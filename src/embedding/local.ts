import { join, sep } from "path";
import { pathToFileURL } from "url";
import type { EmbeddingProvider } from "./bridge";

// Static import — bundled into main.js by esbuild so Electron's runtime
// resolver is never involved. All ESM deps are resolved at build time.
// Also needed as fallback if the worker fails to initialize.
import * as Transformers from "@xenova/transformers";

export const LOCAL_MODEL_DIM: Record<string, number> = {
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/all-mpnet-base-v2": 768,
};

type PendingEmbed = {
  resolve: (v: number[][]) => void;
  reject: (e: Error) => void;
  count: number;
};

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly dimension: number;

  private pluginDir: string;
  private modelName: string;
  private cacheDir: string;

  // Worker path
  private worker: Worker | null = null;
  private useWorker = false;
  private pendingEmbeds = new Map<number, PendingEmbed>();
  private embedIdCounter = 0;

  // Main-thread fallback path
  private pipe: Awaited<ReturnType<typeof Transformers.pipeline>> | null = null;

  private onProgress?: (msg: string) => void;

  constructor(
    pluginDir: string,
    modelName: string,
    cacheDir: string,
    onProgress?: (msg: string) => void
  ) {
    this.pluginDir = pluginDir;
    this.modelName = modelName;
    this.cacheDir = cacheDir;
    this.dimension = LOCAL_MODEL_DIM[modelName] ?? 384;
    this.onProgress = onProgress;
  }

  async initialize(): Promise<void> {
    try {
      await this.initWorker();
      this.useWorker = true;
      this.onProgress?.(`Model ready: ${this.modelName}`);
    } catch (err) {
      console.warn("[Anamnesis] Worker init failed, falling back to main thread:", err);
      this.useWorker = false;
      await this.initMainThread();
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.useWorker && this.worker) return this.embedViaWorker(texts);
    return this.embedMainThread(texts);
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    // Reject any pending embed promises
    for (const pending of this.pendingEmbeds.values()) {
      pending.reject(new Error("Worker terminated"));
    }
    this.pendingEmbeds.clear();
  }

  // ── Worker path ────────────────────────────────────────────────────────────

  private async initWorker(): Promise<void> {
    const workerPath = join(this.pluginDir, "embedder-worker.js");
    const workerUrl = pathToFileURL(workerPath).href;

    this.worker = new Worker(workerUrl);

    return new Promise<void>((resolve, reject) => {
      // Allow up to 2 minutes for first-run model download
      const timeout = setTimeout(() => {
        reject(new Error("Worker init timeout after 2 minutes"));
      }, 120_000);

      this.worker!.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if (msg.type === "ready") {
          clearTimeout(timeout);
          // Switch to steady-state message handler
          this.worker!.onmessage = (ev) => this.handleWorkerMessage(ev);
          resolve();
        } else if (msg.type === "progress") {
          if (msg.status === "downloading") {
            const pct = msg.progress ? ` (${Math.round(msg.progress)}%)` : "";
            this.onProgress?.(`Downloading ${msg.file ?? "model"}${pct}`);
          }
        } else if (msg.type === "error" && msg.id === undefined) {
          // Init-phase error — no embed id
          clearTimeout(timeout);
          reject(new Error(msg.message ?? "Unknown worker error"));
        }
      };

      this.worker!.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error(e.message ?? "Worker load error"));
      };

      this.worker!.postMessage({
        type: "init",
        pluginDir: this.pluginDir,
        modelName: this.modelName,
        cacheDir: this.cacheDir,
        dim: this.dimension,
      });

      this.onProgress?.(`Loading model: ${this.modelName}`);
    });
  }

  private handleWorkerMessage(e: MessageEvent): void {
    const msg = e.data;
    if (msg.type === "result") {
      const pending = this.pendingEmbeds.get(msg.id);
      if (!pending) return;
      this.pendingEmbeds.delete(msg.id);
      const dim = msg.dim as number;
      const flat = msg.flat as number[];
      const results: number[][] = [];
      for (let i = 0; i < pending.count; i++) {
        results.push(flat.slice(i * dim, (i + 1) * dim));
      }
      pending.resolve(results);
    } else if (msg.type === "error" && msg.id !== undefined) {
      const pending = this.pendingEmbeds.get(msg.id);
      if (!pending) return;
      this.pendingEmbeds.delete(msg.id);
      pending.reject(new Error(msg.message ?? "Embed error"));
    }
  }

  private embedViaWorker(texts: string[]): Promise<number[][]> {
    return new Promise<number[][]>((resolve, reject) => {
      const id = ++this.embedIdCounter;
      this.pendingEmbeds.set(id, { resolve, reject, count: texts.length });
      this.worker!.postMessage({ type: "embed", id, texts });
    });
  }

  // ── Main-thread fallback path ──────────────────────────────────────────────

  private async initMainThread(): Promise<void> {
    // Point onnxruntime-web WASM files to the local plugin dir.
    // Must be a plain filesystem path — ort-web.node.js calls
    // fs.readFileSync(path.normalize(...)) so file:// URLs get mangled.
    const wasmPath = join(this.pluginDir, "wasm") + sep;
    const onnxEnv = (Transformers.env.backends as any)?.onnx;
    if (onnxEnv?.wasm) {
      onnxEnv.wasm.wasmPaths = wasmPath;
      onnxEnv.wasm.numThreads = 1;
    } else {
      console.warn("[Anamnesis] env.backends.onnx.wasm not available — WASM may use CDN.");
    }
    Transformers.env.cacheDir = this.cacheDir;

    this.onProgress?.(`Loading model: ${this.modelName}`);
    this.pipe = await Transformers.pipeline("feature-extraction", this.modelName, {
      progress_callback: (p: { status: string; file?: string; progress?: number }) => {
        if (p.status === "downloading") {
          const pct = p.progress ? ` (${Math.round(p.progress)}%)` : "";
          this.onProgress?.(`Downloading ${p.file ?? "model"}${pct}`);
        }
      },
    });
    this.onProgress?.(`Model ready: ${this.modelName}`);
  }

  private async embedMainThread(texts: string[]): Promise<number[][]> {
    if (!this.pipe) throw new Error("LocalEmbeddingProvider not initialized");
    const output = await (this.pipe as any)(texts, { pooling: "mean", normalize: true });
    const flat: Float32Array = output.data;
    const dim = this.dimension;
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      results.push(Array.from(flat.subarray(i * dim, (i + 1) * dim)));
    }
    return results;
  }
}
