import { join } from "path";
import type { EmbeddingProvider } from "./bridge";

type OpenAIModule = typeof import("openai");

const OPENAI_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

const OPENAI_BATCH_SIZE = 128;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimension: number;

  private pluginDir: string;
  private apiKey: string;
  private modelName: string;
  private client: InstanceType<OpenAIModule["default"]> | null = null;

  constructor(pluginDir: string, apiKey: string, modelName = "text-embedding-3-small") {
    this.pluginDir = pluginDir;
    this.apiKey = apiKey;
    this.modelName = modelName;
    this.dimension = OPENAI_DIMS[modelName] ?? 1536;
  }

  async initialize(): Promise<void> {
    const mod = await import(join(this.pluginDir, "node_modules", "openai")) as unknown as OpenAIModule;
    const OpenAI = mod.default;
    this.client = new OpenAI({
      apiKey: this.apiKey,
      dangerouslyAllowBrowser: true,
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.client) throw new Error("OpenAIEmbeddingProvider not initialized");

    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += OPENAI_BATCH_SIZE) {
      const batch = texts.slice(i, i + OPENAI_BATCH_SIZE);
      const response = await this.client.embeddings.create({
        model: this.modelName,
        input: batch,
      });
      response.data
        .sort((a, b) => a.index - b.index)
        .forEach((item) => results.push(item.embedding));
    }
    return results;
  }
}
