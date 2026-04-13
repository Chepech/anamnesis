import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import { UMAP } from "umap-js";
import type { VectorDB, ChunkRecord } from "./db";

export const GRAPH_VIEW_TYPE = "anamnesis-graph";

// One colour per top-level folder (cycles after 12)
const PALETTE = [
  "#7c8cff", "#ff7c8c", "#7cffb0", "#ffd97c",
  "#c87cff", "#7ce8ff", "#ff9f7c", "#b0ff7c",
  "#ff7ce8", "#7cccff", "#ffe07c", "#a0ffc8",
];

// Edges per node — top-K nearest neighbours get a line
const K_NEIGHBOURS = 5;

interface GraphNode {
  x: number;
  y: number;
  filePath: string;
  label: string;
  snippet: string;
  color: string;
}

interface GraphEdge {
  a: number; // index into nodes[]
  b: number;
  strength: number; // cosine similarity 0-1
}

export class GraphView extends ItemView {
  private vectorDB: VectorDB;

  private canvasEl!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private statusEl!: HTMLElement;

  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private folderColor: Map<string, string> = new Map();
  private pan = { x: 0, y: 0 };
  private zoom = 1;
  private dragging = false;
  private dragStart = { x: 0, y: 0 };
  private panStart = { x: 0, y: 0 };
  private hoveredNode: GraphNode | null = null;
  private tooltipEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, vectorDB: VectorDB) {
    super(leaf);
    this.vectorDB = vectorDB;
  }

  getViewType(): string { return GRAPH_VIEW_TYPE; }
  getDisplayText(): string { return "Anamnesis Graph"; }
  getIcon(): string { return "git-fork"; }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.style.cssText = "position:relative;display:flex;flex-direction:column;height:100%;padding:0;";

    // Top bar with status + rebuild button
    const topBar = root.createDiv();
    topBar.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:6px 10px;flex-shrink:0;border-bottom:1px solid var(--background-modifier-border);";

    this.statusEl = topBar.createEl("span");
    this.statusEl.style.cssText = "flex:1;font-size:12px;color:var(--text-muted);";
    this.statusEl.setText("Loading vectors…");

    const rebuildBtn = topBar.createEl("button");
    rebuildBtn.setText("Rebuild");
    rebuildBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    rebuildBtn.addEventListener("click", async () => {
      rebuildBtn.disabled = true;
      this.nodes = [];
      this.edges = [];
      this.draw(); // clear canvas immediately
      try {
        await this.buildGraph();
      } finally {
        rebuildBtn.disabled = false;
      }
    });

    this.canvasEl = root.createEl("canvas");
    this.canvasEl.style.cssText = "flex:1;min-height:0;cursor:crosshair;display:block;";
    this.ctx = this.canvasEl.getContext("2d")!;

    this.tooltipEl = root.createDiv();
    this.tooltipEl.style.cssText = [
      "position:absolute;pointer-events:none;display:none;",
      "background:var(--background-primary);border:1px solid var(--background-modifier-border);",
      "border-radius:6px;padding:6px 10px;font-size:12px;max-width:240px;",
      "box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:100;line-height:1.4;",
    ].join("");

    this.bindEvents();
    this.resizeCanvas();
    await this.buildGraph();
  }

  private buildLegend(root: HTMLElement, folderColor: Map<string, string>): void {
    // Remove any existing legend
    root.querySelector(".anamnesis-graph-legend")?.remove();

    if (folderColor.size === 0) return;

    const legend = root.createDiv("anamnesis-graph-legend");
    legend.createEl("div", { cls: "anamnesis-legend-title", text: "Folders" });

    for (const [folder, color] of folderColor) {
      const row = legend.createDiv("anamnesis-legend-row");
      const dot = row.createDiv("anamnesis-legend-dot");
      dot.style.background = color;
      row.createEl("span", { cls: "anamnesis-legend-label", text: folder });
    }
  }

  async onClose(): Promise<void> {}

  // ── Graph build ────────────────────────────────────────────────────────────

  private async buildGraph(): Promise<void> {
    this.statusEl.setText("Fetching index…");

    let chunks: ChunkRecord[];
    try {
      chunks = await this.vectorDB.getAllChunks();
    } catch (err) {
      this.statusEl.setText(`Error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (chunks.length === 0) {
      this.statusEl.setText("No indexed notes yet — run Re-index first.");
      return;
    }

    // Dedupe: one representative chunk per file (first encountered)
    const seen = new Set<string>();
    const unique: ChunkRecord[] = [];
    for (const c of chunks) {
      if (!seen.has(c.file_path)) {
        seen.add(c.file_path);
        unique.push(c);
      }
    }


    // Convert vectors from whatever LanceDB returns (Float32Array subarray)
    // to plain number[] that UMAP can safely iterate
    const vectors: number[][] = unique.map((c) =>
      Array.from(c.vector as unknown as ArrayLike<number>)
    );

    this.statusEl.setText(`Computing layout for ${unique.length} notes…`);

    // Colour by top-level folder
    this.folderColor = new Map<string, string>();
    let colorIdx = 0;
    const getColor = (fp: string) => {
      const folder = fp.includes("/") ? fp.split("/")[0] : "root";
      if (!this.folderColor.has(folder)) this.folderColor.set(folder, PALETTE[colorIdx++ % PALETTE.length]);
      return this.folderColor.get(folder)!;
    };

    // UMAP projection — yields between epochs, so UI stays alive
    const nEpochs = 300;
    const nNeighbors = Math.min(15, Math.max(2, unique.length - 1));
    const umap = new UMAP({ nComponents: 2, nEpochs, nNeighbors, minDist: 0.05 });

    let coords: number[][];
    try {
      coords = await umap.fitAsync(vectors, (epoch) => {
        if (epoch % 30 === 0) {
          const pct = Math.round((epoch / nEpochs) * 100);
          this.statusEl.setText(`Layout ${pct}%…`);
        }
      });
    } catch (err) {
      this.statusEl.setText(`UMAP error: ${err instanceof Error ? err.message : String(err)}`);
      console.error("[Anamnesis] UMAP failed:", err);
      return;
    }

    // Normalise to [0, 1]
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of coords) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const rX = maxX - minX || 1;
    const rY = maxY - minY || 1;

    this.nodes = unique.map((c, i) => ({
      x: (coords[i][0] - minX) / rX,
      y: (coords[i][1] - minY) / rY,
      filePath: c.file_path,
      label: c.file_path.replace(/\.md$/, "").split("/").pop() ?? c.file_path,
      snippet: c.text.replace(/\s+/g, " ").trim().slice(0, 120),
      color: getColor(c.file_path),
    }));

    // k-NN edges from cosine similarity in original vector space
    this.statusEl.setText("Computing edges…");
    this.edges = computeKNNEdges(vectors, K_NEIGHBOURS);

    this.pan = { x: 0, y: 0 };
    this.zoom = 1;
    this.statusEl.setText(
      `${unique.length} notes · ${this.edges.length} edges — scroll to zoom, drag to pan`
    );

    const root = this.containerEl.children[1] as HTMLElement;
    this.buildLegend(root, this.folderColor);
    this.draw();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private draw(): void {
    const { ctx, nodes, edges, pan, zoom } = this;
    const W = this.cw;
    const H = this.ch;
    if (W === 0 || H === 0) return;

    ctx.clearRect(0, 0, W, H);
    if (nodes.length === 0) return;

    const pad = 48;
    const scaleX = (W - 2 * pad) * zoom;
    const scaleY = (H - 2 * pad) * zoom;

    const toScreen = (wx: number, wy: number) => ({
      sx: pad + (wx + pan.x) * scaleX,
      sy: pad + (wy + pan.y) * scaleY,
    });

    // Draw edges first (behind nodes)
    for (const edge of edges) {
      const a = nodes[edge.a];
      const b = nodes[edge.b];
      const { sx: ax, sy: ay } = toScreen(a.x, a.y);
      const { sx: bx, sy: by } = toScreen(b.x, b.y);

      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.strokeStyle = `rgba(150,150,150,${edge.strength * 0.35})`;
      ctx.lineWidth = edge.strength * 1.5;
      ctx.stroke();
    }

    // Draw nodes
    const baseRadius = Math.max(3, Math.min(7, zoom * 5));

    for (const node of nodes) {
      const { sx, sy } = toScreen(node.x, node.y);
      const isHovered = node === this.hoveredNode;
      const r = isHovered ? baseRadius * 1.8 : baseRadius;

      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.globalAlpha = isHovered ? 1 : 0.8;
      ctx.fill();

      if (isHovered) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.9;
        ctx.stroke();

        // Label
        ctx.globalAlpha = 1;
        ctx.fillStyle = "var(--text-normal)";
        ctx.font = `${Math.max(10, zoom * 11)}px var(--font-interface)`;
        ctx.fillText(node.label, sx + r + 4, sy + 4);
      }
    }

    ctx.globalAlpha = 1;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private bindEvents(): void {
    const c = this.canvasEl;

    const ro = new ResizeObserver(() => { this.resizeCanvas(); this.draw(); });
    ro.observe(c);
    this.register(() => ro.disconnect());

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      // Zoom toward mouse position
      const mx = (e.clientX - rect.left - 48) / ((this.cw - 96) * this.zoom);
      const my = (e.clientY - rect.top - 48) / ((this.ch - 96) * this.zoom);
      const factor = e.deltaY < 0 ? 1.12 : 0.9;
      const newZoom = Math.max(0.2, Math.min(20, this.zoom * factor));
      // Adjust pan so zoom is centered on mouse
      this.pan.x = mx - (mx - this.pan.x) * (newZoom / this.zoom);
      this.pan.y = my - (my - this.pan.y) * (newZoom / this.zoom);
      this.zoom = newZoom;
      this.draw();
    }, { passive: false });

    c.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.panStart = { ...this.pan };
      c.style.cursor = "grabbing";
    });

    this.register(() => {
      window.removeEventListener("mousemove", this._onMouseMove);
      window.removeEventListener("mouseup", this._onMouseUp);
    });
    window.addEventListener("mousemove", this._onMouseMove);
    window.addEventListener("mouseup", this._onMouseUp);

    c.addEventListener("click", () => {
      if (this.hoveredNode) this.openFile(this.hoveredNode.filePath);
    });
  }

  private _onMouseMove = (e: MouseEvent) => {
    const rect = this.canvasEl.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    if (this.dragging) {
      const scaleX = (this.cw - 96) * this.zoom;
      const scaleY = (this.ch - 96) * this.zoom;
      this.pan.x = this.panStart.x + (e.clientX - this.dragStart.x) / scaleX;
      this.pan.y = this.panStart.y + (e.clientY - this.dragStart.y) / scaleY;
      this.draw();
      return;
    }

    const pad = 48;
    const scaleX = (this.cw - 2 * pad) * this.zoom;
    const scaleY = (this.ch - 2 * pad) * this.zoom;
    const toScreen = (wx: number, wy: number) => ({
      sx: pad + (wx + this.pan.x) * scaleX,
      sy: pad + (wy + this.pan.y) * scaleY,
    });

    const hitRadius = 10;
    let found: GraphNode | null = null;
    for (const node of this.nodes) {
      const { sx, sy } = toScreen(node.x, node.y);
      if (Math.hypot(cx - sx, cy - sy) < hitRadius) { found = node; break; }
    }

    if (found !== this.hoveredNode) {
      this.hoveredNode = found;
      this.draw();
    }

    if (found) {
      this.tooltipEl.style.display = "block";
      const parentRect = (this.containerEl.children[1] as HTMLElement).getBoundingClientRect();
      this.tooltipEl.style.left = `${e.clientX - parentRect.left + 14}px`;
      this.tooltipEl.style.top = `${e.clientY - parentRect.top + 14}px`;
      this.tooltipEl.innerHTML =
        `<strong style="display:block;margin-bottom:3px">${found.label}</strong>` +
        `<span style="color:var(--text-muted);font-size:11px">${found.snippet}…</span>`;
    } else {
      this.tooltipEl.style.display = "none";
    }
  };

  private _onMouseUp = () => {
    this.dragging = false;
    this.canvasEl.style.cursor = "crosshair";
  };

  private resizeCanvas(): void {
    const c = this.canvasEl;
    const dpr = window.devicePixelRatio ?? 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (w === 0 || h === 0) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    this.ctx = this.canvasEl.getContext("2d")!;
    this.ctx.scale(dpr, dpr);
  }

  private get cw(): number { return this.canvasEl.clientWidth; }
  private get ch(): number { return this.canvasEl.clientHeight; }

  private async openFile(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    }
  }
}

// ── k-NN edge computation ──────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function computeKNNEdges(vectors: number[][], k: number): GraphEdge[] {
  const n = vectors.length;
  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];

  for (let i = 0; i < n; i++) {
    // Compute similarity to all other nodes
    const sims: Array<{ j: number; sim: number }> = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      sims.push({ j, sim: cosine(vectors[i], vectors[j]) });
    }
    sims.sort((a, b) => b.sim - a.sim);

    for (const { j, sim } of sims.slice(0, k)) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (!edgeSet.has(key) && sim > 0) {
        edgeSet.add(key);
        edges.push({ a: i, b: j, strength: sim });
      }
    }
  }

  return edges;
}
