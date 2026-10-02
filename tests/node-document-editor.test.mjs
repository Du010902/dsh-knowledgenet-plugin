/**
 * **节点笔记编辑器**的测试（`design/node-note-editor.html` + `node-note-editor-plan.md`）。
 *
 * 宿主侧的比较交换/冲突/上限由 `node-document.test.mjs` 覆盖 ✓；
 * 这里管的是**客户端那一半**：
 * - 请求与响应契约（只发 `nodeId`/`text`/`hash`，绝不发绝对路径 ✗）；
 * - **序号守卫**：切节点后旧响应必须被丢弃 ✗；
 * - 状态机与安全预览（正文不解析 HTML ✗）；
 * - 与设计稿对应的界面部件都在，且入口有**两个**（选中区 + 右键菜单 ✓）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  readNodeDocument,
  saveNodeDocument,
} from "../src/client/node-document-client.ts";
import { dialogKeyboardIntent } from "../src/client/dialog-keyboard.ts";
import {
  canSave,
  clearDraftCache,
  createLatestGuard,
  createSaveGate,
  editorReducer,
  forgetDraft,
  initialEditorState,
  isDirty,
  migrateDraft,
  previewBlocks,
  scanUnsupportedSyntax,
  canOpenRich,
  recallDraft,
  rememberDraft,
} from "../src/client/node-document-state.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFile(path.join(HERE, "..", relative), "utf8");
const editorSource = await read("src/client/NodeDocumentEditor.tsx");
const clientSource = await read("src/client/node-document-client.ts");
const panelSource = await read("src/client/GraphPanel.tsx");
const menuSource = await read("src/client/GraphContextMenu.tsx");
const confirmSource = await read("src/client/ConfirmDialog.tsx");
const richSource = await read("src/client/MarkdownRichEditor.tsx");
const stateSource = await read("src/client/node-document-state.ts");
const buildSource = await read("build.mjs");
const css = await read("src/client/panel.css");
const dictSource = await read("src/client/index.ts");

/** 假 fetch：记下请求体并回一个可控响应 ✓ */
function fakeFetch(response) {
  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input, method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    return { json: async () => response };
  };
  return { fetcher, calls };
}

/** 模拟组件里"只在未保存时写缓存"的那条规则 ✓ */
function rememberDraftCheck(state, base) {
  if (isDirty(state)) return { draft: state.draft, base: state.base === "" ? base : state.base, hash: state.hash };
  return undefined;
}

const DOC = {
  nodeId: "n1",
  title: "注意力机制",
  path: "Nodes/注意力机制.md",
  text: "## 我的理解\n\n加权求和。",
  hash: "h1",
  revision: 3,
};

describe("客户端请求契约", () => {
  it("读：只发 kind + nodeId + 库目标（**不发路径** ✗）", async () => {
    const { fetcher, calls } = fakeFetch({ ok: true, document: DOC });
    const outcome = await readNodeDocument("n1", fetcher, { target: { root: "/tmp/lib" } });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.document, DOC, "文档要原样解出来 ✓");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, { kind: "read-node-document", nodeId: "n1", root: "/tmp/lib" });
    assert.ok(!JSON.stringify(calls[0].body).includes("Nodes/"), "绝不许把路径发给宿主 ✗");
  });

  it("目标优先 root；没有 root 才用 sessionId ✓", async () => {
    const a = fakeFetch({ ok: true, document: DOC });
    await readNodeDocument("n1", a.fetcher, { target: { root: "/tmp/lib", sessionId: "s1" } });
    assert.equal(a.calls[0].body.root, "/tmp/lib");
    assert.equal(a.calls[0].body.sessionId, undefined, "同时给了就只用 root ✓");
    const b = fakeFetch({ ok: true, document: DOC });
    await readNodeDocument("n1", b.fetcher, { target: { sessionId: "s1" } });
    assert.equal(b.calls[0].body.sessionId, "s1");
  });

  it("**过期响应必须丢弃**（切节点后旧响应不许覆盖 ✗）", async () => {
    const { fetcher, calls } = fakeFetch({ ok: true, document: DOC });
    let current = true;
    const outcome = await readNodeDocument("n1", fetcher, {
      target: { root: "/tmp/lib" },
      isCurrent: () => current,
    });
    assert.equal(outcome.ok, true, "当前请求要正常返回 ✓");
    current = false;
    const stale = await readNodeDocument("n2", fetcher, {
      target: { root: "/tmp/lib" },
      isCurrent: () => current,
    });
    assert.equal(stale, undefined, "过期响应要返回 undefined（调用方什么都不做 ✓）");
    assert.equal(calls.length, 2);
  });

  it("保存：带 nodeId + 完整正文 + 读取时的指纹 ✓（没有指纹就不带 ✓）", async () => {
    const withHash = fakeFetch({ ok: true, document: DOC });
    await saveNodeDocument({ nodeId: "n1", text: "新正文", hash: "h1" }, withHash.fetcher, {
      target: { root: "/tmp/lib" },
    });
    assert.deepEqual(withHash.calls[0].body, {
      kind: "save-node-document",
      nodeId: "n1",
      text: "新正文",
      hash: "h1",
      root: "/tmp/lib",
    });
    const noHash = fakeFetch({ ok: true, document: DOC });
    await saveNodeDocument({ nodeId: "n1", text: "新正文" }, noHash.fetcher, { target: { root: "/tmp/lib" } });
    assert.equal(noHash.calls[0].body.hash, undefined, "没有指纹就不发字段 ✓");
  });

  it("冲突：回带磁盘最新正文，供界面比较 ✓", async () => {
    const { fetcher } = fakeFetch({
      ok: false,
      error: { code: "conflict", message: "被改过", latest: { ...DOC, text: "外部的新正文", hash: "h2" } },
    });
    const outcome = await saveNodeDocument({ nodeId: "n1", text: "我的草稿", hash: "h1" }, fetcher, {
      target: { root: "/tmp/lib" },
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "conflict");
    assert.equal(outcome.latest.text, "外部的新正文", "冲突要能拿到最新正文 ✓");
  });

  it("宿主回垃圾 ⇒ 明确的 unknown（不抛异常 ✓）", async () => {
    const { fetcher } = fakeFetch({ ok: true, document: { nope: 1 } });
    const outcome = await readNodeDocument("n1", fetcher, { target: { root: "/tmp/lib" } });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "unknown");
    const bad = fakeFetch(null);
    const again = await saveNodeDocument({ nodeId: "n1", text: "x" }, bad.fetcher, { target: { root: "/tmp/lib" } });
    assert.equal(again.ok, false);
    assert.equal(again.code, "unknown");
  });

  it("**网络拒绝**以异常抛出（组件必须 try/catch，否则是未处理的 Promise 拒绝 ✗）", async () => {
    const rejecting = async () => { throw new Error("net::ERR_FAILED"); };
    await assert.rejects(
      () => readNodeDocument("n1", rejecting, { target: { root: "/tmp/lib" } }),
      /ERR_FAILED/,
      "读取层如实抛出 ✓",
    );
    await assert.rejects(
      () => saveNodeDocument({ nodeId: "n1", text: "x", hash: "h1" }, rejecting, { target: { root: "/tmp/lib" } }),
      /ERR_FAILED/,
      "保存层同样抛出 ✓",
    );
    /* 组件侧：冲突刷新必须包在 try/catch 里，并且有独立读取编号 ✓ */
    const refreshBlock = editorSource.slice(
      editorSource.indexOf("const refreshLatest = useCallback"),
      editorSource.indexOf("const mergeAndSave = useCallback"),
    );
    assert.ok(refreshBlock.includes("try {") && refreshBlock.includes("catch (error)"), "冲突刷新要 try/catch ✓");
    assert.ok(refreshBlock.includes("conflictGuardRef.current.next()"), "要有独立的读取编号 ✓");
    assert.ok(editorSource.includes("conflictGuardRef.current.invalidate()"), "保存开始要让在飞的比较读取作废 ✓");
  });
});

describe("编辑器状态机：草稿保护（复查的六条 P1）", () => {
  const fresh = () => editorReducer(initialEditorState("n1"), { type: "load-ok", document: DOC });

  it("基础：dirty / canSave ✓", () => {
    const ready = fresh();
    assert.equal(isDirty(ready), false);
    assert.equal(canSave(ready), false, "没改动就不能保存 ✓");
    const dirty = editorReducer(ready, { type: "edit", text: "我改了一点" });
    assert.equal(isDirty(dirty), true);
    assert.equal(canSave(dirty), true);
    /* 撤掉底栏后**没有 statusText**：状态只剩标题右上角的 `*` 与保存中标记 ✓ */
    assert.ok(
      !stateSource.includes("export function statusText"),
      "底部那行状态文字已经撤掉 ⇒ statusText 不许留着 ✗",
    );
    /* 复查补充：载入中不许保存（否则会拿旧基线提交 ✗） */
    assert.equal(canSave({ ...dirty, phase: "loading" }), false);
    assert.equal(canSave({ ...dirty, hash: "" }), false, "没有指纹不许保存 ✓");
    assert.equal(canSave({ ...dirty, conflicted: true }), false);
    assert.equal(canSave({ ...dirty, saving: true }), false);
  });

  it("**复查 P1-1**：载入成功**不许覆盖**未保存草稿（父组件重渲染不再冲掉输入 ✗）", () => {
    const typed = editorReducer(fresh(), { type: "edit", text: "我刚敲的字" });
    const reloaded = editorReducer(typed, {
      type: "load-ok",
      document: { ...DOC, text: "磁盘上的正文", hash: "h2", revision: 4 },
    });
    assert.equal(reloaded.draft, "我刚敲的字", "草稿必须原样保留 ✗");
    assert.equal(reloaded.conflicted, true, "盘上变了 ⇒ 标成冲突，让用户决定 ✓");
    assert.equal(reloaded.latest.text, "磁盘上的正文", "把最新正文留着，供用户主动比较 ✓");
    assert.equal(
      reloaded.comparing,
      false,
      "**默认不展开比较区** ✓（保存并关闭后重开时，把异常处理铺成主界面是最刺眼的那条 ✓）",
    );
    /* 干净的时候照旧采纳 ✓ */
    const clean = editorReducer(fresh(), { type: "load-ok", document: { ...DOC, text: "新的", hash: "h9" } });
    assert.equal(clean.draft, "新的");
    assert.equal(clean.hash, "h9");
    assert.equal(clean.conflicted, false);
  });

  it("**复查 P1-2**：「查看」只展开比较区，绝不替换草稿；替换另有显式动作 ✓", () => {
    const conflicted = editorReducer(fresh(), {
      type: "save-conflict",
      latest: { ...DOC, text: "外部的新正文", hash: "h2" },
    });
    const shown = editorReducer(conflicted, { type: "toggle-compare" });
    assert.equal(shown.draft, conflicted.draft, "查看不许动草稿 ✗");
    assert.equal(shown.base, conflicted.base, "查看不许动基线 ✗");
    assert.equal(shown.hash, conflicted.hash, "查看不许动指纹 ✗");
    assert.equal(shown.comparing, !conflicted.comparing, "只切换比较区的展开状态 ✓");
    const again = editorReducer(shown, { type: "toggle-compare" });
    assert.equal(again.comparing, conflicted.comparing, "再点一次切回来 ✓");
    assert.equal(again.draft, conflicted.draft, "反复切换也不许动草稿 ✗");
    /* 只有显式的 adopt-latest（界面里带二次确认 ✓）才会替换 ✗ */
    const adopted = editorReducer(conflicted, { type: "adopt-latest" });
    assert.equal(adopted.draft, "外部的新正文");
    assert.equal(adopted.hash, "h2");
    assert.equal(adopted.conflicted, false);
    /* 没有 latest 时 adopt 什么都不做 ✓（构造一个"冲突但没拿到最新正文"的状态 ✓） */
    const noLatest = editorReducer(fresh(), { type: "save-conflict", latest: null });
    assert.equal(noLatest.latest, null);
    const untouched = editorReducer(noLatest, { type: "adopt-latest" });
    assert.equal(untouched.draft, noLatest.draft, "没有最新正文时不许清空草稿 ✗");
  });

  it("**复查 P1-2/3**：冲突里可以「已合并，基于最新版本保存」（换基线、留草稿 ✓）", () => {
    /* 真实场景：用户**改过**（草稿 ≠ 编辑器快照 ✓），保存时发现磁盘也变了 ✓ */
    const typed = editorReducer(fresh(), { type: "edit", text: "我改的正文" });
    const conflicted = editorReducer(typed, {
      type: "save-conflict",
      latest: { ...DOC, text: "外部的新正文", hash: "h2" },
    });
    const merged = editorReducer(conflicted, { type: "merge-and-save" });
    assert.equal(merged.draft, conflicted.draft, "合并后草稿仍是用户的 ✓");
    assert.equal(merged.hash, "h2", "基线指纹换成最新版本 ⇒ 才能提交 ✓");
    assert.equal(merged.conflicted, false, "解除冲突后可以保存 ✓");
    assert.equal(isDirty(merged), true, "草稿还没保存成功 ⇒ 仍然算未保存 ✓（换基线不等于保存 ✗）");
    assert.equal(canSave(merged), true);
  });

  it("**复查 P1-3**：保存失败**不清空草稿**，载入失败与保存失败分开 ✓", () => {
    const typed = editorReducer(fresh(), { type: "edit", text: "宝贵的草稿" });
    const failed = editorReducer(typed, { type: "save-failed", key: "saveFailed" });
    assert.equal(failed.draft, "宝贵的草稿", "保存失败草稿必须在 ✗");
    assert.equal(failed.phase, "ready", "载入是成功的（不许退化成「读不到」✗）");
    assert.equal(failed.loadErrorKey, null, "保存失败不许写成载入失败 ✗");
    assert.equal(failed.saveErrorKey, "saveFailed");
    /* 载入失败也不许清空草稿 ✓ */
    const loadFailed = editorReducer(failed, { type: "load-failed", key: "nodeMissing" });
    assert.equal(loadFailed.draft, "宝贵的草稿");
    assert.equal(loadFailed.loadErrorKey, "nodeMissing");
  });

  it("**复查补充**：保存期间冻结输入；保存只更新基线、不吞掉草稿 ✓", () => {
    const typed = editorReducer(fresh(), { type: "edit", text: "第一版" });
    const saving = editorReducer(typed, { type: "save-start" });
    assert.equal(saving.frozen, true, "保存期间要冻结 ✓");
    assert.equal(editorReducer(saving, { type: "edit", text: "第一版 + 抢跑的字" }).draft, "第一版", "冻结期间输入被忽略 ✓");
    const saved = editorReducer(saving, {
      type: "save-ok",
      document: { ...DOC, text: "第一版", hash: "h3", revision: 5 },
      submitted: "第一版",
    });
    assert.equal(saved.draft, "第一版");
    assert.equal(saved.base, "第一版");
    assert.equal(saved.hash, "h3");
    assert.equal(saved.revision, 5);
    assert.equal(saved.frozen, false);
    assert.equal(isDirty(saved), false, "存完就干净了 ✓");
  });

  it("**复查 P1-2/5**：没有指纹的文档不可编辑（保存会被宿主拒 ✗）", () => {
    const noHash = editorReducer(initialEditorState("n1"), { type: "load-ok", document: { ...DOC, hash: "" } });
    assert.equal(noHash.phase, "loadError");
    assert.equal(noHash.loadErrorKey, "missingFingerprint");
    assert.equal(canSave({ ...noHash, draft: "改一下" }), false, "没指纹不许保存 ✓");
  });

  it("**复查 P1-6**：草稿缓存在组件外 ⇒ 卸载/切目标后能恢复，且不串库 ✓", () => {
    clearDraftCache();
    const a = "libA::n1";
    const b = "libB::n1";
    rememberDraft(a, { draft: "库 A 的草稿", base: "旧的", hash: "h1" });
    rememberDraft(b, { draft: "库 B 的草稿", base: "旧的", hash: "h2" });
    /* 记录里两种基线都在 ✓（磁盘基线 + 编辑器快照 ✓；没给 snapshot 时回落成 base ✓） */
    assert.deepEqual(recallDraft(a), { draft: "库 A 的草稿", base: "旧的", hash: "h1", snapshot: "旧的" });
    assert.equal(recallDraft(b).draft, "库 B 的草稿", "不同库里的同名节点不许串 ✗");
    forgetDraft(a);
    assert.equal(recallDraft(a), undefined, "放弃草稿后要清掉 ✓");
    assert.equal(recallDraft(b).draft, "库 B 的草稿", "不能连带清掉别的库 ✓");
    clearDraftCache();
  });

  it("**复查 P1-1**：空正文也是有效草稿 —— 缓存与恢复都不许当成「没有记录」✗", () => {
    clearDraftCache();
    /* 用户把正文删光（draft=""、base 是磁盘旧正文 ✓）⇒ **必须留下记录** ✓ */
    const typed = editorReducer(fresh(), { type: "edit", text: "" });
    assert.equal(isDirty(typed), true, "删光正文当然算未保存修改 ✓");
    rememberDraft("L::n1", { draft: typed.draft, base: "旧的磁盘正文", hash: DOC.hash });
    const record = recallDraft("L::n1");
    assert.notEqual(record, undefined, "空正文也必须留下记录（旧实现在这里返回 undefined ✗）");
    assert.equal(record.draft, "", "记录里就是空正文 ✓");
    /* 重开：恢复空草稿 + 两种基线；磁盘没变 ⇒ 不是冲突，而且能保存 ✓ */
    const restored = editorReducer(initialEditorState("n1"), {
      type: "restore-draft",
      draft: record.draft,
      base: record.base,
      hash: record.hash,
      snapshot: record.snapshot,
    });
    const loaded = editorReducer(restored, { type: "load-ok", document: { ...DOC, text: "旧的磁盘正文" } });
    assert.equal(loaded.draft, "", "空草稿必须恢复（不能被磁盘正文顶回来 ✗）");
    assert.equal(loaded.conflicted, false, "磁盘没变 ⇒ 不是冲突 ✓");
    assert.equal(canSave(loaded), true, "空正文也要能保存 ✓");
    clearDraftCache();
  });

  it("**复查 P2-2**：磁盘未变 / 磁盘已变 / 草稿其实等于磁盘，三种情况要分清 ✓", () => {
    /* ① 磁盘没变（指纹相同）⇒ 继续编辑，不是冲突 ✓ */
    const editing = editorReducer(
      editorReducer(initialEditorState("n1"), { type: "restore-draft", draft: "我改的", base: "原文", hash: DOC.hash }),
      { type: "load-ok", document: { ...DOC, text: "原文" } },
    );
    assert.equal(editing.draft, "我改的");
    assert.equal(editing.conflicted, false, "磁盘没变却要求合并 ✗");
    /* ② 磁盘变了 ⇒ 才判冲突 ✓ */
    const changed = editorReducer(
      editorReducer(initialEditorState("n1"), { type: "restore-draft", draft: "我改的", base: "原文", hash: DOC.hash }),
      { type: "load-ok", document: { ...DOC, text: "别人改的", hash: "h9" } },
    );
    assert.equal(changed.conflicted, true, "磁盘真的变了才判冲突 ✓");
    assert.equal(changed.draft, "我改的", "冲突时草稿保留 ✓");
    /* ③ 草稿其实等于磁盘 ⇒ 干净，不该要求合并 ✓ */
    const same = editorReducer(
      editorReducer(initialEditorState("n1"), { type: "restore-draft", draft: "已保存的正文", base: "更旧的", hash: "h0" }),
      { type: "load-ok", document: { ...DOC, text: "已保存的正文", hash: "h1" } },
    );
    assert.equal(same.conflicted, false, "草稿与磁盘相同 ⇒ 不算冲突 ✓");
    assert.equal(isDirty(same), false, "而且应当是干净的 ✓");
  });

  it("**复查 P2-5**：宿主规范化后的正文要同步回草稿 ⇒ 不会一直显示未保存 ✓", () => {
    const typed = editorReducer(fresh(), { type: "edit", text: "\n\n正文\n\n\n" });
    const saving = editorReducer(typed, { type: "save-start" });
    const saved = editorReducer(saving, {
      type: "save-ok",
      document: { ...DOC, text: "正文", hash: "h4", revision: 6 },
      submitted: "\n\n正文\n\n\n",
    });
    assert.equal(
      saved.draft,
      "\n\n正文\n\n\n",
      "草稿保持**编辑器那一份** ✗（宿主规范化只在磁盘基线那边 ✓）",
    );
    assert.equal(saved.base, "正文", "**磁盘基线**用宿主规范化后的正文 ✓（冲突保护仍以它为准 ✓）");
    assert.equal(saved.snapshot, "\n\n正文\n\n\n", "**编辑器快照** = 本次提交上去的那份 ✓（脏不脏就看它 ✓）");
    assert.equal(isDirty(saved), false, "保存后必须干净 ✓（哪怕它与磁盘正文差着末尾空白 ✓）");
    /* 若草稿自提交后又变了（允许的情况下）⇒ 只保留新增部分，不吞掉 ✓ */
    const racing = editorReducer(
      { ...saving, draft: "提交后又敲的字", frozen: true },
      { type: "save-ok", document: { ...DOC, text: "提交时那版", hash: "h5" }, submitted: "提交时那版" },
    );
    assert.equal(racing.draft, "提交后又敲的字", "提交之后新增的内容要留着 ✓");
  });

  it("**复查 P2-6**：保存互斥门是同步的 ⇒ 重复点击只发一次写入 ✓", async () => {
    const gate = createSaveGate();
    assert.equal(gate.tryEnter(), true, "第一次进得去 ✓");
    assert.equal(gate.tryEnter(), false, "保存中再点 ⇒ 直接拒绝（不发请求 ✗）");
    assert.equal(gate.busy, true);
    gate.exit();
    assert.equal(gate.tryEnter(), true, "结束后可以再保存 ✓");
    gate.exit();
    /* 失败/异常路径也必须放行（否则一次失败把保存永久锁死 ✗） */
    let released = false;
    try {
      if (gate.tryEnter()) throw new Error("模拟宿主抛错");
    } catch {
      released = true;
    } finally {
      gate.exit();
    }
    assert.equal(released, true);
    assert.equal(gate.tryEnter(), true, "异常之后仍然可以保存 ✓");
    gate.exit();
  });

  it("**复查 P2-4**：身份迁移要把草稿搬到新键并**删掉旧键** ✓", () => {
    clearDraftCache();
    rememberDraft("L::adopted-1", { draft: "草稿正文", base: "", hash: "h1" });
    assert.equal(migrateDraft("L", "adopted-1", "01ULID"), true, "要搬 ✓");
    assert.equal(recallDraft("L::01ULID").draft, "草稿正文", "新键上有 ✓");
    assert.equal(recallDraft("L::adopted-1"), undefined, "旧键必须删掉（不能复制后保留 ✗）");
    assert.equal(migrateDraft("L", "无关", "另一个"), false, "没有记录就什么都不做 ✓");
    clearDraftCache();
  });

  it("预览是**安全渲染**：`## ` 变标题、其余按纯文本，HTML 不解析 ✗", () => {
    const blocks = previewBlocks("## 标题\n<script>alert(1)</script>\n普通一行");
    assert.deepEqual(blocks[0], { heading: true, text: "标题" });
    assert.deepEqual(blocks[1], { heading: false, text: "<script>alert(1)</script>" }, "脚本文本原样保留、不解析 ✓");
    assert.deepEqual(blocks[2], { heading: false, text: "普通一行" });
    assert.equal(previewBlocks("")[0].heading, false);
  });

  it("客户端**不碰 front-matter、不引 Node 模块** ✗（身份由存储层维护 ✓）", () => {
    for (const source of [clientSource, editorSource]) {
      assert.ok(!source.includes("frontmatter"), "客户端不许解析/拼装 front-matter ✗");
      assert.ok(!/from "node:/.test(source), "客户端不许引入 node:* 模块 ✗");
      assert.ok(!source.includes("composeDocument"), "不许在客户端拼整份文档 ✗");
    }
  });
});

describe("与设计稿对应的部件与入口", () => {
  it("编辑器部件齐：标题 / 未保存标记 / 正文 / 冲突条 / 快捷键 / 提示行 ✓", () => {
    for (const piece of [
      "kn-editor-title",
      "kn-editor-notice",
      /* 真实冲突：紧凑提示条 + 按需展开的比较区 ✓（不再常驻一整块源码 ✗） */
      "kn-editor-conflict",
      "kn-editor-conflict-bar",
      "kn-editor-compare",
      "kn-editor-compare-body",
      "kn-editor-text",
      "kn-editor-rich",
      /* 底栏撤掉后，"未保存"只剩标题右上角这个标记 ✓ */
      "kn-editor-dirty",
    ]) {
      /* 富文本容器类名在 MarkdownRichEditor 里 ✓，其余在 NodeDocumentEditor ✓ */
      const haystack = editorSource + richSource;
      assert.ok(haystack.includes(piece), `界面要有 ${piece} ✓`);
      assert.ok(css.includes(`.${piece}`), `${piece} 要有样式 ✓`);
    }
    assert.ok(editorSource.includes('event.key.toLowerCase() !== "s"'), "Ctrl/⌘ + S 要接上 ✓");
    assert.ok(!editorSource.includes('role="tablist"'), "模式切换标签已撤掉 ⇒ 不许长回来 ✗");
    assert.ok(
      editorSource.includes('className="kn-editor-heading" title={`${t("editorHint")} · ${t("saveShortcut")}`}'),
      "「支持 Markdown」与保存快捷键改挂在标题栏 title 上 ⇒ 不再常驻占正文高度 ✓（文档要求 ✓）",
    );
  });

  it("**极简外壳**：底栏、「⋯ 详情」与「正文 / 源码」切换全撤掉，高度归正文；未保存只在标题右上角一个 `*` ✓", () => {
    /*
     * 用户要求（`design/editor-chrome-minimal-design.md`）：
     * ① 「保存笔记」按钮撤掉，只留 Ctrl / ⌘ + S ✓；
     * ② 底部"有未保存修改"那行撤掉，改用**节点名右上角的 `*`** ✓；
     * ③ 「⋯」与它展开的内容（路径 / 修订 / 快捷键说明）一起去掉 ✓；
     * ④ **「正文 / 源码」也不再给用户挑**：正常只有正文 ✓（第二批要求）。
     * 反向断言同样重要 ✗：这些东西一个都不许悄悄长回来 ✓。
     */
    for (const gone of [
      "kn-editor-foot", "kn-editor-save", "kn-editor-status", "kn-editor-more", "kn-editor-details", "kn-editor-tabs",
    ]) {
      assert.ok(!editorSource.includes(gone), `编辑器里不许再有 ${gone} ✗`);
      assert.ok(!css.includes(`.${gone}`), `样式里不许再有 .${gone} ✗`);
    }
    assert.ok(!dictSource.includes("saveNote"), "「保存笔记」按钮与文案一起撤掉 ✗（中英词典都不留 ✓）");
    assert.ok(!dictSource.includes("tabRich") && !dictSource.includes("tabSource"), "模式切换的文案一起撤掉 ✗");
    assert.ok(
      /\.kn-editor-body \{[^}]*flex: 1/s.test(css),
      "正文视口是唯一吃剩余高度的主体 ⇒ 底栏腾出的高度全归正文 ✓",
    );
    /*
     * 标记本身：`*` 挂在标题行里、贴着文字右上角 ✓；标题文字单独一层
     * ⇒ 长标题被省略号截断时标记不会被裁掉 ✗。
     */
    assert.ok(editorSource.includes('className="kn-editor-title-text"'), "标题文字要单独一层（省略号只作用在它身上 ✓）");
    assert.ok(editorSource.includes('className="kn-editor-dirty"'), "未保存要有 `*` 标记 ✓");
    assert.ok(editorSource.includes('title={t("statusDirty")}'), "标记要有悬停说明 ✓");
    assert.ok(editorSource.includes('className="sr-only"'), "`*` 要让读屏也能理解 ✓");
    assert.ok(
      /\.kn-editor-dirty \{[^}]*align-self: flex-start/s.test(css),
      "标记要贴在标题右上角 ✓",
    );
    assert.ok(editorSource.includes('void save();'), "Ctrl / ⌘ + S 仍走统一的 save() ✓");
    assert.ok(!editorSource.includes("kn-editor-tag"), "常驻「节点笔记」徽标要撤掉 ✗（占高度 ✓）");
  });

  it("**没有模式切换**：正常只有正文；纯文本只在「保不住的语法 / 起不来」时自动兜底 ✓", () => {
    /*
     * 用户明确说"我不需要看源码"⇒ 不给「正文 / 源码」按钮 ✓。但**内容安全不能丢** ✗：
     * ① 命中富编辑器保不住的语法 ⇒ 自动改用纯文本（并可显式点回正文、随时退回 ✓）；
     * ② 富编辑器初始化失败 ⇒ 同样自动落到纯文本，那份草稿仍然可改可存 ✓；
     * ③ 语法被删干净 ⇒ 自动回正文（纯文本从来不是用户选的，不许把他留在那儿 ✗）。
     */
    assert.ok(editorSource.includes('if (unsupported.length > 0) setTab("source");'), "语法命中要自动落到纯文本 ✓");
    assert.ok(
      editorSource.includes('if (tab === "rich" && richStatus.failed) setTab("source");'),
      "富编辑器起不来要自动落到纯文本 ⇒ 草稿不会变成只读 ✓",
    );
    assert.ok(
      editorSource.includes('if (tab !== "source" || richStatus.failed || unsupported.length > 0) return;'),
      "语法删干净后要自动回正文 ✓（富编辑器失败时不回 ✗）",
    );
    /* 退回纯文本要走统一入口（先取正文快照 ✓ —— 否则最后一笔会丢 ✗） */
    assert.ok(
      editorSource.includes('onClick={() => { leaveRich("source"); }}>{t("backToPlainText")}'),
      "「改回纯文本」必须先取快照再切 ✓",
    );
    assert.ok(
      editorSource.includes('onClick={() => { setTab("rich"); }}>{t("openRichAnyway")}'),
      "回正文要**显式点一次**（有损转换要有同意 ✓）",
    );
    assert.ok(editorSource.includes('t("unsupportedNotice")') && editorSource.includes('t("unsupportedRisk")'), "两条提示都在 ✓");
    /* 提示条里不许再出现"切到源码"这类让用户自己挑模式的说法 ✓ */
    for (const key of ["tabRich", "tabSource"]) {
      assert.ok(!editorSource.includes(`t("${key}")`), `${key} 已撤掉 ✗`);
    }
  });


  it("**Typora 式即时编辑**：正文直接编辑格式化内容，纯文本只是同一份草稿的兜底写法 ✓", () => {
    /* ① 富编辑器接入 + 默认就在正文（没有模式切换 ✓） */
    assert.ok(!editorSource.includes('t("tabRich")') && !editorSource.includes('t("tabSource")'), "不再有模式切换标签 ✓");
    assert.ok(editorSource.includes('useState<"rich" | "source">("rich")'), "默认进正文（可视化）模式 ✓");
    assert.ok(editorSource.includes("<MarkdownRichEditor"), "正文模式用富文本编辑器 ✓");
    assert.ok(richSource.includes('from "@milkdown/crepe"'), "用 Milkdown / Crepe ✓");
    assert.ok(richSource.includes("features"), "表格 / 公式走 Crepe 的特性开关 ✓");
    assert.ok(!editorSource.includes("previewBlocks("), "不再有「写完切预览」那条老路 ✗");
    /* ② 两个模式共享同一份草稿 / 基线 / 指纹（不是两套状态 ✓） */
    assert.ok(editorSource.includes('tab === "rich" ?'), "正文 / 源码只是显示方式切换 ✓");
    assert.ok(
      (editorSource.match(/value=\{state\.draft\}/g) ?? []).length === 1,
      "纯文本兜底仍绑同一份 draft ✓（不是另一份内容 ✗）",
    );
    /* ③ 草稿变化**不**整体回写编辑器（只在外部替换时用 syncToken ✓） */
    assert.ok(richSource.includes("syncToken"), "要有显式的整体同步开关 ✓");
    assert.ok(
      richSource.includes("token === syncTokenRef.current") && richSource.includes("replaceAll(next)"),
      "只有 token 变化才整体替换 ✓",
    );
    /* ④ 保存前现取当前 Markdown ✓（不用延迟缓存 ✓） */
    assert.ok(editorSource.includes("richRef.current?.flush()"), "保存前 flush 一次 ✓");
    /* ⑤ 保存期间富编辑器整体只读 ✓；异步初始化晚于卸载要销毁 ✓ */
    assert.ok(
      editorSource.includes('readOnly={state.saving || state.frozen || state.phase !== "ready"}'),
      "保存 / 未就绪时只读 ✓",
    );
    assert.ok(richSource.includes("crepe.setReadonly"), "只读要作用到编辑器本身 ✓");
    assert.ok(
      richSource.includes("if (cancelled || disposedRef.current) {"),
      "异步初始化晚于卸载（或本次已被取消）要立刻销毁 ✓",
    );
    assert.ok(richSource.includes("let cancelled = false;"), "取消标志要**按挂载实例**，不能用会被下一次 effect 重置的共享标志 ✗");
    /* ⑥ 样式与字体是**构建期内联**的（Shadow DOM + 自包含 ✓） */
    assert.ok(buildSource.includes("readEditorCss"), "build.mjs 要拼第三方样式 ✓");
    assert.ok(buildSource.includes("data:font/woff2;base64"), "KaTeX 字体要转 data URI ✓");
    assert.ok(buildSource.includes("codeSplitting: false"), "不许留动态分块（自包含单文件 ✓）");
  });

  it("**复查（富编辑器）**：不支持语法嗅探 —— 命中就自动改用纯文本 ✓", () => {
    assert.deepEqual(scanUnsupportedSyntax("## 标题\n\n- 列表\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n$e=mc^2$\n").reasons, []);
    assert.equal(canOpenRich("# 普通 Markdown ✓"), true);
    /* **水平分隔线与 Setext 标题都是标准 Markdown** ✗（第三次复查 P2-2）：不许再判成未知语法 ✓ */
    assert.equal(canOpenRich("正文\n\n---\n\n尾巴"), true, "水平分隔线要留在正文模式 ✓");
    assert.equal(canOpenRich("Setext 标题\n---\n\n正文"), true, "Setext 标题下划线也不能误判 ✓");
    assert.equal(canOpenRich("| a | b |\n| --- | --- |\n| 1 | 2 |"), true, "表格分隔行不能误判 ✓");
    assert.equal(canOpenRich("左\n\n***\n\n右"), true, "另一种分隔线写法也不能误判 ✓");
    const cases = [
      ["<div class=\"x\">块级 HTML</div>", "原始 HTML 标签"],
      ["正文\n<!-- 注释 -->\n正文", "原始 HTML 标签"],
      [":::note\n内容\n:::", "自定义指令（:::）"],
      ["import X from './x'\n\n{value}", "模板 / MDX 语法"],
      ["正文[^1]\n\n[^1]: 脚注内容", "脚注定义"],
      ["引用式链接 [foo][1]\n\n[1]: https://example.com", "引用式链接定义"],
      ["\\newcommand{\\R}{\\mathbb{R}}", "LaTeX 宏定义"],
    ];
    for (const [sample, reason] of cases) {
      const scan = scanUnsupportedSyntax(sample);
      assert.ok(scan.reasons.includes(reason), `应当命中「${reason}」：${sample}`);
      assert.equal(canOpenRich(sample), false);
    }
  });

  it("**复查 P1-1**：异步初始化期间的同步不许丢（记账 + 补上 + 未就绪 flush 返回 null）✓", () => {
    assert.ok(richSource.includes("pendingRef"), "未就绪的正文要记进 pendingRef ✓");
    assert.ok(richSource.includes("const pending = pendingRef.current ?? markdownRef.current;"), "create 成功后要用最新那份补同步 ✓");
    assert.ok(richSource.includes("if (pending !== crepe.getMarkdown()) {"), "补同步要走真正的 replaceAll ✓");
    assert.ok(
      richSource.includes("if (crepe === null || !readyRef.current || failedRef.current) return null;"),
      "未就绪/失败时 flush 必须返回 null ✗（不许拿挂载时的旧正文当当前内容 ✗）",
    );
    assert.ok(richSource.includes("if (composingRef.current) return null;"), "输入法组合中也不许取值 ✗");
  });

  it("**复查 P2-5**：初始化与外部替换**不算用户修改**（同步期间忽略变更事件）✓", () => {
    assert.ok(richSource.includes("syncingRef"), "要有同步来源标志 ✓");
    assert.ok(richSource.includes("if (cancelled || syncingRef.current) return;"), "同步期间的 markdownUpdated 一律忽略 ✗");
    assert.ok(richSource.includes("syncingRef.current = true;"), "外部替换要包在同步标志里 ✓");
  });

  it("**复查 P1-2/P1-3**：切源码 / 关闭 / 合并保存都先取同一个正文快照 ✓", () => {
    assert.ok(editorSource.includes("const snapshotDraft = useCallback"), "要有统一的快照入口 ✓");
    assert.ok(editorSource.includes("const leaveRich = useCallback"), "离开富编辑器要有统一入口 ✓");
    assert.ok(
      editorSource.includes('onClick={() => { leaveRich("source"); }}'),
      "切源码前必须先取快照 ✗（复查 P1-2）",
    );
    assert.ok(editorSource.includes('onClick={() => { leaveRich("close"); }}'), "关闭前也要先取快照 ✓");
    const mergeBlock = editorSource.slice(
      editorSource.indexOf("const mergeAndSave = useCallback"),
      editorSource.indexOf("const leaveRich = useCallback"),
    );
    assert.ok(mergeBlock.includes("const live = snapshotDraft();"), "合并保存也要现取正文 ✗（复查 P1-3）");
    assert.ok(!mergeBlock.includes("saveWith(state.draft"), "合并保存不许再用 state.draft 提交 ✗");
    assert.ok(editorSource.includes('key: richStatus.failed ? "richFailed" : "richLoading"'), "取不到正文要报可见错误 ✓");
  });

  it("**复查 P1-4/P2-6**：不支持语法与初始化失败都要有可见提示与出口 ✓", () => {
    assert.ok(
      editorSource.includes("scanUnsupportedSyntax(state.draft)"),
      "要按**当前草稿**嗅探（只看 base 会漏掉纯文本里新加的内容 ✗）",
    );
    assert.ok(editorSource.includes("useMemo(() => scanUnsupportedSyntax"), "每次草稿变化都重新算 ✓");
    assert.ok(editorSource.includes('t("unsupportedNotice")'), "要说明为什么改用纯文本 ✓");
    assert.ok(editorSource.includes('t("unsupportedRisk")'), "回正文前要说清风险 ✓");
    assert.ok(editorSource.includes('t("backToPlainText")'), "还要给一条退回纯文本的路 ✓");
    assert.ok(editorSource.includes('t("richFailed")') && editorSource.includes('t("richLoading")'), "初始化失败/加载中要可见 ✓");
    assert.ok(editorSource.includes("onStatus={setRichStatus}"), "编辑器要上报状态 ✓");
    assert.ok(richSource.includes("onCompositionEnd"), "组合结束要上报并补一次用户改动 ✓");
  });

  it("**复查（构建）**：必需样式缺失必须**构建失败**，字体不许留包外 URL ✓", () => {
    assert.ok(buildSource.includes("富文本编辑器必需的样式缺失"), "必需资源缺失要抛错 ✗（不能静默跳过 ✓）");
    assert.ok(buildSource.includes("KaTeX 字体缺失"), "字体缺失要抛错 ✓");
    assert.ok(buildSource.includes("仍残留在包外请求的字体"), "构建后要校验没有包外字体 URL ✓");
    assert.ok(buildSource.includes("一个都没内联成功"), "一个都没内联也要失败 ✓");
  });

  it("**复查（第二次）P1-1**：纯文本兜底必须能保存（不许因为没有富实例就判「取不到正文」✗）", () => {
    const snapshot = editorSource.slice(
      editorSource.indexOf("const snapshotDraft = useCallback"),
      editorSource.indexOf("const save = useCallback"),
    );
    assert.ok(snapshot.includes('if (tab === "source")'), "纯文本要直接读草稿 ✓");
    assert.ok(snapshot.includes("live = state.draft;"), "纯文本的权威就是受控 textarea 的草稿 ✓");
    assert.ok(snapshot.includes("richRef.current?.flush() ?? null"), "正文模式才要求有效实例 ✓");
    /* 组合推迟只对正文模式成立 ✓（纯文本不归富实例管 ✓） */
    assert.ok(
      editorSource.includes('if (tab === "rich" && richStatus.composing)'),
      "组合检查要带模式条件 ✗（否则纯文本兜底也会被卡住 ✗）",
    );
    /* 两条"自动落到纯文本"的路径因此都能保存 ✓ */
    assert.ok(editorSource.includes('setTab("source")'), "不支持语法 / 初始化失败都要能落到纯文本并保存 ✓");
  });

  it("**复查（第二次）P1-2**：输入法组合期间不许卸载编辑器（统一待办，等组合结束再执行）✓", () => {
    const leaveRich = editorSource.slice(
      editorSource.indexOf("const leaveRich = useCallback"),
      editorSource.indexOf("/** 放弃草稿并用最新正文"),
    );
    assert.ok(leaveRich.includes('if (tab === "source")'), "纯文本兜底直接执行 ✓");
    assert.ok(leaveRich.includes("rich.isReady() !== true"), "未就绪/失败允许动作（切源码是恢复路径 ✓）");
    assert.ok(leaveRich.includes("if (richStatus.composing)"), "组合中要挡住会卸载编辑器的动作 ✓");
    assert.ok(
      leaveRich.includes("pendingActionRef.current = { kind };"),
      "组合中只记**类型**（不存闭包 ✗），组合结束重走同一流程 ✓",
    );
    assert.ok(leaveRich.includes("if (live === null) return;"), "取不到快照就不许执行 ✗");
    /* 本轮（第三次复查 P2-1）：补跑必须**重新取快照**，不是跑原始闭包 ✓ */
    assert.ok(
      editorSource.includes("else leaveRich(pending.kind); /* 重走"),
      "组合结束的补跑要重新走 leaveRich ⇒ 重新取快照 ✓",
    );
    assert.ok(!editorSource.includes("pending.run()"), "不许存/直接跑原始闭包 ✗");
    /* 新鲜 dirty 要交给父面板，别让父面板用旧的 editorDirty 判断 ✓ */
    assert.ok(leaveRich.includes("props.onClose(dirty)"), "关闭要把**刚算出来的** dirty 交出去 ✓");
    assert.ok(panelSource.includes("freshDirty ?? editorDirty"), "面板要优先用新鲜 dirty ✓");
    /* 只有一份待办（保存/切模式/关闭共用 ✓） */
    assert.ok(editorSource.includes("const pendingActionRef = useRef<"), "只有一处统一待办 ✓");
    assert.ok(!editorSource.includes("pendingSaveRef"), "旧的「只推迟保存」那套必须删掉 ✗");
    assert.ok(editorSource.includes('if (pending.kind === "save") void save();'), "组合结束后按待办类型补跑 ✓");
  });

  it("**复查（第二次）P2-3**：按**当前草稿**判是否兜底；代码块与公式不算不支持语法 ✓", () => {
    /* 扫描器先挖掉代码与公式 ✓ */
    const codeDoc = "说明：\n\n```html\n<div class=\"x\">代码里的 HTML</div>\n```\n\n以及行内 `<span>` 与公式 $\\{a\\}$。\n";
    assert.deepEqual(scanUnsupportedSyntax(codeDoc).reasons, [], "代码块/行内代码/公式里的内容不该触发 ✗");
    /* 但普通上下文里的 HTML 仍然命中 ✓ */
    assert.equal(canOpenRich("正文\n\n<div>块级</div>\n"), false);
    /*
     * 判据必须是**当前草稿**（`state.draft`）而不是载入基线 ✗（第二次复查 P2-3）：
     * 用户在纯文本里新加一段 HTML 后，提示与"回正文要显式点一次"都得跟着变 ✓。
     */
    assert.ok(editorSource.includes("useMemo(() => scanUnsupportedSyntax(state.draft)"), "按当前草稿嗅探 ✓");
    /* 回正文仍然要一次显式同意（有损转换 ✓）—— 现在那一次就是通知条上的按钮本身 ✓ */
    assert.ok(
      editorSource.includes('<button type="button" onClick={() => { setTab("rich"); }}>{t("openRichAnyway")}</button>'),
      "只有显式点「仍要用正文编辑」才允许有损转换 ✓",
    );
  });

  it("**复查（br/叠层）**：安全 <br> 变体不该落到纯文本；其它 HTML 继续保护 ✓", () => {
    /*
     * 实测（Crepe 7.22.2，真实浏览器往返）：下列写法**无操作与编辑别的段落后都逐字保留** ✓
     * ⇒ 它们必须能留在正文模式 ✗（截图里整篇退回源码正是被它触发的 ✗）。
     */
    for (const sample of [
      "第一行<br />第二行\n",
      "第一行<br>第二行\n",
      "第一行<br/>第二行\n",
      "第一行<BR />第二行\n",
      "第一行<br /><br />第二行\n",
      "上一段\n\n<br />\n\n下一段\n",
      "> 引用第一行<br />引用第二行\n",
      "| 甲<br />乙 | 丙 |\n| --- | --- |\n",
      "写作 `<br />` 会换行。\n",
      "第一行<br />第二行\n\n<div class=\"x\">块</div>\n",
    ]) {
      /* 最后一个样本里还有 <div> ⇒ 仍要命中；其余纯 br 样本必须放行 ✓ */
      const reasons = scanUnsupportedSyntax(sample).reasons;
      if (sample.includes("<div")) {
        assert.ok(reasons.includes("原始 HTML 标签"), "混排里的其它 HTML 仍要保护 ✓");
      } else {
        assert.deepEqual(reasons, [], `安全换行写法不该退回源码：${sample}`);
      }
    }
    /* 其它 HTML 一个都不能放行 ✓ */
    for (const sample of ["<span>行内</span>\n", "<!-- 注释 -->\n", "<div>块</div>\n", "<br onclick=\"x\">坏标签\n"]) {
      assert.equal(canOpenRich(sample), false, `仍要保护：${sample}`);
    }
    assert.ok(stateSource.includes("textWithoutBreaks"), "检测器要按同一份「安全能力范围」摘掉 br ✓");
  });

  it("**复查（br/叠层）**：编辑器打开时图谱 HUD 让位、且窄面板不穿透 ✓", () => {
    /* ① 编辑器层级高过上游 HUD（z-index 6）✓ */
    assert.ok(css.includes(".kn-graph:has(.kn-editor) .kn-editor"), "编辑器要整体抬高 ✓");
    assert.ok(/z-index: 12/.test(css), "要真正高过 HUD 的 6 ✓");
    /* ② 宽面板里让出编辑条 ✓ */
    assert.ok(css.includes("right: 452px"), "HUD 要在宽面板里让出编辑条 ✓");
    assert.ok(css.includes(".kn-graph:has(.kn-editor) .kn-minimap"), "右下小地图同样要让位 ✓");
    /* ③ 窄面板：图谱层不接受指针 ✓ */
    assert.ok(css.includes("pointer-events: none"), "被遮住的图谱控件不许穿透 ✓");
    /* ④ 关掉编辑器后规则自动失效（不再依赖任何持久状态）✓ */
    assert.ok(css.includes(":has(.kn-editor)"), "用 :has 跟随编辑器存在与否 ⇒ 关闭即恢复 ✓");
  });

  it("**复查（第三次）P2-1**：组合结束的待办必须重新取快照；载入判定只做一次 ✓", () => {
    /* 待办只存类型 ⇒ 补跑重走 leaveRich（内含"取快照 + 按结果决定 dirty"）✓ */
    assert.ok(editorSource.includes('pendingActionRef.current = { kind: "save" };'), "保存待办也走同一套 ✓");
    assert.ok(
      editorSource.includes("if (pending.kind === \"save\") void save();"),
      "补跑按类型分派 ✓",
    );
    assert.ok(
      editorSource.includes("else leaveRich(pending.kind);"),
      "离开类待办要重走 leaveRich ⇒ **重新取快照** ✗（不能直接跑旧闭包 ✗）",
    );
    /* 组合结束的时序触发 ✓ */
    assert.ok(
      editorSource.includes('if (tab === "rich" && richStatus.composing) return;'),
      "组合中先不补跑 ✓",
    );
    /* 载入判定只做一次：编辑途中不会被踢出正文 ✓（"语法删干净后回正文"是另一条、方向相反 ✓） */
    assert.ok(editorSource.includes("autoSourceRef.current === props.nodeId"), "每节点只判定一次 ✓");
    assert.ok(
      editorSource.includes("if (autoSourceRef.current === props.nodeId) return;"),
      "自动落到纯文本只能发生在**载入判定**那一次 ✓（编辑途中发现潜在语法只提示 ✓）",
    );
  });

  it("**复查（第三次）P2-2**：水平分隔线 / Setext 标题不算未知语法，且不再编辑途中切模式 ✓", () => {
    for (const sample of ["正文\n\n---\n\n尾巴", "标题\n===\n\n正文", "| a | b |\n| --- | --- |", "***"]) {
      assert.equal(canOpenRich(sample), true, `标准 Markdown 不该被锁进纯文本：${sample}`);
    }
    assert.ok(!stateSource.includes('"疑似 front-matter 分隔线"'), "旧的 --- 启发式必须删掉 ✗");
  });

  it("**两个入口**：选中区按钮 + 右键菜单项，走同一个动作 ✓", () => {
    assert.ok(panelSource.includes("kn-sel-edit"), "选中节点信息区要有编辑按钮 ✓");
    assert.ok(panelSource.includes('t("editNote")'), "按钮文案走词典 ✓");
    assert.ok(panelSource.includes("requestEdit({ kind: \"open\", nodeId: selectedNode.id })"), "按钮要真的打开编辑器 ✓");
    assert.ok(menuSource.includes("props.onEditNote?.(nodeId)"), "右键菜单要有同名入口 ✓");
    assert.ok(menuSource.includes("props.copy.editNote"), "菜单项文案走词典 ✓");
    assert.ok(panelSource.includes("onEditNote={(nodeId) => { setFocusId(nodeId); requestEdit({ kind: \"open\", nodeId }); }}"), "面板要把它接到编辑器上 ✓");
  });

  it("未保存时切节点/关闭：三选一（继续编辑 / 放弃修改 / 保存并继续 ✓）", () => {
    assert.ok(panelSource.includes("leaveTitle") && panelSource.includes("leaveStay"), "要弹提示 ✓");
    assert.ok(panelSource.includes("extraLabel={t(\"leaveDiscard\")}"), "要有「放弃修改」第三个按钮 ✓");
    assert.ok(panelSource.includes("onConfirm={saveAndLeave}"), "「保存并继续」要先保存 ✓");
    assert.ok(
      panelSource.includes("confirmDisabled={!editorSaveable}"),
      "保存中/不可保存由 confirmDisabled 单独挡住 ✓（不再整体禁用弹窗 ✗）",
    );
    assert.ok(
      panelSource.includes("if (pending !== null) {"),
      "只有保存成功（onSaved）才真的执行待办 ✓",
    );
    assert.ok(panelSource.includes("saveNonce={editorSaveNonce}"), "编辑器要能收到保存请求 ✓");
  });

  it("**复查 P2-3**：点「放弃修改」先清掉这个节点的草稿缓存（否则再打开又冒出来 ✗）", () => {
    assert.ok(
      panelSource.includes("if (editingNodeId !== null) forgetDraft(draftKey(libraryKey, editingNodeId));"),
      "放弃动作必须清**当前正在编辑的那个**节点的缓存 ✓",
    );
    const start = panelSource.indexOf("const discardLeave = useCallback");
    assert.ok(start > 0, "应当能找到 discardLeave");
    /* 取到下一个顶层 const 为止（声明位置会调整，不能拿别的函数名当结尾 ✗） */
    const nextDecl = panelSource.indexOf("\n  const ", start + 10);
    const discard = panelSource.slice(start, nextDecl < 0 ? panelSource.length : nextDecl);
    assert.ok(
      discard.indexOf("forgetDraft") >= 0 && discard.indexOf("forgetDraft") < discard.indexOf("setEditingNodeId"),
      "清理必须发生在关闭/切换**之前** ✓",
    );
    /*
     * 依赖数组里引用了 `libraryKey` ⇒ 声明必须在它之前 ✓
     * （依赖数组在渲染期求值，顺序错了就是 `Cannot access 'libraryKey' before initialization`
     * ⇒ 整块面板只剩"渲染出错" ✗ —— 实机踩过这一次 ✓）。
     */
    assert.ok(
      panelSource.indexOf("const libraryKey = useMemo") < start,
      "discardLeave 必须排在 libraryKey 之后 ✗",
    );
  });

  it("**复查 P2-4**：身份被采用后，编辑目标 / 选择 / 草稿键一起同步，待办照旧执行 ✓", () => {
    assert.ok(panelSource.includes("const adopted = document.nodeId !== editingNodeId;"), "要发现身份变化 ✓");
    assert.ok(panelSource.includes("setEditingNodeId(document.nodeId);"), "编辑目标换新身份 ✓");
    assert.ok(
      panelSource.includes("setFocusId(document.nodeId);"),
      "**选择**也要换 ✓（否则「选中驱动编辑」的 effect 会拿旧 id 再打开一次 ✗）",
    );
    assert.ok(panelSource.includes("forgetDraft(draftKey(libraryKey, editingNodeId));"), "旧键要删掉，不是复制保留 ✗");
    assert.ok(
      panelSource.includes("if (pending !== null) {"),
      "待办与身份更新**独立执行**（采用身份时也要真的继续 ✓）",
    );
    assert.ok(editorSource.includes("forgetDraft("), "编辑器侧也要删旧键 ✓");
  });

  it("**复查 P1-1**：传给编辑器的 target / report 必须稳定（否则重渲染就重读 ✗）", () => {
    assert.ok(panelSource.includes("const editingTarget = useMemo("), "target 要 useMemo 固化 ✓");
    assert.ok(panelSource.includes("const editorReport = useCallback("), "report 也要固化 ✓");
    assert.ok(panelSource.includes("target={editingTarget}"), "编辑器拿到的是稳定对象 ✓");
    assert.ok(panelSource.includes("report={editorReport}"), "报告回调也是稳定的 ✓");
    /* 编辑器内部：load 只依赖 nodeId 与 fetcher，**不许**依赖 target/report ✗ */
    const loadDeps = /const load = useCallback\([\s\S]*?\}, \[([^\]]*)\]\);/.exec(editorSource);
    assert.ok(loadDeps !== null, "要能找到 load 的依赖数组");
    assert.ok(!loadDeps[1].includes("props.target"), "load 不许依赖 target 对象 ✗");
    assert.ok(!loadDeps[1].includes("props.report"), "load 不许依赖 report ✗");
    assert.ok(loadDeps[1].includes("props.nodeId"), "load 要依赖 nodeId ✓");
  });

  it("**复查 P1-6**：草稿缓存在组件外、键含库身份；只缓存未保存内容 ✓（两种基线都存 ✓）", () => {
    assert.ok(editorSource.includes("recallDraft(cacheKeyRef.current)"), "挂载时先恢复草稿 ✓");
    assert.ok(
      editorSource.includes("rememberDraft(cacheKeyRef.current, {"),
      "只把**未保存**的草稿写进缓存（并且带基线 ✓）",
    );
    for (const field of ["draft: state.draft", "base: state.base", "hash: state.hash", "snapshot: state.snapshot"]) {
      assert.ok(editorSource.includes(field), `缓存记录要带 ${field} ✓（磁盘基线 + 编辑器快照 ✓）`);
    }
    assert.ok(editorSource.includes("forgetDraft(cacheKeyRef.current);"), "变干净就删记录 ✓");
    assert.ok(panelSource.includes("libraryKey={libraryKey}"), "库身份要传下来（不串库 ✓）");
    assert.ok(panelSource.includes("key={`${libraryKey}::${editingNodeId}`}"), "换库/换节点要重挂 ✓");
    assert.ok(
      editorSource.includes("seqRef.current += 1;") && editorSource.includes("abortRef.current?.abort();"),
      "卸载要同时让序号失效并取消请求 ✓（只 abort 不够 ✗）",
    );
  });

  it("**复查补充**：Ctrl/⌘+S 只在本编辑器内生效；保存期间冻结输入并禁用其它保存入口 ✓", () => {
    assert.ok(editorSource.includes("composedPath"), "要认 Shadow DOM 里的真实事件路径 ✓");
    assert.ok(editorSource.includes("root.contains(event.target as Node)"), "焦点不在本编辑器就不拦 ✓");
    assert.ok(editorSource.includes("readOnly={state.saving || state.frozen}"), "保存期间冻结输入 ✓");
    const disabled = (editorSource.match(/disabled=\{state\.saving \|\| state\.refreshing\}/g) ?? []).length;
    assert.ok(disabled >= 4, `比较 / 合并 / 放弃等入口在保存期间都要禁用（实际 ${disabled} 处 ✓）`);
  });

  it("**复查 P2-7 / P2-4**：身份被采用后编辑目标、选择与草稿键一起换 ✓", () => {
    assert.ok(editorSource.includes("outcome.document.nodeId !== props.nodeId"), "编辑器要发现身份变化 ✓");
    assert.ok(panelSource.includes("const adopted = document.nodeId !== editingNodeId;"), "面板要跟着换目标 ✓");
    assert.ok(panelSource.includes("setFocusId(document.nodeId);"), "选择也要换 ✓");
  });

  it("**复查 P1-1（第三轮）**：没有 latest 时「合并保存」只刷新，**绝不写入** ✗", () => {
    const fresh = () => editorReducer(initialEditorState("n1"), { type: "load-ok", document: DOC });
    /* 冲突但没带回 latest（宿主再次读取失败或最新正文超限都可能这样 ✓） */
    const conflicted = editorReducer(fresh(), { type: "save-conflict", latest: null });
    assert.equal(conflicted.latest, null);
    /* 此时"合并"是空操作 ⇒ 组件只会去刷新，不会拿刚读到的 hash 提交 ✗ */
    const still = editorReducer(conflicted, { type: "merge-and-save" });
    assert.deepEqual(still, conflicted, "没有 latest 时合并必须什么都不做 ✓");
    assert.equal(canSave(still), false, "也不许因此变成可保存（否则等于替用户确认覆盖 ✗）");
    /* 刷新成功（用户已经能看到最新正文 ✓）之后才允许换基线 ✓ */
    const refreshed = editorReducer(conflicted, {
      type: "conflict-refresh-ok",
      latest: { ...DOC, text: "磁盘最新", hash: "h9" },
    });
    assert.equal(refreshed.latest.text, "磁盘最新");
    assert.equal(
      refreshed.comparing,
      conflicted.comparing,
      "读取最新版本**不顺手改展开状态** ✓（展开与否由用户点「比较修改」决定 ✓）",
    );
    assert.equal(refreshed.draft, conflicted.draft, "刷新不许动草稿 ✗");
    const merged = editorReducer(refreshed, { type: "merge-and-save" });
    assert.equal(merged.hash, "h9", "看过之后才能以新基线提交 ✓");
    assert.equal(merged.draft, conflicted.draft, "草稿仍然保留 ✓");
  });

  it("**复查 P2-3（第三轮）**：冲突刷新有 refreshing 状态、失败保留草稿 ✓", () => {
    const fresh = () => editorReducer(initialEditorState("n1"), { type: "load-ok", document: DOC });
    const conflicted = editorReducer(fresh(), { type: "save-conflict", latest: null });
    const refreshing = editorReducer(conflicted, { type: "conflict-refresh-start" });
    assert.equal(refreshing.refreshing, true, "要能显示「正在读取最新正文」✓");
    const failed = editorReducer(refreshing, { type: "conflict-refresh-failed", key: "mergeFailed" });
    assert.equal(failed.refreshing, false);
    assert.equal(failed.draft, conflicted.draft, "读取失败草稿必须还在 ✗");
    assert.equal(failed.saveErrorKey, "mergeFailed", "要有可见的失败提示 ✓");
  });

  it("**复查 P2-3（第三轮）**：最新正文读取守卫 —— 晚到的旧读取不许覆盖新的 ✓", () => {
    const guard = createLatestGuard();
    const first = guard.next();
    const second = guard.next();
    assert.equal(guard.isCurrent(first), false, "起了新读取 ⇒ 旧的那个作废 ✓");
    assert.equal(guard.isCurrent(second), true);
    assert.equal(guard.isCurrent(first), false, "旧的（哪怕更晚返回）不许改状态 ✗");
    guard.invalidate();
    assert.equal(guard.isCurrent(second), false, "保存开始/成功要让在飞的比较读取作废 ✓");
    const third = guard.next();
    assert.equal(guard.isCurrent(third), true, "之后新起的读取照常有效 ✓");
  });

  it("**复查 P2-2（第三轮）**：保存失败/冲突 ⇒ 父面板收起弹窗并清掉待办 ✓", () => {
    assert.ok(editorSource.includes("onSaveOutcome"), "编辑器要报告保存生命周期 ✓");
    assert.ok(panelSource.includes("onSaveOutcome={onEditorSaveOutcome}"), "面板要接上 ✓");
    assert.ok(panelSource.includes('if (outcome === "saved") return;'), "成功才保留待办 ✓");
    assert.ok(
      panelSource.includes("pendingEditRef.current = null;") && panelSource.includes("setLeaveDialog(null);"),
      "失败/冲突要清待办并收起弹窗 ✓（否则全屏弹窗挡住错误与合并入口 ✗）",
    );
    assert.ok(panelSource.includes("busy={editorSaving}"), "弹窗要有「保存中」的冻结态 ✓");
    assert.ok(panelSource.includes("confirmDisabled={!editorSaveable}"), "不可保存时只禁用确认 ✓");
    assert.ok(confirmSource.includes("disabled={busy}"), "弹窗按钮要真的禁用 ✓");
    assert.ok(confirmSource.includes("onClick={busy ? undefined : onCancel}"), "保存中点背景也不许关（那是「放弃」语义 ✗）✓");
  });

  it("**复查小项**：复制草稿有成功/失败反馈；保存错误显示**具体**原因 ✓", () => {
    assert.ok(editorSource.includes('setCopyState("done")'), "复制成功要有反馈 ✓");
    assert.ok(editorSource.includes('setCopyState("failed")'), "复制失败也要有反馈 ✓");
    assert.ok(editorSource.includes("t(state.saveErrorKey)"), "错误区显示具体 key（节点删除 / 超限 / 缺指纹 ✓）");
    assert.ok(editorSource.includes("mergeNeedsReview"), "没有 latest 时要有「先查看再合并」的说明 ✓");
  });

  it("**复查 P2-1（第四轮）**：保存接管刷新 ⇒ `conflict-refresh-start → save-start → save-ok` 之后三个标志全为 false ✓", () => {
    const fresh = () => editorReducer(initialEditorState("n1"), { type: "load-ok", document: DOC });
    const refreshing = editorReducer(
      editorReducer(fresh(), { type: "save-conflict", latest: null }),
      { type: "conflict-refresh-start" },
    );
    assert.equal(refreshing.refreshing, true, "前置：正在刷新最新正文 ✓");
    const saving = editorReducer(refreshing, { type: "save-start" });
    assert.equal(saving.refreshing, false, "保存一开始就要清掉 refreshing ✗（否则永远停在 true ✓）");
    assert.equal(saving.saving, true);
    assert.equal(saving.frozen, true);
    const done = editorReducer(saving, {
      type: "save-ok",
      document: { ...DOC, text: "存下去的正文", hash: "h7", revision: 9 },
      submitted: "存下去的正文",
    });
    assert.equal(done.refreshing, false, "成功分支也要明确清理 ✓");
    assert.equal(done.saving, false);
    assert.equal(done.frozen, false, "三个标志都归零 ⇒ 状态机自洽 ✓");
    /* 失败分支同样清（既有断言已覆盖 ✓），这里确认不会留下"进行中"的假象 ✓ */
    const failed = editorReducer(saving, { type: "save-failed", key: "saveFailed" });
    assert.equal(failed.refreshing, false);
  });

  it("**复查 P2-2（第四轮）**：提前失败（缺指纹）也要通知父面板 ⇒ 弹窗收起、待办清掉 ✓", () => {
    /* 组件侧：统一失败出口 ✓ */
    assert.ok(editorSource.includes("const fail = (key: string): false => {"), "要有统一失败出口 ✓");
    const failBlock = editorSource.slice(
      editorSource.indexOf("const fail = (key: string): false => {"),
      editorSource.indexOf('if (hash === "")'),
    );
    assert.ok(failBlock.includes('dispatch({ type: "save-failed", key })'), "失败要更新状态 ✓");
    assert.ok(failBlock.includes("saveOutcomeRef.current?.(false, key)"), "失败**必须**通知父面板 ✓");
    assert.ok(
      editorSource.includes('if (hash === "") return fail("missingFingerprint")'),
      "缺指纹的提前拒绝要走出这个出口 ✓",
    );
    /* 互斥门挡下的重复请求**不算失败** ⇒ 不许误清另一个请求的待办 ✓ */
    assert.ok(
      editorSource.includes("if (!saveGateRef.current.tryEnter()) return false;"),
      "被互斥门挡下时直接返回、不通知父面板 ✓",
    );
    /* 结构化的失败与异常也都走 fail ✓ */
    assert.ok(editorSource.includes("return fail(failureKey(outcome.code))"), "结构化失败走统一出口 ✓");
    assert.ok(editorSource.includes('return fail("saveFailed")'), "异常走统一出口 ✓");
    /* 父面板侧：不可保存时提前禁用确认，并给出指引 ✓（文案抽在 `leaveLabels` 纯函数里 ✓） */
    assert.ok(panelSource.includes("onSaveableChange={setEditorSaveable}"), "面板要接可保存状态 ✓");
    assert.ok(panelSource.includes("leaveLabels("), "面板要用纯函数取弹窗文案 ✓");
    assert.ok(stateSource.includes('t("leaveBlocked")'), "不可保存时给出「去哪处理」的说明 ✓");
  });

  it("**复查 P1-5**：不可保存时只禁用「保存」，继续编辑 / 放弃 / Esc / 点背景都必须可用 ✓", () => {
    /*
     * 弹窗的键盘语义用**可执行**的纯函数验证 ✓（`.tsx` 不能被 Node 直接导入 ✗）：
     * - 正在写盘 ⇒ 一切冻结；
     * - 只是"当前存不了" ⇒ **只**挡 Enter，Esc 照常返回编辑器 ✓。
     */
    assert.equal(dialogKeyboardIntent("Escape", { busy: true }), "ignore", "写盘期间 Esc 也不生效 ✓");
    assert.equal(dialogKeyboardIntent("Enter", { busy: true }), "ignore", "写盘期间 Enter 不重复确认 ✓");
    assert.equal(
      dialogKeyboardIntent("Escape", { confirmDisabled: true }),
      "cancel",
      "**只是存不了**时 Esc 必须能回到编辑器 ✗（复查 P1-5）",
    );
    assert.equal(dialogKeyboardIntent("Enter", { confirmDisabled: true }), "ignore", "存不了时 Enter 不该触发保存 ✓");
    assert.equal(dialogKeyboardIntent("Escape", {}), "cancel", "正常时 Esc = 取消 ✓");
    assert.equal(dialogKeyboardIntent("Enter", {}), "confirm", "正常时 Enter = 确认 ✓");
    assert.equal(dialogKeyboardIntent("a", {}), "ignore", "其它键不理会 ✓");

    /* 接线：两个参数**分开**传 ✓；只禁用确认那一个按钮 ✓；背景点击只在写盘时失效 ✓ */
    assert.ok(panelSource.includes("busy={editorSaving}"), "busy 只对应「正在写盘」✓");
    assert.ok(panelSource.includes("confirmDisabled={!editorSaveable}"), "不可保存单独传 ✓");
    assert.ok(!panelSource.includes("busy={editorSaving || !editorSaveable}"), "不许再把两者混在一起 ✗");
    assert.ok(confirmSource.includes("disabled={confirmDisabled}"), "确认按钮按 confirmDisabled 禁用 ✓");
    assert.ok(
      confirmSource.includes("disabled={busy} onClick={onCancel}"),
      "「继续编辑」只在写盘时禁用 ✓（存不了不该困住用户 ✗）",
    );
    assert.ok(confirmSource.includes("onClick={busy ? undefined : onCancel}"), "点背景只在写盘时失效 ✓");
    assert.ok(stateSource.includes('t("leaveSaveBlocked")'), "确认按钮文案要解释当前不可保存 ✓");
  });

  it("保存成功后**轻量刷新、不重建布局**（图谱视角与转动中心不动 ✓）", () => {
    assert.ok(panelSource.includes("void load({ refresh: true });"), "保存后重新取数 ✓");
    const onSavedBlock = panelSource.slice(panelSource.indexOf("onSaved={() => {"), panelSource.indexOf("onSaved={() => {") + 600);
    assert.ok(!onSavedBlock.includes("relayoutToken"), "不许顺手重排 ✗");
    assert.ok(!onSavedBlock.includes("setCameraCommand"), "不许顺手动镜头 ✗");
    assert.ok(!onSavedBlock.includes("setEditingNodeId(null)"), "不该无条件关闭编辑器（要按待办走 ✓）");
  });

  it("文案同时进中英词典 ✓；窄面板覆盖、宽面板并排 ✓", () => {
    /* `saveNote` 已随保存按钮撤掉 ⇒ 换成仍在使用的那几条 ✓ */
    for (const key of [
      "editNote", "notePanelTitle", "statusDirty", "statusSaving", "saveShortcut",
      "unsupportedNotice", "unsupportedRisk", "openRichAnyway", "backToPlainText",
      "richFailed", "conflictNotice", "leaveDiscard",
    ]) {
      const zh = dictSource.slice(dictSource.indexOf("const DICT_ZH"), dictSource.indexOf("const DICT_EN"));
      const en = dictSource.slice(dictSource.indexOf("const DICT_EN"));
      assert.ok(zh.includes(`${key}:`), `中文词典要有 ${key} ✓`);
      assert.ok(en.includes(`${key}:`), `英文词典要有 ${key} ✓`);
    }
    assert.ok(css.includes("container-type: inline-size"), "按**面板自己的宽度**判断（容器查询 ✓）");
    assert.ok(css.includes("@container (min-width: 720px)"), "宽面板并排 ✓");
    assert.ok(css.includes(".kn-sel"), "选中信息条要有样式 ✓");
    assert.ok(css.includes(".kn-root .sr-only"), "上游那个 sr-only 播报要真正隐藏 ✗（它没有样式会露出来 ✓）");
  });
});
