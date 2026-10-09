import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import type { DocumentTarget } from "./node-document-client.ts";

/** Only standard create/navigation capabilities are borrowed from DSH. */
export interface ConversationServices {
  sessions: { create(options: { cwd: string }): Promise<string>; list?: { getSnapshot(): { byId: Record<string, { title?: string; displayTitle?: string }> } } };
  uiWorkspace: { openSession(sessionId: string): void };
}
export interface ConversationRecord { sessionId: string; createdAt: number }
export interface ConversationList { root: string; cwd: string; conversations: ConversationRecord[] }
type Fetcher = (url: string, options: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Validate plugin HTTP responses, retaining the Host's error message. */
async function request(fetcher: Fetcher, body: object): Promise<ConversationList> {
  const response = await fetcher(GRAPH_API_ROUTE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data: unknown = await response.json();
  if (!response.ok || !data || typeof data !== "object" || !("ok" in data) || data.ok !== true) {
    const error = data && typeof data === "object" && "error" in data ? data.error : null;
    throw new Error(error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "Conversation request failed");
  }
  if (!("root" in data) || typeof data.root !== "string" || !("cwd" in data) || typeof data.cwd !== "string" || !("conversations" in data) || !Array.isArray(data.conversations)) throw new Error("Invalid conversation response");
  const conversations = data.conversations.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("sessionId" in entry) || typeof entry.sessionId !== "string" || !("createdAt" in entry) || typeof entry.createdAt !== "number") throw new Error("Invalid conversation record");
    return { sessionId: entry.sessionId, createdAt: entry.createdAt };
  });
  return { root: data.root, cwd: data.cwd, conversations };
}

/** Isolated workflow; a failed index write retries the same created Session. */
export function makeConversationActions(getServices: () => ConversationServices | undefined, fetcher: Fetcher) {
  const pending = new Map<string, string>();
  const running = new Map<string, Promise<string>>();
  const list = (nodeId: string, target?: DocumentTarget) => request(fetcher, { kind: "node-conversations", ...target, nodeId });
  return {
    list,
    async create(nodeId: string, target?: DocumentTarget): Promise<string> {
      const services = getServices();
      if (!services) throw new Error("DSH conversation service unavailable");
      const info = await list(nodeId, target);
      const key = JSON.stringify([info.root, nodeId]);
      const existing = running.get(key);
      if (existing) return existing;
      const work = (async () => {
        let sessionId = pending.get(key);
        if (!sessionId) { sessionId = await services.sessions.create({ cwd: info.cwd }); pending.set(key, sessionId); }
        await request(fetcher, { kind: "record-node-conversation", root: info.root, nodeId, conversationId: sessionId });
        pending.delete(key);
        return sessionId;
      })();
      running.set(key, work);
      try { return await work; } finally { running.delete(key); }
    },
    open(sessionId: string): void {
      const services = getServices();
      if (!services) throw new Error("DSH conversation service unavailable");
      services.uiWorkspace.openSession(sessionId);
    },
    title(sessionId: string): string {
      const entry = getServices()?.sessions.list?.getSnapshot().byId[sessionId];
      return entry?.title ?? entry?.displayTitle ?? sessionId.slice(0, 12);
    },
  };
}

let getServices: () => ConversationServices | undefined = () => undefined;
/** Attach a lazy, lifetime-owned service lookup from the plugin Client context. */
export function attachConversationServices(lookup: () => ConversationServices | undefined): () => void {
  getServices = lookup;
  return () => { if (getServices === lookup) getServices = () => undefined; };
}
export const nodeConversations = makeConversationActions(() => getServices(), (url, options) => fetch(url, options));
