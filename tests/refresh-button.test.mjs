/**
 * 面板头部「刷新」按钮：形态守门（用户要求 2026-09）。
 *
 * 用户的原话是"改成与浏览器界面一致的圆环形状" ✗→✓：
 * 原来是**文字胶囊**（`.kn-btn` + "刷新"两个字），这轮换成浏览器那颗**圆环刷新图标按钮**：
 * 正方、圆形、无边框、无底色，里面只有一枚 16 网格的圆环箭头图标 ✓。
 *
 * 钉住三件事（都是容易回退的点）：
 * 1. 按钮用的是 `kn-icon-btn` 且**不能再有可见文字**，但读屏名字（`aria-label`）与 hover 说明必须在；
 * 2. 图标必须按**宿主规格**画（16 网格 + 线宽 1），否则和旁边几颗图标粗细对不上（这个仓踩过一次）；
 * 3. 形状覆盖必须写在 `panel.css` **末尾** —— `.kn-root-fill .kn-btn` 那几条响应式规则
 *    会写死 height / padding，它们是单类选择器、与本组同优先级 ⇒ 只有靠"后出现"才压得住 ✗。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL = path.join(HERE, "..", "src", "client", "GraphPanel.tsx");
const ICON = path.join(HERE, "..", "src", "client", "PanelIcon.tsx");
const CSS = path.join(HERE, "..", "src", "client", "panel.css");

const panel = await readFile(PANEL, "utf8");
const icon = await readFile(ICON, "utf8");
const css = await readFile(CSS, "utf8");

describe("刷新按钮：圆环图标形态", () => {
  it("用 kn-icon-btn，且不再渲染「刷新」这两个字（名字交给 aria-label）", () => {
    assert.ok(panel.includes('className="kn-btn kn-icon-btn"'), "刷新按钮必须带 kn-icon-btn");
    assert.ok(panel.includes('aria-label={t("refresh")}'), "没有可见文字 ⇒ 必须给 aria-label（否则读屏念不出）");
    assert.ok(panel.includes('title={t("refreshHint")}'), "hover 说明（重新从磁盘读取）要保留");
    assert.ok(panel.includes("<RefreshRingIcon />"), "按钮里渲染圆环图标");
    /* 可见文字必须去掉：按钮的**子节点**只能是图标（aria-label 不算内容） */
    const start = panel.indexOf('className="kn-btn kn-icon-btn"');
    const button = panel.slice(start, panel.indexOf("</button>", start));
    const body = button.slice(button.indexOf(">") + 1);
    assert.ok(body.includes("<RefreshRingIcon />"), "按钮体里应当只有图标");
    assert.equal(
      /props\.copy\.refresh|t\("refresh"\)(?!\s*})/.test(body.replace(/aria-label=\{[^}]*\}/g, "")),
      false,
      "「刷新」不能再作为可见文字渲染（那又会变成文字胶囊）",
    );
    /* 另一颗按钮（重新整理）保持文字形态：用户只要求改刷新这一颗 */
    assert.ok(
      panel.includes('<button type="button" className="kn-btn" onClick={() => setRelayoutToken'),
      "「重新整理」应保持原来的文字按钮",
    );
  });

  it("图标=harness 产品图标集的原版字形（几何与画法都照抄，不许自己改）", () => {
    const start = icon.indexOf("export function RefreshRingIcon");
    assert.ok(start > 0, "找不到 RefreshRingIcon");
    const glyph = icon.slice(start);
    assert.match(glyph, /viewBox="0 0 16 16"/, "与宿主同网格（16）");
    assert.match(glyph, /strokeWidth=\{1\}/, "与宿主同线宽（ICON_REGULAR_STROKE = 1）");
    /*
     * 两条 path 的 `d` 必须与 `ui-primitives/src/icons/index.tsx` 的 `IconRefreshOutlineArtwork`
     * **逐字一致**（这里是前缀 + 尾段两处取样，中间那段太长，取首尾足够把"换过几何"钉出来）。
     */
    assert.ok(
      glyph.includes('d="M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611'),
      "圆环那条 path 的几何必须是原版（开头对不上就说明自己重画了）",
    );
    assert.ok(glyph.includes("13.0001 3.6L14.5001 5.1\""), "圆环那条 path 的收尾也要与原版一致");
    assert.ok(glyph.includes('d="M14.4999 1.5V5.1H10.8999"'), "箭头那条 path 必须与原版一致");
    /* 画法照抄：每条 path 自带 currentColor 描边；原版**不设** linecap/linejoin（默认 butt/miter） */
    assert.equal((glyph.match(/stroke="currentColor"/g) ?? []).length, 2, "两条 path 都自带 currentColor");
    assert.equal(glyph.includes("strokeLinecap"), false, "原版没有 linecap（上一版自己加 round 就画偏了）");
    assert.equal(glyph.includes("strokeLinejoin"), false, "原版没有 linejoin");
    assert.equal(glyph.includes("<circle"), false, "原版没有 circle 元素（圆环是 path 画的）");
  });

  it("形状=照抄宿主 `.tool` 图标按钮：28×28 圆 + 6px 内边距 + 15px 字形", () => {
    /* 来源：ui-sidebar-files/src/client/FilesBody.module.css 的 .tool */
    assert.match(css, /\.kn-icon-btn \{[\s\S]{0,400}width: 28px/, "按钮宽 28px（与宿主那颗一致）");
    assert.match(css, /\.kn-icon-btn \{[\s\S]{0,400}height: 28px/, "按钮高 28px");
    assert.match(css, /\.kn-icon-btn \{[\s\S]{0,400}padding: 6px/, "6px 内边距（28 − 2×6 = 16 内容区，容纳 15px 字形）");
    assert.match(css, /\.kn-icon-btn \{[\s\S]{0,400}border-radius: var\(--dsw-radius-sm/, "圆角用宿主 token");
    assert.match(css, /\.kn-icon-btn \{[\s\S]{0,400}border: none/, "去掉胶囊边框");
    assert.match(css, /\.kn-icon-btn \{[\s\S]{0,400}background: transparent/, "去掉胶囊底色");
    assert.match(css, /\.kn-icon-btn svg \{[\s\S]{0,120}width: 15px;[\s\S]{0,60}height: 15px/, "字形 15px（与宿主一致）");
    assert.match(css, /\.kn-icon-btn:hover:not\(:disabled\) \{[\s\S]{0,200}interactive-bg-hover/, "hover 用宿主 hover token");
    assert.match(css, /\.kn-icon-btn:focus-visible/, "键盘焦点要看得见");
  });

  it("形状覆盖放在 panel.css 末尾（否则会被 `.kn-root-fill .kn-btn` 的响应式调参压回去）", () => {
    const override = css.indexOf(".kn-root-fill .kn-btn.kn-icon-btn {");
    assert.ok(override > 0, "必须有 .kn-root-fill .kn-btn.kn-icon-btn 这条覆盖");
    /* 所有 `.kn-root-fill .kn-btn {` 单类规则都必须排在这条前面 */
    const singles = [...css.matchAll(/\.kn-root-fill \.kn-btn \{/g)].map((m) => m.index ?? -1);
    assert.ok(singles.length >= 4, `应该有多档响应式调参（实际 ${singles.length} 条）`);
    for (const at of singles) {
      assert.ok(at < override, "覆盖必须出现在所有 `.kn-root-fill .kn-btn` 单类规则之后（同优先级靠后取胜）");
    }
    assert.match(css.slice(override), /width: 28px;[\s\S]{0,200}height: 28px;[\s\S]{0,200}padding: 6px;/, "覆盖里要把宽高与内边距都钉死");
  });
});
