/** Bounded model queries are independent of the graph panel's rendering payload. */
import { Buffer } from "node:buffer";
import { normalizeTitle } from "../vendor/upstream/data/types.ts";
import { resolveNodeArg, search } from "./graph.ts";
import { resolveLibraryRoot, sessionCwdOf } from "./library.ts";
import { readNode, readNodeFast, readNodeRelations, type V3Node } from "./v3/store.ts";
import { readUnderstanding } from "./understanding-file.ts";
import { learningFocusOf, currentIdOf } from "./stack.ts";
import { pageNumber, resolveLearningConfig } from "./learning-config.ts";
import { openFor, type KnowledgeNetConfig } from "./tools.ts";

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
async function target(args: Record<string, unknown>, exec: unknown, config: KnowledgeNetConfig) {
  const root = await resolveLibraryRoot(sessionCwdOf(exec), config.libraryRoot);
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
export function createModelTools(config: KnowledgeNetConfig): Array<Record<string, unknown>> {
  const limits = resolveLearningConfig(config);
  return [
    {
      name: "kn_list_graph",
      description: "仅用于用户明确要求的知识库关系、路线或全库总览；普通问候、编程、解释一个节点不先调用它。neighborhood 真实返回目标的一跳关系，默认只取前置；overview 必须显式指定并分页。图谱界面另行加载完整图，不依赖本工具结果。",
      parameters: { type: "object", properties: {
        mode: { type: "string", enum: ["neighborhood", "overview"], description: "默认 neighborhood；用户明确要求全库总览时才指定 overview。" },
        rootId: { type: "string", description: "局部查询目标 ID。" },
        focusId: { type: "string", description: "rootId 的同义参数；仅设一个即可。" },
        direction: { type: "string", enum: ["prerequisites", "dependents", "both"], description: "默认 prerequisites。" },
        offset: { type: "integer", minimum: 0, description: "节点续页偏移，默认 0；局部页始终包含中心节点。" },
        edgeOffset: { type: "integer", minimum: 0, description: "总览的边独立分页偏移，默认 0。" },
        maxNodes: { type: "integer", minimum: 1, description: "本页节点数，不超过插件模型预算。" },
        maxEdges: { type: "integer", minimum: 1, description: "总览本页边数，不超过插件模型预算。" },
        refresh: { type: "boolean", description: "需要确认外部变更时刷新本地图谱。" },
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
          const requestedNodes = pageNumber(args.maxNodes, limits.modelMaxNodes, limits.modelMaxNodes);
          const requestedEdges = pageNumber(args.maxEdges, limits.modelMaxEdges, limits.modelMaxEdges);
          if (mode === "neighborhood" && requestedNodes < 2) throw new TypeError("Neighborhood pages require room for a neighbor");
          const dir = direction(args.direction, "prerequisites");
          if (dir === "none") throw new TypeError("Graph direction cannot be none");
          const context = await openFor(exec, config, { refresh: args.refresh === true });
          const snapshot = context.snapshot;
          const marks = await readUnderstanding(context.library.root);
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
          const count = mode === "neighborhood" ? Math.min(requestedNodes - 1, limits.relationLimit) : requestedNodes;
          const neighbors = candidates.slice(offset, offset + Math.max(0, count));
          const selected = focus ? [focus, ...neighbors] : neighbors;
          const kept = new Set(selected.map(node => node.id));
          const relationEdges = mode === "neighborhood" ? edges.filter(edge => kept.has(edge.fromId) && kept.has(edge.toId)) : edges;
          const shownEdges = relationEdges.slice(edgeOffset, edgeOffset + requestedEdges);
          const nodes = selected.map(node => ({ id: node.id, title: node.title, path: node.relativePath, understood: marks[node.id] === true }));
          const nextOffset = offset + neighbors.length < candidates.length && neighbors.length ? offset + neighbors.length : null;
          const nextEdgeOffset = edgeOffset + shownEdges.length < relationEdges.length ? edgeOffset + shownEdges.length : null;
          return {
            ok: true, mode, focusId: focus?.id ?? null, direction: mode === "neighborhood" ? dir : undefined,
            library: { name: context.library.manifest.title }, nodes,
            edges: shownEdges.map(edge => ({ id: edge.id, fromId: edge.fromId, toId: edge.toId, relationType: edge.relationType, relation: edge.relation.slice(0, limits.relationDescriptionChars) })),
            counts: { nodes: candidates.length + (focus ? 1 : 0), edges: edges.length },
            offset, nextOffset, edgeOffset, nextEdgeOffset,
            truncated: neighbors.length < candidates.length || shownEdges.length < edges.length,
            pagingNote: mode === "overview" ? "节点和边独立分页；边端点可能不在本节点页中，可按 ID 读取。" : "每页保留中心节点，nextOffset 用于继续读取邻居；只返回本页关系。",
          };
        } catch (error) { return failure(error); }
      },
    },
    {
      name: "kn_find_node",
      description: "只在用户要求操作库内节点且尚无 ID 时按标题/别名找少量候选；不先取全库图谱，不创建或修改任何内容。明确提供的普通概念问题可以直接解释，无需查库。",
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
      description: "按需读取用户正在问的一个知识点，不遍历其他节点正文。默认只返回目标正文的一页、理解标记和关系计数；不展开前置/后继。用户要求关系时显式选择 relations；长文按 nextOffset 续读。先解释本次疑问，不自动规划路线或建点。",
      parameters: { type: "object", properties: {
        ...refProperties,
        offset: { type: "integer", minimum: 0, description: "正文字符偏移，默认 0；续读使用 nextOffset。" },
        noteMaxChars: { type: "integer", minimum: 1, description: "本页正文字符数，默认插件 noteMaxChars，受 maxNoteChars 限制。" },
        relations: { type: "string", enum: ["none", "prerequisites", "dependents", "both"], description: "默认 none；本次需要关系时才选择方向。" },
        relationOffset: { type: "integer", minimum: 0 },
        relationLimit: { type: "integer", minimum: 1, description: "关系条数，受插件 relationLimit 限制。" },
      } },
      output,
      async execute(args: Record<string, unknown>, exec: unknown) {
        try {
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
            ok: true, node: { ...summary(node!, marks[node!.id] === true), primaryDocument: node!.relativePath, createdAt: node!.createdAt, updatedAt: node!.updatedAt },
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
      description: "仅当用户明确追问此前学习的知识库节点、且本次没有给出目标时，读取此前目标的身份与理解标记；不读笔记正文。不把此目标当成普通任务的主题。",
      parameters: { type: "object", properties: {} }, output,
      async execute(_args: Record<string, unknown>, exec: unknown) {
        try {
          const session = (exec as { agent?: { session?: unknown } })?.agent?.session;
          const id = learningFocusOf(session) ?? currentIdOf(session);
          if (!id) return fail("no_learning_target", "此前没有明确学习目标，请用户说明目标节点。");
          const located = await target({ id }, exec, config);
          if (located.error) return located.error;
          const marks = await readUnderstanding(located.root!);
          return { ok: true, node: summary(located.node!, marks[located.node!.id] === true) };
        } catch (error) { return failure(error); }
      },
    },
  ];
}
