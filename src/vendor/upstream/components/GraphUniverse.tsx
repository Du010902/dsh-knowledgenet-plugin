/**
 * 三维空间视图（环绕观察）
 *
 * 它是「环视」的替代者：真实三维坐标、透视相机，围着整张图拖动观察。
 * React 这一层只做四件事：
 * 1. 挂载画布与标签层，创建 / 销毁运行时（SpaceEngine）；
 * 2. 把业务状态（工作区、当前节点、相机命令）翻译成引擎调用；
 * 3. 渲染浮层：布局状态、操作提示、悬停信息、视野外提示与降级说明；
 * 4. 把画布上的选择与右键交回现有业务入口（enterNode / 节点右键菜单事件）。
 *
 * 每帧变化的东西（坐标、标签位置、相机）完全不进 React 状态：
 * 逐帧 setState 是这类视图最典型的性能陷阱。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { GraphSnapshot } from "@/data/types";
import { canRenderSpace, SpaceEngine, type EdgeHoverInfo, type HoverInfo } from "@/graph3d/engine";
import type { LayoutStatusDetail } from "@/graph3d/layoutClient";
import type { CameraCommand, LabelDensity, LayoutStatus } from "@/graph3d/types";
import { STATUS_DISPLAY } from "@/store";
import { Icon } from "./icons";
import {
  CANVAS_CONTEXT_MENU_EVENT,
  EDGE_CONTEXT_MENU_EVENT,
  NODE_CONTEXT_MENU_EVENT,
  type CanvasContextMenuRequest,
  type EdgeContextMenuRequest,
  type NodeContextMenuRequest,
} from "./nodeContextMenu";

export interface GraphUniverseProps {
  graph: GraphSnapshot;
  rootId: string | null;
  /** 当前知识点（选中节点 / 目标根节点） */
  focusId: string | null;
  labelDensity: LabelDensity;
  /** 工具栏发出的相机命令：seq 变化即执行一次 */
  command: CameraCommand | null;
  /** 「重新整理布局」指令：数值变一次执行一次（不是相机命令，相机保持不动） */
  relayoutToken: number;
  onEnter(id: string): void;
  /** 被选中的关系（连线）；与二维聚焦共用画布那一份选中状态 */
  selectedEdgeId?: string | null;
  onSelectEdge?(edgeId: string | null): void;
  /** WebGL 2 不可用或上下文丢失：外层据此回退到二维聚焦 */
  onFallback(): void;
}

/** 布局状态对应的文案：结束原因不同，说法也不同 */
function layoutStatusText(status: LayoutStatus, detail: LayoutStatusDetail): string {
  if (status === "forming") return "正在形成知识空间…";
  if (status === "settling") return `关系正在舒展 · 第 ${Math.max(0, detail.iterations)} 步`;
  if (status === "unavailable") return "布局计算不可用 · 使用当前分布";
  if (detail.reason === "reused") return "沿用上次布局结果 · 可自由探索";
  if (detail.reason === "budget") return "布局已停止（达到迭代上限）· 可自由探索";
  if (detail.reason === "cancelled") return "布局已暂停 · 可自由探索";
  if (detail.reason === "error") return "布局异常 · 已沿用上一份有效坐标";
  return "布局已稳定 · 可自由探索";
}

export function GraphUniverse({
  graph,
  rootId,
  focusId,
  labelDensity,
  command,
  relayoutToken,
  onEnter,
  selectedEdgeId = null,
  onSelectEdge,
  onFallback,
}: GraphUniverseProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<SpaceEngine | null>(null);
  /** 引擎按索引回调，React 按 ID 回调：这里保存当前稳定顺序做一次翻译 */
  const idsRef = useRef<string[]>([]);

  /** 引擎回调要读最新 props，但不希望它们的变化重建引擎 */
  const propsRef = useRef({ graph, rootId, focusId, onEnter, onSelectEdge });
  propsRef.current = { graph, rootId, focusId, onEnter, onSelectEdge };

  const [status, setStatus] = useState<{ status: LayoutStatus; detail: LayoutStatusDetail }>({
    status: "forming",
    detail: { iterations: 0 },
  });
  const [hover, setHover] = useState<HoverInfo | null>(null);
  /** 悬停到一条关系：与节点悬停互斥（命中只有一个目标） */
  const [edgeHover, setEdgeHover] = useState<EdgeHoverInfo | null>(null);
  const [offstage, setOffstage] = useState(false);
  /** WebGL 2 不支持（webgl2）/ 运行时上下文丢失（lost）/ 初始化异常 */
  const [failure, setFailure] = useState<string | null>(() => (canRenderSpace() ? null : "webgl2"));
  /** 重试时递增：换一块全新 canvas，避免复用已经丢失的上下文 */
  const [generation, setGeneration] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const announcedRef = useRef<string | null>(null);
  const commandSeq = useRef(0);
  /**
   * 已经执行过的命令序号。
   *
   * 用「序号」而不是「有没有命令」来判断：组件重新挂载时 effect 会再跑一遍，
   * 若把当前这条命令当成新命令，切回空间视图的瞬间就会被上一条定位/取景命令
   * 拉走镜头——那正是「切换视图要恢复相机」的反面。
   */
  const executedSeq = useRef(command?.seq ?? 0);

  /** 引擎内部触发的定位（F / 双击 / 视野外提示）：seq 递增，重复定位同一节点也生效 */
  const issueLocate = useCallback((source: CameraCommand["source"]) => {
    const engine = engineRef.current;
    if (!engine) return;
    commandSeq.current += 1;
    const target = propsRef.current.focusId;
    engine.runCommand(
      {
        seq: commandSeq.current,
        type: "focusNode",
        nodeId: target ?? undefined,
        source,
      },
      target,
    );
  }, []);

  const syncGraph = useCallback((engine: SpaceEngine) => {
    const current = propsRef.current;
    engine.syncGraph(current.graph, current.rootId, current.focusId);
  }, []);

  /* --------------------------- 运行时：创建与销毁 --------------------------- */

  useEffect(() => {
    if (failure) return;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const labelLayer = labelLayerRef.current;
    if (!host || !canvas || !labelLayer) return;

    let engine: SpaceEngine;
    try {
      engine = new SpaceEngine({
        host,
        canvas,
        labelLayer,
        onStatus: (next, detail) => setStatus({ status: next, detail }),
        onHover: (info) => setHover(info),
        onEdgeHover: (info) => setEdgeHover(info),
        onSelect: (index) => {
          // 单击只选择：走的正是画布与左侧列表共用的业务入口
          if (index === null) return;
          const id = idsRef.current[index];
          if (id) propsRef.current.onEnter(id);
        },
        onSelectEdge: (id) => {
          // 单击一条关系只选中它，不改当前节点
          propsRef.current.onSelectEdge?.(id);
        },
        onContextMenu: (hit, clientX, clientY) => {
          /*
           * 右键分三种：节点上问「拿这个节点怎么办」，**关系上问「这条依赖还要不要」**，
           * 空白处问「在这张网上再放一个点」。相机在引擎里已经把这些手势排除在外，
           * 这里只负责把请求转给画布。
           */
          if (hit.kind === "node") {
            const id = idsRef.current[hit.index];
            if (!id) return;
            window.dispatchEvent(
              new CustomEvent<NodeContextMenuRequest>(NODE_CONTEXT_MENU_EVENT, {
                detail: { nodeId: id, x: clientX, y: clientY },
              }),
            );
            return;
          }
          if (hit.kind === "edge") {
            const id = propsRef.current.graph.edges[hit.index]?.id;
            if (!id) return;
            window.dispatchEvent(
              new CustomEvent<EdgeContextMenuRequest>(EDGE_CONTEXT_MENU_EVENT, {
                detail: { edgeId: id, x: clientX, y: clientY },
              }),
            );
            return;
          }
          window.dispatchEvent(
            new CustomEvent<CanvasContextMenuRequest>(CANVAS_CONTEXT_MENU_EVENT, {
              detail: { x: clientX, y: clientY },
            }),
          );
        },
        onLocateRequest: () => issueLocate("keyboard"),
        onSelectedOffscreen: (value) => setOffstage(value),
        onContextLost: () => setFailure("lost"),
      });
    } catch (error) {
      console.error("[KnowledgeNet] 三维视图初始化失败", error);
      setFailure(error instanceof Error ? error.message : "init");
      return;
    }

    engineRef.current = engine;
    syncGraph(engine);
    engine.setLabelDensity(labelDensity);
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
    // 只在挂载与「重试」时重建：图数据、焦点与相机命令走各自的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, failure, syncGraph, issueLocate]);

  useEffect(() => {
    // 稳定 ID 顺序与布局一致：引擎返回索引，这里翻回业务 ID
    idsRef.current = [...graph.nodes.map((node) => node.id)].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
  }, [graph.nodes]);

  /* ------------------------------ 图数据与焦点 ------------------------------ */

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    syncGraph(engine);
  }, [graph, rootId, syncGraph]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setFocus(focusId);
    // 只播报选中变化：相机与坐标不逐帧播报
    if (focusId && announcedRef.current !== focusId) {
      announcedRef.current = focusId;
      const node = graph.nodes.find((item) => item.id === focusId);
      if (node) {
        const prerequisites = graph.edges.filter((edge) => edge.fromId === node.id).length;
        setAnnouncement(
          `已选中 ${node.title}，${STATUS_DISPLAY[node.status].label}，${prerequisites} 个前置知识`,
        );
      }
    }
  }, [focusId, graph]);

  useEffect(() => {
    engineRef.current?.setLabelDensity(labelDensity);
  }, [labelDensity]);

  /*
   * 被选中的关系由画布持有（两个视图共用同一份）：这里只把它转给引擎。
   * 两个方向都会走：用户在这里点了一条线 → 回调上去 → 画布更新 → 这里再下来，
   * 引擎因此不会出现「自己以为自己选中了哪条」的第二份真相。
   */
  useEffect(() => {
    engineRef.current?.setSelectedEdge(selectedEdgeId);
  }, [selectedEdgeId]);

  /**
   * 已经处理过的「重新整理」指令。
   *
   * 与相机命令同样的道理：effect 在挂载（含 StrictMode 的双次执行）时也会跑一遍，
   * 若把当前 token 当成新指令，进视图的瞬间就会丢掉缓存重算一轮。
   * 用「记住上次处理到哪个 token」来判定，而不是「是不是第一次执行 effect」。
   */
  const handledRelayout = useRef(relayoutToken);
  useEffect(() => {
    if (relayoutToken === handledRelayout.current) return;
    handledRelayout.current = relayoutToken;
    engineRef.current?.relayout();
  }, [relayoutToken]);

  useEffect(() => {
    if (!command || command.seq === executedSeq.current) return;
    executedSeq.current = command.seq;
    /*
     * 只依赖命令本身：把它挂在 focusId 上会让「随便点一个节点」也重新执行上一条命令，
     * 于是一次普通单击就把镜头飞走了——选择与相机定位必须互不冒充。
     * 目标从 propsRef 取，命令自带的 nodeId 优先（见 engine.runCommand）。
     */
    engineRef.current?.runCommand(command, propsRef.current.focusId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  /* --------------------------------- 渲染 --------------------------------- */

  if (failure) {
    const lost = failure !== "webgl2";
    return (
      <div className="universe">
        <div className="universe-fallback">
          <span className="empty-mark">
            <Icon name={lost ? "alert" : "info"} />
          </span>
          <h3>{lost ? "三维绘制已中断" : "当前环境未能启动 WebGL 2"}</h3>
          <p>
            {lost
              ? "图形上下文已经停止。可以重试一次；如果仍然失败，请回到二维聚焦继续使用。"
              : "三维空间视图需要 WebGL 2。回到二维聚焦同样能完成定位与关系核对，那里没有这个限制。"}
          </p>
          <div className="universe-fallback-actions">
            {lost && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setFailure(null);
                  setGeneration((value) => value + 1);
                }}
              >
                <Icon name="sparkles" />
                重试
              </button>
            )}
            <button type="button" className="btn primary" onClick={onFallback}>
              <Icon name="focus" />
              回到二维聚焦
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="universe"
      ref={hostRef}
      role="region"
      tabIndex={0}
      aria-label="三维知识图：拖动旋转、滚轮靠近远离、Shift 加左键拖动平移；右侧列表、详情与工具栏同样可以定位节点"
    >
      <canvas className="universe-canvas" key={generation} ref={canvasRef} aria-hidden="true" />
      <div className="universe-labels" ref={labelLayerRef} aria-hidden="true" />

      <div className="universe-status" role="status">
        <span className="statuslight" aria-hidden="true" />
        {layoutStatusText(status.status, status.detail)}
      </div>

      {offstage && (
        <button type="button" className="universe-offstage" onClick={() => issueLocate("toolbar")}>
          <Icon name="focus" />
          选中节点在视野外 · 按 F 返回
        </button>
      )}

      {hover && (
        <div
          className="universe-tooltip"
          style={{
            left: Math.min(
              Math.max(hover.x + 14, 10),
              Math.max(10, (hostRef.current?.clientWidth ?? 800) - 240),
            ),
            top: Math.max(hover.y + 16, 34),
          }}
        >
          {/* 与参考图的 .space-tooltip 同构：标题一行，状态与关系数一行 */}
          <strong>{hover.title}</strong>
          <span>
            {STATUS_DISPLAY[hover.status].label} · {hover.degree} 条直接关系
          </span>
        </div>
      )}

      {/*
        关系悬停：告诉使用者「这条线连着哪两个知识点」，并说清它可以断开。
        没有这条反馈的话，鼠标划过 1px 的线除了变亮之外没有任何解释，
        「右键能断开」就无从被发现。
      */}
      {edgeHover && (
        <div
          className="universe-tooltip is-edge"
          data-edge-tooltip={edgeHover.id}
          style={{
            left: Math.min(
              Math.max(edgeHover.x + 14, 10),
              Math.max(10, (hostRef.current?.clientWidth ?? 800) - 240),
            ),
            top: Math.max(edgeHover.y + 16, 34),
          }}
        >
          <strong>
            {edgeHover.from} → 前置 {edgeHover.to}
          </strong>
          <span>右键断开这条前置关系</span>
        </div>
      )}

      {/* 提示语与参考图的 .graph-help 一致：选择与定位是两件事，两句都要说 */}
      <div className="universe-hint">
        拖动旋转 · 滚轮靠近 · 单击选择节点或关系 · 右键连线可断开 · 双击或 F 定位选中节点
      </div>

      {/* 选中变化的播报：只播报选中，不播报相机与坐标 */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
