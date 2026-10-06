/**
 * **表格操作菜单**的纯逻辑（`design/table-caret-and-interaction-design.md` ✓）。
 *
 * 文档要的效果：普通表格看起来就是文档内容 ✓ —— 鼠标移入不出横竖辅助线、不点亮整行整列 ✗，
 * 点击单元格是**文字插入光标** ✓；结构操作（增删行列、列对齐）只在用户主动操作表格时
 * 从**表格右上角一个轻量菜单**里出现 ✓。
 *
 * 这里只放"不碰 DOM、不碰 React"的部分（可以直接单测 ✓）：
 * 1. 动作清单与分组（按钮顺序的唯一来源 ✓）；
 * 2. `readTableContext`：光标到底在不在表格里、当前列是什么对齐（决定菜单显不显示 / 哪颗按钮点亮 ✓）；
 * 3. `menuPosition`：菜单该贴在表格块右上角的哪个坐标（纯几何 ✓）。
 *
 * 真正执行命令在 `MarkdownRichEditor` 里（拿着 Milkdown 的 ctx 调表格命令 ✓）。
 */
import { isInTable, selectedRect, selectionCell } from "@milkdown/kit/prose/tables";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorState } from "@milkdown/kit/prose/state";

/** 菜单动作（与 `TableMenu.tsx` 的按钮一一对应 ✓） */
export type TableMenuAction =
  | "row-before"
  | "row-after"
  | "col-before"
  | "col-after"
  | "align-left"
  | "align-center"
  | "align-right"
  | "row-up"
  | "row-down"
  | "col-left"
  | "col-right"
  | "row-delete"
  | "col-delete"
  | "table-delete";

/** 列对齐（表格 schema 的 alignment 属性；缺省按左对齐 ✓） */
export type TableAlignment = "left" | "center" | "right";

/** 一条菜单项 */
export interface TableMenuItem {
  id: TableMenuAction;
  /** 文案 key（中英词典与回落字面文案都要有 ✓） */
  labelKey: string;
  /** 分组编号：同组按钮贴在一起，组间画一条细分隔线 ✓ */
  group: number;
  /** 危险操作（删除行列）⇒ 悬停用警示色 ✓；**标题必须写明对象** ✓ */
  danger?: boolean;
  /** 对齐按钮：当前列正是这个对齐时点亮 ✓ */
  alignment?: TableAlignment;
  /** 行列移动：能不能用要看当前选区（边界 / 表头 / 合并单元格 ✓） */
  move?: boolean;
}

/** 菜单文案（宿主 locale 缺席时的回落；正式文案在中英词典里 ✓） */
export const TABLE_LITERAL: Record<string, string> = {
  tableMenuLabel: "表格操作",
  /* 公式 / 代码块那两颗按钮 ✓（原来硬编码中文 ✗ ⇒ 英文界面下也是中文 ✓） */
  editorEditSource: "编辑源码",
  editorResultOnly: "只看结果",
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
  tableDeleteTable: "删除整张表格",
  tableDeleteCol: "删除本列",
  /* 动不了时给出**为什么** ✓（复查要求"边界时禁用对应方向"✓） */
  tableMoveEdge: "已经在边界上，这个方向移不动",
  tableMoveHeader: "表头行不参与移动",
  /*
   * **表头行上方不能再插行** ✓（用户实测两轮后的最终口径 ✓）：
   * Markdown 表格里第一行**就是表头** ✓ ⇒ 它上面没有可插入的位置 ✓
   * （硬插会把整张表拆成两张 ✗）。
   */
  tableRowBeforeHeader: "第一行是表头，上面没有位置可插入（Markdown 表格的第一行就是表头）",
  tableMoveSpan: "选中的是多行 / 多列，或表里有合并单元格 ⇒ 先只选中一行或一列",
  tableMoveUnavailable: "这份表格暂时不能移动行列",
  /* 只读 / 保存中：入口还在，但禁用并说明状态 ✓ */
  tableEntryDisabled: "编辑器暂时不能改表格（正在保存或只读）",
};

/**
 * 动作清单：**顺序 = 按钮顺序** ✓。
 * 分组：① 插行 ② 插列 ③ 列对齐 **④ 行列移动（复查补的功能 ✓）** ⑤ 删除（危险，放最后 ✓）。
 */
export const TABLE_MENU_ITEMS: readonly TableMenuItem[] = [
  { id: "row-before", labelKey: "tableRowBefore", group: 0 },
  { id: "row-after", labelKey: "tableRowAfter", group: 0 },
  { id: "col-before", labelKey: "tableColBefore", group: 1 },
  { id: "col-after", labelKey: "tableColAfter", group: 1 },
  { id: "align-left", labelKey: "tableAlignLeft", group: 2, alignment: "left" },
  { id: "align-center", labelKey: "tableAlignCenter", group: 2, alignment: "center" },
  { id: "align-right", labelKey: "tableAlignRight", group: 2, alignment: "right" },
  { id: "row-up", labelKey: "tableRowUp", group: 3, move: true },
  { id: "row-down", labelKey: "tableRowDown", group: 3, move: true },
  { id: "col-left", labelKey: "tableColLeft", group: 3, move: true },
  { id: "col-right", labelKey: "tableColRight", group: 3, move: true },
  { id: "row-delete", labelKey: "tableDeleteRow", group: 4, danger: true },
  { id: "table-delete", labelKey: "tableDeleteTable", group: 4, danger: true },
  { id: "col-delete", labelKey: "tableDeleteCol", group: 4, danger: true },
];

/** 菜单该显示成什么样（`inTable === false` ⇒ 根本不渲染 ✓） */
export interface TableContext {
  /** 光标 / 选区在表格里 ✓ */
  inTable: boolean;
  /** 当前单元格所在列的对齐 ✓ */
  alignment: TableAlignment;
}

/**
 * 从编辑器 state 读出表格上下文。
 *
 * **只读、纯函数** ✓：菜单的显隐与高亮都来自**编辑器的 selection** ✓，
 * 不靠鼠标悬停推断 ✗（文档第 3 节要求 ✓）。
 */
export function readTableContext(state: EditorState | null | undefined): TableContext {
  if (state === null || state === undefined || !isInTable(state)) {
    return { inTable: false, alignment: "left" };
  }
  /*
   * `selectionCell` 给的是"**紧挨着单元格**"的位置（prosemirror-tables 的惯用形态 ✓），
   * 单元格本体在 `nodeAfter` 上 ✓（`node(depth)` 拿到的是它外面那一行 ✗）。
   */
  const raw: unknown = selectionCell(state).nodeAfter?.attrs.alignment;
  return { inTable: true, alignment: raw === "center" || raw === "right" ? raw : "left" };
}

/**
 * 事件路径（`event.composedPath()` ✓）里有没有**我们自己的**入口 / 菜单节点 ✓。
 *
 * 为什么不能用 `event.target.closest(".kn-table-entry, .kn-table-menu")` ✗
 * （`design/table-menu-shadow-dom-review.md` 实测 ✓）：
 * 面板跑在 Shadow DOM 里，事件传到 `document` 时 `event.target` 被**重定向成 shadow host** ✗
 * ⇒ 里面真正被点的那个菜单项根本看不到 ⇒ 点菜单内部也被判成"点外面"、
 * 在 `click` 执行动作**之前**把菜单收掉 ✗。
 *
 * 为什么按**节点引用**而不是类名 ✗：同一页面可能有别的编辑器 / 别的实例的菜单 ✓，
 * 只匹配类名会把别人的菜单当成自己的 ✓。
 *
 * @param path - `event.composedPath()` 的结果 ✓（Shadow DOM 里它给的是**真实**路径 ✓）。
 * @param nodes - 我们自己的节点（入口按钮 / 菜单容器 ✓；可能还没挂上 ⇒ `null` ✓）。
 * @returns 命中任何一个 ⇒ `true` ✓。
 */
export function pathHitsNodes(
  path: readonly unknown[],
  nodes: readonly (unknown | null | undefined)[],
): boolean {
  const mine: unknown[] = nodes.filter((node) => node !== null && node !== undefined);
  if (mine.length === 0) return false;
  for (const item of path) {
    if (mine.includes(item)) return true;
  }
  return false;
}

/**
 * **行列移动**的可用状态 + 命令参数（全部由当前选区算出来 ✓，纯函数可单测 ✓）。
 *
 * 复查要求（`design/table-interaction-and-row-column-functions-review.md` P2 ✓）：
 * - 补回"上移/下移行、左移/右移列"✓；
 * - **边界时禁用对应方向** ✓；
 * - **表头行不参与移动** ✓（不许把正文行与表头互换 ✗）；
 * - 多行 / 多列选择与**合并单元格**明确禁止 ✗（不许猜、也不许破坏结构 ✓）。
 */
export interface TableMoveState {
  rowUp: boolean;
  rowDown: boolean;
  colLeft: boolean;
  colRight: boolean;
  /** 当前行索引 / 当前列索引（拼命令参数用 ✓） */
  rowIndex: number;
  colIndex: number;
  /** 一个都动不了时的原因（文案 key ✓；至少有一个能动就是 `null` ✓） */
  blockedKey: string | null;
}

/**
 * 第一行是不是表头行 ✓。
 *
 * 角色名要**两种都认** ✗：`prosemirror-tables` 这一版给表头单元格的是 `"header_cell"` ✓
 * （实测本仓库里内联的那份就是它 ✓），旧文档/别处也有写 `"header"` 的 ✓ ⇒ 两个都当表头 ✓。
 */
function hasHeaderRow(table: Node): boolean {
  const cell = table.firstChild?.firstChild ?? null;
  const role = cell?.type.spec.tableRole;
  return role === "header" || role === "header_cell";
}

/**
 * 读出"这份表格现在能不能移动行列、往哪边移" ✓。
 * @param state - 编辑器状态 ✓。
 * @returns 不在表格里（或读不出来）返回 `null` ✓。
 */
export function readTableMoveState(state: EditorState | null | undefined): TableMoveState | null {
  if (state === null || state === undefined || !isInTable(state)) return null;
  let rect;
  try {
    rect = selectedRect(state);
  } catch {
    /* 选区在表格里却算不出矩形（理论上不会 ✓）⇒ 当"不可用"处理，别把异常抛给界面 ✓ */
    return null;
  }
  const { top, bottom, left, right, map, table } = rect;
  /*
   * **合并单元格**：`TableMap` 里同一个位置出现多次 ⇒ 行列不是规整网格 ✗
   * ⇒ 移动会破坏结构，直接禁用 ✓（复查要求"如未支持需明确禁止"✓）。
   */
  const merged = new Set(map.map).size !== map.map.length;
  /* 多行 / 多列选择：不猜用户要移动哪一行/列 ✗ */
  const singleRow = bottom - top === 1;
  const singleCol = right - left === 1;
  const headerRows = hasHeaderRow(table) ? 1 : 0;
  const rowIndex = top;
  const colIndex = left;
  const rowMovable = !merged && singleRow && rowIndex >= headerRows;
  const colMovable = !merged && singleCol;
  const rowUp = rowMovable && rowIndex - 1 >= headerRows;
  const rowDown = rowMovable && rowIndex + 1 <= map.height - 1;
  const colLeft = colMovable && colIndex - 1 >= 0;
  const colRight = colMovable && colIndex + 1 <= map.width - 1;
  /* 一个都动不了 ⇒ 给一句"为什么" ✓（边界 / 表头 / 多选或合并 ✓） */
  let blockedKey: string | null = null;
  if (!rowUp && !rowDown && !colLeft && !colRight) {
    if (merged || !singleRow || !singleCol) blockedKey = "tableMoveSpan";
    else if (rowIndex < headerRows) blockedKey = "tableMoveHeader";
    else blockedKey = "tableMoveEdge";
  }
  return { rowUp, rowDown, colLeft, colRight, rowIndex, colIndex, blockedKey };
}

/**
 * 移动动作用哪组 `from` / `to`（喂给 Milkdown 的 `moveRowCommand` / `moveColCommand` ✓）。
 *
 * Milkdown 的命令最终落到 `prosemirror-tables` 的 `moveTableRow` / `moveTableColumn` ✓：
 * **整体搬整行 / 整列**（单元格内容、列对齐、列宽都跟着走 ✓），走事务 ⇒ 可以撤销 ✓；
 * 不是"删了再输"、也不动 DOM 顺序 ✗（复查明确要求 ✓）。
 *
 * @param action - 必须是移动类动作 ✓（其它动作返回 `null` ✓）。
 * @param move - `readTableMoveState` 的结果 ✓。
 * @returns `{ from, to }`（索引 ✓）或 `null` ✓。
 */
export function movePayload(
  action: TableMenuAction,
  move: TableMoveState,
): { from: number; to: number } | null {
  if (action === "row-up") return move.rowUp ? { from: move.rowIndex, to: move.rowIndex - 1 } : null;
  if (action === "row-down") return move.rowDown ? { from: move.rowIndex, to: move.rowIndex + 1 } : null;
  if (action === "col-left") return move.colLeft ? { from: move.colIndex, to: move.colIndex - 1 } : null;
  if (action === "col-right") return move.colRight ? { from: move.colIndex, to: move.colIndex + 1 } : null;
  return null;
}

/**
 * 入口在"实在没地方、只能压在单元格上"时收成的**小图标尺寸** ✓
 * （用户实测："别挡住我要编辑的格子" ✗ ⇒ 有地方就放到格子外面 ✓，没地方就把自己缩到最小 ✓）。
 */
export const TABLE_ENTRY_COMPACT_SIZE = 22;

/** 入口按钮的高度（复查要求"轻量按钮" ✓；横向定位用下面的估算宽度 ✓） */
export const TABLE_ENTRY_SIZE = 24;
/**
 * 入口按钮的**估算宽度**（图标 + 「表格操作」四个字 + 内边距 ✓）。
 * 只是用来判断"右边有没有地方放" ✓ —— 宁可估大一点（少用右侧空白、退到表格角上）✗，
 * 也不要估小了把入口压在表格上 ✓。
 */
export const TABLE_ENTRY_WIDTH = 78;
/** 入口 / 弹出层与表格之间的间距 ✓ */
export const TABLE_ENTRY_GAP = 4;
/** 弹出菜单的高度上限（与 CSS 的 max-height 一致 ✓；超了在菜单里滚 ✓） */
export const TABLE_POPOVER_HEIGHT = 264;

/**
 * 单元格的**最小文字宽度**（em ✓，与 `editor-overrides.css` 里 `th/td { min-width: 6em }` 同一档 ✓）。
 *
 * 为什么要按 em 记 ✗：字号是正文那档（15px ✓）算出来的宽度才跟得上主题/缩放 ✓
 * —— 写死 px 的话换主题就偏 ✓。
 */
export const TABLE_CELL_MIN_EM = 6;
/** 单元格左右内边距之和（px ✓，与 CSS 的 `padding: 8px 12px` 对应 ✓） */
export const TABLE_CELL_PADDING_PX = 24;

/**
 * **表格的最小宽度** = 列数 × (每列最小文字宽 + 单元格内边距) ✓
 * （用户实测 ✓：13 列时"一个字一行"✗ ⇒ 要"列多就横向滚动看完整表格"✓）。
 *
 * 为什么必须**按列数算** ✗：
 * - 只写 `width: 100%` ⇒ 列多时浏览器把每列压到极窄 ✗（单元格上的 `min-width` 会被忽略 ✗）；
 * - 只写 `min-width: max-content` ⇒ 表格**永不换行** ✗（正文型表格会拉成几千像素 ✗）；
 * - 按列数给一个**下限** ✓ ⇒ 列少时下限 < 可用宽度 ⇒ `width: 100%` 生效（铺满 ✓）✓；
 *   列多时下限 > 可用宽度 ⇒ 表格溢出 ✓ ⇒ 交给 `.table-wrapper` 出**下方横条** ✓✓。
 *
 * @param columns - 表格的列数（取第一行 `children.length` ✓）。
 * @param fontPx - 表格当前的 `font-size`（px ✓）。
 * @returns 最小宽度（px ✓）；列数不合法时返回 0（调用方清掉 `min-width` ✓）。
 */
export function tableMinWidth(columns: number, fontPx: number): number {
  if (!Number.isFinite(columns) || columns <= 0) return 0;
  const font = Number.isFinite(fontPx) && fontPx > 0 ? fontPx : 15;
  return Math.round(columns * (TABLE_CELL_MIN_EM * font + TABLE_CELL_PADDING_PX));
}

/**
 * **一个 table 候选**（DOM 层负责收集 ✓，这里只做判定 ✓ ⇒ 可离线单测 ✓）。
 *
 * 为什么需要它（`design/table-entry-hidden-preview-table-analysis.md` ✓）：
 * 表格块里**正文表格之前还有一张隐藏的拖拽预览 table** ✗
 * （`.drag-preview > table`，`editor-overrides.css` 把它 `display:none` ✓）
 * ⇒ 原来的 `querySelector("table")` 拿到的是它 ✓，矩形 `0×0` ✓，
 * 于是"可见带小于按钮高度" ⇒ 入口被判成不可显示 ⇒ 用户根本看不到入口 ✓（实测入口数 = 0 ✓）。
 * 复查要求：**别依赖"第一张 / 最后一张"** ✗，按标记过滤 ✓。
 */
export interface TableCandidate {
  /** 是不是 `.drag-preview`（或它里面）那张隐藏预览表 ✓ */
  hidden: boolean;
  /** 是不是在 `.table-wrapper` 里 ✓（正文表格一定在 ✓） */
  inWrapper: boolean;
  /** 视口矩形的宽高（`0` ⇒ 没尺寸、量不了 ✓） */
  width: number;
  height: number;
}

/**
 * 从候选里挑出**正文表格** ✓。
 *
 * 规则（顺序即优先级 ✓）：排除隐藏预览 ✓ → 必须在 `.table-wrapper` 里 ✓ → **必须有非零尺寸** ✓。
 * 全都不合格 ⇒ `undefined` ✓（调用方据此报"没找到正文表格"或"尺寸为零" ✓，而不是笼统的"没空间" ✗）。
 *
 * @param candidates - 块内收集到的所有 table 候选 ✓（**顺序无关** ✓）。
 * @returns 正文表格候选；没有返回 `undefined` ✓。
 */
export function pickBodyTable<T extends TableCandidate>(candidates: readonly T[]): T | undefined {
  const usable = candidates.filter((item) => item.hidden !== true && item.inWrapper === true);
  return usable.find((item) => item.width > 0 && item.height > 0);
}

/**
 * 入口该锚在哪张表格 ✓（复查"多表格切换"那条 ✓）。
 *
 * - **菜单打开期间锁定** ✓：`locked` 有效就一直用它 ✗（否则鼠标一飘就换表、可能误操作 ✓）；
 * - 否则**鼠标悬停的那张优先** ✓（用户指着谁就是谁 ✓ —— 复查指出原来"选区优先"会让人以为
 *   悬停的表格没有菜单 ✓）；没有悬停（或刚移出表格）再退回**选区所在的表格** ✓。
 *
 * @param args - 三个候选（同一形状 ✓；没有就传 `null` ✓）。
 * @returns 该用的那张；都没有 ⇒ `null` ✓。
 */
export function resolveTableTarget<T>(args: {
  locked: T | null;
  hovered: T | null;
  selection: T | null;
}): T | null {
  return args.locked ?? args.hovered ?? args.selection;
}

/** 入口**为什么没显示** ✓（复查要求把几种情况分开 ✗，别都报 `no-visible-band` ✓） */
export type TableEntryHideReason =
  /** 连表格块都没找到（选区不在表格里、也没悬停任何表格 ✓） */
  | "no-block"
  /** 块里没有合格的正文表格（只有隐藏预览 / 都不在 wrapper 里 ✓） */
  | "no-body-table"
  /** 找到了正文表格，但它量出来是零尺寸 ✓ */
  | "zero-size"
  /** 正文表格与正文视口**完全不相交**（整张滚出视口了 ✓） */
  | "table-out-of-view"
  /** 表格有可见部分，但放不下一个按钮 ✓ */
  | "no-visible-band";

/**
 * 算出"没显示入口"的原因 ✓（纯函数 ✓）。
 *
 * @param args.candidates - 块内 table 候选 ✓（空数组 ⇒ `no-block` ✓）。
 * @param args.visible - 正文表格 ∩ `.table-wrapper` 的**可见矩形**（视口坐标 ✓）。
 * @param args.viewport - 正文滚动容器的可见范围 ✓。
 * @param args.size - 按钮高度（默认 `TABLE_ENTRY_SIZE` ✓）。
 * @returns 原因 ✓；一切正常（**应该显示**）⇒ `null` ✓。
 */
export function tableEntryHideReason(args: {
  candidates: readonly TableCandidate[];
  visible?: { top: number; bottom: number } | undefined;
  viewport?: { top: number; bottom: number } | undefined;
  size?: number;
}): TableEntryHideReason | null {
  const size = args.size ?? TABLE_ENTRY_SIZE;
  if (args.candidates.length === 0) return "no-block";
  const body = pickBodyTable(args.candidates);
  if (body === undefined) {
    /* 候选都不合格：有"合格形状但零尺寸"的 ⇒ 那是 zero-size 分支；否则就是没找到正文表格 ✓ */
    const sized = args.candidates.some(
      (item) => item.hidden !== true && item.inWrapper === true && item.width > 0 && item.height > 0,
    );
    return sized ? null : "no-body-table";
  }
  if (body.width <= 0 || body.height <= 0) return "zero-size";
  const { visible, viewport } = args;
  if (visible === undefined || viewport === undefined) return null;
  const bandTop = Math.max(visible.top, viewport.top);
  const bandBottom = Math.min(visible.bottom, viewport.bottom);
  if (bandBottom <= bandTop) return "table-out-of-view";
  if (bandBottom - bandTop < size) return "no-visible-band";
  return null;
}

/** 一个矩形只需要这几个边 ✓（都用 `getBoundingClientRect()` 给 ✓） */
export interface Box {
  top: number;
  right: number;
  /** 可选：判定纵向空间时用 ✓ */
  bottom?: number;
  /** 可选：判定横向空间时用 ✓ */
  left?: number;
}

/**
 * **入口按钮**该放哪儿 ✓（`design/node-editor-design-implementation-review.md` P2 ✓
 * ＋ `design/table-entry-scroll-visibility-review.md` ✓）。
 *
 * 横向仍然按优先级（谁也不遮 ✓）：
 * 1. **表格右侧的空白**（短表格最常见 ✓）⇒ 贴着表格右边缘外侧放 ✓；
 * 2. **表格上方的空白**（上一块与表格之间真的有 `size + gap` 的空 ✓）⇒ 放上方右对齐 ✓；
 * 3. 都没有 ⇒ 压**表格自己的右上角**（宁可靠在表格上，也不许盖住前一段正文 ✗）。
 *
 * 纵向在复查之后改成"**跟着可见区域走**"✗（原来固定锚在表格顶部 ✓）：
 * 长表格往下滚时，表格顶部早滚出正文视口了 ✗，绝对定位的按钮就被裁掉 ——
 * 复查实测 `entryTop=0 / entryBottom=24` 而正文可见区是 `44…777`，**完全没有交集** ✓，
 * 功能还在、用户却看不到 ✓。现在：
 *
 * - 先算"表格 ∩ 正文视口"这条**可见带** ✓（`table` 已经与 `.table-wrapper` 求过交 ✓）；
 * - 可见带放不下一个按钮 ⇒ **明确隐藏** ✓（返回 `null`；表格整个滚出视口就属于这种 ✓）；
 * - 活跃单元格在可见带里 ⇒ 纵向**贴它** ✓（用户点哪儿，入口就在哪儿附近 ✓）；
 *   不在 ⇒ 夹进可见带 ✓；
 * - 上方那条优先级只在"放上去之后**仍在可见带内**"时才用 ✓，否则退回表格角上 ✓。
 *
 * 坐标与旧实现一样是"正文容器的**内容坐标**" ✓（跟着内容一起滚 ✓）。
 *
 * @param table - **可见**表格范围（已与 `.table-wrapper` 的可见区域求过交 ✓；横滚时不会算到看不见的列 ✓）。
 * @param container - 正文滚动容器 ✓（纵向可见区 = `[top, bottom]` ✓）。
 * @param scrollTop - 容器的 `scrollTop`（把视口坐标换算成内容坐标 ✓）。
 * @param previousBottom - 表格**上一块**的下沿（视口坐标 ✓；没有就传 `null` ✓）——"上方有没有空白"看它 ✓。
 * @param size - 按钮高度 ✓。
 * @param gap - 间距 ✓。
 * @param width - 按钮估算宽度 ✓。
 * @param cell - **活跃单元格**的矩形（视口坐标 ✓；不是"光标在表格里"就传 `null` ✓）。
 * @returns `right` 是相对容器右边缘的偏移（CSS `right` ✓）；`inside` = 是否压在表格上 ✓；
 *   **表格在正文视口里放不下按钮时返回 `null`** ✓（调用方据此收起入口 ✓）。
 */
export function tableEntryPosition(
  table: Box,
  container: Box,
  scrollTop: number,
  previousBottom: number | null,
  size: number = TABLE_ENTRY_SIZE,
  gap: number = TABLE_ENTRY_GAP,
  width: number = TABLE_ENTRY_WIDTH,
  cell: Box | null = null,
): { top: number; right: number; inside: boolean; compact: boolean } | null {
  /* 正文视口的纵向范围（视口坐标 ✓） */
  const viewTop = container.top;
  const viewBottom = container.bottom ?? container.top + size;
  /* 表格 ∩ 正文视口 = 可见带 ✓（表格本身也已经与 wrapper 求过交 ✓） */
  const bandTop = Math.max(table.top, viewTop);
  const bandBottom = Math.min(table.bottom ?? table.top + size, viewBottom);
  if (bandBottom - bandTop < size) return null; /* 可见带放不下一个按钮 ⇒ 明确隐藏 ✗ */

  /*
   * 纵向锚点：活跃单元格在可见带里就跟它走 ✓，否则贴可见带顶 ✓
   * （不管哪种，最终都夹进**正文视口** ⇒ 一定与视口相交 ✓）。
   */
  const wanted = cell !== null && cell.top >= bandTop && cell.top <= bandBottom - size ? cell.top : bandTop;
  const clampToView = (value: number): number => Math.min(Math.max(value, viewTop), Math.max(viewTop, viewBottom - size));
  const top = clampToView(wanted);
  const contentTop = top - viewTop + scrollTop;

  /* 表格右侧的空白 ✓ */
  const gutter = container.right - table.right;
  /* 上一块下沿到表格上沿之间的距离 ✓（null ⇒ 表格是这一段的第一块 ✓） */
  const freeAbove = previousBottom === null ? Number.POSITIVE_INFINITY : table.top - previousBottom;

  /*
   * ⓪ **贴活跃单元格的「右上角外侧」** ✓（用户两次实测的要求合起来就是这句 ✓）：
   * ① 不能飘到离被点的那一格很远的右边 ✗；
   * ② 更**不能盖住正在编辑的那一格** ✗。
   *
   * 所以：
   * - **纵向优先放在这一格的上方** ✓（入口底边 = 单元格上沿 − 间距 ✓）⇒ "右上角"✓ 且不挡这一格 ✓；
   *   上面放不下（这一格就在可见区顶部 ✓）⇒ 再试**可见带上方** ✓（整张表格顶部之外 ✓，更不挡 ✓）；
   * - **横向贴这一格的右边** ✓（不再贴整张表 / 容器右边 ✗）；格子右边在视口外 ⇒ 夹到"整块可见"的最右 ✓；
   * - 上面**真的没地方**（这一格在视口最顶上、上方又被滚动压掉 ✓）⇒ 才压在这一格右上角，
   *   但那时**收成小图标** ✓（`compact` ✓）—— 少挡字，而且仍然紧贴这一格 ✓；
   * - 这一格本身太窄（放不下整条胶囊 ✓）⇒ 同上，走小图标 ✓。
   *
   * `inside` 表示"是否压在表格上"✓（CSS 据此用半透明样式 ✓，不遮住格子里的字 ✓）。
   */
  if (cell !== null && cell.top >= bandTop && cell.top <= bandBottom - size) {
    const inset = 2;
    const visibleLeft = Math.max(table.left ?? container.left ?? container.right - width, container.left ?? 0);
    const maxRight = Math.max(inset, container.right - visibleLeft - width - inset);
    /** 让入口**右边**贴着 `edge`（视口坐标 ✓），并保证整块可见 ✓ */
    const rightFor = (edge: number): number => Math.min(Math.max(container.right - edge + inset, inset), maxRight);
    const wideEnough = cell.right - visibleLeft >= width + inset * 2;
    if (wideEnough) {
      for (const wantedTop of [cell.top - size - gap, bandTop - size - gap]) {
        if (wantedTop < viewTop) continue; /* 放上去会跑出可见区 ⇒ 换下一个锚 ✗ */
        return {
          top: Math.max(0, Math.round(wantedTop - viewTop + scrollTop)),
          right: Math.max(0, Math.round(rightFor(cell.right))),
          inside: wantedTop + size > table.top,
          compact: false,
        };
      }
    }
    /* 上面没地方 / 这一格太窄 ⇒ 压在这一格右上角，但收成小图标 ✓（尽量少挡 ✓） */
    return {
      top: Math.max(0, Math.round(clampToView(cell.top + inset) - viewTop + scrollTop)),
      right: Math.max(0, Math.round(rightFor(cell.right))),
      inside: true,
      compact: true,
    };
  }

  if (gutter >= width + gap) {
    /* ① 放右侧空白里：左边紧挨表格右边缘 ✓ */
    return { top: Math.max(0, Math.round(contentTop)), right: Math.max(0, Math.round(gutter - gap - width)), inside: false, compact: false };
  }
  /*
   * ② 放表格上方 —— 两个前提都要满足 ✓：
   * 上方真有空白 ✓，**而且表格顶部本身可见** ✗（长表格滚下去时表格顶早滚出视口了，
   * 这时"上方"会飘到前面那些行上 ✗；这种情况老老实实贴着活跃单元格 / 可见带 ✓），
   * 放上去也仍在正文视口里 ✓。
   */
  const aboveTop = top - size - gap;
  if (freeAbove >= size + gap && table.top >= viewTop && aboveTop >= viewTop) {
    return { top: Math.max(0, Math.round(aboveTop - viewTop + scrollTop)), right: Math.max(0, Math.round(gutter)), inside: false, compact: false };
  }
  /* ③ 压表格右上角（只压表格，不压上一段 ✓） */
  return { top: Math.max(0, Math.round(contentTop + 2)), right: Math.max(0, Math.round(gutter + 2)), inside: true, compact: false };
}

/**
 * **弹出菜单**该放哪儿 ✓：默认在入口**下方**，空间不够就翻到上方 ✓；
 * 横向夹在容器里（右对齐到入口，太靠右/太靠左都收回来 ✓）。
 *
 * 复查补充（`design/table-entry-scroll-visibility-review.md` 第 5 条 ✓）：
 * 纵向也要保证**整块落在正文视口里** ✗ —— 只按"入口下方"算的话，
 * 长表格滚下去时入口贴住视口底边、菜单就被推到裁切区外 ✓。
 * 现在纵向夹在 `[scrollTop, scrollTop + 可见高度]` 内 ✓；
 * 菜单比视口还高时贴视口顶 ✓（CSS 的 `max-height` + `overflow:auto` 让它自己滚 ✓）。
 *
 * @param entry - 入口按钮的位置（内容坐标 ✓）。
 * @param container - 正文滚动容器（内容坐标下的可见高度 = `bottom - top` ✓）。
 * @param scrollTop - 容器的 `scrollTop` ✓。
 * @param popoverHeight - 弹出层估计高度（`TABLE_POPOVER_HEIGHT` ✓）。
 * @param popoverWidth - 弹出层宽度 ✓（夹横向用 ✓）。
 * @param size - 入口高度 ✓。
 * @param gap - 间距 ✓。
 */
export function tablePopoverPosition(
  entry: { top: number; right: number },
  container: Box,
  scrollTop: number,
  popoverHeight: number = TABLE_POPOVER_HEIGHT,
  popoverWidth: number = 210,
  size: number = TABLE_ENTRY_SIZE,
  gap: number = TABLE_ENTRY_GAP,
): { top: number; right: number } {
  const visibleHeight = (container.bottom ?? container.top) - container.top;
  /* 正文视口的**内容坐标**范围 ✓（留 2px 边 ✓） */
  const viewTop = scrollTop + 2;
  const viewBottom = scrollTop + visibleHeight - 2;
  const below = entry.top + size + gap;
  const above = entry.top - gap - popoverHeight;
  /* 优先下方 ✓；下方放不下就翻上去 ✓；两边都放不下（比视口还高）⇒ 贴视口顶、菜单自己滚 ✓ */
  const fitsBelow = below + popoverHeight <= viewBottom;
  const candidate = fitsBelow ? below : above;
  /* 允许的最靠下位置：菜单底边不越过视口底边 ✓（菜单比视口高时退化成贴着视口顶 ✓） */
  const lowest = Math.max(viewTop, viewBottom - popoverHeight);
  const top = Math.min(Math.max(candidate, viewTop), lowest);
  const visibleWidth = container.right - (container.left ?? container.right - 400);
  const maxRight = Math.max(0, visibleWidth - popoverWidth - 2);
  return { top: Math.round(top), right: Math.round(Math.min(Math.max(0, entry.right), maxRight)) };
}
