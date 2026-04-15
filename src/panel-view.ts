import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type { VectorDB } from "./db";
import type { IndexingEngine, IndexStatus } from "./indexer";
import type { PluginSettings } from "./settings";

export const PANEL_VIEW_TYPE = "anamnesis-panel";

export class AnamnesisPanel extends ItemView {
  private vectorDB: VectorDB;
  private indexer: IndexingEngine;
  private settings: PluginSettings;
  private onReindex: () => Promise<void>;
  private onOpenSearch: () => void;
  private onOpenGraph: () => void;
  private onFlushNow: () => void;
  private onMcpStart: () => void;
  private onMcpStop: () => void;

  private currentStatus: IndexStatus = { state: "idle" };

  // Live DOM refs
  private statusDotEl!: HTMLElement;
  private statusTextEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private countdownEl!: HTMLElement;
  private countdownFillEl!: HTMLElement;
  private chunkCountEl!: HTMLElement;
  private pauseBtn!: HTMLButtonElement;
  private reindexBtn!: HTMLButtonElement;
  private flushBtn!: HTMLButtonElement;
  private mcpDotEl!: HTMLElement;
  private mcpTextEl!: HTMLElement;
  private mcpPortEl!: HTMLElement;
  private mcpUrlEl!: HTMLElement;
  private mcpStartBtn!: HTMLButtonElement;
  private mcpStopBtn!: HTMLButtonElement;

  // rAF handle for countdown animation
  private rafId: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    vectorDB: VectorDB,
    indexer: IndexingEngine,
    settings: PluginSettings,
    callbacks: {
      onReindex: () => Promise<void>;
      onOpenSearch: () => void;
      onOpenGraph: () => void;
      onFlushNow: () => void;
      onMcpStart: () => void;
      onMcpStop: () => void;
    }
  ) {
    super(leaf);
    this.vectorDB = vectorDB;
    this.indexer = indexer;
    this.settings = settings;
    this.onReindex = callbacks.onReindex;
    this.onOpenSearch = callbacks.onOpenSearch;
    this.onOpenGraph = callbacks.onOpenGraph;
    this.onFlushNow = callbacks.onFlushNow;
    this.onMcpStart = callbacks.onMcpStart;
    this.onMcpStop = callbacks.onMcpStop;
  }

  getViewType(): string { return PANEL_VIEW_TYPE; }
  getDisplayText(): string { return "Anamnesis"; }
  getIcon(): string { return "database"; }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("anamnesis-panel");
    this.buildUI(root);
    await this.refreshStats();
  }

  async onClose(): Promise<void> {
    this.stopCountdown();
  }

  updateStatus(status: IndexStatus): void {
    this.currentStatus = status;
    this.renderStatus();
    if (status.state === "idle") this.refreshStats();
  }

  updateMcpStatus(status: "stopped" | "running" | "error", port: number): void {
    this.mcpDotEl.className = "anamnesis-status-dot";
    this.mcpDotEl.style.background = ""; // clear any previous inline override

    // Always reflect the current port and URL
    const displayPort = port > 0 ? port : this.settings.mcpPort;
    this.mcpPortEl.setText(String(displayPort));
    this.mcpUrlEl.setText(`http://localhost:${displayPort}/mcp`);

    switch (status) {
      case "running":
        this.mcpDotEl.addClass("anamnesis-dot-idle"); // green
        this.mcpTextEl.setText("Listening");
        this.mcpStartBtn.disabled = true;
        this.mcpStopBtn.disabled = false;
        break;
      case "error":
        this.mcpDotEl.addClass("anamnesis-dot-error");
        this.mcpTextEl.setText("Error — check console");
        this.mcpStartBtn.disabled = false;
        this.mcpStopBtn.disabled = true;
        break;
      default:
        // base .anamnesis-status-dot already provides var(--text-faint) gray
        this.mcpTextEl.setText("Not running");
        this.mcpStartBtn.disabled = false;
        this.mcpStopBtn.disabled = true;
        break;
    }
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  private buildUI(root: HTMLElement): void {
    // ── Header ───────────────────────────────────────────────────────────────
    const header = root.createDiv("anamnesis-panel-header");
    header.createEl("span", { text: "Anamnesis", cls: "anamnesis-panel-title" });

    // ── Action bar (top) ──────────────────────────────────────────────────────
    const actionBar = root.createDiv("anamnesis-action-bar");

    // Pause / Resume — hidden until indexing
    this.pauseBtn = actionBar.createEl("button", { cls: "anamnesis-action-btn" });
    this.pauseBtn.setAttribute("aria-label", "Pause");
    this.pauseBtn.style.display = "none";
    this.pauseBtn.addEventListener("click", () => {
      if (this.indexer.isPaused) this.indexer.resume();
      else this.indexer.pause();
    });

    // Re-index
    this.reindexBtn = actionBar.createEl("button", { cls: "anamnesis-action-btn anamnesis-action-btn--primary" });
    this.reindexBtn.setAttribute("aria-label", "Re-index vault");
    this.buildActionBtn(this.reindexBtn, "database", "Re-index");
    this.reindexBtn.addEventListener("click", async () => {
      this.reindexBtn.disabled = true;
      await this.onReindex();
      this.reindexBtn.disabled = false;
    });

    // Semantic Search
    const searchBtn = actionBar.createEl("button", { cls: "anamnesis-action-btn" });
    searchBtn.setAttribute("aria-label", "Semantic Search");
    this.buildActionBtn(searchBtn, "telescope", "Search");
    searchBtn.addEventListener("click", () => this.onOpenSearch());

    // Vector Graph
    const graphBtn = actionBar.createEl("button", { cls: "anamnesis-action-btn" });
    graphBtn.setAttribute("aria-label", "Vector Graph");
    this.buildActionBtn(graphBtn, "git-fork", "Graph");
    graphBtn.addEventListener("click", () => this.onOpenGraph());

    // ── Status card ──────────────────────────────────────────────────────────
    const statusCard = root.createDiv("anamnesis-card");

    const statusRow = statusCard.createDiv("anamnesis-status-row");
    this.statusDotEl = statusRow.createDiv("anamnesis-status-dot");
    this.statusTextEl = statusRow.createEl("span", { cls: "anamnesis-status-label" });

    this.flushBtn = statusRow.createEl("button", { cls: "anamnesis-icon-btn" });
    this.flushBtn.title = "Index queued files now";
    setIcon(this.flushBtn, "refresh-cw");
    this.flushBtn.addEventListener("click", () => this.onFlushNow());

    // Countdown bar — drains from full to empty while files are queued
    this.countdownEl = statusCard.createDiv("anamnesis-countdown-bar-wrap");
    this.countdownEl.style.display = "none";
    this.countdownFillEl = this.countdownEl.createDiv("anamnesis-countdown-fill");

    // Indexing progress bar — fills from empty to full during active indexing
    this.progressEl = statusCard.createDiv("anamnesis-progress-bar-wrap");
    this.progressEl.style.display = "none";
    this.progressEl.createDiv("anamnesis-progress-fill");

    // ── Stats card ───────────────────────────────────────────────────────────
    const statsCard = root.createDiv("anamnesis-card");
    statsCard.createEl("p", { cls: "anamnesis-card-label", text: "Index" });

    const addStat = (label: string, value: string, capture?: (el: HTMLElement) => void) => {
      const row = statsCard.createDiv("anamnesis-stat-row");
      row.createEl("span", { cls: "anamnesis-stat-label", text: label });
      const valEl = row.createEl("span", { cls: "anamnesis-stat-value", text: value });
      capture?.(valEl);
    };

    addStat("Chunks", "—", (el) => { this.chunkCountEl = el; });
    addStat(
      "Model",
      this.settings.localModelName.split("/").pop() ?? this.settings.localModelName
    );
    addStat(
      "Provider",
      this.settings.embeddingProvider === "openai" ? "OpenAI" : "Local (offline)"
    );
    addStat(
      "Dimensions",
      this.settings.embeddingProvider === "openai" ? "1536" : "384"
    );

    // ── MCP card ─────────────────────────────────────────────────────────────
    const mcpCard = root.createDiv("anamnesis-card");
    mcpCard.createEl("p", { cls: "anamnesis-card-label", text: "MCP Server" });

    const mcpRow = mcpCard.createDiv("anamnesis-status-row");
    this.mcpDotEl = mcpRow.createDiv("anamnesis-status-dot anamnesis-dot-idle");
    this.mcpTextEl = mcpRow.createEl("span", { cls: "anamnesis-status-label", text: "Not running" });

    const addMcpStat = (label: string, value: string, capture: (el: HTMLElement) => void) => {
      const row = mcpCard.createDiv("anamnesis-stat-row");
      row.createEl("span", { cls: "anamnesis-stat-label", text: label });
      const valEl = row.createEl("span", { cls: "anamnesis-stat-value", text: value });
      capture(valEl);
    };

    addMcpStat("Port", String(this.settings.mcpPort), (el) => { this.mcpPortEl = el; });
    addMcpStat("URL", `http://localhost:${this.settings.mcpPort}/mcp`, (el) => { this.mcpUrlEl = el; });

    const mcpBtnRow = mcpCard.createDiv("anamnesis-mcp-btn-row");

    this.mcpStartBtn = mcpBtnRow.createEl("button", { cls: "anamnesis-action-btn anamnesis-action-btn--primary" });
    this.buildActionBtn(this.mcpStartBtn, "play", "Start");
    this.mcpStartBtn.addEventListener("click", () => this.onMcpStart());

    this.mcpStopBtn = mcpBtnRow.createEl("button", { cls: "anamnesis-action-btn" });
    this.buildActionBtn(this.mcpStopBtn, "square", "Stop");
    this.mcpStopBtn.addEventListener("click", () => this.onMcpStop());
    this.mcpStopBtn.disabled = true;

    this.renderStatus();
  }

  private buildActionBtn(btn: HTMLButtonElement, iconName: string, label: string): void {
    btn.empty();
    const iconEl = btn.createSpan({ cls: "anamnesis-action-icon" });
    setIcon(iconEl, iconName);
    btn.createSpan({ cls: "anamnesis-action-label", text: label });
  }

  // ── Live updates ───────────────────────────────────────────────────────────

  private renderStatus(): void {
    const s = this.currentStatus;

    this.statusDotEl.className = "anamnesis-status-dot";

    // Spinning icon on Re-index button while actively indexing
    const iconEl = this.reindexBtn.querySelector(".anamnesis-action-icon") as HTMLElement | null;
    iconEl?.classList.toggle("anamnesis-spinning", s.state === "indexing");

    // Flush button — active only when files are waiting in the queue
    this.flushBtn.disabled = s.state !== "queued";

    if (s.state === "idle") {
      this.statusDotEl.addClass("anamnesis-dot-idle");
      this.statusTextEl.setText("Ready");
    } else if (s.state === "queued") {
      this.statusDotEl.addClass("anamnesis-dot-queued");
      this.statusTextEl.setText(`${s.count} file${s.count === 1 ? "" : "s"} queued`);
      this.countdownEl.style.display = "block";
      this.startCountdown(s.flushAt, s.delayMs);
    } else if (s.state === "indexing") {
      this.statusDotEl.addClass("anamnesis-dot-indexing");
      this.statusTextEl.setText(
        s.label ? `Indexing: ${s.label}` : `Indexing ${s.current} / ${s.total}`
      );
    } else if (s.state === "paused") {
      this.statusDotEl.addClass("anamnesis-dot-paused");
      this.statusTextEl.setText(`Paused — ${s.current} / ${s.total}`);
    } else {
      this.statusDotEl.addClass("anamnesis-dot-error");
      this.statusTextEl.setText(`Error: ${s.message}`);
    }

    if (s.state === "indexing" || s.state === "paused") {
      const pct = s.total > 0 ? (s.current / s.total) * 100 : 0;
      this.progressEl.style.display = "block";
      const fill = this.progressEl.querySelector(".anamnesis-progress-fill") as HTMLElement;
      if (fill) fill.style.width = `${pct}%`;

      this.pauseBtn.style.display = "flex";
      this.buildActionBtn(
        this.pauseBtn,
        s.state === "paused" ? "play" : "pause",
        s.state === "paused" ? "Resume" : "Pause"
      );
    } else {
      this.progressEl.style.display = "none";
      this.pauseBtn.style.display = "none";
    }

    // Hide countdown bar and stop animation for any non-queued state
    if (s.state !== "queued") {
      this.stopCountdown();
      this.countdownEl.style.display = "none";
    }
  }

  // ── Countdown animation ────────────────────────────────────────────────────

  private startCountdown(flushAt: number, delayMs: number): void {
    this.stopCountdown();
    const tick = () => {
      const remaining = Math.max(0, flushAt - Date.now());
      const pct = delayMs > 0 ? (remaining / delayMs) * 100 : 0;
      this.countdownFillEl.style.width = `${pct}%`;
      if (remaining > 0) {
        this.rafId = requestAnimationFrame(tick);
      } else {
        this.rafId = null;
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopCountdown(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private async refreshStats(): Promise<void> {
    try {
      const chunks = await this.vectorDB.countRows();
      if (this.chunkCountEl) this.chunkCountEl.setText(chunks.toLocaleString());
    } catch {
      // table may not exist yet
    }
  }
}
