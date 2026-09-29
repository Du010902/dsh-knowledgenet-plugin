/**
 * 「对话里划词 → 添加前置」纯逻辑的测试。
 *
 * 这些是**用户看得见的行为**，出错很隐蔽（重复条目、标题离谱、推荐错人），所以单独钉住：
 * 归一化、去重、多选上限、默认标题、推荐顺序与去重、MRU 头插。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendSnippet,
  defaultTitle,
  draftPrereqs,
  joinSnippets,
  keepKnownTargets,
  MAX_SNIPPETS,
  normalizeSnippet,
  recommendTargets,
  rememberId,
  MRU_LIMIT,
  TITLE_CHARS,
} from "../src/client/chat-selection.ts";

describe("片段归一化", () => {
  it("折叠空白、去掉列表符号、合并成一行", () => {
    assert.equal(normalizeSnippet("  - 第一行\n* 第二行\n  1. 第三行 "), "第一行 第二行 第三行");
    assert.equal(normalizeSnippet("多   空格\t制"), "多 空格 制");
  });

  it("空/非字符串 → 空串（不抛错）", () => {
    for (const value of [null, undefined, "", "   \n  "]) {
      assert.equal(normalizeSnippet(value), "");
    }
  });

  it("超长会被截断（evidence 不塞爆）", () => {
    const long = "字".repeat(2000);
    assert.ok(normalizeSnippet(long).length <= 600);
  });
});

describe("多选收集", () => {
  it("同一句划两次只算一条；顺序保持", () => {
    let list = appendSnippet([], "第一条");
    list = appendSnippet(list, "第二条");
    list = appendSnippet(list, " 第一条 ");
    assert.deepEqual(list.map((x) => x.text), ["第一条", "第二条"]);
  });

  it("有上限，超出后不再增长", () => {
    let list = [];
    for (let i = 0; i < MAX_SNIPPETS + 5; i += 1) list = appendSnippet(list, `片段${i}`);
    assert.equal(list.length, MAX_SNIPPETS);
  });

  it("空片段不入列表", () => {
    assert.deepEqual(appendSnippet([], "   "), []);
  });

  it("合成一段时用空行分隔", () => {
    const joined = joinSnippets([{ text: "A" }, { text: "B" }]);
    assert.equal(joined, "A\n\nB");
  });
});

describe("默认标题", () => {
  it("遇到句读就停（不把整句当标题）", () => {
    assert.equal(defaultTitle("信噪比，是信号与噪声的比值，常用于衡量链路质量。"), "信噪比");
  });

  it("没有句读时截断到固定字数", () => {
    const text = "这是一个非常长的概念名称它没有句读所以要被截断到一个合理的长度才行";
    assert.equal(defaultTitle(text).length, TITLE_CHARS);
  });

  it("空输入 → 空标题", () => {
    assert.equal(defaultTitle("  "), "");
  });
});

describe("目标节点推荐", () => {
  it("顺序：当前 → 最近加过前置的 → 最近聚焦的；去重、取前 3", () => {
    const out = recommendTargets({
      current: "now",
      recentPrereqTargets: ["p1", "p2", "now"],
      recentFocus: ["f1", "p1", "f2"],
    });
    assert.deepEqual(out, ["now", "p1", "p2"]);
  });

  it("没有当前节点时也能给推荐；空记忆给空列表", () => {
    assert.deepEqual(recommendTargets({ recentFocus: ["f1"] }), ["f1"]);
    assert.deepEqual(recommendTargets({}), []);
  });

  it("非法值被忽略（脏 localStorage 不炸）", () => {
    const out = recommendTargets({ current: "  ", recentFocus: ["", "ok"] });
    assert.deepEqual(out, ["ok"]);
  });
});

describe("多行 → 每条各自的标题（回归：曾把所有行建成同一个节点）", () => {
  it("多行时每行用自己的默认标题", () => {
    const drafts = draftPrereqs(["注意力机制", "自注意力，一种把序列内部关联起来的机制", "   "]);
    assert.deepEqual(drafts.map((d) => d.text), ["注意力机制", "自注意力，一种把序列内部关联起来的机制"]);
    assert.deepEqual(drafts.map((d) => d.title), ["注意力机制", "自注意力"]);
  });

  it("多行时**忽略**那个共用的标题输入框（用它就是旧的静默丢行 bug）", () => {
    const drafts = draftPrereqs(["甲概念", "乙概念"], "同一个标题");
    assert.deepEqual(drafts.map((d) => d.title), ["甲概念", "乙概念"]);
  });

  it("单行才用用户改过的标题；空标题回落到默认标题", () => {
    assert.deepEqual(draftPrereqs(["信噪比，是信号与噪声的比值"], "SNR").map((d) => d.title), ["SNR"]);
    assert.deepEqual(draftPrereqs(["信噪比，是信号与噪声的比值"], "   ").map((d) => d.title), ["信噪比"]);
    assert.deepEqual(draftPrereqs(["信噪比，是信号与噪声的比值"], null).map((d) => d.title), ["信噪比"]);
  });

  it("重复行只算一条；超过上限就截断", () => {
    assert.deepEqual(draftPrereqs(["甲", " 甲 ", "乙"]).map((d) => d.text), ["甲", "乙"]);
    const many = draftPrereqs(Array.from({ length: MAX_SNIPPETS + 3 }, (_, i) => `概念${i}`));
    assert.equal(many.length, MAX_SNIPPETS);
  });

  it("空输入 → 空队列（调用方据此不发请求）", () => {
    assert.deepEqual(draftPrereqs(["", "   ", "\n"]), []);
  });
});

describe("推荐只显示当前库确实存在的节点（回归：推荐里冒出别的库的节点）", () => {
  it("还不知道当前库有哪些节点（null）→ 一个都不显示", () => {
    assert.deepEqual(keepKnownTargets(["a", "b"], null), []);
    assert.deepEqual(keepKnownTargets(["a", "b"], undefined), []);
  });

  it("把别的库残留的 id 全部滤掉，只留本库存在的", () => {
    const known = { n1: "注意力机制", n2: "信噪比" };
    assert.deepEqual(keepKnownTargets(["n9", "n1", "n8", "n2"], known), ["n1", "n2"]);
  });

  it("顺序保持（当前 → 最近加过前置的 → 最近聚焦的），最多 3 个", () => {
    const known = { a: "甲", b: "乙", c: "丙", d: "丁" };
    assert.deepEqual(keepKnownTargets(["a", "b", "c", "d"], known), ["a", "b", "c"]);
    assert.deepEqual(keepKnownTargets(["a", "b"], known, 5), ["a", "b"]);
  });

  it("空表 / 重复 id 都不算数", () => {
    assert.deepEqual(keepKnownTargets(["a", "a"], {}), []);
    assert.deepEqual(keepKnownTargets(["a", "a", "b"], { a: "甲", b: "乙" }), ["a", "b"]);
  });

  it("原型链上的键不算「存在」（脏 id 不炸）", () => {
    assert.deepEqual(keepKnownTargets(["toString", "__proto__"], { a: "甲" }), []);
  });
});

describe("MRU 记忆", () => {
  it("头插、去重、截断", () => {
    let list = ["a", "b"];
    list = rememberId(list, "b");
    assert.deepEqual(list, ["b", "a"]);
    list = rememberId(list, "   ");
    assert.deepEqual(list, ["b", "a"]);
    for (let i = 0; i < MRU_LIMIT + 5; i += 1) list = rememberId(list, `x${i}`);
    assert.equal(list.length, MRU_LIMIT);
    assert.equal(list[0], `x${MRU_LIMIT + 4}`);
  });
});
