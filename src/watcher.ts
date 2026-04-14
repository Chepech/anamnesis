import { App, TFile } from "obsidian";
import { IndexingEngine } from "./indexer";
import type { PluginSettings } from "./settings";

const CONSERVATIVE_MS = 30_000;
const AGGRESSIVE_MS   =  5_000;

/**
 * Listens for vault file events and queues changes for batch processing.
 *
 * Rather than indexing immediately on every keystroke, changes are held in a
 * pending set and flushed after a configurable delay:
 *   conservative — 30 s: ideal for active editing; batches many saves into one pass
 *   aggressive   —  5 s: picks up changes quickly; more frequent DB writes
 */
export class VaultWatcher {
  private app: App;
  private indexer: IndexingEngine;
  private settings: PluginSettings;

  private pendingModify: Set<string> = new Set();
  private pendingDelete: Set<string> = new Set();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private unregister: (() => void)[] = [];

  constructor(app: App, indexer: IndexingEngine, settings: PluginSettings) {
    this.app = app;
    this.indexer = indexer;
    this.settings = settings;
  }

  start(): void {
    const onModify = this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.extension === "md") this.enqueueModify(file.path);
    });

    const onCreate = this.app.vault.on("create", (file) => {
      if (file instanceof TFile && file.extension === "md") this.enqueueModify(file.path);
    });

    const onDelete = this.app.vault.on("delete", (file) => {
      if (file instanceof TFile && file.extension === "md") this.enqueueDelete(file.path);
    });

    const onRename = this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile && file.extension === "md") {
        this.enqueueDelete(oldPath);
        this.enqueueModify(file.path);
      }
    });

    this.unregister = [
      () => this.app.vault.offref(onModify),
      () => this.app.vault.offref(onCreate),
      () => this.app.vault.offref(onDelete),
      () => this.app.vault.offref(onRename),
    ];

    console.log("[Anamnesis] Vault watcher started");
  }

  /** Cancel the pending countdown and flush immediately. No-op if queue is empty. */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingModify.size > 0 || this.pendingDelete.size > 0) {
      this.flush();
    }
  }

  stop(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingModify.clear();
    this.pendingDelete.clear();
    for (const off of this.unregister) off();
    this.unregister = [];
    console.log("[Anamnesis] Vault watcher stopped");
  }

  // ── Queue management ───────────────────────────────────────────────────────

  private enqueueModify(path: string): void {
    this.pendingDelete.delete(path); // supersede any pending delete
    this.pendingModify.add(path);
    const { flushAt, delayMs } = this.scheduleFlush();
    this.indexer.setQueued(this.pendingModify.size + this.pendingDelete.size, flushAt, delayMs);
  }

  private enqueueDelete(path: string): void {
    this.pendingModify.delete(path); // supersede any pending modify
    this.pendingDelete.add(path);
    const { flushAt, delayMs } = this.scheduleFlush();
    this.indexer.setQueued(this.pendingModify.size + this.pendingDelete.size, flushAt, delayMs);
  }

  private scheduleFlush(): { flushAt: number; delayMs: number } {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const delayMs = this.settings.indexingStrategy === "aggressive" ? AGGRESSIVE_MS : CONSERVATIVE_MS;
    const flushAt = Date.now() + delayMs;
    this.flushTimer = setTimeout(() => this.flush(), delayMs);
    return { flushAt, delayMs };
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;

    const toModify = [...this.pendingModify];
    const toDelete = [...this.pendingDelete];
    this.pendingModify.clear();
    this.pendingDelete.clear();

    for (const path of toDelete) {
      await this.indexer.deleteFile(path);
    }

    if (toModify.length > 0) {
      await this.indexer.indexFiles(toModify);
    } else {
      // Only deletes — transition UI back to idle
      this.indexer.setQueued(0);
    }
  }
}
