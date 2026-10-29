/**
 * 知识地图（平面总览层）的**纯数据逻辑**。
 *
 * 两层视图的划分（`design/knowledge-map-two-layer.md`）：
 * - **平面层**：把整张图按「连通分量」分成一座座知识岛（忽略依赖箭头方向），只回答"有哪些群"；
 *   岛与岛之间不画任何线、距离也没有语义；
 * - **空间层**：进入某座岛之后，只把这座岛的节点与关系交给三维视图。
 *
 * 这个文件不碰 React / DOM / 宿主：连通分量、岛的身份键、代表节点、缩略图坐标都是可单测的纯函数。
 * 连通分量**复用**上游布局层的 `buildTopology`（它本来就要为力导向布局算分量与签名），
 * 不再自己写一套 BFS —— 同一份图两套分量算法迟早会分叉。
 */
import type { GraphSnapshot, KnowledgeNode } from "../vendor/upstream/data/types.ts";
import { buildTopology } from "../vendor/upstream/graph3d/topology.ts";

/**
 * 岛卡缩略图最多画几个节点。
 *
 * 卡片的图只有 100×72 左右：节点再多就糊成一团，反而看不出结构。
 * 超出时按度数**抽样**（代表节点一定留下），卡片上的计数仍按整座岛统计。
 */
export const PREVIEW_MAX_NODES = 120;

/** 缩略图最多画几条关系（与抽样后的节点同量级即可） */
const PREVIEW_MAX_EDGES = 240;

/** 岛内一个节点（展示用） */
export interface IslandNodeView {
  id: string;
  title: string;
  /** 已理解（由 coloredGraph 的 status === "done" 得来） */
  known: boolean;
  /** 岛内度数（缩略图抽样与代表节点都按它排序） */
  degree: number;
}

/** 缩略图里的一个点（坐标归一化到 [0,1]） */
export interface PreviewPoint {
  id: string;
  x: number;
  y: number;
  known: boolean;
  representative: boolean;
}

/** 岛卡缩略图：点 + 岛内无向关系（下标指向 points） */
export interface IslandPreview {
  points: PreviewPoint[];
  edges: Array<[number, number]>;
}

/** 一座知识岛（一个连通分量；多个孤立节点会合并成一张「独立节点」卡） */
export interface KnowledgeIsland {
  /**
   * 作用域键 / 视角缓存键：成员 ID 集合的哈希。
   *
   * 为什么不用"第一个节点 ID"：那样删掉它之后整座岛会换键（视角记忆全丢）；
   * 用成员集合哈希则只要成员不变键就不变 ✓（成员真的变了，换键重新取景也更合理）。
   */
  key: string;
  /** 成员 ID；按岛内度数降序、同度再按 ID 升序（稳定顺序 ✓） */
  nodeIds: string[];
  /** 与 `nodeIds` 同序的展示信息 */
  nodes: IslandNodeView[];
  /** 卡片标题：代表节点（岛内**入口节点**，见 `representativeId`）的标题；多节点「独立节点」卡为 null */
  name: string | null;
  /**
   * 代表节点：没有依赖者的入口节点（多棵树顶时取度数最高的；理论上没有则退回度数最高）。
   * 卡片标题与缩略图指纹环用它 —— 它比"度数最高的节点"更能说明这座岛是什么。
   */
  representativeId: string | null;
  nodeCount: number;
  /** 岛内无向关系条数（同一对节点的多条有向边只算一条 ✓） */
  edgeCount: number;
  knownCount: number;
  /** 是否是「独立节点」合并卡（单个孤立节点也算，此时 name 是该节点标题） */
  isolated: boolean;
  preview: IslandPreview;
}

/** 整张图切成知识岛之后的结果 */
export interface KnowledgeMapModel {
  /** 卡片顺序：非孤立岛按节点数降序（同数按名字），独立节点卡固定最后 */
  islands: KnowledgeIsland[];
  /** 节点 ID → 岛键（搜索命中后"该去哪个岛"、局部刷新后"还认不认得这座岛"都要它） */
  nodeToIsland: Map<string, string>;
  totalNodes: number;
  totalEdges: number;
}

/** 岛的稳定键：成员 ID 排序后做 FNV-1a */
export function islandKeyOf(nodeIds: readonly string[]): string {
  const ids = [...nodeIds].sort(compareIds);
  let hash = 0x811c9dc5;
  for (const id of ids) {
    for (let i = 0; i < id.length; i += 1) {
      hash ^= id.charCodeAt(i) & 0xff;
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193);
  }
  return `isl-${(hash >>> 0).toString(36)}`;
}

/**
 * 把图快照切成知识岛。
 *
 * @param graph - 图快照（面板传 `coloredGraph`，这样"已理解"颜色才在缩略图上生效）。
 * @returns 知识岛列表（含缩略图）与节点归属索引。
 */
export function buildKnowledgeMap(graph: GraphSnapshot): KnowledgeMapModel {
  const nodeById = new Map<string, KnowledgeNode>();
  for (const node of graph.nodes) {
    if (!nodeById.has(node.id)) nodeById.set(node.id, node);
  }
  const ids = [...nodeById.keys()].sort(compareIds);
  const indexOf = new Map<string, number>();
  ids.forEach((id, index) => indexOf.set(id, index));

  /* 无向关系对（两端都在图里、忽略自环、同一对只留一条） */
  const pairs: Array<[number, number]> = [];
  const seenPairs = new Set<string>();
  for (const edge of graph.edges) {
    const a = indexOf.get(edge.fromId);
    const b = indexOf.get(edge.toId);
    if (a === undefined || b === undefined || a === b) continue;
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const pairKey = `${low}:${high}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    pairs.push([low, high]);
  }
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  const topo = buildTopology(ids, pairs);
  const degree = pickDegrees(topo.adjacency);
  /*
   * 「依赖者」计数：边是 `fromId 依赖 toId` ⇒ toId 有一个依赖者（fromId）。
   * 没有依赖者的节点就是这座岛的**入口节点**（学习树顶：没有别人把它当前置），
   * 卡片名优先取它 —— "加密 ECS" 比 "MACK" 更能说明这座岛是什么 ✓。
   */
  const dependentCount = new Int32Array(ids.length);
  for (const edge of graph.edges) {
    const dependent = indexOf.get(edge.fromId);
    const prerequisite = indexOf.get(edge.toId);
    if (dependent === undefined || prerequisite === undefined || dependent === prerequisite) continue;
    dependentCount[prerequisite]! += 1;
  }
  /* 每条无向关系必属且只属一个分量：按分量收好，建岛时直接用 */
  const pairsByComponent = new Map<number, Array<[number, number]>>();
  for (const pair of topo.pairs) {
    const component = topo.componentOf[pair[0]]!;
    const list = pairsByComponent.get(component);
    if (list === undefined) pairsByComponent.set(component, [pair]);
    else list.push(pair);
  }

  const islands: KnowledgeIsland[] = [];
  const isolatedIndexes: number[] = [];
  topo.components.forEach((memberIndexes, component) => {
    if (memberIndexes.length === 1 && topo.adjacency[memberIndexes[0]!]!.length === 0) {
      isolatedIndexes.push(memberIndexes[0]!);
      return;
    }
    islands.push(makeIsland(memberIndexes, component));
  });
  if (isolatedIndexes.length > 0) islands.push(makeIsolatedIsland(isolatedIndexes));
  islands.sort(compareIslands);

  const nodeToIsland = new Map<string, string>();
  for (const island of islands) {
    for (const id of island.nodeIds) nodeToIsland.set(id, island.key);
  }

  return {
    islands,
    nodeToIsland,
    totalNodes: ids.length,
    totalEdges: topo.pairs.length,
  };

  /** 建一座非孤立岛（成员按度数降序；边换成岛内下标） */
  function makeIsland(memberIndexes: number[], component: number): KnowledgeIsland {
    /* 先按度数降序排好（缩略图与同分时的顺序都稳定）；代表节点再按"入口优先"挑 */
    const byDegree = [...memberIndexes].sort((a, b) => {
      const diff = degree[b]! - degree[a]!;
      return diff !== 0 ? diff : compareIds(topo.ids[a]!, topo.ids[b]!);
    });
    const entryIndexes = byDegree.filter((globalIndex) => dependentCount[globalIndex] === 0);
    /* 入口节点可能不止一个（多棵学习树顶）⇒ 取度数最高的那个；都没有（理论上不会）就退回度数最高 */
    const representativeGlobal = entryIndexes[0] ?? byDegree[0]!;
    /* 展示顺序仍按度数：代表节点可能排在中间（缩略图给它画指纹环 ✓） */
    const ordered = byDegree;
    const localOf = new Map<number, number>();
    ordered.forEach((globalIndex, localIndex) => localOf.set(globalIndex, localIndex));
    const islandNodes: IslandNodeView[] = ordered.map((globalIndex) => {
      const id = topo.ids[globalIndex]!;
      const node = nodeById.get(id)!;
      return {
        id,
        title: node.title,
        known: node.status === "done",
        degree: degree[globalIndex]!,
      };
    });
    const localPairs: Array<[number, number]> = [];
    for (const pair of pairsByComponent.get(component) ?? []) {
      const a = localOf.get(pair[0]);
      const b = localOf.get(pair[1]);
      if (a === undefined || b === undefined) continue;
      localPairs.push([a, b]);
    }
    const representativeIndex = localOf.get(representativeGlobal)!;
    const representative = islandNodes[representativeIndex]!;
    return {
      key: islandKeyOf(islandNodes.map((node) => node.id)),
      nodeIds: islandNodes.map((node) => node.id),
      nodes: islandNodes,
      name: representative.title,
      representativeId: representative.id,
      nodeCount: islandNodes.length,
      edgeCount: localPairs.length,
      knownCount: islandNodes.filter((node) => node.known).length,
      isolated: false,
      preview: previewIsland(islandNodes, localPairs, representativeIndex),
    };
  }

  /** 多座单点岛合并成的一张卡：没有关系，缩略图只画点 */
  function makeIsolatedIsland(memberIndexes: number[]): KnowledgeIsland {
    const ordered = [...memberIndexes].sort((a, b) => compareIds(topo.ids[a]!, topo.ids[b]!));
    const islandNodes: IslandNodeView[] = ordered.map((globalIndex) => {
      const id = topo.ids[globalIndex]!;
      const node = nodeById.get(id)!;
      return { id, title: node.title, known: node.status === "done", degree: 0 };
    });
    const only = islandNodes.length === 1 ? islandNodes[0]! : null;
    return {
      key: islandKeyOf(islandNodes.map((node) => node.id)),
      nodeIds: islandNodes.map((node) => node.id),
      nodes: islandNodes,
      name: only === null ? null : only.title,
      representativeId: only === null ? null : only.id,
      nodeCount: islandNodes.length,
      edgeCount: 0,
      knownCount: islandNodes.filter((node) => node.known).length,
      isolated: true,
      preview: previewIsland(islandNodes, [], only === null ? -1 : 0),
    };
  }
}

/**
 * 把整张图裁剪成**一座岛**（可直接交给三维视图）。
 *
 * 关系必须按"两端都在岛内"过滤：上游拿 `graph.edges[hit.index]` 反查被点中的关系，
 * 若把跨岛的关系留在数组里，索引会错位 ⇒ 右键菜单作用到别的关系上（真会踩）。
 *
 * @param graph - 整张图（带理解颜色）。
 * @param island - 目标知识岛。
 * @returns 只含该岛节点与岛内关系的新快照。
 */
export function islandSnapshot(graph: GraphSnapshot, island: KnowledgeIsland): GraphSnapshot {
  const keep = new Set(island.nodeIds);
  const nodes = graph.nodes.filter((node) => keep.has(node.id));
  const edges = graph.edges.filter((edge) => keep.has(edge.fromId) && keep.has(edge.toId));
  const goals = graph.goals.filter((goal) => keep.has(goal.rootNodeId));
  return { ...graph, nodes, edges, goals };
}

/* ------------------------------ 缩略图布局 ------------------------------ */

/** 岛屿卡片缩略图的确定性布局（无随机数：同一份数据每次画出来必须一样 ✓） */
function previewIsland(
  nodes: IslandNodeView[],
  edges: Array<[number, number]>,
  representativeIndex: number,
): IslandPreview {
  /* 抽样：保留度数最高的一批（nodes 已按度数降序 ⇒ 直接取前 N 个） */
  let sampleIndexes = nodes.map((_, index) => index);
  let pairs = edges;
  if (nodes.length > PREVIEW_MAX_NODES) {
    sampleIndexes = sampleIndexes.slice(0, PREVIEW_MAX_NODES);
    const localOf = new Map<number, number>();
    sampleIndexes.forEach((oldIndex, newIndex) => localOf.set(oldIndex, newIndex));
    pairs = edges
      .filter(([a, b]) => localOf.has(a) && localOf.has(b))
      .map(([a, b]) => [localOf.get(a)!, localOf.get(b)!] as [number, number]);
  }
  if (pairs.length > PREVIEW_MAX_EDGES) pairs = pairs.slice(0, PREVIEW_MAX_EDGES);

  const count = sampleIndexes.length;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  /* 确定性初始云：黄金角向日葵（按样本顺序 ⇒ 度数高的靠中心） */
  for (let i = 0; i < count; i += 1) {
    const angle = i * 2.399963229728653;
    const radius = 0.5 * Math.sqrt((i + 0.5) / Math.max(1, count));
    xs[i] = 0.5 + Math.cos(angle) * radius;
    ys[i] = 0.5 + Math.sin(angle) * radius;
  }

  if (count > 1) {
    /* 一轮很小的力导向：让有关系的点靠近，缩略图才看得出"结构"，而不是一团均匀散点 */
    const k = Math.sqrt(1 / count);
    let temperature = 0.16;
    const iterations = count <= 20 ? 140 : count <= 60 ? 100 : 60;
    const dispX = new Float64Array(count);
    const dispY = new Float64Array(count);
    for (let step = 0; step < iterations; step += 1) {
      dispX.fill(0);
      dispY.fill(0);
      for (let i = 0; i < count; i += 1) {
        for (let j = i + 1; j < count; j += 1) {
          let dx = xs[i]! - xs[j]!;
          let dy = ys[i]! - ys[j]!;
          let distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < 1e-9) {
            /* 重合点用下标造一个固定的推开方向（不能用随机数） */
            dx = ((i * 13 + j * 7) % 5 - 2) * 1e-3 + 1e-3;
            dy = ((i * 7 + j * 13) % 5 - 2) * 1e-3 + 1e-3;
            distanceSquared = dx * dx + dy * dy;
          }
          const distance = Math.sqrt(distanceSquared);
          const force = (k * k) / distance;
          const ux = (dx / distance) * force;
          const uy = (dy / distance) * force;
          dispX[i]! += ux;
          dispY[i]! += uy;
          dispX[j]! -= ux;
          dispY[j]! -= uy;
        }
      }
      for (const [a, b] of pairs) {
        const dx = xs[a]! - xs[b]!;
        const dy = ys[a]! - ys[b]!;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1e-3;
        const force = (distance * distance) / k;
        const ux = (dx / distance) * force;
        const uy = (dy / distance) * force;
        dispX[a]! -= ux;
        dispY[a]! -= uy;
        dispX[b]! += ux;
        dispY[b]! += uy;
      }
      for (let i = 0; i < count; i += 1) {
        /* 弱重力：不让孤立的点被斥力推到天边 */
        dispX[i]! += (0.5 - xs[i]!) * 0.08;
        dispY[i]! += (0.5 - ys[i]!) * 0.08;
        const length = Math.hypot(dispX[i]!, dispY[i]!);
        if (length > temperature) {
          const scale = temperature / length;
          dispX[i]! *= scale;
          dispY[i]! *= scale;
        }
        xs[i]! += dispX[i]!;
        ys[i]! += dispY[i]!;
      }
      temperature = Math.max(0.003, temperature * 0.96);
    }
  }

  return {
    points: normalizePreviewPoints(xs, ys, sampleIndexes, nodes, representativeIndex),
    edges: pairs,
  };
}

/** 把任意范围的坐标缩进 [0.04,0.96]²（留一点边，点不会被卡片边缘裁掉） */
function normalizePreviewPoints(
  xs: Float64Array,
  ys: Float64Array,
  sampleIndexes: number[],
  nodes: IslandNodeView[],
  representativeIndex: number,
): PreviewPoint[] {
  const count = xs.length;
  if (count === 0) return [];
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
    minX = Math.min(minX, xs[i]!);
    maxX = Math.max(maxX, xs[i]!);
    minY = Math.min(minY, ys[i]!);
    maxY = Math.max(maxY, ys[i]!);
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  return sampleIndexes.map((oldIndex, localIndex) => {
    const node = nodes[oldIndex]!;
    return {
      id: node.id,
      x: spanX < 1e-6 ? 0.5 : 0.04 + ((xs[localIndex]! - minX) / spanX) * 0.92,
      y: spanY < 1e-6 ? 0.5 : 0.04 + ((ys[localIndex]! - minY) / spanY) * 0.92,
      known: node.known,
      representative: oldIndex === representativeIndex,
    };
  });
}

/* -------------------------------- 小工具 -------------------------------- */

/** 岛卡排序：节点多的在前；同数量按名字（独立节点卡固定最后） */
function compareIslands(a: KnowledgeIsland, b: KnowledgeIsland): number {
  if (a.isolated !== b.isolated) return a.isolated ? 1 : -1;
  if (a.nodeCount !== b.nodeCount) return b.nodeCount - a.nodeCount;
  const nameA = a.name ?? "";
  const nameB = b.name ?? "";
  if (nameA !== nameB) return nameA < nameB ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** 稳定 ID 比较：不依赖区域设置（`localeCompare` 在不同系统上可能不同） */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 从拓扑的邻接表读出度数 */
function pickDegrees(adjacency: number[][]): Int32Array {
  const out = new Int32Array(adjacency.length);
  for (let i = 0; i < adjacency.length; i += 1) out[i] = adjacency[i]!.length;
  return out;
}
