import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

/**
 * Stub out packages with native binaries that can't be bundled.
 * - onnxruntime-node: we use the WASM (web) backend instead
 * - sharp: image processing, not needed for text embeddings
 * Also handles bare .node binary requires with an empty module.
 */
const nativeStubPlugin = {
  name: "native-stub",
  setup(build) {
    const nativePackages = /^(onnxruntime-node|sharp)$/;
    build.onResolve({ filter: nativePackages }, (args) => ({
      path: args.path,
      namespace: "native-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "native-stub" }, () => ({
      contents: "module.exports = {}",
      loader: "js",
    }));
    build.onLoad({ filter: /\.node$/ }, () => ({
      contents: "module.exports = {}",
      loader: "js",
    }));
  },
};

/**
 * Patch @xenova/transformers/src/backends/onnx.js before bundling.
 *
 * In Obsidian's Electron renderer, `process.release.name === 'node'` is true,
 * so transformers.js takes the Node path and uses ONNX_NODE (our stub {}).
 * That leaves ONNX.env undefined, breaking env.backends.onnx.wasm.
 *
 * Force the web/WASM path unconditionally so ONNX_WEB is always used.
 * The WASM files are deployed to <pluginDir>/wasm/ and referenced via file://
 * URLs that we set on env.backends.onnx.wasm.wasmPaths at runtime.
 */
const patchTransformersOnnxPlugin = {
  name: "patch-transformers-onnx",
  setup(build) {
    // Use a broad filter; the include check inside handles specificity.
    // esbuild may normalize Windows backslash paths — match on filename only.
    build.onLoad({ filter: /onnx\.js$/ }, (args) => {
      if (!args.path.includes("@xenova") || !args.path.includes("backends")) return null;

      let source = fs.readFileSync(args.path, "utf8");

      // Replace the Node.js detection branch with `false` so we always
      // take the browser/WASM path.
      source = source.replace(
        `if (typeof process !== 'undefined' && process?.release?.name === 'node') {`,
        `if (false) { // forced WASM backend — onnxruntime-web used in Electron renderer`
      );

      return { contents: source, loader: "js" };
    });
  },
};

/**
 * Patch @xenova/transformers/src/env.js before bundling.
 *
 * When esbuild converts the ESM source to CJS, `import.meta` becomes an
 * empty object `{}`, so `import_meta.url` is undefined. env.js then calls
 * `fileURLToPath(undefined)` and throws before any of our runtime overrides
 * can run.
 *
 * The patch guards the one expression that reads `import.meta.url` and falls
 * back to "./" when it's unavailable — the same fallback the code uses in a
 * browser context. Our plugin then overrides cacheDir and wasmPaths anyway.
 */
const patchTransformersEnvPlugin = {
  name: "patch-transformers-env",
  setup(build) {
    build.onLoad({ filter: /env\.js$/ }, (args) => {
        if (!args.path.includes("@xenova")) return null;

        let source = fs.readFileSync(args.path, "utf8");

        // Guard the __dirname derivation so it falls back to "./" when
        // import.meta.url is unavailable (esbuild sets import.meta = {} in CJS).
        // Exact string match avoids regex issues with the `url.fileURLToPath`
        // namespace import syntax.
        const BAD  = `? path.dirname(path.dirname(url.fileURLToPath(import.meta.url)))`;
        const GOOD = `? (import.meta && import.meta.url ? path.dirname(path.dirname(url.fileURLToPath(import.meta.url))) : './')`;
        source = source.replace(BAD, GOOD);

        return { contents: source, loader: "js" };
      }
    );
  },
};

// Shared config — both builds use the same plugin set and externals
const sharedConfig = {
  bundle: true,
  plugins: [nativeStubPlugin, patchTransformersOnnxPlugin, patchTransformersEnvPlugin],
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    // LanceDB and OpenAI stay external — native binary / large SDK,
    // loaded via absolute pluginDir path at runtime.
    "@lancedb/lancedb",
    "apache-arrow",
    "openai",
    ...builtins,
  ],
  format: "cjs",
  target: "node20",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  platform: "node",
  mainFields: ["main", "module"],
};

// Main plugin bundle
const mainContext = await esbuild.context({
  ...sharedConfig,
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
});

// Embedder Web Worker — separate bundle so @xenova/transformers runs off-thread
const workerContext = await esbuild.context({
  ...sharedConfig,
  entryPoints: ["src/embedding/embedder-worker.ts"],
  outfile: "embedder-worker.js",
});

if (prod) {
  await Promise.all([mainContext.rebuild(), workerContext.rebuild()]);
  process.exit(0);
} else {
  await Promise.all([mainContext.watch(), workerContext.watch()]);
}
