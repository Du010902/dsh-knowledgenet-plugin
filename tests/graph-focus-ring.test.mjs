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

describe("画布焦点环：鼠标点出来的那一次不画", () => {
  it("先确认我们压的是上游那条规则（上游改了就该重看这条覆盖）", () => {
    assert.match(
      upstreamCss,
      /\.universe:focus-visible \{\s*outline:/,
      "上游的 .universe:focus-visible 环还在，覆盖才有意义",
    );
  });

  it("覆盖规则：`.kn-root` + 属性选择器 ⇒ 特异性高于上游那条单类规则", () => {
    assert.match(
      css,
      /\.kn-root \.universe\[data-pointer-focus="true"\]:focus-visible \{\s*outline: none;\s*\}/,
      "要有这条把环关掉的规则",
    );
  });

  it("标记的时机：捕获阶段 pointerdown（先于上游 focus）打上、focusout 清掉", () => {
    assert.ok(panel.includes('const POINTER_FOCUS_ATTR = "data-pointer-focus"'), "属性名两边必须一致");
    assert.ok(
      panel.includes('host.addEventListener("pointerdown", markPointerFocus, true)'),
      "要在**捕获阶段**打标记：上游的 focus() 在指针处理里，捕获先执行 ✓",
    );
    assert.ok(
      panel.includes('host.addEventListener("focusout", clearPointerFocus, true)'),
      "焦点离开画布要清标记，否则下一次键盘聚焦也会被误伤 ✗",
    );
    assert.ok(
      panel.includes('canvas()?.setAttribute(POINTER_FOCUS_ATTR, "true")')
        && panel.includes('canvas()?.removeAttribute(POINTER_FOCUS_ATTR)'),
      "标记打在画布根节点（.universe）上，正是上游环所在的那个元素",
    );
  });
});
