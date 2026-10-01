/**
 * 空间视图的**自由旋转**（trackball / 四元数姿态）。
 *
 * 为什么需要它：上游相机用欧拉角 `(angle, pitch)` 表示姿态，并由
 * `basisFromForward` 拿 `WORLD_UP` 叉乘推 `right`。这在**天顶/天底**是奇点：
 * 越过极点时 `right` 会翻转（上游给了 `right = [1,0,0]` 的兜底），于是继续拖就出现"跳一下"。
 * 只解除 `PITCH_LIMIT` 治不了这个——奇点是表示法本身带来的。
 *
 * 这里改成：姿态存成一个**四元数**，拖拽 = 绕**当前屏幕的右轴/上轴**旋转（像抓着一个球）。
 * 基向量直接从四元数取出（`right/up/forward` 各转一次单位轴），不再有叉乘与兜底分支，
 * 因此**任意方向拖拽都连续**，也没有任何角度上限。
 *
 * 兼容：`angle/pitch` 仍然会被同步（供会话持久化与旧代码路径），四元数缺失时可由欧拉角播种。
 */

/** 单位四元数（x, y, z, w） */
export type Quat = readonly [number, number, number, number];
export type Vec3 = readonly [number, number, number];

export const IDENTITY: Quat = [0, 0, 0, 1];
const UP: Vec3 = [0, 1, 0];
const X_AXIS: Vec3 = [1, 0, 0];

/*
 * 缩放到光标要用的一点点向量算术。
 * **刻意自带一份**（不复用上游 `camera.ts` 的 add/sub/…）：这个模块是**独立可测**的，
 * 上游那几个函数只存在于被补丁注入的那个文件里，拿不到 ✓。
 */
function addVec(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function subVec(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scaleVec(a: Vec3, s: number): Vec3 { return [a[0] * s, a[1] * s, a[2] * s]; }
function dotVec(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function normalizeVec(a: Vec3): Vec3 {
  const len = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}

/** 绕单位轴旋转的四元数 */
export function quatFromAxisAngle(axis: Vec3, radians: number): Quat {
  const half = radians / 2;
  const s = Math.sin(half);
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  return [(axis[0] / len) * s, (axis[1] / len) * s, (axis[2] / len) * s, Math.cos(half)];
}

/** 四元数乘法（先 b 后 a 的复合写作 a×b） */
export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/** 用四元数旋转一个向量 */
export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 * (q_vec × v)，结果 = v + w·t + q_vec × t
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/**
 * 由欧拉角（上游约定）播种四元数。
 *
 * 上游把机位放在 `d·(cosP·sinA, sinP, cosP·cosA)`，所以等价于
 * `q = Rot(Y, A) × Rot(X, −P)`（对 `(0,0,1)` 作用即得该式，有测试钉住）。
 */
export function quatFromEuler(angle: number, pitch: number): Quat {
  return quatMultiply(quatFromAxisAngle(UP, angle), quatFromAxisAngle(X_AXIS, -pitch));
}

/** 相机姿态的最小面（与上游 `CameraState` 结构兼容，四元数挂在 `q` 上） */
export interface FreeCameraState {
  distance: number;
  angle: number;
  pitch: number;
  /** 自由姿态；缺失时由 `angle/pitch` 播种 */
  q?: Quat;
}

/** 相机基向量（与上游 `CameraBasis` 同形） */
export interface FreeBasis {
  position: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

/** 取（必要时播种）当前姿态 */
export function currentQuat(state: FreeCameraState): Quat {
  return state.q !== undefined && state.q !== null ? state.q : quatFromEuler(state.angle, state.pitch);
}

/**
 * 一次拖拽：绕**当前屏幕的两条轴**旋转 —— 上下左右都无限、连续，且方向不随机位翻转。
 *
 * 两条轴都必须取**相机自己的**（由四元数转出来的 `right`/`up`），不能用世界 UP：
 * 用世界 UP 做水平旋转时，视角越过天顶（画面上下颠倒）之后左右拖拽在屏幕上会反向，
 * 这正是"有时候旋转方向与拖动方向相反"的来源（上游欧拉角方案在倒过来机位下确实会翻）。
 *
 * 方向约定（"抓住图拖动"）：相机往**拖动的反方向**绕行，于是画面内容跟着手走——
 * 右拖 → 相机向左绕（内容向右转）；下拖 → 相机向上绕（内容向下移）。
 * 因为两条轴都是机身轴，这个关系在任何机位下都成立（有测试逐机位断言）。
 *
 * @param state - 就地更新的相机姿态（会写入 `q`，并同步 `angle/pitch` 供持久化）。
 * @param dx - 水平增量（弧度，已乘灵敏度）。
 * @param dy - 垂直增量（弧度，已乘灵敏度）。
 */
export function trackballStep(state: FreeCameraState, dx: number, dy: number): void {
  const q = currentQuat(state);
  const rightAxis = rotateVec(q, X_AXIS);
  const upAxis = rotateVec(q, UP);
  const delta = quatMultiply(
    quatFromAxisAngle(rightAxis, -dy),
    quatFromAxisAngle(upAxis, -dx),
  );
  const next = quatNormalize(quatMultiply(delta, q));
  state.q = next;
  // 同步欧拉角（会话持久化只记 angle/pitch；同一姿态的欧拉表示即可）
  const forward = rotateVec(next, [0, 0, -1]);
  state.pitch = Math.asin(Math.max(-1, Math.min(1, -forward[1])));
  state.angle = Math.atan2(-forward[0], -forward[2]);
}

/**
 * 由自由姿态给出基向量（供构建期补丁注入到上游 `orbitBasis`）。
 * @param state - 相机状态（用 target/distance）。
 * @param target - 观察目标。
 * @returns 位置与三个正交单位向量；**没有任何叉乘分支**，因此极点是普通的姿态。
 */
export function freeBasis(state: FreeCameraState, target: Vec3): FreeBasis {
  const q = currentQuat(state);
  const offset = rotateVec(q, [0, 0, state.distance]);
  return {
    position: [target[0] + offset[0], target[1] + offset[1], target[2] + offset[2]],
    forward: rotateVec(q, [0, 0, -1]),
    right: rotateVec(q, X_AXIS),
    up: rotateVec(q, UP),
  };
}
