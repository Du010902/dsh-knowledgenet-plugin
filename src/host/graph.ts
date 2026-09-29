/**
 * 图查询：把 v2 扫描结果整理成工具返回的形状。
 *
 * 这里**不重写**任何领域算法：前置/后继、搜索、环检测都直接调用上游 `engine.ts`
 * 与 `scanner.ts`，避免出现第三套实现（那是方案里明确要避免的漂移源）。
 */
import type { GraphSnapshot, KnowledgeNode } from "../vendor/upstream/data/types.ts";
import {
  dependentsOf,
  findExactMatch,
  findSimilar,
  prerequisitesOf,
  searchNodes,
} from "../vendor/upstream/data/engine.ts";
import { normalizeRel } from "../vendor/upstream/data/v2/paths.ts";
import { normalizeTitle } from "../vendor/upstream/data/types.ts";

/** 工具返回里的一条节点（只带界面与模型真正需要的字段） */
export interface NodeSummary {
  id: string;
  title: string;
  path: string;
  status: string;
  aliases: string[];
  health: string;
  revision: number;
}

export function summarizeNode(node: KnowledgeNode): NodeSummary {
  return {
    id: node.id,
    title: node.title,
    path: node.relativePath,
    status: node.status,
    aliases: node.aliases,
    health: node.health,
    revision: node.revision,
  };
}

export interface EdgeSummary {
  id: string;
  fromId: string;
  toId: string;
  relationType: string;
  relation: string;
  dangling: boolean;
}

export function summarizeEdge(edge: {
  id: string;
  fromId: string;
  toId: string;
  relationType: string;
  relation: string;
  dangling?: boolean;
}): EdgeSummary {
  return {
    id: edge.id,
    fromId: edge.fromId,
    toId: edge.toId,
    relationType: edge.relationType,
    relation: edge.relation,
    dangling: edge.dangling === true,
  };
}

/** 用 id → 相对路径 → 文件夹名 → 标题 的顺序解析一个节点参数 */
export function resolveNodeArg(
  snapshot: GraphSnapshot,
  args: { id?: string; path?: string; title?: string },
): KnowledgeNode | undefined {
  const byId = typeof args.id === "string" && args.id.trim() !== ""
    ? snapshot.nodes.find((node) => node.id === args.id!.trim())
    : undefined;
  if (byId !== undefined) return byId;

  const wanted = typeof args.path === "string" && args.path.trim() !== ""
    ? normalizeRel(args.path)
    : "";
  if (wanted !== "") {
    const exact = snapshot.nodes.find((node) => normalizeRel(node.relativePath) === wanted);
    if (exact !== undefined) return exact;
    const byFolder = snapshot.nodes.filter((node) => normalizeRel(node.folderName) === wanted);
    if (byFolder.length === 1) return byFolder[0];
  }

  const title = typeof args.title === "string" ? normalizeTitle(args.title) : "";
  if (title !== "") return findExactMatch(snapshot, title);
  return undefined;
}

/** 搜索：命中完全相同 → 直接给结论；否则给相似候选 */
export function search(
  snapshot: GraphSnapshot,
  query: string,
  limit = 8,
): { exact: NodeSummary | null; similar: NodeSummary[] } {
  const exact = findExactMatch(snapshot, query);
  const similar = findSimilar(snapshot, query, limit).map(summarizeNode);
  const fallback = searchNodes(snapshot, query, limit).map(summarizeNode);
  const seen = new Set(similar.map((node) => node.id));
  for (const node of fallback) {
    if (!seen.has(node.id)) {
      similar.push(node);
      seen.add(node.id);
    }
  }
  return { exact: exact === undefined ? null : summarizeNode(exact), similar };
}

/** 一个节点的一跳邻域：前置 + 后继 + 它们之间的边（供二维聚焦卡片使用） */
export function neighborhood(
  snapshot: GraphSnapshot,
  nodeId: string,
): { nodes: NodeSummary[]; edges: EdgeSummary[] } {
  const center = snapshot.nodes.find((node) => node.id === nodeId);
  const prerequisites = prerequisitesOf(snapshot, nodeId);
  const dependents = dependentsOf(snapshot, nodeId);
  const nodes: KnowledgeNode[] = [];
  const seen = new Set<string>();
  for (const node of [center, ...prerequisites, ...dependents]) {
    if (node === undefined || seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push(node);
  }
  const related = new Set(nodes.map((node) => node.id));
  const edges = snapshot.edges
    .filter((edge) => related.has(edge.fromId) && related.has(edge.toId))
    .map(summarizeEdge);
  return { nodes: nodes.map(summarizeNode), edges };
}
