import { App, Notice, requestUrl } from "obsidian";
import type { PluginManifest } from "obsidian";
import fs from "fs";
import path from "path";
import { extractTarGz } from "./tar";

// Shape of the bootstrap-manifest.json included in each GitHub release
interface NpmPackageEntry {
  name: string;
  version: string;
  url: string; // registry tarball URL from package-lock.json
}

interface BootstrapManifest {
  npmPackages: NpmPackageEntry[];
  nativePackages: Record<string, NpmPackageEntry>; // key: "win32-x64" etc.
  wasmFiles: string[]; // filenames under wasm/ in the release
}

type ProgressFn = (msg: string) => void;

export class Bootstrapper {
  private readonly pluginDir: string;
  private readonly version: string;
  private readonly releaseBase: string;

  constructor(app: App, manifest: PluginManifest) {
    const adapter = app.vault.adapter as { basePath?: string; getBasePath?: () => string };
    const basePath: string = adapter.basePath ?? adapter.getBasePath?.() ?? "";
    const manifestDir = manifest.dir ?? `${app.vault.configDir}/plugins/${manifest.id}`;
    this.pluginDir = path.join(basePath, manifestDir);
    this.version = manifest.version;
    this.releaseBase = `https://github.com/Chepech/anamnesis/releases/download/${this.version}`;
  }

  /** Returns true if any required component is missing. */
  needsSetup(): boolean {
    return !this.hasWorker() || !this.hasWasm() || !this.hasLanceDb();
  }

  /**
   * Downloads and installs all missing components.
   * Shows a persistent Notice during the process and resolves when done.
   */
  async run(): Promise<void> {
    const notice = new Notice("Anamnesis: first-time setup…", 0);
    const progress: ProgressFn = (msg) => {
      notice.setMessage(`Anamnesis setup: ${msg}`);
    };

    try {
      const manifest = await this.fetchManifest();

      if (!this.hasWorker()) {
        progress("downloading embedder-worker.js…");
        await this.downloadReleaseAsset("embedder-worker.js");
      }

      if (!this.hasWasm()) {
        progress("downloading WASM runtime files…");
        await this.downloadWasmFiles(manifest.wasmFiles);
      }

      if (!this.hasLanceDb()) {
        progress("installing dependencies…");
        await this.installNpmPackages(manifest, progress);
      }

      notice.setMessage("Anamnesis: setup complete — initializing…");
      window.setTimeout(() => notice.hide(), 3000);
    } catch (err) {
      notice.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(
        `Anamnesis setup failed: ${msg}\n\nRun the deploy script manually or reinstall the plugin.`,
        0
      );
      throw err;
    }
  }

  // ── presence checks ──────────────────────────────────────────────────────

  private hasWorker(): boolean {
    return fs.existsSync(path.join(this.pluginDir, "embedder-worker.js"));
  }

  private hasWasm(): boolean {
    const dir = path.join(this.pluginDir, "wasm");
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".wasm"));
  }

  private hasLanceDb(): boolean {
    return fs.existsSync(path.join(this.pluginDir, "node_modules", "@lancedb", "lancedb"));
  }

  // ── manifest ──────────────────────────────────────────────────────────────

  private async fetchManifest(): Promise<BootstrapManifest> {
    const url = `${this.releaseBase}/bootstrap-manifest.json`;
    const res = await requestUrl({ url });
    return res.json as BootstrapManifest;
  }

  // ── file downloads ────────────────────────────────────────────────────────

  private async downloadReleaseAsset(filename: string): Promise<void> {
    const url = `${this.releaseBase}/${filename}`;
    const res = await requestUrl({ url });
    fs.writeFileSync(path.join(this.pluginDir, filename), Buffer.from(res.arrayBuffer));
  }

  private async downloadWasmFiles(files: string[]): Promise<void> {
    const wasmDir = path.join(this.pluginDir, "wasm");
    fs.mkdirSync(wasmDir, { recursive: true });

    for (const file of files) {
      const url = `${this.releaseBase}/${file}`;
      const res = await requestUrl({ url });
      fs.writeFileSync(path.join(wasmDir, file), Buffer.from(res.arrayBuffer));
    }
  }

  // ── npm package installation ───────────────────────────────────────────────

  private async installNpmPackages(
    manifest: BootstrapManifest,
    progress: ProgressFn
  ): Promise<void> {
    const nodeModules = path.join(this.pluginDir, "node_modules");
    fs.mkdirSync(nodeModules, { recursive: true });

    // Platform-independent packages
    for (const pkg of manifest.npmPackages) {
      if (this.packageInstalled(pkg.name)) continue;
      progress(`installing ${pkg.name}@${pkg.version}…`);
      await this.installPackage(pkg, nodeModules);
    }

    // Platform-specific native binary
    const platformKey = this.getPlatformKey();
    const native = manifest.nativePackages[platformKey];
    if (native && !this.packageInstalled(native.name)) {
      progress(`installing ${native.name}@${native.version} (native binary)…`);
      await this.installPackage(native, nodeModules);
    } else if (!native) {
      throw new Error(`No native LanceDB binary available for platform: ${platformKey}`);
    }
  }

  private packageInstalled(name: string): boolean {
    // Scoped package: @scope/name → node_modules/@scope/name
    const rel = name.startsWith("@") ? name : name;
    return fs.existsSync(path.join(this.pluginDir, "node_modules", rel));
  }

  private async installPackage(pkg: NpmPackageEntry, nodeModules: string): Promise<void> {
    const res = await requestUrl({ url: pkg.url });
    const tarball = Buffer.from(res.arrayBuffer);

    // Scoped packages install into node_modules/@scope/name
    const destDir = path.join(nodeModules, pkg.name);
    fs.mkdirSync(destDir, { recursive: true });
    await extractTarGz(tarball, destDir);
  }

  // ── platform detection ────────────────────────────────────────────────────

  private getPlatformKey(): string {
    // process.platform / process.arch are available in Electron renderer
    const plat = process.platform as string;
    const arch = process.arch as string;

    if (plat === "win32" && arch === "x64") return "win32-x64";
    if (plat === "darwin" && arch === "x64") return "darwin-x64";
    if (plat === "darwin" && arch === "arm64") return "darwin-arm64";
    if (plat === "linux" && arch === "x64") return "linux-x64";
    if (plat === "linux" && arch === "arm64") return "linux-arm64";

    throw new Error(`Unsupported platform: ${plat}-${arch}`);
  }
}
