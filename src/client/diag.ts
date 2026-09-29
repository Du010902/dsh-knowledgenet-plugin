/**
 * 客户端半 → 宿主的诊断上报（只发结构指纹/状态：没有文本、没有路径）。
 *
 * 为什么需要：客户端半没有日志出口，而「按钮/标签页为什么没出现」这类问题的答案只在浏览器里。
 * 把它 POST 给宿主（同一路由，该载体的 Fetch 路由支持 GET | HEAD | POST），
 * 再由 `kn_status` 读出来——定位就不必让人开 DevTools。
 */
import { GRAPH_API_ROUTE } from "../shared/routes.ts";

/** 一次上报：area 说明哪个功能，outcome 是结论，其余字段是结构指纹 */
export interface DiagPayload {
  area: string;
  outcome: string;
  [key: string]: unknown;
}

/**
 * 发送队列：**串行**发出，避免两条 POST 同时占用同一条通道。
 *
 * 实测教训：桌面端页面的 `api/` 请求走 IPC 桥；`confirm-clicked` 这条诊断刚发出去，
 * 紧接着的 `create-library` **写请求**就失败了（而单独发的诊断都成功）。
 */
let sendQueue: Promise<unknown> = Promise.resolve();

/** 仅测试用：清空发送队列 */
export function __resetDiagQueueForTest(): void {
  sendQueue = Promise.resolve();
}

/**
 * 上报一次诊断（fire-and-forget：失败不影响功能，也不抛）。
 * @param area - 功能标识，例如 `tab-type` / `header-button`。
 * @param outcome - 结论标识。
 * @param detail - 附加的标量/数组字段（**不要**放文本或路径）。
 * @param fetchImpl - 可注入，便于单测。
 * @returns 是否送达。
 */
export async function reportDiag(
  area: string,
  outcome: string,
  detail: Record<string, unknown> | string | null = null,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const send = async (): Promise<boolean> => {
    try {
      const body: DiagPayload = { kind: "diag", area, outcome };
      if (typeof detail === "string") body.detail = detail;
      else if (detail !== null) Object.assign(body, detail);
      const response = await fetchImpl(GRAPH_API_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      return response.ok === true;
    } catch {
      return false;
    }
  };
  const queued = sendQueue.then(send, send);
  sendQueue = queued.catch(() => false);
  return await queued;
}

/**
 * 去重上报：**内容没变就不发**。
 *
 * 为什么必须有：宿主的 `clientDiag` 是 8 条环形缓冲，而取数类上报每次刷新面板都会重发，
 * 结果把真正想看的那条（例如面板几何）挤出去（实测踩过）。按 key + 内容签名去重即可。
 *
 * @param key - 去重键（同一处上报用同一个 key）。
 * @param area - 功能标识。
 * @param outcome - 结论标识。
 * @param detail - 上报内容（用于比对是否变化）。
 * @param fetchImpl - 可注入，便于单测。
 * @returns 是否真的发出去了。
 */
export async function reportDiagOnce(
  key: string,
  area: string,
  outcome: string,
  detail: Record<string, unknown> | string | null = null,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  let signature: string;
  try {
    signature = typeof detail === "string" ? detail : JSON.stringify(detail ?? null);
  } catch {
    signature = String(Date.now());
  }
  if (lastDiagSent.get(key) === signature) return false;
  lastDiagSent.set(key, signature);
  return await reportDiag(area, outcome, detail, fetchImpl);
}

const lastDiagSent = new Map<string, string>();

/** 仅测试用：清空去重表 */
export function __resetDiagOnceForTest(): void {
  lastDiagSent.clear();
}
