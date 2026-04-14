/**
 * Anamnesis MCP Server
 *
 * Exposes the vault index as a local MCP server over Streamable HTTP.
 * Claude Desktop connects via: { "url": "http://localhost:PORT/mcp" }
 *
 * Tools:
 *   search_vault         — semantic search, returns ranked chunks
 *   read_note            — full markdown content of a vault note
 *   list_indexed_files   — all indexed paths with chunk counts
 */

import * as http from "http";
import { App, TFile } from "obsidian";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { VectorDB } from "./db";
import type { EmbeddingProvider } from "./embedding/bridge";

export type McpStatus = "stopped" | "running" | "error";

export class AnamnesisServerMCP {
  private db: VectorDB;
  private provider: EmbeddingProvider;
  private app: App;

  private mcpServer: McpServer;
  private httpServer: http.Server | null = null;
  private _status: McpStatus = "stopped";
  private _port = 0;
  private _error = "";

  constructor(db: VectorDB, provider: EmbeddingProvider, app: App) {
    this.db = db;
    this.provider = provider;
    this.app = app;

    this.mcpServer = new McpServer({ name: "Anamnesis", version: "1.0.0" });
    this.registerTools();
  }

  get status(): McpStatus { return this._status; }
  get port(): number { return this._port; }
  get error(): string { return this._error; }

  async start(port: number): Promise<void> {
    if (this.httpServer) await this.stop();

    this._port = port;
    this._error = "";

    this.httpServer = http.createServer(async (req, res) => {
      // CORS — Claude Desktop is a native app but some clients are browser-based
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url !== "/mcp") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      // Each request gets its own stateless transport instance
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });

      res.on("close", () => transport.close());

      try {
        await this.mcpServer.connect(transport);
        const body = await readBody(req);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(String(err));
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.on("error", (err) => {
        this._status = "error";
        this._error = (err as NodeJS.ErrnoException).code === "EADDRINUSE"
          ? `Port ${port} is already in use`
          : err.message;
        reject(new Error(this._error));
      });
      this.httpServer!.listen(port, "127.0.0.1", () => {
        this._status = "running";
        console.log(`[Anamnesis] MCP server listening on http://127.0.0.1:${port}/mcp`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.httpServer) return;
    await new Promise<void>((resolve) => {
      this.httpServer!.close(() => resolve());
    });
    this.httpServer = null;
    this._status = "stopped";
    console.log("[Anamnesis] MCP server stopped");
  }

  // ── Tools ──────────────────────────────────────────────────────────────────

  private registerTools(): void {
    // ── search_vault ─────────────────────────────────────────────────────────
    this.mcpServer.tool(
      "search_vault",
      "Semantic search over the Obsidian vault. Returns the most relevant chunks " +
        "ranked by cosine similarity to the query.",
      {
        query: z.string().min(1).describe("Natural language search query"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Maximum number of chunks to return (default 10, max 50)"),
      },
      async ({ query, limit }) => {
        const [queryVec] = await this.provider.embed([query]);
        const rows = await this.db.search(queryVec, limit);

        const results = rows.map((r: any) => ({
          file_path: r.file_path as string,
          context_path: r.context_path as string,
          heading: r.heading as string,
          chunk_index: r.chunk_index as number,
          text: r.text as string,
          tags: r.tags as string,
          importance_score: r.importance_score as number,
          // LanceDB adds _distance for vector search; cosine distance ∈ [0,2]
          // for unit vectors, so similarity = 1 - distance/2 gives a clean [0,1] score.
          score: r._distance !== undefined
            ? Math.max(0, 1 - (r._distance as number) / 2)
            : null,
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        };
      }
    );

    // ── read_note ─────────────────────────────────────────────────────────────
    this.mcpServer.tool(
      "read_note",
      "Read the full current content of a vault note by its vault-relative path.",
      {
        path: z
          .string()
          .describe('Vault-relative path, e.g. "Forge/Research/topic.md"'),
      },
      async ({ path }) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
          return {
            content: [{ type: "text" as const, text: `Note not found: ${path}` }],
            isError: true,
          };
        }
        const content = await this.app.vault.read(file);
        const wordCount = content.split(/\s+/).filter(Boolean).length;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ path, word_count: wordCount, content }, null, 2),
            },
          ],
        };
      }
    );

    // ── list_indexed_files ────────────────────────────────────────────────────
    this.mcpServer.tool(
      "list_indexed_files",
      "List all files currently in the Anamnesis vector index, with their chunk counts.",
      {},
      async () => {
        const chunks = await this.db.getAllChunks();

        const counts = new Map<string, number>();
        for (const c of chunks) {
          counts.set(c.file_path, (counts.get(c.file_path) ?? 0) + 1);
        }

        const files = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([path, chunk_count]) => ({ path, chunk_count }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify(files, null, 2) }],
        };
      }
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        resolve(raw); // let the transport handle malformed JSON
      }
    });
    req.on("error", reject);
  });
}
