import { join, sep } from "path";
import type { EmbeddingProvider } from "./bridge";

// Static import — bundled into main.js by esbuild so Electron's runtime
// resolver is never involved. All ESM deps are resolved at build time.
import * as Transformers from "@xenova/transformers";

export const LOCAL_MODEL_DIM: Record<string, number> = {
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/all-mpnet-base-v2": 768,
};

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly dimension: number;

  private pluginDir: string;
  private modelName: string;
  private cacheDir: string;
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
    // Point onnxruntime-web WASM files to the local plugin dir.
    // These are deployed by scripts/deploy.mjs into <pluginDir>/wasm/.
    // Must be a plain filesystem path — ort-web.node.js (Emscripten Node.js build)
    // calls fs.readFileSync(path.normalize(wasmPaths + filename)), so file:// URLs
    // get mangled by path.normalize into a relative path on Windows.
    const wasmPath = join(this.pluginDir, "wasm") + sep;

    // env.backends.onnx is onnxruntime-web's env object. It's set up in
    // @xenova/transformers/src/backends/onnx.js. Guard defensively — if the
    // bundled module didn't expose it, log a warning and fall back to CDN.
    const onnxEnv = (Transformers.env.backends as any)?.onnx;
    if (onnxEnv?.wasm) {
      onnxEnv.wasm.wasmPaths = wasmPath;
      // Disable threads — SharedArrayBuffer may not be available in Electron
      // renderer without the COOP/COEP headers Obsidian doesn't set.
      onnxEnv.wasm.numThreads = 1;
    } else {
      console.warn(
        "[Anamnesis] env.backends.onnx.wasm not available — WASM will use CDN fallback.",
        "backends:", (Transformers.env.backends as any)
      );
    }

    // Cache downloaded model files in the plugin's data directory
    Transformers.env.cacheDir = this.cacheDir;

    this.onProgress?.(`Loading model: ${this.modelName}`);
    this.pipe = await Transformers.pipeline(
      "feature-extraction",
      this.modelName,
      {
        progress_callback: (p: { status: string; file?: string; progress?: number }) => {
          if (p.status === "downloading") {
            const pct = p.progress ? ` (${Math.round(p.progress)}%)` : "";
            this.onProgress?.(`Downloading ${p.file ?? "model"}${pct}`);
          }
        },
      }
    );
    this.onProgress?.(`Model ready: ${this.modelName}`);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.pipe) throw new Error("LocalEmbeddingProvider not initialized");

    const output = await (this.pipe as any)(texts, {
      pooling: "mean",
      normalize: true,
    });

    const flat: Float32Array = output.data;
    const dim = this.dimension;
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      results.push(Array.from(flat.subarray(i * dim, (i + 1) * dim)));
    }
    return results;
  }
}
