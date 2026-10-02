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
import { tableNodes } from "@milkdown/kit/prose/tables";

import {
  TABLE_ENTRY_GAP,
  TABLE_ENTRY_SIZE,
  TABLE_LITERAL,
  TABLE_MENU_ITEMS,
  TABLE_POPOVER_HEIGHT,
  readTableContext,
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
    /* 右侧空白 186px ⇒ 入口右边缘离容器右边 186-4-24=158 ✓ */
    assert.equal(entry.right, 440 - 254 - TABLE_ENTRY_GAP - TABLE_ENTRY_SIZE);
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
    assert.equal(clipped.right, 440 - 200 - TABLE_ENTRY_GAP - TABLE_ENTRY_SIZE);
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
    const entry = /\.kn-table-entry \{[^}]*width:\s*(\d+)px;[^}]*height:\s*(\d+)px/s.exec(panel);
    assert.notEqual(entry, null, "入口要有尺寸 ✓");
    assert.equal(Number(entry[1]), TABLE_ENTRY_SIZE);
    assert.equal(Number(entry[2]), TABLE_ENTRY_SIZE);
    const menu = /\.kn-table-menu \{[^}]*max-height:\s*(\d+)px/s.exec(panel);
    assert.notEqual(menu, null, "菜单要有高度上限 ✓");
    assert.equal(Number(menu[1]), TABLE_POPOVER_HEIGHT);
    const width = /\.kn-table-menu \{[^}]*width:\s*(\d+)px/s.exec(panel);
    assert.equal(Number(width[1]), 210, "与 `tablePopoverPosition` 的默认宽度一致 ✓");
  });
});

describe("动作清单：够用、分组、危险操作写明对象", () => {
  it("九项动作，顺序固定（插行 / 插列 / 对齐 / 删除）✓", () => {
    assert.deepEqual(TABLE_MENU_ITEMS.map((item) => item.id), [
      "row-before", "row-after",
      "col-before", "col-after",
      "align-left", "align-center", "align-right",
      "row-delete", "col-delete",
    ]);
    assert.equal(new Set(TABLE_MENU_ITEMS.map((item) => item.id)).size, TABLE_MENU_ITEMS.length, "不许重复 ✗");
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
