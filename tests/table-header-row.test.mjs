/**
 * **第一行（表头行）不能再向上插入行** ✓
 * （用户两轮实测后的最终口径 ✓）。
 *
 * 第一轮：在第一行点「在上方插入行」⇒ **冒出一张新表** ✗
 *   （根因：GFM 的 `table ⇒ "table_header_row table_row+"` ✓ ⇒ 往表头前面插普通行不合法 ✓
 *    ⇒ ProseMirror 的 `Fitter` 把表格**拆成两张** ✓）。
 * 第二轮：改成"新行当表头、旧表头降级" ✗ ⇒ 用户否决：
 *   「第一行默认变成第二行，这也很怪，因为很多时候第一行是段名」✓
 *   ⇒ 最终：这一行上**禁用**「在上方插入行」并说明原因 ✓。
 *
 * 这里用**真的 Schema + 真的 EditorState** 测位置判定 ✓
 * （`table-header-row.ts` 只依赖 ProseMirror 纯数据 API ✓ ⇒ Node 里能跑 ✓），
 * 并钉住"编辑器里那一项确实被禁用 + 运行期再挡一次"的接线 ✓。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";

import { hitTable, inFirstTableRow, tableRowTypes } from "../src/client/table-header-row.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "..", "src", "client");
const richSource = readFileSync(path.join(CLIENT, "MarkdownRichEditor.tsx"), "utf8");
const menuSource = readFileSync(path.join(CLIENT, "table-menu.ts"), "utf8");
const dictSource = readFileSync(path.join(CLIENT, "index.ts"), "utf8");

const baseNodes = {
  doc: { content: "block+" },
  paragraph: { content: "inline*", group: "block" },
  text: { group: "inline" },
  blockquote: { content: "block+", group: "block" },
};

/** **Milkdown GFM 那套**（名字与内容模型照抄实测值 ✓） */
const milkdownSchema = new Schema({
  nodes: {
    ...baseNodes,
    table: { content: "table_header_row table_row+", group: "block", tableRole: "table" },
    table_header_row: { content: "table_header+", tableRole: "row" },
    table_row: { content: "table_cell+", tableRole: "row" },
    table_header: { content: "paragraph", tableRole: "header_cell", attrs: { alignment: { default: "left" } } },
    table_cell: { content: "paragraph", tableRole: "cell", attrs: { alignment: { default: "left" } } },
  },
  marks: {},
});

/** 原生 `tableNodes` 那套（行类型不分表头/正文 ⇒ 靠单元格类型判 ✓） */
const vanillaSchema = new Schema({
  nodes: {
    ...baseNodes,
    table: { content: "table_row+", group: "block", tableRole: "table" },
    table_row: { content: "(table_cell | table_header)*", tableRole: "row" },
    table_header: { content: "paragraph", tableRole: "header_cell", attrs: { alignment: { default: "left" } } },
    table_cell: { content: "paragraph", tableRole: "cell", attrs: { alignment: { default: "left" } } },
  },
  marks: {},
});

const para = (schema, value) => schema.nodes.paragraph.create(null, value === "" ? undefined : schema.text(value));
const headerCell = (schema, value) => schema.nodes.table_header.create(null, [para(schema, value)]);
const bodyCell = (schema, value) => schema.nodes.table_cell.create(null, [para(schema, value)]);

/** GFM 三列表：表头一行 + 正文一行 ✓，后面再跟一段正文 ✓ */
function milkdownDoc(schema) {
  const table = schema.nodes.table.create(null, [
    schema.nodes.table_header_row.create(null, [headerCell(schema, "1"), headerCell(schema, "2"), headerCell(schema, "3")]),
    schema.nodes.table_row.create(null, [bodyCell(schema, "我来自河南"), bodyCell(schema, "b"), bodyCell(schema, "c")]),
  ]);
  return schema.nodes.doc.create(null, [table, para(schema, "表格后面的一段正文")]);
}

/**
 * 把光标放进第 `row` 行、第 `column` 列**单元格里那段文字**的起点 ✓。
 * 位置换算：表格内容 +1 ✓ → 行内容再 +1 ✓ → 单元格 → 段落文字再 +2 ✓。
 */
function cursorPosInCell(table, row, column) {
  let pos = 1;
  for (let index = 0; index < row; index += 1) pos += table.child(index).nodeSize;
  pos += 1;
  const targetRow = table.child(row);
  for (let index = 0; index < column; index += 1) pos += targetRow.child(index).nodeSize;
  return pos + 2;
}

function stateWithCursorIn(doc, schema, row, column) {
  const state = EditorState.create({ schema, doc });
  const pos = cursorPosInCell(doc.child(0), row, column);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

describe("第一行不能向上插入行（禁用 + 说明原因）✓", () => {
  it("**为什么不能插**：往表头行前面塞普通行 ⇒ 内容模型直接不成立 ✓（Fitter 就是在这儿拆表的 ✗）", () => {
    const schema = milkdownSchema;
    const doc = milkdownDoc(schema);
    const headerRow = doc.child(0).child(0);
    const bodyRow = doc.child(0).child(1);
    assert.throws(
      () => schema.nodes.table.createChecked(null, [bodyRow, headerRow, bodyRow]),
      /Invalid content for node table/,
      "普通行在表头行前面必须被判为不合法 ✓",
    );
    assert.equal(
      schema.nodes.table.validContent(schema.nodes.table.create(null, [headerRow, bodyRow]).content),
      true,
      "对照：表头行在前才是合法的 ✓",
    );
  });

  it("位置判定：第一行 ⇒ 是表头行；正文行 / 表格外 ⇒ 都不是 ✓", () => {
    const schema = milkdownSchema;
    const doc = milkdownDoc(schema);
    const types = tableRowTypes(schema);
    assert.notEqual(types, null);
    const inHeader = stateWithCursorIn(doc, schema, 0, 1);
    assert.equal(inFirstTableRow(inHeader, types), true, "第一行 ⇒ 表头行 ✓");
    assert.deepEqual(hitTable(inHeader)?.rowIndex, 0, "行下标要给对 ✓");
    const inBody = stateWithCursorIn(doc, schema, 1, 0);
    assert.equal(inFirstTableRow(inBody, types), false, "正文行 ⇒ 不禁用 ✓（在正文行上方插普通行是合法的 ✓）");
    assert.equal(hitTable(inBody)?.rowIndex, 1, "正文行下标 1 ✓");
    /* 表格外（后面那段正文 ✓） */
    const outside = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, doc.child(0).nodeSize + 1),
    });
    assert.equal(hitTable(outside), null, "不在表格里 ⇒ `null` ✓（不许抛异常 ✓）");
    assert.equal(inFirstTableRow(outside, types), false, "不在表格里 ⇒ 不禁用 ✓");
  });

  it("光标在第二行时**不能**误判成表头 ✓（`rowIndex` 必须真的算对 ✓）", () => {
    const schema = milkdownSchema;
    const doc = milkdownDoc(schema);
    const types = tableRowTypes(schema);
    for (const [row, expected] of [[0, true], [1, false]]) {
      const state = stateWithCursorIn(doc, schema, row, 2);
      assert.equal(inFirstTableRow(state, types), expected, `第 ${row} 行 ⇒ ${expected} ✓`);
    }
  });

  it("原生 `tableNodes` 那套：靠**单元格类型**判表头 ✓（普通行的表不许被误判 ✗）", () => {
    const schema = vanillaSchema;
    const types = tableRowTypes(schema);
    /* 表头单元格开头的表 ✓ */
    const withHeader = schema.nodes.doc.create(null, [
      schema.nodes.table.create(null, [
        schema.nodes.table_row.create(null, [headerCell(schema, "段名"), headerCell(schema, "2")]),
        schema.nodes.table_row.create(null, [bodyCell(schema, "a"), bodyCell(schema, "b")]),
      ]),
      para(schema, "后面"),
    ]);
    assert.equal(
      inFirstTableRow(stateWithCursorIn(withHeader, schema, 0, 0), types),
      true,
      "第一格是表头单元格 ⇒ 认作表头行 ✓",
    );
    /* 全是普通单元格的表 ⇒ **不许**当成表头 ✗ */
    const withoutHeader = schema.nodes.doc.create(null, [
      schema.nodes.table.create(null, [
        schema.nodes.table_row.create(null, [bodyCell(schema, "a"), bodyCell(schema, "b")]),
        schema.nodes.table_row.create(null, [bodyCell(schema, "c"), bodyCell(schema, "d")]),
      ]),
      para(schema, "后面"),
    ]);
    assert.equal(
      inFirstTableRow(stateWithCursorIn(withoutHeader, schema, 0, 0), types),
      false,
      "没有表头单元格 ⇒ 第一行只是普通行 ⇒ **不禁用** ✓",
    );
  });

  it("**接线**：菜单里这一项要在表头行上禁用并写出原因 ✓", () => {
    assert.ok(
      richSource.includes('disabledActions["row-before"] = "tableRowBeforeHeader";'),
      "禁用原因要挂到 row-before 上 ✓",
    );
    assert.ok(
      /if \(selectionInTarget\) \{[\s\S]{0,220}?inFirstTableRow\(view\.state, rowTypes\)[\s\S]{0,120}?tableRowBeforeHeader/s.test(richSource),
      "判据只看**目标表格里的选区** ✓（悬停别的表时不许误禁用 ✗）",
    );
    assert.ok(menuSource.includes("tableRowBeforeHeader:"), "回落文案要在表格菜单的字典里 ✓");
    const zh = dictSource.slice(dictSource.indexOf("const DICT_ZH"), dictSource.indexOf("const DICT_EN"));
    const en = dictSource.slice(dictSource.indexOf("const DICT_EN"));
    assert.ok(zh.includes("tableRowBeforeHeader:") && en.includes("tableRowBeforeHeader:"), "中英词典都要有 ✓");
  });

  it("**运行期再挡一次** ✓：绕过菜单也不许派发不合法的事务（防表格被拆成两张 ✗）", () => {
    const at = richSource.indexOf('case "row-before"');
    assert.notEqual(at, -1, "要有 row-before 这一支 ✓");
    const block = richSource.slice(at, at + 1200);
    assert.ok(block.includes("inFirstTableRow(view.state, rowTypes)"), "这一支要再判一次表头行 ✓");
    assert.ok(
      /if \(rowTypes !== null && inFirstTableRow\(view\.state, rowTypes\)\) \{[\s\S]{0,200}?break;/.test(block),
      "命中表头行 ⇒ **什么都不派发** ✓（直接结束这一支 ✓）",
    );
    assert.ok(block.includes('reportRef.current?.("table-action-blocked"'), "被挡下要留一条诊断 ✓");
    assert.ok(
      block.indexOf("commands.call(addRowBeforeCommand.key)") > block.indexOf("inFirstTableRow(view.state, rowTypes)"),
      "内置命令只能在**判定之后**执行 ✓（判定在前 ✓）",
    );
    /* 早期那条"降级旧表头"的实现必须已经删掉 ✗ */
    assert.ok(!richSource.includes("insertHeaderRowAbove"), "不许再留着「降级旧表头」那条被否决的实现 ✗");
  });
});
