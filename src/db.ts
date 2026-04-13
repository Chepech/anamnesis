import { join } from "path";

type LanceDB = typeof import("@lancedb/lancedb");
let _lancedb: LanceDB | null = null;

function getLanceDB(pluginDir: string): LanceDB {
  if (!_lancedb) {
    _lancedb = require(join(pluginDir, "node_modules", "@lancedb", "lancedb"));
  }
  return _lancedb!;
}

export interface ChunkRecord extends Record<string, unknown> {
  id: string;           // "<file_path>:<chunk_index>"
  file_path: string;
  heading: string;
  chunk_index: number;
  last_modified: number; // Unix ms
  text: string;
  vector: number[];
}

export const CHUNKS_TABLE = "chunks";

export class VectorDB {
  private db: import("@lancedb/lancedb").Connection | null = null;
  private dbPath: string;
  private vectorDim: number;
  private pluginDir: string;

  constructor(dataDir: string, vectorDim: number, pluginDir: string) {
    this.dbPath = join(dataDir, "lancedb");
    this.vectorDim = vectorDim;
    this.pluginDir = pluginDir;
  }

  async connect(): Promise<void> {
    const lancedb = getLanceDB(this.pluginDir);
    this.db = await lancedb.connect(this.dbPath);
    console.log("[Anamnesis] LanceDB connected at", this.dbPath);
  }

  async ensureTable(): Promise<import("@lancedb/lancedb").Table> {
    if (!this.db) throw new Error("DB not connected");

    const tableNames = await this.db.tableNames();
    if (tableNames.includes(CHUNKS_TABLE)) {
      return this.db.openTable(CHUNKS_TABLE);
    }

    const seed: ChunkRecord[] = [
      {
        id: "__seed__",
        file_path: "",
        heading: "",
        chunk_index: 0,
        last_modified: 0,
        text: "",
        vector: new Array(this.vectorDim).fill(0),
      },
    ];

    const table = await this.db.createTable(CHUNKS_TABLE, seed);
    await table.delete('id = "__seed__"');
    console.log(`[Anamnesis] Created chunks table (dim=${this.vectorDim})`);
    return table;
  }

  async openTable(): Promise<import("@lancedb/lancedb").Table> {
    if (!this.db) throw new Error("DB not connected");
    return this.db.openTable(CHUNKS_TABLE);
  }

  async dropTable(): Promise<void> {
    if (!this.db) throw new Error("DB not connected");
    const tableNames = await this.db.tableNames();
    if (tableNames.includes(CHUNKS_TABLE)) {
      await this.db.dropTable(CHUNKS_TABLE);
      console.log("[Anamnesis] Dropped chunks table");
    }
  }

  async getStoredDim(): Promise<number | null> {
    if (!this.db) throw new Error("DB not connected");
    const tableNames = await this.db.tableNames();
    if (!tableNames.includes(CHUNKS_TABLE)) return null;

    const table = await this.db.openTable(CHUNKS_TABLE);
    const schema = await table.schema();
    const vectorField = schema.fields.find((f) => f.name === "vector");
    if (!vectorField) return null;

    const listType = vectorField.type as any;
    return listType.listSize ?? null;
  }

  async countRows(): Promise<number> {
    if (!this.db) return 0;
    const tableNames = await this.db.tableNames();
    if (!tableNames.includes(CHUNKS_TABLE)) return 0;
    const table = await this.db.openTable(CHUNKS_TABLE);
    return table.countRows();
  }

  async getAllChunks(): Promise<ChunkRecord[]> {
    if (!this.db) throw new Error("DB not connected");
    const table = await this.db.openTable(CHUNKS_TABLE);
    const total = await table.countRows();
    const rows = await table.query().limit(Math.max(total, 1)).toArray();
    return rows as unknown as ChunkRecord[];
  }

  async search(
    vector: number[],
    limit: number = 10
  ): Promise<ChunkRecord[]> {
    if (!this.db) throw new Error("DB not connected");
    const table = await this.db.openTable(CHUNKS_TABLE);
    const rows = await table
      .vectorSearch(vector)
      .limit(limit)
      .toArray();
    return rows as unknown as ChunkRecord[];
  }

  async close(): Promise<void> {
    this.db = null;
  }
}
