/**
 * 「当前会话上下文」发布的测试（按会话归档）。
 *
 * 它承担的是"跨作用域传递权威信息"：面板（session 作用域，拿得到 sessionId）发布，
 * 划词浮条（root 作用域，拿不到）按 **DOM 读到的当前会话 id** 精确读取。
 * 判错的后果很直接——**普通工作区也弹浮条**，这是用户实际反馈过的问题，所以边界要钉住：
 * 未发布、别的会话读不到（不串会话）、已清除、陈旧。
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  __publishedSessionCountForTest,
  __resetCurrentContextForTest,
  clearCurrentContext,
  publishCurrentContext,
  readCurrentContext,
} from "../src/client/current-context.ts";

describe("当前上下文发布（按会话归档）", () => {
  beforeEach(() => {
    __resetCurrentContextForTest();
  });

  it("未发布时读到 null（浮条据此保守不显示）", () => {
    assert.equal(readCurrentContext("s1"), null);
  });

  it("按会话 id 精确读取；别的会话读不到（不串会话的关键）", () => {
    publishCurrentContext({ sessionId: "kb-session", workspacePath: "D:\\kb\\a", library: true }, 1000);
    const mine = readCurrentContext("kb-session", 1000);
    assert.equal(mine?.library, true);
    assert.equal(mine?.workspacePath, "D:\\kb\\a");
    assert.equal(mine?.sessionId, "kb-session");
    assert.equal(readCurrentContext("other-session", 1000), null, "别的会话必须读不到");
  });

  it("同一会话再次发布覆盖旧值（切工作区就是这条路）", () => {
    publishCurrentContext({ sessionId: "s1", workspacePath: "D:\\kb", library: true }, 1000);
    publishCurrentContext({ sessionId: "s1", workspacePath: "D:\\plain", library: false }, 2000);
    assert.equal(readCurrentContext("s1", 2000)?.library, false);
    assert.equal(readCurrentContext("s1", 2000)?.workspacePath, "D:\\plain");
  });

  it("拿不到 sessionId 时进匿名档，只在按 id 查不到时兜底（不回落，避免串会话）", () => {
    publishCurrentContext({ sessionId: null, workspacePath: "D:\\kb", library: true }, 500);
    assert.equal(readCurrentContext(null, 500)?.library, true, "匿名发布可被读");
    assert.equal(readCurrentContext("unknown", 500), null, "按 id 查不到不回落匿名");
  });

  it("非字符串/缺失字段被规整成安全值（不抛错）", () => {
    publishCurrentContext({ sessionId: "s9", workspacePath: undefined, library: false }, 10);
    const got = readCurrentContext("s9", 10);
    assert.equal(got?.workspacePath, "");
    assert.equal(got?.library, false);
  });

  it("按会话清除只影响那一个会话", () => {
    publishCurrentContext({ sessionId: "a", workspacePath: "D:\\kb", library: true }, 1);
    publishCurrentContext({ sessionId: "b", workspacePath: "D:\\kb", library: true }, 1);
    assert.equal(__publishedSessionCountForTest(), 2);
    clearCurrentContext("a");
    assert.equal(readCurrentContext("a", 1), null);
    assert.notEqual(readCurrentContext("b", 1), null, "b 不该被清掉");
  });

  it("全部清除（不传 id）连匿名一起清", () => {
    publishCurrentContext({ sessionId: "a", workspacePath: "D:\\kb", library: true }, 1);
    publishCurrentContext({ sessionId: null, workspacePath: "D:\\kb", library: true }, 1);
    clearCurrentContext();
    assert.equal(readCurrentContext("a", 1), null);
    assert.equal(readCurrentContext(null, 1), null);
  });

  it("陈旧判断：超过 maxAge 视为无效（面板可能已卸载/切走）", () => {
    publishCurrentContext({ sessionId: "s1", workspacePath: "D:\\kb", library: true }, 1000);
    assert.notEqual(readCurrentContext("s1", 1500, 1000), null, "界内仍有效");
    assert.equal(readCurrentContext("s1", 2500, 1000), null, "超时视为陈旧");
    assert.notEqual(readCurrentContext("s1", 99999999, 0), null, "maxAge<=0 表示不判陈旧");
  });
});
