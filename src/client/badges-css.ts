/**
 * 「知识库」标志（纯函数部分，便于单测）。
 *
 * 为什么是"注入样式"而不是"注册插槽"：左侧栏的 `sidebar.workspaces` 是 **single** 槽位
 * （整段浏览区由 ui-workspace 一个占用者渲染），工作区那一行**没有**任何行级插槽
 * （行级插槽只有会话行的 `sidebar.session.row.leading/hover` 与 `...row.action`）。
 * 但那一行有稳定且语义明确的 DOM 标记：`data-row-key="workspace:<workspaceId>"`
 * （Rows.tsx:245，而 group.key 就是 workspaceId —— tree.ts:355-358）。
 *
 * 做法：**换字形**。藏掉原来的文件夹 SVG，用 `mask` 把知识库图标画上去——颜色仍是
 * `currentColor`（跟随行本身），所以它看起来就是宿主自己的一枚图标，而不是外挂的徽标/胶囊。
 */

/**
 * 知识库图标（与客户端组件 `PanelIcon.tsx` 同一套路径：三节点相连）。
 * 作为 mask 使用时只需 alpha，所以描边用黑色即可。
 * **坐标系与线宽对齐宿主**：`viewBox="0 0 16 16"` + `stroke-width="1"`（宿主的 ICON_REGULAR_STROKE）。
 */
const KN_GRAPH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="black"'
  + ' stroke-width="1" stroke-linecap="round">'
  + '<path d="M8 5.3v5.4"/><path d="M8 10.7 4.3 13.4"/><path d="M8 10.7 11.7 13.4"/>'
  + '<circle cx="8" cy="3.6" r="1.7"/><circle cx="3.4" cy="14.4" r="1.5"/><circle cx="12.6" cy="14.4" r="1.5"/>'
  + "</svg>";

/** 图标的 data URL（`#`/`<`/`>`/引号等一律百分号编码，避免把样式表搞坏） */
export function graphIconDataUrl(): string {
  return `url("data:image/svg+xml,${encodeURIComponent(KN_GRAPH_ICON)}")`;
}

/** 图标变量的名字（数据 URL 只写一次，多个工作区共用） */
export const ICON_VAR = "--kn-libid-icon";

/** 从 `useWorkspaces()` 快照里取出工作区条目（形状按语义识别，与 workspace-path.ts 同一套宽容策略） */
export interface WorkspaceEntry {
  workspaceId: string;
  path?: string;
}

export function workspaceEntries(snapshot: unknown): WorkspaceEntry[] {
  if (snapshot === null || typeof snapshot !== "object") return [];
  const root = snapshot as Record<string, unknown>;
  const list = Array.isArray(root.items)
    ? root.items
    : Array.isArray(root.workspaces) ? root.workspaces : [];
  const out: WorkspaceEntry[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = record.workspaceId ?? record.id;
    if (typeof id !== "string" || id === "") continue;
    const path = record.path ?? record.root ?? record.cwd;
    out.push({ workspaceId: id, path: typeof path === "string" && path !== "" ? path : undefined });
  }
  return out;
}

/** CSS 选择器里的转义 */
function cssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ");
}

/** 一个工作区行的换字形规则 */
function badgeRules(workspaceId: string): string {
  const selector = `[data-row-key="workspace:${cssString(workspaceId)}"]`;
  /*
   * `span:nth-of-type(1)` 就是行首那格字形（folder / chevron / projectText / rowActions 四个 span）。
   * 藏掉宿主 SVG 后用 ::before + mask 画知识库图标；尺寸交给容器自身的布局（16px 格），
   * 颜色走 currentColor，所以亮暗主题与选中态都自动跟随。
   */
  const glyph = `${selector} > span:nth-of-type(1)`;
  return [
    `${glyph} svg { display: none; }`,
    `${glyph}::before {`
    + " content: \"\";"
    + " display: block;"
    + " width: 15px;"
    + " height: 15px;"
    + " background-color: currentColor;"
    + ` -webkit-mask: var(${ICON_VAR}) center / contain no-repeat;`
    + ` mask: var(${ICON_VAR}) center / contain no-repeat; }`,
  ].join("\n");
}

/**
 * 生成换字形样式表。
 * @param workspaceIds - 已确认是知识库的工作区 id（`WorkspaceView.workspaceId`）。
 * @returns CSS 文本；空集合时返回空串（调用方据此不注入 `<style>`）。
 */
export function libraryBadgeCss(workspaceIds: readonly string[]): string {
  const ids = [...new Set(workspaceIds.filter((id) => typeof id === "string" && id !== ""))];
  if (ids.length === 0) return "";
  // 图标只声明一次；`all: initial` 之外的规则全部限定在 workspace 行上
  const variables = `:root { ${ICON_VAR}: ${graphIconDataUrl()}; }`;
  return [variables, ...ids.map((id) => badgeRules(id))].join("\n");
}
