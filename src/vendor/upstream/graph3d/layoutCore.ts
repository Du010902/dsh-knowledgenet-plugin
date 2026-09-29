/**
 * 布局内核：d3-force-3d 基线 + 本项目的受控扩展
 *
 * 基线 A：直接边弹簧 + 普通斥力 + 节点碰撞 + 弱收拢 + 柔性边界。
 * 扩展 B：受预算限制的弱拓扑分离（`forces.ts`），两者用同一批图对照。
 *
 * 手动 tick，不用 d3 的自动计时器：渲染帧率与 Worker 分片都不应该改变物理结果，
 * 而且「一批算多少步」必须由我们按时间片决定（见《空间图谱技术方案》8.4）。
 * 这里的代码完全无 DOM、无 window，Worker 与单元测试共用。
 */
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
} from "d3-force-3d";

import {
  applyAnchorForce,
  applyBoundaryForce,
  applyCenteringForce,
  applyTopologyForce,
  collisionResidual,
  componentGeometry,
  hasFiniteCoordinates,
  rmsDisplacement,
  softAnchorWeights,
  type ComponentGeometry,
  type TopologyForceState,
} from "./forces.ts";
import {
  buildTopology,
  componentAnchors,
  initialPositions,
  selectTopologyPairs,
  type Topology,
} from "./topology.ts";
import type { LayoutMetrics, LayoutNode, LayoutParams, LayoutStopReason } from "./types.ts";

export interface LayoutBuildInput {
  /** 稳定 ID 顺序；坐标数组按它解释 */
  ids: string[];
  /** 无向化之前的边（索引指向 ids），方向在布局里被忽略 */
  edges: Array<[number, number]>;
  /**
   * 上一轮坐标，按同一 ID 顺序对齐。
   * 没有缓存的节点用 NaN 占位：既表示「它是新点」，也让初始化能认出它。
   */
  previous: Float32Array | null;
  /**
   * 温启动：沿用旧坐标时不从 alpha = 1 重新点火。
   *
   * 旧坐标往往已经接近平衡态，用满强度重启等于每次进视图都把整张图重新推开一遍，
   * 空间记忆就没了；低 alpha + 软锚定才是「只修一修」的做法。
   * 但这只是起点，稳定性仍由位移/碰撞门槛、软锚定与迭代预算共同保证。
   */
  warmStart?: boolean;
  params: LayoutParams;
}

interface LinkDatum extends SimulationLinkDatum<LayoutNode> {
  source: LayoutNode;
  target: LayoutNode;
}

/**
 * 温启动的初始 alpha。
 *
 * 取值是试调起点：太小则新增节点的结构舒展不出来，太大则整张图被重新推开。
 */
const WARM_ALPHA = 0.45;

export interface LayoutRuntime {
  topo: Topology;
  params: LayoutParams;
  nodes: LayoutNode[];
  geometry: ComponentGeometry;
  /** 本轮真正参与拓扑约束的节点对数（与无向边数不是一回事） */
  topologyPairs: number;
  /** 最近一次通过有限性检查的坐标快照（异常时的回退源） */
  valid: Float32Array;
  iterations: number;
  rms: number;
  /** 位移与碰撞连续达标的批次数 */
  stableBatches: number;
  collisionResidual: number;
  finite: boolean;
  simulation: Simulation<LayoutNode>;
  /** 内部临时缓冲：避免每批都新建大数组 */
  scratch: Float64Array;
}

function createNodes(
  input: LayoutBuildInput,
  topo: Topology,
): { nodes: LayoutNode[]; hasPrevious: boolean[] } {
  const initial = initialPositions(topo, input.params);
  const previous = input.previous;
  const nodes: LayoutNode[] = new Array(topo.ids.length);
  const hasPrevious: boolean[] = new Array(topo.ids.length).fill(false);
  for (let i = 0; i < topo.ids.length; i += 1) {
    const known =
      previous !== null &&
      previous.length >= (i + 1) * 3 &&
      Number.isFinite(previous[i * 3]) &&
      Number.isFinite(previous[i * 3 + 1]) &&
      Number.isFinite(previous[i * 3 + 2]);
    hasPrevious[i] = known;
    nodes[i] = {
      index: i,
      id: topo.ids[i]!,
      x: known ? previous![i * 3]! : initial[i * 3]!,
      y: known ? previous![i * 3 + 1]! : initial[i * 3 + 1]!,
      z: known ? previous![i * 3 + 2]! : initial[i * 3 + 2]!,
      vx: 0,
      vy: 0,
      vz: 0,
    };
  }
  return { nodes, hasPrevious };
}

/** 稳定 ID 顺序的入口检查：坐标数组的解释顺序必须与拓扑一致 */
function assertStableOrder(ids: string[]): void {
  for (let i = 1; i < ids.length; i += 1) {
    if (ids[i - 1]! > ids[i]!) {
      throw new Error(
        `布局输入必须按稳定 ID 升序：第 ${i - 1} 项「${ids[i - 1]}」大于第 ${i} 项「${ids[i]}」`,
      );
    }
  }
}

export function createLayout(input: LayoutBuildInput): LayoutRuntime {
  const params = input.params;
  /*
   * 坐标数组与 `input.ids` 一一对应，而 buildTopology 内部会重新按稳定 ID 排序：
   * 两边顺序不一致就会静默地把坐标错配到别的知识点上。这里显式挡住，
   * 让「顺序不对」当场暴露，而不是变成难以复现的画面错乱。
   */
  assertStableOrder(input.ids);
  const topo = buildTopology(input.ids, input.edges, { distances: true });
  const { nodes, hasPrevious } = createNodes(input, topo);

  const pairs = selectTopologyPairs(topo, params);
  const topologyForce: TopologyForceState = {
    pairs: pairs.pairs,
    targets: pairs.targets,
    counts: pairs.counts,
  };
  const geometry = componentGeometry(topo, params, componentAnchors(topo, params));
  const anchorWeights = softAnchorWeights(topo, hasPrevious);
  const previous = input.previous;

  const links: LinkDatum[] = topo.pairs.map(([a, b]) => ({
    source: nodes[a]!,
    target: nodes[b]!,
  }));

  const simulation = forceSimulation<LayoutNode>(nodes, 3)
    .stop() // 立即停掉自动计时器：所有推进都由 stepLayout 决定
    .velocityDecay(params.velocityDecay)
    .alpha(input.warmStart ? WARM_ALPHA : 1)
    .force(
      "link",
      forceLink<LayoutNode, LinkDatum>(links).distance(params.edgeLength).iterations(1),
    )
    .force(
      "charge",
      forceManyBody<LayoutNode>()
        .strength(-params.chargeStrength)
        .distanceMin(params.collideRadius * 1.2)
        .theta(0.9),
    )
    .force("collide", forceCollide<LayoutNode>(params.collideRadius).strength(0.9).iterations(2))
    .force("topology", (alpha: number) => {
      applyTopologyForce(nodes, topologyForce, params, alpha);
    })
    .force("converge", (alpha: number) => {
      applyCenteringForce(nodes, geometry, params, alpha);
      applyBoundaryForce(nodes, geometry, params, alpha);
    })
    .force("anchor", (alpha: number) => {
      if (previous && params.anchorStrength > 0) {
        applyAnchorForce(nodes, previous, anchorWeights, params, alpha);
      }
    });

  const runtime: LayoutRuntime = {
    topo,
    params,
    nodes,
    geometry,
    topologyPairs: pairs.pairs.length,
    valid: readPositions(nodes),
    iterations: 0,
    rms: Number.POSITIVE_INFINITY,
    stableBatches: 0,
    collisionResidual: 0,
    finite: true,
    simulation,
    scratch: new Float64Array(nodes.length * 3),
  };
  return runtime;
}

/** 推进若干步，并更新位移与碰撞度量（渲染帧率不参与物理计算） */
export function stepLayout(runtime: LayoutRuntime, batch = 1): void {
  const { nodes, scratch } = runtime;
  for (const node of nodes) {
    const i = node.index * 3;
    scratch[i] = node.x;
    scratch[i + 1] = node.y;
    scratch[i + 2] = node.z;
  }

  runtime.simulation.tick(batch);
  runtime.iterations += batch;

  runtime.rms = rmsDisplacement(nodes, scratch, runtime.params.edgeLength);
  runtime.collisionResidual = collisionResidual(nodes, runtime.params.collideRadius);
  runtime.finite = hasFiniteCoordinates(nodes);

  if (runtime.finite) {
    runtime.valid = readPositions(runtime.nodes, runtime.valid);
    if (
      runtime.rms < runtime.params.stableRms &&
      runtime.collisionResidual <= runtime.params.stableCollisionResidual
    ) {
      runtime.stableBatches += 1;
    } else {
      runtime.stableBatches = 0;
    }
  } else {
    // 非有限坐标：回退到上一份有效快照，等 Worker 报告 error
    runtime.stableBatches = 0;
  }
}

/** 把坐标导出到独立数组（写进 out 时复用同一块内存，避免每帧新建） */
export function readPositions(nodes: LayoutNode[], out?: Float32Array): Float32Array {
  const target = out && out.length === nodes.length * 3 ? out : new Float32Array(nodes.length * 3);
  for (const node of nodes) {
    const i = node.index * 3;
    target[i] = node.x;
    target[i + 1] = node.y;
    target[i + 2] = node.z;
  }
  return target;
}

/** 结束判据：位移与碰撞同时达标，并且连续若干批都达标（不看 alpha 是否耗尽） */
export function isSettled(runtime: LayoutRuntime, requiredBatches = 4): boolean {
  return runtime.finite && runtime.stableBatches >= requiredBatches;
}

export function layoutMetrics(runtime: LayoutRuntime, elapsedMs: number): LayoutMetrics {
  return {
    iterations: runtime.iterations,
    rms: runtime.rms,
    collisionResidual: runtime.collisionResidual,
    topologyPairs: runtime.topologyPairs,
    components: runtime.topo.components.length,
    elapsedMs,
  };
}

/** 结束原因：达标 / 用完预算 / 坐标异常 */
export function stopReason(runtime: LayoutRuntime, requiredBatches = 4): LayoutStopReason {
  if (!runtime.finite) return "error";
  if (isSettled(runtime, requiredBatches)) return "stable";
  return "budget";
}
