/**
 * 领域数据 → 三维视图数据
 *
 * 这里是唯一把 `GraphSnapshot` 变成布局/渲染输入的地方：
 * - 节点按**稳定 ID 排序**，坐标数组与这个顺序一一对应（防止坐标错配到别的知识点）；
 * - 布局只用无向结构，显示层保留有向边：箭头永远由 `fromId → toId` 决定；
 * - 标题、状态、别名等只作为显示数据带过去，不参与布局计算。
 *
 * 不写回知识图：节点坐标只存在于这一层，节点本身没有 x/y 字段。
 */
import type { GraphSnapshot, LearnStatus } from "@/data/types";
import { stableIds, topologySignature, undirectedPairs } from "./topology.ts";

export interface SpaceEdge {
  id: string;
  /** 起点索引：它依赖 to */
  from: number;
  /** 终点索引：前置知识，箭头指向它 */
  to: number;
}

export interface SpaceGraph {
  /** 稳定 ID 顺序 */
  ids: string[];
  indexById: Map<string, number>;
  titles: string[];
  statuses: LearnStatus[];
  /** 有向边（显示与「依赖/被依赖」查询都用它） */
  edges: SpaceEdge[];
  /** 关系 ID → `edges` 下标：选中 / 悬停按 ID 记，渲染按下标取 */
  edgeIndexById: Map<string, number>;
  /** 无向化之后的边（布局用），与 `SpaceGraph.edges` 顺序无关 */
  layoutPairs: Array<[number, number]>;
  /** 每个节点的有向出度（它依赖多少个前置）：画箭头与估节点大小用 */
  prerequisites: Int32Array;
  /** 每个节点的有向入度（有多少知识点依赖它） */
  dependents: Int32Array;
  /** 相邻节点集合（无向、去重、升序）：选中高亮与标签优先级用 */
  neighbors: number[][];
  /** 节点半径（世界单位）：枢纽略大，但靠真实透视而不是重排节点来造深度 */
  radius: Float32Array;
  /** 结构签名：只含节点 ID 与边端点 */
  signature: string;
}

/**
 * 把工作区复制成三维视图数据。
 *
 * 复制是必须的：d3 会直接改写传给它的节点对象（坐标、速度、index），
 * 把 Store 里的对象交出去等于让布局引擎改写业务数据。
 */
export function buildSpaceGraph(
  ws: GraphSnapshot,
  rootId: string | null,
  baseRadius: number,
): SpaceGraph {
  const ids = stableIds(ws.nodes.map((n) => n.id));
  const indexById = new Map<string, number>();
  ids.forEach((id, i) => indexById.set(id, i));

  const byId = new Map(ws.nodes.map((n) => [n.id, n]));
  const titles = ids.map((id) => byId.get(id)?.title ?? id);
  const statuses = ids.map<LearnStatus>((id) => byId.get(id)?.status ?? "todo");

  const edges: SpaceEdge[] = [];
  const directedPairs: Array<[number, number]> = [];
  const edgeIndexById = new Map<string, number>();
  for (const edge of ws.edges) {
    const from = indexById.get(edge.fromId);
    const to = indexById.get(edge.toId);
    if (from === undefined || to === undefined || from === to) continue;
    edgeIndexById.set(edge.id, edges.length);
    edges.push({ id: edge.id, from, to });
    directedPairs.push([from, to]);
  }

  const layoutPairs = undirectedPairs(directedPairs);
  const prerequisites = new Int32Array(ids.length);
  const dependents = new Int32Array(ids.length);
  const neighborSets: Array<Set<number>> = ids.map(() => new Set<number>());
  for (const edge of edges) {
    prerequisites[edge.from] += 1;
    dependents[edge.to] += 1;
    neighborSets[edge.from]!.add(edge.to);
    neighborSets[edge.to]!.add(edge.from);
  }
  const neighbors = neighborSets.map((set) => [...set].sort((a, b) => a - b));

  const radius = new Float32Array(ids.length);
  for (let i = 0; i < ids.length; i += 1) {
    const degree = neighbors[i]!.length;
    // 枢纽略大：这是视觉提示，不是把「连接多」当成「更重要」的业务判断
    const hub = 1 + Math.min(0.5, 0.055 * Math.log2(1 + degree));
    const root = ids[i] === rootId ? 1.22 : 1;
    radius[i] = baseRadius * hub * root;
  }

  return {
    ids,
    indexById,
    titles,
    statuses,
    edges,
    edgeIndexById,
    layoutPairs,
    prerequisites,
    dependents,
    neighbors,
    radius,
    signature: topologySignature(ids, layoutPairs),
  };
}

/**
 * 与当前节点相关的节点集合（含自己）。
 *
 * 「相关」= 直接前置 / 直接依赖它的地方，用来决定强调边、标签优先级与淡化程度。
 * 关系核对以详情列表为准，这里只负责视觉强调。
 */
export function relatedSet(graph: SpaceGraph, index: number | null): Set<number> {
  const related = new Set<number>();
  if (index === null || index < 0 || index >= graph.ids.length) return related;
  related.add(index);
  for (const neighbor of graph.neighbors[index] ?? []) related.add(neighbor);
  return related;
}
