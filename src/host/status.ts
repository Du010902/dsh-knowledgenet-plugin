/**
 * 运行时状态（只为诊断）。
 *
 * 为什么需要它：面板取数要靠宿主注册的 Fetch 路由，而**宿主模块只有在 DSH 重启后才会重载**
 * （客户端半刷新页面就能更新）。一旦路由没注册，面板只能看到一句纯文本 `not found`——
 * 那对使用者毫无价值。所以把「路由是否注册、逐轮注入是否生效」记在进程里，
 * 由 `kn_status` 工具与面板一起报出来。
 *
 * 客户端半没有日志出口，于是再加一条：客户端把**结构指纹**（不含文本/路径）POST 回来，
 * 也记在这里。这样"按钮/标志没出现"这类纯前端问题，也能由 `kn_status` 直接回答。
 */

/** 路由注册结果（与 api.ts 的 ApiRegistration 同形，这里避免反向依赖） */
export interface ApiStatus {
  path: string;
  registered: boolean;
  reason?: string;
}

export interface PromptStatus {
  /** 静态「学习协议」段落是否注册成功 */
  section: boolean;
  /** 每 agent 的「当前节点」上下文是否注册成功 */
  perAgent: boolean;
}

export interface RuntimeStatus {
  api: ApiStatus;
  prompts: PromptStatus;
  /** 进程内启动时刻，用来判断宿主模块是不是刚重启过 */
  startedAt: number;
  /** 最近几次面板/探针请求的回答（环形缓冲）：定位「入口卡片为什么没出现」靠它 */
  probes: ProbeLogEntry[];
  /** 客户端上报的结构指纹（环形缓冲） */
  clientDiag: ClientDiagEntry[];
  /** 「按会话隐藏插件能力」的判定留痕（环形缓冲） */
  isolation: IsolationLogEntry[];
  /**
   * 最近几次**库扫描**的聚合指标（环形缓冲）。
   *
   * 为什么要有：性能问题（大库扫描慢、面板取数慢）光看代码只能猜。这里记录
   * "扫了多少节点/边、花了多少毫秒、目录多少" —— 这是"先采集聚合指标再决定优化"的落点。
   */
  scans: ScanLogEntry[];
}

/** 一次库扫描的聚合指标（不含任何节点文本/路径明细） */
export interface ScanLogEntry {
  at: number;
  /** 本次扫描耗时（毫秒） */
  ms: number;
  nodes: number;
  edges: number;
  /** 是否因为缓存命中而跳过了扫描（跳过的条目 ms=0） */
  cached: boolean;
  /** 是否与另一个在途请求合并（请求合并生效） */
  coalesced?: boolean;
}

/** 一次路由请求的留痕 */
export interface ProbeLogEntry {
  at: number;
  /** 请求带来的参数（没有就是 null） */
  sessionId: string | null;
  root: string | null;
  /** 宿主据此解析出的 cwd（没解析到就是 null） */
  cwd: string | null;
  /** 最终回答：library / library_unavailable / session_unknown / other */
  code: string;
}

/** 客户端半主动上报的诊断（只允许结构指纹／状态，不含文本与路径） */
export interface ClientDiagEntry {
  at: number;
  /** 哪个功能：例如 header-button（「添加知识库」按钮） */
  area: string;
  /** 结论：injected / no-search-input / no-rows-ancestor / no-actions-container … */
  outcome: string;
  [key: string]: unknown;
}

/** 环形缓冲长度：够看清「客户端到底问过没有、问的是什么」 */
const PROBE_LOG_LIMIT = 12;
/** 客户端诊断的环形缓冲长度 */
const CLIENT_DIAG_LIMIT = 32;
/** 扫描指标的环形缓冲长度 */
const SCAN_LOG_LIMIT = 8;

/** 一次「是否隐藏」判定的留痕（不含任何节点文本） */
export interface IsolationLogEntry {
  at: number;
  /** 会话工作目录（用于判断"这个会话在不在库里"） */
  sessionCwd: string | null;
  /** 判定结论：是不是知识库会话 */
  isLibrary: boolean;
  /** 是否真的对该会话隐藏了工具 */
  restricted: boolean;
  /** 没能隐藏时的原因（宿主没给 agent 作用域工具面等） */
  reason?: string;
}

/** 记录一次隔离判定（最新的在前，最多 ISOLATION_LOG_LIMIT 条） */
export function recordIsolation(entry: Omit<IsolationLogEntry, "at">): void {
  const full: IsolationLogEntry = { at: Date.now(), ...entry };
  current = {
    api: current?.api ?? { path: "", registered: false },
    prompts: current?.prompts ?? { section: false, perAgent: false },
    startedAt: current?.startedAt ?? Date.now(),
    probes: current?.probes ?? [],
    clientDiag: current?.clientDiag ?? [],
    scans: current?.scans ?? [],
    isolation: [full, ...(current?.isolation ?? [])].slice(0, ISOLATION_LOG_LIMIT),
  };
}

/** 隔离留痕的环形缓冲长度 */
const ISOLATION_LOG_LIMIT = 8;

let current: RuntimeStatus | undefined;

export function setRuntimeStatus(status: RuntimeStatus): void {
  current = status;
}

export function patchRuntimeStatus(patch: Partial<RuntimeStatus>): void {
  current = {
    api: patch.api ?? current?.api ?? { path: "", registered: false },
    prompts: patch.prompts ?? current?.prompts ?? { section: false, perAgent: false },
    startedAt: patch.startedAt ?? current?.startedAt ?? Date.now(),
    probes: patch.probes ?? current?.probes ?? [],
    clientDiag: patch.clientDiag ?? current?.clientDiag ?? [],
    scans: patch.scans ?? current?.scans ?? [],
    isolation: patch.isolation ?? current?.isolation ?? [],
  };
}

/** 记录一次路由请求（最新的在前，最多 PROBE_LOG_LIMIT 条） */
export function recordProbe(entry: ProbeLogEntry): void {
  current = {
    api: current?.api ?? { path: "", registered: false },
    prompts: current?.prompts ?? { section: false, perAgent: false },
    startedAt: current?.startedAt ?? Date.now(),
    probes: [entry, ...(current?.probes ?? [])].slice(0, PROBE_LOG_LIMIT),
    clientDiag: current?.clientDiag ?? [],
    scans: current?.scans ?? [],
    isolation: current?.isolation ?? [],
  };
}

/** 记录一次客户端诊断（最新的在前，最多 CLIENT_DIAG_LIMIT 条） */
export function recordClientDiag(entry: ClientDiagEntry): void {
  current = {
    api: current?.api ?? { path: "", registered: false },
    prompts: current?.prompts ?? { section: false, perAgent: false },
    startedAt: current?.startedAt ?? Date.now(),
    probes: current?.probes ?? [],
    clientDiag: [entry, ...(current?.clientDiag ?? [])].slice(0, CLIENT_DIAG_LIMIT),
    scans: current?.scans ?? [],
    isolation: current?.isolation ?? [],
  };
}

/** 记录一次库扫描指标（最新的在前，最多 SCAN_LOG_LIMIT 条） */
export function recordScan(entry: ScanLogEntry): void {
  current = {
    api: current?.api ?? { path: "", registered: false },
    prompts: current?.prompts ?? { section: false, perAgent: false },
    startedAt: current?.startedAt ?? Date.now(),
    probes: current?.probes ?? [],
    clientDiag: current?.clientDiag ?? [],
    scans: [entry, ...(current?.scans ?? [])].slice(0, SCAN_LOG_LIMIT),
  };
}

export function runtimeStatus(): RuntimeStatus | undefined {
  return current;
}
