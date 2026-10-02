/**
 * **表格单元格点击 → 文字光标**的测试
 * （`design/table-click-jitter-and-caret-analysis.md` ✓）。
 *
 * 复查实测的症状：在单元格空白处普通点击，ProseMirror 的 `selectClickedLeaf` 会对
 * `isAtom` 为真的节点建 NodeSelection —— 而 **textblock（段落 / 标题 / 代码块）也是 `isAtom`** ✗
 * ⇒ 选区不折叠、`ProseMirror-hideselection` 上身，亮框 CSS 又被撤掉了 ⇒ 看不见却整段被选中 ✓。
 *
 * 上一版是"**先让原组件建好节点选择，再在 mouseup + 微任务里纠正**" ✗ ——
 * 复查点名它会带来两次选区/聚焦/滚动（抖动嫌疑 ✓）而且竖线晚一拍 ✓。
 * 现在接在 ProseMirror 的 **`handleClick`** 上（在默认处理之前 ✓），只产生**一次**选区变化 ✓。
 *
 * 这里钉四件事：
 * 1. 位置计算（最近的合法文字位置 ✓、空单元格落到第一行 ✓、多段落单元格按坐标就近 ✓）；
 * 2. 什么点击**不许**接管（表格外 / 真原子块 / 本来就是文字位置 / 带修饰键 ✓）；
 * 3. 接线方式（`view.setProps({ handleClick })` ✓、**没有** mouseup + 微任务那套 ✗）；
 * 4. 原生光标（Crepe Cursor `virtual: false` + `caret-color` 跟随正文 ✓）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { tableNodes } from "@milkdown/kit/prose/tables";

import { caretTargetForClick, isPlainClick } from "../src/client/table-caret.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "..", "src", "client");
const richSource = readFileSync(path.join(CLIENT, "MarkdownRichEditor.tsx"), "utf8");
const caretSource = readFileSync(path.join(CLIENT, "table-caret.ts"), "utf8");
const overrides = readFileSync(path.join(CLIENT, "editor-overrides.css"), "utf8");

/** 最小 schema：段落 / 文本 + 一个真正的原子块（模拟图片 ✓）+ 表格 ✓ */
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    image: { group: "block", atom: true, selectable: true },
    text: { group: "inline" },
    ...tableNodes({ tableGroup: "block", cellContent: "block+", cellAttributes: {} }),
  },
  marks: {},
});

/**
 * 建一份"段落 + 表格（第一格放给定块 / 第二格空段落 ✓）"的文档 ✓。
 * @returns 关键位置（都是**位置**，不是节点 ✓）。
 */
function docWithCell(cellBlocks) {
  const row = schema.nodes.table_row.create(null, [
    schema.nodes.table_cell.create(null, cellBlocks),
    schema.nodes.table_cell.create(null, schema.nodes.paragraph.create()),
  ]);
  const table = schema.nodes.table.create(null, [row]);
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, schema.text("表格之前")),
    table,
  ]);
  let tablePos = -1;
  doc.descendants((node, pos) => {
    if (node.type.name !== "table") return true;
    tablePos = pos;
    return false;
  });
  assert.notEqual(tablePos, -1, "测试文档里应该有表格");
  return {
    doc,
    tablePos,
    /** 第一个单元格的内容起点（也等于第一块前面的位置 ✓） */
    cellStart: tablePos + 3,
  };
}

const stateOf = (doc) => EditorState.create({ doc, selection: TextSelection.near(doc.resolve(2)) });

/** 断言这个位置是"合法的文字插入点" ✓ */
function assertIsCaret(state, target) {
  assert.notEqual(target, null, "必须给出一个文字位置 ✓");
  assert.equal(state.doc.resolve(target).parent.inlineContent, true, "必须能放文字光标 ✓");
}

/** 在某个位置敲一个字 ⇒ 只能是**插入** ✓ */
function typeAt(state, target, char = "X") {
  return state.apply(state.tr.insertText(char, target));
}

describe("位置计算：最近的合法文字位置", () => {
  it("点在单元格内边距（结构命中）⇒ 落到该单元格最近的文字位置，且敲字只插入 ✓", () => {
    const { doc, cellStart } = docWithCell([schema.nodes.paragraph.create(null, schema.text("git status"))]);
    const state = stateOf(doc);
    /* 复现实测的坏坐标：pos 落在段落前面、inside 指到那个段落（`selectClickedLeaf` 就建结构选择 ✓） */
    const target = caretTargetForClick(state, { pos: cellStart, inside: cellStart });
    assertIsCaret(state, target);
    assert.equal(target, cellStart + 1, "落在段落文字起点 ✓");
    const after = typeAt(state, target);
    assert.equal(after.doc.textContent.includes("git status"), true, "原文不许被替换 ✗");
  });

  it("空单元格 ⇒ 稳定落到第一行起点 ✓", () => {
    const { doc, cellStart } = docWithCell([schema.nodes.paragraph.create()]);
    const state = stateOf(doc);
    const target = caretTargetForClick(state, { pos: cellStart, inside: cellStart });
    assertIsCaret(state, target);
    assert.equal(target, cellStart + 1, "空段落里的唯一插入位置 ✓");
  });

  it("**多段落单元格**：按坐标就近 ✓（不许一律回落到第一行 ✗）", () => {
    const first = schema.nodes.paragraph.create(null, schema.text("第一段"));
    const second = schema.nodes.paragraph.create(null, schema.text("第二段"));
    const { doc, cellStart } = docWithCell([first, second]);
    const state = stateOf(doc);
    const secondPos = cellStart + first.nodeSize; /* 第二个段落前面的位置 ✓ */
    const target = caretTargetForClick(state, { pos: secondPos, inside: secondPos });
    assertIsCaret(state, target);
    assert.equal(state.doc.resolve(target).parent.textContent, "第二段", "要落在**点击那一段**里 ✗");
    assert.ok(target >= secondPos && target <= secondPos + second.nodeSize, "位置必须落在第二个段落内 ✓");
  });

  it("点在真正的文字位置上（inside === -1）⇒ 交还原生 ✗", () => {
    const { doc, cellStart } = docWithCell([schema.nodes.paragraph.create(null, schema.text("abc"))]);
    const state = stateOf(doc);
    assert.equal(caretTargetForClick(state, { pos: cellStart + 2, inside: -1 }), null);
  });

  it("**不许接管**的点击：表格外 / 真原子块 / 拿不到坐标 ✓", () => {
    const { doc, cellStart } = docWithCell([
      schema.nodes.paragraph.create(null, schema.text("文字")),
      schema.nodes.image.create(),
    ]);
    const state = stateOf(doc);
    /* ① 表格外（第一个段落前面 ✓） */
    assert.equal(caretTargetForClick(state, { pos: 0, inside: 0 }), null);
    /* ② 单元格里的**真原子块**（图片）⇒ 单击选中它是它唯一的操作方式 ✗ */
    const imagePos = cellStart + schema.nodes.paragraph.create(null, schema.text("文字")).nodeSize;
    assert.equal(state.doc.nodeAt(imagePos).type.name, "image", "前置：这里确实是原子块 ✓");
    assert.equal(caretTargetForClick(state, { pos: imagePos, inside: imagePos }), null);
    /* ③ 拿不到坐标 ⇒ 交还原生 ✓ */
    assert.equal(caretTargetForClick(state, null), null);
  });

  it("只改选区、不改文档 ✓", () => {
    const { doc, cellStart } = docWithCell([schema.nodes.paragraph.create(null, schema.text("保持原样"))]);
    const state = stateOf(doc);
    const target = caretTargetForClick(state, { pos: cellStart, inside: cellStart });
    const after = state.apply(state.tr.setSelection(TextSelection.create(state.doc, target)));
    assert.equal(after.doc.eq(state.doc), true, "内容一字不动 ✓");
    assert.equal(after.selection instanceof TextSelection, true);
  });
});

describe("isPlainClick：只对「普通左键单击」动手", () => {
  const plain = { button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };

  it("普通单击 ⇒ 接管 ✓", () => {
    assert.equal(isPlainClick(plain), true);
  });

  it("Shift / Ctrl(⌘) / Alt / 其它键 ⇒ 一律让给原生 ✓", () => {
    assert.equal(isPlainClick({ ...plain, shiftKey: true }), false, "Shift 扩选 ✗");
    assert.equal(isPlainClick({ ...plain, ctrlKey: true }), false, "Ctrl+点击=选中节点 ✗");
    assert.equal(isPlainClick({ ...plain, metaKey: true }), false, "⌘+点击 ✗");
    assert.equal(isPlainClick({ ...plain, altKey: true }), false);
    assert.equal(isPlainClick({ ...plain, button: 2 }), false, "右键 ✗");
  });

  it("拖选 / 双击 / 三击**根本不会走到 handleClick** ✓（由 ProseMirror 自己分流 ✓）", () => {
    assert.ok(!caretSource.includes("detail"), "不再靠 event.detail 猜单击/双击 ✗");
    assert.ok(!caretSource.includes("dragThreshold"), "拖选由 ProseMirror 的 allowDefault 判掉 ✓");
  });
});

describe("接线：在 handleClick 上直接落下文字选区（只变一次 ✓）", () => {
  it("`view.setProps({ handleClick })`，并先让上游处理器跑 ✓", () => {
    const start = richSource.indexOf("const previousClick = view.props.handleClick");
    assert.notEqual(start, -1, "要能找到 handleClick 的接线 ✓");
    const wiring = richSource.slice(start, start + 900);
    assert.ok(wiring.includes("view.setProps({"), "用 setProps 只覆盖这一项 ✓");
    assert.ok(wiring.includes("previousClick.call("), "上游本来也有 handleClick 就先让它跑 ✗");
    assert.ok(wiring.includes("return placeTableCaret(targetView, clickEvent);"), "没有上游处理才由我们接 ✓");
    assert.ok(
      richSource.includes("if (!isPlainClick(event)) return false;"),
      "普通单击的判据走纯函数 ✓",
    );
    assert.ok(
      richSource.includes("caretTargetForClick(view.state, coords ?? null)"),
      "位置计算走纯函数 ✓",
    );
    assert.ok(
      wiring.includes("return placeTableCaret(") && richSource.includes("    return true;\n  }, []);"),
      "接管后要返回 true ⇒ ProseMirror 不再建节点选择 ✓",
    );
  });

  it("**没有** mouseup + 微任务那套（复查点名的「两次变化」✗）", () => {
    assert.ok(!richSource.includes("queueMicrotask"), "不许再用微任务补一刀 ✗");
    assert.ok(!richSource.includes("onCaretMouseUp"), "mouseup 那套已经删掉 ✓");
    assert.ok(!richSource.includes("onCaretMouseDown"), "mousedown 记坐标那套已经删掉 ✓");
    assert.ok(!richSource.includes("mouseDownRef"), "也不再需要记按下坐标 ✓（拖选由 ProseMirror 判 ✓）");
    assert.ok(!richSource.includes("caretFixTarget"), "旧 API 已经换掉 ✓");
    assert.ok(!richSource.includes("shouldFixCaret"), "旧 API 已经换掉 ✓");
  });

  it("只在确实没聚焦时才 focus ✓（点一下本来就已经聚焦了 ✓）", () => {
    const start = richSource.indexOf("const placeTableCaret");
    assert.notEqual(start, -1, "要能找到 placeTableCaret ✓");
    const place = richSource.slice(start, start + 900);
    assert.ok(place.includes("if (!view.hasFocus()) view.focus();"), "聚焦要有条件 ✗（别每次点击都动焦点 ✓）");
    assert.ok(!place.includes("scrollIntoView"), "普通点击不许顺手滚动 ✗");
  });
});

describe("原生插入光标（不再用虚拟光标 ✓）", () => {
  it("Crepe Cursor 特性显式关掉 virtual ✓", () => {
    assert.ok(
      /\[CrepeFeature\.Cursor\]:\s*\{\s*virtual:\s*false,?\s*\}/.test(richSource),
      "要显式 `virtual: false` ⇒ Crepe 不装虚拟光标插件 ✓（原生光标才回来 ✓）",
    );
  });

  it("颜色跟随正文主文字色 ✓（不靠隐藏虚拟光标 DOM ✗）", () => {
    assert.ok(
      /\.kn-root \.kn-editor-rich \.milkdown \.ProseMirror \{\s*caret-color: var\(--dsw-alias-label-primary\)/.test(overrides),
      "原生光标颜色要显式跟随正文色 ✓",
    );
    assert.ok(
      /--prosemirror-virtual-cursor-color: var\(--dsw-alias-label-primary\)/.test(overrides),
      "万一又开虚拟光标，颜色也要是正文色 ✓（原来是 crepe outline，暗色太淡 ✗）",
    );
    assert.ok(!/caret-color:\s*transparent/.test(overrides), "不许把原生光标设成透明 ✗");
  });
});
