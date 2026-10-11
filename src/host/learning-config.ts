/** Plugin-owned limits for model queries; graph rendering uses its existing budget. */
export interface LearningConfigInput {
  modelMaxNodes?: number | null;
  modelMaxEdges?: number | null;
  noteMaxChars?: number | null;
  maxNoteChars?: number | null;
  searchLimit?: number | null;
  relationLimit?: number | null;
  relationDescriptionChars?: number | null;
  structureMaxNodes?: number | null;
  structureMaxEdges?: number | null;
  structureMaxChars?: number | null;
  focusLeaseMs?: number | null;
}
export interface LearningConfig {
  modelMaxNodes: number; modelMaxEdges: number; noteMaxChars: number; maxNoteChars: number;
  searchLimit: number; relationLimit: number; relationDescriptionChars: number;
  structureMaxNodes: number; structureMaxEdges: number; structureMaxChars: number;
  focusLeaseMs: number;
}
/** Resolve validated model-query defaults without changing any DSH setting. */
export function resolveLearningConfig(config: LearningConfigInput = {}): LearningConfig {
  const defaults: LearningConfig = { modelMaxNodes: 40, modelMaxEdges: 100, noteMaxChars: 3000, maxNoteChars: 12000, searchLimit: 5, relationLimit: 5, relationDescriptionChars: 240, structureMaxNodes: 200, structureMaxEdges: 400, structureMaxChars: 24000, focusLeaseMs: 45000 };
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof LearningConfig>) {
    const value = config[key];
    if (value === undefined || value === null) continue;
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("KnowledgeNet config." + key + " must be a positive safe integer");
    result[key] = value;
  }
  if (result.noteMaxChars > result.maxNoteChars) throw new TypeError("noteMaxChars must not exceed maxNoteChars");
  if (result.focusLeaseMs < 3000) throw new TypeError("focusLeaseMs must be at least 3000");
  return result;
}
/** Validate a paging parameter and apply the configured ceiling. */
export function pageNumber(value: unknown, fallback: number, ceiling: number, zero = false): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new TypeError("Paging values must be safe integers in range");
  return Math.min(value, ceiling);
}
