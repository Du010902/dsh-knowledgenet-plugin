import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
/** 库内独立理解标记，不改写正文及其冲突指纹。缺失标记表示未理解。 */
export async function readUnderstanding(root: string): Promise<Record<string, boolean>> {
  let text: string;
  try { text = await readFile(join(root, "understanding.json"), "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return {}; throw error; }
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("nodes" in data) || !data.nodes || typeof data.nodes !== "object" || Array.isArray(data.nodes)) throw new Error("Invalid understanding file");
  const result: Record<string, boolean> = Object.create(null);
  for (const [id, value] of Object.entries(data.nodes)) { if (typeof value !== "boolean") throw new Error("Invalid understanding state"); result[id] = value; }
  return result;
}

/** Caller holds the library write queue; readers only observe a complete JSON file. */
export async function writeUnderstandingFile(root: string, nodes: Record<string, boolean>): Promise<void> {
  const target = join(root, "understanding.json");
  const temp = target + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify({ version: 1, nodes }, null, 2) + "\n", { flag: "wx" });
  try { await rename(temp, target); }
  catch (error) {
    await unlink(temp).catch((cleanupError: Error) => { /* Best effort; preserve the original commit error. */ void cleanupError; });
    throw error;
  }
}

/** Preserve the old key until the node file has committed its new ID. Caller holds the write queue. */
export async function copyUnderstandingIdentity(root: string, fromId: string, toId: string): Promise<void> {
  const nodes = await readUnderstanding(root);
  if (!Object.hasOwn(nodes, fromId)) return;
  nodes[toId] = nodes[fromId]!;
  await writeUnderstandingFile(root, nodes);
}
