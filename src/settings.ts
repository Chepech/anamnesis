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
  /**
   * How aggressively to process file changes.
   * conservative: 30s delay — batches many edits into one pass.
   * aggressive:   5s delay  — picks up changes quickly at the cost of more writes.
   */
  indexingStrategy: "conservative" | "aggressive";
  /** Whether to run the local MCP server. */
  mcpEnabled: boolean;
  /** Port the MCP HTTP server listens on (127.0.0.1 only). */
  mcpPort: number;
  /**
   * Weight applied to the backlink count boost during search reranking.
   * 0 = pure semantic similarity. Higher values surface well-linked notes more.
   */
  importanceWeight: number;
  /** True after the first successful indexAll completes. Prevents auto-reindex on every startup. */
  initialIndexDone: boolean;
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
  indexingStrategy: "conservative",
  mcpEnabled: false,
  mcpPort: 8868,
  importanceWeight: 0.05,
  initialIndexDone: false,
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
      const warning = containerEl.createDiv({ cls: "anamnesis-openai-warning" });
      warning.createEl("span", {
        text: "⚠ Privacy: when using the OpenAI provider, your note content (in chunks of up to 512 characters) is sent to the OpenAI Embeddings API to compute vectors. Nothing is stored on their servers by default, but your text is processed there. The local provider (default) makes no network requests.",
      });

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
      .setName("Indexing strategy")
      .setDesc(
        "Conservative (30 s): waits 30 seconds after the last change before writing to the index — " +
        "great for heavy editing sessions. " +
        "Aggressive (5 s): picks up changes within 5 seconds at the cost of more frequent writes."
      )
      .addDropdown((drop) =>
        drop
          .addOption("conservative", "Conservative — 30 s delay")
          .addOption("aggressive", "Aggressive — 5 s delay")
          .setValue(this.plugin.settings.indexingStrategy)
          .onChange(async (value: string) => {
            this.plugin.settings.indexingStrategy = value as "conservative" | "aggressive";
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

    // ── Search ──────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Search" });

    new Setting(containerEl)
      .setName("Graph importance boost")
      .setDesc(
        "How much to boost notes that are heavily linked to by other notes. " +
        "0 = pure semantic similarity. 0.05 is a subtle nudge; 0.2+ makes backlink count dominant. " +
        "Takes effect immediately — no re-index needed."
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 0.5, 0.01)
          .setValue(this.plugin.settings.importanceWeight)
          .setDynamicTooltip()
          .onChange(async (value: number) => {
            this.plugin.settings.importanceWeight = value;
            await this.plugin.saveSettings();
          })
      );

    // ── MCP Server ──────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "MCP Server" });

    new Setting(containerEl)
      .setName("Enable MCP server")
      .setDesc(
        "Starts a local HTTP server so Claude Desktop (and other MCP clients) can " +
        "search your vault in real time. Bound to 127.0.0.1 — not accessible over the network."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mcpEnabled)
          .onChange(async (value: boolean) => {
            this.plugin.settings.mcpEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.mcpEnabled) {
      new Setting(containerEl)
        .setName("Port")
        .setDesc("Restart the plugin after changing the port.")
        .addText((text) =>
          text
            .setValue(String(this.plugin.settings.mcpPort))
            .onChange(async (value: string) => {
              const n = parseInt(value, 10);
              if (!isNaN(n) && n >= 1024 && n <= 65535) {
                this.plugin.settings.mcpPort = n;
                await this.plugin.saveSettings();
              }
            })
        );

      // Claude Desktop config snippet
      const port = this.plugin.settings.mcpPort;
      const snippet = JSON.stringify(
        { mcpServers: { anamnesis: { url: `http://localhost:${port}/mcp` } } },
        null,
        2
      );
      const snippetSetting = new Setting(containerEl)
        .setName("Claude Desktop config")
        .setDesc("Add this to claude_desktop_config.json under mcpServers:")
        .addButton((btn) =>
          btn
            .setIcon("copy")
            .setTooltip("Copy to clipboard")
            .onClick(async () => {
              await navigator.clipboard.writeText(snippet);
              btn.setIcon("check");
              btn.buttonEl.style.color = "var(--color-green)";
              setTimeout(() => {
                btn.setIcon("copy");
                btn.buttonEl.style.color = "";
              }, 2000);
            })
        );
      const pre = snippetSetting.settingEl.createEl("pre", { cls: "anamnesis-mcp-snippet" });
      pre.setText(snippet);
    }

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
