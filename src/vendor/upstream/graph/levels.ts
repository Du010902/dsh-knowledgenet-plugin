/**
 * 依赖层级与二维聚焦的几何计算（纯函数，无 DOM）
 *
 * 约定不变：边 `A → B` 表示「为了理解 A，需要先理解 B」。
 *
 * 层级 = 从**学习目标**沿「依赖 → 前置」方向走的距离：
 *   0 层是目标本身，1 层是它的直接前置知识，2 层是前置的前置……
 * 多父节点取最短距离（BFS 天然如此），有环也能收敛——
 * 这正是它比「按树组织」更耐用的地方：知识依赖本来就是网。
 *
 * 这里只剩两种摆法：
 *   - focus：只留一跳，上行「依赖它的」、下行「它的前置知识」
 *   - flat ：没有当前节点可聚焦时的平铺兜底（按层分组，不写层名）
 *
 * 原先还有第三种「环视」（每层一个同心环 + 纵轴旋转投影 + 伪深度）。
 * 它已被真正的三维空间视图取代：投影布局没有三维相机，深度遮挡、拾取与近裁剪
 * 都得自行实现，因此相关几何（投影、环形路径、拖动角度换算）整体移除，
 * 而不是留在这里当死代码。
 *
 * 位置是**算出来的**，不写进节点数据：换个学习目标，同一张图的层级自然不同。
 *
 * 画布节点是一张 166×82 的卡片，所以尺寸也在这里算：一行放得下几张卡由列宽决定，
 * 放不下就换行、平面往下长——画布滚动，而不是把卡片缩小。
 */
import type { DependencyEdge, GraphSnapshot, KnowledgeNode, LearnStatus } from "@/data/types";

/* ---------------------------------- 层级 ---------------------------------- */

export interface LevelMap {
  /** 节点 id → 层号；null 表示与当前目标没有依赖通路 */
  level: Map<string, number | null>;
  maxLevel: number;
  /** 与目标没有通路的节点，单独成组显示，不混进层级里 */
  unreachable: string[];
}

/**
 * 以 rootId 为起点计算层级。没有目标（或目标不存在）时所有节点都算「无通路」，
 * 这时视图会退化成一张平铺列表——比假装有层级诚实。
 */
export function computeLevels(ws: GraphSnapshot, rootId: string | null): LevelMap {
  const ids = new Set(ws.nodes.map((n) => n.id));
  const level = new Map<string, number | null>();
  for (const id of ids) level.set(id, null);

  if (!rootId || !ids.has(rootId)) {
    return { level, maxLevel: 0, unreachable: ws.nodes.map((n) => n.id) };
  }

  // A → B：A 依赖 B，所以从 A 出发能到 B（B 更深一层）
  const dependsOn = new Map<string, string[]>();
  for (const e of ws.edges) {
    if (!ids.has(e.fromId) || !ids.has(e.toId)) continue;
    const list = dependsOn.get(e.fromId);
    if (list) list.push(e.toId);
    else dependsOn.set(e.fromId, [e.toId]);
  }

  let maxLevel = 0;
  const queue: string[] = [rootId];
  level.set(rootId, 0);
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    const curLevel = level.get(cur) as number;
    for (const next of dependsOn.get(cur) ?? []) {
      // 已经访问过就跳过：BFS 先到的一定是最短距离，环也在这里被截断
      if (level.get(next) !== null) continue;
      level.set(next, curLevel + 1);
      maxLevel = Math.max(maxLevel, curLevel + 1);
      queue.push(next);
    }
  }

  const unreachable: string[] = [];
  for (const n of ws.nodes) if (level.get(n.id) === null) unreachable.push(n.id);
  return { level, maxLevel, unreachable };
}

/* --------------------------------- 布局基元 --------------------------------- */

export interface SpaceNode {
  id: string;
  title: string;
  status: LearnStatus;
  x: number;
  y: number;
  /** 层号；null = 与目标无通路 */
  level: number | null;
  selected: boolean;
}

export interface SpaceLayout {
  nodes: SpaceNode[];
  /**
   * 画布上的分组标注（聚焦视图写「依赖它的地方 / 当前知识点 / 它的前置知识」）。
   * 没有分组语义的布局返回空数组，而不是编一个标题出来。
   */
  guides: Array<{ key: string; label: string; y: number }>;
  /**
   * 画布平面的内容尺寸（一定 ≥ 传进来的视口尺寸）。
   *
   * 平面自己长大、`.graph-scroll` 滚动，是「节点多也不缩小字号」的实现方式；
   * 视口尺寸仍然参与计算，所以窗口变宽时一行的卡片会变多。
   */
  width: number;
  height: number;
}

/** 卡片宽 166（选中 184），列距取 194：相邻两张卡仍有间隙，选中也不会贴在一起 */
export const NODE_COLUMN = 194;
/** 卡片高 82，行距取 146：跨行连线有地方走，标签也不会压在卡片上 */
export const NODE_ROW = 146;

/** 卡片的一半尺寸：位置给的是卡片中心，算边距与连线落点时要用 */
export const CARD_HALF_W = 83;
export const CARD_HALF_H = 41;

/** 第一列/最后一列离平面边缘的距离（含选中光晕） */
const MARGIN_X = CARD_HALF_W + 24;
/** 平面至少要能放下一张卡 */
const MIN_PLANE_WIDTH = MARGIN_X * 2 + NODE_COLUMN;
const PAD_TOP = 46;
/**
 * 平面底部留白。
 *
 * 比顶部大得多，是因为左下角的缩放控件与右下角的图例浮在画布上：
 * 留白不够时，最后一行卡片会压在这两处控件下面，看起来像被裁掉了。
 * 这里给的是「控件高度 + 它的下边距」。
 */
const PAD_BOTTOM = 76;

function toSpaceNode(
  node: KnowledgeNode,
  level: number | null,
  x: number,
  y: number,
  selectedId: string | null,
): SpaceNode {
  return {
    id: node.id,
    title: node.title,
    status: node.status,
    x,
    y,
    level,
    selected: node.id === selectedId,
  };
}

/** 一行放得下几张卡。宽度不够就只放一张，平面随之变宽，卡片绝不被裁掉 */
function columnsFor(width: number): number {
  const usable = Math.max(NODE_COLUMN, width - MARGIN_X * 2);
  return Math.max(1, Math.floor(usable / NODE_COLUMN));
}

/**
 * 第 index 张卡在行内的横坐标。
 *
 * 满行均分平面宽度；最后一行不满时也铺满——收尾那一行若挤在左边，
 * 看起来像被截断了半行。
 */
function spreadX(width: number, columns: number, index: number, count: number): number {
  const row = Math.floor(index / columns);
  const size = Math.min(columns, count - row * columns);
  const usable = width - MARGIN_X * 2;
  return MARGIN_X + (usable * ((index % columns) + 0.5)) / Math.max(1, size);
}

/** 把节点按层分组，层号升序；无通路的节点单独一组放最后 */
function groupByLevel(
  nodes: KnowledgeNode[],
  levels: LevelMap,
): Array<{ level: number | null; nodes: KnowledgeNode[] }> {
  const groups = new Map<number | null, KnowledgeNode[]>();
  for (const n of nodes) {
    const lv = levels.level.get(n.id) ?? null;
    const list = groups.get(lv);
    if (list) list.push(n);
    else groups.set(lv, [n]);
  }
  return [...groups.entries()]
    .sort((a, b) => {
      if (a[0] === null) return 1; // 无通路的放最后
      if (b[0] === null) return -1;
      return a[0] - b[0];
    })
    .map(([level, list]) => ({ level, nodes: list }));
}

/* ------------------------- 无当前节点时的平铺兜底 ------------------------- */

/**
 * 平铺兜底：按层分组把卡片摆成网格，但不写任何层名。
 *
 * 这是「没有当前知识点可聚焦」时的退路——聚焦视图需要有一个中心节点才成立，
 * 没有学习目标（因此也没有根节点）时用它把全部知识点摆出来，而不是给一块空画布。
 *
 * 分组而不是「按顺序填格子」：后者在行末会把下一层的第一张卡提到上一行，
 * 于是「层号小的在上面」这条不变量就没了（图不再可读）。分层换行则保证
 * 层与层不混行，同时又不声称自己在讲层级——没有行首层名，那种视图已按要求移除。
 */
export function flatLayout(
  nodes: KnowledgeNode[],
  levels: LevelMap,
  viewportWidth: number,
  viewportHeight: number,
  selectedId: string | null,
): SpaceLayout {
  const width = Math.max(viewportWidth, MIN_PLANE_WIDTH);
  if (nodes.length === 0) {
    return { nodes: [], guides: [], width, height: viewportHeight };
  }

  const groups = groupByLevel(nodes, levels);
  const columns = columnsFor(width);
  /** 每组占几行：与分层布局同一套换算，行距不足 NODE_ROW 时平面会长高 */
  const rowsOf = (count: number) => Math.max(1, Math.ceil(count / columns));
  const totalRows = groups.reduce((sum, g) => sum + rowsOf(g.nodes.length), 0);
  const height = Math.max(
    viewportHeight,
    PAD_TOP + PAD_BOTTOM + CARD_HALF_H * 2 + totalRows * NODE_ROW,
  );
  const rowHeight = (height - PAD_TOP - PAD_BOTTOM - CARD_HALF_H * 2) / totalRows;

  const placed: SpaceNode[] = [];
  let rowOffset = 0;
  for (const group of groups) {
    group.nodes.forEach((n, i) => {
      const row = rowOffset + Math.floor(i / columns);
      const inRow = Math.min(columns, group.nodes.length - Math.floor(i / columns) * columns);
      const x = spreadX(width, columns, i, inRow);
      const y = PAD_TOP + rowHeight * (row + 0.5);
      placed.push(toSpaceNode(n, group.level, x, y, selectedId));
    });
    rowOffset += rowsOf(group.nodes.length);
  }

  return { nodes: placed, guides: [], width, height };
}

/* ------------------------------- 聚焦视图（一跳） ------------------------------ */

export interface FocusLayout extends SpaceLayout {
  /** 依赖当前知识点的节点（A → focus） */
  dependents: KnowledgeNode[];
  /** 当前知识点的前置知识（focus → B） */
  prerequisites: KnowledgeNode[];
}

/**
 * 一跳聚焦：上行放「依赖它的地方」，下行放「它的前置知识」，当前节点居中。
 *
 * 两种关系在语义上正好相反，早先混在同一圈里是「复杂图看不清」的主要原因。
 * 邻居一行放不下时同样换行，平面往下长。
 */
export function focusLayout(
  ws: GraphSnapshot,
  focusId: string,
  viewportWidth: number,
  viewportHeight: number,
  selectedId: string | null,
): FocusLayout {
  const byId = new Map(ws.nodes.map((n) => [n.id, n]));
  const focus = byId.get(focusId);
  const width = Math.max(viewportWidth, MIN_PLANE_WIDTH);
  if (!focus) {
    return { nodes: [], guides: [], width, height: viewportHeight, dependents: [], prerequisites: [] };
  }

  const dependents: KnowledgeNode[] = [];
  const prerequisites: KnowledgeNode[] = [];
  const seen = new Set<string>();
  for (const e of ws.edges) {
    if (e.toId === focusId) {
      const n = byId.get(e.fromId);
      if (n && !seen.has(`p-${n.id}`)) {
        seen.add(`p-${n.id}`);
        dependents.push(n);
      }
    } else if (e.fromId === focusId) {
      const n = byId.get(e.toId);
      if (n && !seen.has(`c-${n.id}`)) {
        seen.add(`c-${n.id}`);
        prerequisites.push(n);
      }
    }
  }

  const columns = columnsFor(width);
  const rowsOf = (count: number) => Math.ceil(count / columns);
  const depRows = rowsOf(dependents.length);
  const prereqRows = rowsOf(prerequisites.length);
  /*
   * 当前节点独占中间一行；上下两组各按自己的行数占位。
   * 平面至少和视口一样高，内容整体在平面里垂直居中——窗口很高时图不会贴着顶边。
   */
  /*
   * 垂直居中，但要保证内容与平面顶边之间有 PAD_TOP 的余量：
   * 画布左上角浮着「聚焦：…」的说明条，第一行卡片顶上去会被压住（窄窗口下最明显）。
   * 窗口太矮时就把平面撑高——图可以滚动，卡片不能被盖住。
   */
  const contentHeight = (depRows + 1 + prereqRows) * NODE_ROW + CARD_HALF_H * 2;
  const height = Math.max(viewportHeight, contentHeight + PAD_TOP * 2);
  const top = (height - contentHeight) / 2 + CARD_HALF_H;
  const centerY = top + depRows * NODE_ROW;

  const placed: SpaceNode[] = [];
  dependents.forEach((n, i) => {
    const y = top + Math.floor(i / columns) * NODE_ROW;
    placed.push(toSpaceNode(n, 1, spreadX(width, columns, i, dependents.length), y, selectedId));
  });
  prerequisites.forEach((n, i) => {
    const y = centerY + (Math.floor(i / columns) + 1) * NODE_ROW;
    placed.push(toSpaceNode(n, 1, spreadX(width, columns, i, prerequisites.length), y, selectedId));
  });
  placed.push(toSpaceNode(focus, 0, width / 2, centerY, focusId));

  // 组名只在自己那组有内容时出现：空组的标签只会挤占别人的位置
  const labelY = (y: number) => Math.max(8, Math.round(y));
  const guides: SpaceLayout["guides"] = [];
  if (dependents.length > 0) {
    guides.push({ key: "dependents", label: "依赖它的地方", y: labelY(top - CARD_HALF_H - 6) });
  }
  guides.push({ key: "focus", label: "当前知识点", y: labelY(centerY - CARD_HALF_H - 6) });
  if (prerequisites.length > 0) {
    guides.push({
      key: "prereqs",
      label: "它的前置知识",
      y: labelY(centerY + NODE_ROW - CARD_HALF_H - 6),
    });
  }

  return { nodes: placed, guides, width, height, dependents, prerequisites };
}

/** 当前节点的关系集合，用于「只强调与当前节点相关的边」 */
export function isIncident(edge: DependencyEdge, nodeId: string | null): boolean {
  if (!nodeId) return false;
  return edge.fromId === nodeId || edge.toId === nodeId;
}

