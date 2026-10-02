/**
 * **保存确认 → 关闭/切换 → 再打开** 的一致性测试
 * （`design/save-and-close-reopen-conflict-optimization.md` ✓）。
 *
 * 要防的是那条真实存在的时序缺口：
 * 保存成功后父面板**立刻卸载编辑器**，那条"按 isDirty 写/删草稿缓存"的 effect 根本来不及跑 ⇒
 * 旧草稿记录留在缓存里；下次打开先恢复它，而磁盘已是保存后的新指纹 ⇒
 * **自己的保存被当成外部修改** ✗（用户刚点"保存并关闭"，重开却看到星号 + 冲突提示 ✓）。
 *
 * 这里把正确性钉在三件事上：
 * 1. `saveCommit` 是**唯一**的"保存后该长什么样"（reducer 与缓存提交共用 ✓）；
 * 2. `commitSavedDraft` 的缓存结果（含"保存后立即卸载"这个确定性场景 ✓）；
 * 3. 组件里的**顺序**：落缓存 → 更新界面 → 通知父面板 ✓（不许靠 setTimeout / 等 effect ✓）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  EDITOR_LITERAL,
  clearDraftCache,
  commitSavedDraft,
  diffLines,
  draftKey,
  editorReducer,
  forgetDraft,
  initialEditorState,
  isDirty,
  leaveLabels,
  recallDraft,
  rememberDraft,
  saveCommit,
} from "../src/client/node-document-state.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "..", "src", "client");
const editorSource = readFileSync(path.join(CLIENT, "NodeDocumentEditor.tsx"), "utf8");
const panelSource = readFileSync(path.join(CLIENT, "GraphPanel.tsx"), "utf8");
const stateSource = readFileSync(path.join(CLIENT, "node-document-state.ts"), "utf8");
const dictSource = readFileSync(path.join(CLIENT, "index.ts"), "utf8");

/** 宿主确认保存后返回的文档 ✓（正文可能已被**规范化** ✗ ⇒ 与提交的那份不完全相同 ✓） */
const DOC = {
  nodeId: "n1",
  text: "正文（宿主规范化后）",
  hash: "h2",
  revision: 2,
  path: "Nodes/主题.md",
  title: "主题",
};

const fresh = () => editorReducer(initialEditorState("n1"), { type: "load-ok", document: { ...DOC, text: "原始正文", hash: "h1", revision: 1 } });

describe("saveCommit：保存后该长什么样（reducer 与缓存共用同一套规则）", () => {
  it("提交后没有新修改 ⇒ 草稿保持编辑器那份、**磁盘基线与编辑器快照分开** ✓", () => {
    const commit = saveCommit("提交的那份", DOC, "提交的那份");
    assert.equal(commit.draft, "提交的那份", "草稿保持编辑器那份 ✗（不再改写成磁盘正文 ✓）");
    assert.equal(commit.base, DOC.text, "**磁盘基线**用宿主规范化后的正文 ✓");
    assert.equal(commit.snapshot, "提交的那份", "**编辑器快照** = 提交上去的那份 ✓（脏不脏看它 ✓）");
    assert.equal(commit.hash, DOC.hash);
    assert.equal(commit.nodeId, DOC.nodeId);
    assert.equal(commit.dirty, false, "提交后没再改 ⇒ 干净 ✓（哪怕与磁盘正文差着末尾空白 ✓）");
  });

  it("提交之后又有新修改 ⇒ 保留新草稿、快照仍是提交的那份 ✓（不能无条件删缓存 ✗）", () => {
    const commit = saveCommit("提交之后又敲的字", DOC, "提交的那份");
    assert.equal(commit.draft, "提交之后又敲的字", "新修改必须保留 ✗");
    assert.equal(commit.base, DOC.text, "磁盘基线以宿主返回的为准 ✓");
    assert.equal(commit.snapshot, "提交的那份", "编辑器快照是提交的那份 ✓");
    assert.equal(commit.hash, DOC.hash);
    assert.equal(commit.dirty, true, "还有未保存内容 ⇒ 缓存必须留着 ✓");
  });

  it("身份被「采用」（临时 ID → ULID）也走同一套 ✓", () => {
    const adopted = { ...DOC, nodeId: "01ULID", text: "规范化", hash: "h3" };
    const commit = saveCommit("规范化", adopted, "规范化");
    assert.equal(commit.nodeId, "01ULID");
    assert.equal(commit.hash, "h3");
    assert.equal(commit.dirty, false);
  });

  it("reducer 的 `save-ok` 与 `saveCommit` 逐字段一致 ✓（不许两边各算一次 ✗）", () => {
    for (const [draft, submitted] of [["规范化", "规范化"], ["又改了", "规范化"]]) {
      const state = editorReducer(fresh(), { type: "edit", text: draft });
      const next = editorReducer(state, { type: "save-ok", document: DOC, submitted });
      const commit = saveCommit(draft, DOC, submitted);
      assert.equal(next.draft, commit.draft);
      assert.equal(next.base, commit.base);
      assert.equal(next.hash, commit.hash);
      assert.equal(next.nodeId, commit.nodeId);
      assert.equal(next.revision, commit.revision);
      assert.equal(next.path, commit.path);
      assert.equal(next.title, commit.title);
      assert.equal(next.conflicted, false);
      assert.equal(next.comparing, false);
      assert.equal(next.saving, false);
    }
  });
});

describe("commitSavedDraft：保存确认**同步**落缓存（保存后立即卸载也不留脏记录）", () => {
  it("**保存后立即卸载**这个场景：旧记录必须在通知离开之前就没了 ✓", () => {
    clearDraftCache();
    const key = draftKey("L", "n1");
    /* 用户编辑时的常态：缓存里有一条脏记录（旧基线 + 旧指纹 ✓） */
    rememberDraft(key, { draft: "规范化", base: "原始正文", hash: "h1" });
    assert.notEqual(recallDraft(key), undefined, "前置：确实有脏记录 ✓");

    /*
     * 保存确认（组件做这件事的顺序：**先落缓存，再通知父面板** ✓）——
     * 这里不渲染 React，只验证"卸载前那次同步提交"的结果 ✓：
     * 保存成功且草稿干净 ⇒ 记录必须已经被删掉 ✓。
     */
    const commit = saveCommit("规范化", DOC, "规范化");
    const result = commitSavedDraft(key, key, commit);
    assert.equal(result.kept, false);
    assert.equal(recallDraft(key), undefined, "重开时不该再恢复旧草稿 ⇒ 不会把自己的保存误判成外部修改 ✗");
  });

  it("提交后还有新修改 ⇒ 新记录带着**新基线**与**旧快照**留着 ✓", () => {
    clearDraftCache();
    const commit = saveCommit("又改了", DOC, "规范化");
    const key = draftKey("L", "n1");
    const result = commitSavedDraft(key, key, commit);
    assert.equal(result.kept, true);
    assert.deepEqual(recallDraft(draftKey("L", "n1")), {
      draft: "又改了",
      base: DOC.text,
      hash: DOC.hash,
      snapshot: "规范化",
    });
  });

  it("身份被采用 ⇒ 旧键删掉、新键只在仍有新修改时保留 ✓", () => {
    clearDraftCache();
    const oldKey = draftKey("L", "adopted-1");
    const newKey = draftKey("L", "01ULID");
    rememberDraft(oldKey, { draft: "草稿", base: "旧的", hash: "h1" });
    const adopted = { ...DOC, nodeId: "01ULID", text: "草稿", hash: "h4" };
    const clean = commitSavedDraft(oldKey, newKey, saveCommit("草稿", adopted, "草稿"));
    assert.equal(clean.key, newKey);
    assert.equal(recallDraft(oldKey), undefined, "旧键必须删掉 ✗（不能复制后保留 ✓）");
    assert.equal(recallDraft(newKey), undefined, "干净 ⇒ 新键也不留 ✓");

    clearDraftCache();
    rememberDraft(oldKey, { draft: "草稿", base: "旧的", hash: "h1" });
    const dirty = commitSavedDraft(oldKey, newKey, saveCommit("又改了", adopted, "草稿"));
    assert.equal(dirty.kept, true);
    assert.equal(recallDraft(oldKey), undefined);
    assert.equal(recallDraft(newKey).draft, "又改了");
  });
});

describe("组件里的顺序：落缓存 → 更新界面 → 通知父面板", () => {
  const success = editorSource.slice(
    editorSource.indexOf("if (outcome.ok === true) {"),
    editorSource.indexOf('if (outcome.code === "conflict")'),
  );

  it("缓存提交发生在 `onSaved` / 「saved」通知**之前** ✓", () => {
    assert.ok(success.length > 0, "要能找到保存成功的分支 ✓");
    const commitAt = success.indexOf("commitSavedDraft(");
    const savedAt = success.indexOf("saveOutcomeRef.current?.(false, commit.dirty");
    const notifyAt = success.indexOf("onSavedRef.current?.(outcome.document)");
    assert.ok(commitAt >= 0, "成功分支必须同步落缓存 ✓");
    assert.ok(savedAt > commitAt, "先落缓存，再报保存结果 ✓");
    assert.ok(notifyAt > commitAt, "先落缓存，再通知父面板关闭/切换 ✓（父面板会立刻卸载编辑器 ✗）");
    /* 顺序不能建立在调度时机上 ✗（文档明确否掉 setTimeout / 延迟一帧 / 等 effect ✓） */
    assert.ok(!/setTimeout|requestAnimationFrame/.test(success), "不许用 setTimeout / rAF 保顺序 ✗");
  });

  it("「提交之后还有新修改」要按**当下**状态判断，不能看发起保存时的闭包 ✗", () => {
    assert.ok(editorSource.includes("stateRef.current.draft"), "要用当下这份草稿 ✓");
    assert.ok(
      /const stateRef = useRef\(state\);\s*\n\s*stateRef\.current = state;/.test(editorSource),
      "stateRef 要每次渲染刷新 ✓",
    );
  });

  it("保存确认后**还有新草稿** ⇒ 报 `saved-dirty`，父面板因此留在原地 ✓", () => {
    assert.ok(
      editorSource.includes('saveOutcomeRef.current?.(false, commit.dirty ? "saved-dirty" : "saved")'),
      "还有未保存的新草稿时不许当成「干净的离开」✗",
    );
    assert.ok(panelSource.includes('if (outcome === "saved") return;'), "父面板只在干净保存时继续执行待办 ✓");
    assert.ok(editorSource.includes("node-document-saved-stay"), "「留在原地」也要留痕 ✓");
  });

  it("流程留痕齐全、且**不含正文** ✓", () => {
    for (const step of [
      "node-document-cache-commit",
      "node-document-leave-notify",
      "node-document-saved-stay",
      "node-document-unmount",
      "node-document-draft-recall",
      "node-document-conflict-detected",
    ]) {
      assert.ok(editorSource.includes(step), `要留痕 ${step} ✓`);
    }
    const commitReport = editorSource.slice(
      editorSource.indexOf('reportRef.current?.("node-document-cache-commit"'),
      editorSource.indexOf('reportRef.current?.("node-document-saved"'),
    );
    assert.ok(commitReport.length > 0, "要能找到这条留痕 ✓");
    assert.ok(!/\btext:|\bdraft:/.test(commitReport), "留痕只记节点键/指纹这类事实 ✗（不许带用户正文 ✓）");
  });
});

describe("真实冲突：默认轻量，比较由用户主动发起", () => {
  it("保存冲突与重开冲突都**不自动展开**比较区 ✓", () => {
    const conflicted = editorReducer(fresh(), { type: "save-conflict", latest: { ...DOC, hash: "h2" } });
    assert.equal(conflicted.conflicted, true);
    assert.equal(conflicted.comparing, false, "默认只留一句话 ✓（黄色大块 + 整篇源码会把正文挤走 ✗）");
    assert.notEqual(conflicted.latest, null, "最新版本仍要读回来（点比较就有 ✓）");

    const reloaded = editorReducer(
      editorReducer(fresh(), { type: "edit", text: "我的修改" }),
      { type: "load-ok", document: { ...DOC, text: "别人的修改", hash: "h9" } },
    );
    assert.equal(reloaded.conflicted, true);
    assert.equal(reloaded.comparing, false);
  });

  it("「保存合并结果」要等用户看过最新版本才可用 ✓", () => {
    assert.ok(
      /disabled=\{state\.saving \|\| state\.refreshing \|\| state\.latest === null \|\| !state\.comparing\}/.test(editorSource),
      "未比较完不许合并 ✗（不替用户承担他并没有制造的合并任务 ✓）",
    );
    const compareButton = editorSource.slice(
      editorSource.indexOf("conflictNotice"),
      editorSource.indexOf('t("mergeAndSave")'),
    );
    assert.ok(compareButton.includes('dispatch({ type: "toggle-compare" })'), "比较要用户点才展开 ✓");
    assert.ok(compareButton.includes("if (state.latest === null) void refreshLatest();"), "没读到就先读一次 ✓");
  });

  it("比较区：我的修改 / 文件最新版本分栏，只对差异行做局部标注 ✓", () => {
    assert.ok(editorSource.includes('className="kn-editor-compare-pane"'), "要有分栏 ✓");
    assert.ok(editorSource.includes('{t("myDraft")}') && editorSource.includes('{t("latestText")}'), "两侧要写明是谁 ✓");
    assert.ok(editorSource.includes("kn-editor-diff-line"), "差异行局部标注 ✓");
    assert.ok(!editorSource.includes("kn-editor-latest"), "整篇源码平铺那块已经撤掉 ✗");
    assert.ok(dictSource.includes("compareChanges:"), "「比较修改」入词典 ✓");
  });

  it("放弃修改仍要二次确认（不是默认覆盖 ✗）", () => {
    assert.ok(editorSource.includes("setConfirmAdopt(true)"), "「使用文件最新版本」要经过确认 ✓");
    assert.ok(editorSource.includes('t("adoptLatestConfirmMessage")'), "确认里要说明后果 ✓");
  });
});

describe("离开弹窗文案：动作说清楚", () => {
  const t = (key) => key;

  it("关闭 ⇒「保存并关闭」；切节点 ⇒「保存并切换」✓", () => {
    const close = leaveLabels("close", t, { saving: false, saveable: true });
    assert.equal(close.confirmLabel, "leaveSaveClose");
    assert.equal(close.message, "leaveCloseMessage");
    const open = leaveLabels("open", t, { saving: false, saveable: true });
    assert.equal(open.confirmLabel, "leaveSaveSwitch");
    assert.equal(open.message, "leaveSwitchMessage");
    assert.equal(close.title, "leaveTitle");
  });

  it("写盘中 ⇒ 按钮就是「正在保存…」；存不了 ⇒ 说明要去处理什么 ✓", () => {
    const saving = leaveLabels("close", t, { saving: true, saveable: true });
    assert.equal(saving.confirmLabel, "statusSaving");
    assert.equal(saving.message, "statusSaving");
    const blocked = leaveLabels("open", t, { saving: false, saveable: false });
    assert.equal(blocked.confirmLabel, "leaveSaveBlocked");
    assert.equal(blocked.message, "leaveBlocked");
  });

  it("中英词典 + 回落文案都齐 ✓", () => {
    const zh = dictSource.slice(dictSource.indexOf("const DICT_ZH"), dictSource.indexOf("const DICT_EN"));
    const en = dictSource.slice(dictSource.indexOf("const DICT_EN"));
    for (const key of [
      "leaveCloseMessage", "leaveSwitchMessage", "leaveSaveClose", "leaveSaveSwitch",
      "compareChanges", "hideCompare", "compareIdentical", "myDraft", "latestText",
    ]) {
      assert.ok(zh.includes(`${key}:`), `中文词典要有 ${key} ✓`);
      assert.ok(en.includes(`${key}:`), `英文词典要有 ${key} ✓`);
      assert.equal(typeof EDITOR_LITERAL[key], "string", `回落文案要有 ${key} ✓`);
    }
    assert.ok(panelSource.includes("leaveLabels("), "面板要用同一套文案 ✓");
  });
});

describe("端到端状态机：打开 → 编辑 → 保存 → 立即卸载 → 再打开", () => {
  const KEY = draftKey("L", "n1");
  const DISK_V1 = { ...DOC, text: "原始正文", hash: "h1", revision: 1 };
  /** 宿主保存后返回的正文可能已被**规范化** ⇒ 与提交的那份不完全相同 ✓ */
  const SAVED = { ...DOC, text: "原始正文 加了一行", hash: "h2", revision: 2 };

  /** 编辑器挂载时真实做的事：先恢复缓存里的草稿（如果有 ✓），再读盘 ✓ */
  function reopen(disk) {
    let state = initialEditorState("n1");
    const record = recallDraft(KEY);
    if (record !== undefined) {
      state = editorReducer(state, { type: "restore-draft", draft: record.draft, base: record.base, hash: record.hash });
    }
    return editorReducer(state, { type: "load-ok", document: disk });
  }

  /** 编辑期间的缓存 effect（组件里就是这一条规则 ✓） */
  function cacheEffect(state) {
    if (isDirty(state)) {
      rememberDraft(KEY, { draft: state.draft, base: state.base, hash: state.hash });
    } else {
      forgetDraft(KEY);
    }
  }

  it("**保存并关闭 → 立即卸载 → 再打开**：干净、没有星号、没有冲突 ✓（这就是复查要的端到端 ✓）", () => {
    clearDraftCache();
    /* ① 打开 + 编辑（草稿变脏 ⇒ 缓存写下旧基线与旧指纹 ✓） */
    let state = reopen(DISK_V1);
    state = editorReducer(state, { type: "edit", text: `${DISK_V1.text} 加了一行\n\n` });
    cacheEffect(state);
    assert.equal(isDirty(state), true);
    assert.notEqual(recallDraft(KEY), undefined, "前置：编辑期缓存里确实有一条脏记录 ✓");

    /* ② 保存确认：**先落缓存**（父面板马上卸载，effect 来不及跑 ✗） */
    const commit = saveCommit(state.draft, SAVED, state.draft);
    commitSavedDraft(KEY, KEY, commit);
    /* ③ 父面板立刻卸载编辑器 —— 这里什么都不做，模拟"那条 effect 没有机会跑" ✓ */
    state = editorReducer(state, { type: "save-ok", document: SAVED, submitted: state.draft });
    assert.equal(isDirty(state), false, "界面这边已经干净 ✓");

    /* ④ 再打开：缓存里不该再有旧记录 ⇒ 不会把自己的保存误判成外部修改 ✓ */
    const again = reopen(SAVED);
    assert.equal(recallDraft(KEY), undefined, "旧草稿记录必须已经被清掉 ✗");
    assert.equal(again.conflicted, false, "**不许**出现冲突提示 ✗（复查截图里的问题 ✓）");
    assert.equal(again.draft, SAVED.text, "显示的应当是确认保存后的正文 ✓");
    assert.equal(isDirty(again), false, "也不该有未保存星号 ✓");
  });

  it("**反面对照**：漏掉「先落缓存」这一步就会复现冲突 ✓（证明上面那条真的在防回归 ✓）", () => {
    clearDraftCache();
    let state = reopen(DISK_V1);
    state = editorReducer(state, { type: "edit", text: `${DISK_V1.text} 加了一行\n\n` });
    cacheEffect(state);

    /* 只走 dispatch、不落缓存（= 修复前的老行为 ✓），然后立刻卸载 ✓ */
    state = editorReducer(state, { type: "save-ok", document: SAVED, submitted: state.draft });
    assert.notEqual(recallDraft(KEY), undefined, "旧记录还在 ✓");

    const again = reopen(SAVED);
    assert.equal(again.conflicted, true, "老行为确实会把自己的保存当成外部修改 ✗（复查实测 ✓）");
  });

  it("保存**失败** ⇒ 草稿与缓存都留着，磁盘没变所以再打开也不冲突 ✓", () => {
    clearDraftCache();
    let state = reopen(DISK_V1);
    state = editorReducer(state, { type: "edit", text: "改了但没存上" });
    cacheEffect(state);
    state = editorReducer(state, { type: "save-failed", key: "saveFailed" });
    assert.equal(isDirty(state), true, "草稿必须还在 ✓");
    assert.equal(state.saveErrorKey, "saveFailed");
    assert.notEqual(recallDraft(KEY), undefined, "缓存也要留着 ✓");
    /* 磁盘没变 ⇒ 恢复草稿后指纹一致 ⇒ 只是继续编辑 ✓ */
    const again = reopen(DISK_V1);
    assert.equal(again.conflicted, false, "不该误判成冲突 ✓");
    assert.equal(again.draft, "改了但没存上", "恢复的仍是用户输入 ✓");
  });

  it("保存后**仍有新草稿** ⇒ 缓存带着新基线留着；再打开不冲突（但仍有星号 ✓）", () => {
    clearDraftCache();
    let state = reopen(DISK_V1);
    state = editorReducer(state, { type: "edit", text: "第一次提交" });
    cacheEffect(state);
    /* 提交之后又有了新修改（冻结失效等边界）：保存确认要保留它 ✓ */
    const submitted = "第一次提交";
    const typedAfter = "提交之后又敲的字";
    const commit = saveCommit(typedAfter, SAVED, submitted);
    assert.equal(commit.dirty, true);
    commitSavedDraft(KEY, KEY, commit);
    /* 回调里读到的是**当下**这份草稿（比提交的那份新 ✓）——直接构造出这个状态 ✓ */
    const saved = editorReducer({ ...state, draft: typedAfter }, { type: "save-ok", document: SAVED, submitted });
    assert.equal(isDirty(saved), true, "保存确认后仍有未保存内容 ✓");

    const again = reopen(SAVED);
    assert.equal(again.conflicted, false, "基线是保存后的那份 ⇒ 不是冲突 ✓");
    assert.equal(again.draft, "提交之后又敲的字", "新草稿必须保留 ✓");
    assert.equal(isDirty(again), true, "还有未保存内容 ⇒ 该有星号 ✓");
  });

  it("身份被采用（adopted-* → ULID）后旧键不再冒出来 ✓", () => {
    clearDraftCache();
    const oldKey = draftKey("L", "adopted-1");
    const newKey = draftKey("L", "01ULID");
    let state = editorReducer(initialEditorState("adopted-1"), { type: "load-ok", document: { ...DISK_V1, nodeId: "adopted-1" } });
    state = editorReducer(state, { type: "edit", text: "临时身份下写的" });
    rememberDraft(oldKey, { draft: state.draft, base: state.base, hash: state.hash });

    const adopted = { ...DOC, nodeId: "01ULID", text: "临时身份下写的", hash: "h5", revision: 3 };
    const commit = saveCommit(state.draft, adopted, state.draft);
    commitSavedDraft(oldKey, newKey, commit);
    assert.equal(recallDraft(oldKey), undefined, "旧键必须删掉 ✗");
    assert.equal(recallDraft(newKey), undefined, "干净 ⇒ 新键也不留 ✓");

    /* 用新身份再打开：干净 ✓ */
    const reopened = editorReducer(initialEditorState("01ULID"), { type: "load-ok", document: adopted });
    assert.equal(reopened.conflicted, false);
    assert.equal(isDirty(reopened), false);
  });
});

describe("末尾换行不是用户修改（用户实测的那条 ✗）", () => {
  /** 宿主落盘时去掉末尾空白 ✓；编辑器输出 Markdown 时补回末尾换行 ✓ */
  const DISK = { ...DOC, text: "第一段\n\n第二段", hash: "h1", revision: 1 };
  const EDITOR = `${DISK.text}\n`;

  it("载入后编辑器报基线 ⇒ 草稿/快照一起对齐，但**磁盘基线保持不变** ✓", () => {
    const loaded = editorReducer(initialEditorState("n1"), { type: "load-ok", document: DISK });
    assert.equal(isDirty(loaded), false);
    assert.equal(loaded.base, DISK.text, "磁盘基线就是宿主那份 ✓");

    const aligned = editorReducer(loaded, { type: "editor-baseline", ingested: DISK.text, canonical: EDITOR });
    assert.equal(aligned.draft, EDITOR, "草稿换成**编辑器自己的写法** ✓（末尾换行是它写的 ✓）");
    assert.equal(aligned.snapshot, EDITOR, "快照同步 ✓");
    assert.equal(aligned.base, DISK.text, "磁盘基线**不许**被编辑器写法污染 ✗（冲突保护要用它 ✓）");
    assert.equal(isDirty(aligned), false, "这不是用户修改 ⇒ 不许有星号 ✗");
  });

  it("**保存成功之后**：磁盘正文没有末尾换行、编辑器那份有 ⇒ 仍然算干净 ✓（原问题 ✓）", () => {
    const aligned = editorReducer(
      editorReducer(initialEditorState("n1"), { type: "load-ok", document: DISK }),
      { type: "editor-baseline", ingested: DISK.text, canonical: EDITOR },
    );
    /* 用户敲了一下 ⇒ 脏 ✓ */
    const typed = editorReducer(aligned, { type: "edit", text: `${EDITOR}新的一行` });
    assert.equal(isDirty(typed), true);

    /* 保存：提交的是编辑器那份（带末尾换行 ✓），宿主返回的是规范化后的（没有末行换行 ✓） */
    const saved = editorReducer(typed, {
      type: "save-ok",
      document: { ...DISK, text: `${DISK.text}\n新的一行`, hash: "h2", revision: 2 },
      submitted: `${EDITOR}新的一行`,
    });
    assert.equal(saved.draft, `${EDITOR}新的一行`, "草稿保持编辑器那份 ✓");
    assert.equal(saved.base, `${DISK.text}\n新的一行`, "磁盘基线是宿主规范化后的 ✓");
    assert.equal(isDirty(saved), false, "**保存成功就是干净** ✗（原来会差一个末尾换行 ⇒ 又冒星号 ✓）");

    /* 点叉号那一刻的判定：取到的编辑器正文与快照逐字相等 ⇒ **不弹"尚未保存"** ✓ */
    const liveAtClose = saved.draft;
    assert.equal(liveAtClose !== saved.snapshot, false, "关闭时不许再判定成「有未保存修改」✗");
  });

  it("真的改了内容 ⇒ 照样算脏 ✓（不许把差异一律当规范化 ✗）", () => {
    const aligned = editorReducer(
      editorReducer(initialEditorState("n1"), { type: "load-ok", document: DISK }),
      { type: "editor-baseline", ingested: DISK.text, canonical: EDITOR },
    );
    assert.equal(isDirty(editorReducer(aligned, { type: "edit", text: `${EDITOR}` })), false, "原样 ⇒ 干净 ✓");
    assert.equal(isDirty(editorReducer(aligned, { type: "edit", text: `${EDITOR}# 标题\n` })), true, "加了内容 ⇒ 脏 ✓");
    assert.equal(isDirty(editorReducer(aligned, { type: "edit", text: "第一段\n\n第二段" })), true, "改了行内内容 ⇒ 脏 ✓");
    /* 行首缩进 / 行内空格有语义 ⇒ 不能被"忽略空白"吞掉 ✗ */
    assert.equal(isDirty(editorReducer(aligned, { type: "edit", text: `${DISK.text}\n 缩进了一行` })), true);
  });

  it("编辑器基线只在**该采纳**的时候采纳 ✓（脏草稿 / 过期回报一律不动 ✗）", () => {
    const loaded = editorReducer(initialEditorState("n1"), { type: "load-ok", document: DISK });
    /* ① 用户已经改过 ⇒ 不许被编辑器的规范化覆盖 ✗ */
    const typed = editorReducer(loaded, { type: "edit", text: "用户写的内容" });
    assert.equal(editorReducer(typed, { type: "editor-baseline", ingested: DISK.text, canonical: EDITOR }).draft, "用户写的内容");
    /* ② 回报的 ingested 与当前草稿不一致（迟到的旧回报）⇒ 也不动 ✗ */
    const other = editorReducer(loaded, { type: "editor-baseline", ingested: "别的正文", canonical: "别的正文\n" });
    assert.equal(other.draft, DISK.text);
    assert.equal(other.snapshot, DISK.text);
  });

  it("缓存往返也要带着编辑器快照 ✓（否则重开又会被当成有修改 ✗）", () => {
    clearDraftCache();
    const key = draftKey("L", "n1");
    const DIskDoc = { ...DOC, text: "磁盘正文", hash: "h7", revision: 1 };
    const loaded = editorReducer(initialEditorState("n1"), { type: "load-ok", document: DIskDoc });
    const aligned = editorReducer(loaded, { type: "editor-baseline", ingested: DIskDoc.text, canonical: "磁盘正文\n" });
    const typed = editorReducer(aligned, { type: "edit", text: "磁盘正文\n新内容\n" });
    /* 组件的缓存 effect ✓ */
    rememberDraft(key, { draft: typed.draft, base: typed.base, hash: typed.hash, snapshot: typed.snapshot });

    /* 重开：恢复出来必须还是"脏"，但**不能被误判成冲突** ✓ */
    const record = recallDraft(key);
    let reopened = editorReducer(initialEditorState("n1"), {
      type: "restore-draft",
      draft: record.draft,
      base: record.base,
      hash: record.hash,
      snapshot: record.snapshot,
    });
    assert.equal(isDirty(reopened), true, "真的有未保存内容 ✓");
    reopened = editorReducer(reopened, { type: "load-ok", document: DIskDoc });
    assert.equal(reopened.conflicted, false, "磁盘没变（指纹一致）⇒ 继续编辑 ✓");
    assert.equal(reopened.draft, "磁盘正文\n新内容\n", "草稿保住 ✓");
  });
});

describe("逐行比较（只在用户主动比较时才用）", () => {
  it("完全一致 ⇒ 没有差异可标注 ✓", () => {
    const diff = diffLines("同一段\n第二段", "同一段\n第二段");
    assert.equal(diff.identical, true);
    assert.equal(diff.left.some((line) => line.changed), false);
    assert.equal(diff.right.some((line) => line.changed), false);
  });

  it("改一行 ⇒ 两侧那一行都标出来，未变的行不标 ✓", () => {
    const diff = diffLines("甲\n乙\n丙", "甲\n乙改了\n丙");
    assert.equal(diff.identical, false);
    assert.deepEqual(diff.left, [
      { text: "甲", changed: false },
      { text: "乙", changed: true },
      { text: "丙", changed: false },
    ]);
    assert.deepEqual(diff.right, [
      { text: "甲", changed: false },
      { text: "乙改了", changed: true },
      { text: "丙", changed: false },
    ]);
  });

  it("新增 / 删除行也能指出来 ✓", () => {
    const added = diffLines("甲\n乙", "甲\n新的一行\n乙");
    assert.equal(added.left.some((line) => line.text === "新的一行"), false);
    assert.deepEqual(added.right.find((line) => line.text === "新的一行"), { text: "新的一行", changed: true });
    assert.equal(added.left.every((line) => line.changed === false), true, "没动的那侧不该被标 ✗");
  });

  it("超大文档退化成「全部不同」，不把面板卡住 ✓", () => {
    const big = Array.from({ length: 2500 }, (_, i) => `行 ${i}`).join("\n");
    const diff = diffLines(big, `${big}\n尾巴`);
    assert.equal(diff.identical, false);
    assert.equal(diff.left.every((line) => line.changed), true);
  });
});
