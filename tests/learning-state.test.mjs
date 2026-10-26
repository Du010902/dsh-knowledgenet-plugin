/**
 * **界面聚焦**（`learning-state.ts`）与它那条"开着笔记却说没有当前节点"的修复 ✓。
 *
 * 用户实测 2026-10-11：右侧面板里明明开着「有包络的波包」的笔记，`kn_current_node` 却回
 * `no_reliable_focus` ✗；客户端诊断里躺着
 * `view-focus / rejected / focus_scope_mismatch` ✓ —— 宿主拿**裸字符串**比会话库与面板库，
 * 形状稍不一样就一律拒收 ✗ ⇒ 聚焦一条都存不下来 ✓。
 *
 * 这里钉住修复后的两层：
 * 1. `focus()` 精确查、(严格按会话+库 ✓) 与 `focusAny()` **会话内**回落（不看库根 ✓，跨会话仍隔离 ✗）；
 * 2. 宿主路由与工具那边的接线（两边各自解析后比 ✓、回落到视图自己的库去找节点 ✓）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { LearningState, libraryKey } from "../src/host/learning-state.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const apiSource = await readFile(path.join(HERE, "..", "src", "host", "api.ts"), "utf8");
const toolsSource = await readFile(path.join(HERE, "..", "src", "host", "model-tools.ts"), "utf8");

const SESSION = "session-aaaa";
const OTHER = "session-bbbb";
/** 同一个工作区的两种写法：工作区路径 vs 库根（就是这次拒收的来源之一 ✓） */
const WORKSPACE = "D:\\ws\\demo";
const LIBRARY = "D:\\ws\\demo\\.dsh_knowledge";

/** 记录一次视图上报 ✓ */
function view(state, { sessionId = SESSION, root = LIBRARY, viewId = "v1", sequence = 1, nodeId = "n1", active = true, claim = false, source = "editor" } = {}) {
  state.update({ sessionId, root, viewId, sequence, nodeId, active, source, claim });
}

describe("界面聚焦：精确查与会话内回落 ✓", () => {
  it("库根字面一致时，精确查就命中 ✓（原有行为不变 ✓）", () => {
    const state = new LearningState();
    view(state, { nodeId: "n-editor" });
    assert.deepEqual(state.focus(SESSION, LIBRARY), { nodeId: "n-editor", source: "editor" });
  });

  it("**库根写法不同**（工作区路径 / 大小写）时精确查查不到 ⇒ `focusAny` 顶上来 ✓（就是这次的 bug ✗）", () => {
    const state = new LearningState();
    view(state, { root: WORKSPACE, nodeId: "n-1" });
    assert.equal(state.focus(SESSION, LIBRARY), undefined, "字面不同 ⇒ 精确查本来就是空 ✓");
    assert.deepEqual(state.focusAny(SESSION), { nodeId: "n-1", root: libraryKey(WORKSPACE), source: "editor" });
    /* 大小写也归一 ✓ */
    const state2 = new LearningState();
    view(state2, { root: LIBRARY.toUpperCase() });
    assert.deepEqual(state2.focusAny(SESSION)?.nodeId, "n1");
  });

  it("`focusAny` 只在这个会话自己的视图里找 ✓（跨会话仍隔离 ✗）", () => {
    const state = new LearningState();
    view(state, { sessionId: OTHER, nodeId: "n-other" });
    assert.equal(state.focusAny(SESSION), undefined);
    assert.deepEqual(state.focusAny(OTHER)?.nodeId, "n-other");
  });

  it("取**最近活跃**的那个视图；`active: false` 的不算 ✓", () => {
    const state = new LearningState();
    view(state, { viewId: "v1", nodeId: "n-old", claim: true });
    view(state, { viewId: "v2", nodeId: "n-new", sequence: 2, claim: true });
    assert.deepEqual(state.focusAny(SESSION)?.nodeId, "n-new");
    /* 旧的被标记为不活跃之后，只剩新的 ✓ */
    view(state, { viewId: "v2", nodeId: "n-new", sequence: 3, active: false, claim: true });
    assert.deepEqual(state.focusAny(SESSION)?.nodeId, "n-old");
  });

  it("租约到期（prune）之后两边都查不到 ✓", () => {
    let now = 1_000;
    const state = new LearningState(5_000, () => now);
    view(state, { nodeId: "n1" });
    now += 4_000;
    assert.deepEqual(state.focusAny(SESSION)?.nodeId, "n1", "租约内有效 ✓");
    now += 2_000;
    assert.equal(state.focusAny(SESSION), undefined, "过期即忘 ✓");
  });
});

describe("接线：路由两边各自解析后再比 ✓、工具回落到视图自己的库 ✓", () => {
  it("view-focus 的归属校验不再拿裸字符串比 ✓", () => {
    assert.ok(/const claimed = claimedRoot === undefined/.test(apiSource), "要单独解析面板报的 root ✓");
    assert.ok(
      /resolveRequestedRoot\(ctx, config, \{ root: claimedRoot \}\)/.test(apiSource),
      "面板 root 要过一遍解析（工作区路径 ⇒ 库根 ✓）",
    );
    assert.ok(
      /libraryKey\(scope\.root\) !== libraryKey\(claimed\.root\)/.test(apiSource),
      "比较要发生在**解析之后** ✓（原来比裸字符串就是这次拒收的原因 ✗）",
    );
    assert.ok(/会话库 \$\{scope\.root\}，面板库 \$\{claimed\.root\}/.test(apiSource), "拒收要把两个路径写进 message ✓（下一轮一眼看出为什么 ✓）");
    /* 会话 cwd **解析不出来**时按面板报的库记 ✓（用户实测：就是这一条导致「开着笔记却说没有当前节点」✗） */
    assert.ok(
      /if \(!scope\.root\)[\s\S]{0,700}scope: "claimed"/.test(apiSource),
      "会话工作区未知 ⇒ 按面板报的库记 ✓（仍然只影响这个会话自己 ✓）",
    );
    assert.ok(
      !/无法确认面板库/.test(apiSource),
      "不许再拿「会话未知」当拒收理由 ✗（那条正是这次的 bug ✓）",
    );
    /* 面板没报 root 时，不许去问"配置里的库 / 上次用过的库" ✗ */
    assert.ok(
      /claimedRoot === undefined[\s\S]{0,200}\{ root: scope\.root, sessionUnknown: scope\.sessionUnknown, cwd: scope\.cwd \}/.test(apiSource),
      "没报 root ⇒ 按会话自己的库记 ✓",
    );
  });

  it("`kn_current_node` 精确查不到就用 `focusAny`，并用**那个视图的库根**去找节点 ✓", () => {
    assert.ok(toolsSource.includes("state.focusAny(sessionId)"), "要有会话内回落 ✓");
    assert.ok(toolsSource.includes("const uiRoot = exact ? root : ui?.root;"), "回落时要带视图自己的库根 ✓");
    assert.ok(
      /target\(\{ id: candidate\.id \}, exec, config, candidate\.root\)/.test(toolsSource),
      "按候选自带的 root 去找节点 ✓（否则会去错误的库找 ⇒ not_found ⇒ 又被当成没有焦点 ✗）",
    );
    assert.ok(toolsSource.includes("async function target(args: Record<string, unknown>, exec: unknown, config: KnowledgeNetConfig, rootOverride?: string)"), "`target` 要能接受指定库根 ✓");
  });
});

describe("入口线索：最新认领覆盖旧值 ✓", () => {
  const firstTurn = { snapshotEvents: () => [{ type: "turn/start" }] };

  it("同一会话先后从两个节点打开新对话 ⇒ 线索指向最新认领的节点 ✓", () => {
    const state = new LearningState();
    state.enter(SESSION, LIBRARY, "n-old");
    assert.equal(state.entry(SESSION, LIBRARY, firstTurn), "n-old", "第一次认领先生效 ✓");
    state.enter(SESSION, LIBRARY, "n-latest");
    assert.equal(state.entry(SESSION, LIBRARY, firstTurn), "n-latest", "旧行为第一个节点占住 ✗（用户实测 2026-10-25）");
    state.dispose();
  });

  it("重新认领会重置首轮计数：新认领的线索照常返回，不会立刻失效 ✓", () => {
    const state = new LearningState();
    state.enter(SESSION, LIBRARY, "n-1");
    assert.equal(state.entry(SESSION, LIBRARY, firstTurn), "n-1");
    /* 上一条线索已经记过 request=1；重新认领必须重开一轮 ✓，否则新线索会被当成第二轮请求删掉 ✗ */
    state.enter(SESSION, LIBRARY, "n-2");
    assert.equal(state.entry(SESSION, LIBRARY, firstTurn), "n-2", "覆盖后 request 重新计 ✓");
    state.dispose();
  });

  it("库根不同的线索不串用 ✓", () => {
    const state = new LearningState();
    state.enter(SESSION, LIBRARY, "n-in-lib");
    assert.equal(state.entry(SESSION, WORKSPACE, firstTurn), undefined, "线索只对认领时的库有效 ✓");
    state.dispose();
  });
});
