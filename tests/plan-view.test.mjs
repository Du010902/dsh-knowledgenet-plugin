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

  it("**弹窗只有两个出口**（用户要求：不要「稍后再说」✗）：落地 / 取消这提案，两者都立即关弹窗 ✓", async () => {
    /* 落地：记一条短暂回执 + 立刻关弹窗 ✓ */
    assert.match(reviewSource, /setNote\(\{ text, at: Date\.now\(\) \}\);[\s\S]{0,400}setDialog\(false\);/, "落地成功要立刻关弹窗 ✓");
    /* 取消：关弹窗 + 记进"取消过"（持久 ✓）+ 请宿主删计划文件 ✓ */
    assert.match(reviewSource, /const discard = useCallback[\s\S]{0,400}setDialog\(false\)/, "取消要立刻关弹窗 ✓");
    assert.match(reviewSource, /dismissedPlans\.set\(id, props\.root \?\? ""\)/, "取消要立刻记下来（换会话/重启都不再弹 ✓）");
    assert.match(reviewSource, /kind: "discard-plan"/, "取消要请宿主把计划文件删掉 ✓");
    assert.ok(!/copy\.later/.test(reviewSource), "不许再有「稍后再说」✗");
    assert.ok(
      !/plan-dialog-reopen/.test(reviewSource) && !/copy\.reopen/.test(reviewSource),
      "不许再有「待审提案」小入口（那等于稍后再说 ✗）",
    );
  });

  it("取消过的**持久**记在组件外，并且宿主删成功后把本地记录也清掉 ✓", async () => {
    assert.match(reviewSource, /const dismissedPlans = new Map<string, string>\(readDismissedPlans\(\)/, "启动时读持久记录 ✓");
    assert.match(reviewSource, /forgetDismissedPlan\(id\)/, "宿主真删掉之后要忘掉本地记录 ✓");
    assert.match(reviewSource, /const retryDiscarded = useCallback/, "宿主当时删不掉的，下次拉列表时要补删 ✓");
    assert.match(reviewSource, /if \(pending\.length === 0\) return;\s*\n\s*setDialog\(true\)/, "待审就弹（待审 = 还没决定 ✓）");
  });

  it("Esc = 取消这提案；**Enter 不绑**（建节点必须是一次明确的点击 ✗）", async () => {
    assert.match(reviewSource, /event\.key !== "Escape"/, "Esc 要关掉弹窗 ✓");
    assert.match(reviewSource, /event\.stopImmediatePropagation\(\);\s*\n\s*discard\(\)/, "Esc 与「取消这提案」同一语义 ✓");
    assert.ok(!/dialogKeyboardIntent/.test(reviewSource), "不许复用「Enter 即确认」那套键盘意图 ✗");
  });

  it("落地回执**不许长期占着面板**：到点自己消失，也能立刻收起 ✓（用户实测：一直挂着 ✗）", async () => {
    assert.match(reviewSource, /const TRANSIENT_MS = \d+/, "要有明确的回执时长 ✓");
    assert.match(reviewSource, /now - entry\.at < TRANSIENT_MS/, "过期就不再渲染那张卡 ✓");
    assert.match(reviewSource, /const freshlyApplied = new Map/, "回执记在组件外（重挂面板不会又冒出来 ✗）");
    assert.ok(reviewSource.includes("kn-plan-dismiss"), "要有「立刻收起」的按钮 ✓");
    assert.ok(reviewSource.includes("void undo(plan);"), "落地后的撤销入口保留 ✓");
    assert.ok(
      !/const undoable = undoablePlans\(plans\)/.test(reviewSource),
      "不许再「列出所有已落地提案」——那会让回执永远挂在面板上 ✗",
    );
  });
});
