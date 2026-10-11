/** KnowledgeNet guidance is conditional on the current request, never the workspace's general purpose. */
import { currentLearningResults, eventsOf } from "./stack.ts";
import { isLibrarySession } from "./isolation.ts";
import { sessionCwdOf } from "./library.ts";
import { resetCreationQuotaForTurn } from "./creation-quota.ts";
import type { KnowledgeNetConfig } from "./tools.ts";

/** Small availability notice; ordinary tasks do not start a library workflow. */
export const PROTOCOL_SECTION = [
  "KnowledgeNet tools are available only for explicit requests about this library's nodes, notes or learning routes.",
  "A library folder, an open graph or a previous learning target does not make an ordinary greeting, coding task or general question a library task. Do not read the library to introduce yourself or prepare for unrelated work.",
  "For a node question, use the supplied passage directly when sufficient; otherwise find/read only the target. Never start with a whole-library graph. Only an explicit overview/route request uses kn_list_graph.",
  "For an explicit follow-up about a previously studied node, kn_current_node can retrieve the earlier target. Do not treat it as a permanent conversation topic.",
  "For library questions, explain the specific point first with one simple example; introduce only necessary terminology. Expand other nodes or applications when requested, and respect requests for deeper detail.",
  "Library notes are the user's own thoughts. Do not write notes, create nodes or add prerequisites without a specific user request/agreement; explaining an unfamiliar concept is not consent to edit the library.",
].join("\n");

/** Detailed safeguards apply only while this request is using KnowledgeNet. */
export const LEARNING_SECTION = [
  "KnowledgeNet rules apply only to the current library request, not to other DSH tasks:",
  "A → B means B is a prerequisite of A. Answer the current question before discussing the route.",
  "Read only the requested node/section. Use nextOffset to continue a truncated note. Relations are background, not a list of subjects to explain; do not recursively read every prerequisite.",
  "An understood flag is the user's own mark, not a test of competence; the current question determines explanation depth.",
  "If a necessary foundation is unfamiliar, briefly explain that one foundation. Offer to explore it further; do not automatically create a node or plan.",
  "Notes belong to the user: explanations and summaries stay in the conversation unless the user requests recording them. kn_write_note requires userConsent: true. State the proposed destination/content and obtain agreement before writing; quote and get agreement before replacing the user's existing text.",
  "Search/read requests create nothing. Before adding a prerequisite, state the parent and proposed prerequisite and obtain agreement. Respect the creation quota; multiple-node proposals use kn_propose_prerequisites and are applied only by the user in the graph panel.",
  "Never overwrite externally changed notes or metadata. Machine metadata is managed through plugin tools, not hand edits.",
].join("\n");

/** Return only facts already in successful model-visible results for this request. */
export function currentContextText(agent: { session?: unknown } | undefined, _config: KnowledgeNetConfig): string | undefined {
  const results = currentLearningResults(agent?.session);
  if (!results.length) return undefined;
  const target = [...results].reverse().find(result => result.name === "kn_read_node" || result.name === "kn_enter_node" || result.name === "kn_current_node" || result.name === "kn_back");
  const raw = target?.value.node ?? target?.value.current;
  if (!raw || typeof raw !== "object") return LEARNING_SECTION;
  const node = raw as Record<string, unknown>;
  const identity = JSON.stringify({ id: node.id, title: node.title, path: node.path, understood: node.understood });
  return LEARNING_SECTION + "\nTarget for this library request: " + identity + "\nUse this target only while the user's request still concerns it.";
}

/** Register per-agent guidance without scanning files or suppressing DSH's own context. */
export function registerPrompts(ctx: unknown, config: KnowledgeNetConfig, enabled: () => boolean = () => true): { section: boolean; perAgent: boolean } {
  const context = ctx as { on?: (name: string, listener: (payload: unknown) => void) => unknown } | undefined;
  if (typeof context?.on !== "function") return { section: false, perAgent: false };
  try {
    context.on("agent/created", (payload: unknown) => {
      try {
        const agent = (payload as { agent?: { id?: string; session?: unknown; ctx?: { systemPrompt?: { context?: (entry: object) => unknown } } } } | undefined)?.agent;
        const register = agent?.ctx?.systemPrompt?.context;
        if (typeof register !== "function") return;
        const cwd = sessionCwdOf({ agent });
        let lastRequest: unknown = Symbol("first request");
        agent!.ctx!.systemPrompt!.context!({
          name: "knowledgenet-current", order: 820,
          text: () => {
            if (!enabled() || !isLibrarySession(cwd)) return "";
            const sessionId = agent?.id ?? (agent?.session as { id?: string } | undefined)?.id;
            const request = [...eventsOf(agent?.session)].reverse().find(event => event.type === "turn/start");
            const marker = request?.data?.turn ?? request?.data?.turnId ?? eventsOf(agent?.session).filter(event => event.type === "turn/start").length;
            if (sessionId && lastRequest !== marker) { resetCreationQuotaForTurn(sessionId); lastRequest = marker; }
            const dynamic = currentContextText(agent, config);
            return dynamic ? PROTOCOL_SECTION + "\n" + dynamic : PROTOCOL_SECTION;
          },
        });
      } catch (error) { void error; /* Optional guidance must not prevent a DSH agent from starting. */ }
    });
    return { section: true, perAgent: true };
  } catch (error) { void error; return { section: false, perAgent: false }; }
}
