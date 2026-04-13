import { App, TFile, TAbstractFile } from "obsidian";
import { IndexingEngine } from "./indexer";

const DEBOUNCE_MS = 500;

export class VaultWatcher {
  private app: App;
  private indexer: IndexingEngine;
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private unregister: (() => void)[] = [];

  constructor(app: App, indexer: IndexingEngine) {
    this.app = app;
    this.indexer = indexer;
  }

  start(): void {
    const onModify = this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.extension === "md") {
        this.debounce(file.path, () => this.indexer.indexFile(file));
      }
    });

    const onCreate = this.app.vault.on("create", (file) => {
      if (file instanceof TFile && file.extension === "md") {
        this.debounce(file.path, () => this.indexer.indexFile(file));
      }
    });

    const onDelete = this.app.vault.on("delete", (file) => {
      if (file instanceof TFile && file.extension === "md") {
        this.cancelDebounce(file.path);
        this.indexer.deleteFile(file.path);
      }
    });

    const onRename = this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile && file.extension === "md") {
        this.cancelDebounce(oldPath);
        this.indexer.deleteFile(oldPath).then(() => {
          this.indexer.indexFile(file as TFile);
        });
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

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const off of this.unregister) off();
    this.unregister = [];
    console.log("[Anamnesis] Vault watcher stopped");
  }

  private debounce(key: string, fn: () => void): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      fn();
    }, DEBOUNCE_MS));
  }

  private cancelDebounce(key: string): void {
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(key);
    }
  }
}
