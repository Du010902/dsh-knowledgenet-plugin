/**
 * 相机与投影（纯计算）
 *
 * 与 three 的 PerspectiveCamera 保持一致（垂直 FOV、aspect = W/H），
 * 因此标签层、拾取与错误提示用的屏幕坐标和 WebGL 画出来的是同一套；
 * 单元测试会直接拿 three 的投影矩阵对照，避免「标签和节点差几个像素」这种
 * 只能靠肉眼发现的问题。
 *
 * 约定：
 * - 世界竖直方向永远是 +Y，不做滚转（roll）；
 * - 俯仰限制在接近但不到 ±90°，避免视线与世界向上方向共线；
 * - near/far 由实际尺度算出，不用 near≈0、far=∞ 掩盖裁剪问题。
 */
import type {
  CameraBasis,
  CameraState,
  ProjectedNode,
  Vec3,
  Viewport,
} from "./types.ts";

/** 俯仰上限（弧度）：约 83°，抬头低头都能看，但不会翻过去 */
export const PITCH_LIMIT = 1.45;
/** 近裁剪面：世界单位，比最小的节点半径还小 */
export const NEAR_PLANE = 0.35;

export const WORLD_UP: Vec3 = [0, 1, 0];

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clampPitch(pitch: number): number {
  return clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < 1e-9) return [0, 0, -1];
  return [a[0] / len, a[1] / len, a[2] / len];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}


/** 由 forward 推出 right/up：保持世界竖直方向，不产生滚转 */
export function basisFromForward(position: Vec3, forward: Vec3): CameraBasis {
  const f = normalize(forward);
  let right = cross(f, WORLD_UP);
  if (length(right) < 1e-6) right = [1, 0, 0]; // 正上/正下看时给一个稳定约定
  right = normalize(right);
  const up = normalize(cross(right, f));
  return { position, forward: f, right, up };
}

/** 环绕观察的相机基向量：位置由 target / distance / angle / pitch 决定 */
export function orbitBasis(state: CameraState): CameraBasis {
  const cosPitch = Math.cos(state.pitch);
  const offset: Vec3 = [
    state.distance * cosPitch * Math.sin(state.angle),
    state.distance * Math.sin(state.pitch),
    state.distance * cosPitch * Math.cos(state.angle),
  ];
  const position = add(state.target, offset);
  return basisFromForward(position, scale(offset, -1));
}

/* ------------------------------- 投影与拾取 ------------------------------- */

function focalLength(fovDeg: number): number {
  return 1 / Math.tan((fovDeg * Math.PI) / 360);
}

/**
 * 把世界坐标投影到 CSS 像素。
 *
 * 与 three 的透视投影同式：屏幕半径按深度缩放，就是「前大后小」的真实来源，
 * 不通过重排节点伪造深度。
 */
export function projectPoint(
  point: Vec3,
  basis: CameraBasis,
  viewport: Viewport,
  fovDeg: number,
  out?: { x: number; y: number; depth: number; scale: number },
): { x: number; y: number; depth: number; scale: number } | null {
  const d = sub(point, basis.position);
  const depth = dot(d, basis.forward);
  if (depth <= NEAR_PLANE) {
    if (out) {
      out.x = 0;
      out.y = 0;
      out.depth = depth;
      out.scale = 0;
    }
    return null;
  }
  const f = focalLength(fovDeg);
  const halfHeight = viewport.height / 2;
  const scaleFactor = (f * halfHeight) / depth;
  const result = out ?? { x: 0, y: 0, depth: 0, scale: 0 };
  result.x = viewport.width / 2 + dot(d, basis.right) * scaleFactor;
  result.y = viewport.height / 2 - dot(d, basis.up) * scaleFactor;
  result.depth = depth;
  result.scale = scaleFactor;
  return result;
}

/**
 * 节点投影半径的上下限（CSS 像素）。
 *
 * 与渲染器用的是同一对数字（`design/workbench-ui-reference.html` 的
 * `Math.max(2.6, Math.min(22, node.r * scale))`）：标签位置、拾取范围与
 * 真正画出来的球必须按同一个半径算，否则名字会飘在球外面几个像素。
 */
export const NODE_MIN_PIXELS = 2.6;
export const NODE_MAX_PIXELS = 22;

/** 一帧内全部节点的屏幕投影：标签、拾取、箭头共用这一份结果 */
export function projectNodes(
  positions: Float32Array,
  radii: Float32Array,
  ids: string[],
  basis: CameraBasis,
  viewport: Viewport,
  fovDeg: number,
  out?: ProjectedNode[],
): ProjectedNode[] {
  const count = ids.length;
  const list: ProjectedNode[] = out && out.length === count ? out : new Array(count);
  for (let i = 0; i < count; i += 1) {
    const point: Vec3 = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    const projected = projectPoint(point, basis, viewport, fovDeg);
    const radius = projected
      ? clamp(radii[i]! * projected.scale, NODE_MIN_PIXELS, NODE_MAX_PIXELS)
      : 0;
    const existing = list[i];
    if (existing) {
      existing.index = i;
      existing.id = ids[i]!;
      existing.x = projected ? projected.x : 0;
      existing.y = projected ? projected.y : 0;
      existing.depth = projected ? projected.depth : 0;
      existing.radius = radius;
      existing.visible = projected !== null;
    } else {
      list[i] = {
        index: i,
        id: ids[i]!,
        x: projected ? projected.x : 0,
        y: projected ? projected.y : 0,
        depth: projected ? projected.depth : 0,
        radius,
        visible: projected !== null,
      };
    }
  }
  return list;
}

/**
 * 屏幕空间拾取。
 *
 * 按 canvas 的 CSS 像素命中，不把 DPR 像素当 CSS 像素；
 * 命中半径给一点余量（参考图是 `Math.max(11, radius + 5)`），
 * 重叠时优先更近的那个节点（避免远处不可见节点抢走点击）。
 */
export function pickNode(
  projected: ProjectedNode[],
  x: number,
  y: number,
  minHitRadius = 11,
): number | null {
  let hit: number | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const node of projected) {
    if (!node.visible) continue;
    const distance = Math.hypot(x - node.x, y - node.y);
    if (distance > Math.max(minHitRadius, node.radius + 5)) continue;
    if (node.depth < bestDepth) {
      bestDepth = node.depth;
      hit = node.index;
    }
  }
  return hit;
}

/**
 * 屏幕空间拾取一条**关系（连线）**。
 *
 * 与节点拾取同一套口径：都用同一帧的投影结果、都按 CSS 像素命中。
 * 区别在于判据是「点到线段的距离」而不是点距——线本身只有 1–2px 宽，
 * 因此给一个明确的命中带宽（默认 10px，与节点命中半径同量级）。
 *
 * 三条纪律：
 * - 任一端点在相机后方或视野外（`!visible`）就跳过：那截线段在屏幕上不存在；
 * - 重叠时取**两端平均深度更近**的那条，避免远处的线穿过近处的东西还能被点到；
 * - 参数只要求 `{from, to}` 的下标结构，不 import adapter 的 `SpaceEdge`，
 *   拾取逻辑因此可以脱离三维数据层单独测试。
 */
export function pickEdge(
  projected: ProjectedNode[],
  edges: ReadonlyArray<{ from: number; to: number }>,
  x: number,
  y: number,
  threshold = 10,
): number | null {
  let hit: number | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index]!;
    const a = projected[edge.from];
    const b = projected[edge.to];
    if (!a || !b || !a.visible || !b.visible) continue;
    const distance = distanceToSegment(x, y, a.x, a.y, b.x, b.y);
    if (distance > threshold) continue;
    const depth = (a.depth + b.depth) / 2;
    if (depth < bestDepth) {
      bestDepth = depth;
      hit = index;
    }
  }
  return hit;
}

/** 点到线段的最短距离（线段退化成一个点时退化为点距） */
function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-9) return Math.hypot(px - ax, py - ay);
  // 投影参数夹到 [0,1]：垂足落在线段外时必须取端点，否则会命中"延长线上的假点"
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/* ------------------------------- 包围体与取景 ------------------------------- */

export interface Bounds {
  center: Vec3;
  radius: number;
  /** 各轴最小/最大值，供「适应窗口」与调试使用 */
  min: Vec3;
  max: Vec3;
}

export function boundsOf(positions: Float32Array, count: number): Bounds {
  if (count === 0 || positions.length < count * 3) {
    return { center: [0, 0, 0], radius: 20, min: [0, 0, 0], max: [0, 0, 0] };
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i * 3 + axis]!;
      if (!Number.isFinite(value)) continue;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  if (!Number.isFinite(min[0]!)) return { center: [0, 0, 0], radius: 20, min: [0, 0, 0], max: [0, 0, 0] };
  const center: Vec3 = [
    (min[0]! + max[0]!) / 2,
    (min[1]! + max[1]!) / 2,
    (min[2]! + max[2]!) / 2,
  ];
  let radius = 20;
  for (let i = 0; i < count; i += 1) {
    const dx = positions[i * 3]! - center[0];
    const dy = positions[i * 3 + 1]! - center[1];
    const dz = positions[i * 3 + 2]! - center[2];
    const distance = Math.hypot(dx, dy, dz);
    if (Number.isFinite(distance) && distance > radius) radius = distance;
  }
  return { center, radius, min, max };
}

/**
 * 「适应窗口」的相机距离。
 *
 * 按实际 canvas 的横纵 FOV 取更紧的一侧，并留出浮层边距（insets），
 * 因此窗口变扁、工具栏变高都不会把节点顶出画面——不沿用二维缩放下限那套。
 *
 * 再加一条**最小屏幕占比**约束（验收清单 P2-4）：包围球直径至少要占画布短边
 * `MIN_COVERAGE`。几何取景本身与半径成正比，正常情况下这条约束不会生效；
 * 它的作用是兜住「缓存相机来自一张更大的图」这类情况——那时云团会缩成中间一小团，
 * 看起来像图没加载完整。
 */
export const MIN_COVERAGE = 0.3;

export function fitDistance(
  radius: number,
  viewport: Viewport,
  fovDeg: number,
  insets: { top: number; bottom: number; left?: number; right?: number } = { top: 0, bottom: 0 },
): number {
  if (!Number.isFinite(radius) || radius <= 0) return 200;
  const top = insets.top ?? 0;
  const bottom = insets.bottom ?? 0;
  const left = insets.left ?? 0;
  const right = insets.right ?? 0;
  const usableHeight = Math.max(80, viewport.height - top - bottom);
  const usableWidth = Math.max(80, viewport.width - left - right);
  const tanHalfV = Math.tan((fovDeg * Math.PI) / 360);
  // 垂直方向按可用高度收缩，水平方向还要乘上可用宽高比
  const tanHalfEffectiveV = tanHalfV * (usableHeight / Math.max(1, viewport.height));
  const tanHalfEffectiveH = tanHalfV * (usableWidth / Math.max(1, viewport.height));
  const half = Math.min(Math.atan(tanHalfEffectiveV), Math.atan(tanHalfEffectiveH));
  const geometric = radius / Math.sin(Math.max(0.05, half));
  /*
   * 投影直径 / 画布短边 = radius × focal / distance（推导：投影半径 = radius × focal × H / (2d)），
   * 因此「占比不低于 MIN_COVERAGE」等价于 distance ≤ radius × focal / MIN_COVERAGE。
   */
  const focal = 1 / tanHalfV;
  const maxForCoverage = (radius * focal) / MIN_COVERAGE;
  return Math.min(geometric, maxForCoverage);
}

/** 相机位置的合理边界：不锁死最小距离（允许进入云团内部），但要防止跑到无穷远 */
export function clampCameraDistance(distance: number, radius: number): number {
  return clamp(distance, 6, radius * 14 + 600);
}
