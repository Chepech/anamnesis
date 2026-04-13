# Anamnesis

*From Greek ἀνάμνησις — the act of recollection, recovering what was always known.*

Anamnesis is an Obsidian plugin that turns your vault into a queryable semantic memory system. It continuously indexes your notes into a local vector database, provides semantic search by meaning rather than keyword, visualizes the conceptual structure of your knowledge as an interactive graph, and exposes everything to AI agents via the Model Context Protocol (MCP).

---

## What It Does

- **Local-first indexing** — embeds every note into a 384-dimensional vector using a bundled ML model. No network required. Everything runs inside Obsidian.
- **Semantic search** — find notes by concept, not exact wording. Ask "what did I write about decision fatigue?" and it finds relevant passages even if those words don't appear.
- **Vector graph** — a 2D map of your entire vault's semantic space, where proximity means conceptual similarity.
- **MCP server** *(planned)* — exposes retrieval tools to AI agents like Claude Code so they can query your vault as a knowledge source during conversations.

---

## Interface

### Control Panel

Opened via the ribbon icon or `Anamnesis: Open control panel` in the command palette. Lives in the right sidebar.

Shows:
- Current indexing status with a pulsing indicator
- Chunk count and active model
- Re-index, Pause, and Resume controls
- Buttons to open Semantic Search and the Vector Graph

### Semantic Search

Opens in the right sidebar alongside the control panel (like Obsidian's native Backlinks pane). Type a natural-language query and Anamnesis embeds it on the fly, searches the vector index, and returns the most semantically relevant notes grouped by file. Results link directly to the source note.

### Vector Graph

Opens as a full editor tab. An interactive canvas showing all indexed notes as nodes in 2D semantic space.

#### How the graph works

Each note is represented by a 384-dimensional embedding vector — a point in high-dimensional space where direction encodes meaning. Notes about similar topics end up close together; unrelated notes are far apart.

**UMAP** (Uniform Manifold Approximation and Projection) compresses those 384 dimensions down to 2 for display. It works by building a graph of nearest neighbors in high-dimensional space, then finding a 2D layout that preserves the same neighborhood structure as faithfully as possible. Notes that were close in 384D stay close in 2D. The layout takes ~200–300 optimization epochs to converge — you'll see the progress percentage in the status bar while it runs.

**Edges** are drawn between the top-5 nearest neighbors of each node, computed from cosine similarity in the original 384D space (not the projected 2D). Thicker, more opaque edges mean higher similarity. Two notes with a thin faint edge share some conceptual overlap; two notes with a thick bright edge are closely related.

**Node colors** represent top-level vault folders:

| Color | Meaning |
|-------|---------|
| Each unique color | One top-level folder in your vault |
| Nodes of the same color | Notes from the same folder |

Up to 12 distinct folder colors cycle through the palette. Notes at the vault root get their own color. The color legend isn't rendered on canvas — hover a node to see its full file path in the tooltip.

**Navigation:**
- Scroll to zoom (zooms toward the mouse cursor)
- Drag to pan
- Hover a node to see the file name and a text snippet
- Click a node to open the note in the editor

### Status Bar

The `Anamnesis: Ready` item in the bottom-right status bar is interactive. Click it to:
- **While idle**: trigger a re-index or open the control panel
- **While indexing**: pause or cancel the current run
- **While paused**: resume or cancel
- **On error**: see the error and retry

---

## Setup

1. Build: `npm run build`
2. Deploy to vault: `node scripts/deploy.mjs "path/to/vault"`
3. Enable the plugin in Obsidian → Settings → Community plugins
4. The plugin will load the embedding model on first run (~23 MB download, cached locally)
5. Click **Re-index vault** to build the initial index

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
| Auto-index on change | On | Re-embeds modified notes in the background. |

Changing the embedding model requires a full re-index (different models produce incompatible vector spaces).

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
| Agent Protocol | MCP SDK *(planned)* |

---

## Architecture

```
Obsidian Vault
     │
     ▼
VaultWatcher         — listens to create / modify / delete / rename events
     │
     ▼
IndexingEngine       — chunks Markdown, batches embedding calls, manages mtime cache
     │
     ├──▶ LocalEmbeddingProvider   (@xenova/transformers, fully offline)
     └──▶ OpenAIEmbeddingProvider  (optional, requires API key)
               │
               ▼
           LanceDB                 — fixed-size vector table on local disk
               │
         ┌─────┴──────┐
         ▼             ▼
   SemanticSearch   VectorGraph
   (right sidebar)  (editor tab, UMAP → Canvas2D)
```

---

## Roadmap

- [ ] MCP server — expose `semantic_search`, `contextual_retrieve`, `reindex` to agents
- [ ] Hybrid search — BM25 keyword + vector similarity combined
- [ ] Approximate k-NN for large vaults (>2k notes)
- [ ] Web Worker for UMAP (avoid blocking UI on very large graphs)
- [ ] Graph legend overlay showing folder → color mapping
- [ ] Feedback loop for search relevance tuning
