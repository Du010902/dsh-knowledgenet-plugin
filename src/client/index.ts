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

import { registerChatSelectionBar } from "./badges.ts";
import { NodeCard } from "./NodeCard.tsx";
import { PrereqCard } from "./PrereqCard.tsx";
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
  focus: "聚焦",
  space: "空间",
  refresh: "刷新",
  relayout: "重新整理",
  counts: "节点 {n} · 依赖 {e}",
  noNodes: "这个知识库里还没有知识点。",
  spaceFailed: "三维视图不可用，已回到二维聚焦。",
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
  focus: "Focus",
  space: "Space",
  refresh: "Refresh",
  relayout: "Re-layout",
  counts: "{n} nodes · {e} links",
  noNodes: "This library has no knowledge nodes yet.",
  spaceFailed: "The 3D view is unavailable; switched back to focus.",
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
  /*
   * 语言：**优先问宿主的 locale 服务**（`ctx.locale.getLocale()`），而不是靠 `document.documentElement.lang`
   * 猜——实测后者可能还是 `en`，于是中文界面里我的弹窗变成英文（用户反馈过）。
   */
  const zh = (() => {
    try {
      const service = (ctx as unknown as {
        get?: (key: string) => { getLocale?: () => { id?: string } | undefined } | undefined;
      }).get?.("locale");
      const id = service?.getLocale?.()?.id;
      if (typeof id === "string" && id !== "") return id.toLowerCase().startsWith("zh");
    } catch {
      // 拿不到服务就退回原来的猜测
    }
    return !prefersEnglish();
  })();

  // 对话里划词 → 浮条（添加前置 / 多选）→ 选目标节点（推荐 + 搜索）
  registerChatSelectionBar(ctx as never, {
    addPrereq: zh ? "添加为前置…" : "Add as prerequisite…",
    multi: zh ? "多选" : "Multi-select",
    selected: (count: number) => (zh ? `已选 ${count} 段` : `${count} selected`),
    done: zh ? "完成" : "Done",
    cancel: zh ? "取消" : "Cancel",
    multiTitle: zh ? "收集知识点" : "Collect nodes",
    multiSubtitle: zh
      ? "继续在对话中划词会自动追加，也可以在这里输入"
      : "Keep selecting text in the chat to append — or type here",
    multiLabel: zh ? "被添加的知识点" : "Nodes to add",
    multiHint: zh ? "点击标签可修改名称" : "Click a tag to rename it",
    multiPlaceholder: zh ? "输入后按 Enter 添加，或粘贴多行" : "Type and press Enter, or paste multiple lines",
    multiDetails: zh
      ? "每个标签是一个知识点。选择「添加为前置…」后，再指定它们属于谁"
      : "Each tag becomes a node. Pick “Add as prerequisite…” to choose their parent",
    multiCount: (count: number) => (zh ? `${count} 个知识点` : `${count} node${count === 1 ? "" : "s"}`),
    addStandalone: zh ? "创建独立节点" : "Create standalone",
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
  });
  // 对话里的工具卡片（图谱本体不在这里——它在右侧栏；这里只有写入回执）
  ctx.slots.inject("tool.call.toolview", function* registerViews() {
    for (const view of VIEWS) {
      yield ctx.slots.register(withLocale({ name: "tool.call.toolview", key: view.key }), view.component);
    }
  });
}