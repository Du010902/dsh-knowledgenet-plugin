/**
 * **「添加节点」浮条 = DSH 自己的划词「引用」浮层** ✓（用户 2026-11 的要求）。
 *
 * 背景（用户实测 + 截图 ✗）：对话里划词之后，宿主本来就会弹一颗「引用」胶囊 ✓；
 * 我们又另起一条 `position: fixed`、z-index 更高的方角浮条 ✗ ⇒ 两条浮层落在同一位置：
 * 要么重叠、要么我们的盖住「引用」（"一个显示，另外一个不显示"✗）。
 * 用户原话：
 *
 * > DSH本身拥有的划词引用，与当前插件的划词添加节点似乎有点冲突，比如浮条的重叠，
 * > 或者是一个显示，另外一个不显示等。修复一下，其次，我期望添加节点的UI与划词引用UI相同
 *
 * 修法两件事，这条测试各钉一半 ✓：
 * ① **外观相同** ✓ —— 胶囊的每一项数值都照宿主
 *    `packages/session/message-quotes/src/client/QuoteSelection.module.css` 的 `.action` 抄 ✓；
 * ② **不再各弹一条** ✓ —— 宿主开着那条浮层时，我们把胶囊**挂进它里面**
 *    （`[data-text-interaction-surface]`，跟在「引用」右边 ✓）；宿主没开时才自己浮在选区上方 ✓。
 *
 * 宿主源码不在本仓库里（插件只装发布产物 ✓），所以这里把**数值与接线**都钉死 ✓：
 * 改宿主那份的时候，这一版得同步对齐，否则就是又一次"两边不一样"✗。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "..", "src", "client");
const bar = readFileSync(path.join(CLIENT, "ChatSelectionBar.tsx"), "utf8");

/** 胶囊那份样式（`.kn-sel-action {` 到容器那条为止 ✓） */
const pillStart = bar.indexOf('".kn-sel-action {"');
const pillBlock = bar.slice(pillStart, bar.indexOf('"@media (hover: hover)', pillStart));
/** 整段浮条样式（胶囊 + 两个落点 ✓；弹窗的样式不在此列 ✗） */
const barBlock = bar.slice(pillStart, bar.indexOf('".kn-ms-label-row', pillStart));

describe("「添加节点」胶囊与宿主「引用」胶囊是同一套外观 ✓", () => {
  it("逐项对齐宿主 `.action`（内边距 / 胶囊圆角 / 底 / 投影 / 字 / 描边取色）", () => {
    assert.notEqual(pillStart, -1, "要能找到胶囊样式 ✓");
    for (const token of [
      "padding: 5px 10px",                                      /* 宿主：5px 10px ✓ */
      "border: none",                                           /* 宿主：border: none ✓ */
      "border-radius: 999px",                                   /* 宿主：999px 胶囊 ✓ */
      "corner-shape: round",
      "background: var(--dsw-alias-button-floating-fill)",      /* 宿主：floating-fill ✓ */
      "--dsw-elevation-stroke-color: var(--dsw-alias-border-l3)", /* 宿主：压边取 border-l3 ✓ */
      "box-shadow: var(--dsw-elevation-panel)",                 /* 宿主：elevation-panel ✓ */
      "color: var(--dsw-alias-label-primary)",
      "font: var(--dsw-font-xs-13)",                            /* 宿主：13px 字 ✓ */
      "cursor: pointer",
    ]) {
      assert.ok(pillBlock.includes(token), `胶囊要有 ${token} ✓`);
    }
    /* 悬停 / 键盘聚焦都换宿主那颗的 hover 底色 ✓（宿主用的是 @media (hover: hover) ✓） */
    assert.ok(
      bar.includes("@media (hover: hover) { .kn-sel-action:hover { background: var(--dsw-alias-button-floating-hover); } }"),
      "悬停要用宿主的 floating-hover ✓",
    );
    assert.ok(
      bar.includes(".kn-sel-action:focus-visible { background: var(--dsw-alias-button-floating-hover); }"),
      "键盘聚焦也要给同样的反馈 ✓",
    );
    /* 自造的那套方角白底必须撤干净 ✗（用户截图里正是它压住「引用」） */
    for (const gone of [
      "border-radius: 8px",
      "0 3px 12px rgb(0 0 0 / 12%)",
      "background: var(--dsw-alias-bg-layer-1)",
      "border: 1px solid var(--dsw-alias-border-l2)",
      "kn-sel-primary",
    ]) {
      assert.equal(barBlock.includes(gone), false, `旧的方角浮条外观必须撤掉：${gone} ✗`);
    }
  });

  it("宿主开着浮层时**挂进同一条浮层**（不再各弹一条 ✗）", () => {
    /*
     * 宿主的划词浮层：`ChatView` 里那颗 div 带 `data-text-interaction-surface` ✓
     * （`ui-chat/src/client/chat/ChatView.tsx` 的 `.textInteraction` ✓），
     * 里面渲染的是当前抢到这次划词的那个 Slot 消费者（默认就是「引用」✓）。
     */
    assert.ok(bar.includes("[data-text-interaction-surface]"), "要认得出宿主那条浮层 ✓");
    assert.ok(bar.includes("hostSelectionSurface"), "要有一个找宿主浮层的判定函数 ✓");
    assert.ok(
      bar.includes("createPortal(") && bar.includes("bar.host ?? document.body"),
      "浮条要 portal 进宿主浮层（拿不到才退回 body ✓）",
    );
    assert.ok(
      bar.includes("[data-text-interaction-surface] .kn-sel-bar { margin-left: 6px; }"),
      "挂在宿主浮层里时只留 6px 间隔（并排、不叠 ✓）",
    );
    /*
     * 宿主没开浮层的那几种情况必须判掉 ✓ —— 否则我们把胶囊挂进一个 `visibility: hidden` 的空壳，
     * 它会跟着宿主一起隐形（表现成"点了没反应 / 浮条不见了"✗）。
     */
    assert.ok(bar.includes("surface.childElementCount === 0"), "浮层里没有宿主动作时不许挂进去 ✓");
    assert.ok(
      /getComputedStyle\(surface\)\.visibility !== "visible"/.test(bar),
      "浮层还是隐藏态时不许挂进去 ✓",
    );
    /* 挂进去之后要跟着宿主一起收（宿主只改 visibility，不改 DOM ✓） */
    assert.ok(bar.includes("new MutationObserver(check)"), "要盯宿主浮层的可见性 ✓");
    assert.ok(
      bar.includes("getComputedStyle(hostOfBar).visibility !== \"visible\""),
      "宿主收起浮层时我们的胶囊也要收起 ✓",
    );
  });

  it("宿主没开浮层时退回自己浮在选区上方 ✓（同一颗胶囊，不另造一套 ✗）", () => {
    assert.ok(
      bar.includes('bar !== null && bar.host === null ? "kn-sel-bar kn-sel-bar-float" : "kn-sel-bar"'),
      "要有独立的浮动形态（宿主没开浮层时才用 ✓）",
    );
    assert.ok(bar.includes(".kn-sel-bar-float { position: fixed; z-index: 10001; transform: translateX(-50%); }"), "独立形态自己定位 ✓");
    assert.ok(bar.includes("Math.max(8, bar.y - 40)"), "仍然浮在选区上方 ✓");
    /*
     * 两种形态用的是**同一颗按钮**（同一个类名）✓ —— 这是"UI 相同"的硬保证：
     * 只换落点，不换控件 ✓。
     */
    assert.equal(bar.includes('className="kn-sel-action"'), true, "两种落点共用同一颗胶囊 ✓");
  });

  it("点浮条仍然不吃选区 ✓（改的是外观与落点，不是行为 ✗）", () => {
    /* 容器类名 `kn-sel-bar` 必须一直挂着 ✓（排除判据 / composedPath 都靠它 ✓） */
    assert.ok(bar.includes('"kn-sel-bar"'), "浮条容器类名不变 ✓（排除判据 / composedPath 都靠它）");
    assert.ok(bar.includes('.kn-sel-bar { display: inline-flex'), "容器本体只有布局，不画底/边/影 ✓（视觉上就是宿主那颗胶囊的兄弟 ✓）");
    assert.ok(bar.includes("onMouseDown={(event) => { event.preventDefault(); }}"), "按下时仍然不许动选区 ✓");
    assert.ok(bar.includes("live === \"\" ? bar.text : live"), "读不到现选区时仍回落到浮条记下的原文 ✓");
    /* Esc 收起：宿主那条浮层就是这么收的 ✓，并排显示时键位必须一致 ✓ */
    assert.ok(bar.includes('event.key === "Escape"'), "Esc 也要收起浮条 ✓");
  });
});
