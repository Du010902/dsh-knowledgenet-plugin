/**
 * **表格单元格点击 → 文字插入位置** ✓。
 *
 * ## 真正的根因（2026-10-02 第三次复查后才定位 ✓）
 *
 * Crepe 的表格用了一个**自带节点视图** `TableNodeView`，它做了两件事 ✗：
 *
 * ```js
 * stopEvent(e) {                      // ① mousedown / pointerdown 命中 td|th ⇒ 返回 true
 *   if (e.type === "mousedown" && target.closest("td")) return handleClick(e);
 * }
 * handleClick(e) {                    // ② 自己建"整段的结构选择"，而且**异步**派发
 *   const cell = findParent(role === cell|header)($pos);
 *   const selection = NodeSelection.create(state.doc, cell.from + 1);   // 段落的 NodeSelection ✗
 *   requestAnimationFrame(() => dispatch(tr.setSelection(selection).scrollIntoView()));  // ▼
 * }
 * ```
 *
 * ⇒ 两个后果，正好解释了复查看到的现象 ✓：
 * - `stopEvent` 返回 `true` ⇒ **ProseMirror 根本不处理这次 mousedown** ✗
 *   ⇒ 我们挂在 `handleClick` 上的主路径**永远不会被调用** ✓（不是"注册了没生效"这么简单 ✗）；
 * - 那个结构选择是 **rAF 之后**才派发的 ⇒ `mouseup` + 微任务的兜底跑在它**前面** ✓
 *   ⇒ 兜底看到的是旧选区、什么也不做 ✗，用户最终看到的就是"整段被选中、敲字被替换"✓。
 *
 * ## 现在的落点：**dispatch 这只漏斗**
 *
 * `MarkdownRichEditor` 在视图创建后包了一层 `view.dispatch` ✓：
 * 只要某个事务要把选区变成"**单元格里 textblock 的结构选择**"，就先把点击坐标折算成
 * **最近的合法文字位置**再派发 ✓ —— 这条路**躲不开** ✗（不管是谁、什么时候派发的 ✓），
 * 而且我们重新发一个干净事务 ⇒ 顺带丢掉上游那个 `scrollIntoView()` ✗（抖动的嫌疑之一 ✓）。
 *
 * 这里只有纯逻辑（不碰 DOM、不碰 React ✓）：`view.posAtCoords` 的结果由调用方传进来 ✓。
 */
import { NodeSelection, TextSelection, type EditorState, type Selection } from "@milkdown/kit/prose/state";
import type { Node } from "@milkdown/kit/prose/model";
import { cellAround } from "@milkdown/kit/prose/tables";

/**
 * `view.posAtCoords()` 的结果里我们真正需要的两个字段 ✓。
 *
 * `inside === -1` 表示命中了**真正的文字位置** ✗（那种点击交给原生 ✓，我们一概不抢 ✓）；
 * 否则 `inside` 是"点到哪个节点前面"的位置 ✓（单元格内边距就会走这一支 ✓）。
 */
export interface ClickCoords {
  pos: number;
  inside: number;
}

/** 夹到 `[low, high]` ✓ */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * 这一次点击**该不该由我们接管** ✓（纯判断，方便单测 ✓）。
 *
 * 只认普通左键单击：Shift 扩选、Ctrl(⌘)+点击选中节点、Alt、其它键一律让给原生 ✗
 * （拖选、双击选词、三击选段由 ProseMirror 自己分流，根本不会走到 `handleClick` ✓）。
 */
export function isPlainClick(
  event: { button: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
): boolean {
  return event.button === 0 && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

/**
 * 在一个单元格里找**离锚点最近的合法文字位置** ✓。
 *
 * 复查要求（P1 第 5 条 ✓）：空白点击要"按坐标找最近位置"✗，
 * **只有真正空单元格**才稳定落到第一行起点 ✓ —— 多段落 / 高单元格里，
 * 一律回落到第一行并不符合点击直觉 ✗。
 *
 * @param state - 编辑器状态 ✓。
 * @param anchor - 期望靠近的文档位置（来自点击坐标 ✓）。
 * @param from - 单元格内容起点 ✓。
 * @param to - 单元格内容终点 ✓。
 * @returns 合法文字位置；实在找不到返回 `null` ✓（调用方就交还原生 ✗）。
 */
function nearestTextInCell(doc: Node, anchor: number, from: number, to: number): number | null {
  const $anchor = doc.resolve(anchor);
  const candidates: number[] = [];
  if ($anchor.parent.inlineContent) candidates.push($anchor.pos);
  /* 前后各找一个（`Selection.near` 在找不到时会给整篇选择，夹回单元格后会被下面的合法性检查刷掉 ✓） */
  candidates.push(TextSelection.near($anchor, 1).from);
  candidates.push(TextSelection.near($anchor, -1).from);
  /* 空单元格的兜底：这个单元格第一行的起点 ✓ */
  candidates.push(TextSelection.near(doc.resolve(from), 1).from);

  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const inside = clamp(candidate, from, to);
    if (!doc.resolve(inside).parent.inlineContent) continue; /* 不是合法插入点 ⇒ 跳过 ✓ */
    const distance = Math.abs(inside - anchor);
    if (distance < bestDistance) {
      best = inside;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 这个选区是不是**那个坏状态**：单元格里 textblock（段落 / 标题 / 代码块）的结构选择 ✓。
 *
 * 只认这一种 ✗：文字选区（原生处理对了 ✓）、真正的原子块（图片 / 公式 ⇒ 选中它是要的 ✓）、
 * 表格外的一切结构选择（键盘按块选是**正常**操作 ✓）都不算 ✓。
 */
export function isCellTextblockSelection(selection: Selection): boolean {
  if (!(selection instanceof NodeSelection)) return false;
  if (!selection.node.isTextblock) return false;
  return cellAround(selection.$from) !== null;
}

/**
 * 把**单元格里 textblock 的结构选择**折算成"离锚点最近的合法文字位置" ✓（纯函数 ✓）。
 *
 * @param doc - 事务里的文档（可能与当前 state 不同 ✓）。
 * @param selection - 那个结构选择 ✓。
 * @param coords - 点击坐标解析结果；拿不到传 `null`（那就落到该单元格第一行 ✓）。
 * @returns 合法文字位置；不是那个坏状态 / 算不出来 ⇒ `null` ✓。
 */
export function caretTargetForTextblockSelection(
  doc: Node,
  selection: Selection,
  coords: ClickCoords | null,
): number | null {
  if (!(selection instanceof NodeSelection)) return null;
  if (!selection.node.isTextblock) return null;
  const cell = cellAround(selection.$from);
  if (cell === null || cell.nodeAfter === null) return null;
  const from = cell.pos + 1;
  const to = cell.pos + cell.nodeAfter.nodeSize - 1;
  const anchor = coords !== null ? clamp(coords.pos, from, to) : from;
  return nearestTextInCell(doc, anchor, from, to);
}

/**
 * 算出"这次点击应该把光标放到哪个文字位置" ✓。
 *
 * 只有在**这一个前提**下才接管：点击落在**表格单元格**里、而且命中的不是文字位置、
 * 也不是真正的原子块（图片 / 公式 ⇒ 单击选中它们是**要的**行为 ✗）。
 *
 * @param state - 点击时的编辑器状态 ✓。
 * @param coords - `view.posAtCoords(...)` 的结果；拿不到传 `null` ✓。
 * @returns 应该落到的文字位置；**不该接管时返回 `null`** ✓（交回 ProseMirror 原生 ✓）。
 */
export function caretTargetForClick(state: EditorState, coords: ClickCoords | null): number | null {
  if (coords === null) return null;
  /*
   * ① 只接管**单元格里**的点击 ✓：
   * 用 `inside`（点到哪个节点前面）判单元格 —— 点在单元格内边距时 `inside` 正是那个段落的位置 ✓；
   * 表格外的结构点击一律不动 ✗。
   */
  const probe = coords.inside >= 0 ? coords.inside : coords.pos;
  const cell = cellAround(state.doc.resolve(probe));
  if (cell === null || cell.nodeAfter === null) return null;
  const from = cell.pos + 1;
  const to = cell.pos + cell.nodeAfter.nodeSize - 1;
  /* ② 点在**真正的文字位置**上 ⇒ 原生处理得对 ✓（不抢 ✗） */
  if (coords.inside === -1) return null;
  /* ③ 点到的是**真原子块**（图片 / 公式 / 分隔线）⇒ 单击选中它是它唯一的操作方式 ✗ */
  const node = state.doc.nodeAt(coords.inside);
  if (node !== null && !node.isTextblock) return null;
  /* ④ 其余情况：按坐标找最近的合法文字位置 ✓（空白内边距 / 空行 / 空单元格 ✓） */
  return nearestTextInCell(state.doc, clamp(coords.pos, from, to), from, to);
}

/**
 * **兜底**：点击已经结束时，如果选区仍然是"单元格里 textblock 的结构选择"，
 * 就按点击坐标把它改成合法文字位置 ✓。
 *
 * 定位到真正的根因之后（上游 `TableNodeView.stopEvent` + rAF 派发 ✓，
 * 见本文件顶部注释 ✓），**主修复已经挪到 `view.dispatch` 那只漏斗上** ✓；
 * 这一条留作纵深防御 ✓（只认那一种坏状态：文字选区 / 真原子块 / 表格外的结构选择一律不动 ✗）。
 *
 * @param state - 点击结束后的编辑器状态 ✓。
 * @param coords - 这次点击的 `view.posAtCoords(...)` 结果；拿不到传 `null` ✓。
 * @returns 应该落到的文字位置；不需要兜底时返回 `null` ✓。
 */
export function caretTargetForSelection(state: EditorState, coords: ClickCoords | null): number | null {
  return caretTargetForTextblockSelection(state.doc, state.selection, coords);
}

/**
 * **点正文下方那块空白 ⇒ 光标该落在哪** ✓（用户实测：在最后一个块下面点一下毫无反应，
 * 于是 `/` 命令在那里根本用不了 ✗ —— 想加表格 / 公式只能先跑到上面去回车 ✓）。
 *
 * 规则（与 Typora / Notion 的直觉一致 ✓）：
 * - 文档末尾**已经是空段落** ⇒ 直接用最后那个空位置 ✓（不无脑再加一个空行 ✗）；
 * - 否则在**文档末尾插入一个空段落**并把光标放进去 ✓
 *   ⇒ 接下来敲 `/` 就是"新建一个块"，而不是继续编辑最后一个列表项 / 表格 ✗。
 *
 * 纯逻辑：不碰 DOM、不派发事务 ✓（调用方拿着结果去 `dispatch` ✓）。
 *
 * @param state - 点击时的编辑器状态 ✓。
 * @returns `insert: false` 时 `pos` 就是空段落里的文字位置；
 *          `insert: true` 时先在 `pos`（= 文档末尾）插入一个空段落，光标落在 `pos + 1` ✓；
 *          schema 里没有 `paragraph` 时返回 `null` ✓（绝不硬造节点 ✗）。
 */
export function trailingParagraphTarget(state: EditorState): { pos: number; insert: boolean } | null {
  const paragraph = state.schema.nodes.paragraph;
  if (paragraph === undefined) return null;
  const last = state.doc.lastChild;
  if (last !== null && last.type === paragraph && last.content.size === 0) {
    /* 空段落占 [size-2, size] ⇒ 里面的文字位置是 size-1 ✓ */
    return { pos: state.doc.content.size - 1, insert: false };
  }
  return { pos: state.doc.content.size, insert: true };
}

/** 找到 `pos` 处（或包含它的）那张表格的**第一个单元格范围** ✓ */
function firstCellRange(state: EditorState, pos: number): { from: number; to: number } | null {
  let table: Node | null = null;
  let start = pos;
  const direct = state.doc.nodeAt(pos);
  if (direct !== null && direct.type.spec.tableRole === "table") {
    table = direct;
  } else {
    /* `posAtDOM` 也可能给到表格**内部**的位置 ⇒ 沿祖先找最近的表格 ✓ */
    const clamped = Math.min(Math.max(pos, 1), state.doc.content.size);
    const $pos = state.doc.resolve(clamped);
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      const node = $pos.node(depth);
      if (node.type.spec.tableRole === "table") {
        table = node;
        start = $pos.before(depth);
        break;
      }
    }
  }
  if (table === null) return null;
  const cell = table.firstChild?.firstChild ?? null;
  if (cell === null) return null;
  /* table(+1) → row(+1) → cell(+1) ⇒ 第一个单元格的内容起点就是 start + 3 ✓ */
  const from = start + 3;
  return { from, to: from + cell.nodeSize - 1 };
}

/**
 * 这张表格里**第一个单元格的第一个合法文字位置** ✓。
 *
 * 用途（`design/table-interaction-and-row-column-functions-review.md` P2a ✓）：
 * 鼠标悬停表格时入口就该出现 ⇒ 用户点开菜单时，先把光标放进**这张**表格 ✓
 * —— 复查要求"操作目标来自最后有效单元格选区，**不能通过改变选区来显示入口**"✗：
 * 显示入口时一个事务都不发 ✓，只有用户真的点开才动一次选区 ✓。
 *
 * @param state - 编辑器状态 ✓。
 * @param tablePos - 表格的位置（`view.posAtDOM(block, 0)` 给的位置，可能在表格里或表格前 ✓）。
 * @returns 合法文字位置；找不到返回 `null` ✓。
 */
export function firstCaretInTable(state: EditorState, tablePos: number): number | null {
  const range = firstCellRange(state, tablePos);
  if (range === null) return null;
  return nearestTextInCell(state.doc, range.from, range.from, range.to);
}
