/**
 * 「提案 → 审阅 → 落地」里**纯逻辑**部分的测试。
 *
 * 这一层要防住的正是实际发生的问题：用户只说"搜索相关知识点"，模型却一次建了大量节点。
 * 所以钉住三件事：提案条目会被规范化/去重/限量；**只有用户勾选的条目才会被落地**；
 * 已落地/空提案被拒绝。另外钉住"新建节点配额"（超了必须拒绝）。
 *
 * 注意：本文件是 `.mjs`，不能写 TypeScript 类型标注。
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach } from "node:test";

import {
  MAX_PLAN_ITEMS,
  PLANS_DIR,
  listPlans,
  newPlanId,
  normalizePlanItems,
  planRelPath,
  readPlan,
  savePlan,
  selectPlanItems,
} from "../src/host/plans.ts";
import {
  CREATION_QUOTA,
  __resetCreationQuotaForTest,
  takeCreationQuota,
} from "../src/host/creation-quota.ts";

const plan = (items, extra = {}) => ({
  id: "p1",
  createdAt: 1,
  items,
  ...extra,
});

describe("提案条目的规范化", () => {
  it("丢掉缺 fromId/title 的条目，并按 归属+标题 去重", () => {
    const items = normalizePlanItems([
      { fromId: "a", title: "B" },
      { fromId: "a", title: "B" }, // 重复
      { fromId: "a", title: "   " }, // 无标题
      { fromId: "", title: "C" }, // 无归属
      { fromId: "a", title: " C " },
    ]);
    assert.deepEqual(items.map((item) => `${item.fromId}:${item.title}`), ["a:B", "a:C"]);
    assert.deepEqual(items.map((item) => item.id), ["i1", "i2"]);
  });

  it("有条数上限（再多就不是提案了）", () => {
    const many = Array.from({ length: MAX_PLAN_ITEMS + 10 }, (_v, index) => ({ fromId: "a", title: `T${index}` }));
    assert.equal(normalizePlanItems(many).length, MAX_PLAN_ITEMS);
  });

  it("保留 description / snippet / existingNodeId", () => {
    const [item] = normalizePlanItems([
      { fromId: "a", title: "B", description: "因为…", snippet: "原文", existingNodeId: "n9" },
    ]);
    assert.equal(item.description, "因为…");
    assert.equal(item.snippet, "原文");
    assert.equal(item.existingNodeId, "n9");
  });
});

describe("哪些条目会被落地（可控性的核心）", () => {
  it("不传勾选 = 全部；传了勾选 = 只落地勾选的", () => {
    const p = plan([
      { id: "i1", fromId: "a", title: "B" },
      { id: "i2", fromId: "a", title: "C" },
      { id: "i3", fromId: "a", title: "D" },
    ]);
    const all = selectPlanItems(p);
    assert.equal(all.ok, true);
    assert.equal(all.items.length, 3);
    const picked = selectPlanItems(p, ["i2"]);
    assert.deepEqual(picked.items.map((item) => item.id), ["i2"]);
  });

  it("一条都没勾 → 拒绝（不能变成'全部落地'）", () => {
    const p = plan([{ id: "i1", fromId: "a", title: "B" }]);
    const result = selectPlanItems(p, []);
    assert.equal(result.ok, false);
    assert.equal(result.code, "nothing_selected");
  });

  it("空提案 / 已落地的提案 → 拒绝", () => {
    assert.equal(selectPlanItems(plan([])).code, "empty_plan");
    const done = plan([{ id: "i1", fromId: "a", title: "B" }], { applied: { at: 2, created: [], reused: [], failed: [] } });
    assert.equal(selectPlanItems(done).code, "already_applied");
  });
});

describe("提案落盘", () => {
  it("保存后可读回；文件在 <库>/.knowledgenet/plans/", async () => {
    const root = await mkdtemp(join(tmpdir(), "kn-plans-"));
    const p = plan([{ id: "i1", fromId: "a", title: "B" }], { summary: "补三个前置" });
    await savePlan(root, p);
    const files = await readdir(join(root, PLANS_DIR));
    assert.deepEqual(files, ["p1.json"]);
    const back = await readPlan(root, "p1");
    assert.equal(back.summary, "补三个前置");
    assert.equal(back.items[0].title, "B");
    await savePlan(root, { ...p, summary: "改过" });
    assert.equal((await readPlan(root, "p1")).summary, "改过", "重复保存应覆盖");
    const text = await readFile(join(root, planRelPath("p1")), "utf8");
    assert.match(text, /改过/);
  });

  it("读不存在的/空的 id → null（不抛错）", async () => {
    const root = await mkdtemp(join(tmpdir(), "kn-plans-"));
    assert.equal(await readPlan(root, "没有"), null);
    assert.equal(await readPlan(root, ""), null);
    assert.deepEqual(await listPlans(root), []);
  });

  it("listPlans 按新到旧排序", async () => {
    const root = await mkdtemp(join(tmpdir(), "kn-plans-"));
    await savePlan(root, { id: "old", createdAt: 1, items: [{ id: "i1", fromId: "a", title: "B" }] });
    await savePlan(root, { id: "new", createdAt: 5, items: [{ id: "i1", fromId: "a", title: "B" }] });
    assert.deepEqual((await listPlans(root)).map((item) => item.id), ["new", "old"]);
  });

  it("计划 id 可读且不重复", () => {
    const a = newPlanId(new Date("2025-01-02T03:04:05Z"), () => 0.5);
    const b = newPlanId(new Date("2025-01-02T03:04:05Z"), () => 0.25);
    assert.match(a, /^20250102\d{6}-[0-9a-f]{6}$/);
    assert.notEqual(a, b);
  });
});

describe("新建节点配额（超了就拒绝，逼模型走提案）", () => {
  beforeEach(() => {
    __resetCreationQuotaForTest();
  });

  it("窗口内前 N 次放行，第 N+1 次拒绝并回报已用量", () => {
    const now = 1_000_000;
    for (let index = 0; index < CREATION_QUOTA; index += 1) {
      const verdict = takeCreationQuota("s1", now + index);
      assert.equal(verdict.ok, true, `第 ${index + 1} 次应放行`);
    }
    const denied = takeCreationQuota("s1", now + 10);
    assert.equal(denied.ok, false);
    assert.equal(denied.used, CREATION_QUOTA);
  });

  it("窗口滑过之后配额恢复；不同会话互不影响", () => {
    const now = 2_000_000;
    for (let index = 0; index < CREATION_QUOTA; index += 1) takeCreationQuota("s1", now);
    assert.equal(takeCreationQuota("s1", now).ok, false);
    assert.equal(takeCreationQuota("s2", now).ok, true, "另一个会话有自己的配额");
    // 11 分钟后窗口滑出
    assert.equal(takeCreationQuota("s1", now + 11 * 60 * 1000).ok, true);
  });
});
