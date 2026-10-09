import { GRAPH_API_ROUTE, PANEL_ID } from "../shared/routes.ts";
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
  workspaces?: { list?: { getSnapshot?(): unknown } };
  /**
   * 可选：右侧栏导航（`ctx.sidebarRight`）。
   *
   * 用途只有一个：**把用户刚才待的那一栏跟到新对话里**。DSH 的右侧栏（含已开标签）
   * 是**每个会话一份**的停靠面，新建会话必然切到一个"折叠且为空"的面 ⇒ 从节点打开对话后
   * 右侧栏会塌掉、图谱标签也不见了（用户实测）。会话一换就补开自己的标签，
   * 用户就不会"点开对话、面板没了"。
   */
  sidebarRight?: {
    openTabIn?(sessionId: string, kind: string, options?: unknown): void;
    /** 席位正挂着的会话（宿主公开的可观察值）——等它等于新会话再开，否则写不进"没人绘制的面" */
    mounted?: { getSnapshot?(): string | undefined };
  };
}
export interface ConversationRecord { sessionId: string; createdAt: number }
export interface ConversationList { root: string; cwd: string; conversations: ConversationRecord[] }
type Fetcher = (url: string, options: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** 一次「等它真的有内容再记账」的待办 ✓ */
interface DeferredRecord { root: string; nodeId: string }

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
    if (!entry || typeof entry !== "object" || !("sessionId" in entry) || typeof entry.sessionId !== "string" || !("createdAt" in entry) || typeof entry.createdAt !== "number") throw new Error("Invalid conversation record");
    return { sessionId: entry.sessionId, createdAt: entry.createdAt };
  });
  return { root: data.root, cwd: data.cwd, conversations };
}

/**
 * 节点对话的工作流。
 *
 * 三条用户实测出来的规则（都写在这里，别在别处重造）：
 * 1. **新对话必须挂在"这个节点所在的工作区"**：只传 `cwd` 建出来的会话不在任何工作区的
 *    `sessionIds` 里 ⇒ 侧栏归到「未分组」✗。所以能解析出 `workspaceId` 就只传它。
 * 2. **新对话要走宿主自己的"工作区新会话"**（`connectWorkspace`：复用该工作区已有的空白会话，
 *    没有才新建）。自己 `sessions.create` 每次都造一个新的空白会话 ⇒ 用户点「打开新对话」
 *    就被切到一个新会话上：右侧栏塌掉、已开标签清空（每会话一份停靠面）；
 *    而侧栏「+ 新会话」因为复用了当前那个空白会话、**根本没换会话**，所以看起来一切照旧 ✓。
 * 3. **没有内容的会话不记账**：宿主把"还没开始第一轮"的会话标成 `blank`，侧栏只显示当前那一个 ✓
 *    ⇒ 记进节点索引就会留下一条"侧栏里找不到、节点里却有"的对话 ✗。
 *    所以空白会话先挂起，等它真的开始第一轮（列表快照里 `blank === false`）再写索引 ✓。
 *
 * 另外：索引写入失败时，同一次运行内重试复用**同一个**已建会话（不重复造空白会话 ✓）。
 */
export function makeConversationActions(getServices: () => ConversationServices | undefined, fetcher: Fetcher) {
  const pending = new Map<string, string>();
  const running = new Map<string, Promise<string>>();
  const list = (nodeId: string, target?: DocumentTarget) => request(fetcher, { kind: "node-conversations", ...target, nodeId });

  /** 已经建好、但还没写进索引的会话（键 = `[库根, 节点]`）⇒ 重试不重复建 ✓ */
  const record = (root: string, nodeId: string, conversationId: string) =>
    request(fetcher, { kind: "record-node-conversation", root, nodeId, conversationId });

  /** 等内容的待办：会话 → 它该记给谁 ✓ */
  const deferred = new Map<string, DeferredRecord>();
  /** 曾经在列表里见过、后来消失的会话（用来判断"被删了"，避免把晚到的会话误判成不存在 ✓） */
  const seen = new Set<string>();
  /** 正在写索引的会话（避免同一会话并发写两次） */
  const writing = new Set<string>();
  let unwatch: (() => void) | undefined;

  /** 这个会话**已知**"还没开始第一轮"吗？（拿不到列表/字段时一律说"不知道"，宁可记也别丢 ✓） */
  const knownBlank = (services: ConversationServices, sessionId: string): boolean =>
    services.sessions.list?.getSnapshot?.().byId?.[sessionId]?.blank === true;

  /** 这个会话**已被归档**吗？（归档集合由工作区控制器权威给出 ✓） */
  const knownArchived = (services: ConversationServices, sessionId: string): boolean => {
    const snapshot = services.workspaces?.list?.getSnapshot?.() as { archivedSessionIds?: unknown } | undefined;
    const ids = snapshot?.archivedSessionIds;
    return Array.isArray(ids) && ids.some((id) => id === sessionId);
  };

  /** 挂起/继续/收尾：把已经"开始过"的会话写进索引 ✓ */
  const flushDeferred = (): void => {
    const services = getServices();
    if (services === undefined) return;
    const state = services.sessions.list?.getSnapshot?.();
    for (const [sessionId, target] of [...deferred]) {
      const summary = state?.byId?.[sessionId];
      if (summary === undefined) {
        /*
         * 列表已经就绪却完全没有它 ⇒ 会话被删了，这条对话不存在，没必要记 ✓。
         * 只对"以前真的见过"的会话这样判：刚建好的会话可能晚一拍才进列表，
         * 那时误判成"不存在"就会漏记 ✗。
         */
        if (state?.phase === "ready" && seen.has(sessionId)) deferred.delete(sessionId);
        continue;
      }
      seen.add(sessionId);
      if (summary.blank === true || writing.has(sessionId)) continue;
      writing.add(sessionId);
      record(target.root, target.nodeId, sessionId)
        .then(() => { deferred.delete(sessionId); })
        .catch(() => { /* 下一轮列表变化再试；写失败不该打扰正在对话的用户 */ })
        .finally(() => {
          writing.delete(sessionId);
          if (deferred.size === 0 && unwatch !== undefined) { unwatch(); unwatch = undefined; }
        });
    }
  };

  /** 会话是空白时：先挂起，等它开始第一轮再记账 ✓ */
  const deferRecord = (services: ConversationServices, sessionId: string, target: DeferredRecord): void => {
    const subscribe = services.sessions.list?.subscribe;
    if (typeof subscribe !== "function") { void record(target.root, target.nodeId, sessionId).catch(() => undefined); return; }
    deferred.set(sessionId, target);
    if (unwatch === undefined) unwatch = subscribe(flushDeferred);
    flushDeferred();
  };

  /**
   * 取一个"该用哪个会话"：优先宿主自己的工作区新会话（复用空白 ⇒ 不换会话 ⇒ 右侧栏不动 ✓）；
   * 拿不到那个方法（老宿主）才自己 `sessions.create`，再退回只传 cwd 的旧行为 ✓。
   */
  const sessionFor = async (services: ConversationServices, info: ConversationList, workspaceId: string | undefined): Promise<string> => {
    if (workspaceId !== undefined && typeof services.uiWorkspace.connectWorkspace === "function") {
      return await services.uiWorkspace.connectWorkspace(workspaceId);
    }
    return await services.sessions.create(workspaceId === undefined ? { cwd: info.cwd } : { workspaceId });
  };

  /**
   * 把图谱那一栏跟到刚打开的对话里（右侧栏是每会话一份的停靠面，不补开就塌了 ✓）。
   *
   * 时序：`openSession` 之后新会话的席位才挂上，`ctx.sidebarRight` 在席位挂上之前
   * 写不进"没人绘制的面" ⇒ 先等 `mounted` 报告这个会话再开。读数拿不到（老宿主）时
   * 退化成几十次短延迟重试；都不成就安静放弃（打不开面板不该挡住"打开对话"本身 ✓）。
   */
  const keepPanelOpen = (services: ConversationServices, sessionId: string): void => {
    const navigation = services.sidebarRight;
    const openTabIn = navigation?.openTabIn;
    if (navigation === undefined || typeof openTabIn !== "function") return;
    const mounted = navigation.mounted;
    let tries = 0;
    const step = (): void => {
      tries += 1;
      const settled = mounted === undefined ? tries >= 3 : mounted.getSnapshot?.() === sessionId;
      if (!settled) {
        if (tries < 30) setTimeout(step, 100);
        return;
      }
      try { openTabIn.call(navigation, sessionId, PANEL_ID); }
      catch { /* 类型没注册（宿主没有这一栏）：安静放弃 ✓ */ }
    };
    step();
  };

  return {
    list,
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
          sessionId = await sessionFor(services, info, workspaceId);
          pending.set(key, sessionId);
        }
        if (knownBlank(services, sessionId)) {
          /* 空白会话：先不写索引，等它真的开始第一轮 ✓（见文件头第 3 条） */
          pending.delete(key);
          deferRecord(services, sessionId, { root: info.root, nodeId });
          return sessionId;
        }
        await record(info.root, nodeId, sessionId);
        pending.delete(key);
        return sessionId;
      })();
      running.set(key, work);
      try { return await work; } finally { running.delete(key); }
    },
    open(sessionId: string): void {
      const services = getServices();
      if (!services) throw new Error("DSH conversation service unavailable");
      services.uiWorkspace.openSession(sessionId);
      keepPanelOpen(services, sessionId);
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
  return () => { if (getServices === lookup) getServices = () => undefined; };
}
export const nodeConversations = makeConversationActions(() => getServices(), (url, options) => fetch(url, options));
