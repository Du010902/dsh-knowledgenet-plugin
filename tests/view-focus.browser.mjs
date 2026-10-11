/** Exercise the real focus hook in Chromium, including editor priority and teardown. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

if (!process.env.KN_PROJECT) throw Error("Set KN_PROJECT to the DSH dependency checkout.");
const project = resolve(process.env.KN_PROJECT).replace(/\\/g, "/");
const plugin = fileURLToPath(new URL("../", import.meta.url)).replace(/\\/g, "/");
const require = createRequire(project + "/package.json");
const { rolldown } = await import(pathToFileURL(project + "/node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/dist/index.mjs").href);
const { chromium } = await import(pathToFileURL(project + "/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs").href);
const reactRequire = createRequire(project + "/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/package.json");
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {useViewFocus} from '${plugin}src/client/view-focus.ts';
window.packets=[]; window.fetch=async(url,opts)=>{window.packets.push(JSON.parse(opts.body));return {json:async()=>({ok:true,leaseMs:3000})};};
const shadow=document.getElementById('app').attachShadow({mode:'open'}); const mount=document.createElement('div');shadow.append(mount);const root=createRoot(mount);
function App(){const[graph,setGraph]=React.useState(null);const[editor,setEditor]=React.useState(null);const[session,setSession]=React.useState('chat');const[element,setElement]=React.useState(null);
useViewFocus({sessionId:session,root:'/library',nodeId:editor??graph,source:editor?'editor':'graph',element});
window.choose=id=>setGraph(id);window.edit=id=>setEditor(id);window.switchSession=()=>{setGraph(null);setEditor(null);setSession('next');};
return React.createElement('div',{ref:setElement,style:{width:300,height:100}},React.createElement('button',{onClick:()=>setGraph('A')},'选择 A'));}
root.render(React.createElement(App));window.hide=()=>{mount.style.display='none';};window.unmount=()=>root.unmount();`;
const build = await rolldown({ input: "virtual:entry", plugins: [{ name: "focus-fixture", resolveId(id) {
  if (id === "virtual:entry") return id;
  if (["react", "react-dom/client", "react-dom"].includes(id)) return reactRequire.resolve(id);
}, load(id) { if (id === "virtual:entry") return entry; } }] });
const output = await build.generate({ format: "iife" }); await build.close();
const code = output.output.find(item => item.type === "chunk").code;
const server = createServer((req, res) => {
  res.setHeader("content-type", req.url === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  res.end(req.url === "/app.js" ? code : '<!doctype html><meta charset="utf-8"><div id="app"></div><script src="/app.js"></script>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.KN_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage(); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: "选择 A" }).click();
  await page.waitForFunction(() => window.packets.some(p => p.active && p.nodeId === "A" && p.focusKind === "graph"));
  await page.evaluate(() => window.edit("B"));
  await page.waitForFunction(() => window.packets.at(-1)?.nodeId === "B" && window.packets.at(-1)?.focusKind === "editor");
  await page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
  await page.waitForFunction(() => window.packets.at(-1)?.active === true && window.packets.at(-1)?.nodeId === "B");
  await page.evaluate(() => window.choose("C"));
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.packets.at(-1).nodeId), "B");
  await page.evaluate(() => window.edit(null));
  await page.waitForFunction(() => window.packets.at(-1)?.nodeId === "C");
  await page.evaluate(() => window.switchSession());
  await page.waitForFunction(() => window.packets.at(-1)?.sessionId === "next");
  const packets = await page.evaluate(() => window.packets);
  assert.ok(packets.some(p => p.sessionId === "chat" && !p.active));
  assert.equal(packets.at(-1).nodeId, null);
  assert.equal(new Set(packets.map(p => p.viewId)).size, 1);
  assert.ok(packets.every((p, i) => i === 0 || p.sequence > packets[i - 1].sequence));
  await page.evaluate(() => window.hide());
  await page.waitForFunction(() => window.packets.at(-1)?.active === false);
  await page.evaluate(() => window.unmount());
  await page.waitForTimeout(100);
  const count = await page.evaluate(() => window.packets.length);
  await page.waitForTimeout(1100);
  assert.equal(await page.evaluate(() => window.packets.length), count);
  assert.deepEqual(errors, []);
  console.log("真实浏览器聚焦同步通过：实际选择、编辑器优先、会话切换、隐藏清理、顺序更新、卸载停止心跳。");
} finally {
  await browser?.close(); await new Promise(done => server.close(done));
}
