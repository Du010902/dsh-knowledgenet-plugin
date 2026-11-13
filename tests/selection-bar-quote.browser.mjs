/**
 * **用户反馈（2026-11 截图）：对话里划词后点「引用」要点两次** ✓。
 *
 * 现象：第一次点「引用」＝浮条从「引用 + 添加节点」变成**只剩一个按钮**（我们的胶囊没了），
 * 文本没有被引用；第二次点才真的引用 ✓。
 *
 * 根因（真实 Chromium 里才看得出来，静态扫描钉不住 ✓）：
 * 我们的胶囊是 `createPortal` 进宿主那条 `[data-text-interaction-surface]` 的 ✓，
 * 而宿主按**浮层总宽**把它居中/夹在可视区里（`useTextInteraction` 的 `place()` ✓）。
 * 旧代码把"按在宿主浮层里"当成"点别处" ⇒ 在下一次 `renderBefore` 之前就 `setBar(null)` ✗
 * ⇒ 浮层少了胶囊、总宽变窄 ⇒ 宿主下一帧 `place()` 重新居中 ⇒ **「引用」按钮位移** ✗
 * ⇒ 这一次 `click` 的落点已经不在按钮上 ⇒ 引用没发生（用户看到了"第一次只掉了一个按钮"✓）。
 *
 * 这条测试把宿主的两件真实行为都还原出来：
 * ① 浮层按选区居中（`place()` ✓，含"内容宽度变了就重排"✓）；
 * ② 宿主的「引用」按钮在 `pointerdown` 上 `preventDefault`（保住选区 ✓）、
 *    在 `click` 里读选区文本并插入（我们用一个假的 `#quoted` 表示 ✓），然后宿主自己收起浮层 ✓。
 *
 * 运行：
 * ```
 * $env:KN_PROJECT='D:/AppInstallation/DSH/deepseek-harness'
 * node --test tests/selection-bar-quote.browser.mjs
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
  statusPick: "请选择要添加到的知识点",
  targetSection: "添加为谁的前置",
  confirm: "确认",
  added: "已添加",
  done: "完成",
};

const entry = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ChatSelectionBar } from '${plugin}src/client/ChatSelectionBar.tsx'

window.steps = []
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

/*
 * 假宿主：
 * - `place()` 照抄宿主的"按选区居中、浮层宽度变了就重排"（`useTextInteraction.place()` ✓）；
 * - 「引用」按钮：pointerdown preventDefault（宿主 `QuoteSelectionAction` 的做法 ✓）、
 *   click 读选区文本 → 记到 #quoted → 收起浮层（宿主 dismiss ✓，只改 visibility ✓）。
 */
const PAGE = `<!doctype html><meta charset="utf-8">
<style>
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
  #root { position: relative; z-index: 10; }
  #quoted { white-space: pre-wrap; }
</style>
<div id="sidebar">
  <div data-row-key="workspace:w1">
    <div data-row-key="session:s1" aria-selected="true">会话</div>
  </div>
</div>
<div data-conversation-content="" data-conversation-session="s1" data-conversation-region="chat"
     style="position: absolute; left: 20px; top: 0; right: 0; height: 600px">
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
<div id="quoted"></div>
<div id="root"></div>
<script>
  window.quote = { clicks: 0, text: '' };
  const surface = () => document.getElementById('surface');
  /** 宿主的 place()：按选区中心居中、夹在可视区；浮层宽度变了会重排 ✓ */
  function place() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const surfaceEl = surface();
    if (surfaceEl.style.visibility === 'hidden') return;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const column = document.getElementById('column').getBoundingClientRect();
    const width = surfaceEl.offsetWidth;
    const height = surfaceEl.offsetHeight;
    const left = rect.left + rect.width / 2 - width / 2 - column.left;
    const top = rect.top - 8 - height - column.top;
    surfaceEl.style.left = Math.max(0, left) + 'px';
    surfaceEl.style.top = Math.max(0, top) + 'px';
  }
  let frame;
  new MutationObserver(() => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => { frame = undefined; place(); });
  }).observe(document.getElementById('surface'), { childList: true });
  const quote = document.getElementById('quote');
  quote.addEventListener('pointerdown', (event) => event.preventDefault());
  quote.addEventListener('click', () => {
    window.quote.clicks += 1;
    window.quote.text = window.getSelection()?.toString() ?? '';
    if (window.quote.text.trim() === '') return;
    document.getElementById('quoted').textContent = window.quote.text;
    surface().style.visibility = 'hidden';   /* 宿主 dismiss：只改 visibility ✓ */
  });
</script>
<script src="/app.js"></script>
`;

const build = await rolldown({
  input: "virtual:entry",
  plugins: [{
    name: "selection-bar-quote-fixture",
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

/** 选中 `#text` 的全文并松手（插件就是在这个事件上弹浮条的 ✓） */
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
  await page.waitForFunction(() => window.mounted === true);
  await page.waitForFunction(() => window.steps.some(item => item.step === "mounted"));

  await page.evaluate(selectText);
  await page.waitForSelector("#surface .kn-sel-bar");
  /* 等宿主那次"浮层宽度变了 ⇒ rAF 重新居中"跑完，再量按钮中心 ✓（否则量完又位移 = 测试自己抖 ✗） */
  await page.waitForTimeout(150);
  /* 浮条并进宿主那条浮层（和「引用」同一条 ✓） */
  const joint = await page.evaluate(() => {
    const surface = document.getElementById("surface");
    return {
      inside: surface.querySelector(".kn-sel-bar") !== null,
      children: surface.children.length,
      quoteText: document.getElementById("quote").textContent,
    };
  });
  assert.equal(joint.inside, true, "胶囊必须挂进宿主那条浮层（bug 3 的前提 ✓）");
  assert.equal(joint.quoteText, "引用", "宿主的「引用」必须在同一条浮层里 ✓");

  /* 记下「引用」现在的中心点（宿主刚重排过一遍 ✓） */
  const center = await page.evaluate(() => {
    const rect = document.getElementById("quote").getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });

  /*
   * **真人点击**：按下 → 等宿主下一帧重排 → 松开 ✓。
   * 旧代码会在按下时把胶囊收掉 ⇒ 浮层变窄 ⇒ 宿主重排 ⇒ 按钮移走 ⇒ 这次 click 落空 ✗。
   */
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  /* 按住时：我们的胶囊**必须还在**（收了就会让按钮位移 ✗ —— 就是这个 bug 的根因 ✓） */
  const held = await page.evaluate(() => ({
    bar: document.querySelectorAll("#surface .kn-sel-bar").length,
    quote: document.getElementById("quote").getBoundingClientRect().left,
  }));
  assert.equal(held.bar, 1, "按下「引用」时不许收掉我们的胶囊（否则浮层会缩窄、按钮位移 ⇒ 要点两次 ✗）");
  await page.waitForTimeout(150);   /* 让宿主的 rAF 重排真的有机会跑 ✓ */
  const beforeUp = await page.evaluate(() => ({
    bar: document.querySelectorAll("#surface .kn-sel-bar").length,
    quote: document.getElementById("quote").getBoundingClientRect().left,
  }));
  assert.equal(beforeUp.bar, 1, "按住期间胶囊要一直在（宿主重排前后都不许消失 ✓）");
  assert.equal(beforeUp.quote, held.quote, "「引用」在按下到松开之间**不许位移**（位移 ⇒ 这次点击落空 ✗）");
  await page.mouse.up();

  /* **一次点击就要引用成功** ✓ */
  await page.waitForFunction(() => window.quote.clicks >= 1);
  const clicked = await page.evaluate(() => ({
    clicks: window.quote.clicks,
    text: window.quote.text,
    quoted: document.getElementById("quoted").textContent,
    surfaceHidden: getComputedStyle(document.getElementById("surface")).visibility,
  }));
  assert.equal(clicked.clicks, 1, "「引用」只该被点中一次就生效 ✓");
  assert.ok(clicked.text.trim() !== "", "引用时读到的选区文本不能为空（宿主 readText 的判据 ✓）");
  assert.equal(clicked.quoted, clicked.text, "点一次就要真的引用到文本 ✓");
  assert.equal(clicked.surfaceHidden, "hidden", "引用成功后宿主收起浮层 ✓");

  /* 宿主收起后我们的胶囊跟着收（MutationObserver ✓） */
  await page.waitForFunction(() => document.querySelectorAll(".kn-sel-bar").length === 0);

  assert.deepEqual(errors, [], "页面不该有运行时错误 ✓");
  console.log("「引用」一次点击即生效通过：按下不收起胶囊、宿主重排前后按钮不位移、点击成功、跟随收起。");
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
