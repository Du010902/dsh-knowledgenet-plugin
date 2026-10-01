/**
 * **表格 UI 与操作菜单**的测试（`design/table-caret-and-interaction-design.md` ✓）。
 *
 * 文档要的效果：普通表格就是文档内容 —— 没有常驻十字线/加号、没有整行整列高亮 ✗，
 * 点击单元格是**文字插入光标** ✓；结构操作只在光标进了表格时，从表格右上角一个轻量菜单里做 ✓。
 *
 * 这里盯三件事：
 * 1. **纯逻辑真的对**：`readTableContext` 拿真实 ProseMirror state 跑（在表格里 / 不在 / 列对齐 ✓）；
 *    菜单位置的几何换算（贴在表格上沿 ✓、贴顶时夹到 0 ✓、坐标取整 ✓）。
 * 2. **Crepe 的结构控件必须真的不挡路** ✗：不只是"看不见"，还要 `pointer-events: none`
 *    （透明的绝对定位控件照样吃点击 ⇒ 光标落不下去 ✓）。
 * 3. **菜单本身**：动作清单齐全、危险操作写明对象、键盘可访问、按上去不丢表格选区 ✓。
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
  TABLE_LITERAL,
  TABLE_MENU_GAP,
  TABLE_MENU_HEIGHT,
  TABLE_MENU_ITEMS,
  menuPosition,
  readTableContext,
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
  /* table → row → cell → paragraph：+4 落在第一个单元格的段落起点附近 ✓ */
  const selection = TextSelection.near(doc.resolve(tablePos + 4));
  return EditorState.create({ doc, selection });
}

/** 建一份没有表格的文档 ✓ */
function stateWithoutTable() {
  const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, schema.text("只有正文"))]);
  return EditorState.create({ doc, selection: TextSelection.near(doc.resolve(1)) });
}

describe("表格上下文：菜单显隐与对齐高亮只来自编辑器 selection", () => {
  it("光标在单元格里 ⇒ inTable ✓；列对齐按单元格属性读出来 ✓", () => {
    assert.deepEqual(readTableContext(stateInTable(undefined)), { inTable: true, alignment: "left" });
    assert.deepEqual(readTableContext(stateInTable("center")), { inTable: true, alignment: "center" });
    assert.deepEqual(readTableContext(stateInTable("right")), { inTable: true, alignment: "right" });
    /* 认不出的值一律按左对齐 ✓（不给菜单一个不存在的点亮状态 ✓） */
    assert.deepEqual(readTableContext(stateInTable("weird")), { inTable: true, alignment: "left" });
  });

  it("光标不在表格里 / 没有 state ⇒ 不显示菜单 ✓", () => {
    assert.deepEqual(readTableContext(stateWithoutTable()), { inTable: false, alignment: "left" });
    assert.deepEqual(readTableContext(null), { inTable: false, alignment: "left" });
    assert.deepEqual(readTableContext(undefined), { inTable: false, alignment: "left" });
  });

  it("显隐与高亮**不问鼠标**（不依赖悬停）✗", () => {
    assert.ok(!menuLogicSource.includes("hover"), "上下文只能来自 selection ✗（文档第 3 节 ✓）");
    assert.ok(!menuLogicSource.includes("mouse"), "不许用鼠标位置推断结构状态 ✗");
  });
});

describe("菜单位置：贴在表格块右上角", () => {
  const height = 30;
  const gap = 6;

  it("挂在表格上沿之上，右边缘与表格右边缘对齐 ✓", () => {
    const position = menuPosition(
      { top: 300, right: 400 },
      { top: 100, right: 400 },
      120,
      height,
      gap,
    );
    /* 300 − 100 + 120 − 30 − 6 = 284（内容坐标 ✓） */
    assert.deepEqual(position, { top: 284, right: 0 });
  });

  it("表格贴顶时夹到 0（宁可轻压表格，也不许算到滚动区外面 ✗）", () => {
    assert.deepEqual(
      menuPosition({ top: 10, right: 400 }, { top: 50, right: 400 }, 0, height, gap),
      { top: 0, right: 0 },
    );
  });

  it("短表格靠右放：右侧偏移按容器的右边缘算 ✓；坐标取整 ✓", () => {
    const position = menuPosition(
      { top: 200.6, right: 360.4 },
      { top: 0.4, right: 400 },
      0,
      height,
      gap,
    );
    assert.deepEqual(position, { top: 164, right: 40 });
    assert.equal(Number.isInteger(position.top) && Number.isInteger(position.right), true);
  });

  it("菜单高度常量与 CSS 一致（不一致会让菜单位置整体偏 ✓）", () => {
    const padding = /\.kn-table-menu \{[^}]*padding:\s*(\d+)px (\d+)px/s.exec(panel);
    const button = /\.kn-table-menu-btn \{[^}]*height:\s*(\d+)px/s.exec(panel);
    assert.notEqual(padding, null, "菜单要有内边距 ✓");
    assert.notEqual(button, null, "按钮要有高度 ✓");
    /* 上下内边距 + 按钮高 + 上下 1px 边框 = 菜单实际高 ✓ */
    assert.equal(Number(padding[1]) * 2 + Number(button[1]) + 2, TABLE_MENU_HEIGHT);
    assert.equal(TABLE_MENU_GAP, 6, "间距与 CSS 的视觉关系保持 6px ✓");
  });
});

describe("动作清单：够用、分组、危险操作写明对象", () => {
  it("九颗按钮，顺序固定（插行 / 插列 / 对齐 / 删除）✓", () => {
    assert.deepEqual(TABLE_MENU_ITEMS.map((item) => item.id), [
      "row-before", "row-after",
      "col-before", "col-after",
      "align-left", "align-center", "align-right",
      "row-delete", "col-delete",
    ]);
    assert.equal(new Set(TABLE_MENU_ITEMS.map((item) => item.id)).size, TABLE_MENU_ITEMS.length, "不许重复 ✗");
  });

  it("每颗按钮都有中英词典 + 回落文案 ✓", () => {
    const zh = dictSource.slice(dictSource.indexOf("const DICT_ZH"), dictSource.indexOf("const DICT_EN"));
    const en = dictSource.slice(dictSource.indexOf("const DICT_EN"));
    for (const item of TABLE_MENU_ITEMS) {
      assert.equal(typeof TABLE_LITERAL[item.labelKey], "string", `${item.labelKey} 要有回落文案 ✓`);
      assert.ok(zh.includes(`${item.labelKey}:`), `中文词典要有 ${item.labelKey} ✓`);
      assert.ok(en.includes(`${item.labelKey}:`), `英文词典要有 ${item.labelKey} ✓`);
    }
    assert.equal(typeof TABLE_LITERAL.tableMenuLabel, "string", "工具条本身也要有可读名字 ✓");
  });

  it("分组单调、删除放在最后且标成危险 ✓（标题写明「本行 / 本列」✓）", () => {
    const groups = TABLE_MENU_ITEMS.map((item) => item.group);
    for (let i = 1; i < groups.length; i += 1) assert.ok(groups[i] >= groups[i - 1], "分组不许回退 ✗");
    const danger = TABLE_MENU_ITEMS.filter((item) => item.danger === true).map((item) => item.id);
    assert.deepEqual(danger, ["row-delete", "col-delete"], "只有删除是危险操作 ✓");
    assert.equal(TABLE_MENU_ITEMS[TABLE_MENU_ITEMS.length - 1].danger, true, "危险操作要排在最后 ✓");
    assert.equal(TABLE_LITERAL.tableDeleteRow, "删除本行");
    assert.equal(TABLE_LITERAL.tableDeleteCol, "删除本列");
  });

  it("对齐按钮自带 alignment（用于点亮 ✓）", () => {
    const aligns = TABLE_MENU_ITEMS.filter((item) => item.alignment !== undefined)
      .map((item) => [item.id, item.alignment]);
    assert.deepEqual(aligns, [["align-left", "left"], ["align-center", "center"], ["align-right", "right"]]);
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
    assert.ok(!/tbody tr:hover/.test(overrides), "不许再点亮整行 ✗（文档第 3 节 ✓）");
    assert.ok(
      /th:has\(\.ProseMirror-selectednode\),[\s\S]*?outline:\s*none/.test(overrides),
      "单元格不许因为结构选中而描边 ✗",
    );
    const selected = /\.selectedCell::after \{([^}]*)\}/.exec(overrides);
    assert.notEqual(selected, null, "区域选中仍要有反馈 ✓（不能全清掉 ✗）");
    const percent = /(\d+)%/.exec(selected[1]);
    assert.notEqual(percent, null, "区域选中用低对比底纹 ✓");
    assert.ok(Number(percent[1]) >= 8 && Number(percent[1]) <= 12, `底纹要在 8–12%（实际 ${percent[1]}%）✓`);
    assert.ok(overrides.includes(".column-resize-handle"), "用户主动拖列宽的手柄保留 ✓");
  });

  it("没有对表格做全局 overflow:hidden 遮丑 ✗（会裁掉菜单与手柄 ✓）", () => {
    assert.ok(
      !/milkdown-table-block \{[^}]*overflow:\s*hidden/s.test(overrides),
      "不许在表格块上直接 overflow:hidden ✗（文档第 4 节 ✓）",
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

  it("显隐 / 定位都来自编辑器 selection，菜单与 ProseMirror DOM 分离 ✓", () => {
    assert.ok(richSource.includes("readTableContext(view.state)"), "按当前 selection 判断在不在表格里 ✓");
    assert.ok(richSource.includes("menuPosition("), "位置用纯函数算 ✓");
    assert.ok(richSource.includes('closest<HTMLElement>(".milkdown-table-block")'), "锚点是表格块 ✓");
    assert.ok(richSource.includes('closest<HTMLElement>(".kn-editor-body")'), "坐标基于正文滚动容器 ✓");
    assert.ok(richSource.includes('addEventListener("selectionchange"'), "选区变了要重算 ✓");
    assert.ok(richSource.includes("requestAnimationFrame"), "连续触发要合并到一帧 ✓");
    /* 菜单渲染在 milkdown 挂载点**之外** ✓（不往 node view 里塞外来节点 ✗） */
    assert.ok(richSource.includes("<TableMenu"), "要渲染菜单 ✓");
    assert.ok(
      /<div className="kn-editor-rich"[\s\S]*?\{menu === null \? null : \(/.test(richSource),
      "菜单要是挂载点的兄弟节点 ✓（不占正文高度 ✓）",
    );
    assert.ok(panel.includes(".kn-editor-body {\n  position: relative;"), "正文容器要能当定位父级 ✓");
  });

  it("**不拦截表格上的普通点击** ✗（文字插入光标交给原生编辑器 ✓）", () => {
    assert.ok(
      !/milkdown-table-block[\s\S]{0,200}addEventListener\("pointerdown"/.test(richSource),
      "不许对表格 pointerdown 无条件 preventDefault ✗（会毁掉拖选 / 双击选词 / 输入法 ✓）",
    );
    assert.ok(!richSource.includes("preventDefault()"), "正文里不该出现点击兜底 ✓");
  });

  it("命令执行前再确认一次「光标还在表格里」，异常不许抛进事件处理器 ✓", () => {
    assert.ok(
      richSource.includes("!readTableContext(view.state).inTable"),
      "下命令前再查一次 ✓（菜单位置是下一帧算的，这一拍选区可能已经跑了 ✗）",
    );
    assert.ok(
      /catch \(error\) \{[\s\S]{0,240}table-action-failed/.test(richSource),
      "命令抛错要自己收住 + 上报诊断 ✗（ErrorBoundary 只接渲染错误 ✓）",
    );
  });

  it("菜单按上去不丢表格选区；危险操作写明对象；键盘可达 ✓", () => {
    assert.ok(menuSource.includes('role="toolbar"'), "菜单是可访问的工具条 ✓");
    assert.ok(menuSource.includes('aria-label={props.t("tableMenuLabel")}'), "工具有可读名字 ✓");
    assert.ok(menuSource.includes("onPointerDown={blockFocusSteal}"), "按菜单不抢焦点 ✓");
    assert.ok(
      /function blockFocusSteal\(event: \{ preventDefault: \(\) => void \}\): void \{\s*event\.preventDefault\(\)/.test(menuSource),
      "只阻止默认（不吞事件、不影响点击 ✓）",
    );
    assert.ok(menuSource.includes("aria-pressed"), "对齐按钮要报出自己的状态 ✓");
    assert.ok(menuSource.includes("title={props.t(item.labelKey)}"), "每颗按钮都有标题（危险操作写明对象 ✓）");
    assert.ok(menuSource.includes('className={`kn-table-menu-btn'), "按钮样式类 ✓");
    assert.ok(menuSource.includes('type="button"'), "别在表单语境里误提交 ✓");
  });
});
