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
import { isInTable, selectionCell } from "@milkdown/kit/prose/tables";
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
  | "row-delete"
  | "col-delete";

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
}

/** 菜单文案（宿主 locale 缺席时的回落；正式文案在中英词典里 ✓） */
export const TABLE_LITERAL: Record<string, string> = {
  tableMenuLabel: "表格操作",
  tableRowBefore: "在上方插入行",
  tableRowAfter: "在下方插入行",
  tableColBefore: "在左侧插入列",
  tableColAfter: "在右侧插入列",
  tableAlignLeft: "本列左对齐",
  tableAlignCenter: "本列居中",
  tableAlignRight: "本列右对齐",
  tableDeleteRow: "删除本行",
  tableDeleteCol: "删除本列",
};

/**
 * 动作清单：**顺序 = 按钮顺序** ✓。
 * 分组：① 插行 ② 插列 ③ 列对齐 ④ 删除（危险，放最后并与前面隔开 ✓）。
 */
export const TABLE_MENU_ITEMS: readonly TableMenuItem[] = [
  { id: "row-before", labelKey: "tableRowBefore", group: 0 },
  { id: "row-after", labelKey: "tableRowAfter", group: 0 },
  { id: "col-before", labelKey: "tableColBefore", group: 1 },
  { id: "col-after", labelKey: "tableColAfter", group: 1 },
  { id: "align-left", labelKey: "tableAlignLeft", group: 2, alignment: "left" },
  { id: "align-center", labelKey: "tableAlignCenter", group: 2, alignment: "center" },
  { id: "align-right", labelKey: "tableAlignRight", group: 2, alignment: "right" },
  { id: "row-delete", labelKey: "tableDeleteRow", group: 3, danger: true },
  { id: "col-delete", labelKey: "tableDeleteCol", group: 3, danger: true },
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

/** 入口按钮的边长（复查要求"约 24px 的轻量按钮" ✓） */
export const TABLE_ENTRY_SIZE = 24;
/** 入口 / 弹出层与表格之间的间距 ✓ */
export const TABLE_ENTRY_GAP = 4;
/** 弹出菜单的高度上限（与 CSS 的 max-height 一致 ✓；超了在菜单里滚 ✓） */
export const TABLE_POPOVER_HEIGHT = 264;

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
 * **入口按钮**该放哪儿 ✓（`design/node-editor-design-implementation-review.md` P2 ✓）。
 *
 * 复查实测的问题：原来九个按钮的工具条按**整块容器**定位 ⇒ 短表格（右边缘在 x≈254）
 * 也被贴到容器右边（x≈420），还压在前一段引用上 ✗。
 *
 * 现在按优先级：
 * 1. **表格右侧的空白**（短表格最常见 ✓）⇒ 贴着表格右边缘外侧放，谁也不遮 ✓；
 * 2. **表格上方的空白**（上一块与表格之间真的有 `size + gap` 的空 ✓）⇒ 放上方右对齐 ✓；
 * 3. 都没有 ⇒ 压**表格自己的右上角**（宁可靠在表格上，也不许盖住前一段正文 ✗）。
 *
 * 坐标与旧实现一样是"正文容器的**内容坐标**" ✓（跟着内容一起滚 ✓）。
 *
 * @param table - **可见**表格范围（已与 `.table-wrapper` 的可见区域求过交 ✓；横滚时不会算到看不见的列 ✓）。
 * @param container - 正文滚动容器 ✓。
 * @param scrollTop - 容器的 `scrollTop`（把视口坐标换算成内容坐标 ✓）。
 * @param previousBottom - 表格**上一块**的下沿（视口坐标 ✓；没有就传 `null` ✓）——"上方有没有空白"看它 ✓。
 * @param size - 按钮边长 ✓。
 * @param gap - 间距 ✓。
 * @returns `right` 是相对容器右边缘的偏移（CSS `right` ✓）；`inside` = 是否压在表格上 ✓。
 */
export function tableEntryPosition(
  table: Box,
  container: Box,
  scrollTop: number,
  previousBottom: number | null,
  size: number = TABLE_ENTRY_SIZE,
  gap: number = TABLE_ENTRY_GAP,
): { top: number; right: number; inside: boolean } {
  const contentTop = table.top - container.top + scrollTop;
  /* 表格右侧的空白 ✓ */
  const gutter = container.right - table.right;
  /* 上一块下沿到表格上沿之间的距离 ✓（null ⇒ 表格是这一段的第一块 ✓） */
  const freeAbove = previousBottom === null ? Number.POSITIVE_INFINITY : table.top - previousBottom;

  if (gutter >= size + gap) {
    /* ① 放右侧空白里：左边紧挨表格右边缘 ✓ */
    return { top: Math.max(0, Math.round(contentTop)), right: Math.max(0, Math.round(gutter - gap - size)), inside: false };
  }
  if (freeAbove >= size + gap) {
    /* ② 放表格上方（右对齐到表格右边缘 ✓） */
    return { top: Math.max(0, Math.round(contentTop - size - gap)), right: Math.max(0, Math.round(gutter)), inside: false };
  }
  /* ③ 压表格右上角（只压表格，不压上一段 ✓） */
  return { top: Math.max(0, Math.round(contentTop + 2)), right: Math.max(0, Math.round(gutter + 2)), inside: true };
}

/**
 * **弹出菜单**该放哪儿 ✓：默认在入口**下方**，空间不够就翻到上方 ✓；
 * 横向夹在容器里（右对齐到入口，太靠右/太靠左都收回来 ✓）。
 *
 * @param entry - 入口按钮的位置（内容坐标 ✓）。
 * @param container - 正文滚动容器（内容坐标下的可见高度 = `bottom - top` ✓）。
 * @param scrollTop - 容器的 `scrollTop` ✓。
 * @param popoverHeight - 弹出层估计高度（`TABLE_POPOVER_HEIGHT` ✓）。
 * @param popoverWidth - 弹出层宽度 ✓（夹横向用 ✓）。
 * @param size - 入口边长 ✓。
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
  const maxTop = scrollTop + visibleHeight - popoverHeight - 2;
  const below = entry.top + size + gap;
  const top = below <= maxTop ? below : Math.max(0, entry.top - gap - popoverHeight);
  const visibleWidth = container.right - (container.left ?? container.right - 400);
  const maxRight = Math.max(0, visibleWidth - popoverWidth - 2);
  return { top: Math.max(0, Math.round(top)), right: Math.round(Math.min(Math.max(0, entry.right), maxRight)) };
}
