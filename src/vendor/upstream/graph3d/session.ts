/**
 * 空间视图的会话级缓存
 *
 * 切到二维聚焦再切回来，必须还能认出原来那张图和原来的视角，
 * 所以布局坐标与相机状态都要活过组件卸载。它不属于 Store：
 * 这里只有视图数据，没有任何业务字段，也不写数据库。
 *
 * 失效条件（《空间图谱技术方案》8.3）：
 * - 导入备份 / 整体替换工作区：调用 `dropSpaceCache()` 显式失效；
 * - 节点 ID 顺序变化：按 ID 对齐，认不出的节点坐标用 NaN 占位（当作新点）；
 * - 跨重启缓存：本版不做（需要可靠的工作区身份与代次）。
 */
import type { CameraState, LabelDensity } from "./types.ts";

interface LayoutCache {
  ids: string[];
  positions: Float32Array;
  signature: string;
  /** 这份坐标是否已经收敛：收敛过就不必再跑一轮布局 */
  settled: boolean;
}

let layoutCache: LayoutCache | null = null;
/**
 * 相机缓存。
 *
 * 带一个「存这份相机时布局是否已经收敛」的标记：布局还在形成时相机往往是被
 * **自动取景**摆在那里的（对着还没收敛的初始云团），把它当成「使用者的视角」
 * 恢复回来，会让稀疏小图在中间缩成一小团——而引擎又因为「有相机缓存」不再重新取景，
 * 于是一直错下去（验收清单 P2-4）。未收敛的相机因此不作数，下次进入重新取景。
 */
let cameraCache: { state: CameraState; settled: boolean } | null = null;
let densityCache: LabelDensity = "smart";
/** 工作区代次：显式失效时递增，Worker 用它丢弃旧代次的消息 */
let epoch = 1;

export function spaceEpoch(): number {
  return epoch;
}

export function cachedLayoutSignature(): string | null {
  return layoutCache?.signature ?? null;
}

/**
 * 缓存下来的坐标是否已经收敛，且与当前结构签名一致。
 *
 * 一致并且收敛过，就可以直接沿用坐标、不必再开一个 Worker 跑一轮：
 * 「切到二维再切回来」不是结构变化，重跑只会让节点在镜头没动的情况下挪一下。
 */
export function cachedLayoutReusable(signature: string): boolean {
  return layoutCache !== null && layoutCache.settled && layoutCache.signature === signature;
}

/**
 * 取出与给定 ID 顺序对齐的旧坐标。
 *
 * 认不出的节点写 NaN：Worker 会把它们当作新点重新初始化，
 * 而不是把别的知识点的坐标套上去。完全认不出时返回 null（等于没有缓存）。
 */
export function alignedCachedPositions(ids: string[]): Float32Array | null {
  if (!layoutCache || ids.length === 0) return null;
  const byId = new Map<string, number>();
  layoutCache.ids.forEach((id, index) => byId.set(id, index));
  const out = new Float32Array(ids.length * 3);
  let matched = 0;
  for (let i = 0; i < ids.length; i += 1) {
    const source = byId.get(ids[i]!);
    if (source === undefined) {
      out[i * 3] = Number.NaN;
      out[i * 3 + 1] = Number.NaN;
      out[i * 3 + 2] = Number.NaN;
      continue;
    }
    matched += 1;
    out[i * 3] = layoutCache.positions[source * 3]!;
    out[i * 3 + 1] = layoutCache.positions[source * 3 + 1]!;
    out[i * 3 + 2] = layoutCache.positions[source * 3 + 2]!;
  }
  return matched === 0 ? null : out;
}

export function storeLayout(
  ids: string[],
  positions: Float32Array,
  signature: string,
  settled: boolean,
): void {
  layoutCache = { ids: [...ids], positions: new Float32Array(positions), signature, settled };
}

/** 可沿用的相机：只有「布局已收敛时存下的那一份」才算使用者真正的观看状态 */
export function cachedCamera(): CameraState | null {
  if (!cameraCache || !cameraCache.settled) return null;
  return cloneCamera(cameraCache.state);
}

export function storeCamera(state: CameraState, settled: boolean): void {
  cameraCache = { state: cloneCamera(state), settled };
}

export function cachedLabelDensity(): LabelDensity {
  return densityCache;
}

export function storeLabelDensity(value: LabelDensity): void {
  densityCache = value;
}

/** 只丢布局缓存（「重新整理」用）：相机是使用者的观看状态，不该跟着一起清 */
export function dropLayoutCache(): void {
  layoutCache = null;
}

/** 整体替换数据（导入备份）时调用：位置与相机都作废，避免按旧结构复原 */
export function dropSpaceCache(): void {
  layoutCache = null;
  cameraCache = null;
  epoch += 1;
}

/**
 * 节点集合被完全换掉时（例如换成另一份知识库但没走导入）也让它自然失效：
 * 一个都认不出时，缓存坐标已经没有意义。
 */
export function isLayoutCacheUsable(ids: string[]): boolean {
  if (!layoutCache || ids.length === 0) return false;
  const known = new Set(layoutCache.ids);
  let matched = 0;
  for (const id of ids) if (known.has(id)) matched += 1;
  return matched > 0;
}

function cloneCamera(state: CameraState): CameraState {
  return {
    target: [...state.target],
    distance: state.distance,
    angle: state.angle,
    pitch: state.pitch,
  };
}
