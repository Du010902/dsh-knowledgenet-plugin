/**
 * 面板「提案审阅」纯逻辑的测试。
 *
 * 这里钉住的是**可控性本身**：默认不能全选（避免"点一下又建一堆"）、只有真的新建过才给撤销、
 * 落地结果要说清"新建了几个 / 复用几个 / 失败几条"。
 *
 * 注意：本文件是 `.mjs`，不能写 TypeScript 类型标注。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPLY_DEFAULT_LIMIT,
  defaultSelection,
  describeApply,
  formatPlanTime,
  mergeSelection,
  pendingPlans,
  selectionLabel,
  undoablePlans,
} from "../src/client/plan-view.ts";

const plan = (over) => ({
  id: "p1",
  createdAt: 1_700_000_000_000,
  summary: "",
  itemCount: 3,
  applied: false,
  createdCount: 0,
  items: [
    { id: "i1", fromId: "a", title: "B", reuse: false },
    { id: "i2", fromId: "a", title: "C", reuse: true },
    { id: "i3", fromId: "a", title: "D", reuse: false },
  ],
  ...over,
});

describe("哪些提案要摆到用户面前", () => {
  it("未落地的 → 待审；已落地的 → 不待审", () => {
    const list = [plan({ id: "a" }), plan({ id: "b", applied: true }), plan({ id: "c" })];
    assert.deepEqual(pendingPlans(list).map((item) => item.id), ["a", "c"]);
  });

  it("空提案（0 条）不算待审（没什么可确认的）", () => {
    assert.deepEqual(pendingPlans([plan({ itemCount: 0, items: [] })]), []);
  });

  it("只有'已落地且新建过节点'的才可撤销（纯复用没东西可撤）", () => {
    const list = [
      plan({ id: "new", applied: true, createdCount: 2 }),
      plan({ id: "reuse-only", applied: true, createdCount: 0 }),
      plan({ id: "pending" }),
    ];
    assert.deepEqual(undoablePlans(list).map((item) => item.id), ["new"]);
  });
});

describe("默认勾选（可控性关键）", () => {
  it("默认**不全选**：最多前 10 条", () => {
    const many = plan({
      itemCount: 30,
      items: Array.from({ length: 30 }, (_v, index) => ({ id: `i${index}`, fromId: "a", title: `T${index}`, reuse: false })),
    });
    const picked = defaultSelection(many);
    assert.equal(picked.length, APPLY_DEFAULT_LIMIT);
    assert.equal(picked[0], "i0");
    assert.ok(!picked.includes("i29"), "后面的默认不勾");
  });

  it("不超过上限时全勾", () => {
    assert.deepEqual(defaultSelection(plan({})), ["i1", "i2", "i3"]);
  });
});

describe("刷新不丢勾选（用户报的「点了选不上」就是这条）", () => {
  it("已有的勾选原样保留；第一次见到的提案才套默认", () => {
    const first = plan({ id: "p1", items: Array.from({ length: 15 }, (_v, i) => ({ id: `i${i}`, fromId: "a", title: `T${i}`, reuse: false })) });
    const seen = mergeSelection({}, [first]);
    assert.equal(seen.p1.length, APPLY_DEFAULT_LIMIT, "首次套默认前 N 条");
    // 用户手动又勾了第 11、12 条
    const userPicked = [...seen.p1, "i10", "i11"];
    const afterReload = mergeSelection({ p1: userPicked }, [first]);
    assert.deepEqual(afterReload.p1, userPicked, "刷新后必须保留用户的勾选");
    // 新出现的提案仍拿默认
    const other = plan({ id: "p2" });
    const mixed = mergeSelection({ p1: userPicked }, [first, other]);
    assert.deepEqual(mixed.p1, userPicked);
    assert.equal(mixed.p2.length, 3, "新提案套默认");
  });
});

describe("按钮文案与结果说明", () => {
  it("一条没勾 → 空串（调用方据此禁用）；部分/全部各有说法", () => {
    assert.equal(selectionLabel(0, 3), "");
    assert.equal(selectionLabel(2, 3), "创建选中的 2 条");
    assert.equal(selectionLabel(3, 3), "创建全部 3 条");
  });

  it("落地结果说清 新建/复用/失败", () => {
    assert.equal(describeApply({ created: [{}, {}], reused: [{}] }), "新建 2 个 · 复用 1 个");
    assert.equal(describeApply({ created: [{}], failed: [{ message: "x" }] }), "新建 1 个 · 失败 1 条");
    assert.equal(describeApply({ created: [], reused: [] }), "没有变化");
    assert.equal(describeApply({}), "没有变化");
  });

  it("时间格式化稳定（本地时间、零填充）", () => {
    const text = formatPlanTime(1_700_000_000_000);
    assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
