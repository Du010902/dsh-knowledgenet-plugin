/**
 * 「在资源管理器中显示当前笔记」按钮（用户 2026-10-29 要求 ✓）。
 *
 * 三轮定稿（每轮的原因都写在下面，别再踩回去 ✗）：
 * ① 第一版：客户端直接调 `ctx.remote.session.openWorkspacePath` + 挂载时探测决定显不显示 ——
 *    **编译型插件客户端拿不到 Client Remote**（实机诊断 `reason: "no-remote"`）⇒ 按钮永远不出现 ✗；
 * ② 第二版：改成"节点已知就显示"，点击走**插件宿主路由** ✓ —— 但宿主 `reveal-note` 分支还没接上；
 * ③ 定稿：客户端只发 `{kind:"reveal-note", nodeId, root|sessionId}`，**宿主半**按 nodeId 解析
 *    实际 md 路径并直连 `sessionController.openWorkspacePath({ action: "reveal" })` ✓，
 *    平台分支/路径校验/命令注入边界仍归宿主 ✓，插件不自己 spawn ✗。
 *
 * 本文件钉住三层：
 * - **客户端请求行为**：请求体形状、root/sessionId 二选一、失败归因、诊断上报都真的跑一遍；
 * - **宿主路由行为**：真跑 `handleApiRequest`（临时 v3 库夹具 + 假 `sessionController`）验证
 *   "nodeId → 绝对路径 → { action: \"reveal\" }" 的完整链路与各种失败；
 * - **接线契约**：按钮在标题栏关闭按钮左侧、传 nodeId/target/fetcher（不传绝对路径 ✗）、
 *   图标为什么是本地 SVG（Shadow DOM 里宿主 sprite 的 `<use>` 画不出来 ✓）、中英文案与样式。
 *
 * 为什么没有组件级 DOM 测试：本仓库 `node --test` 环境不装 jsdom / react-dom ✗
 * （仓库惯例："纯函数/路由真跑 + 其余源码契约" ✓，先例 `dialog-keyboard.ts` ✓）；
 * 真实渲染由 `tests/node-conversations.browser.mjs` 的浏览器回归覆盖 ✓（按钮可见 + 点击发出 reveal-note 请求 ✓）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { makeV3Fixture, cleanupFixtures } from "./support/v3-fixture.mjs";
import { handleApiRequest } from "../src/host/api.ts";
import { reportRevealDiag, revealNoteInFileManager } from "../src/client/reveal-note.ts";

after(cleanupFixtures);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "..", "src", "client");
const read = (name) => readFileSync(path.join(CLIENT, name), "utf8");
const editor = read("NodeDocumentEditor.tsx");
const panel = read("GraphPanel.tsx");
const button = read("RevealInFileManager.tsx");
const icons = read("PanelIcon.tsx");
const entry = read("index.ts");
const css = read("panel.css");
const revealNote = read("reveal-note.ts");
const api = readFileSync(path.join(HERE, "..", "src", "host", "api.ts"), "utf8");

/** 假 fetch 注入点：记录请求体并回给定 JSON ✓ */
function fakeFetcher(response = { ok: true }) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { json: async () => response };
  };
  return { fetcher, calls };
}

/* ============================ 客户端请求 · 真跑 ============================ */

describe("客户端请求：`{kind:\"reveal-note\", nodeId, root|sessionId}` ✓", () => {
  it("成功：nodeId + root，同源插件路由；**绝不传绝对路径** ✗", async () => {
    const { fetcher, calls } = fakeFetcher({ ok: true, path: "Nodes/a.md" });
    const outcome = await revealNoteInFileManager({ fetcher, nodeId: "node-a", target: { root: "D:\\ws\\kb\\.dsh_knowledge" } });
    assert.deepEqual(outcome, { ok: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { kind: "reveal-note", nodeId: "node-a", root: "D:\\ws\\kb\\.dsh_knowledge" });
    assert.equal(JSON.stringify(calls[0].body).includes(".md"), false, "不传文件绝对路径 ✓（宿主自己按 nodeId 解析 ✓）");
  });

  it("只给 sessionId 时发 sessionId；root 非空时优先 root ✓", async () => {
    const first = fakeFetcher();
    await revealNoteInFileManager({ fetcher: first.fetcher, nodeId: "n", target: { sessionId: "chat-1" } });
    assert.deepEqual(first.calls[0].body, { kind: "reveal-note", nodeId: "n", sessionId: "chat-1" });
    const second = fakeFetcher();
    await revealNoteInFileManager({ fetcher: second.fetcher, nodeId: "n", target: { root: "/lib", sessionId: "chat-1" } });
    assert.deepEqual(second.calls[0].body, { kind: "reveal-note", nodeId: "n", root: "/lib" });
  });

  it("失败：宿主回 error ⇒ 带 code/message；传输抛错也收敛成可读结果（不抛 ✓）", async () => {
    const refused = await revealNoteInFileManager({
      fetcher: fakeFetcher({ ok: false, error: { code: "reveal_failed", message: "explorer failed" } }).fetcher,
      nodeId: "n",
      target: { root: "/lib" },
    });
    assert.deepEqual(refused, { ok: false, code: "reveal_failed", message: "explorer failed" });

    const thrown = await revealNoteInFileManager({
      fetcher: async () => { throw new Error("connection reset"); },
      nodeId: "n",
      target: { root: "/lib" },
    });
    assert.equal(thrown.ok, false);
    assert.match(thrown.message, /connection reset/);
  });

  it("诊断上报：area=reveal + 扁平标量（不带路径/正文 ✓）", () => {
    const bodies = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true }) }; };
    try {
      reportRevealDiag({ outcome: "revealed" });
      reportRevealDiag({ outcome: "failed", code: "reveal_failed", message: "boom" });
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].kind, "diag");
    assert.equal(bodies[0].area, "reveal");
    assert.equal(bodies[0].outcome, "revealed");
    assert.equal(bodies[1].outcome, "failed");
    assert.equal(bodies[1].code, "reveal_failed");
    assert.equal(JSON.stringify(bodies).includes("Nodes/"), false, "诊断不带路径 ✓");
  });
});

/* ============================ 宿主路由 · 真跑 ============================ */

describe("宿主路由 `reveal-note`：nodeId → 实际路径 → 原生 reveal ✓", () => {
  /** 发一条 POST 到插件路由 ✓ */
  const post = (ctx, fixture, body) => handleApiRequest(ctx, {}, {
    url: "http://dsh.local/api",
    method: "POST",
    json: async () => ({ ...body, root: fixture.root }),
  });
  /** 只提供 sessionController 的宿主上下文（`ctx.get(name)` 其它返回 undefined ✓） */
  const hostWith = (controller) => ({ get: (name) => (name === "sessionController" ? controller : undefined) });

  it("成功：按 nodeId 解析相对路径，交给宿主 `{action:\"reveal\"}`（带 AbortSignal ✓）", async () => {
    const fixture = await makeV3Fixture({ nodes: ["A"] });
    const calls = [];
    const ctx = hostWith({
      openWorkspacePath: async (request, signal) => { calls.push({ request, isAbort: signal instanceof AbortSignal }); },
    });
    const response = await post(ctx, fixture, { kind: "reveal-note", nodeId: fixture.nodes.A.id });
    assert.equal(response.body.ok, true);
    assert.equal(response.body.path, fixture.nodes.A.relativePath);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].isAbort, true, "原生命令要能取消/超时 ✓");
    assert.equal(calls[0].request.action, "reveal");
    assert.equal(calls[0].request.path, path.join(fixture.root, fixture.nodes.A.relativePath), "宿主传绝对路径给 DSH ✓");
  });

  it("节点不存在 ⇒ node_missing；缺 nodeId ⇒ 400 bad_body ✓", async () => {
    const fixture = await makeV3Fixture({ nodes: ["A"] });
    const ctx = hostWith({ openWorkspacePath: async () => undefined });
    const missing = await post(ctx, fixture, { kind: "reveal-note", nodeId: "no-such-node" });
    assert.equal(missing.body.ok, false);
    assert.equal(missing.body.error.code, "node_missing");
    const bad = await post(ctx, fixture, { kind: "reveal-note" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "bad_body");
  });

  it("宿主没有 sessionController ⇒ reveal_unavailable；宿主拒绝/抛错 ⇒ reveal_failed 带原因 ✓", async () => {
    const fixture = await makeV3Fixture({ nodes: ["A"] });
    const noController = await post(hostWith(undefined), fixture, { kind: "reveal-note", nodeId: fixture.nodes.A.id });
    assert.equal(noController.body.ok, false);
    assert.equal(noController.body.error.code, "reveal_unavailable");

    const refusing = await post(
      hostWith({ openWorkspacePath: async () => { throw new Error("Path has no verified Host path"); } }),
      fixture,
      { kind: "reveal-note", nodeId: fixture.nodes.A.id },
    );
    assert.equal(refusing.body.ok, false);
    assert.equal(refusing.body.error.code, "reveal_failed");
    assert.match(refusing.body.error.message, /verified Host path/);
  });

  /* 库解析失败的路径不再单独构造：`resolveRequestedRoot` 会把"像工作区的路径"继续解析/回落到
   * 最近用过的库（既有行为 ✓），用临时夹具很难稳定造出 library_unavailable，这条由库模块自己的
   * 测试覆盖即可 ✓（本用例只管"nodeId → 路径 → reveal 调用"这条链路 ✓）。 */

});

/* ============================ 接线契约 ============================ */

describe("接线：按钮位置、数据来源与依赖 ✓", () => {
  it("按钮在标题栏里、关闭按钮左侧；传 nodeId + target + fetcher（**不传绝对路径** ✗）", () => {
    const headingAt = editor.indexOf('<div className="kn-editor-heading"');
    const revealAt = editor.indexOf("<RevealInFileManager");
    const closeAt = editor.indexOf('className="kn-editor-close"');
    assert.ok(headingAt >= 0 && revealAt > headingAt, "要用标题栏（不是正文区）✓");
    assert.ok(closeAt > revealAt, "挨着关闭按钮、放在它左边 ✓（同属「整个文档」的动作 ✓）");
    assert.ok(
      /<RevealInFileManager nodeId=\{props\.nodeId\} target=\{props\.target\} t=\{props\.t\} fetcher=\{props\.fetcher\} \/>/.test(editor),
      "只传 nodeId/target/fetcher ✓（路径由宿主解析 ✓）",
    );
    assert.equal(editor.includes("libraryRoot"), false, "编辑器不再需要 libraryRoot / 客户端拼绝对路径 ✗");
    assert.equal(panel.includes("libraryRoot={"), false, "面板不用再给编辑器传库根 ✗");
  });

  it("客户端**不访问 ctx.remote**（实测拿不到 ✗），只发同源插件路由 ✓", () => {
    assert.equal(revealNote.includes("attachRevealRemote"), false, "客户端不再登记 remote 接线 ✗（实机 reason: no-remote ✓）");
    assert.equal(revealNote.includes("ctx.get"), false, "客户端模块不再取宿主服务 ✗");
    assert.equal(entry.includes("attachRevealRemote"), false, "入口不再需要 remote 接线 ✗");
    assert.ok(revealNote.includes('kind: "reveal-note"'), "请求体要带 kind=reveal-note ✓");
    assert.ok(revealNote.includes("GRAPH_API_ROUTE"), "走插件自己的同源路由 ✓");
  });

  it("宿主半：按 nodeId 读相对路径，调 `sessionController.openWorkspacePath({action:\"reveal\"})` ✓", () => {
    assert.ok(api.includes('record.kind === "reveal-note"'), "宿主要有 reveal-note 分支 ✓");
    assert.ok(api.includes('ctx.get?.("sessionController")'), "宿主取 sessionController 服务 ✓");
    assert.ok(api.includes('action: "reveal"'), "调原生 reveal，而不是自己开文件（也不打开编辑器）✓");
    assert.ok(api.includes("AbortSignal.timeout"), "原生命令要有超时 ✓");
    assert.ok(api.includes("readNodeFast"), "按 nodeId 解析实际相对路径 ✓");
    assert.ok(api.includes("join(root, relativePath)"), "把库根 + 相对路径拼成宿主绝对路径 ✓");
  });

  it("按钮：节点已知就渲染、失败可读、诊断留痕 ✓", () => {
    assert.ok(button.includes('if (props.nodeId.trim() === "") return null;'), "只在节点 id 为空时不渲染 ✓");
    assert.ok(button.includes('role="alert"'), "失败要有可读提示 ✓（不静默失败 ✗）");
    assert.ok(button.includes('aria-label={t("revealInExplorer")}'), "按钮的无障碍名字走词典 ✓");
    assert.ok(button.includes('title={t("revealInExplorer")}'), "悬停提示同一句 ✓");
    assert.ok(button.includes("disabled={busy}"), "揭示期间禁用，避免连点 ✓");
    assert.ok(button.includes("props.fetcher ?? sameOriginFetcher"), "测试替身可注入、真实运行用同源 fetch ✓");
    assert.ok(button.includes("reportRevealDiag({ outcome: \"revealed\" })"), "成功留痕 ✓");
    assert.ok(button.includes("reportRevealDiag({ outcome: \"failed\""), "失败带 code/message 留痕 ✓");
  });

  it("图标是**本地 SVG 几何**（宿主 sprite 的 `<use>` 在 Shadow DOM 里画不出来 ✗ —— 实测 bbox 0×0）", () => {
    const iconStart = icons.indexOf("export function FolderOpenIcon");
    assert.ok(iconStart >= 0, "要有 FolderOpenIcon ✓");
    const iconBlock = icons.slice(iconStart, icons.indexOf("export function", iconStart + 10));
    assert.ok(iconBlock.includes('viewBox="0 0 16 16"'), "照抄宿主 16 网格 ✓");
    assert.ok(iconBlock.includes("M12.3994 13.5986"), "几何原样照抄（文件夹主体 path）✓");
    assert.ok(iconBlock.includes("M2.55911 7.93683"), "几何原样照抄（打开的夹层 path）✓");
    assert.ok(!iconBlock.includes("<use"), "不许用 sprite 引用 ✗（Shadow DOM 里不渲染 ✓）");
    assert.ok(button.includes('import { FolderOpenIcon } from "./PanelIcon.tsx";'), "按钮要用这枚图标 ✓");
    assert.ok(icons.includes("Shadow DOM") && icons.includes("bbox"), "图标注释里要有 Shadow DOM 的实测证据 ✓");
  });

  it("中英词典与组件字面兜底都有这两条文案 ✓（英文界面不许漏出中文 ✗）", () => {
    const zh = entry.slice(entry.indexOf("const DICT_ZH"), entry.indexOf("const DICT_EN"));
    const en = entry.slice(entry.indexOf("const DICT_EN"));
    for (const key of ["revealInExplorer", "revealFailed"]) {
      assert.ok(new RegExp(`^\\s{2}${key}:`, "m").test(zh), `中文词典要有 ${key} ✓`);
      assert.ok(new RegExp(`^\\s{2}${key}:`, "m").test(en), `英文词典要有 ${key} ✓`);
    }
    assert.ok(button.includes("revealInExplorer: \"在资源管理器中显示\""), "组件字面兜底要有 ✓");
    assert.ok(button.includes("revealFailed: \"无法在资源管理器中显示\""), "失败兜底要有 ✓");
  });

  it("样式：与关闭按钮同尺寸的小方钮、悬停/键盘聚焦/禁用都有 ✓", () => {
    const start = css.indexOf(".kn-editor-reveal {");
    assert.notEqual(start, -1, "按钮样式要有（否则是裸按钮 ✗）");
    const block = css.slice(start, css.indexOf("}", start));
    for (const part of ["width: 24px", "height: 24px", "border-radius: 6px", "background: transparent", "cursor: pointer"]) {
      assert.ok(block.includes(part), `按钮样式要有 ${part} ✓`);
    }
    assert.ok(/\.kn-editor-reveal:hover:not\(:disabled\)/.test(css), "悬停反馈 ✓");
    assert.ok(/\.kn-editor-reveal:focus-visible/.test(css), "键盘聚焦可见 ✓");
    assert.ok(/\.kn-editor-reveal:disabled/.test(css), "禁用态 ✓");
    assert.ok(/\.kn-reveal-control \{[^}]*flex: none/.test(css), "外层控制组不参与标题挤压 ✓");
  });
});
