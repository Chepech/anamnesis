/**
 * Deploy the built plugin to an Obsidian vault.
 *
 * Usage:
 *   node scripts/deploy.mjs "D:/ObsidianVault/HexNev"
 *
 * Deployment layout inside <vault>/.obsidian/plugins/obsidian-local-rag/:
 *   main.js          — bundled plugin (includes @xenova/transformers JS)
 *   manifest.json
 *   wasm/            — onnxruntime-web WASM files (loaded via file:// at runtime)
 *   node_modules/    — native / large packages that can't be bundled:
 *     @lancedb/      — native Rust addon
 *     apache-arrow/  — required by LanceDB
 *     openai/        — OpenAI SDK
 */

import { copyFileSync, mkdirSync, cpSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";

const vault = process.argv[2];
if (!vault) {
  console.error("Usage: node scripts/deploy.mjs <vault-path>");
  process.exit(1);
}

const root = resolve(".");
const pluginDir = join(vault, ".obsidian", "plugins", "anamnesis");
const pluginModules = join(pluginDir, "node_modules");

mkdirSync(pluginDir, { recursive: true });

// ── Core plugin files ──────────────────────────────────────────────────────
for (const file of ["main.js", "embedder-worker.js", "manifest.json", "styles.css"]) {
  const src = join(root, file);
  if (!existsSync(src)) {
    console.error(`Missing: ${src} — run npm run build first`);
    process.exit(1);
  }
  copyFileSync(src, join(pluginDir, file));
  console.log(`  copied ${file}`);
}

// ── ONNX WASM files ────────────────────────────────────────────────────────
// @xenova/transformers (bundled into main.js) loads these via file:// URL.
const wasmSrc = join(root, "node_modules", "onnxruntime-web", "dist");
const wasmDest = join(pluginDir, "wasm");
mkdirSync(wasmDest, { recursive: true });
for (const file of readdirSync(wasmSrc)) {
  if (file.endsWith(".wasm")) {
    copyFileSync(join(wasmSrc, file), join(wasmDest, file));
    console.log(`  copied wasm/${file}`);
  }
}

// ── Runtime npm packages (native / too large to bundle) ───────────────────
// Mark native packages so deploy skips them when already present on disk.
// The native .node binary stays locked by Obsidian's process even when the
// plugin is disabled — re-copying it fails with EPIPE. Skip if already there.
const packages = [
  // LanceDB — native Rust addon (skip if locked)
  ["@lancedb/lancedb", "@lancedb/lancedb", { native: true }],
  ["@lancedb/lancedb-win32-x64-msvc", "@lancedb/lancedb-win32-x64-msvc", { native: true }],
  // lancedb runtime dependency
  ["reflect-metadata", "reflect-metadata", {}],
  // Arrow — pure JS but required by LanceDB's own internals
  ["apache-arrow", "apache-arrow", {}],
  // apache-arrow runtime dependencies
  ["tslib", "tslib", {}],
  ["flatbuffers", "flatbuffers", {}],
  // OpenAI SDK
  ["openai", "openai", {}],
];

for (const [srcPkg, destPkg, opts] of packages) {
  const src = join(root, "node_modules", srcPkg);
  const dest = join(pluginModules, destPkg);
  if (!existsSync(src)) {
    console.warn(`  SKIP (not found): ${srcPkg}`);
    continue;
  }
  if (opts.native && existsSync(dest)) {
    console.log(`  skip (native, already deployed): node_modules/${srcPkg}`);
    continue;
  }
  mkdirSync(join(pluginModules, destPkg, ".."), { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`  copied node_modules/${srcPkg}`);
}

console.log(`\nDeployed to: ${pluginDir}`);
console.log("Reload the plugin in Obsidian → Settings → Community plugins");
