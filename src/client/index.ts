import { attachConversationServices, type ConversationServices } from "./node-conversations.ts";
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
import { attachPluginLocale, pluginTranslate, type PluginLocaleService } from "./plugin-locale.ts";
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
  nodeChats: "对话 {count}", nodeChatNew: "打开新对话", nodeChatEmpty: "还没有从此节点打开过对话", nodeChatLoading: "加载中…", nodeChatCreating: "创建中…", nodeChatClose: "关闭对话列表", nodeChatFailed: "操作失败，请重试", nodeChatHint: "只在当前节点记录这些对话", nodeChatArchived: "已归档", nodeChatArchivedHint: "已归档的对话不能在侧栏直接打开：先在左侧栏取消归档",
  understood: "已理解", notUnderstood: "未理解", understandingSaving: "保存中…", understandingFailed: "保存失败，请重试",
  planPendingTitle: "agent 提交了一份提案",
  planTagCreate: "新建",
  planTagReuse: "已存在·复用",
  planNothingSelected: "未勾选",
  planLater: "稍后再说",
  planHint: "只有你点击才会真正建节点",
  planAppliedTitle: "已按你的确认落地",
  planCreatedCount: "本次新建 {n} 个节点（文件保留，可撤销）",
  planUndo: "撤销本次新建",
  planUndoDone: "已撤销：{n} 个节点已删除（都是这次落地新建的）",
  planReopen: "有 {n} 条提案待审",
  planClose: "关闭",

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
  richLoading: "正在准备正文编辑器…",
  richFailed: "正文编辑器初始化失败，已改用纯文本继续编辑（内容不会丢、保存照常 ✓；重新打开这个节点可以再试一次）",
  unsupportedNotice: "这份正文含有正文编辑器无法原样保留的语法，已自动改用纯文本编辑（原文一字不动 ✓）",
  /* **还在正文模式**时不许说"已自动改用纯文本" ✗（复查：提示要与实际模式一致 ✓） */
  unsupportedNoticeRich: "正文里出现了正文编辑器无法原样保留的语法（下面列出的这些）。**当前仍是正文模式**，保存时这一处可能被改写；想逐字保留请点「退回纯文本」，或先把这些语法删掉。",
  /* 粘贴被 Markdown 拆散时的一键补救 ✓（`design/code-block-copy-paste-analysis.md` ✓） */
  pasteAsCodeBlock: "把刚才粘进来的内容作为代码块插入",
  unsupportedRisk: "在正文里编辑并保存会改写上面这些语法 ✗",
  openRichAnyway: "仍要用正文编辑（可能改写上面的语法）",
  backToPlainText: "改回纯文本（不改写语法）",
  tabEdit: "编辑",
  tabPreview: "预览",
  editorHint: "支持 Markdown · 正文直接保存到这个节点的文档",
  /*
   * 底栏（保存状态 + 保存按钮）与「⋯ 详情」撤掉之后只剩两条状态文字 ✓
   * （`design/editor-chrome-minimal-design.md`）：`*` 标记与保存中标记 ✓。
   */
  statusDirty: "有未保存修改",
  statusSaving: "正在保存…",
  saveShortcut: "Ctrl / ⌘ + S 保存",
  /* 表格操作菜单（`design/table-caret-and-interaction-design.md` ✓；危险操作写明对象 ✓） */
  tableMenuLabel: "表格操作",
  tableRowBefore: "在上方插入行",
  tableRowAfter: "在下方插入行",
  tableColBefore: "在左侧插入列",
  tableColAfter: "在右侧插入列",
  tableAlignLeft: "本列左对齐",
  tableAlignCenter: "本列居中",
  tableAlignRight: "本列右对齐",
  tableRowUp: "本行上移",
  tableRowDown: "本行下移",
  tableColLeft: "本列左移",
  tableColRight: "本列右移",
  tableDeleteRow: "删除本行",
  tableDeleteCol: "删除本列",
  tableDeleteTable: "删除整张表格",
  /* 动不了时说明为什么 ✓；只读 / 保存中：入口还在但禁用 ✓ */
  tableMoveEdge: "已经在边界上，这个方向移不动",
  tableMoveHeader: "表头行不参与移动",
  /* 表头行上方没有可插入的位置 ✓（用户实测 ✓） */
  tableRowBeforeHeader: "第一行是表头，上面没有位置可插入（Markdown 表格的第一行就是表头）",
  /* 关系面板（`NoteRelations` ✓）—— 之前是硬编码中文 ✗，英文界面下不会跟着变 ✓ */
  relPre: "前置 {count}",
  relDepend: "被依赖 {count}",
  relAdd: "＋ 添加前置",
  relAddFromSelection: "＋ 添加前置节点",
  relAddTitle: "添加前置",
  relPreTitle: "前置知识",
  relDependTitle: "依赖此节点",
  relEmpty: "暂无关系",
  relSearchPlaceholder: "搜索已有节点，或输入新节点名称",
  relSearchLabel: "前置节点名称",
  relCreate: "新建「{title}」并设为前置",
  relAdding: "添加中…",
  relFailed: "添加失败，请重试",
  relClose: "关闭关系面板",
  relOpen: "打开「{title}」",
  /* 公式 / 代码块的预览开关 ✓ */
  editorEditSource: "编辑源码",
  /* 图片块 ✓ */
  imageUploadButton: "插入图片",
  imageUploadPlaceholder: "或者粘贴图片链接…",
  imageCaptionPlaceholder: "写一段图注",
  imageConfirm: "确定 ⏎",
  editorResultOnly: "只看结果",
  /* 划词浮条 / 收集弹窗（`ChatSelectionBar` ✓）—— 之前是硬编码中文默认值 ✗ */
  addNode: "添加节点",
  nothingSelected: "没有选中文字",
  noWorkspace: "找不到当前工作区，无法创建",
  createLibraryFailed: "创建知识库失败",
  createNodeFailed: "创建节点失败",
  createNodeDone: "已创建",
  multiLabel: "被添加的知识点",
  multiDetails: "继续在对话中划词会自动追加",
  multiAsPrereq: "是否添加为前置",
  addStandalone: "创建独立节点",
  targetSection: "添加为谁的前置",
  chatSearchPlaceholder: "输入名称搜索",
  resultsLabel: "搜索结果",
  loadingNodes: "正在读取当前知识库…",
  noRecommend: "这个库里还没有可推荐的最近节点，直接搜索吧",
  noResult: "没有匹配的知识点",
  selectMark: "选择",
  statusPick: "请选择要添加到的知识点",
  addPrereq: "添加为前置…",
  multiDragHint: "按住拖动可以把它挪开，方便继续在对话里选文字",
  multiPlaceholder: "在对话中划词，选中的文字会出现在这里",
  bulkCreateFailed: "创建失败：{done}/{total} 个成功",
  chipNameLabel: "第 {index} 个知识点名称",
  chipRemoveLabel: "移除 {name}",
  statusSelected: "添加为「{title}」的前置",
  createNodeTitle: "创建知识点",
  hasEvidence: "有出处",
  /* 图谱面板 / 编辑器里那些**只有字面兜底、词典里缺**的键 ✓（用户实测：英文界面下仍是中文 ✗） */
  refreshHint: "重新从磁盘读取知识库（绕过宿主的库缓存）",
  relayoutHint: "重排布局，并把旋转中心复位到整张图",
  emptyHint: "在空白处右键即可新建节点",
  nodeMenuTitle: "这个知识点",
  addPrerequisite: "添加前置节点…",
  edgeMenuTitle: "这条依赖",
  removeRelation: "删除这条依赖",
  removeNode: "删除当前节点",
  removeNodeConfirmTitle: "删除这个节点？",
  removeNodeConfirmMessage: "要删除的知识点",
  removeNodeDone: "已删除",
  autoCreateFailed: "自动创建知识库失败",
  promptTitle: "添加前置节点",
  promptHint: "输入前置知识点的名称",
  confirmCreate: "添加",
  removeConfirmTitle: "删除依赖",
  removeConfirmMessage: "确认删除这条前置关系吗？",
  menuFailed: "操作失败",
  focusNow: "当前知识点",
  dependentsEmpty: "没有其它知识点依赖它",
  prerequisitesEmpty: "它没有前置知识",
  statusDone: "已完成",
  statusLearning: "学习中",
  statusTodo: "未开始",
  notKnowledgeBase: "当前工作区不是知识库（没有通过「添加知识库」按钮登记过）。用左侧栏「工作区」表头上的知识库按钮把它加进来即可。",
  panelCrashed: "面板渲染出错：请刷新页面；若持续出现，请把控制台里的报错发给我。",
  retryLoad: "重试读取",
  retrySave: "重试保存",
  missingFingerprint: "这份文档没有可用的版本指纹，出于安全不能编辑",
  emptyDocument: "（这个节点还没有正文，直接写就行）",
  cancel: "取消",
  candidatesTitle: "已经有相近的知识点",
  candidatesMessage: "库里已有相近节点，建议复用而不是新建",
  reuse: "复用",
  createAnyway: "仍然新建",
  chipsCount: "{count} 个知识点",
  needOneChip: "先添加至少一个知识点",
  libraryEmpty: "这个知识库还没有任何节点：请先创建独立节点",
  canvasMenuTitle: "这张图",
  createNode: "创建节点",
  createNodeHint: "输入知识点名称（会作为它的文件名）",
  removeNodeHint: "删除会直接删掉那个 markdown 文件，不可恢复。",
  removeNodePurge: "删除",
  tableMoveSpan: "选中的是多行 / 多列，或表里有合并单元格 ⇒ 先只选中一行或一列",
  tableMoveUnavailable: "这份表格暂时不能移动行列",
  tableEntryDisabled: "编辑器暂时不能改表格（正在保存或只读）",
  copyDraft: "复制草稿",
  copied: "草稿已复制到剪贴板",
  copyFailed: "复制失败，请手动选中内容复制",
  refreshingLatest: "正在读取文件最新版本…",
  mergeNeedsReview: "已读到文件最新版本，请先比较，再点「保存合并结果」",
  mergeFailed: "读取文件最新版本失败，你的修改仍在",
  conflictNotice: "文件已有更新，你的修改已保留。",
  compareChanges: "比较修改",
  hideCompare: "收起比较",
  compareIdentical: "两侧内容一致，直接点「保存合并结果」即可。",
  myDraft: "我的修改",
  latestText: "文件最新版本",
  adoptLatest: "使用文件最新版本",
  adoptLatestConfirmTitle: "放弃修改？",
  adoptLatestConfirmMessage: "将用文件里的最新版本替换你未保存的修改，此操作不可撤销。",
  mergeAndSave: "保存合并结果",
  loadingDocument: "正在读取正文…",
  loadFailed: "读取正文失败",
  saveFailed: "保存失败",
  saveDone: "笔记已保存",
  nodeMissing: "这个节点已经不在库里了（草稿保留，可复制走）",
  tooLarge: "正文太大，面板编辑器不处理这么大的文档",
  unsupportedFormat: "这个知识库是旧格式（只读兼容），面板里不能编辑正文",
  libraryUnavailable: "找不到知识库",
  leaveTitle: "有尚未保存的笔记",
  leaveCloseMessage: "当前笔记有未保存修改。保存后关闭编辑区？",
  leaveSwitchMessage: "当前笔记有未保存修改。保存后切换到另一个节点？",
  leaveBlocked: "编辑器里还有问题要处理（见编辑区的提示），处理完再保存并继续。",
  leaveSaveBlocked: "暂时无法保存",
  leaveStay: "继续编辑",
  leaveDiscard: "放弃修改",
  leaveSaveClose: "保存并关闭",
  leaveSaveSwitch: "保存并切换",
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
  nodeChats: "Chats {count}", nodeChatNew: "Open new chat", nodeChatEmpty: "No chats opened from this node yet", nodeChatLoading: "Loading…", nodeChatCreating: "Creating…", nodeChatClose: "Close chat list", nodeChatFailed: "Could not complete. Try again", nodeChatHint: "These chats are recorded only by this node", nodeChatArchived: "Archived", nodeChatArchivedHint: "An archived chat cannot be opened here: unarchive it in the left sidebar first",
  understood: "Understood", notUnderstood: "Not understood", understandingSaving: "Saving…", understandingFailed: "Could not save. Try again",
  planPendingTitle: "The agent submitted a proposal",
  planTagCreate: "New",
  planTagReuse: "Exists · reuse",
  planNothingSelected: "Nothing selected",
  planLater: "Later",
  planHint: "Nodes are created only when you click",
  planAppliedTitle: "Applied as you confirmed",
  planCreatedCount: "Created {n} node(s) this time (files kept, undoable)",
  planUndo: "Undo these creations",
  planUndoDone: "Undone: {n} node(s) removed (the ones created just now)",
  planReopen: "{n} proposal(s) awaiting review",
  planClose: "Close",

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
  richLoading: "Preparing the rich editor…",
  richFailed: "The rich editor failed to start, so plain-text editing is used (nothing is lost and saving still works ✓; reopen the node to retry)",
  unsupportedNotice: "This note uses syntax the rich editor cannot preserve byte-for-byte, so plain-text editing is used automatically (your text is untouched)",
  /* Only claim the automatic switch when it actually happened ✓ */
  unsupportedNoticeRich: "This note now contains syntax the rich editor cannot preserve byte-for-byte. You are **still in rich mode**, so saving may rewrite those parts; switch to plain text to keep them verbatim, or remove that syntax first.",
  /* One-click remedy when a paste got split by Markdown ✓ */
  pasteAsCodeBlock: "Insert what I just pasted as a code block",
  unsupportedRisk: "Editing and saving in the rich editor will rewrite the syntax listed above ✗",
  openRichAnyway: "Use the rich editor anyway (may rewrite the syntax)",
  backToPlainText: "Back to plain text (no rewrite)",
  tabEdit: "Edit",
  tabPreview: "Preview",
  editorHint: "Markdown supported · saves straight to this node's document",
  /* Only two status strings remain once the footer and the ⋯ details are gone ✓ */
  statusDirty: "Unsaved changes",
  statusSaving: "Saving…",
  saveShortcut: "Ctrl / ⌘ + S to save",
  /* Table menu (design/table-caret-and-interaction-design.md; destructive actions name their target) */
  tableMenuLabel: "Table actions",
  tableRowBefore: "Insert row above",
  tableRowAfter: "Insert row below",
  tableColBefore: "Insert column left",
  tableColAfter: "Insert column right",
  tableAlignLeft: "Align this column left",
  tableAlignCenter: "Align this column center",
  tableAlignRight: "Align this column right",
  tableRowUp: "Move this row up",
  tableRowDown: "Move this row down",
  tableColLeft: "Move this column left",
  tableColRight: "Move this column right",
  tableDeleteRow: "Delete this row",
  tableDeleteTable: "Delete table",
  tableDeleteCol: "Delete this column",
  /* Why a move is unavailable; and the disabled entry state ✓ */
  tableMoveEdge: "Already at the edge — cannot move further that way",
  tableMoveHeader: "The header row does not move",
  /* There is no position above the header row ✓ */
  tableRowBeforeHeader: "The first row is the header — Markdown has no position above it",
  /* Relations panel ✓ */
  relPre: "Prerequisites {count}",
  relDepend: "Dependents {count}",
  relAdd: "+ Add prerequisite",
  relAddFromSelection: "+ Add prerequisite node",
  relAddTitle: "Add prerequisite",
  relPreTitle: "Prerequisites",
  relDependTitle: "Depends on this node",
  relEmpty: "No relations yet",
  relSearchPlaceholder: "Search existing nodes, or type a new name",
  relSearchLabel: "Prerequisite node name",
  relCreate: "Create “{title}” as a prerequisite",
  relAdding: "Adding…",
  relFailed: "Could not add — please retry",
  relClose: "Close the relations panel",
  relOpen: "Open “{title}”",
  editorEditSource: "Edit source",
  imageUploadButton: "Insert image",
  imageUploadPlaceholder: "or paste an image link…",
  imageCaptionPlaceholder: "Write a caption",
  imageConfirm: "Confirm ⏎",
  editorResultOnly: "Result only",
  /* Chat selection bar / collection dialog ✓ */
  addNode: "Add node",
  nothingSelected: "Nothing selected",
  noWorkspace: "No current workspace — cannot create",
  createLibraryFailed: "Could not create the library",
  createNodeFailed: "Could not create the node",
  createNodeDone: "Created",
  multiLabel: "Selected knowledge points",
  multiDetails: "Keep selecting in the conversation to append more",
  multiAsPrereq: "Add as a prerequisite?",
  addStandalone: "Create a standalone node",
  targetSection: "Prerequisite of",
  chatSearchPlaceholder: "Type a name to search",
  resultsLabel: "Results",
  loadingNodes: "Reading the knowledge library…",
  noRecommend: "No recent nodes to recommend yet — just search",
  noResult: "No matching knowledge point",
  selectMark: "Select",
  statusPick: "Pick the knowledge point to add to",
  addPrereq: "Add as prerequisite…",
  multiDragHint: "Drag to move it aside so you can keep selecting text in the conversation",
  multiPlaceholder: "Select text in the conversation and it appears here",
  bulkCreateFailed: "Failed: {done}/{total} created",
  chipNameLabel: "Knowledge point {index} name",
  chipRemoveLabel: "Remove {name}",
  statusSelected: "Make it a prerequisite of “{title}”",
  createNodeTitle: "Create knowledge point",
  hasEvidence: "Has source",
  /* Panel / editor keys that previously only had literal fallbacks ✓ */
  refreshHint: "Re-read the library from disk (bypass the host's cache)",
  relayoutHint: "Re-layout and reset the rotation center to the whole graph",
  emptyHint: "Right-click empty space to create a node",
  nodeMenuTitle: "This knowledge point",
  addPrerequisite: "Add prerequisite…",
  edgeMenuTitle: "This dependency",
  removeRelation: "Delete this dependency",
  removeNode: "Delete this node",
  removeNodeConfirmTitle: "Delete this node?",
  removeNodeConfirmMessage: "Knowledge point to delete",
  removeNodeDone: "Deleted",
  autoCreateFailed: "Could not create the library automatically",
  promptTitle: "Add a prerequisite node",
  promptHint: "Type the prerequisite's name",
  confirmCreate: "Add",
  removeConfirmTitle: "Delete dependency",
  removeConfirmMessage: "Delete this prerequisite relation?",
  menuFailed: "Action failed",
  focusNow: "Current knowledge point",
  dependentsEmpty: "Nothing depends on it",
  prerequisitesEmpty: "It has no prerequisites",
  statusDone: "Done",
  statusLearning: "Learning",
  statusTodo: "Not started",
  notKnowledgeBase: "This workspace is not a knowledge library (it was never registered with “Add knowledge library”). Use the knowledge-library button on the Workspaces header in the left sidebar.",
  panelCrashed: "The panel failed to render. Refresh the page; if it keeps happening, send me the console error.",
  retryLoad: "Retry loading",
  retrySave: "Retry saving",
  missingFingerprint: "This document has no usable revision fingerprint, so it cannot be edited safely",
  emptyDocument: "(This node has no body yet — just start typing)",
  cancel: "Cancel",
  candidatesTitle: "Similar knowledge points already exist",
  candidatesMessage: "The library already has similar nodes — reuse one instead of creating a new one",
  reuse: "Reuse",
  createAnyway: "Create anyway",
  chipsCount: "{count} selected",
  needOneChip: "Add at least one knowledge point first",
  libraryEmpty: "This library has no nodes yet — create a standalone node first",
  canvasMenuTitle: "This graph",
  createNode: "Create node",
  createNodeHint: "Type the knowledge point's name (it becomes the file name)",
  removeNodeHint: "Deleting removes that markdown file for good.",
  removeNodePurge: "Delete",
  tableMoveSpan: "Multiple rows/columns are selected, or the table has merged cells — select a single row or column first",
  tableMoveUnavailable: "This table cannot move rows or columns right now",
  tableEntryDisabled: "The table cannot be edited right now (saving or read-only)",
  copyDraft: "Copy draft",
  copied: "Draft copied to the clipboard",
  copyFailed: "Copy failed — select the text and copy manually",
  refreshingLatest: "Loading the file's latest version…",
  mergeNeedsReview: "Latest version loaded — compare it first, then click Save merged result",
  mergeFailed: "Could not read the file's latest version; your changes are kept",
  conflictNotice: "The file has newer changes; yours are kept.",
  compareChanges: "Compare changes",
  hideCompare: "Hide comparison",
  compareIdentical: "Both sides are identical — just click Save merged result.",
  myDraft: "My changes",
  latestText: "File's latest version",
  adoptLatest: "Use the file's latest version",
  adoptLatestConfirmTitle: "Discard your changes?",
  adoptLatestConfirmMessage: "The file's latest version will replace your unsaved changes. This cannot be undone.",
  mergeAndSave: "Save merged result",
  loadingDocument: "Loading the note…",
  loadFailed: "Could not read the note",
  saveFailed: "Could not save",
  saveDone: "Note saved",
  nodeMissing: "This node is no longer in the library (your draft is kept so you can copy it out)",
  tooLarge: "The note is too large for the panel editor",
  unsupportedFormat: "This library uses the old read-only format, so the panel cannot edit notes here",
  libraryUnavailable: "Knowledge library not found",
  leaveTitle: "Unsaved note",
  leaveCloseMessage: "This note has unsaved changes. Save and close the editor?",
  leaveSwitchMessage: "This note has unsaved changes. Save and switch to another node?",
  leaveBlocked: "The editor still has an issue to resolve (see the notice there); fix it, then save and continue.",
  leaveSaveBlocked: "Cannot save right now",
  leaveStay: "Keep editing",
  leaveDiscard: "Discard changes",
  leaveSaveClose: "Save and close",
  leaveSaveSwitch: "Save and switch",
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
  effect?(effect: () => (() => void), label?: string): unknown;
  get?(name: string): unknown;
  slots: {
    inject(key: string, callback: () => unknown): unknown;
    register(options: Record<string, unknown>, component: unknown): unknown;
  };
}

/**
 * 注册 locale 字典 ✓（**交给 `plugin-locale.ts` 做** ✓）。
 *
 * 旧实现一次失败就 `return undefined` ✗ —— 而插件**可能先于** locale 服务 apply ✓
 * （`ctx.get("locale")` 那一刻还是 undefined ✓）⇒ 字典永远没注册上 ✓
 * ⇒ 英文界面里满屏中文 ✓（用户实测："当前插件的语言似乎没有跟随系统变化"✓）。
 * 现在 `attachPluginLocale` 只登记"现读服务的函数"✓，**每次取用都会补试注册** ✓，
 * 而且会按宿主已声明的语言 id（`en-US` / `zh-CN` ✓）各注册一份 ✓。
 */
function registerLocale(ctx: MinimalClientContext): string | undefined {
  attachPluginLocale(
    () => (ctx.get?.("locale") ?? undefined) as PluginLocaleService | undefined,
    NS,
    DICT_ZH,
    DICT_EN,
  );
  /* 立刻试一次（能把失败挡在最前面 ✓）；失败也没关系 ✓ —— 取用时还会再试 ✓ */
  try {
    pluginTranslate();
  } catch {
    /* 忽略：真正的兜底是"取用时再试" ✓ */
  }
  return NS;
}

export function apply(ctx: MinimalClientContext): void {  const ns = registerLocale(ctx);
  const attach = () => attachConversationServices(() => {
    const sessions = ctx.get?.("sessions") as ConversationServices["sessions"] | undefined;
    const uiWorkspace = ctx.get?.("uiWorkspace") as ConversationServices["uiWorkspace"] | undefined;
    /*
     * `workspaces` 只用来读快照：新对话要挂进「当前节点所在的工作区」（否则侧栏归到「未分组」✗）。
     * 它**不是必需服务**：老宿主/组合里没有它时，创建会退回"只传 cwd"的旧行为 ✓。
     */
    const workspaces = ctx.get?.("workspaces") as ConversationServices["workspaces"] | undefined;
    /*
     * `sidebarRight` 提供来源标签和导航参数，并通知目标席位挂载以恢复标签
     * 右侧栏按会话保存；服务缺席时仍可使用标准对话导航。
     */
    const sidebarRight = ctx.get?.("sidebarRight") as ConversationServices["sidebarRight"] | undefined;
    return sessions && uiWorkspace
      ? { sessions, uiWorkspace, ...(workspaces === undefined ? {} : { workspaces }), ...(sidebarRight === undefined ? {} : { sidebarRight }) }
      : undefined;
  });
  if (ctx.effect) ctx.effect(attach, "knowledgenet: node conversation navigation");
  else attach();
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