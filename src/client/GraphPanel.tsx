import { nodeConversations } from "./node-conversations.ts";
/**
 * 右侧栏标签页里的知识库图谱面板（**只有三维空间视图**）。
 *
 * 数据来自宿主注册的 Fetch 路由（`api/knowledgenet.graph`），与工具结果**同一份构造逻辑**：
 * 面板看到的图与模型看到的 JSON 不会说两套话。
 *
 * 视图只有**空间**（`GraphUniverse`：three.js + Worker 力导向布局，Worker 源码由构建期内联为 Blob）。
 * 旧的两维视图已经**从产品里去掉了** ✗ —— 因此：
 * - 面板不再注册任何两维卡片（`GraphCard` 那个文件是遗留死代码）；
 * - 兜底页也不再出现"回到另一个视图"那种话与按钮（构建期把上游那份文案与按钮一起改掉 ✓）。
 *
 * 三维视图套了错误边界：WebGL/Worker 出问题时给一条可读提示与「重试」，
 * 而不是把整个面板从槽位里摘掉；视图**常驻挂载**（不可见只做显隐），
 * 免得反复重建 WebGL 上下文 ✗。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { GraphSnapshot } from "../vendor/upstream/data/types.ts";
import { GraphUniverse } from "../vendor/upstream/components/GraphUniverse.tsx";
import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import { makeTranslator } from "./card-model.ts";
import { pluginTranslate } from "./plugin-locale.ts";
import { GraphContextMenu, requestCanvasMenu } from "./GraphContextMenu.tsx";
import { reportDiag, reportDiagOnce } from "./diag.ts";
import { rememberFocusNode } from "./ChatSelectionBar.tsx";
import { rememberSessionId } from "./chat-selection.ts";
import { LIBRARY_CHANGED_EVENT, clearCurrentContext, publishCurrentContext } from "./current-context.ts";
import { PlanReview } from "./PlanReview.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { InteriorMinimap } from "./InteriorMinimap.tsx";
import { NodeDocumentEditor } from "./NodeDocumentEditor.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { libraryKeyOf } from "./view-cache.ts";
import { forgetOpenEditor, openEditorNode, rememberOpenEditor } from "./open-editor.ts";
import { draftKey, forgetDraft, leaveLabels } from "./node-document-state.ts";
import { RELAYOUT_EVENT } from "./interior-controller.ts";
import { RefreshRingIcon, RelayoutTreeIcon, SearchGlyphIcon, SubmitArrowIcon } from "./PanelIcon.tsx";
import { rankNodes, type NodeMatch, type SearchableNode } from "./node-search.ts";
import { ShadowPanel } from "./shadow.tsx";
import { pickWorkspacePath, resolvePanelTarget } from "./workspace-path.ts";
/** 相机命令类型取自上游（`focusNode` / `fitAll` 都在里面），别在本地再写一份窄的 */
import type { CameraCommand } from "../vendor/upstream/graph3d/types.ts";

type EditAction = { kind: "open"; nodeId: string } | { kind: "close" } | { kind: "conversation"; sessionId: string };

interface PanelPayload {
  understanding?: Record<string, boolean>;
  ok?: boolean;
  /**
   * 知识库身份。
   *
   * `libraryId` 是**稳定身份**（宿主 API 会返回，见 `src/host/api.ts`）：同一个库换了挂载根目录
   * 也还是它 ⇒ 视角缓存按它分区最可靠 ✓；`root` 只作为退路（老快照没有 id 时）✓。
   * 文档 P1：上游的相机/布局缓存是**模块级单槽位、没有身份** ✗
   * —— 不按身份分区就会出现"A 库的球心和姿态被 B 库采用"✓。
   */
  library?: { root?: string; name?: string; formatVersion?: number; libraryId?: string };
  focusId?: string | null;
  nodes?: GraphSnapshot["nodes"];
  edges?: GraphSnapshot["edges"];
  goals?: GraphSnapshot["goals"];
  counts?: { nodes?: number; edges?: number; issues?: number };
  issues?: Array<{ code: string; relativePath: string; detail: string }>;
  truncated?: boolean;
  revision?: number;
  error?: { code?: string; message?: string; createPath?: string };
}

/** 搜索候选最多列几条（再多就不是"挑一个"而是"翻列表"了 ✓） */
const SEARCH_LIMIT = 8;

/** 候选列表的 id（输入框用 `aria-controls` / `aria-activedescendant` 指过来 ✓） */
const SEARCH_LIST_ID = "kn-search-results";

/**
 * 「这次聚焦是鼠标点出来的」标记：打在画布根节点（`.universe`）上。
 *
 * 现在只作**诊断与兼容**用途（CSS 已经不看它来决定压不压环了 ✗）：
 * 环改成"`:focus` / `:focus-visible` 一律不画"，键盘提示改由 `KEYBOARD_FOCUS_ATTR` 承担 ✓。
 */
const POINTER_FOCUS_ATTR = "data-pointer-focus";

/**
 * 「这次聚焦是键盘 Tab 过来的」标记：只有它存在时才画可见焦点环 ✓。
 *
 * 为什么要自己打标记：浏览器把**脚本聚焦**（宿主切标签后自动聚焦画布）也算 `:focus-visible` ✗，
 * 只靠 `:focus-visible` 判断"是不是键盘"会把环错误地显示出来 ✓（用户两次反馈的就是这个）。
 */
const KEYBOARD_FOCUS_ATTR = "data-keyboard-focus";

const LITERAL: Record<string, string> = {
  focus: "聚焦",
  space: "空间",
  refresh: "刷新",
  refreshHint: "重新从磁盘读取知识库（绕过宿主的库缓存）",
  relayout: "重新整理",
  relayoutHint: "重排布局，并把旋转中心复位到整张图",
  /* 搜索框（2026-10）：模糊匹配后**列候选**，由用户挑一个聚焦 ✓ */
  searchPlaceholder: "搜索知识点，回车聚焦",
  searchGo: "搜索并聚焦",
  searchResults: "匹配结果",
  searchMiss: "没有匹配的节点",
  loading: "正在解析当前工作区…",
  failed: "读取知识库失败",
  noNodes: "这个知识库里还没有知识点。",
  emptyHint: "在空白处右键即可新建节点",


  counts: "节点 {n} · 依赖 {e}",
  truncated: "（已截断显示）",
  spaceFailed: "三维视图不可用；数据本身没问题，点「重试」或刷新面板再试。",
  workspaceHint: "面板跟随当前工作区：把这个知识库目录作为工作区打开，这里就会直接显示它。",
  nodeMenuTitle: "这个知识点",
  editNote: "编辑笔记",
  addPrerequisite: "添加前置节点…",
  /* 节点笔记编辑器（`design/node-note-editor.html` ✓）；正式文案同时进中英词典 ✓ */
  leaveTitle: "有尚未保存的笔记",
  /* 动作说清楚：关编辑区 ⇒ 「保存并关闭」；切节点 ⇒ 「保存并切换」✓（不再用笼统的"保存并继续"✗） */
  leaveCloseMessage: "当前笔记有未保存修改。保存后关闭编辑区？",
  leaveSwitchMessage: "当前笔记有未保存修改。保存后切换到另一个节点？",
  leaveBlocked: "编辑器里还有问题要处理（见编辑区的提示），处理完再保存并继续。",
  leaveSaveBlocked: "暂时无法保存",
  leaveStay: "继续编辑",
  leaveDiscard: "放弃修改",
  leaveSaveClose: "保存并关闭",
  leaveSaveSwitch: "保存并切换",
  edgeMenuTitle: "这条依赖",
  removeRelation: "删除这条依赖",
  removeNode: "删除当前节点",
  removeNodeConfirmTitle: "删除这个节点？",
  // 弹窗里只用来引出节点名（删除语义见下面的 hint）：不要再写 v2 那套"移身份/文件夹保留"的说法
  removeNodeConfirmMessage: "要删除的知识点",
  removeNodeDone: "已删除",
  autoCreateFailed: "自动创建知识库失败",
  promptTitle: "添加前置节点",
  promptHint: "输入前置知识点的名称",
  confirmCreate: "添加",
  cancel: "取消",
  removeConfirmTitle: "删除依赖",
  removeConfirmMessage: "确认删除这条前置关系吗？",
  candidatesTitle: "已经有相近的知识点",
  candidatesMessage: "库里已有相近节点，建议复用而不是新建",
  reuse: "复用",
  createAnyway: "仍然新建",
  menuFailed: "操作失败",
  dependents: "依赖它的地方",
  focusNow: "当前知识点",
  prerequisites: "它的前置知识",
  dependentsEmpty: "没有其它知识点依赖它",
  prerequisitesEmpty: "它没有前置知识",
  statusDone: "已完成",
  statusLearning: "学习中",
  statusTodo: "未开始",
  notKnowledgeBase:
    "当前工作区不是知识库（没有通过「添加知识库」按钮登记过）。"
    + "用左侧栏「工作区」表头上的知识库按钮把它加进来即可。",
  routeNotReady:
    "面板数据路由未就绪：宿主半只有在重启 DSH 之后才会注册它（刷新页面只更新客户端半）。"
    + "重启后若仍是这样，请在会话里调用 kn_status，把它给出的诊断发出来。",
  panelCrashed: "面板渲染出错：请刷新页面；若持续出现，请把控制台里的报错发给我。",
};

/** 面板跟随当前工作区：解析出的目标（工作区路径优先，其次会话 id） */
type PanelTarget = { kind: "root" | "session"; value: string } | undefined;

/**
 * 面板的错误边界：**任何渲染异常都显示一条可读提示，而不是白屏**。
 *
 * 为什么需要：面板里一个 TDZ/取数异常会让整块区域变成空白、没有任何线索
 * （真事：往 GraphPanel 加诊断上报时把 useEffect 写在变量定义之前）。
 * 3D 视图原本有自己的边界，这里管住整个面板。
 *
 * @param props - 与内层组件相同（用 Parameters 取，避免重复写一遍类型）。
 * @returns 出错时给提示，正常时原样渲染。
 */
export function GraphPanel(props: Parameters<typeof GraphPanelInner>[0]): ReactNode {
  /* 出错兜底也要跟随语言 ✓（用插件自己的绑定 ✓：这里不能用 `useMemo` + `makeTranslator(props.t…)` ✗ ——
   * 那条"不许先用后声明"的测试会把 `props.t` 看成后面才声明的 `t` ✓（真事 ✓）） */
  return (
    <ErrorBoundary
      fallback={
        <div className="kn-msg">
          {pluginTranslate()?.("panelCrashed") ?? LITERAL.panelCrashed}
        </div>
      }
    >
      <GraphPanelInner {...props} />
    </ErrorBoundary>
  );
}

function GraphPanelInner(props: {
  t?: unknown;
  /** 标准 props：会话作用域插槽会给 */
  sessionId?: string;
  /** 标准 props：工作区快照选择器（形状按语义识别，见 workspace-path.ts） */
  useWorkspaces?: (selector: (snapshot: unknown) => unknown) => unknown;
  /** 框架注入的信息钩子：从标签页的 navigation params 里读用户点选的库根 */
  useTabInfo?: () => { tab?: { navigation?: { params?: unknown } } };
}) {
  /*
   * **翻译函数必须稳定**：`makeTranslator` 每次调用都返回新函数 ✗，
   * 而 `load` 曾经把 `t` 放进依赖 ⇒ `load` 每次渲染都变 ⇒ `useEffect([load])` 每渲染都跑
   * ⇒ 请求回来 setState ⇒ 再渲染 ⇒ **自激取数循环**（会持续打宿主，并不断唤醒三维渲染）。
   * 两步一起做：`useMemo` 固化 `t`，并且 `load` 只通过 `tRef` 读它（不进依赖）。
   */
  const t = useMemo(() => makeTranslator(props.t, LITERAL), [props.t]);
  const tRef = useRef(t);
  tRef.current = t;
  const [payload, setPayload] = useState<PanelPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 只表示「手动刷新」是否在飞：自动取数不该把刷新按钮变灰 */
  const [refreshing, setRefreshing] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [relayoutToken, setRelayoutToken] = useState(0);
  /** 相机命令：`fitAll`（收全图）或 `focusNode`（飞到某个节点）—— 类型直接用上游那份，别再写窄的 ✓ */
  const [cameraCommand, setCameraCommand] = useState<CameraCommand | null>(null);
  const fitSeqRef = useRef(0);
  /**
   * **正在编辑笔记的节点**（null = 编辑器关着 ✓）。
   *
   * 编辑器只编辑**正文** ✓；未保存时切节点/关闭要先问用户三选一
   * （继续编辑 / 放弃修改 / 保存并继续 ✓）—— 这就是下面 pendingEdit 的用途。
   */
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  /** 编辑器当前是否有未保存改动（由编辑器上报 ✓） */
  const [editorDirty, setEditorDirty] = useState(false);
  /** 「保存并继续」的触发计数：+1 ⇒ 编辑器保存，成功后在 onSaved 里完成待办 ✓ */
  const [editorSaveNonce, setEditorSaveNonce] = useState(0);
  /** 编辑器是否正在保存（弹窗据此显示"保存中"、禁用"放弃修改" ✓ —— 复查 P2-2 ✓） */
  const [editorSaving, setEditorSaving] = useState(false);
  /** 编辑器现在能不能保存（没有指纹/载入失败时提前禁用「保存并继续」✓ —— 复查 P2-2 ✓） */
  const [editorSaveable, setEditorSaveable] = useState(true);
  /** 待办：保存成功后要执行的切节点/关闭动作 ✓ */
  const pendingEditRef = useRef<EditAction | null>(null);
  const [leaveDialog, setLeaveDialog] = useState<EditAction | null>(null);
  /**
   * 渲染期快照的"当前库身份"。
   *
   * `applyEdit` 里要用它来清"这个库还开着编辑器"的记忆，但 `libraryKey` 声明在后面
   * （依赖数组在渲染期求值 ⇒ 写进 `useCallback` 依赖会 TDZ ✗）⇒ 走 ref ✓。
   */
  const libraryKeyRef = useRef("");

  /**
   * 请求进入某个节点的编辑器（或关闭）。
   * 有未保存改动时**不直接切**，先弹三选一 ✓（设计稿要求 ✓）。
   */
  /**
   * **真正切编辑器**：编辑目标与**图谱聚焦**必须一起改 ✓。
   *
   * 为什么不能只 `setEditingNodeId` ✗（用户实测："点一下抖一下、还停在原来那篇"✓）：
   * 下面有一条 effect 是"图谱聚焦变了就切编辑器" ✓ —— 只改编辑目标的话，
   * `effectiveFocus` 还是原来那个节点 ✓ ⇒ 新节点刚挂上就被立刻请求回去 ✗
   * ⇒ 表现成"窗口抖一下、文档没换"✓。
   * 两处**同时**改 ⇒ `effectiveFocus === editingNodeId` ✓，那条 effect 自然不动 ✓，
   * 而且图谱高亮也跟着跳到被打开的那个节点 ✓（正是"跳转到对应节点"该有的样子 ✓）。
   */
  const applyEdit = useCallback((next: EditAction): void => {
    /*
     * **打开对话不关编辑器**（用户要求：编辑笔记的弹窗不受"打开新对话"影响 ✓）。
     *
     * 编辑器开着哪篇笔记记在**组件外**（`open-editor.ts`，按库身份 ✓）：
     * 如果这次真的换了会话，本实例会被整体卸载（右侧栏停靠面按会话）⇒
     * 新面板挂载后会把它恢复出来 ✓（见下面那条同步/恢复 effect）。
     */
    if (next.kind === "conversation") { nodeConversations.open(next.sessionId); return; }
    /*
     * 关掉编辑器**必须先清掉"这个库还开着编辑器"的记忆** ✗ ——
     * 否则那条 effect 会看到"记录里有、state 是 null"又把编辑器恢复回来（关不掉 ✓）。
     */
    if (next.kind === "close") forgetOpenEditor(libraryKeyRef.current);
    if (next.kind === "open") setFocusId(next.nodeId);
    setEditingNodeId(next.kind === "open" ? next.nodeId : null);
  }, []);

  const requestEdit = useCallback((
    next: EditAction,
    /*
     * **来得更新鲜的 dirty** ✗（第三次复查 P2-1）：编辑器刚在组合结束后取过快照，
     * 那一刻的"有没有未保存内容"比 React state 更准 ⇒ 一律以传入值为准 ✓，
     * 否则"该弹三选一却没弹"或"明明干净却拦住"都可能发生 ✗。
     */
    freshDirty?: boolean | undefined,
  ): void => {
    /*
     * **打开对话不算"离开编辑器"** ⇒ 三选一不适用 ✓（用户要求：这个操作不许影响编辑弹窗 ✓）。
     * 未保存的内容就留在编辑器里，编辑器本身不关、不重挂 ✓。
     */
    if (next.kind === "conversation") { applyEdit(next); return; }
    if (freshDirty ?? editorDirty) {
      setLeaveDialog(next);
      return;
    }
    /*
     * 注意：**取消三选一时不许动聚焦** ✗ —— 聚焦改了、编辑器没切，
     * 那条"聚焦变了就切"的 effect 又会立刻再弹一次 ✗（会变成死循环 ✓）。
     * 所以聚焦只在**真正落地**的这两处跟着改 ✓（这里 + 保存后的待办 ✓）。
     */
    applyEdit(next);
  }, [editorDirty, applyEdit]);

  /** 三选一：继续编辑 */
  const cancelLeave = useCallback((): void => {
    pendingEditRef.current = null;
    setLeaveDialog(null);
  }, []);

  /** 三选一：保存并继续（真正的切换在 onSaved 里完成 ⇒ 保存失败就留在原地 ✓） */
  const saveAndLeave = useCallback((): void => {
    pendingEditRef.current = leaveDialog;
    setEditorSaveNonce((value) => value + 1);
  }, [leaveDialog]);

  /**
   * 编辑器的保存生命周期（复查 P2-2）。
   *
   * 关键行为：**保存失败 / 冲突 / "保存成功但仍有新草稿"时收起弹窗、清掉待办** ✓ ——
   * 否则那个覆盖全屏的三选一弹窗会挡住编辑器里的错误与合并入口 ✗，
   * 甚至会把用户还没保存的字一起关掉 ✗；
   * 且旧待办绝不能在后来某次普通保存成功时"意外生效" ✗（所以这里一并清空 ✓）。
   * 用户处理完错误后重新点关闭/切换即可重新发起 ✓。
   */
  const onEditorSaveOutcome = useCallback((saving: boolean, outcome: string | null): void => {
    setEditorSaving(saving);
    if (saving) return;
    /* 只有干净的 "saved" 才继续执行离开待办 ✓；"saved-dirty" 要留在原地 ✗ */
    if (outcome === "saved") return;
    pendingEditRef.current = null;
    setLeaveDialog(null);
  }, []);
  /**
   * 离开弹窗文案：**动作说清楚** ✓（关闭 ⇒「保存并关闭」；切节点 ⇒「保存并切换」）。
   * 计算放在 `leaveLabels`（纯函数、可单测 ✓）；这里每次渲染直接取（很便宜 ✓，
   * 而且不把每次都变的 `t` 放进依赖 ✗）。
   */
  const leaveCopy = leaveDialog === null
    ? null
    : leaveLabels(leaveDialog.kind === "conversation" ? "close" : leaveDialog.kind, t, { saving: editorSaving, saveable: editorSaveable });
  /** 搜索框里正在敲的关键词（只影响提示与回车时的选点，不进图谱数据 ✓） */
  const [searchQuery, setSearchQuery] = useState("");
  /**
   * 发一条 `fitAll` 相机命令：把**环绕中心**（旋转中心）与距离复位到**整张图的包围盒**。
   *
   * 上游 `navigation.fitAll()` 取的是**全部节点**的 bounds.center，所以它天然"不认"某个聚焦节点 ✓。
   * 两处用它：
   *  1. 新建节点后 ⇒ 把新节点收进视野；
   *  2. 点「重新整理」⇒ **把旋转中心收回来**（用户要求 2026-09）。
   *     —— 上游 `engine.relayout()` 是"只重排布局、相机保持不动"（注释里写明了是刻意的），
   *     于是聚焦过某个节点后，环绕中心会一直钉在那个节点上 ✗；这里补上归位那一步 ✓。
   */
  const fitWholeGraph = useCallback((): void => {
    fitSeqRef.current += 1;
    setCameraCommand({ seq: fitSeqRef.current, type: "fitAll", source: "toolbar" });
  }, []);

  /**
   * 飞到某个节点：**选中 + 取景**两件事一起做（搜索命中后用它 ✓）。
   *
   * - `setFocusId` ⇒ 高亮这个节点，并触发既有的"记住聚焦 / 上报 / 发布标题"副作用 ✓；
   * - 再发一条 `focusNode` 相机命令 ⇒ 镜头对上去（与**双击节点、按 F** 是同一条路 ✓）。
   *
   * 为什么不能只 `setFocusId`：上游把"选择"与"定位"严格分开了 —— `engine.setFocus()` 只改高亮，
   * **不动相机**（`navigation.focusOn` 才是取景）✓。
   */
  const focusNodeById = useCallback((id: string): void => {
    setFocusId(id);
    fitSeqRef.current += 1;
    setCameraCommand({ seq: fitSeqRef.current, type: "focusNode", nodeId: id, source: "toolbar" });
  }, []);
  const [spaceNotice, setSpaceNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  /*
   * 「和当前工作区绑定」：不再让用户填库根。工作区路径来自标准 props 快照
   * （`useWorkspaces().items[].path`，用 sessionIds 对上当前会话），拿不到就退到会话 id，
   * 由宿主按该会话的 cwd 去找最近的 library.json。
   */
  const identity = useMemo(() => (snapshot: unknown) => snapshot, []);
  const workspaceSnapshot = props.useWorkspaces === undefined ? undefined : props.useWorkspaces(identity);
  const workspacePath = useMemo(
    () => pickWorkspacePath(workspaceSnapshot, props.sessionId),
    [workspaceSnapshot, props.sessionId],
  );

  /*
   * **知识库身份**：作为 prop **显式**交给图谱组件，再由组件交给引擎（引擎构造时绑定到实例）✓
   *
   * 为什么不写成"渲染期设一个全局变量、引擎稍后去读" ✗：
   * 引擎是在**子组件的 effect 里**创建的，而 React 的效果是"子先父后、按提交顺序"——
   * 两个面板在同一提交里渲染时，全局变量早已被后渲染的那个面板覆盖 ⇒
   * A 的引擎会绑到 B 的身份上，缓存就此串库 ✗（文档 P1 复查指出的就是这个）。
   */
  const libraryKey = useMemo(() => libraryKeyOf(payload?.library), [payload?.library]);
  /* `applyEdit` 在回调里读它（那时早已赋值 ✓），用来清"这个库还开着编辑器"的记忆 ✓ */
  libraryKeyRef.current = libraryKey;

  /**
   * 编辑器的**库级记忆**：同步 + 恢复，一个 effect 搞定。
   *
   * - `editingNodeId !== null` ⇒ 记下"这个库开着这篇" ✓；
   * - `editingNodeId === null` 且记录里有 ⇒ **恢复**（换会话后新面板接管 / 面板重挂 ✓）；
   * - 两边都空 ⇒ 什么都不用做。
   *
   * 为什么恢复时必须**连聚焦一起设**：下面有一条"聚焦变了就切编辑器"的 effect，
   * 只恢复编辑器的话，`effectiveFocus` 还是宿主给的那一篇 ⇒ 编辑器刚开就被请求切走 ✗。
   *
   * 关闭编辑器走 `applyEdit` 的 `close` 分支（先 `forgetOpenEditor` 再置 null ✓），
   * 所以这里不会出现"关掉又被恢复"的死循环 ✓。
   */
  useEffect(() => {
    if (libraryKey === "") return;
    if (editingNodeId !== null) { rememberOpenEditor(libraryKey, editingNodeId); return; }
    const restored = openEditorNode(libraryKey);
    if (restored === null) return;
    setFocusId(restored);
    setEditingNodeId(restored);
  }, [libraryKey, editingNodeId]);

  /*
   * 标签页 params 里的 root：用户从左侧栏「知识库」区块点了某个库。
   * 这是最明确的意图，优先于工作区绑定。信息钩子只能在渲染期调用，所以放在这里取。
   */
  let overrideRoot: string | undefined;
  if (props.useTabInfo !== undefined) {
    try {
      const params = props.useTabInfo()?.tab?.navigation?.params as
        | { root?: unknown; knowledgenet?: { root?: unknown } }
        | undefined;
      const candidate = params?.root ?? params?.knowledgenet?.root;
      if (typeof candidate === "string" && candidate.trim() !== "") overrideRoot = candidate;
    } catch {
      // 取不到就按工作区绑定，不要因为一个信息钩子让面板打不开
    }
  }

  /*
   * 过期 root 的自我修复开关。
   *
   * 为什么需要：标签页 params 里的 root 是**开标签页那一刻**的意图，会一直留着。
   * 如果那个库被搬走/删掉（或你换了模型：库现在必须在 `<工作区>/.dsh_knowledge/`），
   * 面板会永远卡在同一句"还没有可用的知识库"✗ —— 让人以为插件坏了。
   * 所以：用显式 root 取数失败时，**自动退回"跟随当前工作区"**再试一次（并上报留痕）。
   */
  const [ignoreOverride, setIgnoreOverride] = useState(false);
  const fallbackRef = useRef(false);


  const target = useMemo<PanelTarget>(
    () => resolvePanelTarget({
      overrideRoot: ignoreOverride ? undefined : overrideRoot,
      workspacePath,
      sessionId: props.sessionId,
    }),
    [ignoreOverride, overrideRoot, workspacePath, props.sessionId],
  );

  /**
   * 编辑器的库目标：**必须稳定** ✗ —— 每次渲染新建对象会让编辑器重新读盘并冲掉草稿
   * （复查 P1-1 的头号问题）。这里按 root/sessionId 固化 ✓。
   *
   * **必须排在 `target` 之后**（TDZ ✗：`useMemo` 工厂在渲染期立即求值 ✓）。
   */
  const editingTarget = useMemo(() => {
    if (target === undefined) return { sessionId: props.sessionId };
    return target.kind === "root" ? { root: target.value } : { sessionId: target.value };
  }, [target, props.sessionId]);

  /** 诊断上报也固化（编辑器内部用 ref 保管，这里再稳一层更省心 ✓） */
  const editorReport = useCallback((step: string, detail: unknown): void => {
    void reportDiag("note-editor", step, detail ?? null);
  }, []);

  /**
   * 三选一：放弃修改。
   *
   * **必须先清掉这个节点在组件外缓存里的草稿** ✗ —— 否则稍后打开同一节点，
   * 那个"用户刚刚明确放弃"的内容又会被恢复出来（复查 P2-3 ✓）。
   * 清理要发生在切换之前；切换只改 state，不会触发编辑器再写一次缓存 ✓。
   *
   * ⚠️ **声明位置很关键**：依赖数组在**渲染期**求值 ⇒ 这里必须排在 `libraryKey` 之后，
   * 否则就是 `Cannot access 'libraryKey' before initialization` ✗（实机崩过一次 ✓）。
   */
  const discardLeave = useCallback((): void => {
    const pending = leaveDialog;
    pendingEditRef.current = null;
    setLeaveDialog(null);
    if (editingNodeId !== null) forgetDraft(draftKey(libraryKey, editingNodeId));
    /* 丢弃并继续 ⇒ 同样是"**真正落地**"的切换 ✓ ⇒ 走 applyEdit（聚焦一起改 ✓） */
    if (pending !== null) applyEdit(pending);
  }, [leaveDialog, editingNodeId, libraryKey, applyEdit]);

  /*
   * 注意：诊断上报必须在 `graph` / `effectiveFocus` 定义**之后**——
   * useEffect 的依赖数组在渲染期就要读取这两个变量，写在前面会触发 TDZ
   * （Cannot access 'effectiveFocus' before initialization），整个面板会渲染不出来。
   */

  /*
   * 门禁：**跟随工作区**那条路要求该工作区是「通过添加知识库按钮登记过的知识库」
   * （只是目录里有 library.json 不够——用添加工作区按钮加进来的同一个文件夹只是普通工作区）。
   * 显式 params.root（标签页被点名打开某个库）不走这个门禁。
   */
  /** 静默建库只做一次（避免失败后反复重建） */
  const creatingRef = useRef(false);
  /** 取数请求序号：只让"最新一次请求"的结果落地，丢弃过期响应（见 load 里的 seq 守卫） */
  const seqRef = useRef(0);
  /** 上一次请求的取消手柄：切换目标/卸载时 abort，别让旧请求占着网络与宿主 ✓ */
  const abortRef = useRef<AbortController | null>(null);
  /** 重试定时器：卸载或换目标时必须清掉 ✓ */
  const retryTimerRef = useRef<number | null>(null);
  /** 图区容器：用 IntersectionObserver 判断"面板是否真的看得见" ✓ */
  const graphHostRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const node = graphHostRef.current;
    if (node === null || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry !== undefined) setVisible(entry.isIntersecting && entry.intersectionRatio > 0);
      },
      { threshold: 0.01 },
    );
    observer.observe(node);
    return () => { observer.disconnect(); };
  }, []);

  /*
   * **画布不要那圈焦点环**（用户两次反馈："点击之后这个边框会变得高亮" / "怎么又变成高亮了"）。
   *
   * 环来自上游的 `.universe:focus-visible`：画布要在指针按下时拿到焦点，F / 方向键才生效
   * （`graph3d/navigation.ts` 主动 focus）✓。
   *
   * 只压"鼠标点出来的那一次"不够 ✗：**宿主/脚本聚焦**画布时（切标签、侧栏重排后自动聚焦）
   * 浏览器同样算 `:focus-visible` ✗ ⇒ 环又冒出来。所以：
   * - CSS 里 `:focus` 与 `:focus-visible` **一起压掉**（不再依赖浏览器的启发式 ✗）；
   * - 键盘可达性由**我们自己打的标记**承担：Tab 键打上 `data-keyboard-focus`、指针按下清掉 ✓。
   */
  useEffect(() => {
    const host = graphHostRef.current;
    if (host === null) return undefined;
    const canvas = (): Element | null => host.querySelector(".universe");
    const markPointerFocus = (): void => {
      const element = canvas();
      if (element === null) return;
      element.setAttribute(POINTER_FOCUS_ATTR, "true");
      /* 指针来了 ⇒ 这不是键盘聚焦 ⇒ 撤掉键盘提示 ✓ */
      element.removeAttribute(KEYBOARD_FOCUS_ATTR);
    };
    const clearPointerFocus = (): void => { canvas()?.removeAttribute(POINTER_FOCUS_ATTR); };
    /* 键盘 Tab：下一次聚焦按"键盘聚焦"处理（Tab 之后浏览器才会把焦点移过去 ✓） */
    const markKeyboardFocus = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      canvas()?.setAttribute(KEYBOARD_FOCUS_ATTR, "true");
    };
    host.addEventListener("pointerdown", markPointerFocus, true);
    /* focusout 会冒泡：焦点离开画布（去别处、或组件卸载）就把标记清掉，免得影响下一次键盘聚焦 ✓ */
    host.addEventListener("focusout", clearPointerFocus, true);
    window.addEventListener("keydown", markKeyboardFocus, true);
    return () => {
      host.removeEventListener("pointerdown", markPointerFocus, true);
      host.removeEventListener("focusout", clearPointerFocus, true);
      window.removeEventListener("keydown", markKeyboardFocus, true);
    };
  }, []);

  // 卸载时收尾：取消在飞的请求、清掉重试定时器（否则回调会打到已卸载的组件上 ✓）
  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const load = useCallback(async (options: { refresh?: boolean } = {}) => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    const t = tRef.current;
    // 取消上一次在飞的请求：切工作区/刷新时它已经没有意义了 ✓
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (target !== undefined) query.set(target.kind === "root" ? "root" : "sessionId", target.value);
      if (options.refresh === true) query.set("refresh", "1");
      const suffix = query.toString();
      const response = await fetch(suffix === "" ? GRAPH_API_ROUTE : `${GRAPH_API_ROUTE}?${suffix}`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
        signal: controller.signal,
      });
      const text = await response.text();
      let body: PanelPayload | null = null;
      try {
        body = JSON.parse(text) as PanelPayload;
      } catch {
        body = null;
      }
      if (seq !== seqRef.current) return; // 过期响应：丢弃，别覆盖最新一次
      if (body === null) {
        setPayload(null);
        setError(t("routeNotReady"));
        return;
      }
      if (body.ok === true) {
        setPayload(body);
        setError(null);
        return;
      }

      /*
       * **首次打开就静默创建知识库**（用户要求）：
       * 宿主回答 library_missing 时带着建议位置 `<工作区>/.dsh_knowledge`，这里直接建，
       * 不弹任何窗口、不问任何问题；建完立刻重新取数。
       *
       * 只做一次（creatingRef），失败就退化成显示原因（例如目录不可写），不再反复重试。
       */
      if (body.error?.code === "library_missing" && body.error?.createPath !== undefined && !creatingRef.current) {
        creatingRef.current = true;
        try {
          const created = await fetch(GRAPH_API_ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ kind: "create-library", root: body.error.createPath, title: undefined }),
          });
          const outcome = (await created.json().catch(() => null)) as
            | { ok?: boolean; error?: { code?: string; message?: string } }
            | null;
          if (outcome?.ok !== true) {
            /*
             * **失败必须说出来**：之前这里是 `catch {}` 直接吞掉 ✗ ⇒ 用户只看到"还没有知识库"，
             * 反复点击也建不出来，完全不知道原因（实测：目录里残留了 `Backup/`、`Nodes/`，
             * 被"非空目录"守卫拦下 ✓）。现在把宿主的错误码与原文直接显示出来 ✓。
             */
            const code = outcome?.error?.code ?? "unknown";
            void reportDiag("graph-panel", "auto-create-library", `failed:${code}`);
            setPayload(null);
            setError(`${t("autoCreateFailed")}：[${code}] ${outcome?.error?.message ?? ""}`);
            return;
          }
          void reportDiag("graph-panel", "auto-create-library", "ok");
        } catch (cause) {
          void reportDiag("graph-panel", "auto-create-library", "threw");
          setPayload(null);
          setError(`${t("autoCreateFailed")}：${cause instanceof Error ? cause.message : String(cause)}`);
          return;
        }
        setAttempt((value) => value + 1);
        return;
      }

      /*
       * **过期显式 root 的自我修复**：带着标签页里的旧 root 取数失败时，退回"跟随当前工作区"
       * 再试一次（只做一次，避免来回打转）。没有这一步的话，被搬走/删掉的旧库会让面板
       * 永远停在错误上 ✗。
       */
      if (target.kind === "root" && !fallbackRef.current) {
        fallbackRef.current = true;
        void reportDiag("graph-panel", "root-fallback", body.error?.code ?? "error");
        setIgnoreOverride(true);
        return;
      }

      setPayload(null);
      /*
       * 错误里带上**错误码**：`library_missing`（还没建库）/ `library_unavailable`（显式 root 不是库）
       * / `session_unknown`（宿主还没拿到工作区）三种情况的表现完全不同，带码就能一眼定位。
       */
      const failureCode = body.error?.code ?? "unknown";
      setError(`${body.error?.message ?? failureCode} [${failureCode}]`);
      // 会话刚建时宿主可能还没拿到它的工作区：稍后自己重试，而不是让用户手动填路径
      if (body.error?.code === "session_unknown" && attempt < 4) {
        // 定时器要能被清理：卸载/切换目标时不能再触发一次 setAttempt（旧请求的回调 ✗）
        if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          setAttempt((value) => value + 1);
        }, 1200);
      }
    } catch (cause) {
      /*
       * 过期请求的异常同样不能改状态：切工作区时旧请求被 abort ⇒ 这里会抛
       * `AbortError` ✗，如果不过滤就会把新工作区的界面刷成错误状态 ✓。
       */
      if (seq !== seqRef.current || (cause instanceof Error && cause.name === "AbortError")) return;
      setPayload(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
    // 依赖里**没有 t**：它只通过 tRef 读取 —— 这正是那条自激取数循环的根因
  }, [attempt, target]);

  /*
   * 取数：**面板不可见时完全不取** ✓。
   *
   * `keepMounted: false` 只覆盖"切换标签页"✓；而 DSH 在**侧栏收起**时仍可能保留选中标签的挂载
   * （代码审查指出 ✓），那时取数与三维渲染都会继续跑。这里用 IntersectionObserver 直接观察
   * 图区容器：一旦它不可见（收起/被盖住/零尺寸）就停；重新可见时按需刷新一次 ✓。
   */
  useEffect(() => {
    if (!visible) return;
    void load();
  }, [load, visible]);

  /*
   * **浮条/菜单建完节点后，视图要自己跟上**（用户要求：默认刷新一次 ✓，并且新节点要在视野里 ✓）。
   *
   * 三件事一起做：
   *  1. 重新取数（`refresh: true` 绕过宿主缓存 ✓）；
   *  2. `relayoutToken` +1 ⇒ 重跑力导向布局 ✓（新节点由力场安置，而不是留在上一步的旧坐标 ✗）；
   *  3. 发一条 `fitAll` 相机命令 ⇒ 把所有节点（含新节点）收进视野 ✓
   *     —— 之前新节点会落在视野外，界面上只提示"选中节点在视野外·按 F 返回" ✗。
   */
  useEffect(() => {
    const onLibraryChanged = (): void => {
      void load({ refresh: true });
      setRelayoutToken((value) => value + 1);
      fitWholeGraph();
    };
    window.addEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);
    return () => { window.removeEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged); };
  }, [load, fitWholeGraph]);

  const updateUnderstanding = useCallback((states: Record<string, boolean>) => { setPayload(current => current ? { ...current, understanding: states } : current); }, []);
  const graph = useMemo<GraphSnapshot | null>(() => {
    if (payload === null) return null;
    return {
      revision: typeof payload.revision === "number" ? payload.revision : 0,
      nodes: payload.nodes ?? [],
      edges: payload.edges ?? [],
      goals: payload.goals ?? [],
      session: null,
    };
  }, [payload]);
  const coloredGraph = useMemo<GraphSnapshot | null>(() => graph ? { ...graph, nodes: graph.nodes.map(node => ({ ...node, status: payload?.understanding?.[node.id] === true ? "done" : "todo" })) } : graph, [graph, payload?.understanding]);


  /**
   * 三维**场景标识**：库身份 + 节点集合。
   *
   * 两个地方要用同一个 key ✓：
   * - `<GraphUniverse key=…>`：换库或增删节点时重建引擎；
   * - 右下角**视角位置图**：变化时清空位置快照与历史轨迹（别把上一个场景的点投到新场景 ✗）。
   *
   * **必须放在 `graph` 之后** ✗ —— 它读 `graph`；放到组件前部会在模块初始化时序上踩 TDZ
   * （实测 `ReferenceError: Cannot access 'graph' before initialization` ⇒ 整块面板渲染失败 ✗）。
   */
  const sceneKey = useMemo(
    () => `${libraryKey}#${(graph?.nodes ?? []).map((node) => node.id).sort().join(",")}`,
    [libraryKey, graph],
  );

  const effectiveFocus = focusId ?? payload?.focusId ?? null;
  const nodeCount = payload?.counts?.nodes ?? graph?.nodes.length ?? 0;
  const edgeCount = payload?.counts?.edges ?? graph?.edges.length ?? 0;

  /**
   * 当前**选中的节点**（信息条 + 「编辑笔记」入口要用 ✓）。
   *
   * 声明顺序很关键 ✗：它读 `graph` **和** `effectiveFocus` ⇒ 必须排在这两个之后
   * （`useMemo` 的工厂在渲染期立即求值 ⇒ 排前面就是
   * `Cannot access 'X' before initialization`，整块面板崩 ✗ —— 这个坑已经踩过两次 ✓）。
   */
  const selectedNode = useMemo(() => {
    if (graph === null || effectiveFocus === null || effectiveFocus === undefined) return null;
    const node = graph.nodes.find((item) => item.id === effectiveFocus);
    if (node === undefined) return null;
    return {
      id: node.id,
      title: node.title,
      status: node.status,
      prerequisites: graph.edges.filter((edge) => edge.fromId === node.id).length,
    };
  }, [graph, effectiveFocus]);

  /**
   * 编辑器开着时，用户在图上点了别的节点 ⇒ **跟着切过去** ✓
   * （有未保存修改就先三选一 —— 与关闭按钮共用 `requestEdit` 同一条路 ✓）。
   */
  useEffect(() => {
    if (editingNodeId === null) return;
    if (effectiveFocus === null || effectiveFocus === undefined) return;
    if (effectiveFocus === editingNodeId) return;
    requestEdit({ kind: "open", nodeId: effectiveFocus });
  }, [effectiveFocus, editingNodeId, requestEdit]);

  /*
   * 搜索候选：**列出所有命中的节点，让用户自己挑** ✓（用户反馈 2026-10）。
   *
   * 之前是"算出匹配度最高的那个，回车直接飞过去" ✗ —— 查「车」时"回车""回车聚焦"都命中，
   * 界面却替用户选了其中一个并动了镜头，用户原话："我们不应该替用户做决定"。
   * 现在这里给出**候选列表**（按匹配度排序），键盘 ↑↓ 或鼠标点选，回车聚焦当前高亮那条 ✓。
   * 节点上限 400，纯字符串打分，每次渲染算一遍开销可忽略 ✓。
   */
  const searchMatches = useMemo<Array<NodeMatch<SearchableNode>>>(() => {
    if (graph === null) return [];
    return rankNodes(graph.nodes as SearchableNode[], searchQuery, SEARCH_LIMIT);
  }, [graph, searchQuery]);

  /** 关键词非空、一个都没命中 ⇒ 候选框里给一句"没有匹配的节点" ✓（图谱没载入时不说这话） */
  const searchMissed = graph !== null && searchQuery.trim() !== "" && searchMatches.length === 0;

  /** 搜索块有没有焦点：只有聚焦时才弹候选（点别处就收起来，不常驻挡着图 ✓） */
  const [searchFocused, setSearchFocused] = useState(false);
  const searchOpen = searchQuery.trim() !== "" && searchFocused;
  /** 当前高亮第几条候选（↑↓ 移动、鼠标悬停也会高亮；回车聚焦的就是它 ✓） */
  const [searchActive, setSearchActive] = useState(0);
  /*
   * 关键词一变，高亮回到第一条。
   * 少了这一步，候选从 5 条变成 1 条时高亮可能停在下标 4 ⇒ 回车什么都不发生（"点了没反应" ✗）。
   */
  useEffect(() => { setSearchActive(0); }, [searchQuery]);

  /**
   * 聚焦候选里的第 `index` 条（用户点它，或回车时聚焦当前高亮那条 ✓）。
   * 做完就把关键词清空、候选收起 —— 镜头已经飞过去了，界面回到干净状态 ✓。
   */
  const focusSearchResult = (index: number): void => {
    const hit = searchMatches[index];
    if (hit === undefined) return;
    void reportDiag("graph-panel", "search-focus", `${hit.via}:${hit.score}`);
    focusNodeById(hit.node.id);
    setSearchQuery("");
  };

  /** 回车 / 点右侧箭头：聚焦**当前高亮**那条候选（高亮在界面上是可见的，所以不是"替你决定"✓） */
  const submitSearch = (): void => {
    if (searchQuery.trim() === "") return;
    if (searchMatches.length === 0) {
      void reportDiag("graph-panel", "search-miss", "no-match");
      return;
    }
    focusSearchResult(searchActive);
  };

  /*
   * 面板是 session 作用域（拿得到 sessionId），把它记下来供 **root 作用域**的组件用：
   * 「对话里划词 → 添加前置」的浮条挂在 sidebar.footer.action，拿不到 sessionId，
   * 没有它就判断不出"当前工作区是不是知识库"（实测：门禁一律拒绝 → 浮条永远不出现）。
   */
  useEffect(() => {
    rememberSessionId(props.sessionId ?? null);
  }, [props.sessionId]);

  /*
   * 发布"当前会话上下文"给 **root 作用域**的组件（划词浮条）用：
   * 它们拿不到 sessionId，切工作区时 props/快照也可能不刷新；而本组件是 session 作用域、
   * 会随宿主刷新（实测：切工作区时面板数据确实跟着切），所以由这里发布最可靠。
   * 卸载时清掉，避免留下陈旧值（浮条宁可少显示，也不误显示）。
   */
  useEffect(() => {
    /*
     * 顺手把 id→标题 也发布出去：划词浮条的「推荐」要显示真名（否则只剩 id 前 8 位，像乱码）。
     * 浮条在 root 作用域，自己拿不到图谱数据，只能靠这里给。
     */
    const titles: Record<string, string> = {};
    for (const node of graph?.nodes ?? []) {
      const item = node as { id?: string; title?: string };
      if (typeof item.id === "string" && typeof item.title === "string") titles[item.id] = item.title;
    }
    publishCurrentContext({
      sessionId: props.sessionId ?? null,
      workspacePath: workspacePath ?? null,
      /*
       * **把已解析出的库根一并发布** ✓（浮条拿它当写入目标 ⇒ 不必再自己猜工作区路径 ✗）。
       * 实测：某些会话里浮条侧既读不到工作区分组行、也拿不到快照路径，导致"找不到当前工作区" ✗；
       * 而面板这边**本来就知道**库根（取数成功时它就是 `payload.library.root` ✓）。
       */
      libraryRoot: typeof payload?.library?.root === "string" ? payload.library.root : "",
      // 与面板自己的判据一致：登记过 ∧ 那个目录本身是库（exact 探测在取数时由宿主判定）
      // 新模型：能取到数据就说明这个工作区有知识库（目录自描述，不再看登记表）
      library: payload !== null,
      titles,
    });
    return () => {
      clearCurrentContext(props.sessionId ?? null);
    };
  }, [graph, props.sessionId, workspacePath]);

  /*
   * 诊断：聚焦节点的**相关边**到底有几条、什么类型。
   * 用来回答"图上四条边都连着选中节点，为什么只有三条是强调色"——
   * 是数据里只有三条（第四条只是投影上贴着），还是渲染层少画了一条。
   * 放在 graph/effectiveFocus 定义之后（见上面的 TDZ 说明）。
   */
  useEffect(() => {
    if (effectiveFocus === null || effectiveFocus === undefined || graph === null) return;
    const incident = graph.edges.filter(
      (edge: { fromId?: string; toId?: string }) => edge.fromId === effectiveFocus || edge.toId === effectiveFocus,
    );
    // 记进推荐记忆：面板里聚焦过的节点会被「添加前置」的推荐用上（最近聊到的节点）
    try {
      const node = graph.nodes.find((item: { id: string }) => item.id === effectiveFocus);
      rememberFocusNode(String(effectiveFocus), (node as { title?: string } | undefined)?.title);
    } catch {
      // 记忆失败不影响功能
    }
    void reportDiagOnce("focus-incident", "graph-focus", "incident", {
      focus: String(effectiveFocus).slice(0, 12),
      incident: incident.length,
      types: incident.map((edge: { type?: string }) => String(edge.type ?? "?")),
      total: graph.edges.length,
    });
  }, [effectiveFocus, graph]);

  /*
   * 渲染层自己上报的选中事实（构建期补丁从 renderer 派出 `knowledgenet:selection`）：
   * 选中节点 id、引擎里的边数、以及**进了强调层**的每条边两端 id。
   * 它才是"为什么只有三条被强调"的判据（面板的 focusId 是另一回事，别混）。
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onSelection = (event: Event): void => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (detail === null || typeof detail !== "object") return;
      void reportDiagOnce("engine-selection", "graph-focus", "engine-selection", detail);
    };
    window.addEventListener("knowledgenet:selection", onSelection as EventListener);
    // 面板几何（位置/高度/边框宽度）：用来判断"那条横线是插件画的还是宿主的"
    const onGeometry = (event: Event): void => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (detail === null || typeof detail !== "object") return;
      void reportDiagOnce("panel-geometry", "panel-geometry", "measured", detail);
    };
    window.addEventListener("knowledgenet:geometry", onGeometry as EventListener);
    return () => {
      window.removeEventListener("knowledgenet:selection", onSelection as EventListener);
      window.removeEventListener("knowledgenet:geometry", onGeometry as EventListener);
    };
  }, []);

  // 空图 / 未装载时也别只给一片空白：至少让标题栏与计数可见（下面照常渲染）

  return (
    <ShadowPanel height="fill">
      {/*
       * 这里**不再显示库名与计数**（用户反馈：知识库必然是当前项目下的 `.dsh_knowledge`，
       * 那行是冗余信息 ✗）。面板顶部只留操作按钮；视图也只保留**空间视图**——
       * 「聚焦视图」按用户要求整体去掉 ✓。
       */}
      <div className={searchOpen ? "kn-head kn-head-panel is-search-open" : "kn-head kn-head-panel"}>
        {/*
          * 「重新整理」按用户要求换成**设计稿那枚"层级树"图标**（图标按钮，形态与右边那颗刷新一致）✓。
          * 文字改由 `aria-label` 承担；`title` 里说明它到底做了什么（重跑力导向布局）✓。
          */}
        <button
          type="button"
          className="kn-btn kn-icon-btn"
          aria-label={t("relayout")}
          title={t("relayoutHint")}
          onClick={() => {
            /*
             * 三件事一起做（用户要求 2026-09 / 文档 P2）：
             *  ① 广播**明确的重新整理请求** ⇒ 控制器取消抓取、等新布局完成后再采一次球心 ✓
             *     （之前用 `smooth` 参数猜"是不是重排"，而它只表示要不要动画 ✗，
             *      用户操作过之后球心就再也不更新了，与按钮提示不符 ✗）；
             *  ② `relayoutToken` +1 ⇒ 丢掉缓存的坐标、从确定性初始分布重排一轮；
             *  ③ 发一条 `fitAll` ⇒ 收全图（球心是否更新由控制器按②的请求决定 ✓）。
             * 注意：只复位"中心与距离"，**不动用户当前的旋转姿态** ✓。
             */
            window.dispatchEvent(new CustomEvent(RELAYOUT_EVENT, {
              detail: { libraryKey: libraryKeyOf(payload?.library) },
            }));
            setRelayoutToken((value) => value + 1);
            fitWholeGraph();
          }}
        >
          <RelayoutTreeIcon />
        </button>
        {/*
          * 「刷新」按用户要求改成**浏览器那颗圆环刷新按钮**的形态 ✓（字形直接抄 harness 产品图标集）。
          *
          * 文字改由 `aria-label` 承担：可见文字去掉后，读屏仍念得出"刷新" ✓；
          * `title` 上的说明（重新从磁盘读取知识库）保持不变 ✓。
          */}
        
        <button
          type="button"
          className="kn-btn kn-icon-btn"
          aria-label={t("refresh")}
          title={t("refreshHint")}
          onClick={() => { setRefreshing(true); void load({ refresh: true }).finally(() => { setRefreshing(false); }); }}
          disabled={refreshing}
        >
          <RefreshRingIcon />
        </button>

        {/*
          * 搜索框（用户要求 2026-10）：和上面两颗按钮**同一行**，排在那颗刷新**后面** ——
          * 与浏览器那条工具行一致（`[←][→][⟳] [地址栏] [↗]`）✓。
          *
          * 行为：边打字边算出**候选列表**（最多 8 条，按匹配度排序），
          * **由用户自己挑**（↑↓ 或鼠标点，回车聚焦当前高亮那条）✓ ——
          * 用户明确要求过：命中多个时不要替用户决定聚焦哪一个 ✗。
          *
          * 两个刻意的取舍：
          *  1. 只有**聚焦（回车/点候选）**才动镜头；边打字只弹候选 ✓；
          *  2. 用 `<form onSubmit>`：回车与点右侧箭头是**同一条路** ✓。
          */}
        <form
          className="kn-search"
          role="search"
          onSubmit={(event) => { event.preventDefault(); submitSearch(); }}
          onFocus={() => { setSearchFocused(true); }}
          onBlur={(event) => {
            /* 焦点还在搜索块内部（点到候选行、或点输入框）就别收起 ✓ */
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setSearchFocused(false);
          }}
        >
          <div className="kn-search-box">
            <SearchGlyphIcon />
            <input
              className="kn-search-field"
              type="search"
              value={searchQuery}
              aria-label={t("searchPlaceholder")}
              placeholder={t("searchPlaceholder")}
              spellCheck={false}
              aria-expanded={searchOpen}
              aria-controls={SEARCH_LIST_ID}
              aria-activedescendant={searchOpen && searchMatches.length > 0 ? `${SEARCH_LIST_ID}-${searchActive}` : undefined}
              onChange={(event) => { setSearchQuery(event.currentTarget.value); }}
              onKeyDown={(event) => {
                /* ↑↓ 在候选间移动；Esc 收起（清空关键词）。回车交给 form 的 submit ✓ */
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSearchActive((index) => (searchMatches.length === 0 ? 0 : Math.min(searchMatches.length - 1, index + 1)));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSearchActive((index) => Math.max(0, index - 1));
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSearchQuery("");
                }
              }}
            />

            {/*
              * 候选列表：**列出来让用户选** ✓（不再替他挑一个直接飞过去）。
              * `role="listbox"` + 每行 `role="option"`：输入框用 `aria-activedescendant` 指过来，
              * 读屏能念出"当前"是哪一条 ✓。
              *
              * **挂在输入框里面**（不是挂在整块 `.kn-search` 上）：这样浮层左右边界
              * 与输入框**完全等宽** ✓ —— 用户反馈过：挂在外层时它会一直伸到右侧箭头那边、
              * 还盖住状态文字，太长了 ✗。
              */}
            {searchOpen ? (
              <div className="kn-search-list" id={SEARCH_LIST_ID} role="listbox" aria-label={t("searchResults")}>
                {searchMissed ? (
                  <div className="kn-search-empty">{t("searchMiss")}</div>
                ) : searchMatches.map((hit, index) => (
                  <button
                    key={hit.node.id}
                    id={`${SEARCH_LIST_ID}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === searchActive}
                    className={index === searchActive ? "kn-search-item is-active" : "kn-search-item"}
                    /* 悬停即高亮（与键盘高亮同一个状态，避免"看到的是这条、回车飞的是那条"✗） */
                    onMouseEnter={() => { setSearchActive(index); }}
                    /* 按下别把输入框的焦点抢走：抢走会触发 blur ⇒ 候选先被收起来，click 就落空了 ✗ */
                    onMouseDown={(event) => { event.preventDefault(); }}
                    onClick={() => { focusSearchResult(index); }}
                  >
                    <span className="kn-search-item-title">{hit.node.title}</span>
                    {/* 别名命中时把命中的那段别名也显示出来，用户才知道"为什么它会被列出来"✓ */}
                    {hit.via === "alias" ? <span className="kn-search-item-alias">{hit.matched}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            type="submit"
            className="kn-icon-btn"
            aria-label={t("searchGo")}
            title={t("searchGo")}
            disabled={searchQuery.trim() === ""}
          >
            <SubmitArrowIcon />
          </button>
        </form>

      </div>

      {spaceNotice !== null ? <div className="kn-warn kn-warn-inline">{spaceNotice}</div> : null}

      {/*
       * agent 的「提案审阅」区：agent 只能提案（不写库），落地/撤销只能由用户在这里点击。
       * 放在图上方：它是要用户做决定的东西，先看见。
       */}
      <PlanReview
        root={workspacePath}
        reloadToken={payload?.revision ?? 0}
        onChanged={() => { void load({ refresh: true }); }}
        report={(step, detail) => { void reportDiagOnce("plan-review", step, step, detail ?? null); }}
      />

      <div className="kn-graph" data-understanding="true">
        {error !== null ? (
          <div className="kn-msg kn-body">
            <div className="kn-error">{t("failed")} — {error}</div>
            <div className="kn-dim">{t("workspaceHint")}</div>
          </div>
        ) : graph === null ? (
          <div className="kn-msg">{t("loading")}</div>
        ) : (
          <div
            className="graph"
            ref={graphHostRef}
            /*
             * **空白右键的兜底（捕获阶段）**。
             *
             * 为什么必须在容器上做、而且是捕获阶段：当前显示的是**上游的**画布/三维视图，
             * 它自己的右键处理会把事件吃掉 ⇒ 只等上游"愿意派发"时不牢靠
             * （实测：右键毫无反应，而 `kn_status` 里连一条 graph-menu 记录都没有 ✗）。
             *
             * 捕获阶段先于我自己的监听器与上游的冒泡处理执行 ⇒ 先按「空白」打开菜单；
             * 若这次右键其实落在节点/连线上，上游随后派发的节点/连线事件会**覆盖**成对应菜单 ✓。
             *
             * ⚠️ 例外：**编辑器里的右键一律跳过** ✗（见下面那段的判断 ✓）——
             * 编辑器也挂在这块 `.graph` 里 ✓，不排除的话每次右键都会多弹一个"创建节点"菜单 ✗。
             */
            onContextMenuCapture={(event) => {
              /*
               * **笔记编辑器里右键不弹图谱菜单** ✗（用户实测：会和表格菜单叠在一起 ✓——
               * 截图里"这张图 / 创建节点"压在"在左侧插入列 / 本列对齐…"上面 ✓）。
               *
               * 编辑器就挂在这块 `.graph` 里 ✓，而这条监听是**捕获阶段**的 ✓
               * ⇒ 不做判断的话，编辑器里的每一次右键都会开一次"创建节点"菜单 ✗。
               * 提前返回 ⇒ ① 图谱菜单不弹 ✓；② 也**不 `preventDefault`** ✓
               * ⇒ 浏览器/系统的原生右键菜单照旧可用 ✓（不许把用户的右键整体吃掉 ✗）。
               */
              const target = event.target as Element | null;
              if (target !== null && typeof target.closest === "function" && target.closest(".kn-editor") !== null) {
                return;
              }
              requestCanvasMenu(event.clientX, event.clientY);
              event.preventDefault();
            }}
          >
            {/*
             * 空库也要把画布渲染出来：**右键菜单是唯一的建节点入口**，
             * 没有画布就没有可右键的地方——第一颗节点会永远建不出来（实测反馈）。
             * 这里只在画布上方叠一句提示，不放按钮。
             */}
            {graph.nodes.length === 0 ? (
              <div className="kn-msg kn-empty-hint">
                <div>{t("noNodes")}</div>
                <div className="kn-dim">{t("emptyHint")}</div>
              </div>
            ) : null}
            {/*
              * 三维视图**常驻挂载**，可见性只控制显隐 ✓。
              *
              * 原来"不可见就卸载"是拿**WebGL 上下文反复重建**换一点点电 ✗：
              * 每次重挂都会新建一个上下文与画布，浏览器上下文数量到上限就会丢上下文
              * —— 那正是「三维绘制已中断」那一页的来源 ✗。
              * 上游的渲染循环是**按需唤醒**的（静止时不再排帧）⇒ 常驻几乎不耗电 ✓。
              */}
            <div className="kn-graph-stage" data-visible={visible ? "true" : "false"}>
              <ErrorBoundary
                fallback={<div className="kn-msg">{t("spaceFailed")}</div>}
                onError={() => { setSpaceNotice(t("spaceFailed")); }}
              >
                <GraphUniverse
                  /*
                   * **节点集合变化时重建场景**（key 变化 ⇒ React 重新挂载）。
                   * 不这样做的后果：删掉一个节点后，三维引擎里那个网格不会被移除 ⇒
                   * 图上留下一个"幽灵圈"（用户实测 ✗）。只按**节点 id 集合**做 key，
                   * 所以改关系、聚焦等不会触发重建（镜头不会乱跳 ✓）。
                   */
                  /*
                   * key = **库根 + 节点集合**：换库或增删节点时重建场景 ✓。
                   * 为什么要带库根：上游的相机/布局缓存是**模块级全局单例** ✗（跨库共用），
                   * 不带库根就会出现"切到另一个库后沿用上一个库的视角"（位置不对）✓。
                   */
                  key={sceneKey}
                  graph={coloredGraph ?? graph}
                  rootId={payload?.focusId ?? null}
                  focusId={effectiveFocus}
                  labelDensity="smart"
                  command={cameraCommand}
                  relayoutToken={relayoutToken}
                  libraryKey={libraryKey}
                  onEnter={(id: string) => setFocusId(id)}
                />
              </ErrorBoundary>
            </div>
            {/*
             * 右下角的**视角位置图**（用户手绘那张平面图的界面版，两张正交投影）：
             * 球心点 = 固定转动中心、眼睛 = 相机当前位置、淡点 = 走过的路径、↗ 读数 = 真实距离比例 ✓。
             * `sceneKey` 与三维场景同一个 key ⇒ 换库/重建时位置图与历史轨迹一起清空 ✓。
             * 只认自己这块画布广播的事件（`contains` 认领）；`pointer-events: none`，不会吃掉拖动 ✓。
             */}
            <InteriorMinimap
              hostRef={graphHostRef}
              active={visible}
              sceneKey={sceneKey}
            />
            {/*
             * 选中节点信息 + 「编辑笔记」入口（设计稿左上角那条 ✓）。
             *
             * 上游那个 `sr-only` 播报是给读屏用的、**本来不可见** ✗；
             * 这里给用户一条**真正看得见**的信息条（标题 + 状态 + 前置数），
             * 并把正文编辑入口放在它右边 ✓ —— 与右键菜单里的同名入口是同一个动作 ✓。
             */}
            {selectedNode !== null && editingNodeId === null ? (
              <div className="kn-sel">
                <div>
                  <span className="kn-sel-tag">{t("focusNow")}</span>{" "}
                  <span className="kn-sel-title">{selectedNode.title}</span>
                  <div className="kn-sel-sub">
                    {t(selectedNode.status === "done" ? "statusDone" : selectedNode.status === "learning" ? "statusLearning" : "statusTodo")}
                    {selectedNode.prerequisites > 0 ? ` · ${selectedNode.prerequisites} ${t("prerequisites")}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  className="kn-sel-edit"
                  onClick={() => { requestEdit({ kind: "open", nodeId: selectedNode.id }); }}
                >
                  {t("editNote")}
                </button>
              </div>
            ) : null}
            {/*
             * **节点笔记编辑器**（`design/node-note-editor.html` 的"编辑节点对应的文档"那一部分 ✓）。
             * 宽面板并排、窄侧栏覆盖在图谱上（CSS 容器查询 ✓）；关闭后图谱视角原样保留 ✓。
             * `key={editingNodeId}` ⇒ 换节点即重挂 ⇒ 草稿不会串到别的节点 ✗。
             */}
            {editingNodeId !== null ? (
              <NodeDocumentEditor
                key={`${libraryKey}::${editingNodeId}`}
                nodeId={editingNodeId}
                libraryKey={libraryKey}
                graph={graph ?? undefined}
                onRelationsChanged={() => { void load({ refresh: true }); }}
                understood={payload?.understanding?.[editingNodeId] === true}
                onOpenConversation={(sessionId, dirty) => requestEdit({ kind: "conversation", sessionId }, dirty)}
                onUnderstandingSaved={updateUnderstanding}
                target={editingTarget}
                t={props.t}
                saveNonce={editorSaveNonce}
                onDirtyChange={setEditorDirty}
                onSaveOutcome={onEditorSaveOutcome}
                onSaveableChange={setEditorSaveable}
                /*
                 * **前置 / 被依赖列表里点节点 ⇒ 切到那个节点的编辑界面** ✓（用户实测要求 ✓）。
                 * 走的是同一条 `requestEdit` ✓ ⇒ 有未保存改动时先弹三选一 ✗
                 * （不会因为"顺手点了个前置"就把正在写的草稿丢掉 ✓）。
                 */
                onOpenNode={(nodeId) => { requestEdit({ kind: "open", nodeId }); }}
                onClose={(dirty) => { requestEdit({ kind: "close" }, dirty); }}
                onSaved={(document) => {
                  /*
                   * 保存成功：① 身份被"采用"（adopted-* → ULID）⇒ **编辑目标、选择、草稿键一起换** ✓
                   * （复查 P2-4：只换编辑目标会让"选中 ≠ 编辑目标"的 effect 又把旧身份请求回来 ✗，
                   * 旧键也必须删掉，不能"复制后保留" ✗）；
                   * ② 待办（保存并继续）**独立执行** ✓ —— 采用身份时也要真的继续 ✗；
                   * ③ 轻量刷新数据（**不重建布局** ✗ ⇒ 视角与转动中心都不动 ✓）。
                   */
                  const adopted = document.nodeId !== editingNodeId;
                  if (adopted) {
                    forgetDraft(draftKey(libraryKey, editingNodeId));
                    setEditingNodeId(document.nodeId);
                    /* 选择也跟到新身份：否则下面那个"选中驱动编辑"的 effect 会拿旧 id 再打开一次 ✗ */
                    setFocusId(document.nodeId);
                  }
                  const pending = pendingEditRef.current;
                  pendingEditRef.current = null;
                  setLeaveDialog(null);
                  if (pending !== null) {
                    const next = pending.kind === "open"
                      ? (adopted && pending.nodeId === editingNodeId ? document.nodeId : pending.nodeId)
                      : null;
                    /*
                     * 待办落地同样走 `applyEdit` ✓（**编辑目标 + 图谱聚焦一起改** ✗）：
                     * 只改编辑目标的话，下面那条"聚焦变了就切编辑器"的 effect 会拿旧聚焦再请求一次 ✗
                     * —— 就是"点前置抖一下、还停在原来那篇"的同一个坑 ✓。
                     */
                    if (!(adopted && next === document.nodeId)) {
                      if (pending.kind === "conversation") applyEdit(pending);
                      else if (next === null) applyEdit({ kind: "close" });
                      else applyEdit({ kind: "open", nodeId: next });
                    }
                  }
                  void load({ refresh: true });
                }}
                report={editorReport}
              />
            ) : null}
            {/* 未保存时切节点/关闭：三选一（继续编辑 / 放弃修改 / 保存并关闭·保存并切换 ✓） */}
            {leaveDialog !== null && leaveCopy !== null ? (
              <ConfirmDialog
                title={leaveCopy.title}
                message={leaveCopy.message}
                confirmLabel={leaveCopy.confirmLabel}
                cancelLabel={t("leaveStay")}
                extraLabel={t("leaveDiscard")}
                /*
                 * 两个参数**必须分开** ✗（复查 P1-5）：
                 * - `busy` = 正在写盘 ⇒ 三个按钮与 Esc/背景一起冻结（不能"说放弃了却在写" ✗）；
                 * - `confirmDisabled` = 当前存不了（缺指纹 / 载入失败 / 冲突）⇒ **只**禁用"保存并继续"，
                 *   继续编辑、放弃修改、Esc、点背景照常可用 ✓ ——
                 *   否则用户会被弹窗困住，而他要处理的错误恰好在被挡住的编辑器里 ✗。
                 */
                busy={editorSaving}
                confirmDisabled={!editorSaveable}
                onCancel={cancelLeave}
                onExtra={discardLeave}
                onConfirm={saveAndLeave}
              />
            ) : null}
            {/* 右键菜单：节点加前置 / 连线删依赖（上游两种视图都会派发 window 事件） */}
            <GraphContextMenu
              t={t}
              nodes={graph.nodes}
              edges={graph.edges}
              root={target !== undefined && target.kind === "root" ? target.value : undefined}
              sessionId={target !== undefined && target.kind === "session" ? target.value : props.sessionId}
              onChanged={() => { void load({ refresh: true }); }}
              onEditNote={(nodeId) => {
              /*
               * 聚焦不再**提前**改 ✓：`applyEdit` 会在"真正落地"时把编辑目标与聚焦一起改 ✓。
               * 提前改的坏处：弹了三选一又被取消 ⇒ 聚焦已经跑了、编辑器还在原地 ✗
               * ⇒ 那条"聚焦变了就切编辑器"的 effect 立刻再请求一次 ✗（取消也切、再弹一遍 ✓）。
               */
              requestEdit({ kind: "open", nodeId });
            }}
              report={(step, detail) => { void reportDiag("graph-menu", step, detail ?? null); }}
              copy={{
                nodeMenuTitle: t("nodeMenuTitle"),
                editNote: t("editNote"),
                addPrerequisite: t("addPrerequisite"),
                edgeMenuTitle: t("edgeMenuTitle"),
                removeRelation: t("removeRelation"),
                removeNode: t("removeNode"),
                removeNodeConfirmTitle: t("removeNodeConfirmTitle"),
                removeNodeConfirmMessage: t("removeNodeConfirmMessage"),
                removeNodeDone: t("removeNodeDone"),
                promptTitle: t("promptTitle"),
                promptHint: t("promptHint"),
                confirmCreate: t("confirmCreate"),
                cancel: t("cancel"),
                removeConfirmTitle: t("removeConfirmTitle"),
                removeConfirmMessage: t("removeConfirmMessage"),
                candidatesTitle: t("candidatesTitle"),
                candidatesMessage: t("candidatesMessage"),
                reuse: t("reuse"),
                createAnyway: t("createAnyway"),
                failed: t("menuFailed"),
              }}
            />
          </div>
        )}
      </div>
    </ShadowPanel>
  );
}
