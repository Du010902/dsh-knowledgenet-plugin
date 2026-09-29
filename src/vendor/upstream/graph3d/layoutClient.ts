/**
 * 布局 Worker 的主线程一侧
 *
 * 职责只有三件事：
 * 1. 按 `epoch + topologyRevision + runId` 过滤消息，旧序列一律丢弃——
 *    过期的快照绝不能污染新的图（节点数变了却按旧顺序解释坐标是最坏的情况）；
 * 2. 用最近两份快照插值，渲染帧率与 10–20Hz 的布局更新解耦；
 * 3. 管理 Worker 生命周期：静态模块 Worker、取消、结束即终止、卸载即清理。
 *
 * 这里不做任何布局计算，也不碰业务 Store。
 */
import type {
  LayoutFinishedMessage,
  LayoutInitMessage,
  LayoutParams,
  LayoutResponse,
  LayoutStatus,
  LayoutStopReason,
} from "./types.ts";

export interface LayoutStartInput {
  epoch: number;
  topologyRevision: number;
  ids: string[];
  /** 索引指向 ids 的边（有向无向都可以，Worker 内部会无向化） */
  edges: Array<[number, number]>;
  /** 已对齐的缓存坐标；认不出的节点用 NaN 占位。没有缓存传 null */
  previous: Float32Array | null;
  params: LayoutParams;
}

export interface LayoutStatusDetail {
  iterations: number;
  reason?: LayoutStopReason;
  elapsedMs?: number;
  metrics?: LayoutFinishedMessage["metrics"];
}

export interface LayoutClientOptions {
  /** 有新坐标可读时唤醒渲染循环 */
  onFrame(): void;
  onStatus(status: LayoutStatus, detail: LayoutStatusDetail): void;
  /** 仅测试用：注入一个假的 Worker */
  createWorker?: () => Worker;
}

/**
 * 快照之间的插值时长。
 *
 * 略长于发送间隔（55ms）：新快照随时会把插值目标换掉，视觉上始终在追赶最新坐标，
 * 因此不会出现「插值走完、画面停住等下一份快照」的顿挫；代价是最多约 90ms 的滞后，
 * 对「看关系怎么舒展」这件事没有影响（选中高亮不经过这里）。
 */
const INTERPOLATION_MS = 90;

/** 有至少一个有限坐标才算有缓存：全是 NaN 等于没有 */
function hasCachedPositions(previous: Float32Array | null): boolean {
  if (!previous) return false;
  for (let i = 0; i < previous.length; i += 1) if (Number.isFinite(previous[i])) return true;
  return false;
}

interface Snapshot {
  positions: Float32Array;
  at: number;
  duration: number;
}

export class LayoutClient {
  private worker: Worker | null = null;
  private runId = 0;
  private epoch = 0;
  private revision = 0;
  private count = 0;
  private latest: Snapshot | null = null;
  /** 同一轮内最后接受的快照序号 */
  private lastSequence = 0;
  private previous: Snapshot | null = null;
  private buffer = new Float32Array(0);
  private status: LayoutStatus = "forming";
  private detail: LayoutStatusDetail = { iterations: 0 };
  private disposed = false;
  /*
   * 字段与构造函数分开写（不用 TS 参数属性）：
   * Node 的「只剥离类型」模式不支持参数属性，而单元测试要直接 import 这个文件。
   */
  private readonly options: LayoutClientOptions;

  constructor(options: LayoutClientOptions) {
    this.options = options;
  }

  get currentStatus(): LayoutStatus {
    return this.status;
  }

  get currentDetail(): LayoutStatusDetail {
    return this.detail;
  }

  /**
   * 开始（或重启）一轮布局。
   *
   * 每次都新建 runId：旧 Worker 的快照即使晚到也会因为 runId 不匹配被丢掉。
   */
  start(input: LayoutStartInput, fallbackPositions: Float32Array): void {
    if (this.disposed) return;
    this.runId += 1;
    this.lastSequence = 0;
    this.epoch = input.epoch;
    this.revision = input.topologyRevision;
    this.count = input.ids.length;
    const initial = new Float32Array(fallbackPositions.length === this.count * 3 ? fallbackPositions : new Float32Array(this.count * 3));
    this.latest = { positions: initial, at: 0, duration: 0 };
    this.previous = null;
    this.buffer = new Float32Array(this.count * 3);
    this.setStatus("forming", { iterations: 0 });
    /** 有可用缓存坐标才叫 UPDATE：Worker 会据此做软锚定，而不是重新初始化 */
    const warm = hasCachedPositions(input.previous);

    if (typeof Worker === "undefined") {
      // 没有 Worker 环境（例如单元测试、异常降级）：保留可用坐标，界面继续能看
      this.setStatus("unavailable", { iterations: 0 });
      return;
    }

    this.disposeWorker();
    let worker: Worker;
    try {
      worker = this.options.createWorker
        ? this.options.createWorker()
        : // Vite 要求这种静态形式才能把 Worker 单独打包；路径必须随文件位置调整
          new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      console.error("[KnowledgeNet] 布局 Worker 未启动", error);
      this.setStatus("unavailable", { iterations: 0 });
      return;
    }
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<LayoutResponse>) => this.handle(event.data);
    worker.onerror = (event) => {
      console.error("[KnowledgeNet] 布局 Worker 出错", event.message ?? event);
      this.disposeWorker();
      this.setStatus("unavailable", { iterations: this.detail.iterations });
    };
    worker.onmessageerror = () => {
      this.setStatus("unavailable", { iterations: this.detail.iterations });
    };

    const message: LayoutInitMessage = {
      type: warm ? "UPDATE" : "INIT",
      epoch: this.epoch,
      topologyRevision: this.revision,
      runId: this.runId,
      stableNodeIds: input.ids,
      edges: input.edges,
      /*
       * 必须送一份副本：转移所有权之后主线程这边的缓存就空了，
       * 而这份缓存正是「切回空间视图还在原位」的依据。
       */
      previousPositions: input.previous ? new Float32Array(input.previous) : null,
      parameters: input.params,
    };
    const transfer = message.previousPositions ? [message.previousPositions.buffer] : [];
    worker.postMessage(message, transfer);
  }

  private handle(message: LayoutResponse): void {
    if (this.disposed) return;
    // 只接受当前代次、当前拓扑版本、当前运行的消息
    if (
      message.epoch !== this.epoch ||
      message.topologyRevision !== this.revision ||
      message.runId !== this.runId
    ) {
      return;
    }
    if (message.type === "SNAPSHOT") {
      if (message.positions.length !== this.count * 3) return; // 顺序/数量对不上：宁可丢弃
      // 同一轮里序号只增不减：迟到的旧快照会把画面往回拉，直接丢掉
      if (message.sequence <= this.lastSequence) return;
      this.lastSequence = message.sequence;
      this.push(message.positions, INTERPOLATION_MS, message.iterations, this.now());
      this.setStatus("settling", { iterations: message.iterations });
      this.options.onFrame();
      return;
    }
    if (message.type === "FINISHED") {
      if (message.positions.length === this.count * 3) {
        this.push(message.positions, INTERPOLATION_MS, message.metrics.iterations, this.now());
      }
      this.setStatus(
        message.reason === "error" ? "unavailable" : "settled",
        {
          iterations: message.metrics.iterations,
          reason: message.reason,
          elapsedMs: message.metrics.elapsedMs,
          metrics: message.metrics,
        },
      );
      this.options.onFrame();
      // 结束即释放：不留在内存里等下一次，重新布局时再建一个 Worker
      this.disposeWorker();
      return;
    }
    // ERROR
    console.error("[KnowledgeNet] 布局失败", message.message);
    this.setStatus("unavailable", { iterations: this.detail.iterations });
    this.disposeWorker();
  }

  private push(positions: Float32Array, duration: number, iterations: number, at: number): void {
    /*
     * 起点取「此刻屏幕上真正显示的坐标」，而不是上一份快照的目标值：
     * 布局以 10–20Hz 更新、渲染按刷新率插值，只有这样才能保证不跳。
     */
    const shown = this.currentPositions();
    this.previous =
      duration > 0 && shown && shown.length === positions.length
        ? { positions: new Float32Array(shown), at, duration }
        : null;
    this.latest = { positions, at, duration };
    this.detail = { ...this.detail, iterations };
  }

  private now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  /**
   * 当前应显示的坐标（插值结果，写进内部缓冲复用）。
   *
   * 布局结束后 duration=0，直接返回最后一份快照，不再产生任何计算。
   */
  currentPositions(): Float32Array | null {
    const latest = this.latest;
    if (!latest) return null;
    if (!this.previous || latest.duration <= 0) return latest.positions;
    const t = Math.min(1, Math.max(0, (this.now() - latest.at) / latest.duration));
    if (t >= 1) {
      this.previous = null;
      return latest.positions;
    }
    const from = this.previous.positions;
    const to = latest.positions;
    for (let i = 0; i < this.buffer.length; i += 1) {
      this.buffer[i] = from[i]! + (to[i]! - from[i]!) * t;
    }
    return this.buffer;
  }

  /** 布局还在动？（用于决定渲染循环要不要继续跑） */
  get animating(): boolean {
    return this.previous !== null && this.latest !== null && this.latest.duration > 0;
  }

  /**
   * 取消本轮布局（页面隐藏、切到二维、组件卸载）。
   *
   * 只发 CANCEL 不 terminate：Worker 会把已经算出来的有效坐标作为
   * FINISHED('cancelled') 交回来，主线程因此不会停在「正在形成」的假状态。
   */
  cancel(): void {
    if (this.disposed || !this.worker) return;
    try {
      this.worker.postMessage({ type: "CANCEL", runId: this.runId });
    } catch {
      this.disposeWorker();
    }
  }

  private setStatus(status: LayoutStatus, detail: LayoutStatusDetail): void {
    const changed =
      status !== this.status ||
      detail.iterations !== this.detail.iterations ||
      detail.reason !== this.detail.reason;
    this.status = status;
    this.detail = detail;
    if (changed) this.options.onStatus(status, detail);
  }

  private disposeWorker(): void {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    try {
      worker.postMessage({ type: "STOP", runId: this.runId });
    } catch {
      /* 通道已经关闭：直接 terminate */
    }
    worker.terminate();
  }

  /** 卸载 / 切到二维：停掉 Worker 并交回已算出的坐标 */
  dispose(): void {
    this.disposed = true;
    this.disposeWorker();
  }
}
