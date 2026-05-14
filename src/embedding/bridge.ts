export interface EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  initialize(): Promise<void>;
  /** Embed a batch of texts. Returns one vector per text. */
  embed(texts: string[]): Promise<number[][]>;
  /** Release any background resources (e.g. Web Worker). Optional. */
  terminate?(): void;
}

// ── Worker message protocol ────────────────────────────────────────────────

/** main → worker: initialise the pipeline */
export interface WorkerInitMsg {
  type: "init";
  pluginDir: string;
  modelName: string;
  cacheDir: string;
  dim: number;
}

/** main → worker: embed a batch of texts */
export interface WorkerEmbedMsg {
  type: "embed";
  id: number;
  texts: string[];
}

/** worker → main: model download progress */
export interface WorkerProgressMsg {
  type: "progress";
  status: string;
  file?: string;
  progress?: number;
}

/** worker → main: pipeline is ready */
export interface WorkerReadyMsg {
  type: "ready";
}

/** worker → main: successful embed result */
export interface WorkerResultMsg {
  type: "result";
  id: number;
  flat: number[];
  dim: number;
}

/** worker → main: error (id present = embed error; id absent = init error) */
export interface WorkerErrorMsg {
  type: "error";
  id?: number;
  message: string;
}

/** Union of all messages sent from worker → main */
export type WorkerToMainMsg = WorkerProgressMsg | WorkerReadyMsg | WorkerResultMsg | WorkerErrorMsg;

/** Union of all messages sent from main → worker */
export type MainToWorkerMsg = WorkerInitMsg | WorkerEmbedMsg;
