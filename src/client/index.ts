/**
 * 插件 Client 半入口。
 *
 * 三种表面：
 * - **右侧栏标签页**「知识库图谱」（会话作用域，并在「开始」页上给出入口卡片）——图谱的家；
 * - **左侧栏「知识库」标志**：知识库工作区那一行贴个小胶囊（见 badges.ts）；
 * - `tool.call.toolview`：写入回执卡片（节点详情 / 建前置结果）。
 *
 * 数据通道：标签页与标志走宿主注册的 Fetch 路由（`api/knowledgenet.graph`）；卡片走工具结果本身。
 * 客户端半不读磁盘、不写库，也不 import 任何 Harness Client 包（含 ui-primitives）。
 */

import { registerChatSelectionBar, type ChatSelectionCopy } from "./badges.ts";
import { NodeCard } from "./NodeCard.tsx";
import { PrereqCard } from "./PrereqCard.tsx";
import { readZh, type LocaleServiceLike } from "./locale-choice.ts";
import { prefersEnglish } from "./tab-definition.ts";
import { registerGraphTab } from "./tab.ts";

export const name = "knowledgenet-client";

/** `ctx.slots` 就绪之前不激活 */
export const inject = ["slots"];

const NS = "knowledgenet";

const VIEWS: Array<{ key: string; component: unknown }> = [
  { key: "kn_read_node", component: NodeCard },
  { key: "kn_add_prerequisite", component: PrereqCard },
];

const DICT_ZH: Record<string, string> = {
  // 面板
  panel: "知识库图谱",
  /* 标签芯片上的短名（芯片窄，用全名会把别的标签挤掉）✓ */
  tabShort: "图谱",
  focus: "聚焦",
  space: "空间",
  refresh: "刷新",
  relayout: "重新整理",
  /* 搜索框（2026-10）：模糊匹配 → **列候选让用户挑** ✓ */
  searchPlaceholder: "搜索知识点，回车聚焦",
  searchGo: "搜索并聚焦",
  searchResults: "匹配结果",
  searchMiss: "没有匹配的节点",
  counts: "节点 {n} · 依赖 {e}",
  noNodes: "这个知识库里还没有知识点。",
  /* 节点笔记编辑器（`design/node-note-editor.html` ✓） */
  editNote: "编辑笔记",
  notePanelTitle: "节点笔记",
  closeEditor: "关闭编辑区",
  details: "详情",
  detailPath: "路径",
  detailRevision: "修订",
  detailShortcut: "快捷键",
  tabRich: "正文",
  richLoading: "正在准备正文编辑器…",
  richFailed: "正文编辑器初始化失败：请切到「源码」继续编辑或复制内容（此时不会保存 ✗）",
  unsupportedNotice: "这份正文含有正文编辑器无法原样保留的语法，已停在「源码」模式（原文一字不动 ✓）",
  unsupportedRisk: "在「正文」模式下编辑并保存，可能会改写上面这些语法 ✗",
  openRichAnyway: "仍要用正文模式打开",
  tabSource: "源码",
  tabEdit: "编辑",
  tabPreview: "预览",
  editorHint: "支持 Markdown · 正文直接保存到这个节点的文档",
  statusSaved: "已保存",
  statusDirty: "有未保存修改",
  statusConflict: "草稿未保存 · 文件有更新",
  statusSaving: "正在保存…",
  saveNote: "保存笔记",
  saveShortcut: "Ctrl / ⌘ + S 保存",
  copyDraft: "复制草稿",
  copied: "草稿已复制到剪贴板",
  copyFailed: "复制失败，请手动选中内容复制",
  refreshingLatest: "正在读取最新正文…",
  mergeNeedsReview: "已读到最新正文，请先查看，再点「已合并，基于最新版本保存」",
  mergeFailed: "刷新最新正文失败，草稿仍在",
  statusSaveFailed: "保存失败 · 草稿仍在",
  conflictNotice: "文件在外部发生了变化，你的草稿仍保留。请先比较最新正文，再决定如何合并。",
  compareLatest: "查看最新正文",
  latestText: "最新正文",
  loadingDocument: "正在读取正文…",
  loadFailed: "读取正文失败",
  saveFailed: "保存失败",
  saveDone: "笔记已保存",
  nodeMissing: "这个节点已经不在库里了（草稿保留，可复制走）",
  tooLarge: "正文太大，面板编辑器不处理这么大的文档",
  unsupportedFormat: "这个知识库是旧格式（只读兼容），面板里不能编辑正文",
  libraryUnavailable: "找不到知识库",
  leaveTitle: "有尚未保存的笔记",
  leaveMessage: "先保存当前内容，再继续查看其他节点。",
  leaveBlocked: "编辑器里还有问题要处理（见编辑区的提示），处理完再保存并继续。",
  leaveSaveBlocked: "暂时无法保存",
  leaveStay: "继续编辑",
  leaveDiscard: "放弃修改",
  leaveSave: "保存并继续",
  spaceFailed: "三维视图不可用；数据本身没问题，点「重试」或刷新面板再试。",
  workspaceHint: "面板跟随当前工作区：把这个知识库目录作为工作区打开，这里就会直接显示它。",
  // 图谱卡片
  title: "知识库图谱",
  loading: "正在解析当前工作区…",
  unreadable: "这条工具结果不是可解析的知识库数据。",
  failed: "读取知识库失败",
  hint: "点击卡片可切换聚焦节点",
  truncated: "（已截断显示）",
  // 节点卡片
  prerequisites: "它的前置知识",
  dependents: "依赖它的地方",
  relations: "依赖说明与来源",
  none: "（暂无）",
  note: "正文摘录",
  resources: "资料",
  // 建前置卡片
  created: "新建节点",
  reused: "复用已有节点",
  evidence: "已记录出处",
  noEvidence: "未带出处",
  candidates: "命中相近知识点，需要先确认",
  candidatesHint: "请选择复用其中一个，或确认是不同概念后让我带 create 重新建立。",
  cycle: "会造成循环依赖，已拒绝",
  emptyStack: "学习栈是空的",
  routeNotReady: "面板数据路由未就绪：宿主半需要重启 DSH 才会注册它（刷新页面只更新客户端半）。",
};

const DICT_EN: Record<string, string> = {
  panel: "Knowledge graph",
  tabShort: "Graph",
  focus: "Focus",
  space: "Space",
  refresh: "Refresh",
  relayout: "Re-layout",
  searchPlaceholder: "Search nodes, Enter to focus",
  searchGo: "Search and focus",
  searchResults: "Matches",
  searchMiss: "No matching node",
  counts: "{n} nodes · {e} links",
  noNodes: "This library has no knowledge nodes yet.",
  /* Node note editor (design/node-note-editor.html) */
  editNote: "Edit note",
  notePanelTitle: "Node note",
  closeEditor: "Close the editor",
  details: "Details",
  detailPath: "Path",
  detailRevision: "Revision",
  detailShortcut: "Shortcut",
  tabRich: "Note",
  richLoading: "Preparing the rich editor…",
  richFailed: "The rich editor failed to start — switch to Markdown to keep editing or copy the text (saving is disabled ✗)",
  unsupportedNotice: "This note uses syntax the rich editor cannot preserve byte-for-byte, so it opened in Markdown mode",
  unsupportedRisk: "Editing and saving in Note mode may rewrite the syntax listed above ✗",
  openRichAnyway: "Open in Note mode anyway",
  tabSource: "Markdown",
  tabEdit: "Edit",
  tabPreview: "Preview",
  editorHint: "Markdown supported · saves straight to this node's document",
  statusSaved: "Saved",
  statusDirty: "Unsaved changes",
  statusConflict: "Draft unsaved · file changed",
  statusSaving: "Saving…",
  saveNote: "Save note",
  saveShortcut: "Ctrl / ⌘ + S to save",
  copyDraft: "Copy draft",
  copied: "Draft copied to the clipboard",
  copyFailed: "Copy failed — select the text and copy manually",
  refreshingLatest: "Loading the latest text…",
  mergeNeedsReview: "Latest text loaded — review it, then click Merge and save",
  mergeFailed: "Could not refresh the latest text; your draft is kept",
  statusSaveFailed: "Save failed · draft kept",
  conflictNotice: "The file changed outside the panel. Your draft is kept — compare the latest text first, then decide how to merge.",
  compareLatest: "Use latest text",
  latestText: "Latest text",
  loadingDocument: "Loading the note…",
  loadFailed: "Could not read the note",
  saveFailed: "Could not save",
  saveDone: "Note saved",
  nodeMissing: "This node is no longer in the library (your draft is kept so you can copy it out)",
  tooLarge: "The note is too large for the panel editor",
  unsupportedFormat: "This library uses the old read-only format, so the panel cannot edit notes here",
  libraryUnavailable: "Knowledge library not found",
  leaveTitle: "Unsaved note",
  leaveMessage: "Save the current note before opening another node.",
  leaveBlocked: "The editor still has an issue to resolve (see the notice there); fix it, then save and continue.",
  leaveSaveBlocked: "Cannot save right now",
  leaveStay: "Keep editing",
  leaveDiscard: "Discard changes",
  leaveSave: "Save and continue",
  spaceFailed: "The 3D view is unavailable. The data is fine — hit Retry or reload the panel.",
  workspaceHint: "The panel follows the current workspace: open this library directory as a workspace and it shows up here.",
  title: "Knowledge graph",
  loading: "Resolving the current workspace…",
  unreadable: "This tool result is not readable knowledge data.",
  failed: "Reading the knowledge library failed",
  hint: "Click a card to change the focus",
  truncated: "(truncated)",
  prerequisites: "Prerequisites",
  dependents: "Depended on by",
  relations: "Recorded links",
  none: "(none)",
  note: "Note excerpt",
  resources: "Resources",
  created: "New node",
  reused: "Reused node",
  evidence: "Source passage recorded",
  noEvidence: "No source passage",
  candidates: "Similar nodes found — confirm first",
  candidatesHint: "Pick one to reuse, or ask me to create a distinct node with create: true.",
  cycle: "Rejected: this would create a dependency cycle",
  emptyStack: "The learning stack is empty",
  routeNotReady: "The panel data route is not ready: the Host half only registers it after DSH restarts (a page refresh updates the Client half only).",
};

interface MinimalClientContext {
  get?(name: string): unknown;
  slots: {
    inject(key: string, callback: () => unknown): unknown;
    register(options: Record<string, unknown>, component: unknown): unknown;
  };
}

/** 注册 locale 字典；宿主 locale 服务不在（或 API 变了）时静默回落到组件内字面文案 */
function registerLocale(ctx: MinimalClientContext): string | undefined {
  const locale = (ctx.get?.("locale") ?? undefined) as
    | { register?(ns: string, language: string, dict: Record<string, string>): unknown }
    | undefined;
  if (locale?.register === undefined) return undefined;
  try {
    locale.register(NS, "zh", DICT_ZH);
    locale.register(NS, "en", DICT_EN);
    return NS;
  } catch {
    return undefined;
  }
}

export function apply(ctx: MinimalClientContext): void {  const ns = registerLocale(ctx);
  const withLocale = (options: Record<string, unknown>): Record<string, unknown> =>
    ns === undefined ? options : { ...options, locale: ns };

  // 主入口：会话右侧栏的「知识库图谱」标签页（含「开始」页上的入口卡片）
  registerGraphTab(ctx as never, ns);

  // 左侧栏：知识库工作区的那一行把文件夹字形换成知识库字形（工作区行没有插槽，故只注入样式）

  // 左侧栏：「工作区」表头上加一个「添加知识库」按钮（表头没有插槽，故注入一个真实按钮）
  /**
   * 现读宿主 locale 服务。
   *
   * 语言判据走它，**不靠 `document.documentElement.lang` 猜** —— 实测那个值在插件 apply 时可能还是 `en`，
   * 于是中文界面里弹窗变成英文（用户反馈过 ✗）。
   *
   * 字段名提醒：宿主 `LocaleSnapshot` 上是 **`active`**；我先前写的 `.id` 不存在 ⇒ 判定永远失败
   * （细节与兜底约定见 `locale-choice.ts`）。用 Inspect 的 client `Service` 契约可直接核对：
   * `getLocale(): LocaleSnapshot`，而 `LocaleSnapshot = { active, locales, revision }` ✓。
   *
   * **刻意不缓存服务**：本插件可能先于 locale 插件 apply（`inject: ["slots"]` 只保证槽位就绪），
   * 那时 `ctx.get("locale")` 还是 undefined；缓存下来就永远拿不到 ⇒ 一直走兜底 ✗。
   * `ctx.get(...)` 只是一次属性查找，按需调用完全够便宜 ✓。
   */
  const localeServiceNow = (): LocaleServiceLike | undefined => {
    try {
      return (ctx.get?.("locale") ?? undefined) as LocaleServiceLike | undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * 当前语言是否中文 —— **每次要用的时候现算** ✓。
   *
   * 为什么不是一个常量：宿主在设置里切换语言时，槽位出口会整体重渲染（`useLocaleRevision`），
   * 只要这里现读快照，弹窗文案就会**立刻跟着变** ✓；注册时钉死一份的老写法要刷新页面才生效 ✗。
   * 宿主服务拿不到（老版本/组合里没有 locale 插件）时才回落到 `prefersEnglish()` 那个猜测。
   */
  const zhNow = (): boolean => readZh(localeServiceNow()) ?? !prefersEnglish();

  /**
   * 划词浮窗的文案：**按次生成**（注册处每次渲染调一次）⇒ 语言跟随宿主设置 ✓。
   * @returns 这一版语言下的文案表。
   */
  const selectionCopy = (): ChatSelectionCopy => {
    const zh = zhNow();
    return {
    addPrereq: zh ? "添加为前置…" : "Add as prerequisite…",
    multi: zh ? "多选" : "Multi-select",
    selected: (count: number) => (zh ? `已选 ${count} 段` : `${count} selected`),
    done: zh ? "完成" : "Done",
    cancel: zh ? "取消" : "Cancel",
    /*
     * 用户要求（2026-09）：弹窗**不再显示标题**，说明行改成一句话、并挪到标签框下面；
     * 底下也不再提供"手动输入新标签"的输入框（知识点只能来自对话划词）。
     * 被废弃的三项先不删（宿主仍在传），只把还渲染的两项改成新文案 ✓。
     */
    multiTitle: zh ? "收集知识点" : "Collect nodes",
    multiSubtitle: zh ? "继续在对话中划词会自动追加" : "Keep selecting text in the chat to append",
    multiLabel: zh ? "被添加的知识点" : "Nodes to add",
    multiHint: zh ? "点击标签可修改名称" : "Click a tag to rename it",
    multiPlaceholder: zh ? "输入后按 Enter 添加，或粘贴多行" : "Type and press Enter, or paste multiple lines",
    multiDetails: zh ? "继续在对话中划词会自动追加" : "Keep selecting text in the chat to append",
    multiCount: (count: number) => (zh ? `${count} 个知识点` : `${count} node${count === 1 ? "" : "s"}`),
    addStandalone: zh ? "创建独立节点" : "Create standalone",
    /* 合并成一层之后弹窗里的两个互斥选项（radio）：建独立节点 ↔ 加为别人的前置 ✓ */
    multiAsPrereq: zh ? "添加为另一个知识点的前置" : "Add as a prerequisite of another node",
    pickTitle: zh ? "被添加的知识点" : "Nodes to add",
    pickHint: zh
      ? "将这些知识点添加为另一个知识点的前置"
      : "Add these nodes as prerequisites of another node",
    recommended: zh ? "推荐" : "Recommended",
    searchHint: zh ? "搜索知识点…" : "Search nodes…",
    searching: zh ? "搜索中…" : "Searching…",
    noResult: zh ? "没有找到相关知识点" : "No matching node",
    titleLabel: zh ? "前置知识点的名称" : "Prerequisite title",
    confirm: zh ? "确认添加" : "Confirm",
    targetSection: zh ? "添加为谁的前置" : "Add as a prerequisite of",
    searchLabel: zh ? "搜索知识点" : "Search nodes",
    searchPlaceholder: zh ? "输入名称搜索" : "Type a name to search",
    resultsLabel: zh ? "搜索结果" : "Search results",
    selectMark: zh ? "选择" : "Select",
    statusPick: zh ? "请选择要添加到的知识点" : "Pick the node to add to",
    statusSelected: (title: string) => (zh ? `添加为「${title}」的前置` : `Add as a prerequisite of “${title}”`),
    added: zh ? "已添加" : "Added",
    failed: zh ? "添加失败" : "Add failed",
    reuse: zh ? "复用" : "Reuse",
    createAnyway: zh ? "仍然新建" : "Create anyway",
    candidatesTitle: zh ? "已经有相近的知识点" : "Similar node exists",
    candidatesMessage: zh ? "库里已有相近节点，建议复用而不是新建" : "A similar node exists; reuse it instead of creating a duplicate",
    loadingNodes: zh ? "正在读取当前知识库…" : "Reading the current library…",
    noRecommend: zh
      ? "这个库里暂时没有可推荐的最近节点，直接搜索吧"
      : "No recent nodes in this library yet — search instead",
    };
  };

  // 对话里划词 → 浮条（添加前置 / 多选）→ 选目标节点（推荐 + 搜索）
  registerChatSelectionBar(ctx as never, selectionCopy);
  // 对话里的工具卡片（图谱本体不在这里——它在右侧栏；这里只有写入回执）
  ctx.slots.inject("tool.call.toolview", function* registerViews() {
    for (const view of VIEWS) {
      yield ctx.slots.register(withLocale({ name: "tool.call.toolview", key: view.key }), view.component);
    }
  });
}