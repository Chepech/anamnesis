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

  private currentStatus: IndexStatus = { state: "idle" };

  // Live DOM refs
  private statusDotEl!: HTMLElement;
  private statusTextEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private chunkCountEl!: HTMLElement;
  private pauseBtn!: HTMLButtonElement;
  private reindexBtn!: HTMLButtonElement;

  constructor(
    leaf: WorkspaceLeaf,
    vectorDB: VectorDB,
    indexer: IndexingEngine,
    settings: PluginSettings,
    callbacks: {
      onReindex: () => Promise<void>;
      onOpenSearch: () => void;
      onOpenGraph: () => void;
    }
  ) {
    super(leaf);
    this.vectorDB = vectorDB;
    this.indexer = indexer;
    this.settings = settings;
    this.onReindex = callbacks.onReindex;
    this.onOpenSearch = callbacks.onOpenSearch;
    this.onOpenGraph = callbacks.onOpenGraph;
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

  async onClose(): Promise<void> {}

  updateStatus(status: IndexStatus): void {
    this.currentStatus = status;
    this.renderStatus();
    if (status.state === "idle") this.refreshStats();
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
    this.statusDotEl.addClass(`anamnesis-dot-${s.state === "paused" ? "paused" : s.state}`);

    if (s.state === "idle") {
      this.statusTextEl.setText("Ready");
    } else if (s.state === "indexing") {
      this.statusTextEl.setText(
        s.label ? `Indexing: ${s.label}` : `Indexing ${s.current} / ${s.total}`
      );
    } else if (s.state === "paused") {
      this.statusTextEl.setText(`Paused — ${s.current} / ${s.total}`);
    } else {
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
