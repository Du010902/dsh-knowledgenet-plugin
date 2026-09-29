/**
 * 从客户端标准 props 的快照里挑出「当前工作区路径」。
 *
 * 为什么需要：入口卡片要不要出现，取决于「这个工作区是不是知识库」。会话 id 那条路依赖宿主
 * 已经有这个会话（全新会话可能还没有），而**工作区路径客户端本来就知道**（标准 props 里有
 * `useWorkspaces` / `useSession`）。有了路径就可以用 `?root=` 直接问宿主，与会话无关。
 *
 * 本插件是编译型插件：拿不到 `WorkspaceSnapshot` 这些声明类型，所以这里做**结构化识别**——
 * 只按字段语义判断（`path` + `sessionIds` / `selected` 标记），认不出来就返回 undefined，
 * 让调用方退回会话那条路，而不是猜一个值。
 */

/** 候选工作区对象里可能承载路径的字段名 */
const PATH_KEYS = ["path", "root", "cwd", "directory", "dir"] as const;
/** 候选数组可能挂在快照的这些键下 */
const LIST_KEYS = ["workspaces", "entries", "items", "list", "all", "records"] as const;
/** 「当前选中」标记的字段名 */
const SELECTED_KEYS = ["selected", "active", "current", "isSelected", "isCurrent", "isActive"] as const;

function readPath(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return undefined;
}

function isFlaggedSelected(value: Record<string, unknown>): boolean {
  for (const key of SELECTED_KEYS) {
    if (value[key] === true) return true;
  }
  return false;
}

function collectCandidates(snapshot: unknown): Array<Record<string, unknown>> {
  if (snapshot === null || typeof snapshot !== "object") return [];
  const root = snapshot as Record<string, unknown>;
  const candidates: Array<Record<string, unknown>> = [];
  for (const key of LIST_KEYS) {
    const list = root[key];
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item !== null && typeof item === "object") candidates.push(item as Record<string, unknown>);
      }
    }
  }
  // 快照本身就是一条工作区记录的情况
  if (candidates.length === 0 && readPath(root) !== undefined) candidates.push(root);
  return candidates;
}

/**
 * 挑出当前工作区路径。
 * @param snapshot - `useWorkspaces()` 的完整快照（形状按语义识别）。
 * @param sessionId - 用来把工作区与当前会话对上（优先命中 `sessionIds` 里含它的那条）。
 * @returns 路径；识别不出来时 undefined。
 */
export function pickWorkspacePath(snapshot: unknown, sessionId?: string): string | undefined {
  // 快照必须是对象：裸字符串之类的东西不该被当成路径（那会拿垃圾值去问宿主）
  if (snapshot === null || typeof snapshot !== "object") return undefined;

  const candidates = collectCandidates(snapshot);
  if (candidates.length === 0) {
    // 也可能是「扁平」的会话快照：{ header: { cwd } } / { cwd } / { workspacePath }
    return pickSessionPath(snapshot);
  }

  if (sessionId !== undefined && sessionId !== "") {
    for (const candidate of candidates) {
      const ids = candidate.sessionIds;
      if (Array.isArray(ids) && ids.some((id) => id === sessionId)) {
        const path = readPath(candidate);
        if (path !== undefined) return path;
      }
    }
  }

  for (const candidate of candidates) {
    if (isFlaggedSelected(candidate)) {
      const path = readPath(candidate);
      if (path !== undefined) return path;
    }
  }

  // 快照里有 selectedId / activeId 之类的指针时，用它对上 id / workspaceId
  const root = snapshot as Record<string, unknown>;
  const pointer = ["selectedId", "activeId", "currentId", "selectedWorkspaceId", "activeWorkspaceId"]
    .map((key) => root[key])
    .find((value) => typeof value === "string");
  if (typeof pointer === "string") {
    for (const candidate of candidates) {
      if (candidate.id === pointer || candidate.workspaceId === pointer) {
        const path = readPath(candidate);
        if (path !== undefined) return path;
      }
    }
  }

  // 只有一个工作区时不必挑
  if (candidates.length === 1) return readPath(candidates[0]);
  return undefined;
}

/** 会话快照里的 cwd 形态（`header.cwd` / `cwd` / `workspacePath` / `workspace.path`） */
export function pickSessionPath(snapshot: unknown): string | undefined {
  if (snapshot === null || typeof snapshot !== "object") return undefined;
  const record = snapshot as Record<string, unknown>;
  const direct = readPath(record);
  if (direct !== undefined) return direct;
  const header = record.header;
  if (header !== null && typeof header === "object") {
    const fromHeader = readPath(header);
    if (fromHeader !== undefined) return fromHeader;
  }
  const workspacePath = record.workspacePath;
  if (typeof workspacePath === "string" && workspacePath.trim() !== "") return workspacePath;
  const workspace = record.workspace;
  if (workspace !== null && typeof workspace === "object") return readPath(workspace);
  return undefined;
}

/** 面板要绑定的目标：请求该带哪个参数去问宿主 */
export interface PanelTarget {
  kind: "root" | "session";
  value: string;
}

/**
 * 决定面板绑定到哪个库。
 *
 * 优先级：**标签页 params 里的 root**（用户在左侧栏「知识库」区块点开的那个库，最明确的意图）
 * → 工作区路径 → 会话 id（宿主按该会话 cwd 向上找 library.json）。
 *
 * @param input - 三个来源，都可以缺席。
 * @returns 请求参数目标；三者都没有时 undefined（面板会显示"跟随当前工作区"的提示）。
 */
export function resolvePanelTarget(input: {
  overrideRoot?: string | undefined;
  workspacePath?: string | undefined;
  sessionId?: string | undefined;
}): PanelTarget | undefined {
  /*
   * **优先级：当前工作区 → 会话 id → 标签页里的显式 root**。
   *
   * 为什么工作区排第一：它就是"面板跟随当前工作区"的直接表达 ✓，而且宿主已支持**把工作区路径
   * 当 root**（自动解析 `<工作区>/.dsh_knowledge/`；没有则回 `library_missing` 供面板静默创建）✓。
   *
   * 为什么不用 DOM 里的会话 id：`data-conversation-session` 是**对话**标识，宿主按**会话**查
   * 工作区时认不出来 ⇒ 面板会收到 `[session_unknown]`（实测踩到 ✗）。
   *
   * 为什么显式 root 排最后：它是**开标签页那一刻**的快照，会一直粘着 ✗。
   */
  const workspace = typeof input.workspacePath === "string" ? input.workspacePath.trim() : "";
  if (workspace !== "") return { kind: "root", value: workspace };
  const session = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  if (session !== "") return { kind: "session", value: session };
  const override = typeof input.overrideRoot === "string" ? input.overrideRoot.trim() : "";
  if (override !== "") return { kind: "root", value: override };
  return undefined;
}
