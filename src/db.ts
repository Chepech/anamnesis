import { join } from "path";

type LanceDB = typeof import("@lancedb/lancedb");
let _lancedb: LanceDB | null = null;

async function getLanceDB(pluginDir: string): Promise<LanceDB> {
  if (!_lancedb) {
    _lancedb = await import(join(pluginDir, "node_modules", "@lancedb", "lancedb")) as unknown as LanceDB;
  }
  return _lancedb!;
}

/** Bump this whenever the ChunkRecord schema changes to trigger a re-index prompt. */
export const SCHEMA_VERSION = "2";

export interface ChunkRecord extends Record<string, unknown> {
  id: string;              // "<file_path>:<chunk_index>"
  file_path: string;
  heading: string;         // last heading seen (flat)
  context_path: string;    // full heading hierarchy: "Infrastructure > Database > Migration"
  chunk_index: number;
  last_modified: number;   // Unix ms
  text: string;            // raw chunk content (no breadcrumb)
  vector: number[];
  tags: string;            // comma-separated YAML tags
  importance_score: number; // backlink count; used for post-retrieval boosting
  schema_version: string;  // matches SCHEMA_VERSION constant
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
    const lancedb = await getLanceDB(this.pluginDir);
    this.db = await lancedb.connect(this.dbPath);
    console.debug("[Anamnesis] LanceDB connected at", this.dbPath);
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
        context_path: "",
        chunk_index: 0,
        last_modified: 0,
        text: "",
        vector: new Array(this.vectorDim).fill(0),
        tags: "",
        importance_score: 0,
        schema_version: SCHEMA_VERSION,
      },
    ];

    const table = await this.db.createTable(CHUNKS_TABLE, seed);
    await table.delete('id = "__seed__"');
    console.debug(`[Anamnesis] Created chunks table (dim=${this.vectorDim}, schema=v${SCHEMA_VERSION})`);
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
      console.debug("[Anamnesis] Dropped chunks table");
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

  /**
   * Returns the schema_version stored in the table, or "1" if the column
   * pre-dates versioning, or null if the table doesn't exist yet.
   */
  async getSchemaVersion(): Promise<string | null> {
    if (!this.db) throw new Error("DB not connected");
    const tableNames = await this.db.tableNames();
    if (!tableNames.includes(CHUNKS_TABLE)) return null;

    const table = await this.db.openTable(CHUNKS_TABLE);
    const schema = await table.schema();

    // If the schema_version column doesn't exist, this is a pre-v2 table
    const hasVersionCol = schema.fields.some((f) => f.name === "schema_version");
    if (!hasVersionCol) return "1";

    // Read one row to get the stored version string
    const rows = await table.query().limit(1).toArray();
    if (rows.length === 0) return SCHEMA_VERSION; // empty table — treat as current
    return String((rows[0] as any).schema_version ?? "1");
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
    limit: number = 10,
    importanceWeight: number = 0
  ): Promise<ChunkRecord[]> {
    if (!this.db) throw new Error("DB not connected");
    const table = await this.db.openTable(CHUNKS_TABLE);
    const rows = await table
      .vectorSearch(vector)
      .limit(limit)
      .toArray();

    if (importanceWeight <= 0) return rows as unknown as ChunkRecord[];

    // Apply importance boost: lower _distance is better, so subtract the boost
    return (rows as any[])
      .map((r) => ({
        ...r,
        _boosted_score:
          (r._distance ?? 1) -
          importanceWeight * Math.log(1 + (r.importance_score ?? 0)),
      }))
      .sort((a, b) => a._boosted_score - b._boosted_score) as unknown as ChunkRecord[];
  }

  close(): void {
    this.db = null;
  }
}
