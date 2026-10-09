/**
 * 面板「提案审阅」纯逻辑的测试。
 *
 * 这里钉住的是**可控性本身**：默认不能全选（避免"点一下又建一堆"）、只有真的新建过才给撤销、
 * 落地结果要说清"新建了几个 / 复用几个 / 失败几条"。
 *
 * 注意：本文件是 `.mjs`，不能写 TypeScript 类型标注。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  APPLY_DEFAULT_LIMIT,
  defaultSelection,
  describeApply,
  formatPlanTime,
  mergeSelection,
  openPlans,
  pendingPlans,
  selectionLabel,
  undoablePlans,
} from "../src/client/plan-view.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const reviewSource = await readFile(path.join(HERE, "..", "src", "client", "PlanReview.tsx"), "utf8");
const dialogCssSource = await readFile(path.join(HERE, "..", "src", "client", "plan-dialog-css.ts"), "utf8");

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

describe("提案弹窗：只摆没被关掉过的提案", () => {
  it("关掉过的不再出现（否则用户取消之后它又自己弹回来 ✗）", () => {
    const list = [plan({ id: "a" }), plan({ id: "b" }), plan({ id: "c", applied: true })];
    assert.deepEqual(openPlans(list, []).map((item) => item.id), ["a", "b"]);
    assert.deepEqual(openPlans(list, ["a"]).map((item) => item.id), ["b"]);
    assert.deepEqual(openPlans(list, ["a", "b"]), []);
  });
});

describe("提案弹窗的接线（源码契约）", () => {
  it("**及时刷新**：自己按秒轮询 list-plans（agent 提交提案不会改图的 revision ✗）", async () => {
    assert.match(reviewSource, /const PLAN_POLL_MS = \d+/, "要有一个明确的轮询间隔 ✓");
    assert.match(reviewSource, /setInterval\(\(\) => setPollTick/, "轮询要真的触发重拉 ✓");
    assert.match(reviewSource, /\[reload, props\.reloadToken, pollTick\]/, "重拉的依赖里要有轮询滴答 ✓");
  });

  it("**弹窗悬浮在聊天上**：portal 到 body，且样式自己注入 head（面板的是 shadow 样式 ✗）", async () => {
    assert.ok(reviewSource.includes("createPortal(") && reviewSource.includes("document.body"), "要 portal 到 body ✓");
    assert.ok(reviewSource.includes("ensurePlanDialogStyle(document)"), "portal 的样式必须同模块注入 ✓");
    assert.ok(dialogCssSource.includes(".kn-pdialog-backdrop"), "遮罩样式要有定义 ✓");
    assert.ok(dialogCssSource.includes(".kn-pdialog {"), "弹窗本体样式要有定义 ✓");
  });

  it("**落地或取消之后立即消失**，且关掉过的不再自动弹回来", async () => {
    assert.match(reviewSource, /setDialog\(false\);[\s\S]{0,160}dismissPlans\(\[plan\.id\]\)/, "落地成功要立刻关弹窗并记下已处理 ✓");
    assert.match(reviewSource, /const dismiss = useCallback[\s\S]{0,240}setDialog\(false\)/, "取消要立刻关弹窗 ✓");
    assert.match(reviewSource, /autoOpenedPlans\.has\(plan\.id\)/, "每个提案只自动弹一次 ✓");
    assert.match(reviewSource, /setDialog\(true\)/, "新提案要自动弹出 ✓");
    assert.ok(
      /const dismissedPlans = new Set<string>\(\)/.test(reviewSource),
      "「关掉过」要记在**组件外**：面板重挂之后不许再弹回来 ✗",
    );
  });

  it("Esc = 取消；**Enter 不绑**（建节点必须是一次明确的点击 ✗）", async () => {
    assert.match(reviewSource, /event\.key !== "Escape"/, "Esc 要关掉弹窗 ✓");
    assert.ok(!/dialogKeyboardIntent/.test(reviewSource), "不许复用「Enter 即确认」那套键盘意图 ✗");
  });

  it("关掉的提案不丢：面板上留一个小入口可以再打开，撤销卡片也还在", async () => {
    assert.ok(reviewSource.includes("plan-dialog-reopen"), "要有「再打开」的入口 ✓");
    assert.ok(reviewSource.includes("copy.reopen.replace"), "入口文案带条数 ✓");
    assert.ok(reviewSource.includes("void undo(plan);"), "已落地的撤销入口保留在面板里 ✓");
  });
});
