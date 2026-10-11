import { carryConversationSidebar, type ConversationSidebar } from "./conversation-sidebar.ts";
import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import type { DocumentTarget } from "./node-document-client.ts";
import { readArchivedFilter, type ArchivedFilter } from "./workspace-filter.ts";

/** Only standard create/navigation capabilities are borrowed from DSH. */
export interface ConversationServices {
  /**
   * `workspaceId` 是宿主把会话挂进工作区分组的**唯一**入口：只传 `cwd` 建出来的会话
   * 不在任何工作区的 `sessionIds` 里 ⇒ 侧栏归到「未分组」✗（用户反馈的正是这个）。
   * 两个都给时宿主只认 `workspaceId`（cwd 由工作区自己解析），所以调用方二选一。
   */
  sessions: {
    create(options: { cwd?: string; workspaceId?: string }): Promise<string>;
    list?: {
      getSnapshot(): { byId: Record<string, { title?: string; displayTitle?: string; blank?: boolean }>; phase?: string };
      subscribe?(listener: () => void): () => void;
    };
  };
  uiWorkspace: {
    openSession(sessionId: string): void;
    /**
     * 「这个工作区的新会话」：**复用**该工作区里已有的空白会话，没有才新建 ✓。
     * 与侧栏「+ 新会话」走的是同一个方法（`uiWorkspace.connectWorkspace`）——
     * 必须走它，插件的「打开新对话」才会和用户自己点「新会话」表现一致（见 makeConversationActions）。
     */
    connectWorkspace?(workspaceId: string): Promise<string>;
  };
  /** 可选：工作区控制器（老宿主没有）——只用它读快照，用来解析"这个节点属于哪个工作区" */
  workspaces?: { list?: { getSnapshot?(): unknown; subscribe?(listener: () => void): () => void } };
  sidebarRight?: ConversationSidebar;
}
export interface ConversationRecord { sessionId: string; createdAt: number }
export interface ConversationList { root: string; cwd: string; conversations: ConversationRecord[] }
type Fetcher = (url: string, options: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** 一次「等它真的有内容再记账」的待办 ✓ */


/** 一条历史记录在节点历史里该怎么出现（与侧栏「筛选会话」一致 ✓） */
export type ConversationState =
  /** 正常显示、点得开 ✓ */
  | "show"
  /** 显示但**已归档**：宿主不让直接打开，界面上要标出来并禁掉 ✗ */
  | "archived"
  /** 不显示（还没开始第一轮 / 当前筛选下不该出现 ✓） */
  | "hide";

/** 路径归一化：分隔符统一 + 去掉末尾分隔符（Windows 的 `D:\a\` 与 `D:/a` 要能对上） */
function normalizePath(value: string): string {
  return value.trim().replace(/[\\/]+/g, "/").replace(/\/+$/g, "");
}

/**
 * 从工作区快照里挑出「这个节点所在的工作区」。
 *
 * 顺序（先准后稳）：
 * 1. **库根所在的工作区目录**（宿主回的 `cwd` = `<工作区>/.dsh_knowledge` 的父目录）——
 *    它就是"节点所在的库属于哪个工作区"的直接表达 ✓；大小写先精确比、再忽略大小写比
 *    （Windows 盘符/目录名大小写常不一致，但 Linux 上大小写是不同的路径 ⇒ 精确优先）。
 * 2. 退回「当前会话归属的工作区」（`sessionIds` 含该会话）——库不在任何工作区下时仍可能对上 ✓。
 *
 * @param snapshot - `workspaces.list.getSnapshot()` 的快照（结构识别，不依赖宿主类型）。
 * @param options - 库根所在的工作区目录 `cwd` 与当前会话 id。
 * @returns 工作区 id；识别不出来时 undefined（调用方退回只传 `cwd` 的旧行为）。
 */
export function pickWorkspaceId(snapshot: unknown, options: { cwd?: string | undefined; sessionId?: string | undefined } = {}): string | undefined {
  const items = (() => {
    if (snapshot === null || typeof snapshot !== "object") return [] as Array<Record<string, unknown>>;
    const list = (snapshot as Record<string, unknown>).items;
    return Array.isArray(list) ? list.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];
  })();
  const idOf = (item: Record<string, unknown>): string | undefined =>
    typeof item.workspaceId === "string" && item.workspaceId !== "" ? item.workspaceId : undefined;

  const cwd = typeof options.cwd === "string" ? normalizePath(options.cwd) : "";
  if (cwd !== "") {
    const pathOf = (item: Record<string, unknown>): string => (typeof item.path === "string" ? normalizePath(item.path) : "");
    const exact = items.find((item) => pathOf(item) === cwd);
    if (exact !== undefined) return idOf(exact);
    const folded = items.find((item) => pathOf(item) !== "" && pathOf(item).toLowerCase() === cwd.toLowerCase());
    if (folded !== undefined) return idOf(folded);
  }

  const sessionId = typeof options.sessionId === "string" ? options.sessionId : "";
  if (sessionId !== "") {
    const owner = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.some((id) => id === sessionId));
    if (owner !== undefined) return idOf(owner);
  }
  return undefined;
}

/** Validate plugin HTTP responses, retaining the Host's error message. */
async function request(fetcher: Fetcher, body: object): Promise<ConversationList> {
  const response = await fetcher(GRAPH_API_ROUTE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data: unknown = await response.json();
  if (!response.ok || !data || typeof data !== "object" || !("ok" in data) || data.ok !== true) {
    const error = data && typeof data === "object" && "error" in data ? data.error : null;
    throw new Error(error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "Conversation request failed");
  }
  if (!("root" in data) || typeof data.root !== "string" || !("cwd" in data) || typeof data.cwd !== "string" || !("conversations" in data) || !Array.isArray(data.conversations)) throw new Error("Invalid conversation response");
  const conversations = data.conversations.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("sessionId" in entry) || typeof entry.sessionId !== "string" || !entry.sessionId.trim() || !("createdAt" in entry) || typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt) || entry.createdAt < 0) throw new Error("Invalid conversation record");
    return { sessionId: entry.sessionId, createdAt: entry.createdAt };
  });
  return { root: data.root, cwd: data.cwd, conversations };
}

/** Node-owned history persists before navigation, including sessions awaiting their first message. */
export function makeConversationActions(getServices: () => ConversationServices | undefined, fetcher: Fetcher) {
  const pending = new Map<string, string>();
  const running = new Map<string, Promise<string>>();
  const listeners = new Set<(recordsChanged: boolean) => void>();
  let unwatch: (() => void)[] = [];
  let cancelNavigation = () => {};
  const notify = (recordsChanged: boolean) => { for (const listener of [...listeners]) listener(recordsChanged); };
  const list = (nodeId: string, target?: DocumentTarget) => request(fetcher, { kind: "node-conversations", ...target, nodeId });
  const knownBlank = (services: ConversationServices, sessionId: string) => services.sessions.list?.getSnapshot().byId[sessionId]?.blank === true;
  const knownArchived = (services: ConversationServices, sessionId: string) => {
    const snapshot = services.workspaces?.list?.getSnapshot?.() as { archivedSessionIds?: unknown } | undefined;
    return Array.isArray(snapshot?.archivedSessionIds) && snapshot.archivedSessionIds.includes(sessionId);
  };
  const disposeWatchers = () => { for (const stop of unwatch) stop(); unwatch = []; };
  const bindWatchers = () => {
    disposeWatchers();
    if (!listeners.size) return;
    const services = getServices();
    for (const source of [services?.sessions.list, services?.workspaces?.list]) {
      if (source?.subscribe) unwatch.push(source.subscribe(() => notify(false)));
    }
  };
  return {
    list,
    subscribe(listener: (recordsChanged: boolean) => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) bindWatchers();
      return () => { listeners.delete(listener); if (!listeners.size) disposeWatchers(); };
    },
    servicesChanged() { bindWatchers(); notify(true); },
    dispose() { disposeWatchers(); cancelNavigation(); },
    async create(nodeId: string, target?: DocumentTarget): Promise<string> {
      const services = getServices();
      if (!services) throw new Error("DSH conversation service unavailable");
      const info = await list(nodeId, target);
      const key = JSON.stringify([info.root, nodeId]);
      const existing = running.get(key);
      if (existing) return existing;
      const work = (async () => {
        let sessionId = pending.get(key);
        if (sessionId === undefined) {
          const workspaceId = pickWorkspaceId(services.workspaces?.list?.getSnapshot?.(), { cwd: info.cwd, sessionId: target?.sessionId });
          sessionId = workspaceId !== undefined && services.uiWorkspace.connectWorkspace
            ? await services.uiWorkspace.connectWorkspace(workspaceId)
            : await services.sessions.create(workspaceId === undefined ? { cwd: info.cwd } : { workspaceId });
          pending.set(key, sessionId);
        }
        await request(fetcher, { kind: "record-node-conversation", root: info.root, nodeId, conversationId: sessionId });
        pending.delete(key);
        notify(true);
        return sessionId;
      })();
      running.set(key, work);
      try { return await work; } finally { running.delete(key); }
    },
    open(sessionId: string): void {
      const services = getServices();
      if (!services) throw new Error("DSH conversation service unavailable");
      cancelNavigation();
      const carried = carryConversationSidebar(services.sidebarRight, sessionId);
      let stop = () => {};
      const restore = () => { if (carried.restore()) stop(); };
      stop = carried.watch(restore);
      cancelNavigation = () => { carried.cancel(); stop(); };
      try { services.uiWorkspace.openSession(sessionId); restore(); }
      catch (error) { cancelNavigation(); throw error; }
    },
    title(sessionId: string): string {
      const entry = getServices()?.sessions.list?.getSnapshot().byId[sessionId];
      return entry?.title ?? entry?.displayTitle ?? sessionId.slice(0, 12);
    },
    /**
     * 这条记录还算不算"一次对话"——**只知道是空白时**才说不算 ✓
     * （列表还没就绪、或这个会话已经不在列表里时按"算"处理：宁可多显示一条历史，也别把用户的对话藏起来）。
     * @param sessionId - 索引里记着的会话 id。
     * @returns false = 已知是空白会话（还没开始第一轮）。
     */
    hasContent(sessionId: string): boolean {
      const services = getServices();
      return services === undefined ? true : !knownBlank(services, sessionId);
    },
    /** 侧栏当前选中的归档筛选（**每轮渲染读一次**即可：那是一次 localStorage 全键扫描 ✓） */
    archivedFilter(): ArchivedFilter {
      return readArchivedFilter();
    },
    /**
     * 这条历史记录现在该怎么出现 —— **跟随侧栏「筛选会话」的归档规则** ✓（用户要求）。
     *
     * 为什么必须跟：归档的会话宿主不让直接打开（点一下毫无反应 ✗），可它照样列在节点历史里就说不通了。
     * 规则与侧栏逐条对齐：
     * - `default`（隐藏已归档，宿主默认）⇒ 已归档的**不显示** ✓；
     * - `show`（全部对话）⇒ 显示，但标成"已归档"并禁掉（点不开的东西不该看着能点 ✗）；
     * - `only`（仅显示已归档）⇒ **只**显示已归档的那些 ✓。
     *
     * 拿不到工作区快照 / 读不出筛选时按宿主默认处理，但**绝不误伤**：
     * 只有确知"已归档"才隐藏；确知是空白会话一律不显示（那不是一次对话 ✓）。
     *
     * @param sessionId - 索引里记着的会话 id。
     * @param filter - 侧栏当前的筛选值（缺省现读一次；列表渲染时应**每轮只读一次**再传进来 ✓）。
     * @returns 该怎么渲染这条记录。
     */
    recordState(sessionId: string, filter: ArchivedFilter = readArchivedFilter()): ConversationState {
      const services = getServices();
      if (services === undefined) return "show";
      if (knownBlank(services, sessionId)) return "hide";
      const archived = knownArchived(services, sessionId);
      const catalog = services.sessions.list?.getSnapshot();
      if (!archived && catalog?.phase === "ready" && !Object.hasOwn(catalog.byId, sessionId)) return "hide";
      if (filter === "only") return archived ? "archived" : "hide";
      if (filter === "show") return archived ? "archived" : "show";
      return archived ? "hide" : "show";
    },
  };
}

let getServices: () => ConversationServices | undefined = () => undefined;
/** Attach a lazy, lifetime-owned service lookup from the plugin Client context. */
export function attachConversationServices(lookup: () => ConversationServices | undefined): () => void {
  getServices = lookup;
  nodeConversations.servicesChanged();
  return () => { if (getServices === lookup) { nodeConversations.dispose(); getServices = () => undefined; } };
}
export const nodeConversations = makeConversationActions(() => getServices(), (url, options) => fetch(url, options));
