/**
 * 二维聚焦视图（DOM 卡片节点 + SVG 只画连线）
 *
 * 这是默认视图：只看当前知识点的一跳关系——上行「依赖它的地方」、下行「它的前置知识」，
 * 当前节点居中。没有当前节点可聚焦时（例如还没有学习目标）退化成平铺，
 * 而不是留一块空画布。
 *
 * 整张图的三维观察由 `GraphUniverse` 负责（原「环视」的同心环投影已按
 * 《空间图谱技术方案》替换掉）：两边的观看状态互相独立，这里只管二维缩放。
 *
 * 与旧版的两处关键区别：
 * 1. 节点是真正的 `<button>` 卡片：可 Tab 聚焦、标题换行而不是被避让算法丢掉，
 *    SVG 只负责画连线；
 * 2. 平面尺寸（`.graph-plane` 的宽高）由布局给出、随内容增长，节点多时画布滚动，
 *    而不是把字号缩小——把字缩小到看不清，等于把图藏起来。
 *
 * 位置全部由依赖层级算出来，不写回工作区。
 *
 * 缩放属于「观看状态」：控件在 GraphCanvas，状态也放在那里，通过可选的 `view` 传进来。
 * 不传时组件自己兜底（内部 state），因此单独渲染它也能用——测试就是这么渲染的。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { STATUS_DISPLAY } from "@/store";
import type { GraphSnapshot } from "@/data/types";
import {
  computeLevels,
  flatLayout,
  focusLayout,
  isIncident,
  type SpaceLayout,
} from "@/graph/levels";
import { MAX_ZOOM, MIN_ZOOM } from "./graphMode";
import { Icon, type IconName } from "./icons";
import {
  CANVAS_CONTEXT_MENU_EVENT,
  EDGE_CONTEXT_MENU_EVENT,
  NODE_CONTEXT_MENU_EVENT,
  type CanvasContextMenuRequest,
  type EdgeContextMenuRequest,
  type NodeContextMenuRequest,
} from "./nodeContextMenu";

/** 容器还没量到尺寸时的兜底视口 */
const FALLBACK_VIEWPORT = { width: 820, height: 430 };
/** 连线在卡片边缘留出的落点：卡片半高 41，再留一点余量 */
const EDGE_INSET_CARD = 43;

export interface GraphView {
  /** 平面缩放（0.6–1.5） */
  zoom: number;
  /** 「适应窗口」算出的缩放回传 */
  onZoomChange?(zoom: number): void;
  /** 「适应窗口」指令：数值变一次，执行一次 */
  fitToken?: number;
}

/** 节点图标：目标用网络、其余用笔记——图标只说明「这是不是当前目标的入口」 */
function iconFor(isRoot: boolean): IconName {
  return isRoot ? "network" : "note";
}

export function GraphSpace({
  graph,
  rootId,
  focusId,
  onEnter,
  selectedEdgeId = null,
  onSelectEdge,
  onDeleteEdge,
  view,
}: {
  graph: GraphSnapshot;
  rootId: string | null;
  /** 当前知识点（选中节点 / 目标根节点） */
  focusId: string | null;
  onEnter(id: string): void;
  /** 当前被选中的关系（连线）；由画布持有，两个视图共用同一个选中 */
  selectedEdgeId?: string | null;
  onSelectEdge?(edgeId: string | null): void;
  /** 键盘断开一条关系（右键菜单之外的第二条路径） */
  onDeleteEdge?(edgeId: string): void;
  view?: GraphView;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const [innerZoom, setInnerZoom] = useState(1);

  const zoom = view?.zoom ?? innerZoom;

  /** 事件与 effect 里要读最新的 view，但又不想因为它每次重建而重跑 */
  const viewRef = useRef(view);
  viewRef.current = view;

  const setZoom = useCallback((next: number) => {
    const current = viewRef.current;
    if (current?.onZoomChange) current.onZoomChange(next);
    else setInnerZoom(next);
  }, []);

  /*
   * 视口尺寸：平面至少和视口一样大，一行的卡片数也由它决定。
   *
   * 两条纪律，都是为了不让「量尺寸」把画布自己推着动起来：
   * 1. 量的盒子（`.graph-scroll`）必须是 `scrollbar-gutter: stable`（见 `src/styles/graph.css`）——
   *    否则滚动条出现/消失会改 `clientWidth`，而平面尺寸又取自 `clientWidth`，
   *    两者互相触发就是一个 60fps 的抖动环路（真机上必现，见 docs/v2-deviations.md 附录四）；
   * 2. 尺寸没变就不写 state：ResizeObserver 会因为无关原因重复回调，
   *    每次 `setViewport` 一个新对象都会让整棵画布重渲染一遍。
   */
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const measure = () => {
      const next = {
        width: Math.max(320, host.clientWidth || FALLBACK_VIEWPORT.width),
        height: Math.max(280, host.clientHeight || FALLBACK_VIEWPORT.height),
      };
      setViewport((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const levels = useMemo(() => computeLevels(graph, rootId), [graph, rootId]);

  const layout: SpaceLayout = useMemo(() => {
    if (graph.nodes.length === 0) {
      return { nodes: [], guides: [], width: viewport.width, height: viewport.height };
    }
    // 聚焦要有一个「当前节点」才成立；没有就退化成平铺，把全部知识点摆出来
    if (focusId) {
      return focusLayout(graph, focusId, viewport.width, viewport.height, focusId);
    }
    return flatLayout(graph.nodes, levels, viewport.width, viewport.height, focusId);
  }, [graph, focusId, levels, viewport.width, viewport.height]);

  const positions = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout.nodes]);

  const prereqCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of graph.edges) counts.set(e.fromId, (counts.get(e.fromId) ?? 0) + 1);
    return counts;
  }, [graph.edges]);

  const drawnEdges = useMemo(() => {
    const relevant = focusId ? graph.edges.filter((e) => isIncident(e, focusId)) : graph.edges;
    // 与当前节点相关的边最后画，压在淡边之上
    return [...relevant].sort(
      (a, b) => Number(isIncident(a, focusId)) - Number(isIncident(b, focusId)),
    );
  }, [graph.edges, focusId]);

  /* --------------------------------- 滚动对位 --------------------------------- */

  /*
   * 平面以 `transform-origin: top center` 缩放，所以平面坐标要按缩放换算成
   * 视觉位置后再去滚：直接把 x/y 当滚动目标，缩放之后就偏了。
   */
  const visualX = useCallback(
    (x: number) => layout.width / 2 + (x - layout.width / 2) * zoom,
    [layout.width, zoom],
  );
  const visualY = useCallback((y: number) => y * zoom, [zoom]);

  const centerOn = useCallback(
    (x: number, y: number) => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollLeft = Math.max(0, visualX(x) - el.clientWidth / 2);
      el.scrollTop = Math.max(0, visualY(y) - el.clientHeight / 2);
    },
    [visualX, visualY],
  );

  // 换当前知识点（或缩放变化）时，始终把当前节点摆在视口中央
  useEffect(() => {
    const focus = layout.nodes.find((n) => n.selected);
    if (focus) centerOn(focus.x, focus.y);
  }, [focusId, centerOn, layout.nodes]);

  // 适应窗口：把整块内容缩放到刚好放得下，再回到内容起点
  const fitToken = view?.fitToken ?? 0;
  useEffect(() => {
    if (!fitToken) return;
    const el = scrollRef.current;
    if (!el) return;
    const next = Math.min(
      MAX_ZOOM,
      Math.max(
        MIN_ZOOM,
        Math.round(Math.min(el.clientWidth / layout.width, el.clientHeight / layout.height, 1) * 100) /
          100,
      ),
    );
    setZoom(next);
    el.scrollTop = 0;
    el.scrollLeft = 0;
    // 只在指令变化时执行一次（setZoom 是稳定引用）
  }, [fitToken, setZoom]);

  /* --------------------------------- 交互 --------------------------------- */

  const openContextMenu = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    // 节点上右键：不要在空白画布的处理器里再开一次菜单
    e.stopPropagation();
    // 画布统一渲染右键菜单：添加前置知识 / 彻底删除
    window.dispatchEvent(
      new CustomEvent<NodeContextMenuRequest>(NODE_CONTEXT_MENU_EVENT, {
        detail: { nodeId: id, x: e.clientX, y: e.clientY },
      }),
    );
  };

  /** 空白处右键：建立知识点的地方（搜索框只负责搜索） */
  const openCanvasMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // 从空白处点空一下就取消关系选中：与「点空白不清空当前节点」不同——
    // 当前节点是正在学习的东西，而选中的那条连线只是「刚才点过」，
    // 留着高亮反而会让人以为它被固定住了。
    onSelectEdge?.(null);
    window.dispatchEvent(
      new CustomEvent<CanvasContextMenuRequest>(CANVAS_CONTEXT_MENU_EVENT, {
        detail: { x: e.clientX, y: e.clientY },
      }),
    );
  };

  /**
   * 关系（连线）上的交互。
   *
   * 三条路径都收在这里，两个视图（二维与三维）的语义因此完全一致：
   * - 左键 = 选中这条关系（高亮，不改当前节点）；
   * - 右键 = 选中 + 请求打开关系菜单（断开）；
   * - 键盘 = Delete/Backspace 直接断开，Enter/Space 在连线中点打开菜单
   *   （命中路径本身可聚焦，键盘用户不必去够鼠标）。
   */
  const edgeEventPoint = (element: Element): { x: number; y: number } => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };

  const openEdgeMenu = (edgeId: string, x: number, y: number) => {
    onSelectEdge?.(edgeId);
    window.dispatchEvent(
      new CustomEvent<EdgeContextMenuRequest>(EDGE_CONTEXT_MENU_EVENT, {
        detail: { edgeId, x, y },
      }),
    );
  };

  const onEdgeContextMenu = (edgeId: string, e: React.MouseEvent) => {
    e.preventDefault();
    // 不要在画布的处理器里再开一次空白菜单
    e.stopPropagation();
    openEdgeMenu(edgeId, e.clientX, e.clientY);
  };

  const onEdgeKeyDown = (edgeId: string, e: React.KeyboardEvent) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      onSelectEdge?.(edgeId);
      onDeleteEdge?.(edgeId);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      const point = edgeEventPoint(e.currentTarget);
      openEdgeMenu(edgeId, point.x, point.y);
    }
  };

  const scrollLabel = focusId
    ? "知识依赖图：聚焦当前知识点的一跳关系"
    : "知识依赖图：全部知识点平铺显示";

  const empty = graph.nodes.length === 0;
  /** 没有当前节点时，平面顶部的说明——画布把全部知识点平铺出来 */

  return (
    <>
      <div
        className="graph-scroll"
        ref={scrollRef}
        role="region"
        aria-label={scrollLabel}
        tabIndex={0}
        onContextMenu={openCanvasMenu}
      >
        <div
          className="graph-plane"
          style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
        >
          <svg
            className="graph-lines"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            /*
             * 这里**不能**再 `aria-hidden`：命中层里有可聚焦的关系按钮，
             * 把焦点元素藏进 aria-hidden 子树是真实的无障碍缺陷。
             * 可见线本身没有可读内容，读屏只会遇到下面那些带 aria-label 的命中层。
             */
            role="group"
            aria-label="知识依赖连线（可选中、右键断开）"
          >
            <defs>
              {/* 两种箭头：与当前节点相关的用强调色，其余用淡色 */}
              {[
                ["base", "var(--edge)"],
                ["active", "var(--accent)"],
              ].map(([id, color]) => (
                <marker
                  key={id}
                  id={`graph-arrow-${id}`}
                  viewBox="0 0 8 8"
                  refX={7}
                  refY={4}
                  markerWidth={5}
                  markerHeight={5}
                  orient="auto"
                >
                  <path d="M 0 0 L 8 4 L 0 8 Z" fill={color} />
                </marker>
              ))}
            </defs>

            {/*
              连线从卡片边缘进出（而不是从卡片中心），箭头才不会被卡片压住。
              每条边是一个 `<g>`：可见线在上、**透明的命中层**在后，
              命中层让「一条 1px 的线」有 12px 的可点区域（`pointer-events: stroke`）。
              可聚焦只在有当前知识点的聚焦视图里开——平铺全图时几百条边
              每个都进 Tab 序列，键盘用户得按几百下才能走到别处。
            */}
            {drawnEdges.map((e) => {
              const from = positions.get(e.fromId);
              const to = positions.get(e.toId);
              if (!from || !to) return null;
              const active = isIncident(e, focusId);
              const downward = to.y >= from.y;
              const startY = from.y + (downward ? EDGE_INSET_CARD : -EDGE_INSET_CARD);
              const endY = to.y + (downward ? -EDGE_INSET_CARD - 2 : EDGE_INSET_CARD + 2);
              const midY = (startY + endY) / 2;
              const path = `M${from.x},${startY} C${from.x},${midY} ${to.x},${midY} ${to.x},${endY}`;
              const selected = e.id === selectedEdgeId;
              const titleOf = (id: string) =>
                graph.nodes.find((n) => n.id === id)?.title ?? "未知知识点";
              const keyboard = focusId !== null;
              return (
                <g
                  key={e.id}
                  className="graph-edge"
                  data-edge-id={e.id}
                  data-selected={selected ? "true" : undefined}
                >
                  <path
                    className="graph-edge-line"
                    d={path}
                    fill="none"
                    stroke={active ? "var(--accent)" : "var(--edge)"}
                    strokeWidth={active ? 1.6 : 1}
                    opacity={active ? 0.9 : 0.5}
                    markerEnd={`url(#graph-arrow-${active ? "active" : "base"})`}
                  />
                  {/* 命中层：透明但可拾取；不画箭头，可见线才是唯一被看见的东西 */}
                  <path
                    className="graph-edge-hit"
                    d={path}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={12}
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="stroke"
                    role={keyboard ? "button" : undefined}
                    tabIndex={keyboard ? 0 : undefined}
                    aria-label={
                      keyboard
                        ? `${titleOf(e.fromId)} 依赖的前置知识 ${titleOf(e.toId)}，右键或按 Delete 断开`
                        : undefined
                    }
                    onClick={() => onSelectEdge?.(e.id)}
                    onContextMenu={(ev) => onEdgeContextMenu(e.id, ev)}
                    onKeyDown={keyboard ? (ev) => onEdgeKeyDown(e.id, ev) : undefined}
                  >
                    <title>{`${titleOf(e.fromId)} → 前置 ${titleOf(e.toId)}：右键断开`}</title>
                  </path>
                </g>
              );
            })}
          </svg>

          {/* 行/组的标注：聚焦的上下两组组名 */}
          {layout.guides.map((g) => (
            <span key={g.key} className="graph-label" style={{ top: g.y }}>
              {g.label}
            </span>
          ))}

          {/*
            没有当前节点时的说明**不在这里**：画布左上角已经有一条
            「全部知识点 · 平铺显示」，页脚还会说一遍现在在看什么。
            再多一条浮在画布上的说明就是第三次重复，而且它会压在节点卡片上。
          */}

          {layout.nodes.map((n) => {
            const prereqCount = prereqCounts.get(n.id) ?? 0;
            const isRoot = n.id === rootId;
            const status = STATUS_DISPLAY[n.status];
            return (
              <button
                key={n.id}
                type="button"
                className={`graph-node${n.selected ? " selected" : ""}${isRoot ? " root" : ""}`}
                data-node-id={n.id}
                style={{ left: n.x, top: n.y }}
                aria-label={`${n.title}，${status.label}，${prereqCount} 个前置`}
                aria-pressed={n.selected}
                onClick={() => onEnter(n.id)}
                onContextMenu={(e) => openContextMenu(n.id, e)}
              >
                <span className="graph-node-title">
                  <span className="graph-node-icon">
                    <Icon name={iconFor(isRoot)} />
                  </span>
                  <span>{n.title}</span>
                </span>
                <span className="graph-node-bottom">
                  {/*
                    状态是「小圆点 + 文字」，不是彩色胶囊：胶囊一多，界面上就没有主次——
                    使用者得逐字读才知道哪个是导航、哪个是状态。
                  */}
                  <span className={`graph-node-status ${status.cls}`}>
                    <span className={`status-dot ${status.cls}`} aria-hidden="true" />
                    {status.label}
                  </span>
                  <span className="graph-node-info">
                    {prereqCount > 0 ? `${prereqCount} 个前置` : "没有前置知识"}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 空库：画布没有东西可摆时说明下一步做什么——右键就是那个入口 */}
      {empty && (
        <div className="graph-empty">
          <span className="empty-mark">
            <Icon name="network" />
          </span>
          <h3>知识库还是空的</h3>
          <p>在这张画布上点右键，写下第一个知识点；它会和后来的节点一样，只是建立得早一些。</p>
        </div>
      )}
    </>
  );
}
