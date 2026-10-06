/**
 * **表头行（表格第一行）的判定** ✓
 * （用户实测两轮之后的最终口径 ✓）。
 *
 * ## 为什么"在第一行上方插行"要**禁用**，而不是想办法插进去
 *
 * Milkdown 的 GFM 表格 schema 是：
 *
 * ```
 * table            ⇒ "table_header_row table_row+"
 * table_header_row ⇒ "table_header+"
 * table_row        ⇒ "table_cell+"
 * ```
 *
 * ⇒ **第一行必须是表头行** ✗。`addRowBeforeCommand` 会试着把**普通行**插到表头前面 ✗
 * ⇒ 那是一份**不合法**的文档 ✓（`table.createChecked([bodyRow, headerRow, …])` 直接抛
 * `RangeError: Invalid content for node table` ✓）⇒ ProseMirror 给事务做 `Fitter` 时
 * 把表格**拆成两张** ✗（用户第一张截图："上面多出一个小表"✓）。
 *
 * 中间试过一条"插进去"的路 ✓：**新行当表头、旧表头降级为普通行** ✓
 * （一次 `replaceWith`，文档始终合法 ✓）。用户实测后**否决**了它 ✓：
 *
 * > 现在的效果是，在第一行向上插入行时，第一行默认变成第二行，这也很怪，
 * > 因为很多时候第一行是段名。直接设置为第一行无法向上插入行吧，可能更合适一点。
 *
 * ⇒ 结论：**第一行上方本来就不是这套结构能表达的位置** ✓（Markdown 里表头就是第一行 ✓），
 * 所以在这一行上**禁用**「在上方插入行」并说清原因 ✓ ——
 * 与既有的"表头行不参与移动"（`tableMoveHeader` ✓）同一套口径 ✓，不猜、不悄悄改写用户的表头 ✓。
 *
 * 本文件只做**位置判定** ✓（纯 ProseMirror 数据 API ✓，不碰 DOM ✓）⇒ 可以在 Node 里直接测 ✓。
 */
import type { EditorState } from "@milkdown/kit/prose/state";
import type { Node as ProseNode, NodeType, Schema } from "@milkdown/kit/prose/model";

/** 表格里那几种节点类型 ✓（两种 schema 命名都兼容 ✓：Milkdown 的 GFM 与原生 prosemirror-tables ✓） */
export interface TableRowTypes {
  /** 表头行 ✓ */
  headerRow: NodeType;
  /** 普通行 ✓ */
  bodyRow: NodeType;
  /** 表头单元格 ✓ */
  headerCell: NodeType;
  /** 普通单元格 ✓ */
  bodyCell: NodeType;
}

/**
 * 从 schema 里取那四种类型 ✓。
 *
 * Milkdown 的 GFM 用 `table_header_row` / `table_row` ✓；
 * 原生 `tableNodes` 只有 `table_row` ✓（表头/正文靠**单元格**类型区分 ✓）。
 *
 * @param schema - 编辑器 schema ✓。
 * @returns 四种类型；缺失 ⇒ `null` ✓。
 */
export function tableRowTypes(schema: Schema): TableRowTypes | null {
  const headerRow = schema.nodes.table_header_row ?? schema.nodes.table_row;
  const bodyRow = schema.nodes.table_row ?? headerRow;
  const headerCell = schema.nodes.table_header ?? schema.nodes.table_cell;
  const bodyCell = schema.nodes.table_cell ?? headerCell;
  if (headerRow === undefined || bodyRow === undefined || headerCell === undefined || bodyCell === undefined) {
    return null;
  }
  return { headerRow, bodyRow, headerCell, bodyCell };
}

/** 光标落在哪张表、哪一行 ✓ */
export interface TableHit {
  /** 表格节点 ✓ */
  table: ProseNode;
  /** 表格节点在文档里的位置（**节点之前**那个位置 ✓） */
  tableStart: number;
  /** 光标所在行的下标 ✓（0 = 第一行 ✓） */
  rowIndex: number;
}

/**
 * 从选区自己算出"光标在哪张表的第几行" ✓。
 *
 * **故意不用 `prosemirror-tables` 的 `selectedRect`** ✗：Milkdown 的 fork 与上游签名不一致 ✓
 * （实测：对普通文字选区直接抛 `No cell with offset 1 found` ✗），
 * 而这里要的信息（表格节点、表格位置、行下标 ✓）顺着 `$from` 往上走一遍就有 ✓
 * —— 也不依赖任何 fork 的私有约定 ✓。
 *
 * @param state - 编辑器状态 ✓。
 * @returns 命中信息；光标不在表格里 ⇒ `null` ✓。
 */
export function hitTable(state: EditorState): TableHit | null {
  const $from = state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const table = $from.node(depth);
    if (table.type.name !== "table") continue;
    const tableStart = $from.before(depth);
    let rowIndex = -1;
    table.forEach((row, offset, index) => {
      /* `offset` 相对表格**内容**起点 ✓ ⇒ 绝对位置要 +1 ✓（节点起始 token） */
      const start = tableStart + 1 + offset;
      if (rowIndex < 0 && $from.pos > start && $from.pos < start + row.nodeSize) rowIndex = index;
    });
    if (rowIndex < 0) return null;
    return { table, tableStart, rowIndex };
  }
  return null;
}

/**
 * 光标所在的那一行是不是**表头行** ✓（用来禁用「在上方插入行」✓）。
 *
 * 判据分两套 ✓：
 * - Milkdown 的 GFM：行类型是 `table_header_row` ✓（`headerRow !== bodyRow` ✓）；
 * - 原生 `tableNodes`：没有专门的行类型 ⇒ 看**第一格是不是表头单元格** ✓
 *   （否则"两列普通行的表"也会被误判成表头 ✗）。
 *
 * @param state - 编辑器状态 ✓。
 * @param types - 四种表格类型 ✓。
 * @returns 是表头行 ⇒ `true` ✓；不在表格里 / 不在第一行 / 第一行不是表头 ⇒ `false` ✓。
 */
export function inFirstTableRow(state: EditorState, types: TableRowTypes): boolean {
  const hit = hitTable(state);
  if (hit === null || hit.rowIndex !== 0) return false;
  const firstRow = hit.table.child(0);
  if (firstRow.type !== types.headerRow) return false;
  /* 同一套 schema 里行类型不分表头/正文 ⇒ 只能靠单元格类型判 ✓ */
  if (types.headerRow === types.bodyRow) {
    return firstRow.childCount > 0 && firstRow.child(0).type === types.headerCell;
  }
  return true;
}
