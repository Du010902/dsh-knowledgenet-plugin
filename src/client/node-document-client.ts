/**
 * 客户端侧的**节点正文读写**通道（`design/node-note-editor-plan.md`）。
 *
 * 三条纪律：
 * 1. **不经过发送模型消息**保存 ✗ —— 直接把正文 POST 给宿主路由 ✓；
 * 2. 每次请求带**序号 + AbortController**：切节点/切库时旧响应绝不允许覆盖新状态 ✓；
 * 3. 客户端**不引入任何 Node 文件模块** ✗（只认 `nodeId` 与相对路径展示 ✓）。
 */
import { GRAPH_API_ROUTE } from "../shared/routes.ts";

/** 一份可编辑的文档（与宿主 `NodeDocument` 同形 ✓） */
export interface NodeDocument {
  nodeId: string;
  title: string;
  /** 实际相对路径（只用于展示 ✓） */
  path: string;
  text: string;
  /** 读取时的整文件指纹：保存时原样带回 ✓ */
  hash: string;
  revision: number;
}

/** 请求目标：宿主按它解析库根（**绝不传绝对路径** ✗） */
export interface DocumentTarget {
  /** 工作区库根（面板已有） */
  root?: string | undefined;
  /** 或者会话 id（宿主按会话 cwd 找库 ✓） */
  sessionId?: string | undefined;
}

/** 失败原因（稳定 code，界面据此出文案 ✓） */
export type DocumentFailure =
  | "library_unavailable"
  | "unsupported_format"
  | "node_missing"
  | "too_large"
  | "conflict"
  | "write_failed"
  | "bad_body"
  /* 宿主读库时出错（权限 / IO ✓）—— 不是"没有这个节点" ✗ */
  | "read_failed"
  | "unknown";

export type ReadOutcome =
  | { ok: true; document: NodeDocument }
  | { ok: false; code: DocumentFailure; message: string };

export type SaveOutcome =
  | { ok: true; document: NodeDocument }
  | { ok: false; code: DocumentFailure; message: string; latest?: NodeDocument };

interface RawResponse {
  ok?: unknown;
  document?: unknown;
  error?: { code?: unknown; message?: unknown; latest?: unknown } | undefined;
}

function asDocument(value: unknown): NodeDocument | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.nodeId !== "string" || typeof raw.text !== "string") return undefined;
  return {
    nodeId: raw.nodeId,
    title: typeof raw.title === "string" ? raw.title : "",
    path: typeof raw.path === "string" ? raw.path : "",
    text: raw.text,
    hash: typeof raw.hash === "string" ? raw.hash : "",
    revision: typeof raw.revision === "number" ? raw.revision : 0,
  };
}

function asFailure(value: unknown): DocumentFailure {
  const code = typeof value === "string" ? value : "";
  const known: DocumentFailure[] = [
    "library_unavailable",
    "unsupported_format",
    "node_missing",
    "too_large",
    "conflict",
    "write_failed",
    "bad_body",
  ];
  return (known as string[]).includes(code) ? (code as DocumentFailure) : "unknown";
}

/** 注入点：测试里换成假 fetch ✓（客户端本体只用同源 `fetch` ✓） */
export type FetchLike = (input: string, init?: RequestInit) => Promise<{
  json(): Promise<unknown>;
  text?(): Promise<string>;
}>;

interface RequestOptions {
  target?: DocumentTarget | undefined;
  /** 用于"过期响应丢弃"的序号守卫（同一个编辑器实例共享 ✓） */
  isCurrent?: (() => boolean) | undefined;
  signal?: AbortSignal | undefined;
}

function targetBody(target: DocumentTarget | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (target?.root !== undefined && target.root !== "") body.root = target.root;
  else if (target?.sessionId !== undefined && target.sessionId !== "") body.sessionId = target.sessionId;
  return body;
}

async function post(
  fetcher: FetchLike,
  body: Record<string, unknown>,
  options: RequestOptions,
): Promise<RawResponse | { ok: false; error: { code: string; message: string } }> {
  const response = await fetcher(GRAPH_API_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    credentials: "same-origin",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => null)) as RawResponse | null;
  if (parsed === null) {
    return { ok: false, error: { code: "unknown", message: "宿主返回了无法解析的内容" } };
  }
  return parsed;
}

/**
 * 读一个节点的正文文档。
 * @param nodeId - 稳定节点 id（重命名也追得住 ✓）。
 * @param fetcher - fetch 注入点。
 * @param options - 目标库、序号守卫与取消信号 ✓。
 * @param requestId - 请求号 ✓（只用于**两端留痕对齐**：宿主 `noteApi` ↔ 客户端 `note-open-*` ✓；
 *   复查问题三要求"只有 requestId 对齐后才能可靠比较"✓ —— 它**不参与任何判定** ✗）。
 * @returns 文档或带 code 的失败；**过期响应会被丢弃**（返回 `stale` 语义由调用方判空 ✓）。
 */
export async function readNodeDocument(
  nodeId: string,
  fetcher: FetchLike,
  options: RequestOptions = {},
  requestId = "",
): Promise<ReadOutcome | undefined> {
  const body = {
    kind: "read-node-document",
    nodeId,
    ...(requestId === "" ? {} : { requestId }),
    ...targetBody(options.target),
  };
  const parsed = await post(fetcher, body, options);
  /* 过期响应：调用方已经切走了 ⇒ 直接丢弃，别写进状态 ✗ */
  if (options.isCurrent !== undefined && !options.isCurrent()) return undefined;
  if (parsed.ok === true) {
    const document = asDocument((parsed as RawResponse).document);
    if (document === undefined) {
      return { ok: false, code: "unknown", message: "宿主返回的文档形状不对" };
    }
    return { ok: true, document };
  }
  const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error;
  return {
    ok: false,
    code: asFailure(error?.code),
    message: typeof error?.message === "string" ? error.message : "读取失败",
  };
}

/**
 * 保存正文（带读取时的指纹做比较交换 ✓）。
 * @param input - 节点 id、完整正文、读取时拿到的指纹。
 * @param fetcher - fetch 注入点。
 * @param options - 目标库、序号守卫与取消信号 ✓。
 * @returns 新文档；冲突时带上磁盘**最新正文**（供比较/合并 ✓）。
 */
export async function saveNodeDocument(
  input: { nodeId: string; text: string; hash?: string },
  fetcher: FetchLike,
  options: RequestOptions = {},
): Promise<SaveOutcome | undefined> {
  const body: Record<string, unknown> = {
    kind: "save-node-document",
    nodeId: input.nodeId,
    text: input.text,
    ...targetBody(options.target),
  };
  if (input.hash !== undefined && input.hash !== "") body.hash = input.hash;
  const parsed = await post(fetcher, body, options);
  if (options.isCurrent !== undefined && !options.isCurrent()) return undefined;
  if (parsed.ok === true) {
    const document = asDocument((parsed as RawResponse).document);
    if (document === undefined) {
      return { ok: false, code: "unknown", message: "宿主返回的文档形状不对" };
    }
    return { ok: true, document };
  }
  const error = (parsed as { error?: { code?: unknown; message?: unknown; latest?: unknown } }).error;
  const latest = asDocument(error?.latest);
  return {
    ok: false,
    code: asFailure(error?.code),
    message: typeof error?.message === "string" ? error.message : "保存失败",
    ...(latest === undefined ? {} : { latest }),
  };
}
