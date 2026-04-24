/**
 * Embedder Web Worker — runs @xenova/transformers in a separate thread
 * so the main renderer stays responsive during embedding computation.
 *
 * Protocol:
 *   main → worker  { type:"init",  pluginDir, modelName, cacheDir, dim }
 *   worker → main  { type:"progress", status, file?, progress? }
 *   worker → main  { type:"ready" }
 *   worker → main  { type:"error",   message }          (init failure)
 *
 *   main → worker  { type:"embed",  id, texts }
 *   worker → main  { type:"result", id, flat: number[], dim }
 *   worker → main  { type:"error",  id, message }       (embed failure)
 */

import { join, sep } from "path";
import * as Transformers from "@xenova/transformers";

let pipe: Awaited<ReturnType<typeof Transformers.pipeline>> | null = null;
let embDim = 384;

// In Electron workers self === globalThis
const ctx: Worker = self as unknown as Worker;

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === "init") {
    try {
      const wasmPath = join(msg.pluginDir, "wasm") + sep;
      type OnnxBackend = { wasm?: { wasmPaths: string; numThreads: number } };
      const onnxEnv = (Transformers.env.backends as Record<string, OnnxBackend | undefined>)?.onnx;
      if (onnxEnv?.wasm) {
        onnxEnv.wasm.wasmPaths = wasmPath;
        onnxEnv.wasm.numThreads = 1;
      }
      Transformers.env.cacheDir = msg.cacheDir;
      embDim = msg.dim ?? 384;

      pipe = await Transformers.pipeline("feature-extraction", msg.modelName, {
        progress_callback: (p: { status: string; file?: string; progress?: number }) => {
          ctx.postMessage({ type: "progress", status: p.status, file: p.file, progress: p.progress });
        },
      });

      ctx.postMessage({ type: "ready" });
    } catch (err: unknown) {
      ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }

  } else if (msg.type === "embed") {
    try {
      if (!pipe) throw new Error("Model not initialized");
      type EmbedFn = (texts: string[], opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>;
      const output = await (pipe as unknown as EmbedFn)(msg.texts, { pooling: "mean", normalize: true });
      const flat = Array.from(output.data);
      ctx.postMessage({ type: "result", id: msg.id, flat, dim: embDim });
    } catch (err: unknown) {
      ctx.postMessage({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
};
