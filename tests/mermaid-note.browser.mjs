/**
 * **Mermaid 图块的浏览器端到端测试** ✓（`design/mermaid-note-blocks.md` ✓）。
 *
 * 和 `tests/*.browser.mjs` 一样，用**构建产物** `client.js` + 真实的 GraphPanel + 笔记弹窗
 * 跑 headless Chrome ✓ —— 静态断言证明不了"图真的画出来了 / 输入真的没被吞" ✗：
 *
 * 1. 渲染：mermaid 围栏变成 `.kn-mermaid svg` ✓（中文标签在、没有 foreignObject ✓、源码区收起 ✓）；
 * 2. 动作：复制为代码 ⇒ 剪贴板里是围栏源码 ✓；下载图像 ⇒ 真的触发一次下载 ✓（PNG 或退化的 SVG ✓）；
 * 3. 输入保护：在**空的** mermaid 块里逐字输入 ⇒ 字符一个不丢、焦点不丢、输入期间不出预览 ✓，
 *    失焦后才出现图 ✓（这是实测过的致命 UX ✗，见设计记录 ✓）；
 * 4. 失败路径：非法语法 ⇒ 预览位置给可读原因 ✓，源码仍可编辑 ✓。
 *
 * 运行（需要 DSH 依赖仓库里的 rolldown / playwright / react-dom）：
 * ```
 * $env:KN_PROJECT='D:/AppInstallation/DSH/deepseek-harness'
 * node --test tests/mermaid-note.browser.mjs
 * ```
 * 可选：`KN_CHROME`（Chrome 可执行文件）、`KN_ROLldown`、`KN_PLAYWRIGHT`。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import { __internal } from "../index.js";
import { writeNote } from "../src/host/v3/store.ts";
import { cleanupFixtures, makeV3Fixture } from "./support/v3-fixture.mjs";

if (!process.env.KN_PROJECT) throw Error("Set KN_PROJECT to the DSH dependency checkout.");
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const PROJECT = resolve(process.env.KN_PROJECT).replace(/\\/g, "/");
const DEPS = `${REPO}/.tmp-build-deps`;
const CHROME = process.env.KN_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

after(async () => {
  await cleanupFixtures();
});

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

/** 扫描 .pnpm 找 rolldown / playwright / react-dom（不写死版本号 ✓） */
function resolveTooling() {
  const rolldownPath = firstExisting([
    process.env.KN_ROLldown,
    ...[DEPS, PROJECT].flatMap((base) => pnpmEntries(`${base}/node_modules/.pnpm`)
      .filter((name) => name.startsWith("rolldown@"))
      .map((name) => `${base}/node_modules/.pnpm/${name}/node_modules/rolldown/dist/index.mjs`)),
  ], "rolldown");
  const playwrightPath = firstExisting([
    process.env.KN_PLAYWRIGHT,
    ...pnpmEntries(`${PROJECT}/node_modules/.pnpm`)
      .filter((name) => name.startsWith("playwright@"))
      .map((name) => `${PROJECT}/node_modules/.pnpm/${name}/node_modules/playwright/index.mjs`),
  ], "playwright");
  const reactDomDir = pnpmEntries(`${PROJECT}/node_modules/.pnpm`).find((name) => name.startsWith("react-dom@18.3.1"));
  const reactRequire = createRequire(firstExisting([
    reactDomDir ? `${PROJECT}/node_modules/.pnpm/${reactDomDir}/node_modules/react-dom/package.json` : undefined,
  ], "react-dom"));
  return { rolldownPath, playwrightPath, reactRequire };
}

/** 页面里的小工具（穿透 Shadow DOM ✓——面板整个在 shadow root 里 ✗） */
function installPageHelpers() {
  const deepAll = (selector, root = document) => {
    const out = [];
    const visit = (node) => {
      out.push(...node.querySelectorAll(selector));
      for (const el of node.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(root);
    return out;
  };
  const deepActive = () => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };
  window.__knTest = { deepAll, deepActive };
}

/** 造一个 v3 节点并写入正文（front-matter 由 store 维护 ✓） */
async function buildFixture({ title, body }) {
  const fixture = await makeV3Fixture({ nodes: [title] });
  const node = fixture.nodes[title];
  const written = await writeNote(fixture.root, { id: node.id, text: body });
  if (written.ok !== true) throw new Error(`写夹具正文失败：${written.code} ${written.message}`);
  return { ...fixture, title };
}

/**
 * 起一次"真实 client.js + /api/ + 页面"，返回 page 与收尾函数 ✓。
 * @param {{ title: string, body: string, viewport?: { width: number, height: number } }} options
 */
async function startHarness({ title, body, viewport = { width: 1280, height: 980 } }) {
  const fixture = await buildFixture({ title, body });
  const tooling = resolveTooling();
  const { rolldown } = await import(pathToFileURL(tooling.rolldownPath).href);
  const { chromium } = await import(pathToFileURL(tooling.playwrightPath).href);

  const entry = `import React from 'react';import * as ReactDOM from 'react-dom';import * as JSX from 'react/jsx-runtime';import {createRoot} from 'react-dom/client';
window.__ModuleLoader__={load:({factory})=>{window.plugin=factory(name=>({'react':React,'react-dom':ReactDOM,'react/jsx-runtime':JSX}[name]));}};
window.mountGraph=()=>{const root=createRoot(document.getElementById('app'));
function App(){return React.createElement(window.plugin.GraphPanel,{sessionId:'chat',useWorkspaces:()=>({items:[{path:${JSON.stringify(fixture.workspace)},sessionIds:['chat']}]}),useTabInfo:()=>({tab:{navigation:{params:{root:${JSON.stringify(fixture.root)}}}}})});}root.render(React.createElement(App));};`;
  const build = await rolldown({
    input: "virtual:entry",
    plugins: [{
      name: "kn-mermaid-test-react",
      resolveId(id) {
        if (id === "virtual:entry") return id;
        if (["react", "react-dom", "react-dom/client", "react/jsx-runtime"].includes(id)) return tooling.reactRequire.resolve(id);
        return null;
      },
      load(id) {
        return id === "virtual:entry" ? entry : null;
      },
    }],
  });
  const output = await build.generate({ format: "iife" });
  await build.close();
  const app = output.output.find((item) => item.type === "chunk").code;
  const compiled = (await readFile(`${REPO}/client.js`, "utf8")).replace(
    "exports.apply = apply;",
    "exports.apply = apply; exports.GraphPanel = GraphPanel;",
  );
  if (!compiled.includes("exports.GraphPanel = GraphPanel;")) throw new Error("client.js 里没有 exports.apply，无法暴露 GraphPanel");

  const state = new __internal.LearningState(3000);
  const ctx = { get: (name) => (name === "sessionPersistence" ? { stat: async (id) => (id === "chat" ? { header: { cwd: fixture.workspace } } : undefined) } : undefined) };
  const server = createServer(async (request, response) => {
    try {
      if (request.url.startsWith("/api/")) {
        let bytes = "";
        for await (const chunk of request) bytes += chunk;
        const requestBody = bytes ? JSON.parse(bytes) : undefined;
        const result = await __internal.handleApiRequest(ctx, { focusLeaseMs: 3000 }, {
          url: `http://localhost${request.url}`,
          method: request.method,
          json: async () => requestBody,
        }, state);
        response.setHeader("content-type", "application/json");
        response.statusCode = result.status;
        response.end(JSON.stringify(result.body));
        return;
      }
      response.setHeader("content-type", request.url.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
      response.end(request.url === "/app.js" ? app : request.url === "/plugin.js" ? compiled
        : `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}#app{height:${viewport.height - 40}px;width:${viewport.width - 40}px}</style><div id="app"></div><script src="/app.js"></script><script src="/plugin.js"></script><script>mountGraph()</script>`);
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({
    viewport,
    acceptDownloads: true,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await page.addInitScript(installPageHelpers);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);

  async function openNote() {
    await page.getByRole("searchbox").waitFor({ timeout: 20000 });
    await page.getByRole("searchbox").fill(title);
    await page.getByRole("option", { name: title, exact: true }).click({ timeout: 20000 });
    await page.getByRole("button", { name: "编辑笔记", exact: true }).click({ timeout: 20000 });
    await page.locator(".kn-editor-title").filter({ hasText: title }).waitFor({ timeout: 20000 });
    await page.locator(".ProseMirror").waitFor({ timeout: 30000 });
    await page.waitForFunction(
      () => window.__knTest.deepAll(".milkdown-code-block").length > 0,
      undefined,
      { timeout: 30000 },
    );
  }

  async function close() {
    await browser.close().catch(() => {});
    await new Promise((done) => server.close(done));
    state.dispose();
  }

  return { page, openNote, close, pageErrors };
}

/** 等 mermaid 块里出现真正的图（不是「渲染中…」占位 ✓） */
async function waitForMermaidSvg(page, timeout = 40000) {
  await page.waitForFunction(() => {
    const blocks = window.__knTest.deepAll(".milkdown-code-block");
    return blocks.some((block) => block.querySelector(".kn-mermaid svg") !== null);
  }, undefined, { timeout });
}

/** 取第一个 mermaid 块里的图信息 ✓ */
function readRenderedFacts(page) {
  return page.evaluate(() => {
    const block = window.__knTest.deepAll(".milkdown-code-block").find((candidate) => candidate.querySelector(".kn-mermaid") !== null);
    if (!block) return null;
    const preview = block.querySelector(".preview");
    const wrapper = block.querySelector(".kn-mermaid");
    const svg = wrapper?.querySelector("svg") ?? null;
    const actions = Array.from(wrapper?.querySelectorAll("[data-kn-mermaid-action]") ?? []).map((button) => ({
      action: button.getAttribute("data-kn-mermaid-action"),
      text: button.textContent?.trim() ?? "",
    }));
    const codemirror = block.querySelector(".codemirror-host");
    return {
      hasSvg: svg !== null,
      svgText: svg?.textContent ?? "",
      foreignObjects: svg?.querySelectorAll("foreignObject").length ?? 0,
      styleTags: svg?.querySelectorAll("style").length ?? 0,
      svgRect: svg === null ? null : { width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height },
      previewRect: preview === null ? null : { width: preview.getBoundingClientRect().width, height: preview.getBoundingClientRect().height },
      sourceHidden: codemirror === null ? null : getComputedStyle(codemirror).display === "none",
      actions,
      blockHeight: block.getBoundingClientRect().height,
    };
  });
}

/** 读剪贴板 ✓ */
function readClipboard(page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** 把焦点从 CodeMirror 挪走（点标题栏不会改正文 ✓） */
async function blurEditor(page) {
  await page.evaluate(() => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    el?.blur?.();
  });
}

describe("Mermaid 图块（真实浏览器）", () => {
  it("围栏渲染成图：中文在、无 foreignObject、源码区收起、两个动作在", async () => {
    const harness = await startHarness({
      title: "Mermaid 渲染",
      body: [
        "## Mermaid 图",
        "",
        "```mermaid",
        "graph TD;",
        "  A[卫星无线电信号] --> B[天线]",
        "  B --> C[射频前端: 放大、滤波、下变频]",
        "  C --> D[ADC: 模拟信号转数字采样]",
        "```",
        "",
      ].join("\n"),
    });
    try {
      await harness.openNote();
      await waitForMermaidSvg(harness.page);
      const facts = await readRenderedFacts(harness.page);
      assert.ok(facts !== null, "应当找到渲染好的 mermaid 块");
      assert.equal(facts.hasSvg, true, "预览里必须真的有 SVG ✓");
      assert.ok(facts.svgText.includes("卫星无线电信号"), "中文标签要渲染出来 ✓");
      assert.ok(facts.svgText.includes("ADC"), "图中文字要完整 ✓");
      assert.equal(facts.foreignObjects, 0, "根级 htmlLabels:false ⇒ 不应有 foreignObject ✓");
      assert.ok(facts.styleTags >= 1, "mermaid 的主题样式在 SVG 内部的 <style> 里 ✓");
      assert.ok(facts.svgRect.width >= 100 && facts.svgRect.height >= 100, `图尺寸太小：${JSON.stringify(facts.svgRect)}`);
      assert.equal(facts.sourceHidden, true, "默认「只看结果」⇒ 源码区收起 ✓");
      assert.deepEqual(facts.actions, [
        { action: "copy", text: "复制为代码" },
        { action: "download", text: "下载图像" },
      ], "两个动作按钮都要在 ✓");
      assert.deepEqual(harness.pageErrors, [], "不应有页面异常 ✓");
    } finally {
      await harness.close();
    }
  });

  it("主题 token 生效（含 color-mix），图不会因现代颜色语法失败", async () => {
    const harness = await startHarness({
      title: "Mermaid 主题",
      body: ["## 主题", "", "```mermaid", "graph TD; A[主题甲] --> B[主题乙]", "```", ""].join("\n"),
    });
    try {
      /*
       * 宿主 token：普通 hex + 一个 `color-mix`（现代颜色语法，mermaid 自己解析不了 ✗）。
       * 渲染器要先用 canvas 把 token 算成 rgb 再交给 mermaid ✓，否则整张图会渲染失败 ✗。
       */
      await harness.page.addStyleTag({
        content: ":root{--dsw-alias-label-primary:#123456;--dsw-alias-label-secondary:#556677;--dsw-alias-bg-layer-1:#fefefe;--dsw-alias-bg-layer-2:#f5f5f5;--dsw-alias-border-l2:color-mix(in srgb, #445566 50%, white);--dsw-alias-brand-primary:#aa0000;}",
      });
      await harness.openNote();
      await waitForMermaidSvg(harness.page);
      const facts = await harness.page.evaluate(() => {
        const svg = window.__knTest.deepAll(".kn-mermaid svg")[0];
        return {
          style: svg?.querySelector("style")?.textContent ?? "",
          errorCount: window.__knTest.deepAll(".kn-mermaid-error").length,
        };
      });
      assert.equal(facts.errorCount, 0, "现代颜色语法不能让图渲染失败 ✗");
      assert.equal(facts.style.includes("color-mix"), false, "SVG 样式里不许残留 color-mix ✗");
      assert.ok(/18,\s*52,\s*86/.test(facts.style), `主题文字色没有生效：${facts.style.slice(0, 200)}`);
      assert.deepEqual(harness.pageErrors, []);
    } finally {
      await harness.close();
    }
  });
  it("一个笔记里两张图：都能渲染；改其中一张不串图、也不影响公式块", async () => {
    const harness = await startHarness({
      title: "Mermaid 多图",
      body: [
        "## 多图",
        "",
        "```mermaid",
        "graph TD; A[第一张图] --> B[节点二]",
        "```",
        "",
        /* **同正文、不同语言**的普通代码块：不能让 mermaid 那张图被"语言判定"误伤 ✗ */
        "```python",
        "graph TD; A[第一张图] --> B[节点二]",
        "```",
        "",
        "$$",
        "\\frac{1}{2}",
        "$$",
        "",
        "```mermaid",
        "graph LR; C[第二张图] --> D[节点四]",
        "```",
        "",
      ].join("\n"),
    });
    try {
      await harness.openNote();
      /* 两张图必须都出来（以前共享一个防抖计时器时只有最后一张能出来 ✗） */
      await harness.page.waitForFunction(
        () => window.__knTest.deepAll(".kn-mermaid svg").length === 2,
        undefined,
        { timeout: 40000 },
      );
      const texts = await harness.page.evaluate(() =>
        window.__knTest.deepAll(".kn-mermaid svg").map((svg) => svg.textContent ?? ""));
      assert.ok(texts[0].includes("第一张图"), `第一张图不对：${texts[0]}`);
      assert.ok(texts[1].includes("第二张图"), `第二张图不对：${texts[1]}`);
      /* 公式块照旧渲染（latex 特性那一层没有被 mermaid 的 renderPreview 顶掉 ✓） */
      const formulaVisible = await harness.page.evaluate(() => {
        const display = window.__knTest.deepAll(".katex-display")[0];
        return display !== undefined && display.getBoundingClientRect().height > 0;
      });
      assert.equal(formulaVisible, true, "公式块不能被 Mermaid 接线改坏 ✓");

      /* 改第二张图：编辑源码 ⇒ 全选重写 ⇒ 失焦 ⇒ 只有第二张变 ✓ */
      const mermaidBlocks = harness.page.locator(".milkdown-code-block").filter({ has: harness.page.locator(".kn-mermaid") });
      await mermaidBlocks.nth(1).getByRole("button", { name: "编辑源码" }).click();
      await mermaidBlocks.nth(1).locator(".cm-content").click();
      await harness.page.keyboard.press("Control+A");
      await harness.page.keyboard.type("graph LR; X[改写之后] --> Y[收尾]");
      await blurEditor(harness.page);
      await harness.page.waitForFunction(() => {
        const svgs = window.__knTest.deepAll(".kn-mermaid svg");
        return svgs.length === 2 && (svgs[1].textContent ?? "").includes("改写之后");
      }, undefined, { timeout: 40000 });
      const after = await harness.page.evaluate(() =>
        window.__knTest.deepAll(".kn-mermaid svg").map((svg) => svg.textContent ?? ""));
      assert.ok(after[0].includes("第一张图"), `改第二张时第一张被串了：${after[0]}`);
      assert.ok(after[1].includes("改写之后"), `第二张没有更新：${after[1]}`);
      assert.deepEqual(harness.pageErrors, []);
    } finally {
      await harness.close();
    }
  });

  it("复制为代码：剪贴板里是围栏源码", async () => {
    const source = "graph LR; A[输入] --> B{判断}; B -->|是| C[处理]";
    const harness = await startHarness({
      title: "Mermaid 复制",
      body: ["## 复制", "", "```mermaid", source, "```", ""].join("\n"),
    });
    try {
      await harness.openNote();
      await waitForMermaidSvg(harness.page);
      await harness.page.locator('[data-kn-mermaid-action="copy"]').first().click();
      await new Promise((done) => setTimeout(done, 150));
      const text = await readClipboard(harness.page);
      assert.equal(text, source, "剪贴板里应当是围栏源码（不是渲染后的图 / HTML）✓");
      assert.deepEqual(harness.pageErrors, []);
    } finally {
      await harness.close();
    }
  });

  it("下载图像：真的触发一次文件下载（PNG，或退化的 SVG）", async () => {
    const harness = await startHarness({
      title: "Mermaid 下载",
      body: ["## 下载", "", "```mermaid", "graph TD; A[开始] --> B[结束]", "```", ""].join("\n"),
    });
    try {
      await harness.openNote();
      await waitForMermaidSvg(harness.page);
      const [download] = await Promise.all([
        harness.page.waitForEvent("download", { timeout: 30000 }),
        harness.page.locator('[data-kn-mermaid-action="download"]').first().click(),
      ]);
      const filename = download.suggestedFilename();
      assert.match(filename, /^mermaid-diagram-\d{8}-\d{6}\.(png|svg)$/, `文件名不对：${filename}`);
      const saved = await download.path();
      assert.ok(saved !== null && saved !== undefined, "下载应当拿到本地临时文件 ✓");
      const { stat } = await import("node:fs/promises");
      const bytes = (await stat(saved)).size;
      if (process.env.KN_DEBUG) console.log(`[kn debug] downloaded ${filename} (${bytes} bytes)`);
      assert.ok(bytes > 500, `下载的文件太小：${bytes} 字节`);
      assert.deepEqual(harness.pageErrors, []);
    } finally {
      await harness.close();
    }
  });

  it("输入保护：空的 mermaid 块里逐字输入不被预览吞掉，失焦后才出图", async () => {
    const harness = await startHarness({
      title: "Mermaid 输入",
      body: ["## 输入", "", "```mermaid", "```", ""].join("\n"),
    });
    try {
      await harness.openNote();
      /* 点进空块的 CodeMirror（Playwright 的 locator 会穿透 Shadow DOM ✓） */
      await harness.page.locator(".cm-content").first().click();
      const chars = "graph TD; A[卫星]-->B[天线]";
      for (const char of chars) await harness.page.keyboard.type(char);
      const state = await harness.page.evaluate(() => {
        const content = window.__knTest.deepAll(".cm-content").find((cm) => (cm.textContent ?? "").includes("graph TD"));
        const active = window.__knTest.deepActive();
        const blocks = window.__knTest.deepAll(".milkdown-code-block");
        const hasDiagram = blocks.some((block) => block.querySelector(".kn-mermaid svg") !== null);
        return {
          text: content?.textContent ?? "",
          focusInCodeMirror: active !== null && active.closest?.(".cm-content") !== null,
          hasDiagram,
        };
      });
      assert.equal(state.text, chars, "逐字输入不能丢字符 ✓（丢一个就说明预览把源码藏了 ✗）");
      assert.equal(state.focusInCodeMirror, true, "输入期间焦点必须留在 CodeMirror 里 ✓");
      assert.equal(state.hasDiagram, false, "输入期间不应当把图顶出来（源码不能被隐藏 ✓）");

      /* 失焦 ⇒ 图出现 */
      await blurEditor(harness.page);
      await waitForMermaidSvg(harness.page);
      const facts = await readRenderedFacts(harness.page);
      assert.equal(facts?.hasSvg, true);
      assert.ok(facts?.svgText.includes("卫星"), "失焦后图里应当是刚输入的标签 ✓");
      assert.equal(facts?.sourceHidden, true, "失焦后回到「只看结果」✓");
      assert.deepEqual(harness.pageErrors, []);
    } finally {
      await harness.close();
    }
  });

  it("失焦后马上回焦继续输入：旧渲染不许抢焦点 / 吞字符", async () => {
    const harness = await startHarness({
      title: "Mermaid 回焦",
      body: ["## 回焦", "", "```mermaid", "```", ""].join("\n"),
    });
    try {
      await harness.openNote();
      await harness.page.locator(".cm-content").first().click();
      await harness.page.keyboard.insertText("graph TD; A[甲]-->B[乙]");
      await blurEditor(harness.page);
      /*
       * 失焦后 180ms 防抖 + 首次还要加载 mermaid（≈0.6s）⇒ 这段时间内回焦并继续打字。
       * 旧版本会把"旧的源码"渲染结果回填 ⇒ 源码区被加 .hidden、焦点掉 body、后面字符全丢 ✗。
       */
      await new Promise((done) => setTimeout(done, 60));
      await harness.page.locator(".cm-content").first().click();
      await harness.page.keyboard.press("End");
      await harness.page.keyboard.insertText(" --> C[丙]");
      await new Promise((done) => setTimeout(done, 250));
      const during = await harness.page.evaluate(() => {
        const content = window.__knTest.deepAll(".cm-content").find((cm) => (cm.textContent ?? "").includes("graph TD"));
        const active = window.__knTest.deepActive();
        const host = window.__knTest.deepAll(".codemirror-host")[0];
        return {
          text: content?.textContent ?? "",
          focusInCodeMirror: active !== null && active.closest?.(".cm-content") !== null,
          hostHidden: host === undefined || getComputedStyle(host).display === "none",
        };
      });
      assert.ok(during.text.includes(" --> C[丙]"), `回焦后输入的字符被吞了：${JSON.stringify(during.text)}`);
      assert.equal(during.focusInCodeMirror, true, "旧渲染不能把焦点抢走 ✓");
      assert.equal(during.hostHidden, false, "编辑中源码区不能被隐藏 ✓");

      /* 再失焦 ⇒ 旧结果被丢弃，按最新源码出图 ✓ */
      await blurEditor(harness.page);
      await harness.page.waitForFunction(() => {
        const svg = window.__knTest.deepAll(".kn-mermaid svg")[0];
        return svg !== undefined && (svg.textContent ?? "").includes("丙");
      }, undefined, { timeout: 40000 });
      assert.deepEqual(harness.pageErrors, []);
    } finally {
      await harness.close();
    }
  });

  it("渲染失败：给出可读原因，源码仍可编辑", async () => {
    const harness = await startHarness({
      title: "Mermaid 失败",
      body: ["## 失败", "", "```mermaid", "graph TD; A-->", "```", ""].join("\n"),
    });
    try {
      await harness.openNote();
      await harness.page.waitForFunction(
        () => window.__knTest.deepAll(".kn-mermaid-error").length > 0,
        undefined,
        { timeout: 40000 },
      );
      const facts = await harness.page.evaluate(() => {
        const error = window.__knTest.deepAll(".kn-mermaid-error")[0];
        return { text: error?.textContent ?? "", title: error?.querySelector(".kn-mermaid-error-title")?.textContent ?? "" };
      });
      assert.ok(facts.title.includes("Mermaid 图渲染失败"), `失败标题不对：${facts.title}`);
      assert.ok(facts.text.includes("Parse error") || facts.text.includes("parse"), `原因应当可读：${facts.text}`);
      /* 源码仍可编辑：点「编辑源码」后 CodeMirror 可见 ✓ */
      await harness.page.getByRole("button", { name: "编辑源码" }).first().click();
      const visible = await harness.page.evaluate(() => {
        const host = window.__knTest.deepAll(".codemirror-host")[0];
        return host !== undefined && getComputedStyle(host).display !== "none" && host.getBoundingClientRect().height > 0;
      });
      assert.equal(visible, true, "失败后源码必须仍可编辑 ✓");
      assert.deepEqual(harness.pageErrors, []);
    } finally {
      await harness.close();
    }
  });
});
