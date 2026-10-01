/**
 * 插件自有的**关系（连线）拾取**：先在相机空间按近裁剪面裁剪线段，再投影命中。
 *
 * 为什么不能用上游 `pickEdge()`（`design/view-navigation-repair-plan.md` P2）：
 * 它只要有一个端点的 `projected.visible === false` 就**整条跳过** ✗ ——
 * 可是 WebGL 画的是真实三维线段，会被 near 平面裁掉一段后**继续显示剩余部分** ✓。
 * 相机进入云团后"一个端点在身后、另一个在身前"是很正常的情形，
 * 于是屏幕上明明画着一条线，悬停/选中/右键却命中空白 ✗。
 *
 * 这里用**同一份有效基向量**把两端换到相机空间：
 * 1. 先按 `NEAR_PLANE` 裁剪线段（两端都在近平面之后 ⇒ 整条不可见，如实返回 null ✓）；
 * 2. 再把裁剪后的两个端点投影到屏幕做线段命中 ✓（与渲染同一套投影，
 *    深度阈值也统一到 `NEAR_PLANE`，避免"画着却点不到"✗）。
 *
 * 上游副本保持冻结：这是插件自己的模块，通过控制器接进拾取路径 ✓。
 */
import type { FreeBasis, Vec3 } from "./trackball.ts";
import { NEAR_PLANE } from "./interior-navigation.ts";

/** 屏幕上的点 */
interface ScreenPoint {
  x: number;
  y: number;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** 把端点从"布局坐标"换到相机空间（x 右、y 上、z = 沿视线深度） */
function toCameraSpace(basis: FreeBasis, point: Vec3): Vec3 {
  const d = sub(point, basis.position);
  return [dot(d, basis.right), dot(d, basis.up), dot(d, basis.forward)];
}

/** 相机空间 → 屏幕（与上游 `projectPoint` 同式 ✓） */
function projectCameraSpace(
  cameraPoint: Vec3,
  viewport: { width: number; height: number },
  fovDeg: number,
): ScreenPoint {
  const depth = cameraPoint[2];
  const focal = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const scaleFactor = (focal * (viewport.height / 2)) / depth;
  return {
    x: viewport.width / 2 + cameraPoint[0] * scaleFactor,
    y: viewport.height / 2 - cameraPoint[1] * scaleFactor,
  };
}

/**
 * 一条边按近裁剪面裁剪后的屏幕线段。
 *
 * @param a - 端点 A（布局坐标）。
 * @param b - 端点 B（布局坐标）。
 * @param basis - 有效基向量（与渲染、投影、抓取同一份 ✓）。
 * @param viewport - 画布尺寸。
 * @param fovDeg - 垂直 FOV。
 * @returns 裁剪后的屏幕端点；整条都在近平面之后 ⇒ null。
 */
export function clippedEdgeSegment(
  a: Vec3,
  b: Vec3,
  basis: FreeBasis,
  viewport: { width: number; height: number },
  fovDeg: number,
): { a: ScreenPoint; b: ScreenPoint } | null {
  let ca = toCameraSpace(basis, a);
  let cb = toCameraSpace(basis, b);
  if (!(ca[2] > NEAR_PLANE) && !(cb[2] > NEAR_PLANE)) return null;
  if (!(ca[2] > NEAR_PLANE) || !(cb[2] > NEAR_PLANE)) {
    /* 一端在前、一端在后 ⇒ 求出与近平面的交点，用交点替换后面那一端 ✓ */
    const denominator = cb[2] - ca[2];
    const t = Math.abs(denominator) < 1e-9 ? 0 : (NEAR_PLANE - ca[2]) / denominator;
    const crossing = add(ca, scale(sub(cb, ca), Math.min(1, Math.max(0, t))));
    crossing[2] = NEAR_PLANE;
    if (ca[2] > NEAR_PLANE) cb = crossing;
    else ca = crossing;
  }
  return {
    a: projectCameraSpace(ca, viewport, fovDeg),
    b: projectCameraSpace(cb, viewport, fovDeg),
  };
}

/** 点到线段的距离（像素） */
function distanceToSegment(px: number, py: number, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 1e-9) return Math.hypot(px - a.x, py - a.y);
  const t = Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / lengthSq));
  return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
}

/**
 * 命中哪条关系。
 *
 * 与上游的差别：**不再因为某个端点不可见就跳过整条边** ✓——
 * 而是用裁剪后仍可见的那一段参与命中（这正是"球内看得见却点不到"的修法）。
 * 重叠时按"屏幕距离更近"取胜；距离相同（理论上不会）保持先出现的 ✓。
 *
 * @param positions - 节点坐标（xyz 连续）。
 * @param edges - 边（`{from, to}` 下标，与 positions 同一套）。
 * @param basis - 有效基向量。
 * @param viewport - 画布尺寸。
 * @param fovDeg - 垂直 FOV。
 * @param x - 光标 x（画布内）。
 * @param y - 光标 y（画布内）。
 * @param tolerance - 命中带宽（像素）。
 * @returns 边下标；没命中 ⇒ null。
 */
export function pickClippedEdge(
  positions: Float32Array,
  edges: ReadonlyArray<{ from: number; to: number }>,
  basis: FreeBasis,
  viewport: { width: number; height: number },
  fovDeg: number,
  x: number,
  y: number,
  tolerance = 6,
): number | null {
  const pointOf = (index: number): Vec3 | null => {
    const px = positions[index * 3];
    const py = positions[index * 3 + 1];
    const pz = positions[index * 3 + 2];
    if (px === undefined || py === undefined || pz === undefined) return null;
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return null;
    return [px, py, pz];
  };
  let best: number | null = null;
  let bestDistance = tolerance;
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    if (edge === undefined) continue;
    const a = pointOf(edge.from);
    const b = pointOf(edge.to);
    if (a === null || b === null) continue;
    const segment = clippedEdgeSegment(a, b, basis, viewport, fovDeg);
    if (segment === null) continue;
    const distance = distanceToSegment(x, y, segment.a, segment.b);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}
