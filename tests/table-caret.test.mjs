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
import { EditorState, NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import { tableNodes } from "@milkdown/kit/prose/tables";

import {
  caretTargetForClick,
  caretTargetForSelection,
  caretTargetForTextblockSelection,
  isCellTextblockSelection,
  isPlainClick,
} from "../src/client/table-caret.ts";

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

/** 第一个单元格里的文字（测试文档：段落 + 表格 ⇒ 表格是第二个孩子 ✓） */
function cellText(doc) {
  return doc.child(1).child(0).child(0).textContent;
}

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

describe("dispatch 漏斗：改掉上游那个「整段结构选择」（真根因 ✓）", () => {
  /**
   * 复现上游 `TableNodeView` 的行为 ✓：它在 mousedown 里 `stopEvent` 吃掉事件，
   * 然后 `NodeSelection.create(state.doc, cell.from + 1)` + rAF 派发 ✓。
   */
  function upstreamTransaction(state, cellStart) {
    return state.tr.setSelection(NodeSelection.create(state.doc, cellStart));
  }

  it("**行为断言**：把上游那次事务折算成折叠光标后，输入只插入、原文一字不丢 ✓", () => {
    const { doc, cellStart } = docWithCell([schema.nodes.paragraph.create(null, schema.text("git status"))]);
    const state = stateOf(doc);
    const upstream = upstreamTransaction(state, cellStart);
    assert.equal(upstream.selection instanceof NodeSelection, true, "前置：上游就是整段结构选择 ✓");
    assert.equal(isCellTextblockSelection(upstream.selection), true, "我们的判据必须认出它 ✗");

    /* 漏斗的动作：按点击坐标算最近的合法文字位置 ✓ */
    const target = caretTargetForTextblockSelection(upstream.doc, upstream.selection, { pos: cellStart, inside: cellStart });
    assert.notEqual(target, null, "必须算得出光标位置 ✓");
    const fixed = state.apply(state.tr.setSelection(TextSelection.create(state.doc, target)));
    assert.equal(fixed.selection instanceof TextSelection, true);
    assert.equal(fixed.selection.empty, true, "选区必须**折叠** ✓（复查的验收 ✓）");

    /* **真输入**：敲一个字 ⇒ 只插入，原内容保留 ✓ */
    const typed = fixed.apply(fixed.tr.insertText("X"));
    assert.equal(cellText(typed.doc), "Xgit status", "原有文字不许被替换 ✗（只多一个 X ✓）");

    /* 反例（对照，证明这条测试有意义 ✓）：不折算直接敲 ⇒ 整段被替换 ✗ */
    const broken = state.apply(upstream);
    const brokenTyped = broken.apply(broken.tr.insertText("X"));
    assert.equal(cellText(brokenTyped.doc), "X", "这就是复查看到的坏结果 ✓");
  });

  it("判据只认「单元格里的 textblock 结构选择」✓（其它一律不动 ✗）", () => {
    const { doc, cellStart } = docWithCell([
      schema.nodes.paragraph.create(null, schema.text("文字")),
      schema.nodes.image.create(),
    ]);
    const state = stateOf(doc);
    /* ① 文字选区 ✓ */
    assert.equal(isCellTextblockSelection(TextSelection.create(doc, cellStart + 1)), false);
    /* ② 单元格里的**真原子块**（图片）⇒ 选中它是要的 ✓ */
    const imagePos = cellStart + schema.nodes.paragraph.create(null, schema.text("文字")).nodeSize;
    assert.equal(isCellTextblockSelection(NodeSelection.create(doc, imagePos)), false);
    /* ③ 表格**外**的段落结构选择（键盘按块选 ⇒ 正常操作 ✓） */
    assert.equal(isCellTextblockSelection(NodeSelection.create(doc, 0)), false);
  });

  it("接线：包住 `view.dispatch` 这只**唯一漏斗** ✓（上游 rAF 也躲不开 ✗）", () => {
    assert.ok(richSource.includes("const baseDispatch = view.dispatch.bind(view);"), "要拿住原始 dispatch ✓");
    assert.ok(richSource.includes("view.dispatch = ("), "要包一层 ✓");
    assert.ok(richSource.includes("isCellTextblockSelection(transaction.selection)"), "判据用事务里的选区 ✓");
    assert.ok(
      richSource.includes("caretTargetForTextblockSelection(transaction.doc, transaction.selection"),
      "用**事务里的文档与选区**折算 ✓（不是 current state ✗）",
    );
    assert.ok(richSource.includes('"table-click-rewritten"'), "改写了要留痕 ✓");
    assert.ok(richSource.includes("if (!transaction.docChanged)"), "只改选区的事务直接丢掉 ✓（顺带丢掉 scrollIntoView ✗）");
    assert.ok(richSource.includes('"table-caret-wired"'), "创建时留痕：接线到底装上没有 ✓");
    assert.ok(
      richSource.includes("CLICK_WINDOW_MS"),
      "只认点击后一小会儿内的坏选区 ✓（键盘造出来的块选择不许动 ✗）",
    );
  });

  it("根因写进了代码注释（上游 `stopEvent` 吃掉了 mousedown ✓）", () => {
    assert.ok(caretSource.includes("stopEvent"), "注释要写明上游 stopEvent ✗");
    assert.ok(caretSource.includes("TableNodeView"), "注释要写明是哪个节点视图 ✓");
    assert.ok(caretSource.includes("requestAnimationFrame"), "注释要写明它是 rAF 之后才派发的 ✓");
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

  it("主路径是 handleClick；**兜底**才用 mouseup + 微任务，而且只看最终选区 ✓", () => {
    /* 复查 P1：真实点击仍然整段选择 ⇒ 主路径可能没兜住 ✓
       ⇒ 保留第二条兜底，但**只在最终选区仍是结构选择时**才动 ✗（主路径成功时它什么都不做 ✓）。 */
    assert.ok(richSource.includes("const onMouseUpFallback"), "要有兜底 ✓");
    assert.ok(richSource.includes("caretTargetForSelection(view.state"), "兜底看的是**最终选区**✓");
    const fallback = richSource.slice(
      richSource.indexOf("const onMouseUpFallback"),
      richSource.indexOf('root.addEventListener("mouseup", onMouseUpFallback, true)'),
    );
    assert.ok(fallback.includes("if (target === null) return;"), "不需要兜底就立刻返回 ✓");
    assert.ok(fallback.includes("queueMicrotask("), "兜底要等 ProseMirror 处理完（微任务 ✓）");
    /* 兜底不是"无条件纠正"：靠纯函数判"是不是结构选择"✓（旧版靠坐标 + 拖选阈值 ✗） */
    assert.ok(caretSource.includes("if (!(selection instanceof NodeSelection)) return null;"), "只看结构选择 ✓");
    assert.ok(!richSource.includes("shouldFixCaret"), "旧的「按坐标无条件纠正」已经换掉 ✓");
    assert.ok(!richSource.includes("caretFixTarget"), "旧 API 已经换掉 ✓");
  });

  it("**诊断留痕**：主路径与兜底都要说清「走到哪一步、结果是什么」✓", () => {
    assert.ok(richSource.includes('"table-click-handle"'), "主路径要留痕（复查要求：不能只以注册了当证据 ✓）");
    assert.ok(richSource.includes('"table-click-fallback"'), "兜底触发要留痕 ✓");
    assert.ok(richSource.includes("target: target === null ? \"none\" : \"caret\""), "要记下有没有算出位置 ✓");
    assert.ok(richSource.includes("inside: coords.inside"), "要记下 posAtCoords 的 inside ✓");
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
