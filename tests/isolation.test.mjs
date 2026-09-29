/**
 * 「插件内容只在**有知识库的工作区**里可见」的测试（新模型）。
 *
 * 用户设计（本轮定稿）：
 * > 知识库 = 工作区里的 `<工作区>/.dsh_knowledge/`；任何工作区点「知识库图谱」首次打开就静默创建它。
 * > 没建过的工作区看不到插件提示词与 `kn_*` 工具；建过的才看得见。**不做兼容**：
 * > 工作区根目录里就算有 library.json 也不算知识库。
 *
 * 三层都测：位置解析（isolation.ts）、`apply()` 的真实行为（假 ctx 驱动）、
 * 以及"建库后重新裁决让已建会话立刻可见"（isolation-state）。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { __internal, apply } from "../index.js";
import { findLibraryRootSync } from "../src/host/isolation.ts";

const temps = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  __internal.__resetIsolationStatesForTest();
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "kn-isolation-"));
  temps.push(dir);
  return dir;
}

/** 造一个"已建知识库的工作区"：`<工作区>/.dsh_knowledge/library.json` */
async function workspaceWithLibrary() {
  const workspace = await tempDir();
  const library = join(workspace, ".dsh_knowledge");
  await mkdir(library, { recursive: true });
  await writeFile(join(library, "library.json"), "{}", "utf8");
  return { workspace, library };
}

describe("库根位置：只认 <工作区>/.dsh_knowledge", () => {
  it("建过库的工作区 → 可见；库根就是那个子目录", async () => {
    const { workspace, library } = await workspaceWithLibrary();
    assert.equal(__internal.isLibrarySession(workspace), true);
    assert.equal(findLibraryRootSync(workspace), library);
    // 工作区内的子目录（会话 cwd 可能是子目录）也要能向上找到
    const sub = join(workspace, "src", "deep");
    await mkdir(sub, { recursive: true });
    assert.equal(__internal.isLibrarySession(sub), true);
  });

  it("没建过库的工作区 → 不可见", async () => {
    const plain = await tempDir();
    assert.equal(__internal.isLibrarySession(plain), false);
  });

  it("**不做兼容**：工作区根目录里放着 library.json 也不算知识库", async () => {
    const plain = await tempDir();
    await writeFile(join(plain, "library.json"), "{}", "utf8");
    assert.equal(__internal.isLibrarySession(plain), false, "根目录的 library.json 不认");
  });

  it("空/未给 cwd → 不可见（默认隐藏，宁可少显示也不外泄）", () => {
    assert.equal(__internal.isLibrarySession(undefined), false);
    assert.equal(__internal.isLibrarySession(""), false);
  });

  it("探测面可注入（纯逻辑，不碰真实磁盘）", () => {
    const ws = resolve("/ws");
    const files = new Set([join(ws, ".dsh_knowledge", "library.json")]);
    const probe = { exists: (p) => files.has(p), isAbsolute: () => true };
    assert.equal(findLibraryRootSync(ws, probe), join(ws, ".dsh_knowledge"));
    assert.equal(__internal.isLibrarySession(ws, probe), true);
    assert.equal(__internal.isLibrarySession(resolve("/other"), probe), false);
  });
});

describe("apply()：按会话隐藏工具（行为验证）", () => {
  /** 造一个最小 ctx：收集注册的工具名、捕获事件监听器（同名可有多个） */
  function makeCtx() {
    const registered = [];
    const listeners = new Map();
    const ctx = {
      tools: { register: (def) => { registered.push(String(def?.name ?? "")); return () => {}; } },
      on: (name, listener) => {
        const list = listeners.get(name) ?? [];
        list.push(listener);
        listeners.set(name, list);
        return () => {};
      },
      get: () => undefined,
    };
    const fire = (name, payload) => {
      for (const listener of listeners.get(name) ?? []) listener(payload);
    };
    return { ctx, registered, fire };
  }

  /** 假 agent：会话 cwd + agent 作用域工具面（restrict 返回可撤销 disposer） */
  function makeAgent(cwd) {
    const applied = [];
    let lifted = 0;
    const agent = {
      session: { header: { cwd } },
      ctx: {
        tools: {
          restrict: (filter) => {
            applied.push(filter);
            return () => { lifted += 1; };
          },
        },
      },
    };
    return { agent, applied, liftedCount: () => lifted };
  }

  it("没建库的工作区：deny 覆盖全部已注册工具", async () => {
    const { ctx, registered, fire } = makeCtx();
    apply(ctx, {});
    assert.ok(registered.length > 0);
    const plain = await tempDir();
    const { agent, applied } = makeAgent(plain);
    fire("agent/created", { agent });
    assert.equal(applied.length, 1);
    assert.deepEqual([...applied[0].deny].sort(), [...registered].sort());
  });

  it("建过库的工作区：不限制", async () => {
    const { ctx, fire } = makeCtx();
    apply(ctx, {});
    const { workspace } = await workspaceWithLibrary();
    const { agent, applied } = makeAgent(workspace);
    fire("agent/created", { agent });
    assert.equal(applied.length, 0, "有知识库就不该限制");
  });

  it("**静默建库后**重新裁决：已建会话立刻变为可见（不必等下一个会话）", async () => {
    const { ctx, fire } = makeCtx();
    apply(ctx, {});
    const workspace = await tempDir();
    const { agent, applied, liftedCount } = makeAgent(workspace);

    // 首次打开面板之前：先按普通工作区隐藏
    fire("agent/created", { agent });
    assert.equal(applied.length, 1, "建库前先隐藏");

    // 面板静默创建了 `.dsh_knowledge`（等价于宿主建库后调用 reevaluateIsolation）
    await mkdir(join(workspace, ".dsh_knowledge"), { recursive: true });
    await writeFile(join(workspace, ".dsh_knowledge", "library.json"), "{}", "utf8");
    const outcome = __internal.reevaluateIsolation((cwd) => __internal.isLibrarySession(cwd));

    assert.equal(outcome.visible, 1, "建库后该会话应变为可见");
    assert.equal(liftedCount(), 1, "应调用了 restrict 的 disposer");
  });
});
