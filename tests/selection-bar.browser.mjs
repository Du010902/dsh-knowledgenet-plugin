/**
 * **划词浮条与宿主「引用」胶囊的共存**（真实 Chromium + 真实组件 ✓）。
 *
 * 用户反馈（截图 ✗）：对话里划词后，DSH 自己的「引用」浮层和插件的「添加节点」浮条
 * 落在同一个位置 —— "浮条的重叠，或者是一个显示，另外一个不显示"✗。
 * 期望：两条合成一条，而且「添加节点」和「引用」长得一样 ✓。
 *
 * 这条测试钉的是**几何与落点**（静态扫描钉不住的部分 ✓）：
 * ① 宿主开着浮层时，胶囊**挂进那条浮层** ✓ —— 同一个容器、并排、**矩形不相交** ✓；
 * ② 胶囊的样式与宿主那颗一致（胶囊圆角 / 内边距 / 字号 / 不透明底 ✓）；
 * ③ 点它仍然打开收集弹窗 ✓（并排之后点击链没断 ✓）；
 * ④ Esc 收、宿主收它也收 ✓；
 * ⑤ 宿主没开浮层时退回"自己浮在选区上方"✓（同一颗胶囊，别丢功能 ✓）。
 *
 * 运行：
 * ```
 * $env:KN_PROJECT='D:/AppInstallation/DSH/deepseek-harness'
 * node --test tests/selection-bar.browser.mjs
 * ```
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

if (!process.env.KN_PROJECT) throw Error("Set KN_PROJECT to the DSH dependency checkout.");
const project = resolve(process.env.KN_PROJECT).replace(/\\/g, "/");
const plugin = fileURLToPath(new URL("../", import.meta.url)).replace(/\\/g, "/");

/** 扫 `.pnpm` 找 rolldown / playwright / react-dom（**不写死版本号** ✓，和别的 `.browser.mjs` 一致 ✓） */
function pnpmEntries(base) {
  try {
    return readdirSync(base).filter((name) => !name.startsWith("@"));
  } catch {
    return [];
  }
}
function firstExisting(candidates, label) {
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  throw new Error(`找不到${label}；尝试过：\n${candidates.filter(Boolean).join("\n")}`);
}
const rolldownPath = firstExisting([
  process.env.KN_ROLldown,
  ...pnpmEntries(`${project}/node_modules/.pnpm`)
    .filter((name) => name.startsWith("rolldown@"))
    .map((name) => `${project}/node_modules/.pnpm/${name}/node_modules/rolldown/dist/index.mjs`),
], "rolldown");
const playwrightPath = firstExisting([
  process.env.KN_PLAYWRIGHT,
  ...pnpmEntries(`${project}/node_modules/.pnpm`)
    .filter((name) => name.startsWith("playwright@"))
    .map((name) => `${project}/node_modules/.pnpm/${name}/node_modules/playwright/index.mjs`),
], "playwright");
const reactDomDir = pnpmEntries(`${project}/node_modules/.pnpm`).find((name) => name.startsWith("react-dom@18.3.1"));
const reactRequire = createRequire(firstExisting([
  reactDomDir ? `${project}/node_modules/.pnpm/${reactDomDir}/node_modules/react-dom/package.json` : undefined,
], "react-dom"));
const { rolldown } = await import(pathToFileURL(rolldownPath).href);
const { chromium } = await import(pathToFileURL(playwrightPath).href);

/*
 * 组装页面：一条假对话（宿主的 `data-conversation-*` 标记 ✓）+ 宿主的划词浮层
 * （`data-text-interaction-surface` 里放一颗「引用」胶囊，就是 `message-quotes` 那个消费者的位置 ✓）
 * + 侧栏里一条会话行 / 工作区行（插件靠它们判"当前会话属于哪个工作区"✓）。
 */
const COPY = {
  addNode: "添加节点",
  addPrereq: "添加为前置",
  addStandalone: "创建独立节点",
  cancel: "取消",
  candidatesMessage: "有相近的节点",
  candidatesTitle: "相近节点",
  createAnyway: "仍然创建",
  createLibraryFailed: "创建知识库失败",
  createNodeDone: "已创建",
  createNodeFailed: "创建节点失败",
  failed: "失败",
  loadingNodes: "正在读取当前知识库…",
  multi: "收集知识点",
  multiAsPrereq: "是否添加为前置",
  multiCount: null,
  multiDetails: "继续在对话中划词会自动追加",
  multiLabel: "被添加的知识点",
  noRecommend: "没有可推荐的最近节点",
  noResult: "没有匹配的知识点",
  nothingSelected: "没有选中文字",
  noWorkspace: "找不到当前工作区",
  recommended: "最近用过",
  resultsLabel: "搜索结果",
  reuse: "复用",
  searchHint: "输入名称搜索",
  searchLabel: "搜索知识点",
  searchPlaceholder: "输入名称搜索",
  searching: "搜索中…",
  selectMark: "选择",
  selected: null,
  statusPick: "请选择要添加到的知识点",
  statusSelected: null,
  targetSection: "添加为谁的前置",
  confirm: "确认",
  added: "已添加",
  multiTitle: "收集知识点",
  multiSubtitle: "标题",
  multiPlaceholder: "占位",
  multiHint: "提示",
  pickTitle: "选择",
  pickHint: "提示",
  titleLabel: "名称",
  done: "完成",
};

const entry = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ChatSelectionBar } from '${plugin}src/client/ChatSelectionBar.tsx'

window.steps = []
window.mounted = false
const copy = ${JSON.stringify(COPY)}
copy.multiCount = (count) => count + ' 个知识点'
copy.selected = (count) => '已选 ' + count + ' 段'
copy.statusSelected = (title) => '添加为「' + title + '」的前置'

const root = createRoot(document.getElementById('root'))
root.render(React.createElement(ChatSelectionBar, {
  copy,
  sessionId: 's1',
  useWorkspaces: () => ({ items: [{ id: 'w1', workspaceId: 'w1', path: 'D:/library' }] }),
  report: (step, detail) => { window.steps.push({ step, detail: detail ?? null }) },
}))
requestAnimationFrame(() => { window.mounted = true })
`;

const PAGE = `<!doctype html><meta charset="utf-8">
<style>
  /* 宿主主题里那几条我们实际用到的 token（真实 DSH 由 ui-theme 声明 ✓）；
     缺了它们，字号那条 var() 会整条失效 ⇒ 回落到继承值 ✗ */
  :root {
    --dsw-font-family: sans-serif;
    --dsw-font-xs-13: 13px/20px var(--dsw-font-family);
    --dsw-alias-label-primary: #141414;
    --dsw-alias-border-l3: rgba(0, 0, 0, 0.12);
    --dsw-alias-button-floating-fill: #ffffff;
    --dsw-alias-button-floating-hover: #f0f0f0;
    --dsw-elevation-panel: 0 4px 16px rgba(0, 0, 0, 0.12);
  }
  body { margin: 0; font: 14px/22px sans-serif; }
  #sidebar { position: fixed; left: 0; top: 0; width: 180px; }
  #root { position: fixed; inset: 0; pointer-events: none; }
  #root > * { pointer-events: auto; }
</style>
<div id="sidebar">
  <div data-row-key="workspace:w1">
    <div data-row-key="session:s1" aria-selected="true">会话</div>
  </div>
</div>
<div data-conversation-content="" data-conversation-session="s1" data-conversation-region="chat"
     style="position: absolute; left: 220px; top: 0; right: 0; height: 600px">
  <div data-conversation-scroll="" style="position: relative; height: 520px; overflow: auto">
    <div id="column" style="position: relative; padding: 140px 40px 40px">
      <div id="surface" data-text-interaction-surface=""
           style="position: absolute; left: 120px; top: 96px; width: max-content; visibility: visible">
        <button type="button" id="quote" style="padding: 5px 10px; border: none; border-radius: 999px;
          background: var(--dsw-alias-button-floating-fill, #fff); color: #111; font: var(--dsw-font-xs-13, 13px/20px sans-serif)">引用</button>
      </div>
      <p id="text" data-text-interaction-source="" style="margin: 0; user-select: text">但强干扰场景下 ENOB 和动态范围就只剩几个 LSB，量化损失迅速变大。</p>
    </div>
  </div>
</div>
<div id="root"></div>
<script src="/app.js"></script>`;

const build = await rolldown({
  input: "virtual:entry",
  plugins: [{
    name: "selection-bar-fixture",
    resolveId(id) {
      if (id === "virtual:entry") return id;
      if (["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"].includes(id)) return reactRequire.resolve(id);
    },
    load(id) { if (id === "virtual:entry") return entry; },
  }],
});
const output = await build.generate({ format: "iife" });
await build.close();
const code = output.output.find(item => item.type === "chunk").code;

const server = createServer((req, res) => {
  res.setHeader("content-type", req.url === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  res.end(req.url === "/app.js" ? code : PAGE);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));

/**
 * 选中 `#text` 的全文并松手（插件就是在这个事件上弹浮条的 ✓）。
 * 传**真函数**给 `page.evaluate`（传返回字符串的箭头函数只会把字符串当返回值 ✗ —— 什么都没发生 ✓）。
 */
const selectText = () => {
  const text = document.getElementById("text");
  const range = document.createRange();
  range.selectNodeContents(text);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const rect = range.getBoundingClientRect();
  document.dispatchEvent(new MouseEvent("mouseup", {
    bubbles: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + 2,
  }));
};

let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.KN_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  /*
   * 等组件**真的装好**（`report("mounted")` 是那次 effect 的最后一行 ✓）：
   * 只等 `window.mounted`（渲染后一帧）会与"document 级监听还没挂上"抢跑 ✗ ——
   * 第一次划词会被丢掉，后面的断言全跟着错位 ✓（实测踩过 ✓）。
   */
  await page.waitForFunction(() => window.steps.some(item => item.step === "mounted"));

  /* ① 宿主开着浮层：胶囊挂进去、和「引用」并排、矩形不相交 */
  await page.evaluate(selectText);
  await page.waitForSelector("#surface .kn-sel-bar");
  const joint = await page.evaluate(() => {
    const surface = document.getElementById("surface");
    const bar = surface.querySelector(".kn-sel-bar");
    const pill = bar.querySelector(".kn-sel-action");
    const quote = document.getElementById("quote");
    const a = pill.getBoundingClientRect();
    const b = quote.getBoundingClientRect();
    const style = getComputedStyle(pill);
    return {
      children: surface.children.length,
      barParentIsSurface: bar.parentElement === surface,
      barCount: document.querySelectorAll(".kn-sel-bar").length,
      floatCount: document.querySelectorAll(".kn-sel-bar-float").length,
      barDisplay: getComputedStyle(bar).display,
      barPosition: getComputedStyle(bar).position,
      border: style.borderRadius,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      fontSize: style.fontSize,
      background: style.backgroundColor,
      shadow: style.boxShadow !== "none",
      sameRow: a.top < b.bottom && b.top < a.bottom,
      overlaps: a.left < b.right && b.left < a.right,
      order: a.left >= b.right,
      text: pill.textContent,
      steps: window.steps.map(item => item.step),
    };
  });
  assert.equal(joint.children, 2, "宿主浮层里应该只有「引用」+「添加节点」两颗（同一条浮条 ✓）");
  assert.equal(joint.barParentIsSurface, true, "胶囊必须挂进宿主那条浮层 ✓（再各弹一条就是重叠 ✗）");
  assert.equal(joint.barCount, 1, "全页只应有一条浮条 ✓");
  assert.equal(joint.floatCount, 0, "宿主开着浮层时不该再出现自己定位的那条 ✗");
  assert.equal(joint.barDisplay, "inline-flex", "并排布局（inline-flex ✓）");
  assert.notEqual(joint.barPosition, "fixed", "不再由插件自己 fixed 定位 ✗");
  assert.equal(joint.border, "999px", "胶囊圆角要和「引用」一样 ✓");
  assert.deepEqual(joint.padding, ["5px", "10px", "5px", "10px"], "内边距要和「引用」一样（5px 10px ✓）");
  assert.equal(joint.fontSize, "13px", "字号要和「引用」一样（--dsw-font-xs-13 ✓）");
  assert.notEqual(joint.background, "rgba(0, 0, 0, 0)", "胶囊要有浮层底色（不是透明 ✓）");
  assert.equal(joint.shadow, true, "胶囊要带浮层投影（--dsw-elevation-panel ✓）");
  assert.equal(joint.sameRow, true, "两颗要在同一排 ✓");
  assert.equal(joint.overlaps, false, "**不许重叠** ✓（用户反馈的就是这一条 ✗）");
  assert.equal(joint.order, true, "「添加节点」在「引用」右边 ✓");
  assert.equal(joint.text, "添加节点", "文案不变 ✓");
  assert.ok(joint.steps.includes("bar-shown"), "要上报 bar-shown（诊断用 ✓）");

  /* ② 点胶囊 ⇒ 打开收集弹窗（并排没有打断点击链 ✓） */
  await page.click("#surface .kn-sel-action");
  await page.waitForSelector(".kn-pick-dialog");
  const opened = await page.evaluate(() => ({
    steps: window.steps.map(item => item.step),
    bar: document.querySelectorAll(".kn-sel-bar").length,
  }));
  assert.ok(opened.steps.includes("open-dialog"), "点胶囊要打开收集弹窗 ✓");
  assert.equal(opened.bar, 0, "打开弹窗后浮条收起 ✓");

  /* ③ Esc：浮条收起（宿主那条浮层也是这么收的 ✓） */
  await page.keyboard.press("Escape");
  await page.evaluate(selectText);
  await page.waitForSelector("#surface .kn-sel-bar");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll(".kn-sel-bar").length === 0);

  /* ④ 宿主收起浮层 ⇒ 我们的胶囊跟着收（宿主只改 visibility ✓） */
  await page.evaluate(selectText);
  await page.waitForSelector("#surface .kn-sel-bar");
  await page.evaluate(() => { document.getElementById("surface").style.visibility = "hidden"; });
  await page.waitForFunction(() => document.querySelectorAll(".kn-sel-bar").length === 0);

  /* ⑤ 宿主没开浮层（隐藏态）⇒ 退回自己浮在选区上方 ✓ */
  await page.evaluate(selectText);
  await page.waitForSelector(".kn-sel-bar-float");
  const standalone = await page.evaluate(() => {
    const bar = document.querySelector(".kn-sel-bar-float");
    const pill = bar.querySelector(".kn-sel-action");
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("text"));
    const text = range.getBoundingClientRect();
    const box = pill.getBoundingClientRect();
    return {
      parent: bar.parentElement === document.body,
      position: getComputedStyle(bar).position,
      border: getComputedStyle(pill).borderRadius,
      above: box.bottom <= text.top,
      inViewport: box.top >= 0 && box.left >= 0,
      surfaceChildren: document.getElementById("surface").children.length,
    };
  });
  assert.equal(standalone.parent, true, "宿主没开浮层时退回 portal 到 body ✓");
  assert.equal(standalone.position, "fixed", "兜底形态自己 fixed 定位 ✓");
  assert.equal(standalone.border, "999px", "兜底形态仍是同一颗胶囊（外观一致 ✓）");
  assert.equal(standalone.above, true, "兜底形态浮在选区上方 ✓");
  assert.equal(standalone.inViewport, true, "兜底形态不许跑出可视区 ✓");
  assert.equal(standalone.surfaceChildren, 1, "宿主浮层里只有它自己的「引用」（我们没挂进去 ✓）");

  /*
   * ⑥ **宿主晚一帧才放出浮层** ⇒ 仍然要挂进它那条，不能再弹自己那条 ✗
   *    （`selectionchange` 是浏览器异步派发的 ⇒ 宿主的浮层可能比我们的 `mouseup` 晚一拍 ✓；
   *     这一拍里如果已经弹了自己那条，下一帧宿主又弹一条 ⇒ 又叠回两条 ✗）
   */
  await page.evaluate(() => {
    const surface = document.getElementById("surface");
    const quote = document.getElementById("quote");
    quote.remove();
    surface.style.visibility = "hidden";
    /* 划词 + 松手（此时宿主还没放出浮层 ✓） */
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("text"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const rect = range.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + 2,
    }));
    /* 同一帧里宿主这才放出自己的浮层（模拟异步的 selectionchange ✓） */
    surface.appendChild(quote);
    surface.style.visibility = "visible";
  });
  await page.waitForSelector("#surface .kn-sel-bar");
  const late = await page.evaluate(() => ({
    barCount: document.querySelectorAll(".kn-sel-bar").length,
    floatCount: document.querySelectorAll(".kn-sel-bar-float").length,
    parentIsSurface: document.querySelector(".kn-sel-bar").parentElement?.id === "surface",
    steps: window.steps.map(item => item.step),
  }));
  assert.equal(late.barCount, 1, "只能有一条浮条 ✓（晚一帧也不能先弹自己那条 ✗）");
  assert.equal(late.floatCount, 0, "宿主这一帧开了浮层 ⇒ 不许出现自己定位那条 ✗");
  assert.equal(late.parentIsSurface, true, "还是挂进宿主那条浮层 ✓");

  assert.deepEqual(errors, [], "页面不该有运行时错误 ✓");
  console.log("划词浮条与「引用」共存通过：挂进同一条浮层、不重叠、同一套胶囊外观、点击/ Esc / 跟随收起 / 兜底定位 / 宿主晚一帧。");
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
