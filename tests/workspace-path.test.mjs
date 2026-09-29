/**
 * 工作区路径识别 + 按路径探针的测试。
 *
 * 为什么这两个必须测：入口卡片的可见性全靠它们。识别失败只会表现成「卡片不出现」，
 * 而**看不见的失败最难查**——所以把几种可能的快照形状都钉住。
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { clearWorkspaceCache, peekPathKind, probeWorkspacePath } from "../src/client/library-probe.ts";
import { pickSessionPath, pickWorkspacePath, resolvePanelTarget } from "../src/client/workspace-path.ts";

describe("面板绑定目标", () => {
  it("**工作区优先**（面板跟随当前工作区，不被标签页里的旧 root 绑住）", () => {
    assert.deepEqual(
      resolvePanelTarget({ overrideRoot: "D:\\picked", workspacePath: "D:\\ws", sessionId: "s" }),
      { kind: "root", value: "D:\\ws" },
    );
  });

  it("没有工作区时才退到会话 id", () => {
    assert.deepEqual(
      resolvePanelTarget({ overrideRoot: "D:\\picked", sessionId: "s" }),
      { kind: "session", value: "s" },
    );
  });

  it("没有会话时才用标签页里的 root", () => {
    assert.deepEqual(
      resolvePanelTarget({ overrideRoot: "D:\\picked" }),
      { kind: "root", value: "D:\\picked" },
    );
  });

  it("有工作区、没有会话时跟随工作区路径", () => {
    assert.deepEqual(
      resolvePanelTarget({ workspacePath: "D:\\ws" }),
      { kind: "root", value: "D:\\ws" },
    );
  });

  it("工作区快照认不出来时退到会话 id", () => {
    assert.deepEqual(resolvePanelTarget({ sessionId: "s-9" }), { kind: "session", value: "s-9" });
  });

  it("三者都没有 → undefined（面板显示「跟随当前工作区」的提示）", () => {
    assert.equal(resolvePanelTarget({}), undefined);
    assert.equal(resolvePanelTarget({ overrideRoot: "  ", workspacePath: "", sessionId: " " }), undefined);
  });
});

describe("工作区路径识别", () => {
  it("快照里 selected 标记的那条优先", () => {
    const snapshot = {
      workspaces: [
        { id: "a", path: "D:\\lib\\a", sessionIds: [] },
        { id: "b", path: "D:\\lib\\b", selected: true, sessionIds: [] },
      ],
    };
    assert.equal(pickWorkspacePath(snapshot), "D:\\lib\\b");
  });

  it("按 sessionId 命中 sessionIds 里的那条（比 selected 更准）", () => {
    const snapshot = {
      workspaces: [
        { id: "a", path: "D:\\lib\\a", selected: true, sessionIds: [] },
        { id: "b", path: "D:\\lib\\b", sessionIds: ["s-1"] },
      ],
    };
    assert.equal(pickWorkspacePath(snapshot, "s-1"), "D:\\lib\\b");
  });

  it("快照只有一条工作区时直接用它", () => {
    assert.equal(pickWorkspacePath({ entries: [{ path: "D:\\only" }] }), "D:\\only");
  });

  it("用 selectedId 指针找对应记录", () => {
    const snapshot = {
      selectedId: "w2",
      items: [
        { workspaceId: "w1", root: "D:\\one" },
        { workspaceId: "w2", root: "D:\\two" },
      ],
    };
    assert.equal(pickWorkspacePath(snapshot), "D:\\two");
  });

  it("认不出来就返回 undefined（调用方退回会话判据，而不是猜）", () => {
    assert.equal(pickWorkspacePath(undefined), undefined);
    assert.equal(pickWorkspacePath({}), undefined);
    assert.equal(pickWorkspacePath({ items: [{ id: "x" }, { id: "y" }] }), undefined);
    assert.equal(pickWorkspacePath("不是对象"), undefined);
  });

  it("会话快照的 cwd 形态", () => {
    assert.equal(pickSessionPath({ header: { cwd: "D:\\ws" } }), "D:\\ws");
    assert.equal(pickSessionPath({ cwd: "D:\\ws" }), "D:\\ws");
    assert.equal(pickSessionPath({ workspacePath: "D:\\ws" }), "D:\\ws");
    assert.equal(pickSessionPath({ workspace: { path: "D:\\ws" } }), "D:\\ws");
    assert.equal(pickSessionPath({}), undefined);
  });
});

describe("按路径探针", () => {
  beforeEach(() => { clearWorkspaceCache(); });

  it("宿主答 ok → library 并按路径缓存", async () => {
    const calls = [];
    const fake = async (url) => { calls.push(url); return { text: async () => JSON.stringify({ ok: true }) }; };
    assert.equal(await probeWorkspacePath("D:\\DataByUsing\\知识库测试\\导航仿真", fake), "library");
    assert.equal(peekPathKind("D:\\DataByUsing\\知识库测试\\导航仿真\\"), "library", "尾部分隔符不影响缓存键");
    assert.equal(await probeWorkspacePath("D:\\DataByUsing\\知识库测试\\导航仿真", fake), "library");
    assert.equal(calls.length, 1);
    assert.match(decodeURIComponent(calls[0]), /root=D:\\DataByUsing\\知识库测试\\导航仿真$/);
  });

  it("宿主答 ok:false → other（不是知识库，缓存起来不再问）", async () => {
    let calls = 0;
    const fake = async () => { calls += 1; return { text: async () => JSON.stringify({ ok: false, error: { code: "library_unavailable" } }) }; };
    assert.equal(await probeWorkspacePath("D:\\资料\\file_useless\\test\\KnowledgeNet", fake), "other");
    assert.equal(await probeWorkspacePath("D:\\资料\\file_useless\\test\\KnowledgeNet", fake), "other");
    assert.equal(calls, 1);
  });

  it("空路径不请求", async () => {
    let calls = 0;
    const fake = async () => { calls += 1; return { text: async () => "{}" }; };
    assert.equal(await probeWorkspacePath("   ", fake), "unknown");
    assert.equal(calls, 0);
  });
});
