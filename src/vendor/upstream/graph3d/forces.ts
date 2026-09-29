/**
 * 自定义力与几何度量（纯计算）
 *
 * 《空间图谱技术方案》4.2 / 4.3 / 4.4 的实现层：
 * - 弱拓扑分离：只作用于 d ≥ 2 的候选节点对，对称归一化并限制单步增量；
 * - 弱收拢：向分量锚点靠拢（forceCenter 只挪质心，替代不了收拢）；
 * - 柔性边界：只对超出目标范围的节点回拉，不把所有节点按到球壳上；
 * - 旧坐标软锚定：增量更新时保住空间记忆，改动点一两跳内更弱、外围更强。
 *
 * 这些力都直接写 `vx/vy/vz`（与 d3 自定义力一致），不返回位移：
 * d3 的积分步会按 velocityDecay 平滑掉每次增量，返回位移反而会绕开阻尼。
 */
import type { LayoutNode, LayoutParams } from "./types.ts";
import { expectedCloudRadius } from "./topology.ts";
import type { Topology } from "./topology.ts";

/* ------------------------------ 拓扑分离 ------------------------------ */

export interface TopologyForceState {
  pairs: Array<[number, number]>;
  targets: Float64Array;
  counts: Int32Array;
}


/**
 * 受控拓扑分离。
 *
 * ```
 * r = ||xi - xj||, u = (xi - xj) / max(r, ε)
 * a = alpha × kTopo × max(0, L(d) - r) / max(1, qi, qj)
 * Δvi += clamp(a, 0, aMax) × u,  Δvj -= clamp(a, 0, aMax) × u
 * ```
 *
 * 只处理过近的一侧：过远由弹簧与普通斥力表达，这里不做「拉近」，
 * 免得把两种力叠成一双更强的斥力。
 */
export function applyTopologyForce(
  nodes: LayoutNode[],
  state: TopologyForceState,
  params: LayoutParams,
  alpha: number,
): void {
  const epsilon = 1e-4;
  for (let k = 0; k < state.pairs.length; k += 1) {
    const [i, j] = state.pairs[k]!;
    const a = nodes[i]!;
    const b = nodes[j]!;
    let dx = a.x - b.x;
    let dy = a.y - b.y;
    let dz = a.z - b.z;
    let r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (r < epsilon) {
      // 完全重合：用稳定 ID 派生的方向打破，避免除零与「粘在一起」
      const [ux, uy, uz] = tieBreakDirection(a.id, b.id);
      dx = ux;
      dy = uy;
      dz = uz;
      r = 1;
    }
    const target = state.targets[k]!;
    const gap = target - r;
    if (gap <= 0) continue;
    const norm = Math.max(1, Math.max(state.counts[i]!, state.counts[j]!));
    const magnitude = Math.min(
      params.topoMaxStep,
      (alpha * params.topoStrength * gap) / norm,
    );
    if (magnitude <= 0) continue;
    const fx = (dx / r) * magnitude;
    const fy = (dy / r) * magnitude;
    const fz = (dz / r) * magnitude;
    a.vx += fx;
    a.vy += fy;
    a.vz += fz;
    b.vx -= fx;
    b.vy -= fy;
    b.vz -= fz;
  }
}

/** 两个稳定 ID 派生的单位向量：同样的重合对永远朝同一个方向分开 */
export function tieBreakDirection(idA: string, idB: string): [number, number, number] {
  let hash = 0x9e3779b9;
  const key = idA < idB ? `${idA}\u0000${idB}` : `${idB}\u0000${idA}`;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const x = ((hash & 0xff) / 255) * 2 - 1;
  const y = (((hash >>> 8) & 0xff) / 255) * 2 - 1;
  const z = (((hash >>> 16) & 0xff) / 255) * 2 - 1;
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/* --------------------------- 收拢 / 边界 / 锚定 --------------------------- */

export interface ComponentGeometry {
  /** 每个节点的分量锚点（与节点索引对齐） */
  anchors: Float64Array;
  /** 柔性边界半径：按节点数与 Ledge 估算，不用一个固定球装所有规模 */
  boundaryRadius: Float64Array;
}

export function componentGeometry(topo: Topology, params: LayoutParams, anchors: Float64Array): ComponentGeometry {
  const boundaryRadius = new Float64Array(topo.ids.length);
  for (const component of topo.components) {
    const radius = expectedCloudRadius(params.edgeLength, component.length) * params.boundarySlack;
    for (const index of component) boundaryRadius[index] = radius;
  }
  return { anchors, boundaryRadius };
}

/** 弱收拢：把分量往自己的锚点带，控制松散程度（不改变相对距离的语义） */
export function applyCenteringForce(
  nodes: LayoutNode[],
  geometry: ComponentGeometry,
  params: LayoutParams,
  alpha: number,
): void {
  const strength = params.centering * alpha;
  if (strength <= 0) return;
  for (const node of nodes) {
    const i = node.index * 3;
    node.vx += (geometry.anchors[i]! - node.x) * strength;
    node.vy += (geometry.anchors[i + 1]! - node.y) * strength;
    node.vz += (geometry.anchors[i + 2]! - node.z) * strength;
  }
}

/**
 * 柔性边界：只对超出目标范围的节点回拉。
 *
 * 不用正半径 forceRadial（那是往球壳上贴），也不做硬裁剪：
 * 长链、星形外壳与多子团都允许存在。
 */
export function applyBoundaryForce(
  nodes: LayoutNode[],
  geometry: ComponentGeometry,
  params: LayoutParams,
  alpha: number,
): void {
  const strength = params.boundaryStrength * alpha;
  if (strength <= 0) return;
  for (const node of nodes) {
    const i = node.index * 3;
    const dx = node.x - geometry.anchors[i]!;
    const dy = node.y - geometry.anchors[i + 1]!;
    const dz = node.z - geometry.anchors[i + 2]!;
    const r = Math.hypot(dx, dy, dz);
    const limit = geometry.boundaryRadius[node.index]!;
    if (r <= limit || r <= 0) continue;
    const back = ((r - limit) / r) * strength;
    node.vx -= dx * back;
    node.vy -= dy * back;
    node.vz -= dz * back;
  }
}

/**
 * 旧坐标软锚定强度。
 *
 * 1 表示「沿用旧坐标、正常拉住」；0.25 表示「刚新增或就在新增点一两跳内」——
 * 允许这段结构重新舒展，外围节点则基本不动，切视图回来还能认出原来的位置。
 */
export function softAnchorWeights(
  topo: Topology,
  hasPrevious: boolean[],
  nearChangeFactor = 0.25,
  neighborhoodHops = 2,
): Float32Array {
  const weights = new Float32Array(topo.ids.length);
  const newNodes: number[] = [];
  for (let i = 0; i < topo.ids.length; i += 1) {
    if (hasPrevious[i]) weights[i] = 1;
    else newNodes.push(i);
  }
  if (newNodes.length === 0) return weights;
  // 从新增点做有限跳 BFS：近处弱锚定，外围保持强锚定
  const queue = [...newNodes];
  const depth = new Int32Array(topo.ids.length).fill(-1);
  for (const i of newNodes) depth[i] = 0;
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head]!;
    head += 1;
    if (depth[cur]! >= neighborhoodHops) continue;
    for (const next of topo.adjacency[cur]!) {
      if (depth[next] !== -1) continue;
      depth[next] = depth[cur]! + 1;
      if (weights[next]! > 0) weights[next] = nearChangeFactor;
      queue.push(next);
    }
  }
  return weights;
}

export function applyAnchorForce(
  nodes: LayoutNode[],
  previous: Float32Array,
  weights: Float32Array,
  params: LayoutParams,
  alpha: number,
): void {
  if (params.anchorStrength <= 0) return;
  for (const node of nodes) {
    const weight = weights[node.index]!;
    if (weight <= 0) continue;
    const i = node.index * 3;
    const strength = params.anchorStrength * weight * alpha;
    if (strength <= 0) continue;
    node.vx += (previous[i]! - node.x) * strength;
    node.vy += (previous[i + 1]! - node.y) * strength;
    node.vz += (previous[i + 2]! - node.z) * strength;
  }
}

/* ------------------------------ 质量度量 ------------------------------ */

/** 位移均方根：归一化到 Ledge 之后才与图的尺度无关 */
export function rmsDisplacement(
  nodes: LayoutNode[],
  before: Float64Array,
  edgeLength: number,
): number {
  if (nodes.length === 0) return 0;
  let sum = 0;
  for (const node of nodes) {
    const i = node.index * 3;
    const dx = node.x - before[i]!;
    const dy = node.y - before[i + 1]!;
    const dz = node.z - before[i + 2]!;
    sum += dx * dx + dy * dy + dz * dz;
  }
  return Math.sqrt(sum / nodes.length) / edgeLength;
}

/**
 * 碰撞残差：最大穿透深度（世界单位）。
 *
 * 用空间哈希网格，邻居只在自己与相邻格子中找，因此是 O(N + 重叠对数)，
 * 不会因为「检查碰撞」把大图拖慢。返回 0 表示没有重叠。
 */
export function collisionResidual(nodes: LayoutNode[], collideRadius: number): number {
  if (nodes.length < 2) return 0;
  const cell = collideRadius * 2;
  /*
   * 数值网格键：这一趟每 4 个 tick 就要跑一次，用字符串拼接会产生大量短命对象。
   * 格号折到 [-512, 512]（格子边长是碰撞直径的两倍，够覆盖任何合理的云团），
   * 越界时钳住即可——那里本来就不会有节点互相碰撞。
   */
  const buckets = new Map<number, number[]>();
  const cellOf = (value: number) => {
    const index = Math.floor(value / cell);
    return index < -512 ? -512 : index > 512 ? 512 : index;
  };
  const key = (x: number, y: number, z: number) => ((x + 512) * 1025 + (y + 512)) * 1025 + (z + 512);
  for (const node of nodes) {
    const k = key(cellOf(node.x), cellOf(node.y), cellOf(node.z));
    const bucket = buckets.get(k);
    if (bucket) bucket.push(node.index);
    else buckets.set(k, [node.index]);
  }
  let worst = 0;
  for (const node of nodes) {
    const cx = cellOf(node.x);
    const cy = cellOf(node.y);
    const cz = cellOf(node.z);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = buckets.get(key(cx + dx, cy + dy, cz + dz));
          if (!bucket) continue;
          for (const other of bucket) {
            if (other <= node.index) continue; // 同一对只算一次
            const b = nodes[other]!;
            const distance = Math.hypot(node.x - b.x, node.y - b.y, node.z - b.z);
            const penetration = collideRadius * 2 - distance;
            if (penetration > worst) worst = penetration;
          }
        }
      }
    }
  }
  return worst;
}

/** 所有坐标都有限？（出现 NaN/Infinity 时回退上一份有效快照） */
export function hasFiniteCoordinates(nodes: LayoutNode[]): boolean {
  for (const node of nodes) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.z)) {
      return false;
    }
  }
  return true;
}
