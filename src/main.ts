import { App, Menu, Notice, Plugin, PluginManifest } from "obsidian";
import { join } from "path";
import { VectorDB } from "./db";
import { IndexingEngine, IndexStatus } from "./indexer";
import { VaultWatcher } from "./watcher";
import { AnamnesisSettingTab, PluginSettings, DEFAULT_SETTINGS } from "./settings";
import type { EmbeddingProvider } from "./embedding/bridge";
import { LocalEmbeddingProvider } from "./embedding/local";
import { OpenAIEmbeddingProvider } from "./embedding/openai";
import { SearchView, SEARCH_VIEW_TYPE } from "./search-view";
import { GraphView, GRAPH_VIEW_TYPE } from "./graph-view";
import { AnamnesisPanel, PANEL_VIEW_TYPE } from "./panel-view";

export default class AnamnesisPlugin extends Plugin {
  settings!: PluginSettings;

  private vectorDB: VectorDB | null = null;
  private provider: EmbeddingProvider | null = null;
  private indexer: IndexingEngine | null = null;
  private watcher: VaultWatcher | null = null;
  private statusBarEl: HTMLElement | null = null;
  private currentStatus: IndexStatus = { state: "idle" };

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
      });
    });

    this.registerView(SEARCH_VIEW_TYPE, (leaf) => {
      if (!this.vectorDB || !this.provider) {
        throw new Error("[Anamnesis] Core not initialized yet — reload plugin.");
      }
      return new SearchView(leaf, this.vectorDB, this.provider);
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

    // Interactive status bar
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("anamnesis-status-bar");
    this.statusBarEl.style.cursor = "pointer";
    this.statusBarEl.addEventListener("click", (e) => this.showStatusMenu(e));
    this.setStatus({ state: "idle" });

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
    await this.vectorDB?.close();
  }

  async triggerFullIndex(): Promise<void> {
    if (!this.indexer) {
      new Notice("[Anamnesis] Not initialized — check settings.");
      return;
    }
    await this.indexer.indexAll();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
    if (storedDim !== null && storedDim !== this.provider.dimension) {
      const msg =
        `[Anamnesis] Embedding model changed (${storedDim} → ${this.provider.dimension} dim). ` +
        `Run "Re-index vault" to rebuild the index.`;
      console.warn(msg);
      new Notice(msg, 8000);
      return;
    }

    await this.vectorDB.ensureTable();

    this.indexer = new IndexingEngine(
      this.app,
      this.vectorDB,
      this.provider,
      this.settings,
      (status) => this.setStatus(status)
    );

    if (this.settings.autoIndexOnChange) {
      this.watcher = new VaultWatcher(this.app, this.indexer);
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

    console.log("[Anamnesis] Core initialized");
  }

  private async activateView(type: string, where: "right" | "tab"): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(type);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = where === "tab"
      ? this.app.workspace.getLeaf("tab")
      : this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type, active: true });
    this.app.workspace.revealLeaf(leaf);
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
    switch (status.state) {
      case "idle":
        this.statusBarEl.setText("Anamnesis: Ready");
        this.statusBarEl.style.color = "";
        break;
      case "indexing":
        this.statusBarEl.setText(
          status.label && status.total === 0
            ? `Anamnesis: ${status.label}`
            : `Anamnesis: ${status.current}/${status.total}`
        );
        this.statusBarEl.style.color = "var(--color-yellow)";
        break;
      case "paused":
        this.statusBarEl.setText(`Anamnesis: Paused (${status.current}/${status.total})`);
        this.statusBarEl.style.color = "var(--color-orange)";
        break;
      case "error":
        this.statusBarEl.setText("Anamnesis: Error");
        this.statusBarEl.style.color = "var(--color-red)";
        break;
    }
  }
}
