/**
 * Builds the eslint-plugin-obsidianmd dist/ after npm install.
 *
 * The plugin ships without a `prepare` script, so npm never auto-builds it.
 * This script clones the source at the locked commit, runs tsc, and copies
 * the resulting dist/ into the installed node_modules location.
 *
 * Usage: npm run setup
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, cpSync, rmSync } from "fs";
import { join, resolve } from "path";
import { readFileSync } from "fs";

const root = resolve(".");
const pluginDir = join(root, "node_modules", "eslint-plugin-obsidianmd");
const distDir = join(pluginDir, "dist");

if (existsSync(distDir)) {
  console.log("eslint-plugin-obsidianmd dist/ already present, skipping.");
  process.exit(0);
}

// Read the locked commit hash from package-lock.json
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const pluginEntry = lock.packages?.["node_modules/eslint-plugin-obsidianmd"];
const resolved = pluginEntry?.resolved ?? "";
const commitHash = resolved.split("#")[1] ?? "HEAD";

const tmpDir = join(root, ".tmp-eslint-plugin-build");
if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });

console.log(`Building eslint-plugin-obsidianmd @ ${commitHash}...`);

execSync(
  `git clone https://github.com/obsidianmd/eslint-plugin.git "${tmpDir}"`,
  { stdio: "inherit" }
);
execSync(`git -C "${tmpDir}" checkout ${commitHash}`, { stdio: "inherit" });
execSync("npm install", { cwd: tmpDir, stdio: "inherit" });
execSync("npx tsc", { cwd: tmpDir, stdio: "inherit" });

mkdirSync(distDir, { recursive: true });
cpSync(join(tmpDir, "dist"), distDir, { recursive: true });
rmSync(tmpDir, { recursive: true, force: true });

console.log("eslint-plugin-obsidianmd built successfully.");
