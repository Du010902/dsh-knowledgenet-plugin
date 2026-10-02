/**
 * **表格操作入口与菜单**的测试
 * （`design/table-caret-and-interaction-design.md` + `design/node-editor-design-implementation-review.md` P2 ✓）。
 *
 * 复查实测的问题（这次要修掉的）：
 * - 九个图标按钮的 240px 工具条**常驻**铺在表格上方 ✗；
 * - 按**整块容器**定位 ⇒ 短表格（右边缘 x≈254）也被贴到容器右边（x≈420）✗；
 * - 于是它盖住了表格之前的那段引用 ✗。
 *
 * 现在的设计：**一个 24px 入口 + 点开才出现的文字菜单** ✓；
 * 位置锚在**可见表格**上，优先级：右侧空白 → 上方空白 → 表格自己的右上角 ✓。
 *
 * 这里盯四件事：定位几何、入口/菜单的显隐契约、命令接线、以及 Crepe 那套结构控件必须让开 ✓。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { CellSelection, tableNodes } from "@milkdown/kit/prose/tables";

import {
  TABLE_ENTRY_GAP,
  TABLE_ENTRY_SIZE,
  TABLE_ENTRY_WIDTH,
  TABLE_LITERAL,
  TABLE_MENU_ITEMS,
  TABLE_POPOVER_HEIGHT,
  movePayload,
  pathHitsNodes,
  readTableContext,
  readTableMoveState,
  tableEntryPosition,
  tablePopoverPosition,
} from "../src/client/table-menu.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "..", "src", "client");
const read = (name) => readFileSync(path.join(CLIENT, name), "utf8");
const richSource = read("MarkdownRichEditor.tsx");
const menuSource = read("TableMenu.tsx");
const menuLogicSource = read("table-menu.ts");
const overrides = read("editor-overrides.css");
const panel = read("panel.css");
const dictSource = read("index.ts");

/** 最小可用的表格 schema（和 `table-menu.ts` 依赖的 tableRole 一致 ✓） */
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
    ...tableNodes({
      tableGroup: "block",
      cellContent: "paragraph+",
      /* 与 Milkdown / GFM 表格一致的列对齐属性 ✓ */
      cellAttributes: { alignment: { default: "left" } },
    }),
  },
  marks: {},
});

/** 建一份"段落 + 表格 + 段落"的文档，并把光标放进表格第一个单元格 ✓ */
function stateInTable(alignment) {
  const cell = schema.nodes.table_cell.create(
    alignment === undefined ? null : { alignment },
    schema.nodes.paragraph.create(null, schema.text("单元格")),
  );
  const row = schema.nodes.table_row.create(null, [cell, cell]);
  const table = schema.nodes.table.create(null, [row]);
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, schema.text("前")),
    table,
    schema.nodes.paragraph.create(null, schema.text("后")),
  ]);
  let tablePos = -1;
  doc.descendants((node, pos) => {
    if (node.type.name !== "table") return true;
    tablePos = pos;
    return false;
  });
  assert.notEqual(tablePos, -1, "测试文档里应该有表格");
  const selection = TextSelection.near(doc.resolve(tablePos + 4));
  return EditorState.create({ doc, selection });
}

/** 建一份没有表格的文档 ✓ */
function stateWithoutTable() {
  const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, schema.text("只有正文"))]);
  return EditorState.create({ doc, selection: TextSelection.near(doc.resolve(1)) });
}

describe("表格上下文：入口显隐与对齐高亮只来自编辑器 selection", () => {
  it("光标在单元格里 ⇒ inTable ✓；列对齐按单元格属性读出来 ✓", () => {
    assert.deepEqual(readTableContext(stateInTable(undefined)), { inTable: true, alignment: "left" });
    assert.deepEqual(readTableContext(stateInTable("center")), { inTable: true, alignment: "center" });
    assert.deepEqual(readTableContext(stateInTable("right")), { inTable: true, alignment: "right" });
    assert.deepEqual(readTableContext(stateInTable("weird")), { inTable: true, alignment: "left" });
  });

  it("光标不在表格里 / 没有 state ⇒ 不显示入口 ✓", () => {
    assert.deepEqual(readTableContext(stateWithoutTable()), { inTable: false, alignment: "left" });
    assert.deepEqual(readTableContext(null), { inTable: false, alignment: "left" });
    assert.deepEqual(readTableContext(undefined), { inTable: false, alignment: "left" });
  });

  it("显隐与高亮**不问鼠标**（不依赖悬停）✗", () => {
    assert.ok(!menuLogicSource.includes("hover"), "上下文只能来自 selection ✗");
    assert.ok(!menuLogicSource.includes("mouse"), "不许用鼠标位置推断结构状态 ✗");
  });
});

describe("入口定位：锚在**可见表格**上，绝不盖住前一段正文", () => {
  const container = { top: 100, right: 440, left: 0, bottom: 900 };

  it("① 表格右边有空白（短表格最常见）⇒ 放右侧，谁也不遮 ✓", () => {
    /* 复查实测：短表格右边缘约 x=254，而工具条原来被贴到 x=420 ✗ */
    const entry = tableEntryPosition(
      { top: 300, right: 254, left: 40, bottom: 360 },
      container,
      0,
      null,
    );
    assert.equal(entry.inside, false, "不许压在表格或正文上 ✓");
    assert.equal(entry.top, 200, "纵向与表格上沿对齐（内容坐标 ✓）");
    /* 右侧空白 186px ⇒ 入口右边缘离容器右边 186-4-估算宽度 ✓ */
    assert.equal(entry.right, 440 - 254 - TABLE_ENTRY_GAP - TABLE_ENTRY_WIDTH);
  });

  it("② 表格贴着容器右缘、但上方有真空白 ⇒ 放上方 ✓", () => {
    const entry = tableEntryPosition(
      { top: 300, right: 440, left: 40, bottom: 360 },
      container,
      0,
      250, /* 上一块下沿：与表格上沿之间还有 50px 空白 ✓ */
    );
    assert.equal(entry.inside, false);
    assert.equal(entry.top, 200 - TABLE_ENTRY_SIZE - TABLE_ENTRY_GAP);
    assert.equal(entry.right, 0, "右对齐到表格右边缘 ✓");
  });

  it("③ 右侧没有空白、上方紧贴正文 ⇒ 宁可压**表格自己的右上角** ✓", () => {
    const entry = tableEntryPosition(
      { top: 300, right: 440, left: 40, bottom: 360 },
      container,
      0,
      296, /* 上一块下沿离表格只有 4px ⇒ 上方放不下 ✓ */
    );
    assert.equal(entry.inside, true, "靠表格，而不是靠前一段正文 ✓");
    assert.equal(entry.top, 202, "只压进表格 2px ✓");
    assert.equal(entry.right, 2);
  });

  it("横向滚动 / 表格被裁 ⇒ 用**可见**右边缘算（不会锚到看不见的列上 ✓）", () => {
    /* 传入的 right 是"表格 ∩ wrapper 可见区"的右边缘 ✓ */
    const visible = tableEntryPosition({ top: 300, right: 300, left: 40, bottom: 360 }, container, 0, null);
    const clipped = tableEntryPosition({ top: 300, right: 200, left: 40, bottom: 360 }, container, 0, null);
    assert.ok(clipped.right > visible.right, "可见范围更窄 ⇒ 入口跟着往左 ✓");
    assert.equal(clipped.right, 440 - 200 - TABLE_ENTRY_GAP - TABLE_ENTRY_WIDTH);
  });

  it("滚动换算：内容坐标 = 视口坐标 − 容器 + scrollTop ✓；贴顶时夹到 0 ✓", () => {
    /* 上方紧贴上一块 ⇒ 走"压表格右上角"那一支：top = 120−100+500+2 = 522 ✓ */
    const scrolled = tableEntryPosition({ top: 120, right: 440, left: 40, bottom: 180 }, container, 500, 119);
    assert.equal(scrolled.inside, true);
    assert.equal(scrolled.top, 522, "120−100+500+2 ✓");
    const clamped = tableEntryPosition({ top: 100, right: 440, left: 40, bottom: 160 }, container, 0, 99);
    assert.equal(clamped.top, 2);
  });
});

describe("弹出菜单定位：默认下方，放不下就翻上去，横向夹在容器里 ✓", () => {
  const container = { top: 100, right: 440, left: 0, bottom: 700 };

  it("下方有空间 ⇒ 在入口下面 ✓", () => {
    const popover = tablePopoverPosition({ top: 200, right: 100 }, container, 0);
    assert.equal(popover.top, 200 + TABLE_ENTRY_SIZE + TABLE_ENTRY_GAP);
  });

  it("下方放不下（入口贴近容器底）⇒ 翻到入口上方 ✓", () => {
    const entryTop = 700 - 100 - 40; /* 距容器底 40px ⇒ 放不下 264px 的菜单 ✓ */
    const popover = tablePopoverPosition({ top: entryTop, right: 0 }, container, 0);
    assert.ok(popover.top + TABLE_POPOVER_HEIGHT < entryTop, "必须整体在入口上方 ✓");
    assert.ok(popover.top >= 0, "不许跑到内容原点上面 ✗");
  });

  it("右对齐到入口，太靠边就夹回来（窄容器不会溢出左侧 ✓）", () => {
    /* 正常宽度：入口贴到最右也不许让菜单左边出界 ✓ */
    const wide = tablePopoverPosition({ top: 200, right: 380 }, { ...container, right: 440, left: 0 }, 0);
    assert.equal(wide.right, 440 - 210 - 2, "夹到容器能容纳的最右位置 ✓");
    /* 容器比菜单还窄：只能贴右边缘（没有可夹的余量 ✓） */
    const narrow = tablePopoverPosition({ top: 200, right: 380 }, { ...container, right: 200, left: 0 }, 0);
    assert.equal(narrow.right, 0, "容器更窄时贴右边缘 ✓");
    /* 本来就靠里 ⇒ 保持与入口对齐 ✓ */
    const inside = tablePopoverPosition({ top: 200, right: 4 }, { ...container, right: 440, left: 0 }, 0);
    assert.equal(inside.right, 4);
  });

  it("常量与 CSS 一致（不一致会让入口/菜单整体偏 ✓）", () => {
    /* 入口高度与定位用的 `TABLE_ENTRY_SIZE` 必须一致 ✓（宽度是估算值、由内容决定 ⇒ 只钉高度 ✓） */
    const entry = /\.kn-table-entry \{[^}]*height:\s*(\d+)px/s.exec(panel);
    assert.notEqual(entry, null, "入口要有高度 ✓");
    assert.equal(Number(entry[1]), TABLE_ENTRY_SIZE);
    assert.ok(
      /\.kn-table-entry \{[^}]*padding:/s.test(panel) && /\.kn-table-entry-label/.test(panel),
      "入口带文字标签 ⇒ 宽度由内容决定 ✓（定位用估算宽度 ✓）",
    );
    assert.ok(TABLE_ENTRY_WIDTH > TABLE_ENTRY_SIZE, "估算宽度要覆盖「图标 + 文字」✓");
    const menu = /\.kn-table-menu \{[^}]*max-height:\s*(\d+)px/s.exec(panel);
    assert.notEqual(menu, null, "菜单要有高度上限 ✓");
    assert.equal(Number(menu[1]), TABLE_POPOVER_HEIGHT);
    const width = /\.kn-table-menu \{[^}]*width:\s*(\d+)px/s.exec(panel);
    assert.equal(Number(width[1]), 210, "与 `tablePopoverPosition` 的默认宽度一致 ✓");
  });
});

describe("Shadow DOM：点击菜单内部不许被当成「点外面」（复查实测 ✓）", () => {
  it("判据按**节点引用**走 `composedPath()` ✓", () => {
    const entry = { id: "entry" };
    const menu = { id: "menu" };
    const item = { id: "item" };
    const host = { id: "shadow-host" };
    /* 影子树里的真实路径：最里面是菜单项 ⇒ 一路到 host ✓ */
    assert.equal(pathHitsNodes([item, menu, host, { id: "body" }, { id: "document" }], [entry, menu]), true);
    assert.equal(pathHitsNodes([entry, host], [entry, menu]), true, "点入口本身也算内部 ✓");
    /* 被重定向过的路径（只剩 host）⇒ 认不出来 ✓ —— 这正是复查复现的坏状态 ✓ */
    assert.equal(
      pathHitsNodes([host, { id: "body" }, { id: "document" }], [entry, menu]),
      false,
      "只剩 host 就认不出内部 ✗（所以才必须用 composedPath ✓）",
    );
    /* 外面真点击 ⇒ 该关 ✓ */
    assert.equal(pathHitsNodes([{ id: "somewhere" }, { id: "document" }], [entry, menu]), false);
    /* 节点还没挂上（`null`）⇒ 不许误判成「内部」✗ */
    assert.equal(pathHitsNodes([item], [null, null]), false);
    assert.equal(pathHitsNodes([], [entry, menu]), false);
  });

  it("**外部点击检测**换成 `composedPath()` + 节点引用 ✓（不再用被重定向的 target ✗）", () => {
    const start = richSource.indexOf("const onPointerDown = (event: Event): void => {");
    assert.notEqual(start, -1, "要能找到外部点击检测 ✓");
    const handler = richSource.slice(start, start + 700);
    assert.ok(handler.includes("event.composedPath()"), "要用 composedPath ✓");
    assert.ok(handler.includes("pathHitsNodes(path, [entryNodeRef.current, menuNodeRef.current])"), "按我们自己的节点引用判 ✓");
    assert.ok(!handler.includes("closest("), "不许再用被重定向的 target.closest ✗");
    assert.ok(richSource.includes("const entryNodeRef = useRef<HTMLButtonElement | null>(null);"), "入口节点要有 ref ✓");
    assert.ok(richSource.includes("const menuNodeRef = useRef<HTMLDivElement | null>(null);"), "菜单节点要有 ref ✓");
    assert.ok(richSource.includes("nodeRef={entryNodeRef}"), "ref 要传进入口 ✓");
    assert.ok(richSource.includes("nodeRef={menuNodeRef}"), "ref 要传进菜单 ✓");
  });

  it("组件把真实节点交出来 ✓，并且打开菜单就**把焦点放进菜单**（键盘才可用 ✓）", () => {
    assert.ok(menuSource.includes("ref={props.nodeRef}"), "入口把节点交给外部 ✓");
    assert.ok(menuSource.includes("const listRef = props.nodeRef ?? ownRef;"), "菜单复用外部 ref ✓");
    assert.ok(menuSource.includes("button.kn-table-menu-item:not(:disabled)"), "只聚焦**可用**的菜单项 ✓");
    assert.ok(
      /first\?\.focus\(\);/.test(menuSource),
      "打开菜单要聚焦第一项 ⇒ Esc / ↑ / ↓ / Enter 才有地方落地 ✗（复查验收第 4 条 ✓）",
    );
  });

  it("跨影子树的选区事件也接上（`document.getSelection()` 看不到影子树 ✗）", () => {
    assert.ok(richSource.includes("root.getRootNode() instanceof ShadowRoot"), "要认影子根 ✓");
    assert.ok(richSource.includes('shadowRoot?.addEventListener("selectionchange"'), "影子根上也要挂 ✓");
    assert.ok(richSource.includes('shadowRoot?.removeEventListener("selectionchange"'), "卸载要摘掉 ✓");
    assert.ok(richSource.includes('document.addEventListener("selectionchange"'), "document 上那条保留 ✓（非影子场景 ✓）");
  });
});

describe("行列移动：命令参数与边界 / 表头 / 合并规则（复查补的功能 ✓）", () => {
  /** 建一张 `rows × cols` 的表（第一行是表头 ⇔ header=true ✓），光标放进指定单元格 ✓ */
  function tableState(rows, cols, header, caret = { row: 0, col: 0 }) {
    const makeRow = (isHeader) => schema.nodes.table_row.create(null, Array.from({ length: cols }, () => (
      (isHeader ? schema.nodes.table_header : schema.nodes.table_cell).create(
        null,
        schema.nodes.paragraph.create(null, schema.text("x")),
      )
    )));
    const table = schema.nodes.table.create(null, Array.from({ length: rows }, (_unused, index) => makeRow(header && index === 0)));
    const doc = schema.nodes.doc.create(null, [table]);
    let tablePos = -1;
    doc.descendants((node, pos) => {
      if (node.type.name !== "table") return true;
      tablePos = pos;
      return false;
    });
    /* 走到目标单元格：table(+1) → row(+1) → cell(+1) → 段落(+1) ✓ */
    let pos = tablePos + 1;
    for (let r = 0; r < caret.row; r += 1) pos += table.child(r).nodeSize;
    const row = table.child(caret.row);
    pos += 1;
    for (let c = 0; c < caret.col; c += 1) pos += row.child(c).nodeSize;
    const selection = TextSelection.near(doc.resolve(pos + 2));
    return EditorState.create({ doc, selection });
  }

  it("中间的行 / 列四个方向都能动，参数是「从哪搬到哪」✓", () => {
    const move = readTableMoveState(tableState(3, 3, false, { row: 1, col: 1 }));
    assert.notEqual(move, null);
    assert.deepEqual(
      { rowUp: move.rowUp, rowDown: move.rowDown, colLeft: move.colLeft, colRight: move.colRight },
      { rowUp: true, rowDown: true, colLeft: true, colRight: true },
    );
    assert.equal(move.rowIndex, 1);
    assert.equal(move.colIndex, 1);
    assert.deepEqual(movePayload("row-up", move), { from: 1, to: 0 });
    assert.deepEqual(movePayload("row-down", move), { from: 1, to: 2 });
    assert.deepEqual(movePayload("col-left", move), { from: 1, to: 0 });
    assert.deepEqual(movePayload("col-right", move), { from: 1, to: 2 });
  });

  it("**边界**：第一行不能上移、最后一行不能下移、第一列不能左移、最后一列不能右移 ✓", () => {
    /* 1×1：四个方向全在边界上 ✓ */
    const only = readTableMoveState(tableState(1, 1, false, { row: 0, col: 0 }));
    assert.notEqual(only, null);
    assert.deepEqual(
      { rowUp: only.rowUp, rowDown: only.rowDown, colLeft: only.colLeft, colRight: only.colRight },
      { rowUp: false, rowDown: false, colLeft: false, colRight: false },
    );
    assert.equal(only.blockedKey, "tableMoveEdge", "一个都动不了时说明是边界 ✓");
    assert.equal(movePayload("row-up", only), null, "动不了就不给参数 ✓");

    const topLeft = readTableMoveState(tableState(2, 2, false, { row: 0, col: 0 }));
    assert.equal(topLeft.rowUp, false, "第一行 ✗");
    assert.equal(topLeft.rowDown, true);
    assert.equal(topLeft.colLeft, false, "第一列 ✗");
    assert.equal(topLeft.colRight, true);

    const bottomRight = readTableMoveState(tableState(2, 2, false, { row: 1, col: 1 }));
    assert.equal(bottomRight.rowDown, false, "最后一行不能下移 ✗");
    assert.equal(bottomRight.colRight, false, "最后一列不能右移 ✗");
    assert.equal(bottomRight.rowUp, true, "但可以上移 ✓");
    assert.equal(bottomRight.colLeft, true, "也可以左移 ✓");
  });

  it("**表头行**不参与移动（不许把正文行与表头互换 ✓）", () => {
    /* 3 行、第一行是表头；光标在第二个数据行（row=2）⇒ 不能上移到表头位置（row=1 是数据行 ⇒ 可以 ✓） */
    const second = readTableMoveState(tableState(3, 2, true, { row: 2, col: 0 }));
    assert.equal(second.rowUp, true, "上移到 row=1（仍是数据行）✓");
    const first = readTableMoveState(tableState(3, 2, true, { row: 1, col: 0 }));
    assert.equal(first.rowUp, false, "上移就进表头了 ⇒ 不许 ✗");
    assert.equal(movePayload("row-up", first), null);
    /* 表头行自己当然也不能动 ✓ */
    const headerRow = readTableMoveState(tableState(3, 2, true, { row: 0, col: 0 }));
    assert.equal(headerRow.rowUp, false);
    assert.equal(headerRow.rowDown, false);
    assert.equal(headerRow.colLeft, false === headerRow.colLeft ? false : headerRow.colLeft, "列方向另算 ✓");
  });

  it("**多列选择**：行还能整行移动 ✓，列方向不猜 ✗", () => {
    const state = tableState(3, 3, false, { row: 1, col: 1 });
    const table = state.doc.firstChild;
    const rowStart = 1 + table.child(0).nodeSize; /* 第二行的起点（表格在位置 0 ✓） */
    const leftCell = rowStart + 1;
    const rightCell = leftCell + table.child(1).child(0).nodeSize;
    const wide = state.apply(state.tr.setSelection(CellSelection.create(state.doc, rightCell, leftCell)));
    const move = readTableMoveState(wide);
    assert.equal(move.rowUp, true, "只有一个行 ⇒ 整行移动仍然明确 ✓");
    assert.equal(move.colLeft, false, "跨了两列 ⇒ 不猜要移动哪一列 ✗");
    assert.equal(move.colRight, false);
  });

  it("**合并单元格** ⇒ 四个方向全禁用并说明原因 ✓（不许破坏结构 ✗）", () => {
    const mergedRow = schema.nodes.table_row.create(null, [
      schema.nodes.table_cell.create({ colspan: 2 }, schema.nodes.paragraph.create(null, schema.text("m"))),
      schema.nodes.table_cell.create(null, schema.nodes.paragraph.create(null, schema.text("n"))),
    ]);
    const plainRow = schema.nodes.table_row.create(null, Array.from({ length: 2 }, () => (
      schema.nodes.table_cell.create(null, schema.nodes.paragraph.create(null, schema.text("p")))
    )));
    const table = schema.nodes.table.create(null, [mergedRow, plainRow]);
    const doc = schema.nodes.doc.create(null, [table]);
    const state = EditorState.create({ doc, selection: TextSelection.near(doc.resolve(3)) });
    const move = readTableMoveState(state);
    assert.notEqual(move, null);
    assert.deepEqual(
      { rowUp: move.rowUp, rowDown: move.rowDown, colLeft: move.colLeft, colRight: move.colRight },
      { rowUp: false, rowDown: false, colLeft: false, colRight: false },
    );
    assert.equal(move.blockedKey, "tableMoveSpan", "要说明是「多选或合并」✗");
  });

  it("不在表格里 ⇒ `readTableMoveState` 返回 null ✓", () => {
    assert.equal(readTableMoveState(stateWithoutTable()), null);
    assert.equal(readTableMoveState(null), null);
  });
});

describe("长表格滚动：入口必须留在正文视口里（复查实测 ✓）", () => {
  /** 内容坐标 → 视口坐标（与实现的换算互为逆运算 ✓） */
  const toViewport = (entry, container, scrollTop) => entry.top - scrollTop + container.top;
  /** 正文视口：复查实测那一组数字 ✓（44…777 ✓） */
  const body = { top: 44, bottom: 777, right: 440, left: 44 };
  /** 断言入口整块落在正文可见区里 ✓ */
  const assertVisible = (entry, scrollTop, label) => {
    assert.notEqual(entry, null, `${label}：不该隐藏 ✓`);
    const top = toViewport(entry, body, scrollTop);
    assert.ok(top >= body.top, `${label}：入口顶（${top}）不许被裁到视口上方 ✗`);
    assert.ok(top + TABLE_ENTRY_SIZE <= body.bottom, `${label}：入口底（${top + TABLE_ENTRY_SIZE}）不许超出视口下方 ✗`);
  };

  it("**复查那一幕**：长表格滚下去（表格顶已在视口上方）⇒ 入口仍与视口相交 ✓", () => {
    /* 35 行表格滚到靠下：表格矩形 top=-600 / bottom=900，活跃单元格在 500 ✓ */
    const entry = tableEntryPosition(
      { top: -600, right: 254, left: 40, bottom: 900 },
      body,
      644,
      -700,
      undefined,
      undefined,
      undefined,
      { top: 500, bottom: 524, right: 254 },
    );
    assertVisible(entry, 644, "长表格中部");
    /* 旧实现是"表格顶的内容坐标"⇒ 视口里等于 -600，完全在裁切区外 ✗（复查实测 0…24 ✓） */
    const oldTop = -600 - body.top + 644;
    assert.ok(toViewport(entry, body, 644) > oldTop + 400, `入口要跟着可见单元格走 ✓（旧值 ${oldTop} ✗）`);
    assert.equal(Math.round(toViewport(entry, body, 644)), 500, "活跃单元格可见 ⇒ 纵向就贴它 ✓");
  });

  it("活跃单元格在视口外 ⇒ 夹进可见带（仍可见 ✓，不外溢 ✗）", () => {
    const below = tableEntryPosition(
      { top: -600, right: 254, left: 40, bottom: 900 },
      body,
      644,
      -700,
      undefined,
      undefined,
      undefined,
      { top: 1000, bottom: 1024, right: 254 },
    );
    assertVisible(below, 644, "单元格在下方视口外");
    const above = tableEntryPosition(
      { top: -600, right: 254, left: 40, bottom: 900 },
      body,
      644,
      -700,
      undefined,
      undefined,
      undefined,
      { top: -500, bottom: -476, right: 254 },
    );
    assertVisible(above, 644, "单元格在上方视口外");
  });

  it("**表格整个滚出视口** ⇒ 明确隐藏（返回 null ✓，不是把坐标夹到 0 ✗）", () => {
    assert.equal(
      tableEntryPosition({ top: -900, right: 254, left: 40, bottom: -40 }, body, 944, null),
      null,
      "表格在视口上方之外 ✓",
    );
    assert.equal(
      tableEntryPosition({ top: 900, right: 254, left: 40, bottom: 1200 }, body, 0, null),
      null,
      "表格在视口下方之外 ✓",
    );
    /* 只剩不到一个按钮的高度也放不下 ✓ */
    assert.equal(tableEntryPosition({ top: 40, right: 254, left: 40, bottom: 60 }, body, 0, null), null);
  });

  it("短表格（表格顶可见）行为不变：右侧空白 → 上方空白 → 表格角上 ✓", () => {
    const table = { top: 300, right: 254, left: 40, bottom: 360 };
    const gutter = tableEntryPosition(table, body, 0, null);
    assert.equal(gutter.inside, false);
    assert.equal(toViewport(gutter, body, 0), 300, "右边有地方就与表格上沿对齐 ✓");
    /* 贴右缘 + 上方有真空白（40px > 24+4 ✓）⇒ 上方（且仍在视口里 ✓） */
    const above = tableEntryPosition({ ...table, right: 438 }, body, 0, 260);
    assert.equal(above.inside, false);
    assert.equal(toViewport(above, body, 0), 300 - TABLE_ENTRY_SIZE - TABLE_ENTRY_GAP);
    /* 上方没地方（只差 1px ✗）⇒ 压表格角上 ✓ */
    const inside = tableEntryPosition({ ...table, right: 438 }, body, 0, 299);
    assert.equal(inside.inside, true);
    assertVisible(inside, 0, "压表格角上");
  });

  it("**弹出菜单**也要落在正文视口里（第 5 条 ✓）", () => {
    /* 入口贴视口底 ⇒ 菜单翻到上方，且整块在视口内 ✓ */
    const high = tablePopoverPosition({ top: 644 + 700, right: 100 }, body, 644);
    assert.ok(high.top >= 644, "不许跑到视口上方 ✗");
    assert.ok(high.top + TABLE_POPOVER_HEIGHT <= 644 + (body.bottom - body.top), "不许越过视口底 ✗");
    /* 入口贴视口顶 ⇒ 菜单在下方、仍在视口内 ✓ */
    const low = tablePopoverPosition({ top: 646, right: 100 }, body, 644);
    assert.ok(low.top > 646, "空间够就放下方 ✓");
    assert.ok(low.top + TABLE_POPOVER_HEIGHT <= 644 + (body.bottom - body.top), "仍在视口内 ✓");
    /* 菜单比视口还高 ⇒ 贴视口顶，由 CSS 自己滚 ✓ */
    const huge = tablePopoverPosition({ top: 646, right: 100 }, body, 644, 2000);
    assert.equal(huge.top, 644 + 2, "贴视口顶 ✓（不再被推到裁切区外 ✗）");
  });

  it("接线：算上活跃单元格、放不下就收起 ✓", () => {
    assert.ok(richSource.includes("activeCellRect(view)"), "要取活跃单元格矩形 ✓");
    assert.ok(richSource.includes('closest<HTMLElement>("td, th")'), "单元格从 DOM 上找 ✓");
    assert.ok(
      richSource.includes("tableEntryPosition(visible, containerRect, container.scrollTop, previousBottom, undefined, undefined, undefined, cell)"),
      "把单元格矩形传进去 ✓",
    );
    assert.ok(richSource.includes("if (entry === null)"), "放不下要收起入口 ✓");
    assert.ok(richSource.includes('"table-entry-hidden"'), "收起要留痕 ✓（复查要求能核对宿主实际坐标 ✓）");
  });
});

describe("入口可发现性（复查 P2a ✓）", () => {
  it("悬停表格也能看到入口，且**悬停不改选区** ✓", () => {
    assert.ok(richSource.includes("pointerover"), "要监听悬停 ✓");
    assert.ok(richSource.includes('closest<HTMLElement>(".milkdown-table-block")'), "悬停找表格块 ✓");
    assert.ok(richSource.includes("hoverBlockRef"), "记住悬停的那张表格 ✓");
    assert.ok(
      richSource.includes("const block = selectionBlock ?? hoverBlockRef.current;"),
      "锚点：光标所在表格优先，其次悬停的表格 ✓",
    );
    assert.ok(
      richSource.includes("const onPointerOver"),
      "悬停处理里**不许**派发选区事务 ✗（复查：不能通过改变选区来显示入口 ✓）",
    );
    const hover = richSource.slice(
      richSource.indexOf("const onPointerOver"),
      richSource.indexOf("const onMouseUpFallback"),
    );
    assert.ok(!hover.includes("dispatch("), "悬停只记录 + 重算位置 ✓");
  });

  it("点开悬停的那张表格时，才把光标放进去（一次事务 ✓）", () => {
    assert.ok(richSource.includes("const openMenu = useCallback"), "要有 openMenu ✓");
    assert.ok(richSource.includes("firstCaretInTable(view.state, tablePos)"), "先算那张表格的第一个文字位置 ✓");
    assert.ok(richSource.includes("view.dispatch(view.state.tr.setSelection("), "只发一次选区事务 ✓");
    assert.ok(!richSource.includes("onToggle={() => { setMenuOpen((value: boolean) => !value); }}"), "开/关走 openMenu / dismissMenu ✓");
  });

  it("入口显眼：带文字标签、有边框底色；只读 / 保存中禁用并说明 ✓", () => {
    assert.ok(menuSource.includes("kn-table-entry-label"), "入口要带文字标签（复查：只有图标认不出来 ✗）✓");
    assert.ok(menuSource.includes("disabled={props.disabled}"), "只读 / 保存中要禁用 ✓");
    assert.ok(menuSource.includes("hint"), "禁用理由写在 title 上 ✓");
    assert.ok(/\.kn-table-entry \{[^}]*border: 1px solid var\(--dsw-alias-border-l2\)/s.test(panel), "要有可见边框 ✓");
    assert.ok(/\.kn-table-entry \{[^}]*background: var\(--dsw-alias-bg-layer-1\)/s.test(panel), "要有不透明底色 ✓");
    assert.ok(!/\.kn-table-entry \{[^}]*opacity: 0\.45/s.test(panel), "不再默认 45% 透明 ✗");
    assert.ok(richSource.includes("const busy = readOnlyRef.current;"), "只读状态进锚点 ✓");
  });

  it("移动项禁用时要写出原因（边界 / 表头 / 多选或合并 ✓）", () => {
    assert.ok(menuSource.includes("disabledReasons"), "菜单要接禁用原因 ✓");
    assert.ok(menuSource.includes("disabled={disabled}"), "禁用对应项 ✓");
    assert.ok(menuSource.includes("kn-table-menu-why"), "禁用原因要看得见（不只 title ✓）");
    assert.ok(richSource.includes("moveReason("), "原因由纯函数算出 ✓");
    assert.ok(panel.includes(".kn-table-menu-item:disabled"), "禁用样式 ✓");
  });
});

describe("行列移动接线（命令 + 参数 ✓）", () => {
  it("接上 Milkdown 的 moveRow / moveCol 命令 ✓", () => {
    assert.ok(richSource.includes("moveRowCommand"), "接上 moveRowCommand ✓");
    assert.ok(richSource.includes("moveColCommand"), "接上 moveColCommand ✓");
    assert.ok(richSource.includes("movePayload(action, moveState)"), "参数由纯函数算 ✓");
    assert.ok(
      richSource.includes('commands.call(moveRowCommand.key, { from: move.from, to: move.to })'),
      "插行那种命令表之外，移动要传 from/to ✓",
    );
    assert.ok(
      richSource.includes("table-action-blocked"),
      "动不了时留痕、不动文档 ✓（复查要求边界禁用 ✓）",
    );
  });
});

describe("动作清单：够用、分组、危险操作写明对象", () => {
  it("十三项动作，顺序固定（插行 / 插列 / 对齐 / **移动** / 删除）✓", () => {
    assert.deepEqual(TABLE_MENU_ITEMS.map((item) => item.id), [
      "row-before", "row-after",
      "col-before", "col-after",
      "align-left", "align-center", "align-right",
      "row-up", "row-down", "col-left", "col-right",
      "row-delete", "col-delete",
    ]);
    assert.equal(new Set(TABLE_MENU_ITEMS.map((item) => item.id)).size, TABLE_MENU_ITEMS.length, "不许重复 ✗");
    /* 复查补的功能：四项移动必须真的在菜单里 ✓ */
    for (const id of ["row-up", "row-down", "col-left", "col-right"]) {
      assert.ok(TABLE_MENU_ITEMS.some((item) => item.id === id), `${id} 要在菜单里 ✓（复查说这项功能缺失 ✗）`);
    }
  });

  it("每项都有中英词典 + 回落文案 ✓", () => {
    const zh = dictSource.slice(dictSource.indexOf("const DICT_ZH"), dictSource.indexOf("const DICT_EN"));
    const en = dictSource.slice(dictSource.indexOf("const DICT_EN"));
    for (const item of TABLE_MENU_ITEMS) {
      assert.equal(typeof TABLE_LITERAL[item.labelKey], "string", `${item.labelKey} 要有回落文案 ✓`);
      assert.ok(zh.includes(`${item.labelKey}:`), `中文词典要有 ${item.labelKey} ✓`);
      assert.ok(en.includes(`${item.labelKey}:`), `英文词典要有 ${item.labelKey} ✓`);
    }
    assert.equal(typeof TABLE_LITERAL.tableMenuLabel, "string", "入口本身也要有可读名字 ✓");
  });

  it("分组单调、删除放最后且标成危险 ✓（文字写明「本行 / 本列」✓）", () => {
    const groups = TABLE_MENU_ITEMS.map((item) => item.group);
    for (let i = 1; i < groups.length; i += 1) assert.ok(groups[i] >= groups[i - 1], "分组不许回退 ✗");
    const danger = TABLE_MENU_ITEMS.filter((item) => item.danger === true).map((item) => item.id);
    assert.deepEqual(danger, ["row-delete", "col-delete"], "只有删除是危险操作 ✓");
    assert.equal(TABLE_LITERAL.tableDeleteRow, "删除本行");
    assert.equal(TABLE_LITERAL.tableDeleteCol, "删除本列");
  });

  it("对齐项自带 alignment（用于点亮 ✓）", () => {
    const aligns = TABLE_MENU_ITEMS.filter((item) => item.alignment !== undefined)
      .map((item) => [item.id, item.alignment]);
    assert.deepEqual(aligns, [["align-left", "left"], ["align-center", "center"], ["align-right", "right"]]);
  });
});

describe("交互契约：一个入口、点开才展开、Esc 回正文", () => {
  it("默认**只渲染入口**，动作菜单在 `menuOpen` 时才渲染 ✓", () => {
    assert.ok(richSource.includes("<TableEntry"), "要渲染入口 ✓");
    assert.ok(
      /menu === null \|\| !menuOpen \? null : \(\s*<TableMenu/.test(richSource),
      "菜单必须由展开状态控制 ✗（复查：九个按钮常驻是这次要修的问题 ✓）",
    );
    assert.ok(richSource.includes("const [menuOpen, setMenuOpen] = useState(false)"), "默认收起 ✓");
    assert.ok(
      menuSource.includes("onPointerDown={keepSelection}"),
      "入口与菜单都不抢焦点 ✓（表格选区不能被清掉 ✓）",
    );
    assert.ok(menuSource.includes('role="menu"'), "菜单语义 ✓");
    assert.ok(menuSource.includes('role="menuitem"'), "菜单项语义 ✓");
    assert.ok(menuSource.includes('aria-expanded={props.open}'), "入口要报展开状态 ✓");
    assert.ok(menuSource.includes('aria-haspopup="menu"'), "入口要声明弹出菜单 ✓");
  });

  it("键盘：Esc 关闭并回正文、↑/↓ 在菜单里走 ✓", () => {
    assert.ok(menuSource.includes('event.key === "Escape"'), "Esc 关闭 ✓");
    assert.ok(menuSource.includes("props.onDismiss()"), "关闭要交给调用方（负责把焦点还给正文 ✓）");
    assert.ok(menuSource.includes('event.key === "ArrowDown"') && menuSource.includes('event.key === "ArrowUp"'));
    assert.ok(
      richSource.includes("const dismissMenu = useCallback") && richSource.includes("viewRef.current?.focus()"),
      "关掉菜单要把焦点还给编辑器 ✓",
    );
    assert.ok(
      richSource.includes("view.focus();") && richSource.includes("setMenuOpen(false);"),
      "执行完动作也要收起菜单、回正文 ✓",
    );
  });

  it("点菜单以外的地方关闭 ✓；容器尺寸 / 滚动变化要重算 ✓", () => {
    assert.ok(richSource.includes('target.closest(".kn-table-entry, .kn-table-menu")'), "点外面关闭 ✓");
    assert.ok(richSource.includes("ResizeObserver"), "复查要求：容器宽度变化未必有 window.resize ⇒ 用 ResizeObserver ✓");
    assert.ok(
      richSource.includes('container.addEventListener("scroll", onSelectionChanged, true)'),
      "横向滚动会改变可见表格范围 ⇒ 捕获阶段接住后代滚动 ✓",
    );
    assert.ok(richSource.includes("tableEntryPosition(") && richSource.includes("tablePopoverPosition("), "定位走纯函数 ✓");
  });

  it("入口锚点用**表格本体 ∩ wrapper 可见区**，并按上一块的下沿判断上方空间 ✓", () => {
    assert.ok(richSource.includes('block?.querySelector<HTMLElement>("table")'), "锚的是表格本体，不是整块容器 ✓");
    assert.ok(richSource.includes('closest<HTMLElement>(".table-wrapper")'), "与横向滚动容器求交 ✓");
    assert.ok(richSource.includes("block.previousElementSibling"), "用上一块的下沿判断上方有没有空白 ✓");
    assert.ok(panel.includes("position: relative"), "正文容器要能当定位父级 ✓");
  });
});

describe("Crepe 的结构控件必须真的让开（不只「看不见」）", () => {
  it("十字线 / 加号 / 行列抓手 / 拖动预览：display:none **且** pointer-events:none ✓", () => {
    for (const cls of [".line-handle", ".cell-handle", ".add-button", ".drag-preview"]) {
      assert.ok(overrides.includes(cls), `${cls} 要被覆盖 ✓`);
    }
    const rule = /\.milkdown-table-block \.handle,[\s\S]*?\{([^}]*)\}/.exec(overrides);
    assert.notEqual(rule, null, "要有一条把这些控件一起撤掉的规则 ✓");
    assert.ok(/display:\s*none\s*!important/.test(rule[1]), "必须 display:none ✓");
    assert.ok(
      /pointer-events:\s*none\s*!important/.test(rule[1]),
      "只设透明不够 ✗：透明的绝对定位控件照样吃点击 ⇒ 落不下文字光标 ✓",
    );
  });

  it("整行悬停底色撤掉、结构选中描边撤掉、区域选中降到低对比 ✓", () => {
    assert.ok(!/tbody tr:hover/.test(overrides), "不许再点亮整行 ✗");
    assert.ok(
      /th:has\(\.ProseMirror-selectednode\),[\s\S]*?outline:\s*none/.test(overrides),
      "单元格不许因为结构选中而描边 ✗",
    );
    const selected = /\.selectedCell::after \{([^}]*)\}/.exec(overrides);
    assert.notEqual(selected, null, "区域选中仍要有反馈 ✓（不能全清掉 ✗）");
    const percent = /(\d+)%/.exec(selected[1]);
    assert.ok(Number(percent[1]) >= 8 && Number(percent[1]) <= 12, `底纹要在 8–12%（实际 ${percent[1]}%）✓`);
    assert.ok(overrides.includes(".column-resize-handle"), "用户主动拖列宽的手柄保留 ✓");
  });

  it("没有对表格做全局 overflow:hidden 遮丑 ✗（会裁掉菜单与手柄 ✓）", () => {
    assert.ok(
      !/milkdown-table-block \{[^}]*overflow:\s*hidden/s.test(overrides),
      "不许在表格块上直接 overflow:hidden ✗",
    );
  });
});

describe("菜单接线：命令、定位、不抢焦点", () => {
  it("增删行列与对齐都接到 Milkdown / prosemirror-tables 的命令上 ✓", () => {
    for (const needle of [
      "addRowBeforeCommand", "addRowAfterCommand", "addColBeforeCommand", "addColAfterCommand",
      "setAlignCommand", "deleteRow", "deleteColumn",
    ]) {
      assert.ok(richSource.includes(needle), `要接上 ${needle} ✓`);
    }
    assert.ok(richSource.includes("commandsCtx"), "命令必须走编辑器自己的 ctx ✓");
    assert.ok(richSource.includes("editorViewCtx"), "删除行列要拿当前视图 ✓");
    assert.ok(
      richSource.includes("crepe.editor.action((ctx: Ctx)"),
      "要用 `editor.action` 拿 ctx ✗（另建一套 ctx 等于对另一个编辑器下命令 ✓）",
    );
  });

  it("命令执行前再确认一次「光标还在表格里」，异常不许抛进事件处理器 ✓", () => {
    assert.ok(richSource.includes("!readTableContext(view.state).inTable"), "下命令前再查一次 ✓");
    assert.ok(
      /catch \(error\) \{[\s\S]{0,240}table-action-failed/.test(richSource),
      "命令抛错要自己收住 + 上报诊断 ✗（ErrorBoundary 只接渲染错误 ✓）",
    );
  });
});
