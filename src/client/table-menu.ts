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

/** 菜单实际高度（与 CSS 一致：22px 按钮 + 上下各 4px 内边距 ✓） */
export const TABLE_MENU_HEIGHT = 30;
/** 菜单与表格上沿的间距 ✓ */
export const TABLE_MENU_GAP = 6;

/**
 * 菜单坐标：挂在**表格块的右上角** ✓。
 *
 * 坐标系是"正文滚动容器"的**内容坐标** ✓ —— 菜单是该容器的绝对定位子元素，
 * 因此跟着内容一起滚 ✓（不需要在滚动时重算 ✓）。
 *
 * `top` 夹到 ≥ 0 ✓：表格正好贴顶时宁可轻压表格上沿，也不能算到滚动区外面看不见 ✗；
 * `right` 同理 ✓（超窄侧栏下贴着右边缘 ✓）。
 *
 * @param block - 表格块的 `getBoundingClientRect()`（视口坐标 ✓）。
 * @param container - 正文滚动容器的 `getBoundingClientRect()` ✓。
 * @param scrollTop - 该容器的 `scrollTop` ✓（把视口坐标换算成内容坐标 ✓）。
 * @returns 相对容器内容原点的 `top` / `right`（px，已取整 ✓）。
 */
export function menuPosition(
  block: { top: number; right: number },
  container: { top: number; right: number },
  scrollTop: number,
  height: number = TABLE_MENU_HEIGHT,
  gap: number = TABLE_MENU_GAP,
): { top: number; right: number } {
  const top = Math.max(0, Math.round(block.top - container.top + scrollTop - height - gap));
  const right = Math.max(0, Math.round(container.right - block.right));
  return { top, right };
}
