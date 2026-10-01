/**
 * 空间图谱的**内部导航**：固定球心 C + 相机位置 P + 视角姿态 Q + 图谱旋转 S。
 *
 * 依 `design/knowledgenet-interior-navigation.md` 实现。为什么换模型（而不是继续修符号）：
 * 上游把"相机在哪"和"绕谁转"绑在同一个轨道表示上（`target` + `distance` + 欧拉姿态），
 * 于是**绕心旋转**时不同深度的节点屏幕位移符号不同（`Δ ∝ Z/(D−Z)`），
 * 球背面必然反向 —— 那是几何事实，不是符号写错；把滚轮改成"移动相机"、把拖动改成
 * "抓取点投影约束求解"才能让**正在抓取的那一块**始终跟手 ✓。
 *
 * 三个量彻底分开：
 * - `C`（center）：固定旋转中心，取稳定布局的包围体中心；用户开始操作后冻结，只有明确
 *   「重新整理 / 换库」才换 ✓；
 * - `P`（eye）：相机在**显示世界**里的位置；**滚轮只改它**（沿视线前进后退，可以穿过 C）✓；
 * - `Q`（view）：相机完整姿态（含滚转）；右/上/前轴都由它给出，不靠固定世界上方向 ✓；
 * - `S`（scene）：图谱绕 C 的整体旋转；**拖动只改它** ✓。
 *
 * 渲染/投影/拾取全部沿用上游对**布局坐标**的做法，靠"等效相机基向量"把 S 折进去：
 * `P_eff = C + S⁻¹(P − C)`，三条轴 = `S⁻¹ · Q 的轴`。
 * 于是"布局点 X 用 P_eff 投影" ≡ "显示点 `C + S(X−C)` 用 P 投影" ✓（点积在旋转下不变），
 * 现有渲染器、标签、连线与拾取**一行都不用改** ✓。
 */
import {
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  rotateVec,
  type FreeBasis,
  type Quat,
  type Vec3,
} from "./trackball.ts";

/* ------------------------------ 向量与四元数 ------------------------------ */

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => {
  const len = length(a) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
};
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));
const clampNum = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** 共轭 = 逆（单位四元数） */
export function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/**
 * 四元数球面插值（姿态动画用）。
 * @param a - 起点姿态。
 * @param b - 终点姿态。
 * @param t - 0~1。
 * @returns 插值姿态（最短弧，`dot < 0` 时先取反避免绕远路）。
 */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let target = b;
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (cos < 0) {
    target = [-b[0], -b[1], -b[2], -b[3]];
    cos = -cos;
  }
  if (cos > 0.9995) {
    return quatNormalize([
      a[0] + (target[0] - a[0]) * t,
      a[1] + (target[1] - a[1]) * t,
      a[2] + (target[2] - a[2]) * t,
      a[3] + (target[3] - a[3]) * t,
    ]);
  }
  const theta = Math.acos(clampNum(cos, -1, 1));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return quatNormalize([
    a[0] * wa + target[0] * wb,
    a[1] * wa + target[1] * wb,
    a[2] * wa + target[2] * wb,
    a[3] * wa + target[3] * wb,
  ]);
}

/** 由"看向 dir"构造姿态（保留参考上方向的滚转尽量小；极点处回退到世界 Z） */
export function quatLookAt(forward: Vec3, referenceUp: Vec3 = [0, 1, 0]): Quat {
  const f = normalize(forward);
  let up = referenceUp;
  if (Math.abs(dot(f, normalize(up))) > 0.999) up = [0, 0, 1];
  const right = normalize([f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]]);
  const realUp: Vec3 = [
    right[1] * f[2] - right[2] * f[1],
    right[2] * f[0] - right[0] * f[2],
    right[0] * f[1] - right[1] * f[0],
  ];
  /* 基矩阵 [right, realUp, -forward] ⇒ 四元数（Shepperd 分支） */
  const m00 = right[0], m01 = realUp[0], m02 = -f[0];
  const m10 = right[1], m11 = realUp[1], m12 = -f[1];
  const m20 = right[2], m21 = realUp[2], m22 = -f[2];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return quatNormalize([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]);
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return quatNormalize([s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return quatNormalize([(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]);
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return quatNormalize([(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]);
}

/* --------------------------------- 状态 --------------------------------- */

/** 导航状态：固定球心 C、相机位置 P、视角 Q、图谱旋转 S */
export interface InteriorState {
  /** C：固定旋转中心（布局坐标） */
  center: Vec3;
  /** P：相机位置（显示世界） */
  eye: Vec3;
  /** Q：相机姿态（显示世界） */
  view: Quat;
  /** S：图谱绕 C 的整体旋转 */
  scene: Quat;
  /** 操作包围球半径（拖动期间冻结） */
  radius: number;
}

/** 显示世界的相机基向量（P + Q 的三条轴） */
export function displayBasis(state: InteriorState): FreeBasis {
  return {
    position: state.eye,
    forward: rotateVec(state.view, [0, 0, -1]),
    right: rotateVec(state.view, [1, 0, 0]),
    up: rotateVec(state.view, [0, 1, 0]),
  };
}

/**
 * 给渲染/投影/拾取用的**等效相机基向量**（布局坐标系）。
 *
 * 布局点 X 用这份基投影 ≡ 显示点 `C + S(X−C)` 用 `displayBasis` 投影 ✓
 * —— 所以现有渲染器与拾取可以完全不动 ✓。
 */
export function effectiveBasis(state: InteriorState): FreeBasis {
  const inverse = quatConjugate(state.scene);
  const display = displayBasis(state);
  return {
    position: add(state.center, rotateVec(inverse, sub(state.eye, state.center))),
    forward: rotateVec(inverse, display.forward),
    right: rotateVec(inverse, display.right),
    up: rotateVec(inverse, display.up),
  };
}

/** 布局坐标 → 显示坐标：`Xdisplay = C + S(X − C)` */
export function displayOf(state: InteriorState, point: Vec3): Vec3 {
  return add(state.center, rotateVec(state.scene, sub(point, state.center)));
}

/** 显示坐标 → 布局坐标（反投影锚点用）：`X = C + S⁻¹(A − C)` */
export function layoutOf(state: InteriorState, point: Vec3): Vec3 {
  return add(state.center, rotateVec(quatConjugate(state.scene), sub(point, state.center)));
}

/* --------------------------------- 投影 --------------------------------- */

/**
 * 相机空间的**近裁剪距离**：与上游 `projectPoint()` 的 `NEAR_PLANE` 保持一致 ✓。
 *
 * 文档 P2：我们自己曾用 1e-6、上游用 0.35 —— 两套阈值会让"渲染可见"与"能被拾取"错位
 * （近处的内容画着却点不到 ✗）。投影、抓取、线段拾取现在共用这一个 ✓。
 */
export const NEAR_PLANE = 0.35;

/** 像素级投影（与上游 `projectPoint` 同式；这里自带一份，保持本模块可独立测试） */
export function projectDisplay(
  state: InteriorState,
  viewport: { width: number; height: number },
  fovDeg: number,
  point: Vec3,
): { x: number; y: number; depth: number } | null {
  const basis = displayBasis(state);
  const d = sub(point, basis.position);
  const depth = dot(d, basis.forward);
  if (!(depth > NEAR_PLANE)) return null;
  const focal = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const scaleFactor = (focal * (viewport.height / 2)) / depth;
  return {
    x: viewport.width / 2 + dot(d, basis.right) * scaleFactor,
    y: viewport.height / 2 - dot(d, basis.up) * scaleFactor,
    depth,
  };
}

/** 从相机出发、穿过光标（画布内坐标）的射线（显示世界，方向已归一化） */
export function cursorRay(
  state: InteriorState,
  viewport: { width: number; height: number },
  fovDeg: number,
  x: number,
  y: number,
): { origin: Vec3; direction: Vec3 } {
  const basis = displayBasis(state);
  const width = viewport.width > 0 ? viewport.width : 1;
  const height = viewport.height > 0 ? viewport.height : 1;
  const ndcX = (x / width) * 2 - 1;
  const ndcY = 1 - (y / height) * 2;
  const tanHalfV = Math.tan((fovDeg * Math.PI) / 360);
  const tanHalfH = tanHalfV * (width / height);
  return {
    origin: basis.position,
    direction: normalize(add(
      add(basis.forward, scale(basis.right, ndcX * tanHalfH)),
      scale(basis.up, ndcY * tanHalfV),
    )),
  };
}

/* ------------------------------- 抓取点锚定 ------------------------------- */

/** 一次拖动的抓取锚点：布局坐标（整次拖动期间固定） */
export interface GrabAnchor {
  /** 锚点在**布局**坐标里的位置 */
  layout: Vec3;
  /** 建立锚点那一刻的显示坐标 */
  display: Vec3;
  /** 建立时的屏幕位置（像素，用于算"跟手"误差） */
  screen: { x: number; y: number };
}

/**
 * 从投影结果里挑"光标下的节点"，并反投影出它的**布局坐标**。
 *
 * 反投影：`A = P + right·((x − w/2)/scale) + up·((h/2 − y)/scale) + forward·depth`，
 * 再由 `X = C + S⁻¹(A − C)` 回到布局坐标 ✓（这样不需要把 positions 数组传进导航层）。
 *
 * 重叠时用**最近深度**（不是只比屏幕距离）——与上游拾取一致 ✓。
 *
 * @param state - 导航状态。
 * @param viewport - 画布尺寸（CSS 像素）。
 * @param fovDeg - 垂直 FOV（度）。
 * @param projected - 上游 `getProjected()` 的结果。
 * @param x - 光标 x（画布内）。
 * @param y - 光标 y（画布内）。
 * @returns 锚点；光标不在任何可见节点上 ⇒ null。
 */
export function anchorFromProjected(
  state: InteriorState,
  viewport: { width: number; height: number },
  fovDeg: number,
  projected: ReadonlyArray<{ x: number; y: number; depth: number; radius: number; visible: boolean }>,
  x: number,
  y: number,
  slack = 10,
): GrabAnchor | null {
  let best: { node: (typeof projected)[number]; distance: number } | null = null;
  for (const node of projected) {
    if (!node.visible || !(node.depth > 0) || !(node.radius > 0)) continue;
    const distance = Math.hypot(node.x - x, node.y - y);
    if (distance > node.radius + slack) continue;
    /* 最近深度优先；深度相同再比屏幕距离 ✓ */
    if (best === null || node.depth < best.node.depth - 1e-6
      || (Math.abs(node.depth - best.node.depth) <= 1e-6 && distance < best.distance)) {
      best = { node, distance };
    }
  }
  if (best === null) return null;
  const basis = displayBasis(state);
  const focal = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const scaleFactor = (focal * (viewport.height / 2)) / best.node.depth;
  const display = add(
    add(basis.position, scale(basis.right, (best.node.x - viewport.width / 2) / scaleFactor)),
    add(scale(basis.up, (viewport.height / 2 - best.node.y) / scaleFactor), scale(basis.forward, best.node.depth)),
  );
  return { layout: layoutOf(state, display), display, screen: { x: best.node.x, y: best.node.y } };
}

/**
 * 空白拖动：光标射线 ∩ 操作包围球（球心 C、半径 `state.radius`，整次拖动期间固定）。
 *
 * - 相机在球**外** ⇒ 取最近的正交点（近侧内壁）；
 * - 相机在球**内** ⇒ 取前方退出交点（内壁）✓；
 * - 指针偏离球的屏幕轮廓 ⇒ 把光标**夹到轮廓上**再求交（虚拟抓取点），
 *   避免"点在球外就完全没有旋转杠杆" ✗。
 *
 * @returns 锚点；无解（半径非法）⇒ null。
 */
export function anchorFromRay(
  state: InteriorState,
  viewport: { width: number; height: number },
  fovDeg: number,
  x: number,
  y: number,
): GrabAnchor | null {
  const radius = state.radius;
  if (!(radius > 0)) return null;
  const basis = displayBasis(state);
  /* 先把光标夹进球的屏幕轮廓（球心投影 ± 屏幕半径）✓ */
  const centerScreen = projectDisplay(state, viewport, fovDeg, state.center);
  let px = x;
  let py = y;
  if (centerScreen !== null) {
    const focal = 1 / Math.tan((fovDeg * Math.PI) / 360);
    const silhouette = (focal * (viewport.height / 2) * radius) / Math.max(1e-6, centerScreen.depth);
    const dx = x - centerScreen.x;
    const dy = y - centerScreen.y;
    const distance = Math.hypot(dx, dy);
    if (distance > silhouette && distance > 1e-6) {
      px = centerScreen.x + (dx / distance) * silhouette;
      py = centerScreen.y + (dy / distance) * silhouette;
    }
  }
  const ray = cursorRay(state, viewport, fovDeg, px, py);
  const toCenter = sub(ray.origin, state.center);
  const b = 2 * dot(toCenter, ray.direction);
  const c = dot(toCenter, toCenter) - radius * radius;
  const disc = b * b - 4 * c;
  if (!(disc >= 0)) return null;
  const root = Math.sqrt(disc);
  /*
   * **两个根都算出来，统一按前向距离阈值取最小有效根**（文档 P2）。
   *
   * 以前按 `c < 0`（球内/球外）二选一 ✗，于是"相机**恰好站在球面上**朝球内看"时：
   * 较小根正好是 0（就是脚下那个点），被 `t > 0` 丢掉，而较大的那个根才是前方内壁 ⇒ 直接返回 null ✗
   * —— 空白拖动整次失效。现在不再让根的符号决定唯一候选 ✓：
   * - 前向阈值用 `NEAR_PLANE`（与投影近裁剪一致 ✓），比它更近的交点等于"贴在相机上"，不算抓取点；
   * - **朝外看**（相机在球外/球面上、视线背离球体）时两个根都不在前方 ⇒ 返回 null（如实报告没有前方交点 ✓）；
   * - 相机在球内时较小根为负、较大根为正 ⇒ 自动选中前方内壁 ✓。
   */
  const near = Math.min((-b - root) / 2, (-b + root) / 2);
  const far = Math.max((-b - root) / 2, (-b + root) / 2);
  const forward = [near, far].find((candidate) => candidate > NEAR_PLANE);
  if (forward === undefined) return null;
  const display = add(ray.origin, scale(ray.direction, forward));
  const screen = projectDisplay(state, viewport, fovDeg, display);
  return {
    layout: layoutOf(state, display),
    display,
    screen: screen === null ? { x: px, y: py } : { x: screen.x, y: screen.y },
  };
}

/**
 * 抓取点离球心够远吗（有旋转杠杆吗）？
 *
 * 锚点贴着 C 时杠杆趋近 0：要让它在屏幕上挪 1px 需要巨大的转角 ⇒
 * 解会被限幅、看起来"拖不动"✗（文档也要求这种情况改用虚拟球面锚点 ✓）。
 *
 * @param state - 导航状态（用 `radius` 定阈值）。
 * @param anchor - 待检查的锚点。
 * @returns 杠杆是否足够。
 */
export function hasLever(state: InteriorState, anchor: GrabAnchor): boolean {
  const lever = length(sub(anchor.layout, state.center));
  const threshold = Math.max(10, state.radius * 0.15);
  return lever >= threshold;
}

/**
 * 建立抓取点：**节点优先，其次球面**（文档 §拖动旋转算法）——但节点杠杆不足时改用球面 ✓。
 *
 * @param state - 导航状态。
 * @param viewport - 画布尺寸。
 * @param fovDeg - 垂直 FOV。
 * @param projected - 上游 `getProjected()` 的结果。
 * @param x - 光标 x（画布内）。
 * @param y - 光标 y（画布内）。
 * @returns 抓取点；都没有解 ⇒ null。
 */
export function grabAnchor(
  state: InteriorState,
  viewport: { width: number; height: number },
  fovDeg: number,
  projected: ReadonlyArray<{ x: number; y: number; depth: number; radius: number; visible: boolean }>,
  x: number,
  y: number,
): GrabAnchor | null {
  const node = anchorFromProjected(state, viewport, fovDeg, projected, x, y);
  if (node !== null && hasLever(state, node)) return node;
  /* 球面（虚拟）抓取点：杠杆充足，且与"抓住球壳"的手感一致 ✓ */
  const wall = anchorFromRay(state, viewport, fovDeg, x, y);
  if (wall !== null) return wall;
  return node; /* 连球面都没解（半径非法）时才退回节点 ✓ */
}

/* ------------------------------ 拖动求解（J） ------------------------------ */

/** 一次求解的结果 */
export interface DragSolution {
  /** 世界（显示）坐标系下、绕屏幕右/上轴的增量旋转 */
  delta: Quat;
  /** 求解出的两个角度（弧度）：[绕右轴, 绕上轴] */
  angles: { right: number; up: number };
  /** 线性化矩阵是否接近奇异（此时只做限幅更新） */
  singular: boolean;
}

/**
 * 抓取点投影约束求解（文档 §拖动旋转算法）：
 *
 * 1. 锚点显示坐标 `A`；以相机**右轴/上轴**为两个自由度，
 *    对 `A − C` 施加小角度旋转后投影回屏幕 ⇒ 得到 2×2 雅可比 `J`（中心差分）；
 * 2. 解 `θ = (JᵀJ + λI)⁻¹ Jᵀ u`（`u` = 本帧鼠标增量，像素）；
 * 3. 合成绕右轴、上轴的增量四元数 `Δ`；限幅后返回，调用方做 `S ← Δ × S` ✓。
 *
 * 这样**不需要**按"相机在球内还是球外"整体取反符号：近侧/远侧各自的方向由投影自动给出 ✓。
 *
 * @param state - 当前状态（只读）。
 * @param viewport - 画布尺寸。
 * @param fovDeg - 垂直 FOV。
 * @param anchor - 抓取点（显示坐标）。
 * @param dx - 本帧鼠标水平增量（像素）。
 * @param dy - 本帧鼠标垂直增量（像素）。
 * @param maxAngle - 单步限幅（弧度）。
 * @returns 增量旋转；锚点退化（贴住 C）⇒ `delta` 为单位四元数且 `singular: true`。
 */
export function solveDrag(
  state: InteriorState,
  viewport: { width: number; height: number },
  fovDeg: number,
  anchor: Vec3,
  dx: number,
  dy: number,
  maxAngle = 0.12,
): DragSolution {
  const basis = displayBasis(state);
  const lever = sub(anchor, state.center);
  const identity: Quat = [0, 0, 0, 1];
  /* 锚点几乎贴在球心上时没有旋转杠杆 ⇒ 交给调用方换虚拟球面锚点 ✓ */
  if (length(lever) < 1e-3) return { delta: identity, angles: { right: 0, up: 0 }, singular: true };

  const project = (point: Vec3): { x: number; y: number } | null => {
    const projected = projectDisplay(state, viewport, fovDeg, point);
    return projected === null ? null : { x: projected.x, y: projected.y };
  };
  const at = (rightAngle: number, upAngle: number): { x: number; y: number } | null => {
    const rotated = rotateVec(
      quatMultiply(
        quatFromAxisAngle(basis.up, upAngle),
        quatFromAxisAngle(basis.right, rightAngle),
      ),
      lever,
    );
    return project(add(state.center, rotated));
  };

  const epsilon = 1e-3; /* 差分角：只属于数值精度，不是用户灵敏度 ✓ */
  const base = at(0, 0);
  if (base === null) return { delta: identity, angles: { right: 0, up: 0 }, singular: true };
  const alongRight = at(epsilon, 0) ?? base;
  const alongUp = at(0, epsilon) ?? base;
  const j00 = (alongRight.x - base.x) / epsilon;
  const j10 = (alongRight.y - base.y) / epsilon;
  const j01 = (alongUp.x - base.x) / epsilon;
  const j11 = (alongUp.y - base.y) / epsilon;

  /* (JᵀJ + λI)，λ 按 J 的尺度取，避免量纲差 ⇒ 奇异时退化为小步 ✓ */
  const a11 = j00 * j00 + j10 * j10;
  const a12 = j00 * j01 + j10 * j11;
  const a22 = j01 * j01 + j11 * j11;
  const lambda = Math.max(1e-6, (a11 + a22) * 1e-3);
  const m11 = a11 + lambda;
  const m22 = a22 + lambda;
  const det = m11 * m22 - a12 * a12;
  const singular = !(Math.abs(det) > 1e-12);
  let thetaRight = 0;
  let thetaUp = 0;
  if (!singular) {
    /* θ = (JᵀJ + λI)⁻¹ Jᵀu，其中 Jᵀu = [j00·dx + j10·dy, j01·dx + j11·dy] */
    const r1 = j00 * dx + j10 * dy;
    const r2 = j01 * dx + j11 * dy;
    thetaRight = (m22 * r1 - a12 * r2) / det;
    thetaUp = (-a12 * r1 + m11 * r2) / det;
  } else {
    /* 只沿最大尺度方向走一步，不放大误差、不突然换符号 ✓ */
    const normRight = Math.hypot(j00, j10);
    const normUp = Math.hypot(j01, j11);
    if (normRight >= normUp && normRight > 1e-9) thetaRight = (j00 * dx + j10 * dy) / (a11 + lambda);
    else if (normUp > 1e-9) thetaUp = (j01 * dx + j11 * dy) / (a22 + lambda);
  }
  const magnitude = Math.hypot(thetaRight, thetaUp);
  if (magnitude > maxAngle) {
    const k = maxAngle / magnitude;
    thetaRight *= k;
    thetaUp *= k;
  }
  const delta = quatNormalize(quatMultiply(
    quatFromAxisAngle(basis.up, thetaUp),
    quatFromAxisAngle(basis.right, thetaRight),
  ));
  return { delta, angles: { right: thetaRight, up: thetaUp }, singular };
}

/** 把增量旋转作用到图谱旋转上：`S ← Δ × S` ✓ */
export function applySceneRotation(state: InteriorState, delta: Quat): void {
  state.scene = quatNormalize(quatMultiply(delta, state.scene));
}

/** 一次拖动求解的选项 */
export interface DragOptions {
  /** 单步限幅（弧度）：求解超过它就缩短，再迭代追赶 ✓ */
  maxAngle?: number;
  /** 迭代上限（限幅后需要多解几次才能跟上指针） */
  maxIterations?: number;
  /** 认为"跟上了"的像素误差 */
  tolerance?: number;
}

/** 求解 + 迭代追赶的结果 */
export interface DragResult {
  /** 实际迭代了几次（0 表示锚点一开始就在目标位置） */
  iterations: number;
  /** 停止时的像素残差 */
  error: number;
  /** 锚点掉到相机后方/退化 ⇒ 调用方应结束这次抓取 ✓ */
  lost: boolean;
}

/**
 * 把抓取点拖到指针处（文档 §拖动旋转算法 的 3~5 步）：
 * 反复"求解 → 限幅应用 → 复算误差"，直到锚点投影落到目标屏幕位置 ✓。
 *
 * 为什么要迭代：单步限幅会截断解（深度很大的锚点杠杆小、需要的角度大），
 * 只解一次会出现"跟不上一大段"的滞后 ✗；迭代几次就能追上，而单帧的角速度仍然被限住 ✓
 * （**不**用"球内/球外整体取反符号"这种补丁：近侧远侧的方向由投影自动给出 ✓）。
 *
 * @param state - 就地更新 `scene`。
 * @param viewport - 画布尺寸。
 * @param fovDeg - 垂直 FOV。
 * @param layoutAnchor - 抓取点的**布局**坐标（整次拖动期间不变）。
 * @param target - 指针希望锚点到达的屏幕位置（像素）。
 * @param options - 限幅/迭代参数。
 * @returns 迭代次数与最终残差（像素）；退化位形 ⇒ 提前结束且不产生 NaN ✓。
 */
export function dragAnchorTo(
  state: InteriorState,
  viewport: { width: number; height: number },
  fovDeg: number,
  layoutAnchor: Vec3,
  target: { x: number; y: number },
  options: DragOptions = {},
): DragResult {
  const maxAngle = options.maxAngle ?? 0.12;
  const maxIterations = options.maxIterations ?? 6;
  const tolerance = options.tolerance ?? 0.5;
  let error = Number.POSITIVE_INFINITY;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const display = displayOf(state, layoutAnchor);
    const current = projectDisplay(state, viewport, fovDeg, display);
    /* 锚点落到相机后面就无法再"跟手"了：交给调用方结束抓取（不硬算）✓ */
    if (current === null) return { iterations: iteration, error, lost: true };
    const ux = target.x - current.x;
    const uy = target.y - current.y;
    error = Math.hypot(ux, uy);
    if (error <= tolerance) return { iterations: iteration, error, lost: false };
    const solution = solveDrag(state, viewport, fovDeg, display, ux, uy, maxAngle);
    /* 奇异（锚点贴住球心）⇒ 如实返回，让调用方换虚拟球面锚点或结束 ✓ */
    if (solution.singular) return { iterations: iteration, error, lost: true };
    applySceneRotation(state, solution.delta);
  }
  return { iterations: maxIterations, error, lost: false };
}

/* ------------------------------- 小地图截面 ------------------------------- */

/** 小地图上的一个点：把相机位置投到"过球心与相机、且沿视线"的截面上 */
export interface MinimapPoint {
  /**
   * 沿视线方向的深度（世界单位）。
   * 球心在相机前方 ⇒ **正**；穿到球心另一侧 ⇒ **负**（于是小地图上"越深入越往左"✓）。
   */
  depth: number;
  /** 垂直于视线的侧向偏移（相机上方向为正，带符号；只丢掉绕视线的方位角 ✓） */
  lateral: number;
  /** 到球心的**真实**距离（世界单位）——`hypot(depth, lateral)` 必须等于它 ✓ */
  distance: number;
  /** 是否在操作球外 */
  outside: boolean;
}

/**
 * 相机在操作球里的位置 → 小地图（截面图）坐标。
 *
 * 用户的截面图要的就是这个：一张平面图，能看出"视角现在在球体的哪个位置"。
 * 取**过球心、过相机、且沿视线方向**的截面：横轴 = 沿视线的深度（球心在前方为正 ✓），
 * 纵轴 = **相机上方向上的偏移**（`dot(P−C, up)`）✓。
 *
 * 为什么侧向不再取"垂直分量的完整模长"（文档 P2）：那样只有符号由 up 的点积决定，
 * 当偏移主要沿屏幕右方向时，up 分量从 +0.001 跨到 −0.001 会让侧向值从 +100 跳到 −100 ✗
 * （实际只移动了 0.002）。现在纵轴就是 up 分量本身 ⇒ **连续、不会跳变** ✓；
 * 代价是"图上距离 = 真实距离"不再成立，所以另给一个距离读数（见 `distanceRatio`）✓。
 *
 * @param input - 球心、相机位置、相机的前向与上方向、操作球半径。
 * @returns 截面坐标（世界单位）与到球心的真实距离。
 */
export function minimapPoint(input: {
  center: Vec3;
  eye: Vec3;
  forward: Vec3;
  up: Vec3;
  radius: number;
}): MinimapPoint {
  const offset = sub(input.eye, input.center);
  const alongView = dot(offset, input.forward);
  const depth = -alongView;
  const lateral = dot(offset, input.up);
  const distance = length(offset);
  return {
    depth,
    lateral,
    distance,
    outside: input.radius > 0 ? distance > input.radius : false,
  };
}

/**
 * 到球心的距离相对操作球半径的比值（小地图上的距离读数 ✓）。
 * @param distance - 到球心的真实距离。
 * @param radius - 操作球半径。
 * @returns 比值；半径非法 ⇒ 0。
 */
export function distanceRatio(distance: number, radius: number): number {
  return radius > 0 && Number.isFinite(radius) ? distance / radius : 0;
}

/**
 * 是否该为小地图轨迹记一个新采样。
 *
 * 相机状态事件可能因为别的原因重复广播（同一位置反复派发）✗ ——
 * 每次都追加就会画出一串没有意义的点 ✓（文档 P2 要求去重）。
 *
 * @param previousEye - 上一次采样时的相机位置（没有 ⇒ 记）。
 * @param eye - 这次的位置。
 * @param radius - 操作球半径（用于把"位移"归一化成比例）。
 * @param minRatio - 至少移动这么多倍半径才算新采样。
 * @returns 是否记录。
 */
export function shouldSampleTrail(
  previousEye: Vec3 | null,
  eye: Vec3,
  radius: number,
  minRatio = 0.004,
): boolean {
  if (previousEye === null) return true;
  if (!(radius > 0)) return false;
  return length(sub(eye, previousEye)) / radius > minRatio;
}

/**
 * 以**固定球心 C** 为基准测量操作球半径：`max|X − C|`（文档 P2）。
 *
 * 为什么不能直接用包围体的 `radius`：那个是绕 `bounds.center` 算的 ✗ ——
 * 球心冻结在别处时，它未必包得住全部节点，小地图和抓取范围就会失真 ✗。
 *
 * @param positions - 节点坐标（xyz 连续存放）。
 * @param count - 节点数。
 * @param center - 固定球心 C。
 * @returns 半径（空图 ⇒ 传入的兜底值）。
 */
export function radiusAbout(positions: Float32Array, count: number, center: Vec3): number {
  let maxDistance = 0;
  for (let index = 0; index < count; index += 1) {
    const x = positions[index * 3];
    const y = positions[index * 3 + 1];
    const z = positions[index * 3 + 2];
    if (x === undefined || y === undefined || z === undefined) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const distance = Math.hypot(x - center[0], y - center[1], z - center[2]);
    if (distance > maxDistance) maxDistance = distance;
  }
  return maxDistance > 0 ? maxDistance : 0;
}

/* --------------------------------- 滚轮 --------------------------------- */

/** 滚轮推进的配置（都由插件拥有并校验，不散落在构建替换字符串里 ✓） */
export interface WheelOptions {
  /** 一个"标准化像素"推进的世界距离（插件按场景尺度给，带正的下限） */
  speed: number;
  /** 单次事件的最大行程（世界单位） */
  maxStep: number;
  /** 行高换算（`deltaMode === 1`） */
  lineHeight: number;
}

export const DEFAULT_WHEEL: WheelOptions = { speed: 0.5, maxStep: 400, lineHeight: 16 };

/**
 * 标准化滚轮增量并换算成**沿视线的前进行程**。
 *
 * 约定与浏览器一致：向前滚（`deltaY < 0`）⇒ 返回**正值**（前进）；
 * `deltaMode` 三种单位分别处理（像素 / 行 / 页），并把单事件行程限幅，
 * 免得一次大增量直接跨过整张图 ✓。
 *
 * @param deltaY - 原始 `event.deltaY`。
 * @param deltaMode - 原始 `event.deltaMode`（0 像素 / 1 行 / 2 页）。
 * @param viewportHeight - 画布高度（页单位换算用）。
 * @param options - 速度配置。
 * @returns 前进行程（世界单位，正 = 前进）。
 */
export function wheelTravel(
  deltaY: number,
  deltaMode: number,
  viewportHeight: number,
  options: WheelOptions = DEFAULT_WHEEL,
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  const page = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : options.lineHeight * 20;
  const unit = deltaMode === 1 ? options.lineHeight : deltaMode === 2 ? page : 1;
  const pixels = deltaY * unit;
  const travel = -pixels * options.speed; /* 向前滚（deltaY < 0）⇒ 正行程 ✓ */
  return clampNum(travel, -options.maxStep, options.maxStep);
}

/**
 * 相机沿视线前进/后退：`P ← P + F × travel`，**只动位置**（C/Q/S 都不变）✓。
 *
 * 不依赖"到球心的距离"，所以走到球心也不会失去推进能力 ✓；
 * 同时对 `|P − C|` 设一个有限上限，防止一路飞出场景 ✗。
 *
 * @param state - 就地更新 `eye`。
 * @param travel - 前进行程（世界单位，正 = 前进）。
 * @param maxRange - `|P − C|` 的上限。
 */
export function advanceEye(state: InteriorState, travel: number, maxRange: number): void {
  if (!Number.isFinite(travel) || travel === 0) return;
  const forward = rotateVec(state.view, [0, 0, -1]);
  const next = add(state.eye, scale(forward, travel));
  const offset = sub(next, state.center);
  const distance = length(offset);
  if (Number.isFinite(maxRange) && maxRange > 0 && distance > maxRange) {
    /*
     * 超范围时**沿视线截断行程**，而不是把点径向投回球面（文档开发备注）：
     * 径向投影会附带给横向位移，于是"一直往前滚"会莫名其妙地往侧面漂 ✗。
     * 求 |P + F·t − C| = maxRange 的根，取沿行进方向最远的那个 ✓。
     */
    const origin = sub(state.eye, state.center);
    const b = 2 * dot(origin, forward);
    const c = dot(origin, origin) - maxRange * maxRange;
    const disc = b * b - 4 * c;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      const roots = [(-b - root) / 2, (-b + root) / 2];
      /* 只保留**沿行进方向**且不超过本次行程的根，取最远的那个 ✓ */
      const usable = travel > 0
        ? roots.filter((t) => t > 0 && t <= travel).sort((l, r) => r - l)
        : roots.filter((t) => t < 0 && t >= travel).sort((l, r) => l - r);
      if (usable.length > 0) {
        /* 用一个略小于边界的系数，避免浮点落在球外 ✓ */
        state.eye = add(state.eye, scale(forward, usable[0] * 0.999));
        return;
      }
    }
    /* 没有可截断的交点（理论上不该发生）⇒ 不动，别乱跳 ✓ */
    return;
  }
  state.eye = next;
}

/* ------------------------------ 定位与取景 ------------------------------ */

/**
 * 定位到某个**布局坐标**的点：移动相机并转向它，**球心 C 与图谱旋转 S 都不变** ✓。
 * @param state - 就地更新 `eye` / `view`。
 * @param target - 布局坐标。
 * @param distance - 停在目标前方多远。
 */
export function aimAt(state: InteriorState, target: Vec3, distance: number): void {
  const display = displayOf(state, target);
  const forward = rotateVec(state.view, [0, 0, -1]);
  const eye = sub(display, scale(forward, Math.max(1e-3, distance)));
  const toTarget = sub(display, eye);
  state.eye = eye;
  state.view = quatLookAt(normalize(toTarget), rotateVec(state.view, [0, 1, 0]));
}

/**
 * 适应窗口：相机退到包围球外、面向球心；保留 S 与 C ✓。
 * @param state - 就地更新 `eye` / `view`。
 * @param radius - 包围球半径。
 * @param distance - 取景距离（球心到相机）。
 */
export function fitSphere(state: InteriorState, radius: number, distance: number): void {
  const outward = sub(state.eye, state.center);
  const direction = length(outward) < 1e-6 ? [0, 0, 1] : normalize(outward);
  state.eye = add(state.center, scale(direction, Math.max(distance, radius * 1.05)));
  state.view = quatLookAt(normalize(sub(state.center, state.eye)));
}

/** Shift 平移：只改相机位置（右/上方向），朝向与 C/S 不变 ✓ */
export function panEye(state: InteriorState, dx: number, dy: number, unitScale: number): void {
  const basis = displayBasis(state);
  state.eye = add(state.eye, add(scale(basis.right, -dx * unitScale), scale(basis.up, dy * unitScale)));
}
