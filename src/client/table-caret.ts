/**
 * **表格单元格点击 → 文字插入位置**（`design/table-click-jitter-and-caret-analysis.md` ✓）。
 *
 * 复查实测的坏状态：在单元格**空白处**（内边距、空行、比文字更高的行）普通点击时，
 * ProseMirror 的 `selectClickedLeaf` 会命中一个 `isAtom` 节点 —— 而 `isAtom` 对
 * **textblock（段落 / 标题 / 代码块）也为真** ✗ ⇒ 直接建了一个 **NodeSelection**：
 * 浏览器选区不折叠、`ProseMirror-hideselection` 上身，而我们又把亮框 CSS 撤掉了
 * ⇒ 看不见却整段被选中，一敲字整段被替换 ✗。
 *
 * 上一版的做法是"**先让原组件建好节点选择，再在 mouseup + 微任务里纠正**" ✗ ——
 * 复查指出它会带来两次选区/聚焦/滚动（抖动的嫌疑来源 ✓），而且竖线出现得晚 ✓。
 * 现在改成接在 ProseMirror 的 **`handleClick`** 上：在它默认的 `selectClickedLeaf` **之前**
 * 直接落下合法文字位置 ✓（见 `MarkdownRichEditor` 的 `view.setProps` ✓）——
 * 只有**一次**选区变化 ✓，也不需要第二次聚焦 ✓。
 *
 * 这里只有纯逻辑（不碰 DOM、不碰 React ✓）：`view.posAtCoords` 的结果由调用方传进来 ✓。
 */
import { TextSelection, type EditorState } from "@milkdown/kit/prose/state";
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
function nearestTextInCell(state: EditorState, anchor: number, from: number, to: number): number | null {
  const $anchor = state.doc.resolve(anchor);
  const candidates: number[] = [];
  if ($anchor.parent.inlineContent) candidates.push($anchor.pos);
  /* 前后各找一个（`Selection.near` 在找不到时会给整篇选择，夹回单元格后会被下面的合法性检查刷掉 ✓） */
  candidates.push(TextSelection.near($anchor, 1).from);
  candidates.push(TextSelection.near($anchor, -1).from);
  /* 空单元格的兜底：这个单元格第一行的起点 ✓ */
  candidates.push(TextSelection.near(state.doc.resolve(from), 1).from);

  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const inside = clamp(candidate, from, to);
    if (!state.doc.resolve(inside).parent.inlineContent) continue; /* 不是合法插入点 ⇒ 跳过 ✓ */
    const distance = Math.abs(inside - anchor);
    if (distance < bestDistance) {
      best = inside;
      bestDistance = distance;
    }
  }
  return best;
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
  return nearestTextInCell(state, clamp(coords.pos, from, to), from, to);
}
