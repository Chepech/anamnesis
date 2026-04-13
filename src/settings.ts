import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type AnamnesisPlugin from "./main";

export interface PluginSettings {
  embeddingProvider: "local" | "openai";
  localModelName: string;
  openaiApiKey: string;
  openaiModelName: string;
  chunkSize: number;
  chunkOverlap: number;
  excludePatterns: string; // newline-separated globs
  autoIndexOnChange: boolean;
  /** Dimension of the currently indexed vectors — used to detect model switches. */
  indexedVectorDim: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  embeddingProvider: "local",
  localModelName: "Xenova/all-MiniLM-L6-v2",
  openaiApiKey: "",
  openaiModelName: "text-embedding-3-small",
  chunkSize: 512,
  chunkOverlap: 64,
  excludePatterns: ".obsidian\nnode_modules\nArchives",
  autoIndexOnChange: true,
  indexedVectorDim: 0, // 0 means no index yet
};

export class AnamnesisSettingTab extends PluginSettingTab {
  plugin: AnamnesisPlugin;

  constructor(app: App, plugin: AnamnesisPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Anamnesis" });

    // ── Embedding provider ─────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Embeddings" });

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Local runs offline (~23 MB model download on first use). OpenAI requires an API key.")
      .addDropdown((drop) =>
        drop
          .addOption("local", "Local (offline)")
          .addOption("openai", "OpenAI API")
          .setValue(this.plugin.settings.embeddingProvider)
          .onChange(async (value: string) => {
            this.plugin.settings.embeddingProvider = value as "local" | "openai";
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.embeddingProvider === "local") {
      new Setting(containerEl)
        .setName("Local model")
        .setDesc("HuggingFace model ID. Changing this requires a full re-index.")
        .addDropdown((drop) =>
          drop
            .addOption("Xenova/all-MiniLM-L6-v2", "all-MiniLM-L6-v2 (384-dim, fast)")
            .addOption("Xenova/all-mpnet-base-v2", "all-mpnet-base-v2 (768-dim, better quality)")
            .setValue(this.plugin.settings.localModelName)
            .onChange(async (value: string) => {
              this.plugin.settings.localModelName = value;
              await this.plugin.saveSettings();
            })
        );
    }

    if (this.plugin.settings.embeddingProvider === "openai") {
      new Setting(containerEl)
        .setName("OpenAI API key")
        .setDesc("Stored in plugin data, never synced.")
        .addText((text) =>
          text
            .setPlaceholder("sk-...")
            .setValue(this.plugin.settings.openaiApiKey)
            .onChange(async (value: string) => {
              this.plugin.settings.openaiApiKey = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("OpenAI model")
        .addDropdown((drop) =>
          drop
            .addOption("text-embedding-3-small", "text-embedding-3-small (1536-dim)")
            .addOption("text-embedding-3-large", "text-embedding-3-large (3072-dim)")
            .setValue(this.plugin.settings.openaiModelName)
            .onChange(async (value: string) => {
              this.plugin.settings.openaiModelName = value;
              await this.plugin.saveSettings();
            })
        );
    }

    // ── Indexing ────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Indexing" });

    new Setting(containerEl)
      .setName("Auto-index on change")
      .setDesc("Re-embed modified notes in the background.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoIndexOnChange)
          .onChange(async (value: boolean) => {
            this.plugin.settings.autoIndexOnChange = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Chunk size")
      .setDesc("Max characters per chunk (default 512).")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.chunkSize))
          .onChange(async (value: string) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n >= 64) {
              this.plugin.settings.chunkSize = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Chunk overlap")
      .setDesc("Characters of overlap between consecutive chunks (default 64).")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.chunkOverlap))
          .onChange(async (value: string) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n >= 0) {
              this.plugin.settings.chunkOverlap = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Exclude patterns")
      .setDesc("One folder or glob per line. Matching files are skipped.")
      .addTextArea((area) =>
        area
          .setValue(this.plugin.settings.excludePatterns)
          .onChange(async (value: string) => {
            this.plugin.settings.excludePatterns = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Actions ─────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Actions" });

    new Setting(containerEl)
      .setName("Re-index entire vault")
      .setDesc("Drops and rebuilds the vector index from scratch.")
      .addButton((btn) =>
        btn
          .setButtonText("Re-index now")
          .setCta()
          .onClick(async () => {
            new Notice("[Anamnesis] Starting full re-index…");
            await this.plugin.triggerFullIndex();
          })
      );
  }
}
