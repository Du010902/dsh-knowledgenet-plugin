/**
 * 空间视图的运行时（帧循环、标签层、布局客户端、相机）
 *
 * React 只负责挂载画布、转发命令与显示浮层；真正每帧变化的东西都在这里，
 * 因为「逐帧 setState」是这类视图最典型的性能陷阱：
 * 坐标、标签位置、相机都不进 React 状态，只有状态文案与悬停信息才进。
 *
 * 生命周期要求（《空间图谱技术方案》9.3）：
 * - 卸载时清理 RAF、Worker、监听器、ResizeObserver、几何/材质/纹理与标签 DOM；
 * - 静止（相机不动、布局停、无动画）时不继续渲染，页面隐藏时停止本轮布局；
 * - WebGL 上下文丢失时停止绘制并报告，由外层给出重试与回退路径。
 */
import { boundsOf, type Bounds } from "./camera.ts";
import { buildSpaceGraph, relatedSet, type SpaceGraph } from "./adapter.ts";
import { LayoutClient, type LayoutStatusDetail } from "./layoutClient.ts";
import { planLabels } from "./labels.ts";
import { readPalette, watchPalette, type SpacePalette } from "./palette.ts";
import { SpaceNavigation, type ContextHit } from "./navigation.ts";
import { SpaceRenderer, webgl2Available } from "./renderer.ts";
import {
  alignedCachedPositions,
  cachedCamera,
  cachedLayoutReusable,
  cachedLayoutSignature,
  dropLayoutCache,
  isLayoutCacheUsable,
  spaceEpoch,
  storeCamera,
  storeLayout,
} from "./session.ts";
import { buildTopology, initialPositions, mergePositions } from "./topology.ts";
import {
  DEFAULT_LAYOUT_PARAMS,
  type CameraCommand,
  type CameraState,
  type LabelCandidate,
  type LabelDensity,
  type LayoutStatus,
  type ProjectedNode,
  type Viewport,
} from "./types.ts";
import type { GraphSnapshot } from "@/data/types";

export { DEFAULT_LAYOUT_PARAMS };

/** 垂直视场角：45–60° 之间的初始试调值 */
const FOV_DEG = 50;
/** 读不到 --font 时的兜底字体栈（正常情况下用样式表里的那一份） */
const FALLBACK_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
/** 「视野外」判定留出的边距（CSS 像素） */
const OFFSCREEN_MARGIN = 24;
/** 会话缓存的写入间隔：坐标没变就没必要每帧复制一份大数组 */
const CACHE_STORE_INTERVAL_MS = 250;
/** 没有节点时的包围体：常量复用，避免空图时每帧新建数组 */
const EMPTY_BOUNDS: Bounds = boundsOf(new Float32Array(0), 0);

/**
 * 标签测量用的字体栈。
 *
 * 与 `.universe-label` 实际使用的字体必须一致：不一致会让「测出来的宽度」
 * 和「画出来的宽度」对不上，冲突检测随之失准。因此直接读样式表上的 `--font`，
 * 而不是在这里再抄一份（抄的那份漏掉几个字族就会悄悄失准）。
 */
function readFontStack(): string {
  if (typeof document === "undefined") return FALLBACK_FONT_STACK;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--font").trim();
  return value || FALLBACK_FONT_STACK;
}

export interface HoverInfo {
  index: number;
  title: string;
  status: "todo" | "learning" | "done";
  prerequisites: number;
  /** 直接关系数（出入度之和）：参考图的提示条写的是「N 条直接关系」 */
  degree: number;
  x: number;
  y: number;
}

/**
 * 关系（连线）的悬停信息。
 *
 * 只有两端标题与屏幕位置：它要回答的是「这条线连着哪两个知识点」，
 * 与节点的 `HoverInfo`（状态、度数）不是同一类信息，因此单独一条回调。
 */
export interface EdgeHoverInfo {
  id: string;
  from: string;
  to: string;
  x: number;
  y: number;
}

export interface SpaceEngineOptions {
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  labelLayer: HTMLElement;
  onStatus(status: LayoutStatus, detail: LayoutStatusDetail): void;
  onHover(info: HoverInfo | null): void;
  /** 短点击选中的节点（null = 点在空白处） */
  onSelect(index: number | null): void;
  /** 悬停到一条关系：界面据此显示「A → 前置 B · 右键断开」 */
  onEdgeHover(info: EdgeHoverInfo | null): void;
  /** 短点击选中一条关系（不改当前节点） */
  onSelectEdge(id: string | null): void;
  /**
   * 右键：`hit` 说明点到了节点、关系还是空白（三种目标对应三个菜单）。
   * 空白处用来新建知识点；关系上用来断开前置关系。
   */
  onContextMenu(hit: ContextHit, clientX: number, clientY: number): void;
  /** F / 双击：请求对当前选中节点发一条定位命令 */
  onLocateRequest(): void;
  onSelectedOffscreen(offstage: boolean): void;
  onContextLost(): void;
}

interface LabelSlot {
  element: HTMLSpanElement;
  id: string;
  text: string;
  x: number;
  y: number;
  tone: string;
  font: number;
  weight: number;
}

export class SpaceEngine {
  private readonly renderer: SpaceRenderer;
  private readonly navigation: SpaceNavigation;
  private readonly layout: LayoutClient;
  private readonly resizeObserver: ResizeObserver;
  private readonly stopThemeWatch: () => void;
  private readonly measureContext: CanvasRenderingContext2D | null;
  private readonly fontStack = readFontStack();
  private readonly measureCache = new Map<string, number>();
  private readonly labelSlots: LabelSlot[] = [];

  private graph: SpaceGraph | null = null;
  /** 显式标注为 Float32Array（缓冲区来源不敏感）：主线程副本、Worker 转移、内部插值缓冲都往这里放 */
  private positions: Float32Array = new Float32Array(0);
  private viewport: Viewport = { width: 800, height: 600 };
  private palette: SpacePalette;
  private selected: number | null = null;
  private hover: number | null = null;
  /**
   * 关系（连线）的悬停与选中。
   *
   * 按 **ID** 记而不是按下标：图每变一次（新增/删除一条关系）`edges` 的下标都会重排，
   * 按下标记会让「刚才选中的那条线」悄悄变成另一条。渲染时再翻成下标。
   */
  private hoveredEdgeId: string | null = null;
  private selectedEdgeId: string | null = null;
  private hoveredEdge: number | null = null;
  private selectedEdge: number | null = null;
  private related: Set<number> = new Set();
  private retained = new Set<string>();
  private labelDensity: LabelDensity = "smart";
  private raf: number | null = null;
  private needsFrame = false;
  /** 正在执行的这一帧：帧内不再排新回调，帧末是唯一的排程点 */
  private inFrame = false;
  private lastCacheStore = 0;
  private disposed = false;
  private layoutAnimating = false;
  private cameraSaveTimer: number | undefined;
  private hidden = false;

  private selectedOffstage = false;
  private pendingInitialFit = false;
  /** 相机是否来自缓存（可沿用的使用者视角）；决定布局稳定后要不要重新取景 */
  private readonly cameraRestored: boolean = false;
  /**
   * 布局收敛后要再做一次取景。
   *
   * 不能在 `onStatus("settled")` 的回调里直接取景：那一刻**这一帧的坐标还没应用**
   * （最终坐标是下一帧从 `layout.currentPositions()` 拿到的），于是会拿初始分布
   * 去算距离——初始云团比收敛后的图松散得多，结果是稀疏小图被推得很远，
   * 画布中间缩成一小团（验收清单 P2-4 描述的正是这个现象）。
   * 因此只在这里立一个标记，真正的取景放到 `renderFrame` 里、坐标刷新之后。
   */
  private pendingSettleFit = false;
  /** 布局稳定后是否还要自动取景（用户一动相机就关掉，不再抢镜头） */
  private autoFit = false;
  /** 自动取景实际发生了几次：浏览器自检用它盯住「切回空间不该再被拉镜头」 */
  private autoFitCount = 0;
  /** 当前这份坐标是否已经收敛（写进会话缓存，供下次直接沿用） */
  private layoutSettled = false;

  constructor(private readonly options: SpaceEngineOptions) {
    this.palette = readPalette();
    this.renderer = new SpaceRenderer(options.canvas, this.palette);
    this.measureContext = document.createElement("canvas").getContext("2d");

    const restored = cachedCamera();
    /** 相机能不能沿用：决定布局稳定后要不要重新取景（见 startLayout） */
    this.cameraRestored = restored !== null;
    const initial: CameraState = restored ?? {
      /*
       * 默认视角略微俯视（约 17°）：pitch 太小的话纵深方向几乎正对相机，
       * 三维云团看起来会像一张平面图。
       */
      target: [0, 0, 0],
      distance: 340,
      angle: -0.35,
      pitch: 0.3,
    };
    this.navigation = new SpaceNavigation({
      element: options.host,
      initial,
      edgeLength: DEFAULT_LAYOUT_PARAMS.edgeLength,
      getProjected: () => this.renderer.project(this.navigation.basis(), this.viewport, FOV_DEG),
      // 拾取只认 `{from, to}` 下标；图还没同步时给空数组（此时没有任何东西可点）
      getEdges: () => this.graph?.edges ?? [],
      onSelect: (index) => this.handleSelect(index),
      onHover: (index) => this.handleHover(index),
      onSelectEdge: (index) => this.handleSelectEdge(index),
      onEdgeHover: (index) => this.handleEdgeHover(index),
      onContextMenu: (hit, clientX, clientY) => {
        if (this.graph) options.onContextMenu(hit, clientX, clientY);
      },
      onLocate: () => options.onLocateRequest(),
      // 用户自己动了相机：取消「布局稳定后自动取景」
      onUserCameraInput: () => {
        this.autoFit = false;
      },
      onCameraChange: () => {
        this.scheduleCameraSave();
        this.wake();
      },
    });

    this.layout = new LayoutClient({
      onFrame: () => this.wake(),
      onStatus: (status, detail) => {
        this.layoutAnimating = status === "settling" || status === "forming";
        if (status === "settled") {
          /*
           * 「收敛」「沿用」以及「用完预算」都算有效结果，可以记下来复用。
           *
           * 预算结束（迭代上限或时间上限）本身就是一个合法的结束状态：坐标有效、
           * 只是没到数学上的平衡点。把时间上限排除在外会让「切回来还在原位」
           * 变成机器速度的函数——同一张图在慢机器上每次往返都要重算一遍。
           * 想再花一轮预算就点「重新整理」。
           * 被取消（切后台、卸载时停掉的那一轮）不算：那说明计算才走了一半。
           */
          this.layoutSettled =
            detail.reason === "stable" ||
            detail.reason === "reused" ||
            detail.reason === "budget";
          if (this.graph) {
            storeLayout(this.graph.ids, this.positions, this.graph.signature, this.layoutSettled);
          }
        }
        /*
         * 布局稳定后再自动取景一次。
         *
         * 初始坐标只是「紧凑云团」的起点，真实布局往往舒展得更大；
         * 只在第一帧取景会让稳定后的节点跑到画面外。用户一旦自己动过相机，
         * autoFit 就关掉了，这里不会再抢镜头。
         *
         * 只立标记、不当场取景：这一帧的坐标还是旧的，见 `pendingSettleFit` 的说明。
         */
        if (status === "settled" && this.autoFit) {
          this.autoFit = false;
          this.autoFitCount += 1;
          this.pendingSettleFit = true;
          this.wake();
        }
        options.onStatus(status, detail);
      },
    });

    this.resizeObserver = new ResizeObserver(() => this.measureHost());
    this.resizeObserver.observe(options.host);
    this.stopThemeWatch = watchPalette(() => this.handleThemeChange());
    options.canvas.addEventListener("webglcontextlost", this.onContextLost);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.measureHost();

    // 「缓存不存在或整库被替换」时才做初始全图取景；有缓存就沿用上次视角
    if (!restored) {
      this.pendingInitialFit = true;
      this.autoFit = true;
    }
    this.installDebugHook();
    this.wake();
  }

  /**
   * 开发期调试钩子（生产构建里被 `import.meta.env.DEV` 静态消除）。
   *
   * 浏览器自检（scripts/space-check.mjs）要断言的是「相机到底动没动」，
   * 靠标签位置反推并不可靠：节点进出视野会让标签集合变化，反推会把
   * 「换了视野」误判成「没动」。这里把相机状态原样暴露给开发环境。
   */
  private installDebugHook(): void {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    /**
     * 一条关系在屏幕上的两个端点（拾取用的那份投影）。
     *
     * 抽成闭包是因为要在多处复用：`edgeScreenPoint` 取中点，
     * 自检脚本则可以沿线多试几个落点（短边中点可能落在球体命中圈里）。
     */
    const debugEdgeSegment = (edgeId: string): { a: { x: number; y: number }; b: { x: number; y: number } } | null => {
      const index = this.graph?.edgeIndexById.get(edgeId);
      if (index === undefined || !this.graph) return null;
      const edge = this.graph.edges[index]!;
      const projected = this.renderer.project(this.navigation.basis(), this.viewport, FOV_DEG);
      const a = projected[edge.from];
      const b = projected[edge.to];
      if (!a || !b || !a.visible || !b.visible) return null;
      return { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
    };
    (window as unknown as Record<string, unknown>).__KN_SPACE__ = {
      camera: () => this.navigation.camera,
      status: () => this.layout.currentStatus,
      positionOf: (id: string) => {
        const index = this.graph?.indexById.get(id);
        if (index === undefined) return null;
        return [
          this.positions[index * 3] ?? 0,
          this.positions[index * 3 + 1] ?? 0,
          this.positions[index * 3 + 2] ?? 0,
        ];
      },
      labelCount: () => this.labelSlots.filter((slot) => !slot.element.hidden).length,
      autoFits: () => this.autoFitCount,
      autoFitArmed: () => this.autoFit,
      layoutSettled: () => this.layoutSettled,
      cachedSignature: () => cachedLayoutSignature(),
      /**
       * 当前坐标的包围球半径。
       *
       * 自检要判断「稀疏小图有没有把画布填满」：这个数与相机距离一起
       * 决定投影后占画布短边多少，是「构图是否过小」唯一可量化的口径。
       */
      boundsRadius: () => boundsOf(this.positions, this.graph?.ids.length ?? 0).radius,
      /**
       * 当前图里的节点 ID（按渲染索引顺序）。
       *
       * 三维视图的 DOM 里没有节点 ID（标签只有文字），自检要指着某个节点
       * 断言坐标时就得从这里取——否则它只能先切到二维卡片去读，那一步
       * 会让引擎挂载/卸载一轮，测出来的取景就不是「首次进入」的那一次了。
       */
      ids: () => [...(this.graph?.ids ?? [])],
      /**
       * 一条关系在屏幕上的位置（两端投影点的中点）。
       *
       * 自检脚本要点右键命中一条线，必须落在**与拾取同一口径**的位置上：
       * 自己按相机矩阵重算一遍既重复又容易偏，这里直接把拾取用的那份投影交出来。
       */
      edgeScreenPoint: (edgeId: string) => {
        const segment = debugEdgeSegment(edgeId);
        if (!segment) return null;
        return { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 };
      },
      /**
       * 一条关系**两个端点**的屏幕坐标。
       *
       * 自检要点中一条线，最稳的落点是两个端点的中点；但短边或密集图里，
       * 中点可能落在某个球体的命中半径内（那时节点优先，点不到线）。
       * 因此把整段交出去，让脚本沿线找几个落点，而不是写死一个坐标。
       */
      edgeScreenSegment: debugEdgeSegment,
      edgeIds: () => [...(this.graph?.edges.map((edge) => edge.id) ?? [])],
      hoveredEdge: () =>
        this.hoveredEdge !== null ? (this.graph?.edges[this.hoveredEdge]?.id ?? null) : null,
      selectedEdge: () =>
        this.selectedEdge !== null ? (this.graph?.edges[this.selectedEdge]?.id ?? null) : null,
      /** 当前悬停的节点（自检排查用：悬停被节点抢走时能看出来） */
      hoveredNode: () => (this.hover !== null ? (this.graph?.ids[this.hover] ?? null) : null),
    };
  }

  /* ------------------------------- 图数据 ------------------------------- */

  /**
   * 用最新的知识图数据刷新视图。
   *
   * 结构签名只含节点 ID 与边端点：改标题、改状态、切选中都不会重算布局，
   * 因此空间记忆不会被无关操作打乱。
   */
  syncGraph(ws: GraphSnapshot, rootId: string | null, focusId: string | null): void {
    if (this.disposed) return;
    const graph = buildSpaceGraph(ws, rootId, DEFAULT_LAYOUT_PARAMS.nodeRadius);
    const previousGraph = this.graph;
    const structureChanged =
      !previousGraph ||
      previousGraph.signature !== graph.signature ||
      previousGraph.ids.length !== graph.ids.length;

    this.graph = graph;
    if (structureChanged) {
      this.renderer.setGraph(graph);
      this.startLayout(graph);
    } else {
      this.renderer.refreshGraphData(graph);
    }
    this.applyFocus(graph, focusId);
    this.wake();
  }

  /**
   * 开始（或继续）一轮布局。
   *
   * 缓存坐标一律按 ID 对齐后带上：组件重新挂载（切到二维再切回来）不算「整库被替换」，
   * 从头再摆一遍会让画面跳一下、还要白等一次完整布局。认不出的节点由缓存层写成 NaN，
   * Worker 会把它们当新点处理；整库确实换了（导入备份）时缓存已被显式清空，这里自然拿不到。
   */
  private startLayout(graph: SpaceGraph): void {
    const count = graph.ids.length;
    if (count === 0) {
      this.positions = new Float32Array(0);
      this.layoutAnimating = false;
      // 空图不该留着上一轮还在跑的 Worker
      this.layout.cancel();
      return;
    }
    const topology = buildTopology(graph.ids, graph.layoutPairs, { distances: false });
    const initial = initialPositions(topology, DEFAULT_LAYOUT_PARAMS);
    const cached = isLayoutCacheUsable(graph.ids) ? alignedCachedPositions(graph.ids) : null;
    this.positions = mergePositions(initial, cached);

    /*
     * 结构没变、上次又已经收敛：直接沿用那份坐标，不开 Worker。
     *
     * 这就是「切到二维再切回来」的常见路径——它不是结构变化，重跑一轮布局
     * 只会让节点在镜头没动的情况下挪一下（实测一个节点会挪动近一条边长）。
     * 结构变了（新增/删除节点或关系）才真的需要继续算。
     *
     * 相机则分两种：能沿用（`cameraRestored`，布局收敛时存下的）就一动不动；
     * 沿用时**不**自动取景，否则等于把使用者的视角强行拉走。
     */
    if (cached && cachedLayoutReusable(graph.signature)) {
      this.autoFit = false;
      if (!this.cameraRestored) this.pendingSettleFit = true;
      this.layoutAnimating = false;
      this.layoutSettled = true;
      this.options.onStatus("settled", { iterations: 0, reason: "reused" });
      this.wake();
      return;
    }

    /*
     * 布局稳定后要不要自动取景，只看「相机能不能沿用」：
     * - 能沿用：使用者上次摆好的视角，谁都不许动；
     * - 不能沿用（第一次进来，或上次那份是布局还没收敛时存的）：稳定后重新取景。
     * 用坐标缓存来判断是错的——相机可能只是对着还没收敛的初始云团被摆在那儿。
     */
    this.autoFit = !this.cameraRestored;
    this.layoutAnimating = true;
    this.layoutSettled = false;
    this.layout.start(
      {
        epoch: spaceEpoch(),
        topologyRevision: revisionOf(graph.signature),
        ids: graph.ids,
        edges: graph.layoutPairs,
        previous: cached,
        params: DEFAULT_LAYOUT_PARAMS,
      },
      this.positions,
    );
  }

  /* ------------------------------- 焦点与选中 ------------------------------- */

  private applyFocus(graph: SpaceGraph, focusId: string | null): void {
    const index = focusId !== null ? (graph.indexById.get(focusId) ?? null) : null;
    this.selected = index;
    this.related = relatedSet(graph, index);
    this.resolveEdges(graph);
    this.syncEmphasis();
  }

  /**
   * 按 ID 把关系的悬停 / 选中翻成下标。
   *
   * 图结构变化之后必须重算：`edges` 的下标会变，ID 不会。
   * 找不到的 ID（那条关系被断开了）直接落空——高亮不该指向别的关系。
   */
  private resolveEdges(graph: SpaceGraph): void {
    this.hoveredEdge =
      this.hoveredEdgeId !== null ? (graph.edgeIndexById.get(this.hoveredEdgeId) ?? null) : null;
    this.selectedEdge =
      this.selectedEdgeId !== null ? (graph.edgeIndexById.get(this.selectedEdgeId) ?? null) : null;
  }

  private syncEmphasis(): void {
    this.renderer.setEmphasis(
      this.selected,
      this.hover,
      this.related,
      this.hoveredEdge,
      this.selectedEdge,
    );
  }

  /** 外部（例如画布切到另一个节点）改变了当前节点 */
  setFocus(focusId: string | null): void {
    if (this.disposed || !this.graph) return;
    this.applyFocus(this.graph, focusId);
    this.wake();
  }

  /**
   * 外部（画布）改变了被选中的关系。
   *
   * 画布持有唯一的那份选中状态，引擎只负责渲染它；这条入口是为了让
   * 「在二维视图里选中的线，切到三维还亮着」——同一条关系在两个视图里是同一条。
   */
  setSelectedEdge(edgeId: string | null): void {
    if (this.disposed || !this.graph) return;
    if (this.selectedEdgeId === edgeId) return;
    this.selectedEdgeId = edgeId;
    this.resolveEdges(this.graph);
    this.syncEmphasis();
    this.wake();
  }

  private handleSelect(index: number | null): void {
    if (!this.graph) return;
    /*
     * 点在空白处不清空当前节点：与二维聚焦一致——「点空一下」不该让人丢掉
     * 正在看的知识点，右栏内容也随之消失。要换节点就点节点或左侧列表。
     */
    if (index === null) {
      this.options.onSelect(null);
      return;
    }
    // 先就地更新高亮，再通知上层：选中的反馈不该等一次 Store 往返
    this.selected = index;
    this.related = relatedSet(this.graph, index);
    this.syncEmphasis();
    this.wake();
    this.options.onSelect(index);
  }

  /** 短点击一条关系：选中它（不改当前节点），并把选中状态交回画布 */
  private handleSelectEdge(index: number | null): void {
    if (!this.graph) return;
    const id = index === null ? null : (this.graph.edges[index]?.id ?? null);
    this.selectedEdgeId = id;
    this.resolveEdges(this.graph);
    this.syncEmphasis();
    this.wake();
    this.options.onSelectEdge(id);
  }

  private handleEdgeHover(index: number | null): void {
    if (!this.graph) return;
    const id = index === null ? null : (this.graph.edges[index]?.id ?? null);
    this.hoveredEdgeId = id;
    this.resolveEdges(this.graph);
    this.syncEmphasis();
    if (id === null) {
      this.options.onEdgeHover(null);
      this.wake();
      return;
    }
    const edge = this.graph.edges[index!]!;
    const projected = this.renderer.project(this.navigation.basis(), this.viewport, FOV_DEG);
    const a = projected[edge.from];
    const b = projected[edge.to];
    this.options.onEdgeHover({
      id,
      from: this.graph.titles[edge.from] ?? "",
      to: this.graph.titles[edge.to] ?? "",
      // 提示条摆在两个端点的屏幕中点：贴着线，也不压住球体本身
      x: a && b ? (a.x + b.x) / 2 : (a?.x ?? 0),
      y: a && b ? (a.y + b.y) / 2 : (a?.y ?? 0),
    });
    this.wake();
  }

  private handleHover(index: number | null): void {
    if (!this.graph) return;
    this.hover = index;
    this.syncEmphasis();
    if (index === null) {
      this.options.onHover(null);
    } else {
      const projected = this.renderer.project(this.navigation.basis(), this.viewport, FOV_DEG)[index];
      this.options.onHover({
        index,
        title: this.graph.titles[index] ?? "",
        status: this.graph.statuses[index] ?? "todo",
        prerequisites: this.graph.prerequisites[index] ?? 0,
        degree: this.graph.neighbors[index]?.length ?? 0,
        x: projected?.x ?? 0,
        y: projected?.y ?? 0,
      });
    }
    this.wake();
  }

  /* ------------------------------- 命令 ------------------------------- */

  /**
   * 重新整理布局。
   *
   * 丢掉缓存的坐标，从确定性初始分布重新算一轮（相机保持不动——人正在看某处，
   * 不该被顺手拉走）。设计里「允许用户以后重新整理」指的就是这个入口。
   */
  relayout(): void {
    if (this.disposed || !this.graph || this.graph.ids.length === 0) return;
    dropLayoutCache();
    this.startLayout(this.graph);
    // 只是重排布局：相机是使用者当前的观看位置，不该顺手拉走
    this.autoFit = false;
    this.wake();
  }

  setLabelDensity(density: LabelDensity): void {
    this.labelDensity = density;
    this.retained.clear(); // 换密度立刻重排，不做保留
    this.wake();
  }

  /** 「适应窗口」/「定位」命令由外层用递增的 token 触发 */
  runCommand(command: CameraCommand, focusId: string | null): void {
    if (this.disposed || !this.graph) return;
    /*
     * 命令自带的 nodeId 优先：它是「发命令那一刻」的目标，
     * 不受其后选中变化影响（否则一次单击就会被上一条定位命令带飞）。
     */
    const target = command.nodeId ?? focusId;
    const index = target !== null ? (this.graph.indexById.get(target) ?? null) : null;
    // 用户明确要求了取景方式：布局稳定后不要再自动拉镜头
    this.autoFit = false;
    this.navigation.command(command, index, this.positions, this.graph.ids.length);
    this.wake();
  }

  /* ------------------------------- 帧循环 ------------------------------- */

  private wake = (): void => {
    if (this.disposed || this.hidden) return;
    this.needsFrame = true;
    /*
     * 只在「没有待执行的帧、也没有正在执行的帧」时排下一帧。
     *
     * 少了 `!this.inFrame` 这一条，帧内任何 wake（相机动了、布局来了新快照）都会再排
     * 一个回调，而帧末又会排一个：待执行回调每帧翻倍，一个 600ms 的定位动画就能把页面拖死。
     * 帧末是唯一的排程点。
     */
    if (this.raf === null && !this.inFrame) this.raf = requestAnimationFrame(this.loop);
  };

  private loop = (now: number): void => {
    this.raf = null;
    this.inFrame = true;
    /*
     * 无论这一帧正常结束还是中途抛异常，inFrame 都必须复位：
     * 否则 wake() 从此不再排帧，整个视图会一直停在那张画面上。
     */
    try {
      if (!this.disposed) this.renderFrame(now);
    } finally {
      this.inFrame = false;
    }
  };

  private renderFrame(now: number): void {
    this.needsFrame = false;

    const graph = this.graph;
    const count = graph?.ids.length ?? 0;

    const interpolated = this.layout.currentPositions();
    if (interpolated && interpolated.length === count * 3) this.positions = interpolated;
    if (count > 0) this.renderer.setPositions(this.positions);

    const bounds = count > 0 ? boundsOf(this.positions, count) : EMPTY_BOUNDS;
    if (this.pendingInitialFit && count > 0) {
      this.pendingInitialFit = false;
      this.navigation.fitAll(this.positions, count, false);
    }
    /*
     * 收敛后的取景：放在坐标刷新之后（`this.positions` 刚被这一帧的插值结果替换），
     * 否则量的是上一轮分布。
     */
    if (this.pendingSettleFit && count > 0) {
      this.pendingSettleFit = false;
      this.navigation.fitAll(this.positions, count, true);
    }

    this.navigation.setFrameContext(bounds, this.viewport);
    const cameraMoving = this.navigation.update(now);
    const basis = this.navigation.basis();
    this.renderer.render(basis, this.viewport, FOV_DEG, bounds);

    const projected = count > 0 ? this.renderer.project(basis, this.viewport, FOV_DEG) : [];
    this.syncLabels(projected);
    this.syncOffstage(projected);

    const layoutMoving = this.layout.animating;
    if (count > 0 && (this.layoutAnimating || layoutMoving)) {
      /*
       * 布局在推进：把最新坐标写进会话缓存（节流，不必每帧复制一份大数组）。
       * 卸载时还会再存一次最终坐标，所以这里的间隔不影响「切回来还在原位」。
       */
      if (now - this.lastCacheStore >= CACHE_STORE_INTERVAL_MS) {
        this.lastCacheStore = now;
        storeLayout(graph!.ids, this.positions, graph!.signature, this.layoutSettled);
      }
    }
    if (
      !this.disposed &&
      (cameraMoving || layoutMoving || this.layoutAnimating || this.needsFrame)
    ) {
      this.raf = requestAnimationFrame(this.loop);
    }
  };

  /* ------------------------------- 标签层 ------------------------------- */

  private measureText(text: string, font: number, weight: number): number {
    const key = `${weight}|${font}|${text}`;
    const cached = this.measureCache.get(key);
    if (cached !== undefined) return cached;
    let width = text.length * font * 0.95; // 没有 2D 上下文时的兜底估算
    if (this.measureContext) {
      this.measureContext.font = `${weight} ${font}px ${this.fontStack}`;
      width = this.measureContext.measureText(text).width;
    }
    if (this.measureCache.size > 4000) this.measureCache.clear();
    this.measureCache.set(key, width);
    return width;
  }

  /**
   * 标签同步：**只写变化的那些元素**。
   *
   * 逐帧给几十个 span 写 textContent/transform 会让布局与样式计算吃掉大量时间，
   * 因此先比后写，并且只维护一个复用池（不每个节点建卡片）。
   */
  private syncLabels(projected: ProjectedNode[]): void {
    const graph = this.graph;
    if (!graph) return;
    const candidates: LabelCandidate[] = [];
    for (const node of projected) {
      if (!node.visible) continue;
      const related = this.related.has(node.index);
      const isSelected = node.index === this.selected;
      const isHover = node.index === this.hover;
      if (!isSelected && !isHover && !related) continue; // 普通节点由预算决定，先只看相关的
      candidates.push(this.candidateFor(node, isSelected, isHover, related));
    }
    // 普通节点：只把当前视野内最近的若干个纳入候选，剩下的交给预算
    const normals = projected
      .filter((node) => node.visible && !this.related.has(node.index))
      .sort((a, b) => a.depth - b.depth)
      .slice(0, 120);
    for (const node of normals) {
      candidates.push(this.candidateFor(node, false, false, false));
    }

    const plan = planLabels(
      {
        candidates,
        viewport: this.viewport,
        density: this.labelDensity,
        /*
         * 让开顶部状态条（top: 55）与底部提示/控件（约 44px 高、bottom: 24）：
         * 标签钻到浮层下面等于没显示。
         */
        inset: { top: 58, bottom: 56 },
        measure: (text, font, weight) => this.measureText(text, font, weight),
      },
      this.retained,
    );

    const layer = this.options.labelLayer;
    plan.placements.forEach((placement, index) => {
      const slot = this.labelSlots[index] ?? this.createSlot(layer);
      if (
        slot.id !== placement.id ||
        slot.text !== placement.text ||
        slot.tone !== placement.tone ||
        slot.font !== placement.font ||
        slot.weight !== placement.weight
      ) {
        slot.element.textContent = placement.text;
        slot.element.className = `universe-label is-${placement.tone}`;
        slot.element.style.fontSize = `${placement.font}px`;
        slot.element.style.fontWeight = String(placement.weight);
        slot.id = placement.id;
        slot.text = placement.text;
        slot.tone = placement.tone;
        slot.font = placement.font;
        slot.weight = placement.weight;
      }
      if (slot.x !== placement.x || slot.y !== placement.y) {
        /*
         * 标签整体比锚点再下移 3px。
         *
         * 参考图给的 `y = item.y - radius - 11` 是**文字基线**的位置，
         * 而 DOM 这一层的 `translate(-50%,-100%)` 把「盒底」放在锚点上，
         * 两者对不齐：不下移的话名字会整体偏高约 3px。
         */
        slot.element.style.transform = `translate3d(${Math.round(placement.x)}px, ${Math.round(
          placement.y,
        )}px, 0) translate(-50%, -100%) translateY(3px)`;
        slot.x = placement.x;
        slot.y = placement.y;
      }
      slot.element.hidden = false;
    });
    for (let i = plan.placements.length; i < this.labelSlots.length; i += 1) {
      const slot = this.labelSlots[i]!;
      if (!slot.element.hidden) slot.element.hidden = true;
    }

    this.retained = new Set(plan.placements.map((placement) => placement.id));
    layer.dataset.count = String(plan.placements.length);
  }

  private candidateFor(
    node: ProjectedNode,
    isSelected: boolean,
    isHover: boolean,
    related: boolean,
  ): LabelCandidate {
    const graph = this.graph!;
    const title = graph.titles[node.index] ?? "";
    /*
     * 三档与参考图一致（`drawLabels`）：
     * - 选中 / 悬停是「强制」：字号最大、永远显示；
     * - 直接邻接与悬停共享 `--text` 那一档（12px / 500）；
     * - 普通名称 11px / 400，受预算与遮挡限制。
     */
    const forced = isSelected || isHover;
    const important = forced || related;
    return {
      id: node.id,
      text: title.length > 18 ? `${title.slice(0, 17)}…` : title,
      x: node.x,
      y: node.y,
      depth: node.depth,
      // 选中 → 悬停 → 重要邻接 → 近处普通节点（与参考图的 10000/9000/5000 同序）
      priority: isSelected ? 10000 : isHover ? 9000 : related ? 5000 : 1000 - node.depth,
      important,
      forced,
      font: isSelected ? 14 : important ? 12 : 11,
      weight: isSelected ? 600 : important ? 500 : 400,
      tone: isSelected ? "selected" : important ? "related" : "normal",
      radius: node.radius,
    };
  }

  private createSlot(layer: HTMLElement): LabelSlot {
    const element = document.createElement("span");
    element.className = "universe-label is-normal";
    element.setAttribute("aria-hidden", "true");
    layer.appendChild(element);
    const slot: LabelSlot = {
      element,
      id: "",
      text: "",
      x: Number.NaN,
      y: Number.NaN,
      tone: "",
      font: 0,
      weight: 0,
    };
    this.labelSlots.push(slot);
    return slot;
  }

  /** 选中节点是否在视野外：是的话给方向提示与定位入口，而不是把标签贴错位置 */
  private syncOffstage(projected: ProjectedNode[]): void {
    const selected = this.selected;
    let offstage = false;
    if (selected !== null) {
      const node = projected[selected];
      offstage =
        !node ||
        !node.visible ||
        node.x < -OFFSCREEN_MARGIN ||
        node.y < -OFFSCREEN_MARGIN ||
        node.x > this.viewport.width + OFFSCREEN_MARGIN ||
        node.y > this.viewport.height + OFFSCREEN_MARGIN;
    }
    if (offstage !== this.selectedOffstage) {
      this.selectedOffstage = offstage;
      this.options.onSelectedOffscreen(offstage);
    }
  }

  /* ------------------------------- 尺寸与主题 ------------------------------- */

  private measureHost(): void {
    const host = this.options.host;
    const width = Math.max(1, Math.round(host.clientWidth));
    const height = Math.max(1, Math.round(host.clientHeight));
    if (width === this.viewport.width && height === this.viewport.height) return;
    this.viewport = { width, height };
    this.renderer.resize(width, height);
    this.retained.clear();
    this.wake();
  }

  private handleThemeChange(): void {
    this.palette = readPalette();
    this.renderer.setPalette(this.palette);
    this.retained.clear();
    this.wake();
  }

  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.layout.dispose();
    this.layoutAnimating = false;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.options.onContextLost();
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) {
      // 切后台不再持续计算：停掉本轮布局，保留已经算出来的坐标
      this.hidden = true;
      if (this.raf !== null) cancelAnimationFrame(this.raf);
      this.raf = null;
      this.layout.cancel();
      this.navigation.cancelPointer();
      this.persistCamera();
    } else {
      this.hidden = false;
      this.wake();
    }
  };

  private scheduleCameraSave(): void {
    if (this.cameraSaveTimer !== undefined) window.clearTimeout(this.cameraSaveTimer);
    this.cameraSaveTimer = window.setTimeout(() => {
      this.cameraSaveTimer = undefined;
      this.persistCamera();
    }, 400);
  }

  private persistCamera(): void {
    // 「布局已收敛」才算是使用者真正的观看状态，见 session.ts 的说明
    storeCamera(this.navigation.camera, this.layoutSettled);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this.cameraSaveTimer !== undefined) window.clearTimeout(this.cameraSaveTimer);
    this.persistCamera();
    // 卸载时把最后一帧坐标落进缓存：下次进来直接接着看
    if (this.graph && this.positions.length === this.graph.ids.length * 3) {
      storeLayout(this.graph.ids, this.positions, this.graph.signature, this.layoutSettled);
    }
    this.resizeObserver.disconnect();
    this.stopThemeWatch();
    this.options.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.navigation.dispose();
    this.layout.dispose();
    for (const slot of this.labelSlots) slot.element.remove();
    this.labelSlots.length = 0;
    this.options.labelLayer.replaceChildren();
    this.renderer.dispose();
    if (import.meta.env.DEV && typeof window !== "undefined") {
      delete (window as unknown as Record<string, unknown>).__KN_SPACE__;
    }
  }
}

/** 结构签名 → 数值版本号：协议里的 topologyRevision */
function revisionOf(signature: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < signature.length; i += 1) {
    hash ^= signature.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** WebGL 2 是否可用：在真实创建路径上判断，而不是只看 window 上有没有 WebGLRenderingContext */
export function canRenderSpace(): boolean {
  return webgl2Available();
}
