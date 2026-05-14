import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import type { PluginSettings } from "./settings";
import { HybridSearchEngine, SearchResult } from "./hybrid-search";

export const SEARCH_VIEW_TYPE = "anamnesis-search";

export class SearchView extends ItemView {
  private hybridSearch: HybridSearchEngine;
  private settings: PluginSettings;

  // DOM refs
  private inputEl!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private resultsEl!: HTMLElement;

  // Debounce
  private debounceTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, hybridSearch: HybridSearchEngine, settings: PluginSettings) {
    super(leaf);
    this.hybridSearch = hybridSearch;
    this.settings = settings;
  }

  getViewType(): string {
    return SEARCH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Search";
  }

  getIcon(): string {
    return "telescope";
  }

  onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("anamnesis-search-view");

    // ── Header ──────────────────────────────────────────────────────────────
    const header = root.createDiv("anamnesis-header");
    header.createEl("h4", { text: "Semantic search" });

    // ── Search input ─────────────────────────────────────────────────────────
    const inputWrap = root.createDiv("anamnesis-input-wrap");
    this.inputEl = inputWrap.createEl("input", {
      type: "text",
      placeholder: "Search your vault…",
      cls: "anamnesis-input",
    });
    this.inputEl.addEventListener("input", () => this.onInput());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (this.debounceTimer !== null) {
          window.clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
        }
        void this.runSearch();
      }
    });

    // ── Status line ──────────────────────────────────────────────────────────
    this.statusEl = root.createDiv("anamnesis-status");

    // ── Results container ────────────────────────────────────────────────────
    this.resultsEl = root.createDiv("anamnesis-results");
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    return Promise.resolve();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private onInput(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    const q = this.inputEl.value.trim();
    if (!q) {
      this.statusEl.setText("");
      this.resultsEl.empty();
      return;
    }
    this.debounceTimer = window.setTimeout(() => void this.runSearch(), 400);
  }

  private async runSearch(): Promise<void> {
    const q = this.inputEl.value.trim();
    if (!q) return;

    this.statusEl.setText("Searching…");
    this.resultsEl.empty();

    try {
      const hits = await this.hybridSearch.search(q, 15);

      if (hits.length === 0) {
        this.statusEl.setText("No results.");
        return;
      }

      this.statusEl.setText(`${hits.length} result${hits.length > 1 ? "s" : ""}`);
      this.renderResults(hits);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.statusEl.setText(`Error: ${msg}`);
      console.error("[Anamnesis] Search error:", err);
    }
  }

  private renderResults(hits: SearchResult[]): void {
    // Group by file so the same file doesn't repeat awkwardly
    const byFile = new Map<string, SearchResult[]>();
    for (const hit of hits) {
      const arr = byFile.get(hit.file_path) ?? [];
      arr.push(hit);
      byFile.set(hit.file_path, arr);
    }

    for (const [filePath, chunks] of byFile) {
      const card = this.resultsEl.createDiv("anamnesis-result-card");

      // File name link
      const titleRow = card.createDiv("anamnesis-result-title");
      const link = titleRow.createEl("a", {
        text: this.friendlyName(filePath),
        cls: "anamnesis-file-link",
        href: "#",
      });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        void this.openFile(filePath);
      });

      // Match source badges — shown once per card
      const sources = chunks[0].match_sources;
      if (sources.length > 0) {
        const badgesEl = titleRow.createDiv("anamnesis-match-badges");
        for (const src of sources) {
          badgesEl.createEl("span", {
            text: src === "semantic" ? "~" : "K",
            cls: `anamnesis-match-badge anamnesis-match-badge--${src}`,
            attr: { title: src === "semantic" ? "Semantic match" : "Keyword match" },
          });
        }
      }

      // Snippet(s)
      for (const chunk of chunks.slice(0, 2)) {
        const snippetEl = card.createDiv("anamnesis-snippet");
        const contextLabel = chunk.context_path || chunk.heading;
        if (contextLabel) {
          snippetEl.createEl("span", {
            text: contextLabel + " — ",
            cls: "anamnesis-heading",
          });
        }
        snippetEl.createEl("span", {
          text: this.truncate(chunk.text, 160),
          cls: "anamnesis-text",
        });
        if (chunk.tags) {
          snippetEl.createEl("span", {
            text: " [" + chunk.tags + "]",
            cls: "anamnesis-tags",
          });
        }
      }
    }
  }

  private async openFile(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    }
  }

  private friendlyName(filePath: string): string {
    return filePath.replace(/\.md$/, "").split("/").pop() ?? filePath;
  }

  private truncate(text: string, max: number): string {
    const t = text.replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max) + "…" : t;
  }
}
