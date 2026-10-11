/** Bounded model queries are independent of the graph panel's rendering payload. */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { normalizeTitle } from "../vendor/upstream/data/types.ts";
import { resolveNodeArg, search } from "./graph.ts";
import { resolveLibraryRoot, sessionCwdOf } from "./library.ts";
import { readNode, readNodeFast, readNodeRelations, type V3Node } from "./v3/store.ts";
import { readUnderstanding } from "./understanding-file.ts";
import { learningFocusOf, currentIdOf } from "./stack.ts";
import { pageNumber, resolveLearningConfig } from "./learning-config.ts";
import { openFor, type KnowledgeNetConfig } from "./tools.ts";
import { LearningState, modelSessionId } from "./learning-state.ts";
import { structurePage } from "./structure-page.ts";

const output = { schema: { type: "object" }, render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }] };
const fail = (code: string, message: string, extra: object = {}) => ({ ok: false, error: { code, message }, ...extra });
function summary(node: V3Node, understood: boolean) {
  return { id: node.id, title: node.title, path: node.relativePath, status: node.status, understood, aliases: node.aliases, revision: node.rev, health: node.adopted ? "needs_adoption" : "ok" };
}
function failure(error: unknown) {
  const value = error as { code?: string; message?: string };
  return fail(error instanceof TypeError ? "invalid_input" : value?.code ?? "library_unavailable", value?.message ?? String(error));
}
/** Resolve one target; only title/path discovery needs the metadata snapshot. */
async function target(args: Record<string, unknown>, exec: unknown, config: KnowledgeNetConfig, rootOverride?: string) {
  /*
   * `rootOverride`：调用方已经知道"该去哪个库找"时直接用它 ✓（界面聚焦那条路会带来**面板自己的库根** ✓：
   * 面板报上来的库与会话工作区解析出来的库可能字面不同 ✓ —— 见 `LearningState.focusAny` 的注释 ✓）。
   * 不传就是原来的语义：按会话 cwd 解析 ✓。
   */
  const root = rootOverride ?? await resolveLibraryRoot(sessionCwdOf(exec), config.libraryRoot);
  let id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) {
    const context = await openFor(exec, config);
    if (typeof args.title === "string") {
      const title = normalizeTitle(args.title);
      const matches = context.snapshot.nodes.filter(node => normalizeTitle(node.title) === title || node.aliases.some(alias => normalizeTitle(alias) === title));
      if (matches.length > 1) return { error: fail("ambiguous_title", "同名节点不止一个，请选择节点 ID。", { candidates: matches.slice(0, resolveLearningConfig(config).searchLimit).map(node => ({ id: node.id, title: node.title, path: node.relativePath })) }) };
    }
    id = resolveNodeArg(context.snapshot, args as { id?: string; path?: string; title?: string })?.id ?? "";
    if (!id && typeof args.title === "string") id = context.snapshot.nodes.find(node => node.aliases.some(alias => normalizeTitle(alias) === normalizeTitle(String(args.title))))?.id ?? "";
  }
  if (!id) return { error: fail("not_found", "没有找到该节点，请用 kn_find_node 确认目标。") };
  const fast = await readNodeFast(root, id);
  if (fast.ok) return { root, node: fast.node };
  if (fast.code === "node_missing" && fast.unverified) {
    const authoritative = await readNode(root, { id });
    if (authoritative.ok) return { root, node: authoritative.node };
  }
  return { error: fail(fast.code, "无法读取目标知识点，请确认它仍然存在。") };
}
function direction(value: unknown, fallback: string): string {
  const result = value ?? fallback;
  if (result !== "none" && result !== "prerequisites" && result !== "dependents" && result !== "both") throw new TypeError("Invalid relationship direction");
  return String(result);
}
const refProperties = {
  id: { type: "string", description: "目标节点 ID；已知 ID 时优先使用。" },
  path: { type: "string", description: "目标节点相对库根的路径。" },
  title: { type: "string", description: "目标标题或别名；重名时先选择 ID。" },
};

/** Create read-only tools with validated plugin-owned limits. */
export function createModelTools(config: KnowledgeNetConfig, state = new LearningState()): Array<Record<string, unknown>> {
  const limits = resolveLearningConfig(config);
  return [
    {
      name: "kn_list_graph",
      description: "当前对话正在或可能讨论本工作区知识库时，可自主查询结构背景。overview 仅返回标题、别名、理解标记与关系，不含正文；小库一页、大库按需续页。neighborhood 查询一跳关系。结构是解释背景，不是必须全部讲解或读取正文的清单；无关任务不必调用。",
      parameters: { type: "object", properties: {
        mode: { type: "string", enum: ["neighborhood", "overview"], description: "默认 neighborhood；需要了解全库结构背景时选择 overview，不要求用户明确提出总览。" },
        rootId: { type: "string", description: "局部查询目标 ID。" },
        focusId: { type: "string", description: "rootId 的同义参数；仅设一个即可。" },
        direction: { type: "string", enum: ["prerequisites", "dependents", "both"], description: "默认 prerequisites。" },
        offset: { type: "integer", minimum: 0, description: "节点续页偏移，默认 0；局部页始终包含中心节点。" },
        edgeOffset: { type: "integer", minimum: 0, description: "总览的边独立分页偏移，默认 0。" },
        maxNodes: { type: "integer", minimum: 1, description: "本页节点数，不超过插件模型预算。" },
        maxEdges: { type: "integer", minimum: 1, description: "总览本页边数，不超过插件模型预算。" },
        refresh: { type: "boolean", description: "需要确认外部变更时刷新本地图谱。" },
        revision: { type: "string", description: "续页时原样传上一页结构内容指纹 revision；实际内容变更会要求重新查询。" },
      } },
      output,
      async execute(args: Record<string, unknown>, exec: unknown) {
        try {
          const mode = args.mode ?? "neighborhood";
          if (mode !== "neighborhood" && mode !== "overview") throw new TypeError("Invalid graph mode");
          if (typeof args.rootId === "string" && typeof args.focusId === "string" && args.rootId !== args.focusId) throw new TypeError("rootId and focusId must refer to the same node");
          const id = args.rootId ?? args.focusId ?? currentIdOf((exec as { agent?: { session?: unknown } })?.agent?.session) ?? learningFocusOf((exec as { agent?: { session?: unknown } })?.agent?.session);
          if (mode === "neighborhood" && (typeof id !== "string" || !id.trim())) return fail("focus_required", "请指定目标节点；明确要看全库时使用 mode: overview。");
          const offset = pageNumber(args.offset, 0, Number.MAX_SAFE_INTEGER, true);
          const edgeOffset = pageNumber(args.edgeOffset, 0, Number.MAX_SAFE_INTEGER, true);
          const nodeCeiling = mode === "overview" ? limits.structureMaxNodes : limits.modelMaxNodes;
          const edgeCeiling = mode === "overview" ? limits.structureMaxEdges : limits.modelMaxEdges;
          const requestedNodes = pageNumber(args.maxNodes, nodeCeiling, nodeCeiling);
          const requestedEdges = pageNumber(args.maxEdges, edgeCeiling, edgeCeiling);
          if (mode === "neighborhood" && requestedNodes < 2) throw new TypeError("Neighborhood pages require room for a neighbor");
          const dir = direction(args.direction, "prerequisites");
          if (dir === "none") throw new TypeError("Graph direction cannot be none");
          const context = await openFor(exec, config, { refresh: args.refresh === true });
          const snapshot = context.snapshot;
          const marks = await readUnderstanding(context.library.root);
          if (mode === "overview") {
            const library = { name: context.library.manifest.title };
            const nodes = snapshot.nodes.map(node => ({ id: node.id, title: node.title, aliases: node.aliases, understood: marks[node.id] === true, understandingMarked: Object.hasOwn(marks, node.id) })).sort((a, b) => a.id.localeCompare(b.id));
            const edges = snapshot.edges.map(edge => ({ id: edge.id, fromId: edge.fromId, toId: edge.toId, relationType: edge.relationType })).sort((a, b) => a.id.localeCompare(b.id));
            // Scanner generations expire independently of contents; they cannot be paging revisions.
            const revision = createHash("sha256").update(JSON.stringify({ library, nodes, edges })).digest("hex");
            if (args.revision !== undefined && args.revision !== revision) return fail("structure_changed", "图谱结构或理解标记已变更，请从零重新分页读取。");
            return structurePage({ library, revision, nodes, edges, offset, edgeOffset, maxNodes: requestedNodes, maxEdges: requestedEdges, maxChars: limits.structureMaxChars });
          }
          let candidates = snapshot.nodes;
          let edges = snapshot.edges;
          let focus: typeof snapshot.nodes[number] | undefined;
          if (mode === "neighborhood") {
            focus = candidates.find(node => node.id === id);
            if (!focus) return fail("not_found", "没有找到目标节点。");
            edges = edges.filter(edge => (dir !== "dependents" && edge.fromId === id) || (dir !== "prerequisites" && edge.toId === id));
            const ids = new Set(edges.flatMap(edge => [edge.fromId, edge.toId]));
            candidates = candidates.filter(node => node.id !== id && ids.has(node.id));
          }
          const count = Math.min(requestedNodes - 1, limits.relationLimit);
          const neighbors = candidates.slice(offset, offset + Math.max(0, count));
          const selected = focus ? [focus, ...neighbors] : neighbors;
          const kept = new Set(selected.map(node => node.id));
          const relationEdges = mode === "neighborhood" ? edges.filter(edge => kept.has(edge.fromId) && kept.has(edge.toId)) : edges;
          const shownEdges = relationEdges.slice(edgeOffset, edgeOffset + requestedEdges);
          const nodes = selected.map(node => ({ id: node.id, title: node.title, aliases: node.aliases, path: node.relativePath, understood: marks[node.id] === true, understandingMarked: Object.hasOwn(marks, node.id) }));
          const nextOffset = offset + neighbors.length < candidates.length && neighbors.length ? offset + neighbors.length : null;
          const nextEdgeOffset = edgeOffset + shownEdges.length < relationEdges.length ? edgeOffset + shownEdges.length : null;
          return {
            ok: true, mode, focusId: focus?.id ?? null, direction: dir,
            library: { name: context.library.manifest.title }, nodes,
            edges: shownEdges.map(edge => ({ id: edge.id, fromId: edge.fromId, toId: edge.toId, relationType: edge.relationType, relation: edge.relation.slice(0, limits.relationDescriptionChars) })),
            counts: { nodes: candidates.length + (focus ? 1 : 0), edges: edges.length },
            offset, nextOffset, edgeOffset, nextEdgeOffset,
            truncated: neighbors.length < candidates.length || shownEdges.length < edges.length,
            pagingNote: "每页保留中心节点，nextOffset 用于继续读取邻居；只返回本页关系。",
          };
        } catch (error) { return failure(error); }
      },
    },
    {
      name: "kn_find_node",
      description: "按标题/别名查找少量候选，判断当前内容是否涉及本工作区知识库或定位学习对象；不创建或修改内容。无关或已提供充分材料的问题可直接回答。",
      parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, description: "候选上限，受插件 searchLimit 限制。" } }, required: ["query"] },
      output,
      async execute(args: Record<string, unknown>, exec: unknown) {
        try {
          const query = typeof args.query === "string" ? normalizeTitle(args.query) : "";
          if (!query) return fail("invalid_input", "query 不能为空");
          const limit = pageNumber(args.limit, limits.searchLimit, limits.searchLimit);
          const context = await openFor(exec, config);
          const found = search(context.snapshot, query, context.snapshot.nodes.length);
          const similar = found.similar.filter(node => node.id !== found.exact?.id);
          return { ok: true, query, exact: found.exact, similar: similar.slice(0, limit - (found.exact ? 1 : 0)), truncated: similar.length > limit - (found.exact ? 1 : 0) };
        } catch (error) { return failure(error); }
      },
    },
    {
      name: "kn_read_node",
      description: "按需读取一个知识点的正文。优先当前疑问的节点，再读取解释所必需的关联或较远节点；不自动遍历所有前置。默认返回一页正文、理解标记和关系计数；关系通过 relations 查询，长文使用 nextOffset。先回答当前疑问，不自动规划路线或建点。",
      parameters: { type: "object", properties: {
        ...refProperties,
        role: { type: "string", enum: ["target", "background"], description: "默认 target。为解释当前节点而补读基础或其他节点时使用 background，避免把补充材料替换为历史学习目标。" },
        offset: { type: "integer", minimum: 0, description: "正文字符偏移，默认 0；续读使用 nextOffset。" },
        noteMaxChars: { type: "integer", minimum: 1, description: "本页正文字符数，默认插件 noteMaxChars，受 maxNoteChars 限制。" },
        relations: { type: "string", enum: ["none", "prerequisites", "dependents", "both"], description: "默认 none；本次需要关系时才选择方向。" },
        relationOffset: { type: "integer", minimum: 0 },
        relationLimit: { type: "integer", minimum: 1, description: "关系条数，受插件 relationLimit 限制。" },
      } },
      output,
      async execute(args: Record<string, unknown>, exec: unknown) {
        try {
          const role = args.role ?? "target";
          if (role !== "target" && role !== "background") throw new TypeError("Invalid note role");
          const offset = pageNumber(args.offset, 0, Number.MAX_SAFE_INTEGER, true);
          const maxChars = pageNumber(args.noteMaxChars, limits.noteMaxChars, limits.maxNoteChars);
          const relationOffset = pageNumber(args.relationOffset, 0, Number.MAX_SAFE_INTEGER, true);
          const relationLimit = pageNumber(args.relationLimit, limits.relationLimit, limits.relationLimit);
          const dir = direction(args.relations, "none");
          const located = await target(args, exec, config);
          if (located.error) return located.error;
          const { root, node } = located;
          const graph = await readNodeRelations(root!, node!.id);
          const marks = await readUnderstanding(root!);
          const full = node!.note ?? "";
          if (offset > full.length) return fail("invalid_input", "正文偏移超出长度。");
          const prerequisites: object[] = [], dependents: object[] = [];
          const candidates = dir === "none" ? [] : [
            ...(dir !== "dependents" ? graph.prerequisites.map(edge => ({ edge, direction: "prerequisites", id: edge.toId })) : []),
            ...(dir !== "prerequisites" ? graph.dependents.map(edge => ({ edge, direction: "dependents", id: edge.fromId })) : []),
          ];
          const relations: object[] = [];
          for (const item of candidates.slice(relationOffset, relationOffset + relationLimit)) {
            const related = await readNodeFast(root!, item.id);
            const info = related.ok ? { id: related.node.id, title: related.node.title, path: related.node.relativePath, understood: marks[item.id] === true } : { id: item.id, dangling: true };
            (item.direction === "prerequisites" ? prerequisites : dependents).push(info);
            relations.push({ id: item.edge.id, fromId: item.edge.fromId, toNodeId: item.edge.toId, direction: item.direction, toTitle: related.ok ? related.node.title : "", relationType: item.edge.type, description: (item.edge.description ?? "").slice(0, limits.relationDescriptionChars) });
          }
          const end = Math.min(full.length, offset + maxChars);
          return {
            ok: true, role, node: { ...summary(node!, marks[node!.id] === true), understandingMarked: Object.hasOwn(marks, node!.id), primaryDocument: node!.relativePath, createdAt: node!.createdAt, updatedAt: node!.updatedAt },
            note: { path: node!.relativePath, text: full.slice(offset, end), truncated: offset > 0 || end < full.length, byteLength: Buffer.byteLength(full, "utf8"), totalChars: full.length, offset, nextOffset: end < full.length ? end : null, maxChars },
            relationCounts: { prerequisites: graph.prerequisites.length, dependents: graph.dependents.length },
            prerequisites, dependents, relations, resources: [],
            relationPage: { direction: dir, offset: relationOffset, total: candidates.length, nextOffset: relationOffset + relations.length < candidates.length ? relationOffset + relations.length : null },
          };
        } catch (error) { return failure(error); }
      },
    },
    {
      name: "kn_current_node",
      description: "查询当前学习对象的身份与理解标记，不返回正文。auto 优先活动界面中打开的笔记/实际选择，再取新对话入口线索，最后取历史目标。追问刚才的节点时用 source: history；用户明确指定的主题始终优先，不把聚焦当成永久会话主题。",
      parameters: { type: "object", properties: { source: { type: "string", enum: ["auto", "ui", "entry", "history"], description: "默认 auto；history 用于刚才的目标，ui 用于界面当前选中的节点。" } } }, output,
      async execute(args: Record<string, unknown>, exec: unknown) {
        try {
          const session = (exec as { agent?: { session?: unknown } })?.agent?.session;
          const requested = args.source ?? "auto";
          if (!["auto", "ui", "entry", "history"].includes(String(requested))) throw new TypeError("Invalid focus source");
          const root = await resolveLibraryRoot(sessionCwdOf(exec), config.libraryRoot);
          const sessionId = modelSessionId(exec);
          /*
           * **界面聚焦优先**（用户实测 2026-10-11：面板里开着笔记，这里却报"没有当前节点" ✗）：
           * 先按 (会话, 会话库) 精确查 ✓；查不到再取**这个会话最近活跃的视图** ✓
           * （面板报的库可能与会话库字面不同 ✓，见 `LearningState.focusAny` ✓），
           * 并用**那个视图自己的库根**去找节点 ✓（否则会去错误的库里找 ⇒ not_found ⇒ 又被当成"没有焦点" ✗）。
           */
          const exact = sessionId ? state.focus(sessionId, root) : undefined;
          const ui = exact ?? (sessionId ? state.focusAny(sessionId) : undefined);
          const uiRoot = exact ? root : ui?.root;
          const entry = sessionId ? state.entry(sessionId, root, session) : undefined;
          const history = learningFocusOf(session) ?? currentIdOf(session);
          const candidates = [
            { id: ui?.nodeId, source: "ui", detail: ui?.source, root: uiRoot },
            { id: entry, source: "entry", detail: "node_conversation", root: undefined },
            { id: history, source: "history", detail: "learning_result", root: undefined },
          ].filter(candidate => candidate.id && (requested === "auto" || candidate.source === requested));
          for (const candidate of candidates) {
            const located = await target({ id: candidate.id }, exec, config, candidate.root);
            if (located.error) {
              if (located.error.error.code === "not_found" || located.error.error.code === "node_missing") continue;
              return located.error;
            }
            const marks = await readUnderstanding(located.root!);
            return { ok: true, node: { ...summary(located.node!, marks[located.node!.id] === true), understandingMarked: Object.hasOwn(marks, located.node!.id) }, source: candidate.source, focusKind: candidate.detail };
          }
          return { ok: true, node: null, source: null, reason: "no_reliable_focus" };
        } catch (error) { return failure(error); }
      },
    },
  ];
}
