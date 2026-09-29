/**
 * 图的载荷（payload）：`kn_list_graph` 工具与 `/api/knowledgenet.graph` 路由**共用同一份**
 * 构造逻辑。这样「模型看到的 JSON」「图谱卡片画的图」「面板画的图」三者永远同形同源，
 * 不会出现两套字段慢慢漂移的情况。
 */
import type { GraphSnapshot } from "../vendor/upstream/data/types.ts";
import { summarizeEdge, summarizeNode, type EdgeSummary, type NodeSummary } from "./graph.ts";
import type { LibraryContext } from "./library.ts";

export const DEFAULT_MAX_NODES = 400;

/**
 * 边数上限：节点被裁到 400 时，边仍可能成倍于节点（枢纽节点尤其明显）。
 * 超出部分直接截断——图上画不下，模型也不需要。
 */
export const MAX_EDGES = 4000;
/** 单条关系的说明最多这么多字符（说明是"为什么依赖"，不该长到把载荷撑爆） */
export const MAX_EDGE_DESCRIPTION = 240;
/**
 * 载荷字节预算（序列化后）。
 *
 * 为什么放在这里：`maxNodes` 只限制**节点数**，节点很多或说明很长时载荷仍可能到几 MB，
 * 面板首载与模型上下文都要为它付费（审查指出）。超预算就从尾部丢节点重算，直到进预算。
 */
export const MAX_PAYLOAD_BYTES = 1_800_000;

export interface GraphPayload {
  library: { root: string; name: string; formatVersion: number };
  focusId: string | null;
  goals: Array<{ id: string; title: string; rootNodeId: string }>;
  nodes: NodeSummary[];
  edges: EdgeSummary[];
  counts: { nodes: number; edges: number; issues: number };
  issues: Array<{ code: string; relativePath: string; detail: string }>;
  truncated: boolean;
  revision: number;
}

export function clampMaxNodes(value: number | null | undefined): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : DEFAULT_MAX_NODES;
  return Math.min(Math.max(raw, 10), 2000);
}

/** 说明超长就截断（加省略号），避免单条说明把载荷撑大 */
function clipDescription(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length <= MAX_EDGE_DESCRIPTION) return value;
  return `${value.slice(0, MAX_EDGE_DESCRIPTION)}…`;
}

/** 按上限裁剪节点，并只保留两端都留下的边 */
export function clipGraph(
  snapshot: GraphSnapshot,
  maxNodes: number,
): { truncated: boolean; nodes: NodeSummary[]; edges: EdgeSummary[] } {
  const nodes = snapshot.nodes.slice(0, maxNodes).map(summarizeNode);
  const kept = new Set(nodes.map((node) => node.id));
  const allEdges = snapshot.edges
    .filter((edge) => kept.has(edge.fromId) && kept.has(edge.toId))
    .map((edge) => {
      const summary = summarizeEdge(edge) as EdgeSummary & { description?: string };
      if (typeof summary.description === "string") {
        summary.description = clipDescription(summary.description) ?? "";
      }
      return summary;
    });
  const edges = allEdges.slice(0, MAX_EDGES);
  return {
    truncated: snapshot.nodes.length > nodes.length || allEdges.length > edges.length,
    nodes,
    edges,
  };
}

/** 聚焦谁：显式 rootId 优先，否则第一个学习目标；都没有就不聚焦（二维视图会退化成平铺） */
export function focusOf(snapshot: GraphSnapshot, rootId?: string | null): string | null {
  if (typeof rootId === "string" && rootId.trim() !== "") {
    const found = snapshot.nodes.find((node) => node.id === rootId.trim());
    if (found !== undefined) return found.id;
    return null;
  }
  const goal = snapshot.goals[0];
  return goal === undefined ? null : goal.rootNodeId;
}

export function graphPayload(
  context: LibraryContext,
  options: { rootId?: string | null; maxNodes?: number | null; focusId?: string | null } = {},
): GraphPayload {
  const snapshot = context.snapshot;
  const clipped = clipGraph(snapshot, clampMaxNodes(options.maxNodes));
  const payload: GraphPayload = {
    library: {
      root: context.library.root,
      name: context.library.manifest.title,
      formatVersion: context.library.manifest.formatVersion,
    },
    focusId: options.focusId ?? focusOf(snapshot, options.rootId),
    goals: snapshot.goals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      rootNodeId: goal.rootNodeId,
    })),
    nodes: clipped.nodes,
    edges: clipped.edges,
    counts: {
      nodes: snapshot.nodes.length,
      edges: snapshot.edges.length,
      issues: context.library.report.issues.length,
    },
    issues: context.library.report.issues.slice(0, 5).map((issue) => ({
      code: issue.code,
      relativePath: issue.relativePath,
      detail: issue.detail,
    })),
    truncated: clipped.truncated,
    revision: snapshot.revision,
  };

  /*
   * 字节预算兜底：节点/边都裁过之后，若序列化仍超预算（说明很长、标题很长等），
   * 就从尾部丢节点（并丢掉因此悬空的边）重算，直到进预算。
   * 目的：面板首载与模型上下文都不该被一个巨型载荷拖住。
   */
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
    let nodes = payload.nodes;
    let edges = payload.edges;
    while (nodes.length > 10 && JSON.stringify({ ...payload, nodes, edges }).length > MAX_PAYLOAD_BYTES) {
      nodes = nodes.slice(0, Math.max(10, Math.floor(nodes.length * 0.8)));
      const kept = new Set(nodes.map((node) => node.id));
      edges = edges.filter((edge) => kept.has(edge.fromId) && kept.has(edge.toId));
    }
    payload.nodes = nodes;
    payload.edges = edges;
    payload.truncated = true;
  }
  return payload;
}
