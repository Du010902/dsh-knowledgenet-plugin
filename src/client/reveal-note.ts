/**
 * 「在资源管理器中显示当前笔记」的**客户端请求**（走插件自己的宿主路由 ✓）。
 *
 * 为什么不是客户端直接调 `ctx.remote.session.openWorkspacePath` ✗（第一版就是这么做的，实测不通）：
 * 编译型插件的客户端半**访问不到 Client Remote** —— 2026-10-29 实机诊断（`kn_status` 的
 * `clientDiag`，area=reveal）明确报 `{"remote":false,"session":false,"reason":"no-remote"}` ✓；
 * 本仓库 `src/host/api.ts` 顶部也早写过"客户端半没有 `host.call`，也用不了 `ctx.remote.*`" ✓。
 *
 * 现在的分工（`design/note-reveal-in-file-manager.md`）：
 * - **客户端**：只发一条同源请求 `{ kind: "reveal-note", nodeId, root|sessionId }` ✓
 *   （与笔记正文读写走同一条 `GRAPH_API_ROUTE` ✓，不传绝对路径 ✗）；
 * - **宿主半**（`src/host/api.ts` 的 `reveal-note` 分支）：按 nodeId 解析库内路径，
 *   再直连 `ctx.sessionController.openWorkspacePath({ action: "reveal" })` ✓ ——
 *   平台分支（Windows `explorer /select,` / macOS `open -R` / Linux 目录管理器）、路径校验
 *   （必须能被 `ctx.fs` 映射成 Host 路径 ✓）和命令注入边界仍然归宿主 ✓，插件不自己 spawn ✗。
 *
 * 诊断（`kn_status` 的 `clientDiag`，area=reveal ✓）：成功/失败都留痕，排查不用再靠猜 ✓。
 */
import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import type { DocumentTarget, FetchLike } from "./node-document-client.ts";

/** 一次"在文件管理器中显示"的结果 ✓ */
export type RevealOutcome =
  /** 宿主已接受原生交接 ✓ */
  | { ok: true }
  /** 失败：带宿主/传输给出的稳定 code 与可读消息 ✓ */
  | { ok: false; code: string; message: string };

/**
 * 请宿主在文件管理器中**定位**当前文档 ✓。
 *
 * @param input.fetcher - fetch 注入点（编辑器把测试替身透下来 ✓；真实运行用同源 fetch ✓）。
 * @param input.nodeId - 当前节点 id ✓（宿主据此解析实际路径 ✓）。
 * @param input.target - 库目标（root 或 sessionId，二选一 ✓）。
 * @returns 成功，或带 code/message 的失败（不抛 ✓）。
 */
export async function revealNoteInFileManager(input: {
  fetcher: FetchLike;
  nodeId: string;
  target?: DocumentTarget | undefined;
}): Promise<RevealOutcome> {
  const body: Record<string, unknown> = { kind: "reveal-note", nodeId: input.nodeId };
  if (input.target?.root !== undefined && input.target.root !== "") body.root = input.target.root;
  else if (input.target?.sessionId !== undefined && input.target.sessionId !== "") body.sessionId = input.target.sessionId;
  try {
    const response = await input.fetcher(GRAPH_API_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const parsed = (await response.json()) as
      | { ok?: unknown; error?: { code?: unknown; message?: unknown } | undefined }
      | null;
    if (parsed?.ok === true) return { ok: true };
    const error = parsed?.error;
    return {
      ok: false,
      code: typeof error?.code === "string" ? error.code : "unknown",
      message: typeof error?.message === "string" && error.message !== "" ? error.message : "无法在资源管理器中显示",
    };
  } catch (error) {
    /* 传输失败（宿主没起、同源路由不可用）也收敛成可读结果 ✓，界面不会白屏 ✓ */
    return { ok: false, code: "unknown", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 上报一条「在资源管理器中显示」诊断 ✓（失败静默，不影响功能 ✓）。
 * 宿主 `api.ts` 的 diag 分支只收 `area` / `outcome` 与扁平标量 ✓（路径与正文都不会被上报 ✗）。
 * @param entry - 额外字段（布尔 / 短字符串 / 数字 ✓；undefined 会被 JSON 丢掉 ✓）。
 */
export function reportRevealDiag(entry: Record<string, unknown>): void {
  try {
    void fetch(GRAPH_API_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "diag", area: "reveal", ...entry }),
    }).catch(() => undefined);
  } catch {
    /* 诊断是附带的：网络/宿主异常都不该影响按钮 ✓ */
  }
}
