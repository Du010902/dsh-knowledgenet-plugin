/**
 * 依赖图的拓扑：无向化、连通分量、跳数距离、候选节点对
 *
 * 纯计算，不碰 DOM、不碰 three、不碰业务 Store——Worker 与单元测试都用它。
 *
 * 两条约定，照抄《空间图谱技术方案》4.1：
 * 1. 布局距离用**无向化**后的最短跳数 d(i,j)：只在布局里忽略箭头，
 *    原始有向边、前置语义与数据保存都不受影响（箭头永远由 fromId → toId 决定）。
 * 2. 不同连通分量之间没有有限跳数，不能把无穷代进距离公式：
 *    分量各自布局，分量之间按包围体给出稳定间隔，孤立节点自成一个分量。
 */
import type { LayoutParams, Vec3 } from "./types.ts";

export interface Topology {
  /** 稳定 ID 顺序（按字符串排序），坐标数组永远按它解释 */
  ids: string[];
  indexById: Map<string, number>;
  /** 无向邻接表，邻居索引升序 */
  adjacency: number[][];
  /** 连通分量（每个分量内的索引升序），按最小索引升序排列 */
  components: number[][];
  /**
   * 全节点对跳数：distances[i][j]，-1 表示不可达（不同分量）。
   * 只有需要时才计算（`buildTopology(..., { distances: true })`）。
   */
  distances: Int16Array[] | null;
  /** 无向去重后的边（i < j），按 (i, j) 升序 */
  pairs: Array<[number, number]>;
  /** 结构签名：只含节点 ID 与无向边端点 */
  signature: string;
  /** 每个节点所属分量序号 */
  componentOf: Int32Array;
}

/** 稳定 ID 顺序：相同输入必须得到相同顺序，否则「同一份图」每次布局都会变形 */
export function stableIds(ids: Iterable<string>): string[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 无向去重：布局忽略箭头，但显示层仍然保留有向边 */
export function undirectedPairs(
  edges: Array<[number, number]>,
): Array<[number, number]> {
  const seen = new Set<number>();
  const out: Array<[number, number]> = [];
  for (const [a, b] of edges) {
    if (a === b) continue; // 自环对布局距离没有意义
    const i = Math.min(a, b);
    const j = Math.max(a, b);
    const key = i * 0x100000 + j;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([i, j]);
  }
  out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return out;
}

/**
 * 结构签名。
 *
 * 只包含节点 ID 与边端点：标题、笔记、状态、主题、选中、相机变化都不改变它，
 * 因此这些变化不会触发重算——否则点一下节点整张图就会重新抖一次。
 */
export function topologySignature(ids: string[], pairs: Array<[number, number]>): string {
  let hash = 0x811c9dc5;
  const mix = (value: number) => {
    hash ^= value & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (value >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  };
  for (const id of ids) {
    for (let i = 0; i < id.length; i += 1) mix(id.charCodeAt(i));
    mix(0x1f);
  }
  mix(ids.length);
  for (const [a, b] of pairs) {
    mix(a);
    mix(b);
  }
  return `t1:${ids.length}:${pairs.length}:${(hash >>> 0).toString(36)}`;
}

/** 建拓扑。`distances` 打开时会做全源 BFS（O(N·(N+M))，只在结构变化时算一次） */
export function buildTopology(
  rawIds: string[],
  edges: Array<[number, number]>,
  options: { distances?: boolean } = {},
): Topology {
  const ids = stableIds(rawIds);
  const indexById = new Map<string, number>();
  ids.forEach((id, i) => indexById.set(id, i));

  const pairs = undirectedPairs(edges);
  const adjacency: number[][] = ids.map(() => []);
  for (const [a, b] of pairs) {
    adjacency[a]!.push(b);
    adjacency[b]!.push(a);
  }
  for (const list of adjacency) list.sort((a, b) => a - b);

  const componentOf = new Int32Array(ids.length).fill(-1);
  const components: number[][] = [];
  for (let start = 0; start < ids.length; start += 1) {
    if (componentOf[start] !== -1) continue;
    const component: number[] = [];
    const queue = [start];
    componentOf[start] = components.length;
    for (let head = 0; head < queue.length; head += 1) {
      const cur = queue[head]!;
      component.push(cur);
      for (const next of adjacency[cur]!) {
        if (componentOf[next] !== -1) continue;
        componentOf[next] = components.length;
        queue.push(next);
      }
    }
    component.sort((a, b) => a - b);
    components.push(component);
  }
  components.sort((a, b) => a[0]! - b[0]!);

  return {
    ids,
    indexById,
    adjacency,
    components,
    distances: options.distances ? allPairsDistances(adjacency) : null,
    pairs,
    signature: topologySignature(ids, pairs),
    componentOf,
  };
}

/** 从每个节点出发做一次 BFS；环、未连通、孤立点都在这里自然收敛 */
function allPairsDistances(adjacency: number[][]): Int16Array[] {
  const n = adjacency.length;
  const table: Int16Array[] = new Array(n);
  const queue = new Int32Array(n);
  for (let root = 0; root < n; root += 1) {
    const dist = new Int16Array(n).fill(-1);
    dist[root] = 0;
    let head = 0;
    let tail = 0;
    queue[tail] = root;
    tail += 1;
    while (head < tail) {
      const cur = queue[head]!;
      head += 1;
      const next = dist[cur]! + 1;
      for (const nb of adjacency[cur]!) {
        if (dist[nb] !== -1) continue;
        dist[nb] = next;
        queue[tail] = nb;
        tail += 1;
      }
    }
    table[root] = dist;
  }
  return table;
}

/**
 * 拓扑目标距离：L(d) = Ledge × (1 + β × ln d)，d ≥ 1。
 *
 * L(1) 恰好等于直接边长度：直接相连的节点不再叠加拓扑分离，
 * 它们的关系由弹簧、斥力和碰撞表达。
 */
export function targetDistance(d: number, params: LayoutParams): number {
  if (d <= 1) return params.edgeLength;
  return params.edgeLength * (1 + params.topoBeta * Math.log(d));
}

export interface TopologyPairs {
  pairs: Array<[number, number]>;
  /** 每个节点对的目标长度，与 pairs 一一对应 */
  targets: Float64Array;
  /** 每个节点参与的约束对数：力的对称归一化用它，避免大图局部突增 */
  counts: Int32Array;
}

/**
 * 挑出参与拓扑分离的节点对。
 *
 * 小图（节点对总数在预算内）取全部 d ≥ 2 的对；大图先取关键近邻对
 * （每个节点按跳数从小到大取若干），再用固定种子在分量内抽样补足预算——
 * 远分支因此仍被考虑，而不是每帧随机换一批约束引起抖动。
 */
export function selectTopologyPairs(
  topo: Topology,
  params: LayoutParams,
): TopologyPairs {
  const n = topo.ids.length;
  const counts = new Int32Array(n);
  if (n < 2) {
    return { pairs: [], targets: new Float64Array(0), counts };
  }
  const distances = topo.distances;
  const budget = Math.max(1, Math.floor(params.topoPairBudget));
  const chosen = new Set<number>();
  const pairs: Array<[number, number]> = [];
  const key = (i: number, j: number) => i * 0x100000 + j;

  const push = (i: number, j: number) => {
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    const k = key(a, b);
    if (chosen.has(k)) return false;
    chosen.add(k);
    pairs.push([a, b]);
    counts[a] += 1;
    counts[b] += 1;
    return true;
  };

  const nearPerNode = n <= 120 ? 64 : 12;
  if (distances) {
    // 关键近邻：每个节点按跳数升序取前 nearPerNode 个（只算同分量、d ≥ 2）
    for (let i = 0; i < n; i += 1) {
      const row = distances[i]!;
      const candidates: Array<{ j: number; d: number }> = [];
      for (let j = i + 1; j < n; j += 1) {
        const d = row[j]!;
        if (d >= 2) candidates.push({ j, d });
      }
      candidates.sort((a, b) => a.d - b.d || a.j - b.j);
      for (let k = 0; k < Math.min(nearPerNode, candidates.length); k += 1) {
        if (pairs.length >= budget) break;
        push(i, candidates[k]!.j);
      }
    }
  } else {
    // 没有距离表时退化成「二跳以内的近邻」，仍然确定性
    for (const component of topo.components) {
      for (const i of component) {
        const seen = new Set<number>();
        for (const nb of topo.adjacency[i]!) for (const nb2 of topo.adjacency[nb]!) seen.add(nb2);
        const list = [...seen].filter((j) => j > i).sort((a, b) => a - b);
        for (let k = 0; k < Math.min(nearPerNode, list.length); k += 1) {
          if (pairs.length >= budget) break;
          push(i, list[k]!);
        }
      }
    }
  }

  // 预算还有余量：在分量内按固定种子抽样远关系对，覆盖「只算近邻」看不到的部分
  if (pairs.length < budget) {
    const rng = lcg(params.seed ^ 0x5bf03635);
    const maxAttempts = budget * 12;
    let attempts = 0;
    while (pairs.length < budget && attempts < maxAttempts) {
      attempts += 1;
      const i = Math.floor(rng() * n);
      const component = topo.components[topo.componentOf[i]!]!;
      if (component.length < 2) continue;
      const j = component[Math.floor(rng() * component.length)]!;
      if (i === j) continue;
      if (distances && distances[i]![j]! < 2) continue; // 直接边交给弹簧
      push(i, j);
    }
  }

  const targets = new Float64Array(pairs.length);
  for (let k = 0; k < pairs.length; k += 1) {
    const [i, j] = pairs[k]!;
    const d = distances ? distances[i]![j]! : 3;
    targets[k] = targetDistance(d >= 2 ? d : 3, params);
  }
  return { pairs, targets, counts };
}

/** 线性同余发生器：固定种子 → 可复现的初始化与抽样 */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * 「紧凑云团」的估算半径：按节点数与直接边长度估一个体积，
 * 只用来定柔性边界与初始分布，不当作必须达到的形状。
 *
 * 长链细长、星形有外壳、多子团并存都是合法结果——不为了球形扭曲关系。
 */
export function expectedCloudRadius(edgeLength: number, nodeCount: number): number {
  if (nodeCount <= 1) return edgeLength;
  return 1.4 * edgeLength * Math.cbrt(nodeCount);
}

/** 每个分量的锚点：分量之间留出稳定间隔，锚点不赋予「知识更远」的业务含义 */
export function componentAnchors(topo: Topology, params: LayoutParams): Float64Array {
  const anchors = new Float64Array(topo.ids.length * 3);
  const components = [...topo.components].sort(
    (a, b) => b.length - a.length || a[0]! - b[0]!,
  );
  if (components.length <= 1) return anchors; // 单分量：锚点就是原点

  const unit = (k: number): Vec3 => {
    // 黄金角螺旋：确定性、各方向分散，不依赖随机数
    const y = 1 - (2 * (k + 0.5)) / components.length;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = k * Math.PI * (3 - Math.sqrt(5));
    return [Math.cos(theta) * r, y, Math.sin(theta) * r];
  };

  let cursor = 0;
  components.forEach((component, k) => {
    const radius = expectedCloudRadius(params.edgeLength, component.length);
    const gap = params.edgeLength * 1.5;
    const [ux, uy, uz] = unit(k);
    const center: Vec3 = [ux * (cursor + radius), uy * (cursor + radius), uz * (cursor + radius)];
    for (const i of component) {
      anchors[i * 3] = center[0];
      anchors[i * 3 + 1] = center[1];
      anchors[i * 3 + 2] = center[2];
    }
    cursor += radius * 2 + gap;
  });
  return anchors;
}

/**
 * 确定性初始分布：同一批 ID 与参数必然得到同一批坐标（不含随机数）。
 *
 * 每个分量围绕自己的锚点铺开，半径按体积均匀（cbrt）分布，
 * 方向用黄金角螺旋——比「全在原点附近再让斥力炸开」稳定得多。
 */
export function initialPositions(topo: Topology, params: LayoutParams): Float32Array {
  const n = topo.ids.length;
  const out = new Float32Array(n * 3);
  const anchors = componentAnchors(topo, params);
  for (const component of topo.components) {
    const radius = expectedCloudRadius(params.edgeLength, component.length) * 0.6;
    component.forEach((index, k) => {
      const fraction = (k + 0.5) / component.length;
      const local = radius * Math.cbrt(fraction);
      const y = 1 - 2 * fraction;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = k * Math.PI * (3 - Math.sqrt(5));
      out[index * 3] = anchors[index * 3]! + Math.cos(theta) * r * local;
      out[index * 3 + 1] = anchors[index * 3 + 1]! + y * local;
      out[index * 3 + 2] = anchors[index * 3 + 2]! + Math.sin(theta) * r * local;
    });
  }
  return out;
}

/**
 * 合并「缓存坐标」与「确定性初始分布」。
 *
 * 主线程需要一份立刻能渲染的坐标：有缓存的节点沿用旧位置（切视图回来不跳），
 * 新节点用初始分布（NaN 表示没有缓存）。Worker 内部用同一套规则，
 * 因此第一帧与 Worker 的第一份快照不会互相打架。
 */
export function mergePositions(initial: Float32Array, previous: Float32Array | null): Float32Array {
  if (!previous || previous.length !== initial.length) return initial;
  const out = new Float32Array(initial.length);
  for (let i = 0; i < initial.length; i += 3) {
    if (
      Number.isFinite(previous[i]) &&
      Number.isFinite(previous[i + 1]) &&
      Number.isFinite(previous[i + 2])
    ) {
      out[i] = previous[i]!;
      out[i + 1] = previous[i + 1]!;
      out[i + 2] = previous[i + 2]!;
    } else {
      out[i] = initial[i]!;
      out[i + 1] = initial[i + 1]!;
      out[i + 2] = initial[i + 2]!;
    }
  }
  return out;
}
