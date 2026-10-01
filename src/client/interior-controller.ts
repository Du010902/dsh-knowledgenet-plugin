/**
 * `SpaceNavigation` 的插件自有替代实现：内部导航控制器。
 *
 * 依 `design/knowledgenet-interior-navigation.md`。对引擎保持**同一套接口**
 * （`camera` / `basis()` / `command()` / `fitAll()` / `setFrameContext()` / `update()` /
 * `cancelPointer()` / `dispose()`），所以接线只需要把 `engine.ts` 的导入换掉 ✓。
 *
 * 与上游的三点根本区别：
 * 1. **滚轮只移动相机位置 P**（沿视线前进后退，可穿过球心），不再改观察距离、
 *    也不朝光标横移、更不会自动挪旋转中心 ✓；
 * 2. **拖动只旋转图谱 S**（绕固定球心 C），用"抓取点投影约束"求解 ⇒
 *    正在抓取的那一块按指针方向移动，球前球后都一致 ✓（上游绕 target 环绕时球背面必然反向 ✗）；
 * 3. 姿态用完整四元数 Q（含滚转），右/上轴由 Q 给出，没有极点翻转 ✓。
 *
 * 渲染/标签/拾取全部走 `basis()` 给出的**等效相机基向量**（把 S 折进去），
 * 所以那些既有代码一行都不用改 ✓。
 */
import { boundsOf, fitDistance, pickEdge, pickNode, type Bounds } from "../vendor/upstream/graph3d/camera.ts";
import { DRAG_THRESHOLD } from "../vendor/upstream/graph3d/types.ts";
import type { CameraCommand, CameraState, ProjectedNode, Vec3, Viewport } from "../vendor/upstream/graph3d/types.ts";
import type { ContextHit } from "../vendor/upstream/graph3d/navigation.ts";

import {
  advanceEye,
  aimAt,
  anchorFromRay,
  displayBasis,
  dragAnchorTo,
  effectiveBasis,
  fitSphere,
  grabAnchor,
  panEye,
  quatConjugate,
  quatSlerp,
  radiusAbout,
  wheelTravel,
  DEFAULT_WHEEL,
  type GrabAnchor,
  type InteriorState,
} from "./interior-navigation.ts";
import { pickClippedEdge } from "./edge-picking.ts";
import { currentQuat, freeBasis, quatMultiply, quatNormalize, type Quat } from "./trackball.ts";
import { activeLibraryKey } from "./view-cache.ts";

/** 定位动画时长（毫秒）；「减少动态效果」时降为 1ms（与上游一致） */
const FOCUS_DURATION_MS = 620;
/** 视野角（与引擎渲染、`fitDistance` 用的一致） */
const FOV_DEG = 50;
/** 插在 `camera` 上的内部状态键：让上游的内存相机缓存也能带上完整状态 ✓ */
const STATE_KEY = "knInterior";

/**
 * 「相机在球里在哪」的窗口事件名。
 *
 * 引擎是在**上游组件内部**创建的（`GraphUniverse.tsx`），插件拿不到它的实例 ✗；
 * 而相机状态只有这里（内部导航控制器）知道 ✓。
 * 所以由控制器在每次状态变化后广播一个 `CustomEvent`，面板据此画右下角的小地图 ✓
 * —— 与插件既有的 `NODE_CONTEXT_MENU_EVENT` 那套 glue 同一种做法，不必改上游 ✓。
 */
export const INTERIOR_STATE_EVENT = "kn-interior-state";

/**
 * 「用户按了重新整理」的窗口事件名。
 *
 * 面板按钮在重排布局的同时广播它 ✓；控制器据此：
 * 取消进行中的抓取 ✓、等新布局完成后再**采一次球心**并取景 ✓
 * —— 不再用 `smooth` 参数去猜"这是不是重排"（那个参数只表示要不要动画 ✗，文档 P2）。
 * 负载带库身份：多面板并存时只认自己那一个 ✓。
 */
export const RELAYOUT_EVENT = "kn-relayout-request";

/** 重排请求的兜底时限（毫秒）：等不到"布局完成"就用当前包围体兜一次 ✓ */
const RELAYOUT_DEADLINE_MS = 2000;

/** 事件负载：相机位置/朝向、固定球心与操作球半径 */
export interface InteriorStateDetail {
  /** 发起这次更新的画布宿主元素（面板用 `contains()` 认领属于自己那一块 ✓） */
  host: Element;
  center: Vec3;
  eye: Vec3;
  /** 相机朝向（显示世界） */
  forward: Vec3;
  /** 相机上方向（显示世界） */
  up: Vec3;
  /** 到球心的距离 */
  distance: number;
  /** 操作包围球半径 */
  radius: number;
}

/** 挂在 `camera` 上的内部状态（`frozen` = 球心已冻结，缓存恢复时要一起带回来 ✓） */
type CarriedState = InteriorState & { frozen?: boolean };
type CameraWithState = CameraState & { [STATE_KEY]?: CarriedState };

/** 控制器选项：与上游 `NavigationOptions` 同形（这样引擎侧不用改） */
export interface InteriorNavigationOptions {
  element: HTMLElement;
  initial: CameraState;
  edgeLength: number;
  getProjected(): ProjectedNode[];
  getEdges(): ReadonlyArray<{ from: number; to: number }>;
  onSelect(index: number | null): void;
  onHover(index: number | null): void;
  onEdgeHover?(index: number | null): void;
  onSelectEdge?(index: number | null): void;
  onContextMenu(hit: ContextHit, clientX: number, clientY: number): void;
  onLocate(): void;
  onCameraChange(): void;
  onUserCameraInput?(): void;
}

interface PointerState {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  captured: boolean;
  panning: boolean;
}

interface Animation {
  start: number;
  duration: number;
  fromEye: Vec3;
  toEye: Vec3;
  fromView: readonly [number, number, number, number];
  toView: readonly [number, number, number, number];
}

const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const clampNum = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export class InteriorNavigation {
  /**
   * 对外的相机视图（**等效相机**：布局坐标系里的位置与姿态）。
   * 只用于持久化与调试；`basis()` 才是渲染真正用的那份 ✓。
   */
  camera: CameraWithState;

  private state: InteriorState;
  private pointer: PointerState | null = null;
  private grab: GrabAnchor | null = null;
  private animation: Animation | null = null;
  private suppressClick = false;
  private suppressedTimer: number | undefined;
  private disposed = false;
  private hover: number | null = null;
  private hoverEdge: number | null = null;
  private bounds: Bounds = boundsOf(new Float32Array(0), 0);
  private viewport: Viewport = { width: 800, height: 600 };
  /** 用户是否已经自己操作过相机：操作过就**冻结球心** ✓ */
  private userInteracted = false;
  /** 同一帧里的相机变化只在下一帧广播一次 ✓ */
  private stateEventPending = false;
  /** 节点坐标（引擎每帧交过来；线段拾取需要世界坐标 ✓） */
  private positions: Float32Array | null = null;
  private positionCount = 0;
  /** 是否已按"以固定球心 C 为中心"量过半径 ✓（量过就不再被 bounds.radius 覆盖 ✗） */
  private radiusMeasured = false;
  /** 收到明确的重新整理请求、正等新布局完成 ✓ */
  private relayoutPending = false;
  private relayoutDeadline = 0;
  /** 重排期间用户自己操作过 ⇒ 不再自动取景覆盖他的视角 ✓ */
  private interactedSinceRelayout = false;
  /** 本实例绑定的知识库身份（构造时取一次；重新整理事件按它认领 ✓） */
  private readonly libraryKey = activeLibraryKey();
  /*
   * 注意：这里**不用**构造参数属性（`constructor(private readonly options…)`）——
   * Node 的 strip-only TS 模式直接拒绝那种写法（ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX），
   * 而我们的单测就是直接加载 `.ts` 源码跑的 ✗。
   */
  private readonly options: InteriorNavigationOptions;

  constructor(options: InteriorNavigationOptions) {
    this.options = options;
    this.state = this.seedState(options.initial);
    this.camera = { ...options.initial } as CameraWithState;
    this.syncCamera();
    const element = options.element;
    element.addEventListener("pointerdown", this.onPointerDown);
    element.addEventListener("pointermove", this.onPointerMove);
    element.addEventListener("pointerup", this.onPointerUp);
    element.addEventListener("pointercancel", this.onPointerCancel);
    element.addEventListener("pointerleave", this.onPointerLeave);
    element.addEventListener("dblclick", this.onDoubleClick);
    element.addEventListener("contextmenu", this.onContextMenu);
    element.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("blur", this.onWindowBlur);
    window.addEventListener(RELAYOUT_EVENT, this.onRelayoutRequest);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  /**
   * 「重新整理」请求（面板广播）。
   * @param event - 负载里带库身份；不是本实例的库就忽略 ✓。
   */
  private onRelayoutRequest = (event: Event): void => {
    const detail = (event as CustomEvent<{ libraryKey?: string }>).detail;
    if (detail !== undefined && detail !== null
      && typeof detail.libraryKey === "string" && detail.libraryKey !== this.libraryKey) {
      return;
    }
    this.relayoutPending = true;
    this.interactedSinceRelayout = false;
    this.relayoutDeadline = (typeof performance === "undefined" ? 0 : performance.now()) + RELAYOUT_DEADLINE_MS;
    /* 重排开始就取消进行中的抓取（文档要求）✓ */
    this.cancelPointer();
  };

  /* ------------------------------ 状态与基向量 ------------------------------ */

  /**
   * 从上游相机状态播种：优先用缓存里带过来的完整状态；
   * 没有（老缓存 / 首次打开）⇒ 按文档的兼容做法：
   * **以旧 target 初始化 C、以单位四元数初始化 S**，P/Q 由 `freeBasis` 反推 ✓。
   */
  private seedState(initial: CameraState): InteriorState {
    const carried = (initial as CameraWithState)[STATE_KEY];
    if (carried !== undefined && Array.isArray(carried.center) && Array.isArray(carried.eye)) {
      /*
       * **"球心已冻结"也要一起恢复**（文档 P1）：
       * 恢复完整状态却把 `userInteracted` 留在 false，会让随后的 fitAll 把
       * 已经冻结的球心当成"还没操作过的初始球心"再挪一次 ✗。
       */
      this.userInteracted = carried.frozen === true;
      return {
        center: [...carried.center],
        eye: [...carried.eye],
        view: [...carried.view],
        scene: [...carried.scene],
        radius: Number.isFinite(carried.radius) && carried.radius > 0 ? carried.radius : 20,
      };
    }
    const basis = freeBasis(initial, initial.target);
    return {
      center: [...initial.target],
      eye: [...basis.position],
      view: currentQuat(initial),
      scene: [0, 0, 0, 1],
      radius: 20,
    };
  }

  /** 把内部状态同步到对外的 `camera`（持久化 / 调试用；渲染不走它 ✓） */
  private syncCamera(): void {
    const basis = effectiveBasis(this.state);
    const offset: Vec3 = [
      basis.position[0] - this.state.center[0],
      basis.position[1] - this.state.center[1],
      basis.position[2] - this.state.center[2],
    ];
    const distance = Math.hypot(offset[0], offset[1], offset[2]) || 1;
    const forward = basis.forward;
    this.camera.target = [...this.state.center];
    this.camera.distance = distance;
    this.camera.q = this.effectiveQuat();
    this.camera.pitch = Math.asin(clampNum(-forward[1], -1, 1));
    this.camera.angle = Math.atan2(-forward[0], -forward[2]);
    this.camera[STATE_KEY] = {
      center: [...this.state.center],
      eye: [...this.state.eye],
      view: [...this.state.view],
      scene: [...this.state.scene],
      radius: this.state.radius,
      /* 冻结标记：缓存恢复时要一起带回来，否则球心会被再挪一次 ✗ */
      frozen: this.userInteracted,
    };
    this.publishState();
  }

  /**
   * 广播"相机在球里的位置"（给右下角的小地图用）。
   *
   * 用 `requestAnimationFrame` 合并同一帧里的多次变化：拖动时每个 pointermove 都会同步一次相机，
   * 不合并的话一帧要派发好几次事件、面板也跟着重渲染好几次 ✗。
   */
  private publishState(): void {
    if (this.stateEventPending || this.disposed) return;
    if (typeof window === "undefined" || typeof CustomEvent !== "function") return;
    this.stateEventPending = true;
    const flush = (): void => {
      this.stateEventPending = false;
      if (this.disposed) return;
      const basis = displayBasis(this.state);
      const detail: InteriorStateDetail = {
        host: this.options.element,
        center: [...this.state.center],
        eye: [...this.state.eye],
        forward: [...basis.forward],
        up: [...basis.up],
        distance: Math.hypot(
          this.state.eye[0] - this.state.center[0],
          this.state.eye[1] - this.state.center[1],
          this.state.eye[2] - this.state.center[2],
        ),
        radius: this.state.radius,
      };
      window.dispatchEvent(new CustomEvent<InteriorStateDetail>(INTERIOR_STATE_EVENT, { detail }));
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else flush();
  }

  /** 等效姿态（把 S 折进 Q）：布局坐标系里相机朝向 */
  private effectiveQuat(): Quat {
    /*
     * 必须与 `effectiveBasis()` 一致：那里三条轴都是 `S⁻¹` 作用到 Q 的轴上，
     * 所以对外姿态 = `inverse(S) × Q` ✓。
     * （曾经写成 `S × Q` ✗ —— 调试/持久化看到的姿态会与真正渲染的基向量不一致，
     *  将来谁拿这份姿态去推算就会算错。文档开发备注点名的就是这个。）
     */
    return quatNormalize(quatMultiply(quatConjugate(this.state.scene), this.state.view));
  }

  /** 渲染/投影/拾取用的基向量（= 布局坐标系的相机；S 已折进去） */
  basis() {
    return effectiveBasis(this.state);
  }

  /** 外部（每帧）更新：包围体、视口、节点坐标（线段拾取要用世界坐标 ✓） */
  setFrameContext(bounds: Bounds, viewport: Viewport, positions?: Float32Array, count?: number): void {
    this.bounds = bounds;
    this.viewport = viewport;
    if (positions !== undefined) {
      this.positions = positions;
      this.positionCount = count ?? positions.length / 3;
    }
    /*
     * **球心不在这里跟随**（文档：布局持续计算期间不要每帧重算操作球心 ✗）——
     * 每帧跟着包围体中心走会让画面在布局收敛时自己漂移。
     * 球心只在 `fitAll()`（初次取景 / 新布局完成 / 明确重新整理）时采一次 ✓。
     * 操作球半径也随之冻结：拖动期间不换 ✓；而且一旦按"以 C 为中心"量过（`fitAll` ✓），
     * 就**不再**用绕 `bounds.center` 的那个半径覆盖它 ✗（文档 P2：后者未必包住全部节点 ✓）。
     */
    if (this.pointer === null && !this.radiusMeasured
      && Number.isFinite(bounds.radius) && bounds.radius > 0) {
      this.state.radius = bounds.radius;
    }
    /* 重排请求进来后迟迟等不到"布局完成"：到点就用当前包围体兜一次，别一直挂着 ✗ */
    if (this.relayoutPending && this.relayoutDeadline > 0
      && (typeof performance === "undefined" || performance.now() >= this.relayoutDeadline)) {
      this.adoptRelayoutCenter(bounds, null, 0);
    }
    this.syncCamera();
  }

  /* ------------------------------- 相机命令 ------------------------------- */

  command(command: CameraCommand, index: number | null, positions: Float32Array, count: number): void {
    this.positions = positions;
    this.positionCount = count;
    if (command.type === "fitAll") {
      this.fitAll(positions, count, true);
      return;
    }
    if (index === null || index < 0 || index >= count) return;
    const target: Vec3 = [
      positions[index * 3] ?? 0,
      positions[index * 3 + 1] ?? 0,
      positions[index * 3 + 2] ?? 0,
    ];
    /* 定位：移动相机并转向它；**球心 C 与图谱旋转 S 都不动** ✓ */
    const distance = clampNum(this.options.edgeLength * 2.6, 40, Math.max(60, this.bounds.radius));
    const from = { eye: [...this.state.eye] as Vec3, view: this.state.view };
    this.animateTo(from, this.aimTarget(target, distance), true);
  }

  /**
   * 「适应窗口」：回到球外全局取景、面向球心；保留 C 与 S ✓。
   *
   * 球心更新规则（文档 P2：**不复用 `smooth` 推断重排**）：
   * - 用户还没操作过 ⇒ 采当前布局的包围体中心（初次进入 ✓）；
   * - 收到过**明确的重新整理请求**（`kn-relayout-request` 事件 ✓）⇒ 在布局完成后采一次 ✓；
   * - 其它情况（普通适应窗口 / 自动收敛取景）⇒ **球心保持不动** ✓。
   *
   * @param positions - 节点坐标。
   * @param count - 节点数。
   * @param smooth - 是否带动画（只决定动画，不再用来推断"是否重排" ✓）。
   */
  fitAll(positions: Float32Array, count: number, smooth: boolean): void {
    this.positions = positions;
    this.positionCount = count;
    const bounds = boundsOf(positions, count);
    this.bounds = bounds;
    const newLayout = this.relayoutPending;
    if ((!this.userInteracted || newLayout) && Number.isFinite(bounds.radius) && bounds.radius > 0) {
      this.adoptRelayoutCenter(bounds, positions, count);
    } else {
      /* 球心不动，但半径始终按"以 C 为中心"量 ✓（操作球 / 取景 / 小地图共用它 ✓） */
      this.measureRadius(positions, count);
    }
    /* 用户在重排期间自己操作过 ⇒ 别再自动取景覆盖他的视角（文档要求）✓ */
    const skipFraming = newLayout && this.interactedSinceRelayout;
    this.relayoutPending = false;
    this.relayoutDeadline = 0;
    this.interactedSinceRelayout = false;
    if (skipFraming) {
      this.syncCamera();
      this.options.onCameraChange();
      return;
    }
    const insets = { top: 64, bottom: 64 };
    /*
     * 取景距离用**操作球半径**（以固定球心 C 量出来的那个 ✓），
     * 而不是绕 `bounds.center` 的包围半径 —— 两者在球心冻结于别处时会不一样，
     * 用后者会出现"取景按另一个球算"的错位 ✗（文档要求三处共用同一个半径 ✓）。
     */
    const framingRadius = this.state.radius > 0 ? this.state.radius : bounds.radius;
    const distance = fitDistance(framingRadius, this.viewport, FOV_DEG, insets) * 1.08;
    const from = { eye: [...this.state.eye] as Vec3, view: this.state.view };
    this.animateTo(from, this.fitTarget(framingRadius, distance), smooth);
  }

  /** 采用新的球心，并把操作球半径按"以新球心为中心"重量一次 ✓ */
  private adoptRelayoutCenter(bounds: Bounds, positions: Float32Array | null, count: number): void {
    if (!Array.isArray(bounds.center) || !(bounds.radius > 0)) return;
    this.state.center = [...bounds.center];
    this.radiusMeasured = false;
    if (positions !== null && count > 0) this.measureRadius(positions, count);
    else this.state.radius = bounds.radius;
  }

  /** 以**固定球心 C** 为基准量半径：`max|X − C|` ✓（文档 P2） */
  private measureRadius(positions: Float32Array, count: number): void {
    const radius = radiusAbout(positions, count, this.state.center);
    if (radius > 0) {
      this.state.radius = radius;
      this.radiusMeasured = true;
    }
  }

  /**
   * 每帧推进定位/取景动画（P 线性插值、Q 球面插值）。
   *
   * **只有这里才把插值结果写进 state**（文档 P2）：命令之后、第一帧之前，
   * 状态必须还停在出发前 —— 否则滚轮/按下取消动画时会从"终点"开始操作，产生突发移动 ✗，
   * 同步出去的 camera 与状态事件也会提前暴露终点 ✗。
   */
  update(now: number): boolean {
    if (this.disposed) return false;
    const animation = this.animation;
    if (!animation) return false;
    const t = clampNum((now - animation.start) / animation.duration, 0, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    this.state.eye = lerp3(animation.fromEye, animation.toEye, eased);
    this.state.view = quatSlerp(animation.fromView, animation.toView, eased);
    if (t >= 1) {
      /* 收尾时提交**精确终点**，别留插值残差 ✓ */
      this.state.eye = [...animation.toEye] as Vec3;
      this.state.view = animation.toView;
      this.animation = null;
    }
    this.syncCamera();
    this.options.onCameraChange();
    return true;
  }

  /**
   * 启动一次位姿动画。
   *
   * @param from - 起点（调用时的实际状态 ✓ —— 连续定位就自然接着上一次的插值位置 ✓）。
   * @param to - 终点（在临时副本上算出来的，提交之前不影响 state ✓）。
   * @param smooth - 是否要动画；「减少动态效果」或非 smooth ⇒ 立即提交且不留待执行动画 ✓。
   */
  private animateTo(
    from: { eye: Vec3; view: Quat },
    to: { eye: Vec3; view: Quat },
    smooth: boolean,
  ): void {
    const duration = smooth && !this.reducedMotion() ? FOCUS_DURATION_MS : 1;
    if (duration <= 1) {
      /* 立即到位：明确同步提交，并把待执行动画清掉 ✓ */
      this.state.eye = [...to.eye] as Vec3;
      this.state.view = to.view;
      this.animation = null;
      this.syncCamera();
      this.options.onCameraChange();
      return;
    }
    this.animation = {
      start: performance.now(),
      duration,
      fromEye: [...from.eye] as Vec3,
      toEye: [...to.eye] as Vec3,
      fromView: from.view,
      toView: to.view,
    };
    /* 起点不变：这里同步出去的仍是"出发前"的状态 ✓ */
    this.syncCamera();
    this.options.onCameraChange();
  }

  /** 在**临时副本**上算出"对准目标"的位姿（不碰真实状态 ✓） */
  private aimTarget(target: Vec3, distance: number): { eye: Vec3; view: Quat } {
    const draft = this.draftState();
    aimAt(draft, target, distance);
    return { eye: draft.eye, view: draft.view };
  }

  /** 在**临时副本**上算出"适应窗口"的位姿（不碰真实状态 ✓） */
  private fitTarget(radius: number, distance: number): { eye: Vec3; view: Quat } {
    const draft = this.draftState();
    fitSphere(draft, radius, distance);
    return { eye: draft.eye, view: draft.view };
  }

  /** 复制一份状态用于试算 ✓ */
  private draftState(): InteriorState {
    return {
      center: [...this.state.center],
      eye: [...this.state.eye],
      view: [...this.state.view],
      scene: [...this.state.scene],
      radius: this.state.radius,
    };
  }

  /* ------------------------------- 指针交互 ------------------------------- */

  private local(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.options.element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onPointerDown = (event: PointerEvent): void => {
    /* 右键留给节点菜单：这里完全不参与相机 */
    if (event.button !== 0) return;
    this.options.element.focus({ preventScroll: true });
    this.animation = null;
    const point = this.local(event);
    /*
     * 按下时**记录候选抓取点**（此时还不旋转）：
     * 必须用**按下那一刻**的指针位置取锚点 —— 等到越过阈值才取的话，
     * 指针已经离开节点几十像素，节点上就抓不到了（实测会退化成球面锚点 ✗）。
     */
    this.grab = event.shiftKey ? null : this.buildGrab(point.x, point.y);
    this.pointer = {
      id: event.pointerId,
      startX: point.x,
      startY: point.y,
      lastX: point.x,
      lastY: point.y,
      moved: false,
      captured: false,
      panning: event.shiftKey,
    };
    this.options.element.dataset.dragging = "true";
  };

  private onPointerMove = (event: PointerEvent): void => {
    const point = this.local(event);
    const pointer = this.pointer;
    if (pointer !== null && pointer.id === event.pointerId) {
      const dx = point.x - pointer.startX;
      const dy = point.y - pointer.startY;
      if (!pointer.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        pointer.moved = true;
        /* 真的开始拖了才捕获指针：在 pointerdown 就捕获会把随后的 click 一并重定向 ✗ */
        this.options.element.setPointerCapture(event.pointerId);
        pointer.captured = true;
        this.userInteracted = true;
        this.interactedSinceRelayout = true;
      }
      if (pointer.moved) {
        this.options.onUserCameraInput?.();
        if (pointer.panning) {
          const unit = clampNum(this.state.radius, 30, 400) * 0.0016;
          panEye(this.state, point.x - pointer.lastX, point.y - pointer.lastY, unit);
        } else if (this.grab !== null) {
          /* 目标 = 抓取点初始屏幕位置 + **从按下点到当前位置的总位移**（不累加增量，避免漂移 ✓） */
          const target = {
            x: this.grab.screen.x + dx,
            y: this.grab.screen.y + dy,
          };
          const result = dragAnchorTo(this.state, this.viewport, FOV_DEG, this.grab.layout, target);
          /*
           * 锚点掉到相机后方 / 杠杆失效（贴近球心）⇒ 按文档改用**虚拟球面锚点**继续，
           * 并以当前位置为新基准（不跳帧）；球面也解不出来才结束这次抓取 ✓。
           */
          if (result.lost) {
            const rebuilt = anchorFromRay(this.state, this.viewport, FOV_DEG, point.x, point.y);
            if (rebuilt === null) {
              this.grab = null;
            } else {
              this.grab = rebuilt;
              pointer.startX = point.x;
              pointer.startY = point.y;
              if (rebuilt.screen !== undefined) this.grab.screen = rebuilt.screen;
            }
          }
        }
        this.syncCamera();
        this.options.onCameraChange();
        this.setHover(null);
      }
      pointer.lastX = point.x;
      pointer.lastY = point.y;
      return;
    }
    /* 没在拖动时才更新悬停：拖动越过节点不该频繁弹信息 */
    this.applyHover(this.hitTest(point.x, point.y));
  };

  /** 建立抓取点：节点优先，其次操作包围球面 ✓ */
  private buildGrab(x: number, y: number): GrabAnchor | null {
    return grabAnchor(this.state, this.viewport, FOV_DEG, this.options.getProjected(), x, y);
  }

  private hitTest(x: number, y: number): ContextHit {
    const projected = this.options.getProjected();
    const node = pickNode(projected, x, y);
    if (node !== null) return { kind: "node", index: node };
    const edges = this.options.getEdges();
    /*
     * 关系拾取换成**插件自有**的"先按近裁剪面裁线段、再投影命中" ✓：
     * 上游 `pickEdge()` 只要有一个端点不可见就整条跳过 ✗，而相机进入云团后
     * "一个端点在身后"很正常 —— 于是屏幕上画着的线却点不到（文档 P2）。
     * 没有坐标时（还没同步过）退回上游实现，行为不至于更差 ✓。
     */
    const edge = this.positions !== null && this.positionCount > 0
      ? pickClippedEdge(this.positions, edges, this.basis(), this.viewport, FOV_DEG, x, y)
      : pickEdge(projected, edges, x, y);
    if (edge !== null) return { kind: "edge", index: edge };
    return { kind: "canvas" };
  }

  private applyHover(hit: ContextHit): void {
    this.setHover(hit.kind === "node" ? hit.index : null);
    this.setEdgeHover(hit.kind === "edge" ? hit.index : null);
  }

  private onPointerUp = (event: PointerEvent): void => {
    const pointer = this.pointer;
    if (pointer === null || pointer.id !== event.pointerId) return;
    this.pointer = null;
    this.grab = null;
    delete this.options.element.dataset.dragging;
    if (pointer.captured && this.options.element.hasPointerCapture(event.pointerId)) {
      this.options.element.releasePointerCapture(event.pointerId);
    }
    if (pointer.moved) {
      /* 拖动之后浏览器还会补一次 click：用它拦住"转一下顺便换了当前节点" */
      this.suppressClick = true;
      if (this.suppressedTimer !== undefined) window.clearTimeout(this.suppressedTimer);
      this.suppressedTimer = window.setTimeout(() => {
        this.suppressClick = false;
      }, 60);
      return;
    }
    const point = this.local(event);
    const hit = this.hitTest(point.x, point.y);
    if (hit.kind === "node") {
      this.options.onSelect(hit.index);
      this.options.onSelectEdge?.(null);
      return;
    }
    if (hit.kind === "edge") {
      this.options.onSelectEdge?.(hit.index);
      return;
    }
    this.options.onSelect(null);
    this.options.onSelectEdge?.(null);
  };

  private onPointerCancel = (): void => {
    this.cancelPointer();
  };

  private onPointerLeave = (): void => {
    if (this.pointer === null) {
      this.setHover(null);
      this.setEdgeHover(null);
    }
  };

  private onDoubleClick = (event: MouseEvent): void => {
    if (this.suppressClick) return;
    const point = this.local(event);
    const hit = this.hitTest(point.x, point.y);
    if (hit.kind === "edge") {
      this.options.onSelectEdge?.(hit.index);
      return;
    }
    const node = hit.kind === "node" ? hit.index : null;
    this.options.onSelect(node);
    if (node !== null) this.options.onLocate();
  };

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    const point = this.local(event);
    const hit = this.hitTest(point.x, point.y);
    if (hit.kind === "node") this.options.onSelect(hit.index);
    if (hit.kind === "edge") this.options.onSelectEdge?.(hit.index);
    this.cancelPointer();
    this.options.onContextMenu(hit, event.clientX, event.clientY);
  };

  /**
   * 滚轮 = **沿视线前进/后退**（文档 §滚轮前进后退）。
   *
   * - 只改相机位置 P；不动 C / Q / S / FOV；
   * - 不做朝光标的横向偏移：同一输入在画布任何位置产生同样位移 ✓；
   * - 速度与单事件上限由插件按场景尺度给（带正的下限，走到球心也能继续）✓；
   * - 拖动期间收到滚轮 ⇒ 结束当前抓取（文档要求）✓。
   */
  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.animation = null;
    this.grab = null;
    this.options.onUserCameraInput?.();
    this.userInteracted = true;
        this.interactedSinceRelayout = true;
    const spacing = clampNum(this.options.edgeLength, 8, 200);
    const travel = wheelTravel(event.deltaY, event.deltaMode, this.viewport.height, {
      ...DEFAULT_WHEEL,
      speed: clampNum(spacing * 0.01, 0.05, 4),
      maxStep: Math.max(this.state.radius * 0.6, 80),
    });
    advanceEye(this.state, travel, Math.max(this.state.radius * 4, 600));
    this.syncCamera();
    this.options.onCameraChange();
  };

  private setHover(index: number | null): void {
    if (this.hover === index) return;
    this.hover = index;
    this.options.onHover(index);
  }

  private setEdgeHover(index: number | null): void {
    if (this.hoverEdge === index) return;
    this.hoverEdge = index;
    this.options.onEdgeHover?.(index);
  }

  /* -------------------------------- 键盘 -------------------------------- */

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== "KeyF") return;
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const active = document.activeElement as HTMLElement | null;
    const focused =
      active !== null && (active === this.options.element || this.options.element.contains(active));
    if (!focused) return;
    event.preventDefault();
    this.options.onLocate();
  };

  private onWindowBlur = (): void => {
    this.cancelPointer();
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) this.cancelPointer();
  };

  /** 丢掉未完成的拖动/抓取（切后台、失焦、右键菜单、滚轮打断）✓ */
  cancelPointer(): void {
    this.pointer = null;
    this.grab = null;
    delete this.options.element.dataset.dragging;
  }

  /* ------------------------------- 动画 ------------------------------- */

  private reducedMotion(): boolean {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const element = this.options.element;
    element.removeEventListener("pointerdown", this.onPointerDown);
    element.removeEventListener("pointermove", this.onPointerMove);
    element.removeEventListener("pointerup", this.onPointerUp);
    element.removeEventListener("pointercancel", this.onPointerCancel);
    element.removeEventListener("pointerleave", this.onPointerLeave);
    element.removeEventListener("dblclick", this.onDoubleClick);
    element.removeEventListener("contextmenu", this.onContextMenu);
    element.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener(RELAYOUT_EVENT, this.onRelayoutRequest);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.suppressedTimer !== undefined) window.clearTimeout(this.suppressedTimer);
    this.pointer = null;
    this.grab = null;
    this.animation = null;
  }
}

/* 让"定位"在没有任何姿态变化时也能工作：quatFromAxisAngle 等由 trackball 提供 ✓ */
