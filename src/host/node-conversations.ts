import { readNodeFast, withLibraryWrite } from "./v3/store.ts";
import { readConversationIndex, writeConversationIndex, type NodeConversation } from "./node-conversation-file.ts";

/** Read one node's navigation history without reading or changing Session files. */
export async function listNodeConversations(root: string, nodeId: string): Promise<NodeConversation[]> {
  const node = await readNodeFast(root, nodeId);
  if (!node.ok) throw new Error("没有找到这个知识点");
  return ((await readConversationIndex(root))[nodeId] ?? []).slice().sort((a, b) => b.createdAt - a.createdAt);
}

/** Record a successfully created Session once, serializing concurrent library changes. */
export async function recordNodeConversation(root: string, nodeId: string, sessionId: string): Promise<NodeConversation[]> {
  return withLibraryWrite(root, async () => {
    const node = await readNodeFast(root, nodeId);
    if (!node.ok) throw new Error("没有找到这个知识点");
    const nodes = await readConversationIndex(root);
    const entries = nodes[nodeId] ?? [];
    if (!entries.some(entry => entry.sessionId === sessionId)) {
      nodes[nodeId] = [...entries, { sessionId, createdAt: Date.now() }];
      await writeConversationIndex(root, nodes);
    }
    return (nodes[nodeId] ?? []).slice().sort((a, b) => b.createdAt - a.createdAt);
  });
}
