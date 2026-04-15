import { App, Menu, Notice, Plugin, PluginManifest, setIcon } from "obsidian";
import { join } from "path";
import { VectorDB, SCHEMA_VERSION } from "./db";
import { IndexingEngine, IndexStatus } from "./indexer";
import { VaultWatcher } from "./watcher";
import { AnamnesisSettingTab, PluginSettings, DEFAULT_SETTINGS } from "./settings";
import type { EmbeddingProvider } from "./embedding/bridge";
import { LocalEmbeddingProvider } from "./embedding/local";
import { OpenAIEmbeddingProvider } from "./embedding/openai";
import { SearchView, SEARCH_VIEW_TYPE } from "./search-view";
import { GraphView, GRAPH_VIEW_TYPE } from "./graph-view";
import { AnamnesisPanel, PANEL_VIEW_TYPE } from "./panel-view";
import { AnamnesisServerMCP } from "./mcp-server";

export default class AnamnesisPlugin extends Plugin {
  settings!: PluginSettings;

  private vectorDB: VectorDB | null = null;
  private provider: EmbeddingProvider | null = null;
  private indexer: IndexingEngine | null = null;
  private watcher: VaultWatcher | null = null;
  private mcpServer: AnamnesisServerMCP | null = null;
  private statusBarEl: HTMLElement | null = null;
  private mcpStatusBarEl: HTMLElement | null = null;
  private currentStatus: IndexStatus = { state: "idle" };
  private currentMcpStatus: "stopped" | "running" | "error" = "stopped";

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);
  }

  async onload(): Promise<void> {
    console.log("[Anamnesis] Loading plugin");
    console.log("[Anamnesis] Plugin dir:", this.getPluginDir());

    await this.loadSettings();
    this.addSettingTab(new AnamnesisSettingTab(this.app, this));

    // View registrations — factories run lazily when the leaf is first opened
    this.registerView(PANEL_VIEW_TYPE, (leaf) => {
      if (!this.vectorDB || !this.indexer) {
        throw new Error("[Anamnesis] Core not initialized yet — reload plugin.");
      }
      return new AnamnesisPanel(leaf, this.vectorDB, this.indexer, this.settings, {
        onReindex: () => this.triggerFullIndex(),
        onOpenSearch: () => this.activateView(SEARCH_VIEW_TYPE, "right"),
        onOpenGraph: () => this.activateView(GRAPH_VIEW_TYPE, "tab"),
        onFlushNow: () => this.watcher?.flushNow(),
        onMcpStart: () => this.startMcpServer(),
        onMcpStop: async () => {
          await this.mcpServer?.stop();
          this.setMcpStatus("stopped");
        },
      });
    });

    this.registerView(SEARCH_VIEW_TYPE, (leaf) => {
      if (!this.vectorDB || !this.provider) {
        throw new Error("[Anamnesis] Core not initialized yet — reload plugin.");
      }
      return new SearchView(leaf, this.vectorDB, this.provider, this.settings);
    });

    this.registerView(GRAPH_VIEW_TYPE, (leaf) => {
      if (!this.vectorDB) {
        throw new Error("[Anamnesis] Core not initialized yet — reload plugin.");
      }
      return new GraphView(leaf, this.vectorDB);
    });

    // Single ribbon icon → control panel
    this.addRibbonIcon("database", "Anamnesis", () => {
      this.activateView(PANEL_VIEW_TYPE, "right");
    });

    // Interactive status bar — icon only, tooltip on hover
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("anamnesis-status-bar");
    this.statusBarEl.style.cursor = "pointer";
    setIcon(this.statusBarEl, "database");
    this.statusBarEl.addEventListener("click", (e) => this.showStatusMenu(e));
    this.setStatus({ state: "idle" });

    // MCP status dot — second icon in the status bar
    this.mcpStatusBarEl = this.addStatusBarItem();
    this.mcpStatusBarEl.addClass("anamnesis-mcp-status-bar");
    this.mcpStatusBarEl.style.cursor = "pointer";
    setIcon(this.mcpStatusBarEl, "server");
    this.mcpStatusBarEl.addEventListener("click", (e) => this.showStatusMenu(e));
    this.setMcpStatus("stopped");

    try {
      await this.initCore();
    } catch (err) {
      console.error("[Anamnesis] Initialization failed:", err);
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus({ state: "error", message: msg });
      new Notice(`[Anamnesis] Init failed: ${msg}`);
    }
  }

  async onunload(): Promise<void> {
    console.log("[Anamnesis] Unloading plugin");
    this.app.workspace.detachLeavesOfType(PANEL_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(SEARCH_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GRAPH_VIEW_TYPE);
    this.watcher?.stop();
    this.provider?.terminate?.();
    await this.mcpServer?.stop();
    await this.vectorDB?.close();
  }

  async triggerFullIndex(): Promise<void> {
    if (!this.indexer) {
      new Notice("[Anamnesis] Not initialized — check settings.");
      return;
    }
    await this.indexer.indexAll();
    // Watcher may have been skipped at init due to a schema/dim mismatch.
    // Now that the index is rebuilt, start it if enabled and not already running.
    this.syncWatcher();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.syncWatcher();
    await this.syncMcpServer();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  private async initCore(): Promise<void> {
    const pluginDir = this.getPluginDir();
    this.provider = await this.buildProvider(pluginDir);

    const dataDir = join(pluginDir, "data");
    this.vectorDB = new VectorDB(dataDir, this.provider.dimension, pluginDir);
    await this.vectorDB.connect();

    const storedDim = await this.vectorDB.getStoredDim();
    const dimMismatch = storedDim !== null && storedDim !== this.provider.dimension;
    if (dimMismatch) {
      const msg =
        `[Anamnesis] Embedding model changed (${storedDim} → ${this.provider.dimension} dim). ` +
        `Run "Re-index vault" to rebuild the index.`;
      console.warn(msg);
      new Notice(msg, 8000);
    }

    const storedSchema = await this.vectorDB.getSchemaVersion();
    const schemaMismatch = storedSchema !== null && storedSchema !== SCHEMA_VERSION;
    if (schemaMismatch) {
      const msg =
        `[Anamnesis] Index schema updated (v${storedSchema} → v${SCHEMA_VERSION}). ` +
        `Run "Re-index vault" to rebuild with improved embeddings.`;
      console.warn(msg);
      new Notice(msg, 8000);
    }

    // Always ensure the table exists so the panel and commands work.
    // indexAll() will drop and recreate it with the correct schema on re-index.
    await this.vectorDB.ensureTable();

    this.indexer = new IndexingEngine(
      this.app,
      this.vectorDB,
      this.provider,
      this.settings,
      (status) => this.setStatus(status)
    );

    // Skip the watcher when there's a schema/dim mismatch — incremental adds
    // would fail against the old table. The user must re-index first.
    if (this.settings.autoIndexOnChange && !dimMismatch && !schemaMismatch) {
      this.watcher = new VaultWatcher(this.app, this.indexer, this.settings);
      this.watcher.start();
    }

    this.addCommand({
      id: "open-panel",
      name: "Open control panel",
      callback: () => this.activateView(PANEL_VIEW_TYPE, "right"),
    });

    this.addCommand({
      id: "open-search",
      name: "Open Semantic Search",
      callback: () => this.activateView(SEARCH_VIEW_TYPE, "right"),
    });

    this.addCommand({
      id: "open-graph",
      name: "Open vector graph",
      callback: () => this.activateView(GRAPH_VIEW_TYPE, "tab"),
    });

    this.addCommand({
      id: "reindex-vault",
      name: "Re-index entire vault",
      callback: () => this.triggerFullIndex(),
    });

    // MCP server — start after core is ready so tools have a live DB + provider
    if (this.settings.mcpEnabled) {
      this.mcpServer = new AnamnesisServerMCP(this.vectorDB, this.provider, this.app);
      await this.startMcpServer();
    }

    console.log("[Anamnesis] Core initialized");
  }

  private async activateView(type: string, where: "right" | "tab"): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(type);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      this.syncPanelMcpState();
      return;
    }
    const leaf = where === "tab"
      ? this.app.workspace.getLeaf("tab")
      : this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type, active: true });
    this.app.workspace.revealLeaf(leaf);
    this.syncPanelMcpState();
  }

  /** Push the current MCP status to any open panel so it always reflects reality. */
  private syncPanelMcpState(): void {
    const panels = this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE);
    for (const leaf of panels) {
      if (leaf.view instanceof AnamnesisPanel) {
        leaf.view.updateMcpStatus(this.currentMcpStatus, this.mcpServer?.port ?? 0);
      }
    }
  }

  private showStatusMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const s = this.currentStatus;

    if (s.state === "indexing") {
      menu.addItem((item) =>
        item.setTitle("Pause indexing").setIcon("pause").onClick(() => this.indexer?.pause())
      );
      menu.addItem((item) =>
        item.setTitle("Cancel indexing").setIcon("x").onClick(() => this.indexer?.cancel())
      );
    } else if (s.state === "paused") {
      menu.addItem((item) =>
        item.setTitle("Resume indexing").setIcon("play").onClick(() => this.indexer?.resume())
      );
      menu.addItem((item) =>
        item.setTitle("Cancel indexing").setIcon("x").onClick(() => this.indexer?.cancel())
      );
    } else if (s.state === "error") {
      menu.addItem((item) =>
        item.setTitle(`Error: ${s.message}`).setDisabled(true)
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item.setTitle("Re-index vault").setIcon("database").onClick(() => this.triggerFullIndex())
      );
    } else if (s.state === "queued") {
      menu.addItem((item) =>
        item.setTitle(`${s.count} file${s.count === 1 ? "" : "s"} queued — indexing soon`).setDisabled(true)
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item.setTitle("Re-index vault now").setIcon("database").onClick(() => this.triggerFullIndex())
      );
    } else {
      // idle
      menu.addItem((item) =>
        item.setTitle("Re-index vault").setIcon("database").onClick(() => this.triggerFullIndex())
      );
      menu.addItem((item) =>
        item.setTitle("Open control panel").setIcon("layout-dashboard")
          .onClick(() => this.activateView(PANEL_VIEW_TYPE, "right"))
      );
    }

    // ── MCP section (always shown) ──────────────────────────────────────────
    menu.addSeparator();
    const mcpRunning = this.mcpServer?.status === "running";
    if (mcpRunning) {
      menu.addItem((item) =>
        item
          .setTitle(`MCP: port ${this.mcpServer!.port}`)
          .setIcon("server")
          .setDisabled(true)
      );
      menu.addItem((item) =>
        item
          .setTitle("Stop MCP server")
          .setIcon("square")
          .onClick(async () => {
            await this.mcpServer?.stop();
            this.setMcpStatus("stopped");
          })
      );
    } else if (this.settings.mcpEnabled) {
      menu.addItem((item) =>
        item
          .setTitle("Start MCP server")
          .setIcon("play")
          .onClick(() => this.startMcpServer())
      );
    } else {
      menu.addItem((item) =>
        item.setTitle("MCP: Disabled").setIcon("server").setDisabled(true)
      );
    }

    menu.showAtMouseEvent(evt);
  }

  private async buildProvider(pluginDir: string): Promise<EmbeddingProvider> {
    let provider: EmbeddingProvider;

    if (this.settings.embeddingProvider === "openai") {
      if (!this.settings.openaiApiKey) {
        throw new Error("OpenAI API key is required. Add it in plugin settings.");
      }
      provider = new OpenAIEmbeddingProvider(
        pluginDir,
        this.settings.openaiApiKey,
        this.settings.openaiModelName
      );
    } else {
      const cacheDir = join(pluginDir, "data", "models");
      provider = new LocalEmbeddingProvider(
        pluginDir,
        this.settings.localModelName,
        cacheDir,
        (msg) => {
          console.log("[Anamnesis]", msg);
          this.setStatus({ state: "indexing", current: 0, total: 0, label: msg });
        }
      );
    }

    this.setStatus({ state: "indexing", current: 0, total: 0, label: "Initializing embeddings…" });
    await provider.initialize();
    this.setStatus({ state: "idle" });
    return provider;
  }

  private getPluginDir(): string {
    const adapter = this.app.vault.adapter as any;
    const basePath: string = adapter.basePath ?? adapter.getBasePath?.() ?? "";
    const manifestDir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
    return join(basePath, manifestDir);
  }

  private setStatus(status: IndexStatus): void {
    this.currentStatus = status;

    // Push to panel if it's open
    const panels = this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE);
    for (const leaf of panels) {
      if (leaf.view instanceof AnamnesisPanel) leaf.view.updateStatus(status);
    }

    if (!this.statusBarEl) return;
    let tooltip: string;
    let color: string;

    switch (status.state) {
      case "idle":
        tooltip = "Anamnesis: Ready";
        color = "";
        break;
      case "queued":
        tooltip = `Anamnesis: ${status.count} file${status.count === 1 ? "" : "s"} queued`;
        color = "var(--color-blue)";
        break;
      case "indexing":
        tooltip = status.label && status.total === 0
          ? `Anamnesis: ${status.label}`
          : `Anamnesis: Indexing ${status.current}/${status.total}`;
        color = "var(--color-yellow)";
        break;
      case "paused":
        tooltip = `Anamnesis: Paused (${status.current}/${status.total})`;
        color = "var(--color-orange)";
        break;
      case "error":
        tooltip = `Anamnesis: Error — ${status.message}`;
        color = "var(--color-red)";
        break;
    }

    this.statusBarEl.title = tooltip;
    this.statusBarEl.style.color = color;
  }

  private setMcpStatus(status: "stopped" | "running" | "error"): void {
    if (!this.mcpStatusBarEl) return;
    this.currentMcpStatus = status;

    // Push to any open panels
    const panels = this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE);
    for (const leaf of panels) {
      if (leaf.view instanceof AnamnesisPanel) leaf.view.updateMcpStatus(status, this.mcpServer?.port ?? 0);
    }

    const port = this.mcpServer?.port ?? 0;
    switch (status) {
      case "running":
        this.mcpStatusBarEl.title = `MCP: Listening on port ${port}`;
        this.mcpStatusBarEl.style.color = "var(--color-green)";
        break;
      case "error":
        this.mcpStatusBarEl.title = `MCP: Error — ${this.mcpServer?.error ?? "unknown"}`;
        this.mcpStatusBarEl.style.color = "var(--color-red)";
        break;
      default:
        this.mcpStatusBarEl.title = "MCP: Not running";
        this.mcpStatusBarEl.style.color = "";
        break;
    }
  }

  private async startMcpServer(): Promise<void> {
    if (!this.vectorDB || !this.provider) return;
    // Create the server lazily — it may not exist if mcpEnabled was off at startup
    if (!this.mcpServer) {
      this.mcpServer = new AnamnesisServerMCP(this.vectorDB, this.provider, this.app);
    }
    try {
      await this.mcpServer.start(this.settings.mcpPort);
      this.setMcpStatus("running");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Anamnesis] MCP server failed to start:", msg);
      new Notice(`[Anamnesis] MCP server error: ${msg}`, 8000);
      this.setMcpStatus("error");
    }
  }

  /** Start or stop the watcher based on current settings and indexer state. */
  private syncWatcher(): void {
    if (!this.indexer) return; // core not ready yet
    if (this.settings.autoIndexOnChange) {
      if (!this.watcher) {
        this.watcher = new VaultWatcher(this.app, this.indexer, this.settings);
      }
      if (!this.watcher.isRunning) this.watcher.start();
    } else {
      if (this.watcher?.isRunning) this.watcher.stop();
    }
  }

  /** Called on saveSettings — restart MCP if enabled/port changed. */
  private async syncMcpServer(): Promise<void> {
    if (!this.vectorDB || !this.provider) return; // core not ready yet

    if (!this.settings.mcpEnabled) {
      await this.mcpServer?.stop();
      this.setMcpStatus("stopped");
      this.mcpServer = null;
      return;
    }

    // Enabled — create server if needed, restart if port changed
    const portChanged = this.mcpServer?.port !== this.settings.mcpPort;
    const wasRunning = this.mcpServer?.status === "running";

    if (!this.mcpServer) {
      this.mcpServer = new AnamnesisServerMCP(this.vectorDB, this.provider, this.app);
    }

    if (!wasRunning || portChanged) {
      if (wasRunning) await this.mcpServer.stop();
      await this.startMcpServer();
    }
  }
}
