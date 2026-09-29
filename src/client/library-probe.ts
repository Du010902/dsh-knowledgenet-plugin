/**
 * 「这个会话的工作区是知识库吗？」——客户端半的探针。
 *
 * 为什么需要它：右侧栏 tab type 的 `guide` 条目是**全局静态注册**，DSH 没有"按工作区声明
 * 可见性"的机制（docs 里明确把它列为不打算做的东西）。所以入口卡片的可见性由提供者自己在
 * `sidebar.right.tab.guide.entry` 槽位里决定：**不是知识库就返回 null**。
 *
 * 判断只能问宿主（"某个目录里有没有 library.json"是宿主的文件系统知识），
 * 走的就是面板那条 Fetch 路由：显式带 `sessionId` 时宿主**不会**回落到其它库，
 * 找不到就如实报 library_unavailable。
 *
 * 结果按 sessionId 缓存：指南页每次渲染/切换会话都不该重复打后端。
 */
import { GRAPH_API_ROUTE } from "../shared/routes.ts";

/** library：这个会话的工作区（或其上级）是知识库；other：不是；unknown：还没问到/问不到 */
export type WorkspaceKind = "library" | "other" | "unknown";

const cache = new Map<string, WorkspaceKind>();
const inflight = new Map<string, Promise<WorkspaceKind>>();

/** 只读缓存里已有的结论（没有就返回 unknown，不触发请求） */
export function peekWorkspaceKind(sessionId: string | undefined): WorkspaceKind {
  if (sessionId === undefined || sessionId === "") return "unknown";
  return cache.get(sessionId) ?? "unknown";
}

export function clearWorkspaceCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * 忘掉某个路径的探测结论（两种探测都清）。
 *
 * 为什么必须有：第一次点「添加知识库」时目录还不是库，探针把 `exact:<路径> = other` 缓存了；
 * 创建成功之后若不清缓存，字形与入口卡片会继续按"不是知识库"渲染，**直到刷新页面**
 * （实测现象：用按钮添加成功后，左侧栏那一行仍是普通文件夹图标）。
 *
 * @param path - 目录路径。
 */
export function forgetProbe(path: string | undefined): void {
  if (path === undefined || path.trim() === "") return;
  const key = pathKey(path);
  cache.delete(key);
  cache.delete(`exact:${key}`);
  inflight.delete(key);
  inflight.delete(`exact:${key}`);
}

/** 路径键：去掉尾部分隔符，避免同一个目录被算成两个键 */
function pathKey(path: string): string {
  return `path:${path.trim().replace(/[\\/]+$/, "")}`;
}

/** 只读缓存里按路径已有的结论 */
export function peekPathKind(path: string | undefined): WorkspaceKind {
  if (path === undefined || path.trim() === "") return "unknown";
  return cache.get(pathKey(path)) ?? "unknown";
}

/** 探针的公共实现：按 key 缓存与合并并发 */
async function probeBy(
  key: string,
  query: string,
  fetchImpl: typeof fetch,
): Promise<WorkspaceKind> {
  const known = cache.get(key);
  if (known !== undefined) return known;
  const running = inflight.get(key);
  if (running !== undefined) return running;

  const task = (async (): Promise<WorkspaceKind> => {
    try {
      const response = await fetchImpl(`${GRAPH_API_ROUTE}?${query}`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      const text = await response.text();
      let body: { ok?: boolean } | null = null;
      try {
        body = JSON.parse(text) as { ok?: boolean };
      } catch {
        body = null;
      }
      if (body === null) return "unknown";
      const kind: WorkspaceKind = body.ok === true ? "library" : "other";
      cache.set(key, kind);
      return kind;
    } catch {
      return "unknown";
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/**
 * 问宿主「这个路径（或其上级）是知识库吗」。
 *
 * 这条路比会话那条更可靠：**不依赖宿主已经有这个会话**，而且显式 `root` 是强声明——
 * 找不到就近的 library.json 就是"不是知识库"，不会拿别的库顶上。
 */
export async function probeWorkspacePath(
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkspaceKind> {
  if (path.trim() === "") return "unknown";
  return await probeBy(pathKey(path), `root=${encodeURIComponent(path)}`, fetchImpl);
}

/**
 * 问宿主「这个目录**本身**是不是知识库」（`exact=1`，不向上找）。
 *
 * 入口门禁必须用这个：把知识库的**子目录**开成工作区时，它只是普通工作区，
 * 不该出现知识库入口或字形。
 */
export async function probeExactWorkspace(
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkspaceKind> {
  if (path.trim() === "") return "unknown";
  return await probeBy(`exact:${pathKey(path)}`, `root=${encodeURIComponent(path)}&exact=1`, fetchImpl);
}

/** 只读缓存里按「目录本身」已有的结论 */
export function peekExactKind(path: string | undefined): WorkspaceKind {
  if (path === undefined || path.trim() === "") return "unknown";
  return cache.get(`exact:${pathKey(path)}`) ?? "unknown";
}

/** 目录状态（创建知识库前先问一次：只有空文件夹才弹创建确认） */
export type FolderState = "library" | "empty" | "non-empty" | "missing" | "unknown";

/**
 * 问宿主这个目录的状态（只读、很轻，不装载库）。
 * @param path - 目录路径。
 * @param fetchImpl - 可注入，便于单测。
 * @returns 状态与条目数；问不到时 `unknown`。
 */
export async function probeFolderState(
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ state: FolderState; entries: number }> {
  if (path.trim() === "") return { state: "unknown", entries: 0 };
  try {
    const response = await fetchImpl(`${GRAPH_API_ROUTE}?root=${encodeURIComponent(path)}&probe=1`, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    const text = await response.text();
    let body: { ok?: boolean; folder?: { state?: unknown; entries?: unknown } } | null = null;
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      body = null;
    }
    const state = body?.folder?.state;
    if (body?.ok !== true || typeof state !== "string") return { state: "unknown", entries: 0 };
    if (state !== "library" && state !== "empty" && state !== "non-empty" && state !== "missing") {
      return { state: "unknown", entries: 0 };
    }
    return {
      state,
      entries: typeof body.folder?.entries === "number" ? body.folder.entries : 0,
    };
  } catch {
    return { state: "unknown", entries: 0 };
  }
}

/** 询问宿主；`fetchImpl` 可注入，便于单测 */
export async function probeWorkspace(
  sessionId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkspaceKind> {
  if (sessionId === undefined || sessionId === "") return "unknown";
  const known = cache.get(sessionId);
  if (known !== undefined) return known;
  const running = inflight.get(sessionId);
  if (running !== undefined) return running;

  const task = (async (): Promise<WorkspaceKind> => {
    try {
      const response = await fetchImpl(`${GRAPH_API_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      const text = await response.text();
      let body: { ok?: boolean; error?: { code?: string } } | null = null;
      try {
        body = JSON.parse(text) as { ok?: boolean; error?: { code?: string } };
      } catch {
        body = null;
      }
      // 路由没就绪（纯文本 not found）→ unknown，且不缓存：宿主重启后应能自己恢复
      if (body === null) return "unknown";
      if (body.ok === true) {
        cache.set(sessionId, "library");
        return "library";
      }
      // 「宿主还不知道这个会话的工作区」（会话刚建、还没有 agent）≠「工作区不是知识库」：
      // 前者要稍后重问，**绝不能缓存**——否则新会话会永远看不到入口卡片。
      if (body.error?.code === "session_unknown") return "unknown";
      cache.set(sessionId, "other");
      return "other";
    } catch {
      return "unknown";
    } finally {
      inflight.delete(sessionId);
    }
  })();

  inflight.set(sessionId, task);
  return task;
}
