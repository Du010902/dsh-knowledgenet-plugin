/**
 * 「这个会话的工作区是知识库吗」探针的行为测试。
 *
 * 这条探针决定右侧栏入口卡片出不出来，所以三种结果都必须准确：
 * library（画卡片）/ other（不画）/ unknown（路由还没就绪，**不缓存**，下次再问）。
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { clearWorkspaceCache, peekWorkspaceKind, probeWorkspace } from "../src/client/library-probe.ts";

const jsonResponse = (body) => ({ text: async () => JSON.stringify(body) });
const textResponse = (text) => ({ text: async () => text });

describe("工作区探针", () => {
  beforeEach(() => { clearWorkspaceCache(); });

  it("宿主答 ok:true → library，并记住结论", async () => {
    const calls = [];
    const fake = async (url) => { calls.push(url); return jsonResponse({ ok: true, counts: { nodes: 8 } }); };
    assert.equal(await probeWorkspace("s1", fake), "library");
    assert.equal(peekWorkspaceKind("s1"), "library");
    // 第二次不再打后端
    assert.equal(await probeWorkspace("s1", fake), "library");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /sessionId=s1$/);
  });

  it("宿主答 ok:false → other（工作区不是知识库，卡片不出现）", async () => {
    const fake = async () => jsonResponse({ ok: false, error: { code: "library_unavailable" } });
    assert.equal(await probeWorkspace("s2", fake), "other");
    assert.equal(peekWorkspaceKind("s2"), "other");
  });

  it("宿主答 session_unknown（还不知道会话工作区）→ unknown，且不缓存", async () => {
    let calls = 0;
    const fake = async () => { calls += 1; return jsonResponse({ ok: false, error: { code: "session_unknown" } }); };
    assert.equal(await probeWorkspace("s2b", fake), "unknown");
    assert.equal(peekWorkspaceKind("s2b"), "unknown");
    assert.equal(await probeWorkspace("s2b", fake), "unknown");
    assert.equal(calls, 2, "「暂时问不到」不能当结论缓存，否则新会话永远看不到入口");
  });

  it("路由未就绪（纯文本 not found）→ unknown，且**不缓存**（下次重问）", async () => {
    let calls = 0;
    const fake = async () => { calls += 1; return textResponse("not found"); };
    assert.equal(await probeWorkspace("s3", fake), "unknown");
    assert.equal(peekWorkspaceKind("s3"), "unknown");
    assert.equal(await probeWorkspace("s3", fake), "unknown");
    assert.equal(calls, 2, "unknown 不该被缓存：宿主重启后应能自己恢复");
  });

  it("请求抛错也不崩，只算 unknown", async () => {
    const fake = async () => { throw new Error("offline"); };
    assert.equal(await probeWorkspace("s4", fake), "unknown");
  });

  it("没有 sessionId 时不问后端（宁可不知道，也不要拿别的库当答案）", async () => {
    let calls = 0;
    const fake = async () => { calls += 1; return jsonResponse({ ok: true }); };
    assert.equal(await probeWorkspace(undefined, fake), "unknown");
    assert.equal(await probeWorkspace("", fake), "unknown");
    assert.equal(calls, 0);
  });

  it("并发问同一个会话只发一次请求", async () => {
    let calls = 0;
    const fake = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return jsonResponse({ ok: true }); };
    const [a, b] = await Promise.all([probeWorkspace("s5", fake), probeWorkspace("s5", fake)]);
    assert.equal(a, "library");
    assert.equal(b, "library");
    assert.equal(calls, 1);
  });
});
