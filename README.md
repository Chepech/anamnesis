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

## Installation

### Community directory (pending)

The plugin is pending review in the Obsidian community directory. Once approved it will be installable via Settings → Community plugins → Browse → search "Anamnesis".

### Manual install (no build required)

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Chepech/anamnesis/releases/latest).
2. Copy them into your vault at `.obsidian/plugins/anamnesis/`.
3. Enable the plugin in Obsidian → Settings → Community plugins.

On first load the plugin automatically downloads the remaining runtime components (see [First-run setup](#first-run-setup) below).

### Build from source (development)

**Requirements:** Node.js 20+ and npm.

```sh
git clone https://github.com/Chepech/anamnesis
cd anamnesis
npm install
node scripts/setup-eslint-plugin.mjs   # downloads pre-built dist or builds from source
npm run build
```

Deploy to your vault:

```sh
node scripts/deploy.mjs "/path/to/your/vault"
```

---

## First-run setup

Anamnesis depends on two components that cannot be distributed through the Obsidian community directory:

- **LanceDB** — a native Rust addon (`.node` binary). The correct binary depends on your OS and CPU architecture.
- **ONNX Runtime WASM** — several `.wasm` files loaded by the local embedding model at runtime.

On first load (or after a fresh install where these files are absent), the plugin detects what is missing and downloads it automatically from the GitHub release, showing a progress notice in the bottom-right corner. This happens once; subsequent loads skip the check.

| Component | Source |
|-----------|--------|
| `embedder-worker.js` | GitHub release asset |
| `wasm/*.wasm` | GitHub release asset |
| `@lancedb/lancedb` and dependencies | npm registry (tarballs from `package-lock.json`) |
| Platform-specific native binary | npm registry (correct binary for your OS/arch) |

### Supported platforms

| Platform | Architecture | Status |
|---|---|---|
| Windows | x64 | Tested |
| macOS | x64, arm64 (Apple Silicon) | Supported, untested |
| Linux | x64, arm64 | Supported, untested |

> The embedding model (~23 MB for the default `all-MiniLM-L6-v2`) is downloaded from Hugging Face on first use and cached locally after that.

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

**Claude Desktop / Claude Code config:**
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
| First-run bootstrap | Custom downloader + ustar tar.gz extractor (Node built-ins only) |
| Vector DB | LanceDB (native Rust addon, loaded at runtime via `window.require`) |
| Local Embeddings | @xenova/transformers + onnxruntime-web (WASM, bundled) |
| Remote Embeddings | OpenAI SDK (optional, loaded at runtime) |
| Dimensionality Reduction | umap-js |
| Visualization | Canvas 2D |
| Agent Protocol | MCP SDK (Streamable HTTP) |

---

## Architecture

```
Obsidian Vault
     │
     ▼
Bootstrapper         — on first load: downloads embedder-worker.js, wasm/*.wasm,
     │                 and the correct LanceDB native binary from GitHub release
     │                 and npm registry; skipped on subsequent loads
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
- [x] Self-bootstrapping install — downloads native binary and WASM on first run, no build step required
- [x] Hybrid search — BM25 keyword + semantic combined via Reciprocal Rank Fusion
- [ ] Community directory listing (pending review)
- [ ] Multilingual embedding model (paraphrase-multilingual-MiniLM-L12-v2)
- [ ] Fuzzy title matching (Jaro-Winkler)
- [ ] Parent-child multi-vector retrieval — summary + chunk at two resolutions
- [ ] Approximate k-NN for large vaults (>2k notes)
- [ ] Search relevance feedback loop

---

## Changelog

### Unreleased

- **Hybrid search** — BM25 keyword retrieval runs in parallel with semantic vector search; results are merged using Reciprocal Rank Fusion (k=60). Each result card shows `~` (semantic) and `K` (keyword) badges so you can see why a note surfaced. Falls back to pure semantic if hybrid is disabled in settings. `search_vault` MCP tool now returns `match_sources` per chunk.
- **Self-bootstrapping install** — plugin detects missing runtime components on first load and downloads them automatically: `embedder-worker.js` and `wasm/*.wasm` from the GitHub release, `@lancedb/lancedb` and the correct platform-specific native binary from the npm registry. No build step required for end users.
- **CI/CD pipeline** — GitHub Actions CI (lint, prettier, type-check, build) runs on every push and PR. Release workflow builds all artifacts and publishes a tagged GitHub release with `bootstrap-manifest.json` included.

### 1.0.2

- Fixed startup reindex race: on first install `initialIndexDone` was never set, causing a full reindex on every startup after the first
- Fixed pause button state machine — pause/resume during the initial index run no longer gets stuck
- Fixed file safety during index: files deleted or moved while `indexAll()` is running are now skipped gracefully instead of crashing the run
- Added obsidian-plugin ESLint ruleset with full lint enforcement across the codebase
- Added Prettier formatting enforcement

### 1.0.1

- Fixed LanceDB native module loading via `window.require` for popout window compatibility
- Resolved all ObsidianReviewBot lint violations for community plugin submission
- Submitted to the Obsidian community plugin directory (pending review)

### 1.0.0

- **Semantic search** — find notes by concept using local `all-MiniLM-L6-v2` embeddings (384-dim, fully offline). Optional OpenAI provider for higher-quality embeddings.
- **Context-aware chunking** — notes split at heading boundaries; each chunk carries the full heading hierarchy (`Infrastructure > Database > Migration`) injected into the embedding so structural position is encoded into the vector
- **Graph-aware embeddings** — backlink count stored as `importance_score`; optional post-retrieval boost surfaces well-connected notes
- **Vector graph** — interactive 2D map of vault semantic space via UMAP; nodes colored by top-level folder, click to open note
- **MCP server** — local Streamable HTTP server exposing `search_vault`, `read_note`, and `list_indexed_files` to Claude Code, Claude Desktop, and any MCP client
- **Incremental indexing** — vault watcher re-embeds modified notes in the background with a configurable delay (5 s aggressive / 30 s conservative)
- **Schema versioning** — index schema is versioned; mismatch on load triggers a re-index notice
