/** KnowledgeNet guidance is conditional on the current request, never the workspace's general purpose. */
import { currentLearningResults, eventsOf } from "./stack.ts";
import { isLibrarySession, findLibraryRootSync } from "./isolation.ts";
import { LearningState } from "./learning-state.ts";
import { sessionCwdOf } from "./library.ts";
import { resetCreationQuotaForTurn } from "./creation-quota.ts";
import type { KnowledgeNetConfig } from "./tools.ts";

/** Small availability notice; ordinary tasks do not start a library workflow. */
export const PROTOCOL_SECTION = [
  "Decide from the current conversation whether it is discussing, or may be discussing, this workspace's KnowledgeNet nodes, notes or learning routes. No special keyword or user-selected learning mode is required. You may use read-only tools to check relevance; unrelated work does not require a library lookup.",
  "A library folder, an open graph or a previous learning target does not permanently make ordinary greetings, coding or general questions library tasks. Do not read all notes to introduce yourself or prepare for unrelated work.",
  "For a relevant learning question, kn_list_graph mode: overview gives metadata-only structure: titles, aliases, relationships and understanding marks, never note bodies. A small library may fit one page; for larger libraries continue or search as needed, never claim a partial page is the entire map.",
  "When the user refers to the current node without naming it, query kn_current_node; do not ask them to operate a node picker. source: history resolves a follow-up about the previously studied node. The user's explicit topic takes precedence over UI focus and entry hints.",
  "If kn_current_node has no reliable target, the current node is unknown. Never substitute a library root, goal, understanding mark or first overview item and claim it is the user's current node. Ask which concept they mean if their message does not identify it. A history result is a previous learning target, not evidence of a currently open note; for the node visible now use source: ui.",
  "For library questions, explain the specific point first with one simple example; introduce only necessary terminology. Expand other nodes or applications when requested, and respect requests for deeper detail.",
  "Library notes are the user's own thoughts. Do not write notes, create nodes or add prerequisites without a specific user request/agreement; explaining an unfamiliar concept is not consent to edit the library.",
].join("\n");

/** Detailed safeguards apply only while this request is using KnowledgeNet. */
export const LEARNING_SECTION = [
  "KnowledgeNet rules apply only to the current library request, not to other DSH tasks:",
  "A → B means B is a prerequisite of A. Answer the current question before discussing the route.",
  "Use the structure as background, not a list of subjects to explain. Read the question's target/section first, then the related or more distant nodes needed to answer it using kn_read_node role: background so supporting material does not replace the learning target. There is no fixed hop limit; do not recursively read every prerequisite. Use nextOffset for truncated notes.",
  "An understood flag is the user's own mark, not a test of competence; the current question determines explanation depth. understandingMarked: false means no self-mark was recorded, not evidence that the user knows nothing.",
  "Prefer understood concepts as explanatory foundations, but do not assume marked concepts need no explanation. Avoid explaining an unfamiliar concept with more unexplained unfamiliar terms. Briefly explain a necessary unfamiliar foundation in intuitive language, then return to the current question; do not automatically create a node or plan.",
  "Notes belong to the user: explanations and summaries stay in the conversation unless the user requests recording them. kn_write_note requires userConsent: true. State the proposed destination/content and obtain agreement before writing; quote and get agreement before replacing the user's existing text.",
  "Search/read requests create nothing. Before adding a prerequisite, state the parent and proposed prerequisite and obtain agreement. Respect the creation quota; multiple-node proposals use kn_propose_prerequisites and are applied only by the user in the graph panel.",
  "Never overwrite externally changed notes or metadata. Machine metadata is managed through plugin tools, not hand edits.",
].join("\n");

/** Return only facts already in successful model-visible results for this request. */
export function currentContextText(agent: { session?: unknown } | undefined, _config: KnowledgeNetConfig): string | undefined {
  const results = currentLearningResults(agent?.session);
  if (!results.length) return undefined;
  const target = [...results].reverse().find(result => (result.name === "kn_read_node" && result.value.role !== "background") || result.name === "kn_enter_node" || result.name === "kn_current_node" || result.name === "kn_back");
  const raw = target?.value.node ?? target?.value.current;
  if (!raw || typeof raw !== "object") return LEARNING_SECTION;
  const node = raw as Record<string, unknown>;
  const identity = JSON.stringify({ id: node.id, title: node.title, path: node.path, understood: node.understood });
  return LEARNING_SECTION + "\nTarget for this library request: " + identity + "\nUse this target only while the user's request still concerns it.";
}

/** Register per-agent guidance without scanning files or suppressing DSH's own context. */
export function registerPrompts(ctx: unknown, config: KnowledgeNetConfig, enabled: () => boolean = () => true, state = new LearningState()): { section: boolean; perAgent: boolean } {
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
            const root = config.libraryRoot || findLibraryRootSync(cwd ?? "");
            const entry = sessionId && root ? state.entry(sessionId, root, agent?.session) : undefined;
            const hint = entry ? "\nThis conversation was just opened from a KnowledgeNet node (first request only): " + JSON.stringify({ id: entry }) + ". Query kn_current_node and metadata-only kn_list_graph to prepare relevant learning context; do not preload all notes. Follow the user's explicit request if it concerns another subject." : "";
            return (dynamic ? PROTOCOL_SECTION + "\n" + dynamic : PROTOCOL_SECTION) + hint;
          },
        });
      } catch (error) { void error; /* Optional guidance must not prevent a DSH agent from starting. */ }
    });
    return { section: true, perAgent: true };
  } catch (error) { void error; return { section: false, perAgent: false }; }
}
