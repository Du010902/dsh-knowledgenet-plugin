/**
 * 诊断上报的**串行**约束。
 *
 * 为什么值得单独测：实测里 `confirm-clicked` 这条诊断刚发出去，紧接着的
 * `create-library` **写请求**就失败了（而单独发的诊断都成功）——页面的 `api/` 请求走桌面端
 * IPC 桥，两条 POST 同时在飞会被丢掉一条。所以诊断必须排队串行发送。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { __resetDiagQueueForTest, reportDiag } from "../src/client/diag.ts";

describe("诊断上报", () => {
  it("并发上报会被串行化（不抢占同一条通道）", async () => {
    __resetDiagQueueForTest();
    let inFlight = 0;
    let maxInFlight = 0;
    const order = [];
    const fake = async (url, init) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(JSON.parse(init.body).outcome);
      await new Promise((resolve) => { setTimeout(resolve, 15); });
      inFlight -= 1;
      return { ok: true };
    };
    const results = await Promise.all([
      reportDiag("add-library", "first", null, fake),
      reportDiag("add-library", "second", null, fake),
      reportDiag("add-library", "third", null, fake),
    ]);
    assert.deepEqual(results, [true, true, true]);
    assert.deepEqual(order, ["first", "second", "third"], "按调用顺序发出");
    assert.equal(maxInFlight, 1, "同一时刻只允许一条在飞");
  });

  it("单条失败不影响后续（队列继续）", async () => {
    __resetDiagQueueForTest();
    const outcomes = [];
    const fake = async (url, init) => {
      const outcome = JSON.parse(init.body).outcome;
      outcomes.push(outcome);
      if (outcome === "boom") throw new Error("offline");
      return { ok: true };
    };
    assert.equal(await reportDiag("x", "boom", null, fake), false);
    assert.equal(await reportDiag("x", "after", null, fake), true);
    assert.deepEqual(outcomes, ["boom", "after"]);
  });
});
