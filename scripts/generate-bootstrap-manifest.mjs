/**
 * Generates bootstrap-manifest.json from package-lock.json.
 *
 * The manifest tells the plugin's Bootstrapper which npm tarballs to download
 * at first-run time. It covers:
 *   - @lancedb/lancedb and its transitive runtime deps
 *   - apache-arrow and its transitive runtime deps
 *   - platform-specific native binaries (keyed by "win32-x64", etc.)
 *   - wasm/*.wasm filenames (from the wasm/ build directory)
 *
 * Only packages present in package-lock.json "packages" are included;
 * @types/* packages are excluded (type-only, not needed at runtime).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const lockPkgs = lock.packages; // "node_modules/foo" → { version, resolved, dependencies, ... }

/** Native package names mapped to our platform keys */
const NATIVE_PLATFORM_MAP = {
  "win32-x64": "@lancedb/lancedb-win32-x64-msvc",
  "darwin-x64": "@lancedb/lancedb-darwin-x64",
  "darwin-arm64": "@lancedb/lancedb-darwin-arm64",
  "linux-x64": "@lancedb/lancedb-linux-x64-gnu",
  "linux-arm64": "@lancedb/lancedb-linux-arm64-gnu",
};
const NATIVE_PKG_NAMES = new Set(Object.values(NATIVE_PLATFORM_MAP));

/** Runtime roots — packages that are external to esbuild and loaded via require() */
const RUNTIME_ROOTS = ["@lancedb/lancedb", "apache-arrow"];

/**
 * Collect the full transitive runtime dep set starting from rootNames.
 * Skips @types/* and the native platform packages (handled separately).
 */
function collectDeps(rootNames) {
  const visited = new Set();
  const queue = [...rootNames];

  while (queue.length > 0) {
    const name = queue.shift();
    if (visited.has(name)) continue;
    if (name.startsWith("@types/")) continue;
    if (NATIVE_PKG_NAMES.has(name)) continue;

    const key = `node_modules/${name}`;
    if (!lockPkgs[key]) continue;

    visited.add(name);

    const deps = lockPkgs[key].dependencies ?? {};
    for (const dep of Object.keys(deps)) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }

  return visited;
}

function toEntry(name) {
  const key = `node_modules/${name}`;
  const pkg = lockPkgs[key];
  return { name, version: pkg.version, url: pkg.resolved };
}

// Collect npm (non-native) packages
const depNames = collectDeps(RUNTIME_ROOTS);
const npmPackages = [...depNames].sort().map(toEntry);

// Build native packages map
const nativePackages = {};
for (const [platformKey, pkgName] of Object.entries(NATIVE_PLATFORM_MAP)) {
  const key = `node_modules/${pkgName}`;
  if (lockPkgs[key]) {
    nativePackages[platformKey] = toEntry(pkgName);
  }
}

// Collect wasm filenames
const wasmDir = path.join(root, "wasm");
const wasmFiles = fs.existsSync(wasmDir)
  ? fs
      .readdirSync(wasmDir)
      .filter((f) => f.endsWith(".wasm"))
      .sort()
  : [];

const manifest = { npmPackages, nativePackages, wasmFiles };

const outPath = path.join(root, "bootstrap-manifest.json");
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Generated ${outPath}`);
console.log(`  npmPackages: ${npmPackages.length}`);
console.log(`  nativePackages: ${Object.keys(nativePackages).join(", ")}`);
console.log(`  wasmFiles: ${wasmFiles.length}`);
