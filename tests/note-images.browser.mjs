/**
 * **笔记图片「原图预览」的浏览器端到端测试** ✓
 * （`design/note-images-storage.md` 第八/九轮 ✓）。
 *
 * 背景（用户两次实测）：
 * ① "在当前笔记中插入图片，会变得很糊"✓ —— 文件本身没坏（磁盘字节与原文件逐字节相同 ✓），
 *    糊的是**显示**：正文栏最宽 860px（面板里 ~770px ✓）⇒ 一张 2000px 宽的图只剩 ~40% ✓，
 *    图里的小字没有像素 ✓；
 * ② 第一版自绘了一个铺满视口的 `<dialog>` ✓ —— 结果右上角按钮被 **Windows 原生标题栏**
 *    （窗口控制按钮）压住 ✗；用户说"DSH 自己的这种图片查看方式就很好，为什么不直接用它的"✓
 *    ⇒ 改成**直接复用宿主共享的 `ImageLightbox`** ✓
 *    （`@deepseek-ai/dsh-client-ui-primitives` ✓；DSH 里点聊天/文档图片看原图就是它 ✓）。
 *
 * 这条测试用**真实构建产物** `client.js` + 真实 `/api/` + headless Chrome 钉住四件事 ✓：
 * ① 正文里确实被压小 ✓（这是"糊"的前提 ✓）；
 * ② 点图片 ⇒ 打开的是**宿主的那块预览** ✓（`role="dialog"` + 我们给的两条本地化 labels ✓，
 *    图片是**原图字节** ✓、`alt` 是图注 ✓）；
 * ③ 关闭路径：Esc ✓ / × ✓ / 点遮罩 ✓；
 * ④ 编辑器卸载时预览跟着走 ✓（它是 React 组件 ✓，不像上一版那样挂在 body 上要手动收 ✗）。
 *
 * ⚠️ 关于宿主组件本身：真实实现是 DSH 的
 * `packages/client/ui-primitives/src/ImageLightbox.tsx` ✓（portal 到 body ✓、
 * 舞台 `inset: var(--dsh-frame-chrome-top, 0px) 0 0` 避开 Windows 标题栏 ✓、
 * Esc / 遮罩 / × / 焦点还原 ✓）。这里没有 DSH 的样式表与 React 运行时，所以给模块表注入一个
 * **严格照契约实现的替身** ✓（portal、`role=dialog`、三条关闭路径、焦点还原全都照做 ✓）——
 * 这条测试验证的是**插件的接线**（点什么 / 传哪张 / 文案 / 什么时候关 ✓）；
 * 宿主组件自己的行为由宿主仓库的测试覆盖 ✓（`image-lightbox.client.spec.tsx` ✓）。
 *
 * 运行（和别的 `.browser.mjs` 一样，需要 DSH 依赖仓库里的 rolldown / playwright / react-dom）：
 * ```
 * $env:KN_PROJECT='D:/AppInstallation/DSH/deepseek-harness'
 * node --test tests/note-images.browser.mjs
 * ```
 * 可选：`KN_CHROME`（Chrome 可执行文件）、`KN_ROLldown`、`KN_PLAYWRIGHT`。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { deflateSync } from "node:zlib";

import { __internal } from "../index.js";
import { writeNote } from "../src/host/v3/store.ts";
import { cleanupFixtures, makeV3Fixture } from "./support/v3-fixture.mjs";

if (!process.env.KN_PROJECT) throw Error("Set KN_PROJECT to the DSH dependency checkout.");
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const PROJECT = resolve(process.env.KN_PROJECT).replace(/\\/g, "/");
const DEPS = `${REPO}/.tmp-build-deps`;
const CHROME = process.env.KN_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

/** 测试图：2000×1400 ✓（正文里会被压到 ~40% ⇒ 复现用户说的"糊"✓） */
const IMAGE_WIDTH = 2000;
const IMAGE_HEIGHT = 1400;
const IMAGE_NAME = "wide.png";
const IMAGE_CAPTION = "示意图";
const TITLE = "图片预览";
const BODY = `![1.00](image/${IMAGE_NAME} "${IMAGE_CAPTION}")\n`;
const VIEWPORT = { width: 1920, height: 1080 };
/** 面板宽度：**故意窄** ✓（真实宿主里右侧面板 ~863px，窗口 1920px ✓ ⇒ 正文栏里的图只有 ~40% ✓） */
const PANEL_WIDTH = 900;
/** 原图预览的选择器 ✓（宿主组件的对话框 ✓；笔记编辑器本身也是 role=dialog ✗，必须区分 ✓） */
const LIGHTBOX = '[role="dialog"][aria-label="查看大图"]';

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

/**
 * 页面里的小工具（**穿透 Shadow DOM** ✓ —— 面板整个在 shadow root 里 ✗，
 * `document.querySelector(".milkdown-image-block img")` 永远是 null ✓）。
 */
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
  const deepOne = (selector) => deepAll(selector)[0] ?? null;
  window.__knTest = { deepAll, deepOne };
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

/* ---------------------------------------------------------------- PNG 合成 ---
 * 测试要一张**大图**（正文里必须被压小 ✓）。这里自己造一张纯色 PNG ✓ ——
 * 不往仓库里塞二进制夹具 ✓，也不依赖 `design/` 里那几张截图（它们会被换掉 ✓）。
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

/** 造一张纯色（带两条色带，截图里看得出方向 ✓）的 24 位 PNG ✓ */
function makePng(width, height) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; /* filter: none ✓ */
    const band = Math.floor(y / 140) % 2 === 0;
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = band ? 236 : 210;
      raw[at + 1] = band ? 242 : 228;
      raw[at + 2] = band ? 250 : 244;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; /* bit depth ✓ */
  ihdr[9] = 2; /* color type: truecolor ✓ */
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 造一个库：一个节点（正文只有那张图 ✓）+ `<库根>/image/wide.png` ✓ */
async function buildFixture() {
  const fixture = await makeV3Fixture({ nodes: [TITLE] });
  const node = fixture.nodes[TITLE];
  await mkdir(resolve(fixture.root, "image"), { recursive: true });
  await writeFile(resolve(fixture.root, "image", IMAGE_NAME), makePng(IMAGE_WIDTH, IMAGE_HEIGHT));
  const written = await writeNote(fixture.root, { id: node.id, text: BODY });
  if (written.ok !== true) throw new Error(`写夹具正文失败：${written.code} ${written.message}`);
  return fixture;
}

/**
 * 宿主基线模块里那块**原图预览**的**契约替身** ✓。
 *
 * 形状照抄 DSH 的 `ImageLightbox` ✓：portal 到 `document.body` ✓、`role="dialog"` ✓、
 * Esc / 点遮罩 / × 三条关闭路径 ✓、关闭时把焦点还给打开者 ✓、图片按窗口等比缩放 ✓。
 * 只替掉样式细节（这里没有 DSH 的样式表 ✓）——测试关心的是"插件有没有把这些交对" ✓。
 */
const HOST_LIGHTBOX_STUB = `
const ImageLightbox = function ImageLightbox(props) {
  const closeRef = React.useRef(null);
  const restoreRef = React.useRef(null);
  React.useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (closeRef.current) closeRef.current.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") { event.stopPropagation(); props.onClose(); }
      if (event.key === "Tab") { event.preventDefault(); if (closeRef.current) closeRef.current.focus(); }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (restoreRef.current) restoreRef.current.focus();
    };
  }, [props.onClose]);
  return ReactDOM.createPortal(
    React.createElement("div", {
      className: "host-lightbox", role: "dialog", "aria-modal": "true",
      "aria-label": props.labels.dialog,
      style: { position: "fixed", inset: "0", zIndex: 1000 },
    },
      React.createElement("div", {
        className: "host-lightbox-stage",
        style: { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px" },
      },
        React.createElement("div", {
          className: "host-lightbox-mask",
          style: { position: "absolute", inset: "0", background: "rgba(0,0,0,0.4)" },
          onMouseDown: props.onClose,
        }),
        React.createElement("img", {
          className: "host-lightbox-image", src: props.src, alt: props.alt,
          style: { position: "relative", maxWidth: "min(100%, 1600px)", maxHeight: "100%", objectFit: "contain" },
        }),
        React.createElement("button", {
          type: "button", className: "host-lightbox-close", "aria-label": props.labels.close,
          onClick: props.onClose, ref: closeRef,
          style: { position: "absolute", top: "20px", right: "20px", zIndex: 1, width: "36px", height: "36px" },
        }, "\\u00d7")
      )
    ),
    document.body
  );
};
`;

/** 起一次"真实 client.js + /api/ + 页面"✓ */
async function startHarness() {
  const fixture = await buildFixture();
  const tooling = resolveTooling();
  const { rolldown } = await import(pathToFileURL(tooling.rolldownPath).href);
  const { chromium } = await import(pathToFileURL(tooling.playwrightPath).href);

  const entry = `import React from 'react';import * as ReactDOM from 'react-dom';import * as JSX from 'react/jsx-runtime';import {createRoot} from 'react-dom/client';
${HOST_LIGHTBOX_STUB}
const hostPrimitives = { ImageLightbox };
window.__ModuleLoader__={load:({factory})=>{window.plugin=factory(name=>({'react':React,'react-dom':ReactDOM,'react/jsx-runtime':JSX,'@deepseek-ai/dsh-client-ui-primitives':hostPrimitives}[name]));}};
window.mountGraph=()=>{const root=createRoot(document.getElementById('app'));
function App(){return React.createElement(window.plugin.GraphPanel,{sessionId:'chat',useWorkspaces:()=>({items:[{path:${JSON.stringify(fixture.workspace)},sessionIds:['chat']}]}),useTabInfo:()=>({tab:{navigation:{params:{root:${JSON.stringify(fixture.root)}}}}})});}root.render(React.createElement(App));};`;
  const build = await rolldown({
    input: "virtual:entry",
    plugins: [{
      name: "kn-note-images-test-react",
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
  /*
   * 把 `GraphPanel` 暴露出来 ✓（与 `client.js` 的加载器契约同一套手法 ✓，
   * 见 `tests/mermaid-note.browser.mjs` 的同一行 ✓）。
   */
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
        response.statusCode = result.status;
        /* 取图走**原始字节** ✓（宿主不再包 JSON ✓）—— 这一条不接的话图片永远 404 ✓ */
        if (result.raw) {
          const buffer = Buffer.from(await result.raw.arrayBuffer());
          response.setHeader("content-type", result.raw.headers.get("content-type") ?? "application/octet-stream");
          response.end(buffer);
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(result.body));
        return;
      }
      response.setHeader("content-type", request.url.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
      response.end(request.url === "/app.js" ? app : request.url === "/plugin.js" ? compiled
        : `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}#app{height:${VIEWPORT.height}px;width:${PANEL_WIDTH}px}</style><div id="app"></div><script src="/app.js"></script><script src="/plugin.js"></script><script>mountGraph()</script>`);
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.addInitScript(installPageHelpers);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);

  async function openNote() {
    await page.getByRole("searchbox").waitFor({ timeout: 20000 });
    await page.getByRole("searchbox").fill(TITLE);
    await page.getByRole("option", { name: TITLE, exact: true }).click({ timeout: 20000 });
    await page.getByRole("button", { name: "编辑笔记", exact: true }).click({ timeout: 20000 });
    await page.locator(".kn-editor-title").filter({ hasText: TITLE }).waitFor({ timeout: 20000 });
    await page.locator(".ProseMirror").waitFor({ timeout: 30000 });
    await page.locator(".milkdown-image-block img").first().waitFor({ state: "attached", timeout: 30000 });
    /* 等取图（fetch → blob）+ 两次 load 都稳定 ✓ */
    await page.waitForFunction(() => {
      const img = window.__knTest.deepOne(".milkdown-image-block img");
      return img !== null && img.naturalWidth > 0;
    }, undefined, { timeout: 30000 });
    await page.waitForTimeout(600);
  }

  /**
   * 用**真实鼠标坐标**点图片 ✓。
   * 为什么不用 `locator.click()` ✗：图片块被选中时 Crepe 会在 `.image-wrapper` 上盖一层
   * `::before`（没有 `pointer-events:none` ✗）⇒ Playwright 的可操作性检查一直报
   * "intercepts pointer events" ✓ 而**真人点得到** ✓（我们的委托监听也照常收到 ✓）。
   */
  async function clickImage() {
    const box = await page.locator(".milkdown-image-block img").first().boundingBox();
    assert.notEqual(box, null, "图片必须有布局盒子 ✓");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }

  async function close() {
    await browser.close().catch(() => {});
    await new Promise((done) => server.close(done));
    state.dispose();
  }

  return { page, openNote, clickImage, close, pageErrors, fixture };
}

/** 读"正文里那张图"与"宿主预览里那张图"的事实 ✓ */
function readFacts(page) {
  return page.evaluate(() => {
    const noteImage = window.__knTest.deepOne(".milkdown-image-block img");
    const dialog = document.querySelector(".host-lightbox");
    const previewImage = dialog === null ? null : dialog.querySelector("img");
    const noteRect = noteImage === null ? null : noteImage.getBoundingClientRect();
    const previewRect = previewImage === null ? null : previewImage.getBoundingClientRect();
    const dialogRect = dialog === null ? null : dialog.getBoundingClientRect();
    return {
      note: noteImage === null ? null : {
        width: Math.round((noteRect?.width ?? 0) * 100) / 100,
        naturalWidth: noteImage.naturalWidth,
        naturalHeight: noteImage.naturalHeight,
        srcKind: (noteImage.getAttribute("src") ?? "").split(":")[0],
        rawSrc: noteImage.getAttribute("data-kn-raw-src"),
      },
      preview: dialog === null || previewImage === null || previewRect === null || dialogRect === null ? null : {
        dialogLabel: dialog.getAttribute("aria-label"),
        closeLabel: dialog.querySelector("button")?.getAttribute("aria-label") ?? null,
        inBody: dialog.parentElement === document.body,
        width: Math.round(previewRect.width * 100) / 100,
        height: Math.round(previewRect.height * 100) / 100,
        naturalWidth: previewImage.naturalWidth,
        alt: previewImage.getAttribute("alt"),
        srcKind: (previewImage.getAttribute("src") ?? "").split(":")[0],
        dialogRect: { width: dialogRect.width, height: dialogRect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      },
    };
  });
}

describe("笔记图片「原图预览」（真实浏览器）", () => {
  it("正文里确实被压小（这就是用户说的「糊」✓）；点图片 ⇒ 打开**宿主的**原图预览 ✓", async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      const before = await readFacts(harness.page);
      assert.notEqual(before.note, null, "正文里要有那张图 ✓");
      assert.equal(before.note.naturalWidth, IMAGE_WIDTH, "取回来的必须是**原图**字节 ✓（不是缩略图 ✗）");
      assert.equal(before.note.naturalHeight, IMAGE_HEIGHT, "高度也要是原图的 ✓");
      assert.equal(before.note.rawSrc, `image/${IMAGE_NAME}`, "Markdown 里仍然是库内相对路径 ✓");
      assert.equal(before.note.srcKind, "blob", "显示走的是我们自己 fetch 回来的 blob: ✓");
      /* 「糊」的前提：正文里显示宽度只有自然的 ~40% ✓ */
      const noteRatio = before.note.width / before.note.naturalWidth;
      assert.ok(noteRatio < 0.5, `正文里应被压到 50% 以下（实际 ${(noteRatio * 100).toFixed(1)}%）✓`);
      assert.equal(before.preview, null, "没点之前不该有预览 ✓");

      await harness.clickImage();
      await harness.page.locator(LIGHTBOX).waitFor({ state: "visible", timeout: 10000 });
      await harness.page.waitForTimeout(200);
      const after = await readFacts(harness.page);
      assert.notEqual(after.preview, null, "点图片要打开原图预览 ✓");
      assert.equal(after.preview.dialogLabel, "查看大图", "对话框的无障碍名称来自我们的词典 ✓");
      assert.equal(after.preview.closeLabel, "关闭", "关闭按钮的无障碍名称来自我们的词典 ✓");
      assert.equal(after.preview.srcKind, "blob", "预览里也直接复用那张 blob 原图 ✓（不重新下载 ✗）");
      assert.equal(after.preview.naturalWidth, IMAGE_WIDTH, "预览里必须是原图分辨率 ✓");
      assert.equal(after.preview.alt, IMAGE_CAPTION, "`alt` 用图注 ✓");
      /* 宿主组件 portal 到 document.body ✓（不是塞进面板的 shadow root 里 ✗） */
      assert.equal(after.preview.inBody, true, "预览要挂在轻 DOM 的 body 上 ✓（宿主组件的契约 ✓）");
      assert.ok(
        Math.abs(after.preview.dialogRect.width - after.preview.viewport.width) < 2,
        `预览要铺满窗口 ✓（实际 ${after.preview.dialogRect.width}）`,
      );
      assert.ok(
        after.preview.width > before.note.width * 1.4,
        `预览里的图必须比正文里大得多 ✓（正文 ${before.note.width}px，预览 ${after.preview.width}px）`,
      );
    } finally {
      await harness.close();
    }
  });

  it("三条关闭路径：Esc ✓ / × ✓ / 点遮罩 ✓", async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      await harness.clickImage();
      await harness.page.locator(LIGHTBOX).waitFor({ state: "visible", timeout: 10000 });
      await harness.page.keyboard.press("Escape");
      await harness.page.waitForTimeout(200);
      assert.equal(await harness.page.locator(LIGHTBOX).count(), 0, "Esc 要关掉 ✓");

      await harness.clickImage();
      await harness.page.locator(LIGHTBOX).waitFor({ state: "visible", timeout: 10000 });
      await harness.page.locator(".host-lightbox button").click();
      await harness.page.waitForTimeout(200);
      assert.equal(await harness.page.locator(LIGHTBOX).count(), 0, "× 要关掉 ✓");

      await harness.clickImage();
      await harness.page.locator(LIGHTBOX).waitFor({ state: "visible", timeout: 10000 });
      const box = await harness.page.locator(LIGHTBOX).boundingBox();
      /* 遮罩在舞台里、整个窗口铺满 ✓ ⇒ 点左上角（还在遮罩上 ✓） */
      await harness.page.mouse.click(box.x + 8, box.y + 8);
      await harness.page.waitForTimeout(200);
      assert.equal(await harness.page.locator(LIGHTBOX).count(), 0, "点遮罩要关掉 ✓");
    } finally {
      await harness.close();
    }
  });

  it("关掉编辑器 ⇒ 预览一起消失 ✓（React 组件跟着卸载，不像上一版挂在 body 上要手动收 ✗）", async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      await harness.clickImage();
      await harness.page.locator(LIGHTBOX).waitFor({ state: "visible", timeout: 10000 });
      /* 遮罩盖着面板，真人点不到关闭按钮 ✓ ⇒ 用**程序化 click** 模拟宿主/切标签把编辑器收掉 ✓ */
      await harness.page.locator(".kn-editor-close").evaluate((el) => el.click());
      await harness.page.waitForTimeout(600);
      assert.equal(await harness.page.locator(LIGHTBOX).count(), 0, "编辑器关掉后预览必须一起消失 ✓");
    } finally {
      await harness.close();
    }
  });
});
