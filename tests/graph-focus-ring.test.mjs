/**
 * 画布的**焦点环**：鼠标点一下不该描一圈（用户反馈 2026-10）。
 *
 * 现象：在图谱区域点一下，整块画布外围出现一圈高亮边框 —— 用户原话"这很奇怪"。
 *
 * 根因不是我们写错了，而是两件事撞在一起：
 * 1. 上游为了让 **F / 方向键**能用，在**指针按下**时主动给画布 `element.focus({ preventScroll: true })`
 *    （`graph3d/navigation.ts:221`）；
 * 2. 浏览器把这次**脚本聚焦**也算进 `:focus-visible` ⇒ 命中上游
 *    `graph.css:355` 的 `.universe:focus-visible { outline: 2px … }` ✗。
 *
 * 折中：**只把"鼠标点出来的那一次"的环去掉**；键盘 Tab 过来时照旧有可见焦点（可访问性不掉）✓。
 * 做法是 `GraphPanel` 在容器上捕获 `pointerdown` 打一个 `data-pointer-focus` 标记
 * （捕获阶段先于上游那次 focus），失焦时清掉；CSS 用更高特异性压掉带标记时的 outline ✓。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const panel = await readFile(path.join(HERE, "..", "src", "client", "GraphPanel.tsx"), "utf8");
const css = await readFile(path.join(HERE, "..", "src", "client", "panel.css"), "utf8");
const upstreamCss = await readFile(
  path.join(HERE, "..", "src", "vendor", "upstream", "styles", "graph.css"),
  "utf8",
);
const bundle = await readFile(path.join(HERE, "..", "client.js"), "utf8");

describe("画布焦点环：鼠标点出来的那一次不画", () => {
  it("先确认我们压的是上游那条规则（上游改了就该重看这条覆盖）", () => {
    assert.match(
      upstreamCss,
      /\.universe:focus-visible \{\s*outline:/,
      "上游的 .universe:focus-visible 环还在，覆盖才有意义",
    );
  });

  it("把上游那条环规则**本身**压掉：`:focus` 与 `:focus-visible` 都不画环", () => {
    /*
     * 复查（用户第二次反馈"这个框怎么又变成高亮了"）：只压"鼠标点出来的那一次"不够 ✗ ——
     * **宿主/脚本聚焦**画布时（切标签、侧栏重排后自动聚焦）浏览器同样算 `:focus-visible` ✗，
     * 那时标记不在，环就又冒出来。
     * 所以现在不再依赖浏览器的启发式：`.kn-root .universe` 的 `:focus` 与 `:focus-visible` 一起清掉 ✓。
     */
    assert.match(
      css,
      /\.kn-root \.universe:focus,\s*\n\.kn-root \.universe:focus-visible \{\s*\n\s*outline: none;\s*\n\}/,
      "两条伪类都要压掉（不能只压 :focus-visible ✗）",
    );
    /* 键盘可达性不能丢：Tab 过来时用我们自己打的标记给可见焦点 ✓ */
    assert.match(
      css,
      /\.kn-root \.universe\[data-keyboard-focus="true"\]:focus \{\s*\n\s*outline: 2px solid var\(--accent\);/,
      "键盘聚焦要有可见提示（可访问性 ✓）",
    );
  });

  it("标记时机：捕获阶段 pointerdown 打指针标记并撤键盘标记；Tab 打键盘标记；focusout 清", () => {
    assert.ok(panel.includes('const POINTER_FOCUS_ATTR = "data-pointer-focus"'), "指针标记名两边要一致");
    assert.ok(panel.includes('const KEYBOARD_FOCUS_ATTR = "data-keyboard-focus"'), "键盘标记要定义");
    assert.ok(
      panel.includes('host.addEventListener("pointerdown", markPointerFocus, true)'),
      "指针按下要**捕获阶段**打标记 ✓",
    );
    assert.ok(
      panel.includes('host.addEventListener("focusout", clearPointerFocus, true)'),
      "焦点离开画布要清标记 ✓",
    );
    assert.ok(
      panel.includes('window.addEventListener("keydown", markKeyboardFocus, true)'),
      "Tab 键要打键盘标记（只有它存在时才画环 ✓）",
    );
    assert.ok(
      panel.includes("element.removeAttribute(KEYBOARD_FOCUS_ATTR)"),
      "指针一到就撤掉键盘标记，避免环留在鼠标操作之后 ✗",
    );
    assert.ok(
      panel.includes('canvas()?.setAttribute(KEYBOARD_FOCUS_ATTR, "true")'),
      "标记打在画布根节点（.universe）上 ✓",
    );
  });

  it("产物里规则与接线都在（构建期没有弄丢 ✓）", () => {
    assert.ok(bundle.includes(".kn-root .universe:focus"), "产物里要有压制规则");
    assert.ok(bundle.includes("data-keyboard-focus"), "产物里要有键盘标记");
    assert.ok(bundle.includes("markKeyboardFocus"), "产物里要有 Tab 接线");
  });
});
