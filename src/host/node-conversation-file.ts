import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** A node-owned navigation record; no Session metadata is written. */
export interface NodeConversation { sessionId: string; createdAt: number }
type Records = Record<string, NodeConversation[]>;

/** Read the complete plugin-owned index, refusing damaged records. */
export async function readConversationIndex(root: string): Promise<Records> {
  let text: string;
  try { text = await readFile(join(root, "node-conversations.json"), "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return Object.create(null); throw error; }
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("nodes" in data) || !data.nodes || typeof data.nodes !== "object" || Array.isArray(data.nodes)) throw new Error("Invalid node conversation index");
  const nodes: Records = Object.create(null);
  for (const [id, entries] of Object.entries(data.nodes)) {
    if (!Array.isArray(entries)) throw new Error("Invalid node conversation records");
    nodes[id] = entries.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("sessionId" in entry) || typeof entry.sessionId !== "string" || !entry.sessionId.trim() || !("createdAt" in entry) || typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt) || entry.createdAt < 0) throw new Error("Invalid node conversation record");
      return { sessionId: entry.sessionId, createdAt: entry.createdAt };
    });
  }
  return nodes;
}

/** Caller owns the library write queue; replace the index atomically. */
export async function writeConversationIndex(root: string, nodes: Records): Promise<void> {
  const target = join(root, "node-conversations.json");
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 1, nodes }, null, 2) + "\n", { flag: "wx" });
  try { await rename(temp, target); }
  catch (error) { await unlink(temp).catch((cleanupError: Error) => { void cleanupError; }); throw error; }
}

/** Copy navigation history before an ordinary Markdown node adopts its permanent ID. */
export async function copyConversationIdentity(root: string, from: string, to: string): Promise<void> {
  const nodes = await readConversationIndex(root);
  if (!Object.hasOwn(nodes, from)) return;
  const byId = new Map((nodes[to] ?? []).map(entry => [entry.sessionId, entry]));
  for (const entry of nodes[from]!) if (!byId.has(entry.sessionId)) byId.set(entry.sessionId, entry);
  nodes[to] = [...byId.values()];
  await writeConversationIndex(root, nodes);
}
