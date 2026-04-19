# Anamnesis

*From Greek ἀνάμνησις — the act of recollection, recovering what was always known.*

Anamnesis is an Obsidian plugin that turns your vault into a queryable semantic memory system. It continuously indexes your notes into a local vector database, provides semantic search by meaning rather than keyword, visualizes the conceptual structure of your knowledge as an interactive graph, and exposes everything to AI agents via the Model Context Protocol (MCP).

---

## What It Does

- **Context-aware indexing** — chunks notes along heading boundaries, preserving the full heading hierarchy and injecting it into every embedding. A chunk from a `## Database` section inside `# Infrastructure` carries that structural address into its vector, so searches surface the right note even when the query keywords don't appear in the chunk itself.
- **Graph-aware embeddings** — notes that are heavily linked to by other notes get a semantic boost. If 20 notes about "database scaling" link to "Migration Plan," that note's vector will be close to "database scaling" queries even if those exact words don't appear in its text.
- **Semantic search** — find notes by concept, not exact wording. Results show the full heading path to the matching passage and any YAML tags associated with the note.
- **Vector graph** — a 2D map of your vault's semantic space, where proximity means conceptual similarity.
- **MCP server** — exposes retrieval tools to AI agents (Claude Code, Claude Desktop, any MCP client) so they can query your vault as a live knowledge source during conversations.

---

## Getting Started

### Why this plugin requires a build step

Anamnesis depends on two components that cannot be bundled into a single `main.js`:

- **LanceDB** — a native Rust addon (`.node` binary). npm automatically picks the right binary for your OS and architecture when you run `npm install`.
- **ONNX Runtime WASM** — several `.wasm` files that the local embedding model loads at runtime via `file://` URLs.

Because of this, the standard Obsidian plugin install (community directory or manual copy of `main.js` + `manifest.json`) will not work on its own. You need to build from source so that `npm install` fetches the correct native binary for your platform and the deploy script places everything in the right layout.

### Supported platforms

| Platform | Architecture | Status |
|---|---|---|
| Windows | x64 | Tested |
| macOS | x64, arm64 (Apple Silicon) | Binaries available, untested |
| Linux | x64, arm64 | Binaries available, untested |

### Install (build from source)

**Requirements:** Node.js 18+ and npm.

```sh
git clone https://github.com/Chepech/anamnesis
cd anamnesis
npm install
npm run build
```

Then deploy to your vault:

```sh
# Windows
node scripts/deploy.mjs "C:/path/to/your/vault"

# macOS / Linux — edit scripts/deploy.mjs first:
# Replace "@lancedb/lancedb-win32-x64-msvc" with the package that matches your platform:
#   macOS Apple Silicon:  @lancedb/lancedb-darwin-arm64
#   macOS Intel:          @lancedb/lancedb-darwin-x64
#   Linux x64:            @lancedb/lancedb-linux-x64-gnu
#   Linux arm64:          @lancedb/lancedb-linux-arm64-gnu
node scripts/deploy.mjs "/path/to/your/vault"
```

Then enable the plugin in Obsidian → Settings → Community plugins and click **Re-index vault**.

> The model download (~23 MB for the default `all-MiniLM-L6-v2`) happens on first run and is cached locally after that.

---

## Indexing Pipeline

### Context-Aware Chunking

The chunker splits Markdown at heading boundaries — a chunk never crosses a `#` line. Each chunk carries:

- **`context_path`** — the full heading hierarchy leading to that chunk: `"Infrastructure > Database > Migration"`. This is injected into the text before embedding so the vector encodes structural position, not just content.
- **`heading`** — the immediate heading (preserved for compatibility).
- **`tags`** — YAML frontmatter tags extracted and stored as searchable metadata.

### Breadcrumb Injection

Before embedding, each chunk's text is prefixed with a breadcrumb:

```
[Note Title] > [Infrastructure > Database] :: The actual chunk text here...
```

The stored `text` field keeps the raw content. Only the vector is computed from the breadcrumb-injected form. This means a query like "why did we choose Postgres?" finds the infrastructure note because "Infrastructure" is baked into the vector even if the chunk itself only says "we moved to PostgreSQL."

### Graph-Aware Embeddings (Backlink Boost)

During indexing, each note's backlinks are resolved via `metadataCache.resolvedLinks`. The top 5 incoming link titles are appended to the first chunk's embedding text:

```
[Note Title] :: First paragraph... Linked from: Database Scaling, Project Phoenix, Architecture Overview
```

The `importance_score` (backlink count) is stored per chunk and used to apply a small post-retrieval boost during search:

```
final_score = distance - (importance_weight × log(1 + importance_score))
```

The `importance_weight` is tunable in settings (default `0.05`) — small enough that semantic similarity stays dominant, but enough to break ties in favor of well-connected notes.

### Full Re-index vs. Incremental Update

**Full re-index** — triggered via the Re-index button or command. Drops the entire LanceDB table and rebuilds from scratch. The only way to guarantee consistency; necessary after model changes or schema updates.

**Incremental update** — triggered by the `VaultWatcher` on `create`, `modify`, `rename`, and `delete` events (500ms debounce). For a modified file: checks the in-memory mtime cache, deletes existing chunks for that path, re-chunks and re-embeds, stores fresh records. For deleted/renamed files: deletes by path and evicts from the mtime cache.

---

## Interface

### Control Panel

Opened via the ribbon icon or `Anamnesis: Open control panel` in the command palette. Lives in the right sidebar.

Shows:
- Current indexing status with a live progress indicator
- Chunk count and active model
- Re-index, Pause, and Resume controls
- Buttons to open Semantic Search and the Vector Graph

### Semantic Search

Opens in the right sidebar. Type a natural-language query — Anamnesis embeds it on the fly, searches the vector index (with optional backlink boost), and returns the most semantically relevant notes grouped by file. Each result shows the full `context_path` to the matching passage and any associated tags. Results link directly to the source note.

### Vector Graph

Opens as a full editor tab. An interactive canvas showing all indexed notes as nodes in 2D semantic space.

Each note is represented by its first chunk's 384-dimensional embedding vector. **UMAP** compresses those dimensions to 2 for display, preserving neighborhood structure — notes that were close in high-dimensional space stay close in 2D. **Edges** connect the top-5 nearest neighbors of each node by cosine similarity in the original space; thickness and opacity reflect similarity strength.

**Node colors** represent top-level vault folders. Hover a node for the file name and snippet; click to open the note.

**Navigation:** scroll to zoom, drag to pan.

### Status Bar

The database icon in the bottom-right status bar is interactive. Click it to:
- **While idle**: trigger a re-index or open the control panel
- **While indexing**: pause or cancel the current run
- **While paused**: resume or cancel
- **On error**: see the error and retry

---

## MCP Server

Anamnesis can run a local MCP server, making your vault queryable from any MCP-compatible agent.

**Enable:** Settings → MCP Server → toggle on. Default port: `8868`.

**Claude Desktop config:**
```json
{
  "mcpServers": {
    "anamnesis": { "url": "http://localhost:8868/mcp" }
  }
}
```

The config snippet (with copy button) is available directly in plugin settings.

### Tools

| Tool | Description |
|------|-------------|
| `search_vault` | Semantic search. Returns ranked chunks with `file_path`, `context_path`, `text`, `tags`, `importance_score`, and similarity `score`. |
| `read_note` | Full markdown content of a note by vault-relative path. |
| `list_indexed_files` | All indexed file paths with chunk counts, sorted by chunk count. |

---

## Setup

See [Getting Started](#getting-started) above — build from source is required for all platforms. The deploy script handles the full layout including native binaries and WASM files.

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Provider | Local | `local` runs fully offline. `openai` uses the OpenAI embeddings API. |
| Local model | all-MiniLM-L6-v2 | 384-dim, fast. Alternative: all-mpnet-base-v2 (768-dim, higher quality). |
| OpenAI model | text-embedding-3-small | Only shown when provider is OpenAI. |
| Chunk size | 512 | Max characters per chunk. |
| Chunk overlap | 64 | Characters of overlap between consecutive chunks. |
| Exclude patterns | `.obsidian`, `node_modules`, `Archives` | One folder/glob per line. Matching files are skipped. |
| Auto-index on change | On | Re-embeds modified notes in the background. Paused when a schema or model change is detected until re-index completes. |
| Indexing strategy | Conservative | Conservative (30 s delay) batches edits; Aggressive (5 s) picks up changes faster. |
| Graph importance boost | 0.05 | How much backlink count influences search ranking. 0 = pure semantic similarity. Takes effect immediately, no re-index needed. |
| MCP enabled | Off | Starts the local HTTP MCP server. |
| MCP port | 8868 | Port the MCP server listens on (127.0.0.1 only). |

Changing the embedding model or triggering a schema update (new plugin version) requires a full re-index. The plugin will display a notice on load and suppress the background watcher until re-indexing is complete.

---

## Privacy & Data

By default Anamnesis runs **entirely offline**. The local embedding provider (all-MiniLM-L6-v2 / all-mpnet-base-v2) downloads once from Hugging Face (~23–90 MB) and runs inside Obsidian via ONNX Runtime. No note content ever leaves your device when using the local provider.

**OpenAI provider (optional):** if you switch to the OpenAI embedding provider in settings, your note content is sent to the [OpenAI Embeddings API](https://platform.openai.com/docs/guides/embeddings) to compute vectors. Specifically:
- Text chunks of your notes (up to 512 characters each) are transmitted to `api.openai.com` on every index and re-index.
- OpenAI does not store API inputs by default (see [OpenAI data usage policies](https://openai.com/policies/api-data-usage-policies)), but your content is processed on their servers.
- Your API key is stored locally in Obsidian's plugin data and is never sent anywhere except to OpenAI's API endpoint.

The MCP server binds to `127.0.0.1` only and is not accessible outside your local machine.

---

## Technical Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript |
| Plugin API | Obsidian Plugin API |
| Bundler | esbuild (CJS, 3 custom plugins for Electron compat) |
| Vector DB | LanceDB (native Rust addon, loaded at runtime) |
| Local Embeddings | @xenova/transformers + onnxruntime-web (bundled) |
| Remote Embeddings | OpenAI SDK (optional) |
| Dimensionality Reduction | umap-js |
| Visualization | Canvas 2D |
| Agent Protocol | MCP SDK (Streamable HTTP) |

---

## Architecture

```
Obsidian Vault
     │
     ▼
VaultWatcher         — create / modify / delete / rename events, 500ms debounce
     │
     ▼
IndexingEngine       — heading-boundary chunking, breadcrumb injection,
     │                 backlink resolution, YAML tag extraction, mtime cache
     │
     ├──▶ LocalEmbeddingProvider   (@xenova/transformers, fully offline)
     └──▶ OpenAIEmbeddingProvider  (optional, requires API key)
               │
               ▼
           LanceDB                 — vector + metadata table on local disk
           (context_path, tags,     schema versioned; mismatch triggers re-index notice
            importance_score,
            schema_version)
               │
     ┌─────────┼──────────┐
     ▼         ▼           ▼
SemanticSearch  VectorGraph  MCP Server
(right sidebar) (UMAP →      (Streamable HTTP,
                 Canvas2D)    127.0.0.1 only)
```

---

## Roadmap

- [x] MCP server — `search_vault`, `read_note`, `list_indexed_files`
- [x] Context-aware chunking — heading-boundary splits, full hierarchy tracking
- [x] Breadcrumb injection — structural address embedded into every vector
- [x] Graph-aware embeddings — backlink boost for well-connected notes
- [x] YAML tag extraction — tags stored as filterable metadata
- [ ] Parent-child multi-vector retrieval — summary + chunk at two resolutions
- [ ] Hybrid search — BM25 keyword + vector similarity combined
- [ ] Approximate k-NN for large vaults (>2k notes)
- [ ] Graph legend overlay showing folder → color mapping
- [ ] Search relevance feedback loop
