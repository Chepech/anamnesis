import { App, TFile } from "obsidian";
import { VectorDB, ChunkRecord } from "./db";
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

  async indexAll(): Promise<void> {
    if (this._running) {
      console.warn("[Anamnesis] indexAll already running, skipping");
      return;
    }
    this._running = true;
    this._paused = false;
    this._cancelled = false;
    this.mtimeCache.clear();

    try {
      await this.db.dropTable();
      const table = await this.db.ensureTable();

      const files = this.getIndexableFiles();
      const total = files.length;
      console.log(`[Anamnesis] Starting full index: ${total} files`);
      this.onStatus({ state: "indexing", current: 0, total });

      let processed = 0;

      for (const file of files) {
        // Pause checkpoint
        if (this._paused) {
          this.onStatus({ state: "paused", current: processed, total });
          await new Promise<void>((resolve) => { this._pauseResolve = resolve; });
        }

        if (this._cancelled) break;

        this.onStatus({ state: "indexing", current: processed, total, label: file.basename });

        const records = await this.fileToRecords(file);
        if (records.length > 0) await table.add(records);
        this.mtimeCache.set(file.path, file.stat.mtime);
        processed++;

        if (processed % 25 === 0) console.log(`[Anamnesis] Indexed ${processed}/${total}`);
      }

      this._lastIndexedCount = processed;
      console.log(`[Anamnesis] Full index complete: ${processed} files`);
      this.onStatus({ state: "idle" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Anamnesis] indexAll failed:", message);
      this.onStatus({ state: "error", message });
    } finally {
      this._running = false;
      this._paused = false;
      this._cancelled = false;
    }
  }

  /** Called by VaultWatcher to reflect pending queue size in the UI. */
  setQueued(count: number, flushAt = 0, delayMs = 0): void {
    if (count <= 0) {
      if (!this._running) this.onStatus({ state: "idle" });
    } else {
      this.onStatus({ state: "queued", count, flushAt, delayMs });
    }
  }

  /** Index a specific batch of file paths (called after the watcher flush timer fires). */
  async indexFiles(paths: string[]): Promise<void> {
    if (this._running) {
      // indexAll is already running — it will cover these files
      console.log("[Anamnesis] indexFiles skipped — indexAll in progress");
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

    const texts = chunks.map((c) => c.text);
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batchVectors = await this.provider.embed(texts.slice(i, i + EMBED_BATCH_SIZE));
      vectors.push(...batchVectors);
    }

    return chunks.map((chunk, idx) => ({
      id: `${file.path}:${chunk.chunkIndex}`,
      file_path: file.path,
      heading: chunk.heading,
      chunk_index: chunk.chunkIndex,
      last_modified: file.stat.mtime,
      text: chunk.text,
      vector: vectors[idx],
    }));
  }
}

/** Escape double-quotes in a value used inside a LanceDB filter string. */
function escape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
