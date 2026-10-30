/** Built GraphPanel → real plugin HTTP → model tool, without a model or DSH changes. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { __internal } from "../index.js";
import { makeV3Fixture, cleanupFixtures } from "./support/v3-fixture.mjs";

if (!process.env.KN_PROJECT) throw Error("Set KN_PROJECT to the DSH dependency checkout.");
const project = resolve(process.env.KN_PROJECT).replace(/\\/g, "/");
const reactRequire = createRequire(project + "/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/package.json");
/* rolldown 版本随 DSH checkout 变化 ⇒ 用装着的那个（优先已验证可用的 1.1.x） */
const rolldownDirs = readdirSync(join(project, "node_modules/.pnpm"));
const rolldownDir = rolldownDirs.find((name) => name.startsWith("rolldown@1.1.")) ?? rolldownDirs.find((name) => name.startsWith("rolldown@"));
if (rolldownDir === undefined) throw Error("No rolldown installation found in the DSH checkout.");
const { rolldown } = await import(pathToFileURL(join(project, "node_modules/.pnpm", rolldownDir, "node_modules/rolldown/dist/index.mjs")).href);
const { chromium } = await import(pathToFileURL(project + "/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs").href);
const fixture = await makeV3Fixture({ nodes: ["场景无关的欺骗检测", "有包络的波包"], edges: [["场景无关的欺骗检测", "有包络的波包"]] });
const state = new __internal.LearningState(3000);
const ctx = { get: name => name === "sessionPersistence" ? { stat: async id => id === "chat" || id === "next" ? { header: { cwd: fixture.workspace } } : undefined } : undefined };
const tools = Object.fromEntries(__internal.createTools({}, state).map(tool => [tool.name, tool]));
const current = async (sessionId = "chat") => tools.kn_current_node.execute({ source: "ui" }, { agent: { id: sessionId, session: { id: sessionId, header: { cwd: fixture.workspace }, snapshotEvents: () => [] } } });
const entry = `import React from 'react';import * as ReactDOM from 'react-dom';import * as JSX from 'react/jsx-runtime';import {createRoot} from 'react-dom/client';
window.__ModuleLoader__={load:({factory})=>{window.plugin=factory(name=>({'react':React,'react-dom':ReactDOM,'react/jsx-runtime':JSX}[name]));}};
window.mountGraph=()=>{const root=createRoot(document.getElementById('app'));window.unmountGraph=()=>root.unmount();
function App(){const[id,setId]=React.useState('chat');window.switchChat=()=>setId('next');return React.createElement(window.plugin.GraphPanel,{sessionId:id,useWorkspaces:()=>({items:[{path:${JSON.stringify(fixture.workspace)},sessionIds:['chat','next']}]}),useTabInfo:()=>({tab:{navigation:{params:{root:${JSON.stringify(fixture.root)}}}}})});}root.render(React.createElement(App));};`;
const build = await rolldown({ input: "virtual:entry", plugins: [{ name: "react-fixture", resolveId(id) {
  if (id === "virtual:entry") return id;
  if (["react", "react-dom", "react-dom/client", "react/jsx-runtime"].includes(id)) return reactRequire.resolve(id);
}, load(id) { if (id === "virtual:entry") return entry; } }] });
const output = await build.generate({ format: "iife" }); await build.close();
const app = output.output.find(item => item.type === "chunk").code;
const compiled = (await readFile(new URL("../client.js", import.meta.url), "utf8")).replace("exports.apply = apply;", "exports.apply = apply; exports.GraphPanel = GraphPanel;");
const packets = [];
const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      let bytes = ""; for await (const chunk of req) bytes += chunk;
      const body = bytes ? JSON.parse(bytes) : undefined;
      if (body?.kind === "view-focus") packets.push(body);
      const result = await __internal.handleApiRequest(ctx, { focusLeaseMs: 3000 }, { url: `http://localhost${req.url}`, method: req.method, json: async () => body }, state);
      res.setHeader("content-type", "application/json"); res.statusCode = result.status; res.end(JSON.stringify(result.body)); return;
    }
    res.setHeader("content-type", req.url.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
    res.end(req.url === "/app.js" ? app : req.url === "/plugin.js" ? compiled : '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}#app{height:760px;width:960px}</style><input id="chat" placeholder="对话输入"><div id="app"></div><script src="/app.js"></script><script src="/plugin.js"></script><script>mountGraph()</script>');
  } catch (error) { res.statusCode = 500; res.end(String(error)); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
let browser;
async function waitTarget(title, sessionId = "chat") {
  for (let count = 0; count < 100; count++) {
    const result = await current(sessionId);
    if (result.node?.title === title || (title === null && result.node === null)) return result;
    await new Promise(done => setTimeout(done, 50));
  }
  assert.fail(JSON.stringify(await current(sessionId)));
}
try {
  browser = await chromium.launch({ executablePath: process.env.KN_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const search = page.getByRole("searchbox"); await search.waitFor();
  assert.equal((await current()).node, null, "Default layout must not publish a user selection");
  await search.fill("波包"); await page.getByRole("option", { name: "有包络的波包" }).click();
  await waitTarget("有包络的波包");
  await page.getByRole("button", { name: "编辑笔记", exact: true }).click();
  await page.locator(".kn-editor-title").filter({ hasText: "有包络的波包" }).waitFor();
  await page.locator('.ProseMirror').waitFor();
  const opened = await waitTarget("有包络的波包"); assert.equal(opened.focusKind, "editor");
  /*
   * 用户 2026-10-30 审核：打开笔记后能直接输入；关闭时选择「继续编辑」要把焦点还给正文 ✓
   * （之前焦点停在已卸载的弹窗按钮上，回 body，得再点一下正文 ✗）
   */
  await page.keyboard.type(" edited");
  await page.locator(".kn-editor-close").click();
  const leaveDialog = page.locator(".kn-modal");
  await leaveDialog.waitFor();
  await leaveDialog.getByRole("button", { name: "继续编辑", exact: true }).click();
  await leaveDialog.waitFor({ state: "detached" });
  await page.waitForTimeout(150);
  const continuationFocus = await page.evaluate(() => {
    const host = document.getElementById("app").querySelector("div").querySelector("div");
    const root = host.shadowRoot;
    const active = root.activeElement ?? document.activeElement;
    const prose = root.querySelector(".ProseMirror");
    return { inProseMirror: prose !== null && active !== null && prose.contains(active), tag: active?.tagName ?? null };
  });
  assert.equal(continuationFocus.inProseMirror, true, "继续编辑后焦点要回正文，用户可以直接接着写 ✓");
  await page.evaluate(() => { document.querySelector('#app').querySelector('div').querySelector('div').shadowRoot.querySelector('.kn-head-panel').style.display='none'; document.hasFocus=()=>false; window.dispatchEvent(new Event('blur')); });
  await page.locator("#chat").fill("解释一下当前知识点");
  await page.waitForTimeout(1200);
  assert.equal((await current()).node.title, "有包络的波包", "Chat focus or hidden toolbar must not clear an open note");
  await page.evaluate(() => window.switchChat()); await waitTarget(null, "chat");
  await waitTarget("有包络的波包", "next");
  await page.evaluate(() => { document.getElementById('app').style.display='none'; }); await waitTarget(null, "next");
  await page.evaluate(() => { document.getElementById('app').style.display='block'; }); await waitTarget("有包络的波包", "next");
  await page.evaluate(() => window.unmountGraph()); await waitTarget(null, "next");
  assert.ok(packets.some(packet => packet.active && packet.focusKind === "editor"));
  assert.deepEqual(errors, []);
  console.log("完整聚焦浏览器流程通过：真实 GraphPanel、笔记弹窗、聊天输入、窗口失焦、隐藏标题栏、会话切换、隐藏/卸载 → HTTP → kn_current_node。");
} finally { await browser?.close(); await new Promise(done => server.close(done)); state.dispose(); await cleanupFixtures(); }
