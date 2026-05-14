/**
 * Ensures eslint-plugin-obsidianmd has a built dist/ in node_modules.
 *
 * The plugin ships without a `prepare` script so npm never auto-builds it.
 * Strategy:
 *   1. Download the pre-built dist tarball from the latest Anamnesis release.
 *   2. If unavailable (no release yet, network error), fall back to
 *      cloning the source at the locked commit and running tsc.
 *
 * Usage: node scripts/setup-eslint-plugin.mjs  (or: npm run setup)
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, cpSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { readFileSync } from "fs";
import https from "https";

const REPO = "Chepech/anamnesis";
const ASSET = "eslint-plugin-obsidianmd-dist.tar.gz";
const DOWNLOAD_URL = `https://github.com/${REPO}/releases/latest/download/${ASSET}`;

const root = resolve(".");
const pluginDir = join(root, "node_modules", "eslint-plugin-obsidianmd");
const distDir = join(pluginDir, "dist");

if (existsSync(distDir)) {
  console.log("eslint-plugin-obsidianmd dist/ already present, skipping.");
  process.exit(0);
}

/** Download URL (following redirects) into a Buffer. Returns null on error. */
function download(url) {
  return new Promise((resolve) => {
    const attempt = (u) => {
      https
        .get(u, { headers: { "User-Agent": "anamnesis-setup" } }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            attempt(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        })
        .on("error", () => resolve(null));
    };
    attempt(url);
  });
}

async function tryDownload() {
  console.log(`Downloading ${ASSET} from latest release…`);
  const buf = await download(DOWNLOAD_URL);
  if (!buf) return false;

  // Write tarball to a temp file and extract with tar
  const tmpTar = join(root, ".tmp-eslint-plugin-dist.tar.gz");
  writeFileSync(tmpTar, buf);

  mkdirSync(distDir, { recursive: true });
  const result = spawnSync("tar", ["-xzf", tmpTar, "-C", pluginDir], {
    stdio: "inherit",
  });
  rmSync(tmpTar, { force: true });

  if (result.status !== 0) {
    rmSync(distDir, { recursive: true, force: true });
    return false;
  }

  console.log("eslint-plugin-obsidianmd dist/ downloaded successfully.");
  return true;
}

function buildFromSource() {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const pluginEntry = lock.packages?.["node_modules/eslint-plugin-obsidianmd"];
  const resolved = pluginEntry?.resolved ?? "";
  const commitHash = resolved.split("#")[1] ?? "HEAD";

  const tmpDir = join(root, ".tmp-eslint-plugin-build");
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });

  console.log(`Building eslint-plugin-obsidianmd @ ${commitHash}…`);

  execSync(`git clone https://github.com/obsidianmd/eslint-plugin.git "${tmpDir}"`, {
    stdio: "inherit",
  });
  execSync(`git -C "${tmpDir}" checkout ${commitHash}`, { stdio: "inherit" });
  execSync("npm install", { cwd: tmpDir, stdio: "inherit" });
  execSync("npx tsc", { cwd: tmpDir, stdio: "inherit" });

  mkdirSync(distDir, { recursive: true });
  cpSync(join(tmpDir, "dist"), distDir, { recursive: true });
  rmSync(tmpDir, { recursive: true, force: true });

  console.log("eslint-plugin-obsidianmd built successfully.");
}

const downloaded = await tryDownload();
if (!downloaded) {
  console.log("Download failed — falling back to clone + build.");
  buildFromSource();
}
