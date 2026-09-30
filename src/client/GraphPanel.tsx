/**
 * 常驻的知识库面板（中央 `main` 面板 + 左侧栏图标）。
 *
 * 数据来自宿主注册的 Fetch 路由（`api/knowledgenet.graph`），与工具结果**同一份构造逻辑**：
 * 面板看到的图与模型看到的 JSON 不会说两套话。
 *
 * 两个视图：
 * - **聚焦**：`GraphSpace`（二维，DOM 卡片 + SVG 连线）；
 * - **空间**：`GraphUniverse`（三维，three.js + Worker 力导向布局；Worker 源码由构建期内联为 Blob）。
 *
 * 三维视图套了错误边界：WebGL/Worker 出问题时退回二维并给一条可读提示，
 * 而不是把整个面板从槽位里摘掉。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { GraphSnapshot } from "../vendor/upstream/data/types.ts";
import { GraphUniverse } from "../vendor/upstream/components/GraphUniverse.tsx";
import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import { makeTranslator } from "./card-model.ts";
import { GraphContextMenu, requestCanvasMenu } from "./GraphContextMenu.tsx";
import { reportDiag, reportDiagOnce } from "./diag.ts";
import { rememberFocusNode } from "./ChatSelectionBar.tsx";
import { rememberSessionId } from "./chat-selection.ts";
import { LIBRARY_CHANGED_EVENT, clearCurrentContext, publishCurrentContext } from "./current-context.ts";
import { PlanReview } from "./PlanReview.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { RefreshRingIcon, RelayoutTreeIcon } from "./PanelIcon.tsx";
import { ShadowPanel } from "./shadow.tsx";
import { pickWorkspacePath, resolvePanelTarget } from "./workspace-path.ts";

interface PanelPayload {
  ok?: boolean;
  library?: { root?: string; name?: string; formatVersion?: number };
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

const LITERAL: Record<string, string> = {
  focus: "聚焦",
  space: "空间",
  refresh: "刷新",
  refreshHint: "重新从磁盘读取知识库（绕过宿主的库缓存）",
  relayout: "重新整理",
  relayoutHint: "重排布局，并把旋转中心复位到整张图",
  loading: "正在解析当前工作区…",
  failed: "读取知识库失败",
  noNodes: "这个知识库里还没有知识点。",
  emptyHint: "在空白处右键即可新建节点",


  counts: "节点 {n} · 依赖 {e}",
  truncated: "（已截断显示）",
  spaceFailed: "三维视图不可用，已回到二维聚焦。",
  workspaceHint: "面板跟随当前工作区：把这个知识库目录作为工作区打开，这里就会直接显示它。",
  nodeMenuTitle: "这个知识点",
  addPrerequisite: "添加前置节点…",
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
  return (
    <ErrorBoundary
      fallback={
        <div className="kn-msg">
          面板渲染出错：请刷新页面；若持续出现，请把控制台里的报错发给我。
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
  /** 相机命令（新节点建好后发 fitAll，把所有节点收进视野 ✓） */
  const [cameraCommand, setCameraCommand] = useState<{ seq: number; type: "fitAll"; source: "toolbar" } | null>(null);
  const fitSeqRef = useRef(0);
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

  const effectiveFocus = focusId ?? payload?.focusId ?? null;
  const nodeCount = payload?.counts?.nodes ?? graph?.nodes.length ?? 0;
  const edgeCount = payload?.counts?.edges ?? graph?.edges.length ?? 0;

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
      <div className="kn-head kn-head-panel">
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
             * 两件事一起做（用户要求 2026-09）：
             *  ① `relayoutToken` +1 ⇒ 丢掉缓存的坐标、从确定性初始分布重排一轮；
             *  ② 发一条 `fitAll` ⇒ **把旋转中心初始化**（回到整张图的包围盒中心）✓
             *     —— 之前上游只重排布局、相机原地不动，聚焦过节点的话环绕中心就一直钉在那个节点上 ✗。
             * 注意：只复位"中心与距离"，**不动用户当前的旋转姿态**（角度/俯仰/自由四元数由使用者决定）✓。
             */
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

      <div className="kn-graph">
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
             */
            onContextMenuCapture={(event) => {
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
            {/* 不可见时不渲染三维：连 requestAnimationFrame 一起停（收起侧栏也能覆盖） */}
            {visible ? null : <div className="kn-msg">{t("loading")}</div>}
            {visible ? (<ErrorBoundary
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
                key={`${payload?.library?.root ?? ""}#${graph.nodes.map((node) => node.id).sort().join(",")}`}
                graph={graph}
                rootId={payload?.focusId ?? null}
                focusId={effectiveFocus}
                labelDensity="smart"
                command={cameraCommand}
                relayoutToken={relayoutToken}
                onEnter={(id: string) => setFocusId(id)}
                onFallback={() => { setSpaceNotice(t("spaceFailed")); }}
              />
            </ErrorBoundary>) : null}
            {/* 右键菜单：节点加前置 / 连线删依赖（上游两种视图都会派发 window 事件） */}
            <GraphContextMenu
              nodes={graph.nodes}
              edges={graph.edges}
              root={target !== undefined && target.kind === "root" ? target.value : undefined}
              sessionId={target !== undefined && target.kind === "session" ? target.value : props.sessionId}
              onChanged={() => { void load({ refresh: true }); }}
              report={(step, detail) => { void reportDiag("graph-menu", step, detail ?? null); }}
              copy={{
                nodeMenuTitle: t("nodeMenuTitle"),
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
