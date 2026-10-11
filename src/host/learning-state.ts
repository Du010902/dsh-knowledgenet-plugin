/** Plugin-local view leases and first-request entry hints; no Session metadata is written. */
import { resolve } from "node:path";
import { eventsOf } from "./stack.ts";

export function libraryKey(root: string): string {
  const absolute = resolve(root);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
interface ViewFocus {
  sessionId: string; root: string; viewId: string; sequence: number;
  nodeId: string | null; source: "editor" | "graph"; active: boolean; expires: number; order: number;
}
interface EntryHint { root: string; nodeId: string; request?: number }

/** One instance belongs to one plugin activation and is shared only by its API, prompts and tools. */
export class LearningState {
  private views = new Map<string, ViewFocus>();
  private entries = new Map<string, EntryHint>();
  private order = 0;
  constructor(private readonly leaseMs = 45000, private readonly now = Date.now) {}

  /** Accept monotonic updates; inactive records prevent late packets reviving a closed view. */
  update(input: Omit<ViewFocus, "expires" | "order"> & { claim?: boolean }): void {
    const root = libraryKey(input.root);
    const key = JSON.stringify([input.sessionId, root, input.viewId]);
    const previous = this.views.get(key);
    if (previous && previous.sequence >= input.sequence) return;
    this.views.set(key, { ...input, root, expires: this.now() + this.leaseMs, order: input.claim || !previous ? ++this.order : previous.order });
    this.prune();
  }

  /** Return only the most recently active view, never a node from another scope. */
  focus(sessionId: string, root: string): { nodeId: string; source: "editor" | "graph" } | undefined {
    this.prune();
    const views = [...this.views.values()].filter(view => view.active && view.sessionId === sessionId && view.root === libraryKey(root));
    const view = views.sort((a, b) => b.order - a.order)[0];
    return view?.nodeId ? { nodeId: view.nodeId, source: view.source } : undefined;
  }

  /** Record an entry action once; opening an existing conversation does not call this. */
  enter(sessionId: string, root: string, nodeId: string): void {
    if (!this.entries.has(sessionId)) this.entries.set(sessionId, { root: libraryKey(root), nodeId });
  }

  /** A hint survives tool continuations of the first human request, but no subsequent request. */
  entry(sessionId: string, root: string, session: unknown): string | undefined {
    const hint = this.entries.get(sessionId);
    if (!hint || hint.root !== libraryKey(root)) return undefined;
    const events = eventsOf(session);
    const requests = events.filter(event => event.type === "user/message" &&
      (event.data?.source as { form?: unknown } | undefined)?.form === undefined).length;
    const turns = events.filter(event => event.type === "turn/start").length;
    const request = Math.max(requests, turns);
    let lastStart = -1, lastEnd = -1;
    for (let index = 0; index < events.length; index++) {
      if (events[index].type === "turn/start") lastStart = index;
      if (events[index].type === "turn/end") lastEnd = index;
    }
    if (lastStart >= 0 && lastEnd > lastStart) { this.entries.delete(sessionId); return undefined; }
    if (request > 1 || (hint.request !== undefined && request !== hint.request)) {
      this.entries.delete(sessionId); return undefined;
    }
    if (!request) return undefined;
    hint.request = request;
    return hint.nodeId;
  }

  dispose(): void { this.views.clear(); this.entries.clear(); }
  private prune(): void {
    for (const [key, view] of this.views) if (view.expires <= this.now()) this.views.delete(key);
  }
}

/** Agent IDs are Session IDs in the host; tests/headless callers may provide session.id. */
export function modelSessionId(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { id?: string; session?: { id?: string } } } | undefined)?.agent;
  return agent?.session?.id ?? agent?.id;
}
