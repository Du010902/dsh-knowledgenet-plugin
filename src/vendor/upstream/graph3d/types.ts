/**
 * 三维空间视图的共享类型
 *
 * 这里只放类型与协议常量，不引入 three、DOM 或 d3：
 * Worker、主线程、纯函数模块与单元测试都要能引用它。
 *
 * 三种状态刻意分开（见《空间图谱技术方案》8.2）：
 * - 业务状态：节点、前置边、学习目标 —— 留在 Store / Repository；
 * - 布局状态：x/y/z、速度、拓扑签名 —— 由布局引擎与视图缓存管理；
 * - 视图状态：相机、标签密度、相机命令 —— 只属于这个视图。
 */

export type Vec3 = [number, number, number];

/* --------------------------------- 布局 --------------------------------- */

/**
 * 交给 d3-force-3d 直接改写的可变节点。
 *
 * `index` 与稳定 ID 的映射关系在整轮布局里保持不变；
 * 坐标不进领域模型（`KnowledgeNode.x/y` 仍然不写），只存在于这份副本里。
 */
export interface LayoutNode {
  index: number;
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/**
 * 布局参数。
 *
 * 数值是**试调起点**，不是测量出来的最优解：直接边长度、拓扑分离强度、
 * 收拢与边界都要用代表图对照之后才谈得上定稿。改这里不需要动算法。
 */
export interface LayoutParams {
  /** 直接边（d = 1）的参考长度 Ledge */
  edgeLength: number;
  /** 拓扑分离的 β：L(d) = Ledge × (1 + β × ln d)，只作用于 d ≥ 2 */
  topoBeta: number;
  /** 拓扑分离强度 kTopo */
  topoStrength: number;
  /** 单个节点单轮允许的最大速度增量（限制步长，避免大图力突增） */
  topoMaxStep: number;
  /** 拓扑约束的节点对预算：小图取全量，大图按固定种子抽样 */
  topoPairBudget: number;
  /** 弱收拢：向分量锚点靠拢的强度（forceCenter 只挪质心，不能代替它） */
  centering: number;
  /**
   * 普通斥力强度（forceManyBody 的 strength，取正数表示排斥）。
   * 它与拓扑分离都包含排斥，两者不能简单相加成两个完整强斥力：
   * 先把这里调到基线可读，再逐级增加较弱的拓扑约束。
   */
  chargeStrength: number;
  /** 速度阻尼：越小越稳，过大则容易来回摆 */
  velocityDecay: number;
  /** 停止判据之一：归一化 RMS 位移持续低于该值 */
  stableRms: number;
  /** 停止判据之一：碰撞残差（世界单位）低于该值视为没有重叠 */
  stableCollisionResidual: number;
  /** 迭代预算上限（超过就结束并如实报告 budget） */
  maxIterations: number;
  /** 时间预算上限（毫秒） */
  maxDurationMs: number;
  /** 柔性边界强度：只对超出目标范围的节点施加回拉 */
  boundaryStrength: number;
  /** 目标范围相对「紧凑云团估算半径」的松弛倍数 */
  boundarySlack: number;
  /** 旧坐标软锚定强度（增量更新时保住空间记忆） */
  anchorStrength: number;
  /** 节点碰撞半径：直径必须明显小于 Ledge，否则碰撞与弹簧互相打架 */
  collideRadius: number;
  /** 渲染用的节点半径（世界单位） */
  nodeRadius: number;
  /** 确定性初始化与抽样用的种子 */
  seed: number;
}

export const DEFAULT_LAYOUT_PARAMS: LayoutParams = {
  edgeLength: 36,
  topoBeta: 0.65,
  topoStrength: 0.7,
  topoMaxStep: 1.2,
  topoPairBudget: 6000,
  centering: 0.02,
  chargeStrength: 90,
  velocityDecay: 0.62,
  boundaryStrength: 0.06,
  boundarySlack: 1.25,
  anchorStrength: 0.07,
  collideRadius: 11,
  nodeRadius: 4.2,
  stableRms: 0.001,
  stableCollisionResidual: 0.6,
  maxIterations: 320,
  maxDurationMs: 8000,
  seed: 20260918,
};

/** 布局质量与结束状态的度量（用于「布局已停止」的判据，不当作优化目标） */
export interface LayoutMetrics {
  iterations: number;
  /** 归一化 RMS 位移（相对 Ledge） */
  rms: number;
  /** 碰撞残差：最大穿透深度（世界单位），0 表示没有重叠 */
  collisionResidual: number;
  /** 本轮真正参与拓扑约束的节点对数 */
  topologyPairs: number;
  components: number;
  elapsedMs: number;
}

/**
 * 结束原因。
 *
 * `stable` 表示位移与碰撞都达到门槛，`budget` 表示用完了迭代/时间预算——
 * 两者都能继续浏览，但含义不同，界面文案不能混为一谈。
 */
export type LayoutStopReason =
  /** 位移与碰撞都达到门槛 */
  | "stable"
  /** 用完迭代/时间预算 */
  | "budget"
  /** 坐标异常，已回退上一份有效快照 */
  | "error"
  /** 被取消或页面隐藏 */
  | "cancelled"
  /** 直接沿用了上次已经收敛的结果，本轮没有真的计算 */
  | "reused";

/* ----------------------------- Worker 协议 ----------------------------- */

export interface LayoutInitMessage {
  type: "INIT" | "UPDATE";
  /** 工作区代次：导入备份 / 整体替换数据时递增，旧代次的消息一律丢弃 */
  epoch: number;
  /** 拓扑版本：只含节点 ID 与边端点 */
  topologyRevision: number;
  runId: number;
  /** 稳定 ID 顺序：坐标数组永远按这个顺序解释 */
  stableNodeIds: string[];
  /** 无向化之后的边（索引指向 stableNodeIds） */
  edges: Array<[number, number]>;
  /** 上一轮坐标（按同一 ID 顺序对齐）；没有缓存时为 null */
  previousPositions: Float32Array | null;
  parameters: LayoutParams;
}

export interface LayoutCancelMessage {
  type: "CANCEL" | "STOP";
  runId: number;
}

export type LayoutRequest = LayoutInitMessage | LayoutCancelMessage;

export interface LayoutSnapshotMessage {
  type: "SNAPSHOT";
  epoch: number;
  topologyRevision: number;
  runId: number;
  /** 同一轮内的递增序号：主线程用它丢弃过期快照 */
  sequence: number;
  positions: Float32Array;
  iterations: number;
  rms: number;
}

export interface LayoutFinishedMessage {
  type: "FINISHED";
  epoch: number;
  topologyRevision: number;
  runId: number;
  reason: LayoutStopReason;
  metrics: LayoutMetrics;
  positions: Float32Array;
}

export interface LayoutErrorMessage {
  type: "ERROR";
  epoch: number;
  topologyRevision: number;
  runId: number;
  message: string;
}

export type LayoutResponse = LayoutSnapshotMessage | LayoutFinishedMessage | LayoutErrorMessage;

/** 主线程渲染循环面对布局时的对外状态 */
export type LayoutStatus = "forming" | "settling" | "settled" | "unavailable";

/* ------------------------------- 相机与命令 ------------------------------- */

/**
 * 环绕观察的相机状态：绕 target 转，distance 是相机到 target 的距离。
 *
 * 空间视图只有这一种相机模型（拖动旋转、滚轮远近、Shift+左键平移都改它），
 * 因此不需要「控制方式」这类开关字段。
 */
export interface CameraState {
  target: Vec3;
  distance: number;
  /** 水平角（弧度） */
  angle: number;
  /** 俯仰角（弧度），限制在接近但不到 ±90° */
  pitch: number;
}

export type CameraCommandType = "focusNode" | "fitAll";

/**
 * 相机命令。
 *
 * 单击只选择、不发命令；「定位」按钮、双击、F 才发一条。
 * 带 seq 是因为「对同一个节点再定位一次」也必须生效——单看 selectedId 表达不了。
 */
export interface CameraCommand {
  seq: number;
  type: CameraCommandType;
  nodeId?: string;
  source: "toolbar" | "keyboard" | "pointer" | "init" | "mode";
}

/** 相机基向量：投影与拾取都从它出发 */
export interface CameraBasis {
  position: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

export interface Viewport {
  width: number;
  height: number;
}

/* ------------------------------- 投影与标签 ------------------------------- */

/** 一帧内所有节点的屏幕投影结果（CSS 像素），标签与拾取共用 */
export interface ProjectedNode {
  index: number;
  id: string;
  /** 屏幕坐标（画布左上角为原点） */
  x: number;
  y: number;
  /** 相机空间深度；≤ 0 表示在相机后方或近裁剪面之内 */
  depth: number;
  /** 屏幕半径（CSS 像素） */
  radius: number;
  visible: boolean;
}

/** 名称密度：智能预算 / 全部 / 仅与当前节点相关 */
export type LabelDensity = "smart" | "all" | "related";

export interface LabelCandidate {
  id: string;
  text: string;
  x: number;
  y: number;
  depth: number;
  /** 优先级：选中 → 悬停 → 搜索命中 → 重要邻接 → 近处普通节点 */
  priority: number;
  important: boolean;
  /**
   * 强制显示：选中与悬停。
   *
   * 它们不受预算、重叠与遮挡影响（参考图里 selected / hovered 的标题永远画出来）；
   * 缺省时按 `tone === "selected"` 判断，因此老的调用点不传也不会改变语义。
   */
  forced?: boolean;
  /** 字号（CSS 像素） */
  font: number;
  weight: number;
  tone: "selected" | "related" | "normal";
  /** 前景遮挡判断用：节点屏幕半径 */
  radius: number;
}

export interface LabelPlacement {
  id: string;
  text: string;
  x: number;
  y: number;
  font: number;
  weight: number;
  tone: LabelCandidate["tone"];
}

/** 标签布局的输入；measure 由调用方注入，因此这一层不依赖 DOM，可单测 */
export interface LabelPlanInput {
  candidates: LabelCandidate[];
  viewport: Viewport;
  density: LabelDensity;
  /** 画布顶部/底部的浮层留白：标签不许钻到工具栏与页脚下面 */
  inset: { top: number; bottom: number };
  measure(text: string, font: number, weight: number): number;
}

/* --------------------------------- 交互 --------------------------------- */

/** 指针拖动与点击的判定阈值（CSS 像素）：超过它就不再派生选点 */
export const DRAG_THRESHOLD = 5;

/** 相机更新回调：布局或相机动了就唤醒渲染循环，静止时不再空转 */
export type Wake = () => void;
