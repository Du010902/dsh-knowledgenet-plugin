/** Replay learning navigation from successful, durable tool results. */
export interface SessionEventLike {
  type?: string;
  data?: Record<string, unknown>;
}
export interface KnowledgeResult { name: string; value: Record<string, unknown>; index: number }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function payload(content: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const raw of content) {
    const block = record(raw);
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    try { const value = record(JSON.parse(block.text)); if (value?.ok === true) return value; }
    catch (error) { void error; /* Non-JSON text is not a KnowledgeNet state result. */ }
  }
  return undefined;
}
/** Pair native calls/results and include successful PTC sub-dispatches in log order. */
export function knowledgeResults(events: readonly SessionEventLike[]): KnowledgeResult[] {
  const calls = new Map<string, string>();
  const results: KnowledgeResult[] = [];
  const completed = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const data = record(event?.data);
    if (!data) continue;
    if (event.type === "tool/call" && typeof data.callId === "string" && typeof data.name === "string") {
      calls.set(data.callId, data.name);
    } else if (event.type === "tool/result") {
      const message = record(data.message);
      const source = record(message?.source);
      const callId = source?.callId ?? message?.callId;
      if (typeof callId !== "string" || completed.has(callId)) continue;
      completed.add(callId);
      const name = calls.get(callId);
      if (!name?.startsWith("kn_") || message?.isError === true) continue;
      const value = payload(message?.content);
      if (value) results.push({ name, value, index });
    } else if (event.type === "tool/ptc-dispatch" && typeof data.name === "string" && data.name.startsWith("kn_") && data.isError !== true) {
      const value = payload(data.content);
      if (value) results.push({ name: data.name, value, index });
    }
  }
  return results;
}
/** Fold resolved IDs; unfinished and failed calls never change the stack. */
export function foldStack(events: readonly SessionEventLike[]): string[] {
  const stack: string[] = [];
  for (const { name, value } of knowledgeResults(events)) {
    if (name === "kn_enter_node") {
      const current = record(value.current);
      const id = current?.id;
      if (typeof id !== "string" || !id.trim()) continue;
      const at = stack.indexOf(id);
      if (at >= 0) stack.splice(at, 1);
      stack.push(id);
    } else if (name === "kn_back") stack.pop();
  }
  return stack;
}
/** A successful read is a temporary learning target, never a node/session binding. */
export function learningFocusOf(session: unknown): string | null {
  let focus: string | null = null;
  for (const { name, value } of knowledgeResults(eventsOf(session))) {
    if (name !== "kn_read_node" && name !== "kn_enter_node" && name !== "kn_back") continue;
    const node = record(name === "kn_read_node" ? value.node : value.current);
    focus = typeof node?.id === "string" ? node.id : null;
  }
  return focus;
}
/** Only results after the latest request/turn activate detailed learning context. */
export function currentLearningResults(session: unknown): KnowledgeResult[] {
  const events = eventsOf(session);
  let boundary = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type === "turn/start") boundary = index;
    if (event?.type === "user/message") {
      const source = record(record(event.data)?.source);
      if (source?.form === undefined) boundary = index;
    }
  }
  return knowledgeResults(events).filter(result => result.index > boundary);
}
/** Read this session's durable events without borrowing another session's state. */
export function eventsOf(session: unknown): readonly SessionEventLike[] {
  const snapshot = (session as { snapshotEvents?: () => readonly SessionEventLike[] } | undefined)?.snapshotEvents;
  if (typeof snapshot !== "function") return [];
  try { const events = snapshot.call(session); return Array.isArray(events) ? events : []; }
  catch (error) { void error; return []; }
}
export function stackOf(session: unknown): string[] { return foldStack(eventsOf(session)); }
export function currentIdOf(session: unknown): string | null { return stackOf(session).at(-1) ?? null; }
export function stackAfterEnter(session: unknown, id: string): string[] {
  const stack = stackOf(session).filter(item => item !== id); stack.push(id); return stack;
}
export function stackAfterBack(session: unknown): { previous: string | null; stack: string[] } {
  const stack = stackOf(session); return { previous: stack.pop() ?? null, stack };
}
/** No process-global fold cache is retained. */
export function __resetFoldCacheForTest(): void {}
