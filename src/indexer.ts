import { App, TFile } from "obsidian";
import { VectorDB, ChunkRecord, SCHEMA_VERSION } from "./db";
import { splitMarkdown } from "./chunker";
import type { EmbeddingProvider } from "./embedding/bridge";
import type { PluginSettings } from "./settings";

export type IndexStatus =
  | { state: "idle" }
  | { state: "queued"; count: number; flushAt: number; delayMs: number }
  | { state: "indexing"; current: number; total: number; label?: string }
  | { state: "paused"; current: number; total: number }
  | { state: "error"; message: string };

export type StatusCallback = (status: IndexStatus) => void;

// How many chunks to embed in one provider call
const EMBED_BATCH_SIZE = 32;

// Max characters used for the breadcrumb prefix before " :: " + chunk text.
// Keeps the total embed text within the 256-token ceiling of all-MiniLM-L6-v2.
const BREADCRUMB_MAX_CHARS = 150;

// Max number of backlink titles appended to the first chunk of each note.
const MAX_BACKLINKS = 5;

/**
 * Returns the titles of notes that link TO the given file, sorted by
 * link count descending. Uses the public metadataCache.resolvedLinks map.
 */
function getBacklinkTitles(app: App, file: TFile): string[] {
  const titles: string[] = [];
  const resolvedLinks = app.metadataCache.resolvedLinks;
  for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
    if (targets[file.path] !== undefined) {
      const name = sourcePath.split("/").pop()?.replace(/\.md$/i, "") ?? "";
      if (name) titles.push(name);
    }
  }
  return titles;
}

export class IndexingEngine {
  private app: App;
  private db: VectorDB;
  private provider: EmbeddingProvider;
  private settings: PluginSettings;
  private onStatus: StatusCallback;

  private _running = false;
  private _paused = false;
  private _cancelled = false;
  private _pauseResolve: (() => void) | null = null;

  // Populated after each successful indexAll
  private _lastIndexedCount = 0;

  // mtime cache for deduplication
  private mtimeCache: Map<string, number> = new Map();

  // Live queue for indexAll — allows watcher to inject files mid-run
  private _indexQueue: TFile[] = [];
  private _indexQueuePaths: Set<string> = new Set();

  // Progress state shared with fileToRecords for inter-batch pause responsiveness
  private _indexingCurrent = 0;
  private _indexingTotal   = 0;

  constructor(
    app: App,
    db: VectorDB,
    provider: EmbeddingProvider,
    settings: PluginSettings,
    onStatus: StatusCallback
  ) {
    this.app = app;
    this.db = db;
    this.provider = provider;
    this.settings = settings;
    this.onStatus = onStatus;
  }

  get isRunning(): boolean { return this._running; }
  get isPaused(): boolean { return this._paused; }
  get lastIndexedCount(): number { return this._lastIndexedCount; }

  pause(): void {
    if (!this._running || this._paused) return;
    this._paused = true;
  }

  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    this._pauseResolve?.();
    this._pauseResolve = null;
  }

  cancel(): void {
    this._cancelled = true;
    this.resume(); // unblock if waiting on pause
  }

  /**
   * Full vault reindex. Returns true on normal completion, false on error or cancellation.
   * Uses a live mutable queue so files changed by the watcher mid-run are included
   * in the same pass rather than being silently dropped.
   */
  async indexAll(): Promise<boolean> {
    if (this._running) {
      console.warn("[Anamnesis] indexAll already running, skipping");
      return false;
    }
    this._running = true;
    this._paused = false;
    this._cancelled = false;
    this.mtimeCache.clear();

    let success = false;

    try {
      await this.db.dropTable();
      const table = await this.db.ensureTable();

      // Initialise the live queue from the current vault snapshot
      this._indexQueue = this.getIndexableFiles();
      this._indexQueuePaths = new Set(this._indexQueue.map(f => f.path));
      const initialTotal = this._indexQueue.length;
      console.log(`[Anamnesis] Starting full index: ${initialTotal} files`);
      this.onStatus({ state: "indexing", current: 0, total: initialTotal });

      let processed = 0;
      this._indexingCurrent = 0;
      this._indexingTotal   = initialTotal;

      while (this._indexQueue.length > 0) {
        const file = this._indexQueue.shift()!;
        this._indexQueuePaths.delete(file.path);

        const currentTotal = processed + this._indexQueue.length;
        this._indexingTotal = currentTotal;

        // ── Pause checkpoint ────────────────────────────────────────────────
        if (this._paused) {
          this.onStatus({ state: "paused", current: processed, total: currentTotal });
          await new Promise<void>(resolve => { this._pauseResolve = resolve; });
        }

        if (this._cancelled) break;

        // ── File existence check ─────────────────────────────────────────────
        // File may have been deleted or moved while this loop was running
        const stillExists = this.app.vault.getAbstractFileByPath(file.path) instanceof TFile;
        if (!stillExists) {
          console.warn(`[Anamnesis] Skipping "${file.basename}" — no longer in vault (deleted/moved mid-reindex)`);
          processed++;
          this._indexingCurrent = processed;
          continue;
        }

        this.onStatus({ state: "indexing", current: processed, total: currentTotal, label: file.basename });
        this._indexingCurrent = processed;

        try {
          const records = await this.fileToRecords(file);
          if (records.length > 0) await table.add(records);
          this.mtimeCache.set(file.path, file.stat.mtime);
        } catch (err) {
          console.warn(`[Anamnesis] Skipping "${file.basename}" due to read error:`, err);
        }

        processed++;
        this._indexingCurrent = processed;

        if (processed % 25 === 0) {
          console.log(`[Anamnesis] Indexed ${processed} / ${processed + this._indexQueue.length}`);
        }
      }

      if (!this._cancelled) {
        this._lastIndexedCount = processed;
        console.log(`[Anamnesis] Full index complete: ${processed} files`);
        this.onStatus({ state: "idle" });
        success = true;
      } else {
        this.onStatus({ state: "idle" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Anamnesis] indexAll failed:", message);
      this.onStatus({ state: "error", message });
    } finally {
      // Always clear the live queue so stale state doesn't leak into the next run
      this._indexQueue = [];
      this._indexQueuePaths.clear();
      this._running = false;
      this._paused = false;
      this._cancelled = false;
    }

    return success;
  }

  /** Called by VaultWatcher to reflect pending queue size in the UI. */
  setQueued(count: number, flushAt = 0, delayMs = 0): void {
    // Don't override the "indexing" status while indexAll is running
    if (this._running) return;
    if (count <= 0) {
      this.onStatus({ state: "idle" });
    } else {
      this.onStatus({ state: "queued", count, flushAt, delayMs });
    }
  }

  /**
   * Index a specific batch of file paths (called after the watcher flush timer fires).
   * If indexAll is running, files are injected into its live queue instead of being dropped.
   */
  async indexFiles(paths: string[]): Promise<void> {
    if (this._running) {
      // indexAll is in progress — push new paths into the live queue with dedup
      for (const path of paths) {
        if (this._indexQueuePaths.has(path)) continue;
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) {
          this._indexQueue.push(f);
          this._indexQueuePaths.add(path);
        }
      }
      return;
    }

    const files: TFile[] = [];
    for (const path of paths) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) files.push(f);
    }

    if (files.length === 0) {
      this.onStatus({ state: "idle" });
      return;
    }

    this._running = true;
    this._cancelled = false;
    const total = files.length;
    this.onStatus({ state: "indexing", current: 0, total,
      label: `${total} file${total === 1 ? "" : "s"}` });

    try {
      const table = await this.db.openTable();
      let processed = 0;

      for (const file of files) {
        if (this._cancelled) break;
        this.onStatus({ state: "indexing", current: processed, total, label: file.basename });

        await table.delete(`file_path = "${escape(file.path)}"`);
        const records = await this.fileToRecords(file);
        if (records.length > 0) await table.add(records);
        this.mtimeCache.set(file.path, file.stat.mtime);
        processed++;
      }

      console.log(`[Anamnesis] Batch indexed ${processed} file(s)`);
      this.onStatus({ state: "idle" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Anamnesis] indexFiles failed:", message);
      this.onStatus({ state: "error", message });
    } finally {
      this._running = false;
      this._cancelled = false;
    }
  }

  async indexFile(file: TFile): Promise<void> {
    const cached = this.mtimeCache.get(file.path);
    if (cached !== undefined && cached === file.stat.mtime) return;
    if (this.isExcluded(file.path)) return;

    try {
      const table = await this.db.openTable();
      await table.delete(`file_path = "${escape(file.path)}"`);
      const records = await this.fileToRecords(file);
      if (records.length > 0) await table.add(records);
      this.mtimeCache.set(file.path, file.stat.mtime);
      console.log(`[Anamnesis] Re-indexed: ${file.path} (${records.length} chunks)`);
    } catch (err) {
      console.error(`[Anamnesis] indexFile failed for ${file.path}:`, err);
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    this.mtimeCache.delete(filePath);
    try {
      const table = await this.db.openTable();
      await table.delete(`file_path = "${escape(filePath)}"`);
      console.log(`[Anamnesis] Deleted chunks for: ${filePath}`);
    } catch (err) {
      console.error(`[Anamnesis] deleteFile failed for ${filePath}:`, err);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private getIndexableFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((f) => !this.isExcluded(f.path));
  }

  private isExcluded(path: string): boolean {
    const patterns = this.settings.excludePatterns
      .split("\n").map((p) => p.trim()).filter(Boolean);
    return patterns.some((p) => path.startsWith(p) || path.includes(`/${p}/`));
  }

  private async fileToRecords(file: TFile): Promise<ChunkRecord[]> {
    const content = await this.app.vault.cachedRead(file);
    const chunks = splitMarkdown(content, this.settings.chunkSize, this.settings.chunkOverlap);
    if (chunks.length === 0) return [];

    // ── Frontmatter tags (Strategy 3) ──────────────────────────────────────
    const fileCache = this.app.metadataCache.getFileCache(file);
    const fm = fileCache?.frontmatter ?? {};
    const rawTags = fm.tags;
    const tags = Array.isArray(rawTags)
      ? rawTags.join(", ")
      : typeof rawTags === "string"
        ? rawTags
        : "";

    // ── Backlinks (Strategy 4) ──────────────────────────────────────────────
    const backlinkTitles = getBacklinkTitles(this.app, file).slice(0, MAX_BACKLINKS);
    const importanceScore = backlinkTitles.length;
    const backlinkSuffix =
      backlinkTitles.length > 0 ? ` Linked from: ${backlinkTitles.join(", ")}` : "";

    // ── Breadcrumb injection (Strategy 1) ──────────────────────────────────
    const title = file.basename;
    const embedTexts = chunks.map((c, idx) => {
      const crumb = c.context_path
        ? `[${title}] > [${c.context_path}]`
        : `[${title}]`;
      const crumbTrimmed =
        crumb.length > BREADCRUMB_MAX_CHARS
          ? crumb.slice(0, BREADCRUMB_MAX_CHARS - 3) + "..."
          : crumb;
      const base = `${crumbTrimmed} :: ${c.text}`;
      // Backlink suffix only on the first chunk (note-level summary signal)
      return idx === 0 ? base + backlinkSuffix : base;
    });

    // ── Embed in batches — check pause/cancel between each batch ───────────
    const vectors: number[][] = [];
    for (let i = 0; i < embedTexts.length; i += EMBED_BATCH_SIZE) {
      // Cancellation check — return empty so the caller skips this file
      if (this._cancelled) return [];

      // Pause check between batches for responsive pause UX
      if (this._paused) {
        this.onStatus({
          state: "paused",
          current: this._indexingCurrent,
          total: this._indexingTotal,
        });
        await new Promise<void>(resolve => { this._pauseResolve = resolve; });
        if (this._cancelled) return [];
      }

      const batchVectors = await this.provider.embed(embedTexts.slice(i, i + EMBED_BATCH_SIZE));
      vectors.push(...batchVectors);
    }

    return chunks.map((chunk, idx) => ({
      id: `${file.path}:${chunk.chunkIndex}`,
      file_path: file.path,
      heading: chunk.heading,
      context_path: chunk.context_path,
      chunk_index: chunk.chunkIndex,
      last_modified: file.stat.mtime,
      text: chunk.text,
      vector: vectors[idx],
      tags,
      importance_score: importanceScore,
      schema_version: SCHEMA_VERSION,
    }));
  }
}

/** Escape double-quotes in a value used inside a LanceDB filter string. */
function escape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
