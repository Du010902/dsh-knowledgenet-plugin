/**
 * 空间视图的相机与输入仲裁
 *
 * 为什么不用 OrbitControls 的默认映射：
 * 本项目的操作契约与它不同——右键必须留给节点菜单（不改相机）、
 * 挑选与定位严格分离、Shift+左键平移、点击与拖动按阈值区分。
 * 默认映射逐条改写的成本比直接写一小段控制器更高，
 * 也更难保证「在输入框里打 f 不会变成飞镜头」这类边界。
 *
 * 逐条实现《空间图谱技术方案》5.1–5.3：
 * - 左键短点击 = 选中，不飞镜头；双击 / F 才发定位命令；
 * - 拖动绕观察目标旋转、滚轮靠近远离、Shift+左键平移观察中心；
 * - 右键只负责节点菜单，右键拖动不旋转；
 * - 键盘只保留 F（定位），且只在画布持有操作焦点时生效；输入框 / 弹窗 / 输入法组合期间全部交还；
 * - 失焦、切后台、指针取消、组件卸载都清掉未完成的拖动。
 */
import {
  add,
  boundsOf,
  clamp,
  clampCameraDistance,
  clampPitch,
  fitDistance,
  orbitBasis,
  pickEdge,
  pickNode,
  scale,
  type Bounds,
} from "./camera.ts";
import type {
  CameraCommand,
  CameraState,
  ProjectedNode,
  Vec3,
  Viewport,
} from "./types.ts";
import { DRAG_THRESHOLD } from "./types.ts";

/** 定位动画时长（毫秒）；「减少动态效果」时降为 1ms */
const FOCUS_DURATION_MS = 620;

/**
 * 右键点到了什么。
 *
 * 三种目标对应三种菜单（节点 / 关系 / 空白）：用判别联合而不是「index 或 null」，
 * 是因为「点到了哪条线」与「点到了哪个球」在业务上是两件事，
 * 混成一个可空下标之后，调用方必然要靠额外的字段去猜。
 */
export type ContextHit =
  | { kind: "node"; index: number }
  | { kind: "edge"; index: number }
  | { kind: "canvas" };

export interface NavigationOptions {
  /** 画布容器：焦点、指针事件与事件目标的边界都以它为准 */
  element: HTMLElement;
  initial: CameraState;
  /** Ledge：定位距离的参考尺度 */
  edgeLength: number;
  getProjected(): ProjectedNode[];
  /**
   * 关系（连线）的端点下标。
   *
   * 拾取只需要 `{from, to}`：拿的是当前图的有向边，索引与 `getProjected()` 同一套。
   * 由引擎提供而不是让导航层认识 `SpaceGraph`——相机与输入仲裁不该依赖业务数据形状。
   */
  getEdges(): ReadonlyArray<{ from: number; to: number }>;
  onSelect(index: number | null): void;
  onHover(index: number | null): void;
  /** 悬停到一条关系（或离开）：界面据此显示「A → 前置 B · 右键断开」 */
  onEdgeHover?(index: number | null): void;
  /** 短点击选中一条关系（不改当前节点） */
  onSelectEdge?(index: number | null): void;
  onContextMenu(hit: ContextHit, clientX: number, clientY: number): void;
  onLocate(): void;
  onCameraChange(): void;
  /**
   * 用户自己动了相机（拖动 / 滚轮 / 平移）。
   *
   * 上层据此取消「布局结束后自动取景」：人已经找好角度了，就不该再被镜头拉走。
   */
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
  fromTarget: Vec3;
  toTarget: Vec3;
  fromDistance: number;
  toDistance: number;
}

export class SpaceNavigation {
  camera: CameraState;
  private pointer: PointerState | null = null;
  private animation: Animation | null = null;
  private suppressClick = false;
  private suppressedTimer: number | undefined;
  private disposed = false;
  private hover: number | null = null;
  /** 当前悬停的关系下标：与节点悬停并存（节点优先，见 hitTest） */
  private hoverEdge: number | null = null;
  private bounds: Bounds = boundsOf(new Float32Array(0), 0);
  private viewport: Viewport = { width: 800, height: 600 };

  constructor(private readonly options: NavigationOptions) {
    this.camera = options.initial;
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
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  /** 外部（每帧）更新：包围体与视口用于取景 */
  setFrameContext(bounds: Bounds, viewport: Viewport): void {
    this.bounds = bounds;
    this.viewport = viewport;
  }

  basis() {
    return orbitBasis(this.camera);
  }

  /* ------------------------------- 相机命令 ------------------------------- */

  /**
   * 相机命令：定位到节点 / 适应窗口。
   *
   * 业务 ID → 索引的换算由上层完成：布局与相机都只认索引，
   * 这样「命令里的 ID 和当前图不一致」不会被静默地当成另一个节点。
   */
  command(
    command: CameraCommand,
    index: number | null,
    positions: Float32Array,
    count: number,
  ): void {
    if (command.type === "fitAll") {
      this.fitAll(positions, count, true);
      return;
    }
    if (index === null || index < 0 || index >= count) return;
    this.focusOn(index, positions);
  }

  /** 「适应窗口」：包围体取景，留出浮层边距 */
  fitAll(positions: Float32Array, count: number, smooth: boolean): void {
    const bounds = boundsOf(positions, count);
    this.bounds = bounds;
    const insets = { top: 64, bottom: 64 };
    const distance = fitDistance(bounds.radius, this.viewport, 50, insets) * 1.08;
    this.animate(
      {
        target: bounds.center,
        distance: clampCameraDistance(distance, this.bounds.radius),
      },
      smooth,
    );
  }

  /** 对准某个节点：把环绕观察的观察中心移到它上面 */
  focusOn(index: number, positions: Float32Array): void {
    const target: Vec3 = [
      positions[index * 3] ?? 0,
      positions[index * 3 + 1] ?? 0,
      positions[index * 3 + 2] ?? 0,
    ];
    const distance = clamp(this.options.edgeLength * 2.6, 40, Math.max(60, this.bounds.radius));
    this.animate({ target, distance }, true);
  }

  /**
   * 每帧推进定位 / 取景动画。
   *
   * 返回 true 表示相机还在动——渲染循环据此决定是否继续跑；
   * 动画结束后不再产生运动，静止时不会持续占用 GPU。
   */
  update(now: number): boolean {
    if (this.disposed) return false;
    const animation = this.animation;
    if (!animation) return false;
    const t = clamp((now - animation.start) / animation.duration, 0, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    this.camera.target = lerp3(animation.fromTarget, animation.toTarget, eased);
    this.camera.distance = lerp(animation.fromDistance, animation.toDistance, eased);
    if (t >= 1) this.animation = null;
    this.options.onCameraChange();
    return true;
  }

  /* ------------------------------- 指针交互 ------------------------------- */

  private local(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.options.element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onPointerDown = (event: PointerEvent): void => {
    // 右键留给节点菜单：这里完全不参与相机
    if (event.button !== 0) return;
    this.options.element.focus({ preventScroll: true });
    this.animation = null; // 新输入打断动画
    const point = this.local(event);
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
    /*
     * 手型光标只在**真的按住拖动**时出现。
     *
     * 原来整个画布平时就是 `cursor: grab`：鼠标什么都没做，指针已经变成一只
     * 张开的手，像是在暗示「这里有东西可以抓」；而它其实只是个普通视图。
     * 现在按下左键就切 `grabbing`，松开/取消再切回去——拖动状态由这里的
     * 指针状态机说了算，不劳 CSS 猜。
     */
    this.options.element.dataset.dragging = "true";
  };

  private onPointerMove = (event: PointerEvent): void => {
    const point = this.local(event);
    const pointer = this.pointer;
    if (pointer && pointer.id === event.pointerId) {
      const dx = point.x - pointer.startX;
      const dy = point.y - pointer.startY;
      if (!pointer.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        pointer.moved = true;
        /*
         * 真的开始拖了才捕获指针：在 pointerdown 就捕获会把随后的 click
         * 一并重定向到容器上，节点自己的点击永远收不到。
         */
        this.options.element.setPointerCapture(event.pointerId);
        pointer.captured = true;
      }
      if (pointer.moved) {
        const stepX = point.x - pointer.lastX;
        const stepY = point.y - pointer.lastY;
        if (pointer.panning) this.pan(stepX, stepY);
        else this.rotate(stepX, stepY);
        this.setHover(null);
      }
      pointer.lastX = point.x;
      pointer.lastY = point.y;
      return;
    }
    // 没在拖动时才更新悬停：拖动越过节点不应该频繁弹出信息
    this.applyHover(this.hitTest(point.x, point.y));
  };

  /**
   * 命中哪一个目标：**节点优先，其次关系，最后空白**。
   *
   * 节点优先是必须的：球体总是压在连线的端点上，如果按"更近的线"取胜，
   * 用户点节点时会被自己那条线抢走。关系的命中带宽写死在 `pickEdge` 里。
   */
  private hitTest(x: number, y: number): ContextHit {
    const projected = this.options.getProjected();
    const node = pickNode(projected, x, y);
    if (node !== null) return { kind: "node", index: node };
    const edge = pickEdge(projected, this.options.getEdges(), x, y);
    if (edge !== null) return { kind: "edge", index: edge };
    return { kind: "canvas" };
  }

  /** 把一次命中翻译成节点悬停 + 关系悬停两组回调（各自只在变化时通知） */
  private applyHover(hit: ContextHit): void {
    this.setHover(hit.kind === "node" ? hit.index : null);
    this.setEdgeHover(hit.kind === "edge" ? hit.index : null);
  }

  private onPointerUp = (event: PointerEvent): void => {
    const pointer = this.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    this.pointer = null;
    delete this.options.element.dataset.dragging;
    if (pointer.captured && this.options.element.hasPointerCapture(event.pointerId)) {
      this.options.element.releasePointerCapture(event.pointerId);
    }
    if (pointer.moved) {
      // 拖动之后浏览器还会补一次 click：用它拦住"转一下顺便换了当前节点"
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
      // 短点击节点 = 选中它，不飞镜头
      this.options.onSelect(hit.index);
      this.options.onSelectEdge?.(null);
      return;
    }
    if (hit.kind === "edge") {
      /*
       * 短点击一条关系 = 选中它。**不改当前节点**：
       * 「我在看哪条依赖」与「我正在学哪个知识点」是两件事，
       * 点一下线就把当前知识点换掉，读对话时会被莫名其妙地带走。
       */
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
    if (!this.pointer) {
      this.setHover(null);
      this.setEdgeHover(null);
    }
  };

  private onDoubleClick = (event: MouseEvent): void => {
    if (this.suppressClick) return;
    const point = this.local(event);
    const hit = this.hitTest(point.x, point.y);
    if (hit.kind === "edge") {
      // 双击一条关系没有"定位"的语义（对象是一条线，不是一个点）：只选中它
      this.options.onSelectEdge?.(hit.index);
      return;
    }
    const node = hit.kind === "node" ? hit.index : null;
    this.options.onSelect(node);
    // 双击允许首次点击已经选过一次，但定位命令只发一次
    if (node !== null) this.options.onLocate();
  };

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    const point = this.local(event);
    const hit = this.hitTest(point.x, point.y);
    /*
     * 三种右键都要上报（含空白）：三维视图里的「新建知识点」在空白处，
     * 「断开前置关系」在连线上，节点菜单在球上。
     */
    if (hit.kind === "node") this.options.onSelect(hit.index);
    if (hit.kind === "edge") this.options.onSelectEdge?.(hit.index);
    // 打开菜单前取消进行中的拖动：菜单期间的指针移动不该继续转相机
    this.cancelPointer();
    this.options.onContextMenu(hit, event.clientX, event.clientY);
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.animation = null;
    this.options.onUserCameraInput?.();
    const delta = clamp(event.deltaY * (event.deltaMode === 1 ? 18 : 1) * 0.001, -0.28, 0.28);
    // 滚轮只改观察距离，不改 FOV、不改 CSS 缩放
    this.camera.distance = clampCameraDistance(
      this.camera.distance * Math.exp(delta * 1.6),
      this.bounds.radius,
    );
    this.options.onCameraChange();
  };

  /** 拖动旋转：绕观察目标转 */
  private rotate(dx: number, dy: number): void {
    this.options.onUserCameraInput?.();
    this.camera.angle -= dx * 0.006;
    this.camera.pitch = clampPitch(this.camera.pitch + dy * 0.006);
    this.options.onCameraChange();
  }

  /** Shift+左键：在相机右/上方向上平移观察中心（进阶手势） */
  private pan(dx: number, dy: number): void {
    this.options.onUserCameraInput?.();
    const basis = orbitBasis(this.camera);
    const unit = this.camera.distance * 0.0016;
    this.camera.target = add(
      this.camera.target,
      add(scale(basis.right, -dx * unit), scale(basis.up, dy * unit)),
    );
    this.options.onCameraChange();
  }

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
    /*
     * F 定位选中节点；但只在画布持有焦点时生效，
     * 否则「在输入框里打 f」会变成飞镜头。
     */
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

  /**
   * 丢掉未完成的拖动。
   *
   * 指针事件被别处抢走（切后台、窗口失焦、pointercancel、右键菜单弹出）时，
   * 不清理的话 `pointer` 会一直停在「正在拖」，下一次移动会突然转一下相机。
   */
  cancelPointer(): void {
    this.pointer = null;
    // 拖拽状态也要一起清掉，否则手型光标会一直挂着
    delete this.options.element.dataset.dragging;
  }

  /* ------------------------------- 动画 ------------------------------- */

  private reducedMotion(): boolean {
    return (
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  private animate(to: { target: Vec3; distance: number }, smooth: boolean): void {
    const duration = smooth && !this.reducedMotion() ? FOCUS_DURATION_MS : 1;
    this.animation = {
      start: performance.now(),
      duration,
      fromTarget: [...this.camera.target],
      toTarget: [...to.target],
      fromDistance: this.camera.distance,
      toDistance: to.distance,
    };
    this.options.onCameraChange();
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
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.suppressedTimer !== undefined) window.clearTimeout(this.suppressedTimer);
    this.pointer = null;
    this.animation = null;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
