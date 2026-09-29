/**
 * 三维布局 Worker
 *
 * 协议见 `types.ts` 与《空间图谱技术方案》8.4：
 * - 同一轮之后到达的旧命令（runId 不增）直接丢弃；快照/结束消息带上版本标识，
 *   由主线程按 epoch + 拓扑版本 + runId 过滤；
 * - 分时间片推进：每片结束让出事件循环，UPDATE / CANCEL / STOP 才收得到；
 * - 只用副本做快照并转移所有权，绝不转移内部仍在写的缓冲区；
 * - 结束后不留在内存里等下一次：主线程收到 FINISHED 即可 terminate 本 Worker。
 *
 * 这个文件刻意不碰 window / document：`tsconfig.worker.json` 用 WebWorker 类型
 * 单独检查它，避免把 DOM 类型混进 Worker。
 */
import { createLayout, layoutMetrics, readPositions, stepLayout, stopReason } from "./layoutCore.ts";
import type { LayoutRuntime } from "./layoutCore.ts";
import type { LayoutRequest, LayoutResponse, LayoutStopReason } from "./types.ts";

/** 因为不引入 WebWorker 全局类型声明，这里显式描述用到的 Worker 侧能力 */
interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<LayoutRequest>) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

/** 每片推进的步数：太大则取消消息迟到，太小则总时间被调度开销吃掉 */
const TICKS_PER_SLICE = 4;
/** 快照发送间隔（毫秒）：主线程按 10–20Hz 接收，渲染帧率与它无关 */
const SNAPSHOT_INTERVAL_MS = 55;
/** 位移与碰撞连续达标的批次数，达到即视为收敛 */
const SETTLED_BATCHES = 4;

interface Run {
  runId: number;
  epoch: number;
  topologyRevision: number;
  runtime: LayoutRuntime;
  startedAt: number;
  lastSnapshotAt: number;
  sequence: number;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

let run: Run | null = null;

function post(message: LayoutResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) scope.postMessage(message, transfer);
  else scope.postMessage(message);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function finish(current: Run, reason: LayoutStopReason, source?: Float32Array): void {
  if (current.timer !== null) clearTimeout(current.timer);
  current.timer = null;
  const elapsedMs = now() - current.startedAt;
  /*
   * 总是先复制再转移所有权：转移之后原缓冲区就归主线程了，
   * 继续往里写（或下次又转移同一块）都会变成难以复现的错乱。
   * `source` 用于坐标异常时回退上一份有效快照。
   */
  const positions = new Float32Array(source ?? readPositions(current.runtime.nodes));
  post(
    {
      type: "FINISHED",
      epoch: current.epoch,
      topologyRevision: current.topologyRevision,
      runId: current.runId,
      reason,
      metrics: layoutMetrics(current.runtime, elapsedMs),
      positions,
    },
    [positions.buffer],
  );
  // 释放这一轮的全部内存：节点、边、距离表、力
  current.runtime.simulation.stop();
  if (run === current) run = null;
}

function sendSnapshot(current: Run): void {
  const positions = readPositions(current.runtime.nodes);
  current.sequence += 1;
  current.lastSnapshotAt = now();
  post(
    {
      type: "SNAPSHOT",
      epoch: current.epoch,
      topologyRevision: current.topologyRevision,
      runId: current.runId,
      sequence: current.sequence,
      positions,
      iterations: current.runtime.iterations,
      rms: current.runtime.rms,
    },
    [positions.buffer],
  );
}

function fail(current: Run, error: unknown): void {
  if (current.timer !== null) clearTimeout(current.timer);
  current.timer = null;
  post({
    type: "ERROR",
    epoch: current.epoch,
    topologyRevision: current.topologyRevision,
    runId: current.runId,
    message: error instanceof Error ? error.message : String(error),
  });
  if (run === current) run = null;
}

/**
 * 一片计算。
 *
 * 每片结束都把控制权交回事件循环（setTimeout 0），否则一个长同步循环会让
 * CANCEL / UPDATE 永远排不上队——「往忙碌 Worker 发取消消息」从来不会打断它。
 */
function slice(): void {
  const current = run;
  if (!current || current.cancelled) return;
  current.timer = null;
  try {
    stepLayout(current.runtime, TICKS_PER_SLICE);
  } catch (error) {
    fail(current, error);
    return;
  }

  const elapsed = now() - current.startedAt;
  const settled = current.runtime.finite && current.runtime.stableBatches >= SETTLED_BATCHES;
  const overIterations = current.runtime.iterations >= current.runtime.params.maxIterations;
  const overtime = elapsed >= current.runtime.params.maxDurationMs;
  const broken = !current.runtime.finite;

  if (settled || overIterations || overtime || broken) {
    if (broken) {
      // 坐标异常：退回上一份通过有限性检查的快照，而不是把 NaN 交给渲染
      finish(current, "error", current.runtime.valid);
      return;
    }
    // 结束前再发一份快照：主线程手上的最后一份必须是最新坐标
    sendSnapshot(current);
    finish(current, stopReason(current.runtime, SETTLED_BATCHES));
    return;
  }
  if (now() - current.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) sendSnapshot(current);
  current.timer = setTimeout(slice, 0);
}

function start(message: Extract<LayoutRequest, { type: "INIT" | "UPDATE" }>): void {
  if (run) {
    // 旧的一轮直接丢掉：不 terminate 也能立刻停手（timer 清掉即可）
    if (run.timer !== null) clearTimeout(run.timer);
    run.runtime.simulation.stop();
    run = null;
  }

  const fresh: Run = {
    runId: message.runId,
    epoch: message.epoch,
    topologyRevision: message.topologyRevision,
    runtime: null as unknown as LayoutRuntime,
    startedAt: now(),
    lastSnapshotAt: 0,
    sequence: 0,
    cancelled: false,
    timer: null,
  };

  try {
    fresh.runtime = createLayout({
      ids: message.stableNodeIds,
      edges: message.edges,
      previous: message.previousPositions,
      // UPDATE 说明主线程手上有可用坐标：温启动，不要把整张图重新点火
      warmStart: message.type === "UPDATE",
      params: message.parameters,
    });
  } catch (error) {
    fail(fresh, error);
    return;
  }

  run = fresh;
  // 先发初始坐标：主线程不必等第一批迭代结束就能把节点摆出来
  sendSnapshot(fresh);
  fresh.timer = setTimeout(slice, 0);
}

scope.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.type === "INIT" || message.type === "UPDATE") {
    /*
     * 同一轮之后的命令一律丢弃：runId 由主线程单调递增，
     * 迟到的旧命令会把已经结束的一轮又拉起来。
     */
    if (run && message.runId <= run.runId) return;
    start(message);
    return;
  }
  if (message.type === "CANCEL" || message.type === "STOP") {
    if (!run || run.runId !== message.runId) return;
    if (message.type === "STOP") {
      run.cancelled = true;
      if (run.timer !== null) clearTimeout(run.timer);
      run.timer = null;
      run.runtime.simulation.stop();
      run = null;
      return;
    }
    // CANCEL：把当前这一轮就地结束，交回已经算出来的有效坐标
    run.cancelled = true;
    if (run.timer !== null) clearTimeout(run.timer);
    run.timer = null;
    finish(run, "cancelled");
  }
});
