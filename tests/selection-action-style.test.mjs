/**
 * **"添加节点"浮条 = 编辑区里那颗「＋ 添加前置节点」的同一套外观** ✓
 * （用户实测要求："添加节点（浮条）的 UI 风格，修改成与文档编辑中添加前置节点一致"✓）。
 *
 * 两边的样式来源不同 ✗ —— 浮条在 `document.body`（拿不到面板样式 ✓）⇒ 自带一份内联样式串 ✓；
 * 编辑区那颗在 `panel.css` ✓。所以"一致"这件事必须**被测出来** ✗，
 * 否则改一边忘一边就又跑偏了 ✓（这条测试就是干这个的 ✓）。
 *
 * 比对的是**具体数值**（圆角 / 内边距 / 字号 / 底色 / 边 / 投影 / 悬停浓度 ✓）：
 * 圆角矩形（不是 999px 胶囊 ✗）、`bg-layer-1` 底、`border-l2` 细边、
 * 柔和投影（`0 3px 12px 12%` ✗）、12px 字、`5px 8px` 内边距 ✓。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "..", "src", "client");
const bar = readFileSync(path.join(CLIENT, "ChatSelectionBar.tsx"), "utf8");
const css = readFileSync(path.join(CLIENT, "panel.css"), "utf8");

/** 浮条那份样式串（取 `.kn-sel-bar {` 到主按钮那条为止 ✓） */
const barStart = bar.indexOf('".kn-sel-bar {"');
const barBlock = bar.slice(barStart, bar.indexOf('".kn-ms-label-row', barStart));

describe("浮条与「＋ 添加前置节点」外观一致 ✓", () => {
  it("浮条：圆角矩形 + 细边 + 柔和投影 ✓（不再是胶囊 ✗）", () => {
    assert.notEqual(barStart, -1, "要能找到浮条样式 ✓");
    for (const token of [
      "border-radius: 8px", /* 容器是圆角矩形 ✓（按钮 6px ✓） */
      "border: 1px solid var(--dsw-alias-border-l2)",
      "background: var(--dsw-alias-bg-layer-1)",
      "box-shadow: 0 3px 12px rgb(0 0 0 / 12%)",
      "font-size: 12px",
    ]) {
      assert.ok(barBlock.includes(token), `浮条要有 ${token} ✓`);
    }
    assert.ok(!barBlock.includes("border-radius: 999px"), "不许再用胶囊圆角 ✗");
    assert.ok(!barBlock.includes("0 6px 20px"), "不许再用更重的投影 ✗");
    assert.ok(!barBlock.includes("bg-layer-2"), "底色要和编辑区那颗一致（layer-1 ✓）");
  });

  it("浮条按钮：6px 圆角 / 5px 8px 内边距 / 悬停 7% ✓", () => {
    assert.ok(barBlock.includes("border-radius: 6px"), "按钮圆角 6px ✓");
    assert.ok(barBlock.includes("padding: 5px 8px"), "内边距 5px 8px ✓");
    assert.ok(barBlock.includes("color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)"), "悬停浓度 7% ✓");
    assert.ok(
      /\.kn-sel-primary \{ background: transparent;/.test(barBlock),
      "主按钮常态**透明底** ✓（与参照物一致；铺底反而更显眼 ✗）",
    );
    assert.ok(barBlock.includes(".kn-sel-primary:focus-visible"), "键盘聚焦也要给反馈 ✓");
  });

  it("编辑区那颗（参照物）仍在，而且数值就是上面这套 ✓", () => {
    const relationsAt = css.indexOf(".kn-note-relations button {");
    assert.notEqual(relationsAt, -1, "参照物样式要在 panel.css 里 ✓");
    const relations = css.slice(relationsAt, relationsAt + 220);
    for (const token of ["border-radius: 6px", "padding: 5px 8px", "font-size: 12px"]) {
      assert.ok(relations.includes(token), `参照物要有 ${token} ✓`);
    }
    const selectionAt = css.indexOf(".kn-note-relations .kn-note-selection {");
    assert.notEqual(selectionAt, -1, "选区浮钮那条要在 ✓");
    const selection = css.slice(selectionAt, selectionAt + 260);
    for (const token of [
      "background: var(--dsw-alias-bg-layer-1)",
      "border: 1px solid var(--dsw-alias-border-l2)",
      "box-shadow: 0 3px 12px rgb(0 0 0 / 12%)",
    ]) {
      assert.ok(selection.includes(token), `参照物要有 ${token} ✓`);
    }
  });

  it("浮条仍然挂在选区上方、并不吃选区 ✓（改的是外观，不是行为 ✗）", () => {
    assert.ok(bar.includes('className="kn-sel-bar"'), "浮条容器类名不变 ✓");
    assert.ok(bar.includes("Math.max(8, bar.y - 40)"), "仍然浮在选区上方 ✓");
    assert.ok(bar.includes("onMouseDown={(event) => { event.preventDefault(); }}"), "按下时仍然不许动选区 ✓");
  });
});
