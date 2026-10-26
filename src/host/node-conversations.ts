import { readNodeFast, withLibraryWrite } from "./v3/store.ts";
import { conversationOwners, readConversationIndex, writeConversationIndex, type ConversationRecords, type NodeConversation } from "./node-conversation-file.ts";

/**
 * 当前节点**可见**的历史：先按归属过滤 ✓（旧重复里非最新认领的节点不显示 ✓），
 * 再按 createdAt 降序 ✓。同一节点内若还留着同一会话的多条旧记录，只显示最新一条 ✓
 * （与文件里其它重复一样：读取时隐藏，不改写历史文件 ✓）。
 */
function visibleConversations(nodes: ConversationRecords, nodeId: string): NodeConversation[] {
  const owners = conversationOwners(nodes);
  const seen = new Set<string>();
  return (nodes[nodeId] ?? [])
    .filter(entry => owners.get(entry.sessionId) === nodeId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter(entry => {
      if (seen.has(entry.sessionId)) return false;
      seen.add(entry.sessionId);
      return true;
    });
}

/** Read one node's navigation history without reading or changing Session files. */
export async function listNodeConversations(root: string, nodeId: string): Promise<NodeConversation[]> {
  const node = await readNodeFast(root, nodeId);
  if (!node.ok) throw new Error("没有找到这个知识点");
  return visibleConversations(await readConversationIndex(root), nodeId);
}

/**
 * Record a successfully created Session once, serializing concurrent library changes.
 *
 * **移动语义**（用户实测 2026-10-25）：同一条对话**最多只属于一个节点** ✓，最新一次显式认领胜出 ✓。
 * DSH 会复用工作区的空白会话 ⇒ 节点 1、节点 2 先后创建可能拿到同一个 sessionId ✗；旧写法直接在
 * 当前节点追加，于是两个节点都记录 ✗。现在先删掉**其它节点**上的同一 sessionId（旧认领 ✓），
 * 再在当前节点插入（createdAt=Date.now()）✓；已经归当前节点时不再插新记录（重复认领幂等 ✓），
 * 只在索引确实有变化时写盘 ✓。
 */
export async function recordNodeConversation(root: string, nodeId: string, sessionId: string): Promise<NodeConversation[]> {
  return withLibraryWrite(root, async () => {
    /* 节点必须真的存在 ✓；索引损坏时 readConversationIndex 直接抛错 ⇒ 绝不覆盖 ✗（与旧行为一致 ✓） */
    const node = await readNodeFast(root, nodeId);
    if (!node.ok) throw new Error("没有找到这个知识点");
    const nodes = await readConversationIndex(root);
    let changed = false;
    for (const [otherId, entries] of Object.entries(nodes)) {
      if (otherId === nodeId) continue;
      const kept = entries.filter(entry => entry.sessionId !== sessionId);
      if (kept.length === entries.length) continue;
      if (kept.length === 0) delete nodes[otherId]; else nodes[otherId] = kept;
      changed = true;
    }
    if ((nodes[nodeId] ?? []).some(entry => entry.sessionId === sessionId)) {
      /* 已经归当前节点 ⇒ 幂等：createdAt 不变、不重复插入 ✓（只在刚删掉别的节点旧记录时写盘 ✓） */
      if (changed) await writeConversationIndex(root, nodes);
      return visibleConversations(nodes, nodeId);
    }
    nodes[nodeId] = [...(nodes[nodeId] ?? []), { sessionId, createdAt: Date.now() }];
    await writeConversationIndex(root, nodes);
    return visibleConversations(nodes, nodeId);
  });
}
