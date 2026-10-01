/**
 * 「添加知识库」表头按钮：注册选项、按钮样式、锚点定位（纯逻辑，便于单测）。
 *
 * 为什么是 DOM 注入：`sidebar.workspaces` 是 single 槽位（整段浏览区由 ui-workspace 渲染），
 * 它的表头动作区（搜索 / 视图选项 / 添加工作区）**没有任何插槽**——ui-workspace 的完整槽位表
 * 只有 6 个键（`directoryFlow` ×2、会话行的 4 个），其中 `directoryFlow` 是**目录选择器本体**
 * （shipped 的「添加工作区」按钮就靠它是否被占用来决定显隐），占了它等于换掉官方选择器。
 *
 * 所以这里按宿主自己的结构定位动作容器并追加一个同尺寸按钮：
 * 表头 = 搜索框往上找到的第一个「含 data-row-key 行」的祖先的第一个子元素
 * （`WorkspaceBrowser.tsx:1207-1303`：sectionHeader → label / searchSlot / headerActions / flow）；
 * 动作容器 = 表头里**不含搜索框**但含 button 的那个子元素。
 * 找不到就什么都不做（并留一条日志），宿主改版最多是"按钮不出现"。
 */

/** 注册 id（`sidebar.footer.action` 的必填 id） */
export const ADD_LIBRARY_ID = "knowledgenet.add-library";
/** 位置：与标志注入器同区、排在其后 */
export const ADD_LIBRARY_ORDER = 50;

/** 注入按钮的类名（样式由本模块的 CSS 提供） */
export const HEADER_BUTTON_CLASS = "kn-add-library";

/** 锚点查找的节流间隔：聊天流式渲染会高频触发 DOM 变化，不能每批都做一次祖先链搜索 */
export const SEARCH_THROTTLE_MS = 150;

/**
 * 首轮找不到锚点后的额外重试时刻（毫秒）。
 *
 * 为什么需要：挂载那一刻表头可能还没渲染（或侧栏处于收起态、搜索框根本不存在），
 * 而"只查一次"的实现会永久放弃——实测就是这么翻车的。所以除了 MutationObserver，
 * 还保留这几档定时重试，覆盖"之后完全没有 DOM 变化"的情况。
 */
export const RETRY_DELAYS_MS: readonly number[] = [400, 1200, 3000];

/*
 * 创建确认现在走**自己的弹窗**（ConfirmDialog.tsx），不再有"两步点击"状态机。
 * 原因：原生 `window.confirm` 在桌面端渲染环境会被静默忽略（直接返回 false），
 * 而"再点一次"的交互又不够显式——用户不知道还要再点一下。
 */

/**
 * 确认弹窗的样式（注入到 document head：弹窗 portal 在 light DOM 里，Shadow 样式管不到）。
 *
 * 颜色全走宿主 token，亮暗主题自动跟随；`position: fixed` 让弹窗不受侧栏祖先变换影响。
 */
export function confirmDialogCss(): string {
  return [
    ".kn-modal-backdrop {",
    "  position: fixed; inset: 0; z-index: 9999;",
    "  display: flex; align-items: center; justify-content: center;",
    "  background: rgba(0, 0, 0, 0.45); }",
    ".kn-modal {",
    "  box-sizing: border-box; width: min(420px, calc(100vw - 48px));",
    "  padding: 18px 20px 14px;",
    "  border: 1px solid var(--dsw-alias-border-l2);",
    "  border-radius: 12px;",
    "  background: var(--dsw-alias-bg-layer-1);",
    "  color: var(--dsw-alias-label-primary);",
    "  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);",
    "  font-size: 13px; line-height: 1.5; }",
    ".kn-modal-title { margin-bottom: 8px; font-size: 14px; font-weight: 600; }",
    ".kn-modal-body { color: var(--dsw-alias-label-secondary); word-break: break-all; }",
    ".kn-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }",
    ".kn-modal-btn {",
    "  padding: 5px 14px; border: 1px solid var(--dsw-alias-border-l2);",
    "  border-radius: 8px; background: transparent;",
    "  color: var(--dsw-alias-label-primary); font: inherit; cursor: pointer; }",
    ".kn-modal-btn:hover { background: var(--kn-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)); }",
    ".kn-modal-primary {",
    "  border-color: transparent;",
    "  background: var(--dsw-alias-brand-primary);",
    "  color: #ffffff; }",
    ".kn-modal-primary:hover { filter: brightness(1.06); }",
  ].join("\n");
}

export interface AddLibraryOptionsInput {
  locale?: string | undefined;
  label: string;
  inject: () => unknown;
}

/** 组装 `slots.register` 的选项 */
export function addLibraryOptions(input: AddLibraryOptionsInput): Record<string, unknown> {
  return {
    name: "sidebar.footer.action",
    id: ADD_LIBRARY_ID,
    order: ADD_LIBRARY_ORDER,
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    inject: input.inject,
  };
}

/** 按钮图标（图谱 + 右上角加号）的 mask 变量名 */
export const ADD_ICON_VAR = "--kn-libid-add-icon";

/**
 * 「添加知识库」的图标：**一枚** 24 网格图标里同时含图谱与加号。
 *
 * 为什么合成一枚，而不是"主图标 + 绝对定位的加号"：后者会让加号顶到 16px 图标框之外，
 * 与旁边三颗按钮比就显得"高了一截"（实测被指出来）。shipped 的 `IconProjectAddOutlineRegular`
 * 也是"文件夹 + 加号"同在一枚 16px 图标里，这里照同一思路：图谱占左下，加号在右上，
 * 整枚都画在 **16 网格**里，且线宽与邻居同为 1（宿主 `ICON_REGULAR_STROKE`），缩放后粗细与视觉尺寸都一致。
 */
const GRAPH_ADD_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="black"'
  + ' stroke-width="1" stroke-linecap="round">'
  // 图谱：上节点 + 左下 + 右下，两条连线（坐左下，给右上角的加号留位）
  + '<path d="M6.2 6.6 3.2 10.4"/><path d="M6.2 6.6 9.4 10.4"/>'
  + '<circle cx="6.2" cy="5" r="1.5"/><circle cx="2.4" cy="11.4" r="1.3"/><circle cx="10.2" cy="11.4" r="1.3"/>'
  // 加号：右上角（线宽同样是 1，与邻居的图标粗细一致）
  + '<path d="M11.4 4.4h3.6"/><path d="M13.2 2.6v3.6"/>'
  + "</svg>";

/** 合成图标的 data URL（百分号编码，避免把样式表搞坏） */
export function graphAddIconDataUrl(): string {
  return `url("data:image/svg+xml,${encodeURIComponent(GRAPH_ADD_SVG)}")`;
}

/** 按钮样式：逐项对齐 shipped 的 `.iconButton`（WorkspaceBrowser.module.css:17-43） */
export function headerButtonCss(): string {
  return [
    `.${HEADER_BUTTON_CLASS} {`,
    "  flex: none; display: inline-flex; align-items: center; justify-content: center;",
    "  width: 28px; height: 28px; padding: 0;",
    "  border: none; border-radius: var(--dsw-radius-sm, 6px);",
    "  background: transparent; color: var(--dsw-alias-label-secondary);",
    "  cursor: pointer; }",
    `.${HEADER_BUTTON_CLASS}:hover:not(:disabled) { background: var(--kn-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)); }`,
    `.${HEADER_BUTTON_CLASS}:focus-visible {`,
    "  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));",
    "  outline-offset: -2px; }",
    `.${HEADER_BUTTON_CLASS}:disabled { opacity: 0.55; cursor: default; }`,
    // 失败反馈：没有官方 toast，就用按钮自身的红色状态 + title（原生 tooltip）
    `.${HEADER_BUTTON_CLASS}[data-kn-error="1"] { color: var(--dsw-alias-state-error-primary); }`,
    `.${HEADER_BUTTON_CLASS}-glyph {`,
    "  display: block; width: 16px; height: 16px; background-color: currentColor;",
    // 与旁边三颗按钮同尺寸（shipped 在宽侧栏用的是 size=16）
    `  -webkit-mask: var(${ADD_ICON_VAR}) center / contain no-repeat;`,
    `  mask: var(${ADD_ICON_VAR}) center / contain no-repeat; }`,
  ].join("\n");
}

/** 定位所需的最小 DOM 面（便于用假对象单测） */
export interface DomNode {
  parentElement: DomNode | null;
  children: Iterable<DomNode>;
  querySelector(selector: string): DomNode | null;
  contains(other: DomNode): boolean;
}

/**
 * 从表头和搜索框挑出动作容器。
 * @param header - 表头元素（搜索框与动作容器的共同父节点）。
 * @param searchInput - 表头里的搜索输入框（用来排除搜索那一格）。
 * @returns 动作容器；找不到时 null。
 */
export function pickActionsContainer(header: DomNode | null, searchInput: DomNode): DomNode | null {
  if (header === null) return null;
  for (const child of header.children) {
    // 搜索位自己也有 button，必须先排除
    if (child.contains(searchInput)) continue;
    if (child.querySelector("button") !== null) return child;
  }
  return null;
}

/**
 * 找到表头元素（按钮挂在它下面）。
 *
 * 为什么**不**挂进动作簇（`.headerActions`）：那个容器的几何是
 * `flex: none; display: flex; gap: 4px; max-width: 60px; overflow: hidden`
 * —— 60px 正好等于 shipped 两颗 28px 按钮加 4px 间距，第三颗会被 `overflow: hidden` 裁掉。
 * （实测就是这样：诊断显示 chosen=2 正确、按钮也插进去了，却完全看不见。）
 * 挂在表头上由表头自己的 flex 布局分空间，**不需要改宿主的任何样式**。
 *
 * 定位方式：侧栏搜索框 → 往上第一个「含 data-row-key 行」的祖先 → 其第一个子元素即表头
 * （`WorkspaceBrowser.tsx:1207-1303`：sectionHeader 的子元素依次是 label / searchSlot /
 * headerActions / pick-flow）。
 */
export function findHeaderMount(doc: {
  querySelector(selector: string): DomNode | null;
}): DomNode | null {
  const input = doc.querySelector('input[type="text"]');
  if (input === null) return null;
  let ancestor: DomNode | null = input.parentElement;
  while (ancestor !== null && ancestor.querySelector("[data-row-key]") === null) {
    ancestor = ancestor.parentElement;
  }
  return firstElementChild(ancestor);
}

function firstElementChild(node: DomNode | null): DomNode | null {
  if (node === null) return null;
  for (const child of node.children) return child;
  return null;
}

/** 上报/诊断用的结构指纹：只描述形状（标签、是否有按钮/搜索框、子节点数），不含任何文本或路径 */
export interface HeaderFingerprint {
  outcome: "injected" | "no-search-input" | "no-rows-ancestor" | "no-actions-container";
  /** 从搜索框往上的层级（tag + 是否含按钮 + 子节点数） */
  chain: Array<{ tag: string; hasButton: boolean; children: number }>;
  /** 表头各子元素（tag + 是否含按钮 + 是否含搜索框） */
  candidates: Array<{ tag: string; hasButton: boolean; hasInput: boolean }>;
  /** 实际选中的候选下标（-1 = 没选中）——看出来"插到哪里去了"靠它 */
  chosen: number;
  /** 按钮实际挂到哪一层（目前固定挂表头，避开限宽的动作簇） */
  appendedTo: string;
}

function tagOf(node: DomNode): string {
  const tag = (node as { tagName?: unknown }).tagName;
  return typeof tag === "string" ? tag.toLowerCase() : "?";
}

function countChildren(node: DomNode): number {
  let total = 0;
  for (const _ of node.children) total += 1;
  return total;
}

/**
 * 生成「按钮为什么没注入」的结构指纹。
 *
 * 客户端半没有日志出口，所以把这份指纹 POST 给宿主，`kn_status` 就能直接回答——
 * 失败原因（搜索框不存在？往上找不到行？动作容器挑不出来？）都在里面。
 */
export function describeHeader(doc: {
  querySelector(selector: string): DomNode | null;
}): HeaderFingerprint {
  const input = doc.querySelector('input[type="text"]');
  if (input === null) return { outcome: "no-search-input", chain: [], candidates: [], chosen: -1, appendedTo: "none" };

  const chain: HeaderFingerprint["chain"] = [];
  let ancestor: DomNode | null = input.parentElement;
  while (ancestor !== null) {
    chain.push({
      tag: tagOf(ancestor),
      hasButton: ancestor.querySelector("button") !== null,
      children: countChildren(ancestor),
    });
    if (ancestor.querySelector("[data-row-key]") !== null) break;
    ancestor = ancestor.parentElement;
  }
  if (ancestor === null) return { outcome: "no-rows-ancestor", chain, candidates: [], chosen: -1, appendedTo: "none" };

  const header = firstElementChild(ancestor);
  const candidates: HeaderFingerprint["candidates"] = [];
  let chosen = -1;
  if (header !== null) {
    let index = 0;
    for (const child of header.children) {
      const hasButton = child.querySelector("button") !== null;
      const hasInput = child.contains(input);
      candidates.push({ tag: tagOf(child), hasButton, hasInput });
      if (chosen < 0 && !hasInput && hasButton) chosen = index;
      index += 1;
    }
  }
  return {
    outcome: pickActionsContainer(header, input) === null ? "no-actions-container" : "injected",
    chain,
    candidates,
    chosen,
    // 按钮实际挂在表头上（不挂进限宽的动作簇，见 findHeaderMount 的说明）
    appendedTo: "header",
  };
}

/** 客户端上报诊断的目标地址（与面板同一条路由；该载体的 Fetch 路由支持 POST） */
export const DIAG_AREA = "header-button";

/**
 * 把结构指纹 POST 给宿主（fire-and-forget）。
 * @param route - document-relative 路由（`api/knowledgenet.graph`）。
 * @param fingerprint - 结构指纹。
 * @param fetchImpl - 可注入，便于单测。
 * @returns 是否成功送达（失败也不抛）。
 */
export async function reportFingerprint(
  route: string,
  fingerprint: HeaderFingerprint,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(route, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ kind: "diag", area: DIAG_AREA, ...fingerprint }),
    });
    return response.ok === true;
  } catch {
    return false;
  }
}

/**
 * 「开始」页入口卡片的样式 —— **逐项照抄宿主** `GuideBody.module.css` 的 `.entry`
 * （display:flex / gap:14px / width:380px / min-height:56px / padding:14px 20px /
 *  border:0.5px var(--dsw-alias-border-l2) / border-radius:var(--dsl-guide-entry-radius)，
 *  图标 26×26、标题 14px、描述 11px）。卡片是渲染在宿主 DOM 里的，所以只能注入到 head。
 *
 * @returns 样式文本。
 */
export function guideEntryCss(): string {
  return [
    ".kn-entry {",
    "  display: flex; gap: 14px; align-items: center; box-sizing: border-box;",
    "  width: 380px; max-width: 100%; min-height: 56px; padding: 14px 20px;",
    "  color: var(--dsw-alias-label-primary);",
    "  font: inherit; text-align: left;",
    "  background: var(--dsw-alias-bg-layer-1);",
    "  border: 0.5px solid var(--dsw-alias-border-l2);",
    "  border-radius: var(--dsl-guide-entry-radius, 14px);",
    "  cursor: pointer; }",
    ".kn-entry:hover { background: var(--kn-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)); }",
    ".kn-entry-icon { display: flex; flex: none; align-items: center; justify-content: center;",
    "  width: 26px; height: 26px; color: var(--dsw-alias-label-secondary); }",
    ".kn-entry-text { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }",
    ".kn-entry-title { overflow: hidden; font-size: 14px; line-height: 1.4;",
    "  white-space: nowrap; text-overflow: ellipsis; }",
    ".kn-entry-desc { overflow: hidden; color: var(--dsw-alias-state-idle-primary);",
    "  font-size: 11px; line-height: 1.4; white-space: nowrap; text-overflow: ellipsis; }",
  ].join("\n");
}

/**
 * 「添加知识库」按钮的小菜单（两项：打开已有 / 在选定位置新建）。
 *
 * 定位是 `fixed`，锚在按钮下方；观感对齐宿主的浮层菜单（同圆角/边框/悬停色 token），
 * 层级高于面板（宿主菜单在 10000 量级，这里取 10002）。
 *
 * @returns CSS 文本。
 */
export function addLibraryMenuCss(): string {
  return [
    ".kn-add-library-menu {",
    "  position: fixed; z-index: 10002; min-width: 148px; padding: 4px;",
    "  display: flex; flex-direction: column; gap: 2px;",
    "  border: 0.5px solid var(--dsw-alias-border-l2);",
    "  border-radius: var(--dsw-radius-md, 8px);",
    "  background: var(--dsw-alias-bg-layer-2);",
    "  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28); }",
    ".kn-add-library-menu-item {",
    "  appearance: none; border: 0; border-radius: var(--dsw-radius-sm, 6px);",
    "  background: transparent; color: var(--dsw-alias-label-primary);",
    "  font: inherit; font-size: 13px; line-height: 1.4; text-align: left;",
    "  padding: 6px 10px; cursor: pointer; white-space: nowrap; }",
    ".kn-add-library-menu-item:hover { background: var(--kn-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)); }",
  ].join("\n");
}
