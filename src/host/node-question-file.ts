import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readQuestionSource, type NodeQuestion } from "../shared/node-questions.ts";

export type QuestionIndex = Record<string, NodeQuestion[]>;
const FILE = "node-questions.json";

export async function readQuestionIndex(root: string): Promise<QuestionIndex> {
  const nodes: QuestionIndex = Object.create(null);
  let text: string;
  try { text = await readFile(join(root, FILE), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return nodes;
    throw error;
  }
  const data = JSON.parse(text);
  if (data?.version !== 1 || !data.nodes || typeof data.nodes !== "object" || Array.isArray(data.nodes)) {
    throw new Error("Invalid node question index");
  }
  for (const [nodeId, entries] of Object.entries(data.nodes)) {
    if (!Array.isArray(entries)) throw new Error("Invalid node question list");
    const ids = new Set<string>();
    nodes[nodeId] = entries.map((entry) => {
      if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)
        || typeof entry.title !== "string" || !entry.title.trim() || typeof entry.processed !== "boolean") {
        throw new Error("Invalid node question");
      }
      const source = readQuestionSource(entry.source);
      if (entry.source !== undefined && source === undefined) throw new Error("Invalid node question source");
      ids.add(entry.id);
      return { id: entry.id, title: entry.title, processed: entry.processed, ...(source ? { source } : {}) };
    });
  }
  return nodes;
}

/** Caller holds the library write queue. */
export async function writeQuestionIndex(root: string, nodes: QuestionIndex): Promise<void> {
  const target = join(root, FILE);
  const temp = target + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify({ version: 1, nodes }, null, 2) + "\n", { flag: "wx" });
  try { await rename(temp, target); }
  catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Keep the temporary owner until the note file commits, and resolve note sources through the new ID. */
export async function copyQuestionIdentity(root: string, from: string, to: string): Promise<void> {
  const nodes = await readQuestionIndex(root);
  const owned = nodes[from];
  if (!owned) return;
  const entries = new Map(owned.map((entry) => [
    entry.id,
    entry.source?.kind === "note" && entry.source.nodeId === from
      ? { ...entry, source: { ...entry.source, nodeId: to } }
      : entry,
  ]));
  for (const entry of nodes[to] ?? []) entries.set(entry.id, entry);
  nodes[to] = [...entries.values()];
  await writeQuestionIndex(root, nodes);
}
