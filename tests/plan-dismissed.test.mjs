/**
 * 「用户取消过这份提案」的持久记录（`plan-dismissed.ts`）。
 *
 * 用户口径（2026-10-10）：提案弹窗只有两个出口 —— **添加节点** 或 **取消这提案**；
 * 取消就是把它丢掉 ⇒ 必须**立刻、且永久**不再出现（刷新页面 / 重启 DSH 也不行 ✗），
 * 同时请宿主删掉计划文件 ✓；宿主还没更新时先本地记住、下次补删 ✓。
 * 这里全部用假存储测（不碰真的 localStorage ✓）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  clearDismissedPlans,
  forgetDismissedPlan,
  markPlanDismissed,
  readDismissedPlans,
} from "../src/client/plan-dismissed.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const reviewSource = await readFile(path.join(HERE, "..", "src", "client", "PlanReview.tsx"), "utf8");

/** 假存储：一个 Map，行为与 localStorage 一致（缺键返回 null ✓） */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, value); },
  };
}

const KEY = "knowledgenet.plan-dismissed.v1";

describe("「取消过的提案」持久记忆", () => {
  it("记下 id 与库根，读得回来（重启后就靠它不再弹 ✓）", () => {
    const storage = fakeStorage();
    assert.deepEqual(readDismissedPlans(storage), [], "一开始什么都没有 ✓");
    markPlanDismissed({ id: "p1", root: "/lib" }, storage);
    assert.deepEqual(readDismissedPlans(storage), [{ id: "p1", root: "/lib" }]);
    assert.equal(storage.map.get(KEY), JSON.stringify([{ id: "p1", root: "/lib" }]), "约定的键 + JSON ✓");
  });

  it("同一份重复取消只留一条；空 id 不记 ✓", () => {
    const storage = fakeStorage();
    markPlanDismissed({ id: "p1", root: "/a" }, storage);
    markPlanDismissed({ id: "p1", root: "/b" }, storage);
    assert.deepEqual(readDismissedPlans(storage), [{ id: "p1", root: "/b" }], "后来者覆盖（根以最新为准 ✓）");
    markPlanDismissed({ id: "", root: "/a" }, storage);
    assert.equal(readDismissedPlans(storage).length, 1);
  });

  it("宿主真删掉之后可以忘掉这一条 ✓", () => {
    const storage = fakeStorage();
    markPlanDismissed({ id: "p1", root: "/a" }, storage);
    markPlanDismissed({ id: "p2", root: "/a" }, storage);
    forgetDismissedPlan("p1", storage);
    assert.deepEqual(readDismissedPlans(storage).map((entry) => entry.id), ["p2"]);
    clearDismissedPlans(storage);
    assert.deepEqual(readDismissedPlans(storage), []);
  });

  it("坏值 / 没有存储 ⇒ 安全读、安全写，绝不抛 ✓", () => {
    assert.deepEqual(readDismissedPlans(fakeStorage({ [KEY]: "not json" })), []);
    assert.deepEqual(readDismissedPlans(fakeStorage({ [KEY]: JSON.stringify({ a: 1 }) })), []);
    assert.deepEqual(
      readDismissedPlans(fakeStorage({ [KEY]: JSON.stringify([{ id: "ok", root: "/r" }, { id: 3 }, null, "x"]) })),
      [{ id: "ok", root: "/r" }],
    );
    assert.deepEqual(readDismissedPlans(null), []);
    markPlanDismissed({ id: "p1", root: "/a" }, null);
    forgetDismissedPlan("p1", null);
    clearDismissedPlans(null);
    const throwing = { getItem: () => { throw new Error("quota"); }, setItem: () => { throw new Error("quota"); } };
    assert.deepEqual(readDismissedPlans(throwing), []);
    markPlanDismissed({ id: "p1", root: "/a" }, throwing);
  });

  it("接线：取消 = 立刻记下 + 请宿主删 + 删成功后忘掉 + 拉列表时补删 ✓", () => {
    assert.match(reviewSource, /const dismissedPlans = new Map<string, string>\(readDismissedPlans\(\)/, "启动时读持久记录 ✓");
    assert.match(reviewSource, /markPlanDismissed/, "取消时要写持久记录 ✓");
    assert.match(reviewSource, /forgetDismissedPlan\(id\)/, "宿主删成功之后要忘掉本地记录 ✓");
    assert.match(reviewSource, /const retryDiscarded = useCallback/, "要能补删（宿主半是启动时加载的 ✓）");
    assert.match(reviewSource, /if \(!present\.has\(id\)\) continue;/, "只对还在列表里的补删（省得每轮都问 ✓）");
  });
});
