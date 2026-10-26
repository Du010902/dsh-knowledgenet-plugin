import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isUlid } from "./v3/ulid.ts";

/** A node-owned navigation record; no Session metadata is written. */
export interface NodeConversation { sessionId: string; createdAt: number }
/** The complete plugin-owned index: node ID ⇒ its navigation records. */
export type ConversationRecords = Record<string, NodeConversation[]>;

/** Read the complete plugin-owned index, refusing damaged records. */
export async function readConversationIndex(root: string): Promise<ConversationRecords> {
  let text: string;
  try { text = await readFile(join(root, "node-conversations.json"), "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return Object.create(null); throw error; }
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("nodes" in data) || !data.nodes || typeof data.nodes !== "object" || Array.isArray(data.nodes)) throw new Error("Invalid node conversation index");
  const nodes: ConversationRecords = Object.create(null);
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
export async function writeConversationIndex(root: string, nodes: ConversationRecords): Promise<void> {
  const target = join(root, "node-conversations.json");
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 1, nodes }, null, 2) + "\n", { flag: "wx" });
  try { await rename(temp, target); }
  catch (error) { await unlink(temp).catch((cleanupError: Error) => { void cleanupError; }); throw error; }
}

/**
 * **读取时**决定每条对话归哪个节点 ✓；一条对话最多显示在一个节点下 ✓。
 *
 * 为什么需要（用户实测 2026-10-25）：DSH 会复用工作区里的**空白会话** ⇒ 节点 1 和节点 2 先后
 * "打开新对话"可能拿到**同一个 sessionId** ✗；旧客户端创建后立即记录，于是索引里同一 sessionId
 * 被两个节点各记一条 ✗。旧记录**不改写**（历史文件保持原样 ✓），只在读取时隐藏旧归属 ✓。
 *
 * 规则（同刻也必须**确定性** ✓，同一份索引无论对象键顺序如何都得到同一个答案 ✓）：
 * 1. `createdAt` **最新**的那条胜出 ✓ —— 即"最新一次显式认领胜出" ✓（正常写入路径已经保证只剩一条 ✓）；
 * 2. `createdAt` 相同时，**正式 ULID 身份优先于临时 `adopted-*` 身份** ✓：普通 Markdown 首次保存
 *    固化正式 ID 时，`copyConversationIdentity` 会把旧身份下的记录**复制**一份（崩溃安全 ✓，见其注释），
 *    于是同刻出现新旧两份；旧身份对应的节点此后解析不到（节点文件已带上新 ULID ✓）⇒ 归给 ULID ✓；
 * 3. 仍相同时（同类身份）按节点 ID 的**码元序**取较大者 ✓。规则宁可武断，也要可复现 ✓。
 *
 * @param nodes - `readConversationIndex` 读出的完整索引。
 * @returns sessionId ⇒ nodeId 的归属表 ✓（列表、记录返回值都按它过滤 ✓）。
 */
export function conversationOwners(nodes: ConversationRecords): Map<string, string> {
  const best = new Map<string, { nodeId: string; createdAt: number }>();
  for (const [nodeId, records] of Object.entries(nodes)) {
    for (const record of records) {
      const previous = best.get(record.sessionId);
      if (previous !== undefined && !winsOwnership(nodeId, record.createdAt, previous.nodeId, previous.createdAt)) continue;
      best.set(record.sessionId, { nodeId, createdAt: record.createdAt });
    }
  }
  const owners = new Map<string, string>();
  for (const [sessionId, record] of best) owners.set(sessionId, record.nodeId);
  return owners;
}

/** Ownership comparison for {@link conversationOwners}; keep the rules in sync with its doc comment. */
function winsOwnership(nodeId: string, createdAt: number, ownerId: string, ownerCreatedAt: number): boolean {
  if (createdAt !== ownerCreatedAt) return createdAt > ownerCreatedAt;
  const permanent = isUlid(nodeId), ownerPermanent = isUlid(ownerId);
  if (permanent !== ownerPermanent) return permanent;
  return nodeId > ownerId;
}

/**
 * Copy navigation history before an ordinary Markdown node adopts its permanent ID.
 *
 * 这里**故意是复制而不是移动** ✓：节点正文文件还没提交新 ID 时若写盘失败，旧身份下的历史不能丢 ✗。
 * 代价是复制后新旧身份下各留一份**同刻**记录 ✓ ⇒ `conversationOwners` 的同刻规则把归属判给正式 ULID ✓，
 * 旧临时身份的记录只被隐藏、不主动清理 ✓（与"已有重复不改写历史文件"一致 ✓）。
 */
export async function copyConversationIdentity(root: string, from: string, to: string): Promise<void> {
  const nodes = await readConversationIndex(root);
  if (!Object.hasOwn(nodes, from)) return;
  const byId = new Map((nodes[to] ?? []).map(entry => [entry.sessionId, entry]));
  for (const entry of nodes[from]!) if (!byId.has(entry.sessionId)) byId.set(entry.sessionId, entry);
  nodes[to] = [...byId.values()];
  await writeConversationIndex(root, nodes);
}
