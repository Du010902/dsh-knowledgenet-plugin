/**
 * 客户端卡片模型测试（纯函数，无需 DOM）。
 *
 * 客户端半没法在 DSH 里跑单测，但「工具结果 → 界面模型」是纯函数，
 * 而这里正是最容易悄悄坏掉的地方：宿主改了字段名，卡片就会变成空白。
 * 因此这些断言直接钉住**宿主真实产出的形状**（与 tests/mutate.test.mjs 里调用的工具对齐）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { makeTranslator, nodeCardModel, nodeLine, parseToolResult, prereqCardModel, relationChipState } from "../src/client/card-model.ts";

const blockOf = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

describe("parseToolResult", () => {
  it("解析宿主工具产出的 JSON", () => {
    const parsed = parseToolResult(blockOf({ ok: true, nodes: [] }));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data.nodes, []);
  });

  it("错误回执：ok=false 且带 code/message", () => {
    const parsed = parseToolResult(blockOf({ ok: false, error: { code: "library_unavailable", message: "x" } }));
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.error, { code: "library_unavailable", message: "x" });
  });

  it("不可解析的内容不会抛错，而是给出 unreadable", () => {
    for (const block of [undefined, {}, { content: [] }, { content: [{ type: "text", text: "not json" }] }, { content: [{ type: "image" }] }]) {
      const parsed = parseToolResult(block);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error.code, "unreadable");
    }
  });
});

describe("nodeCardModel（kn_read_node 的真实形状）", () => {
  const payload = {
    ok: true,
    node: { id: "n1", title: "注意力机制", path: "Nodes/Attention", status: "learning", primaryDocument: "note.md" },
    note: { path: "note.md", text: "第一行\n第二行", truncated: true, byteLength: 12, maxChars: 8 },
    prerequisites: [{ id: "n2", title: "向量空间", path: "Nodes/Vec", status: "todo" }],
    dependents: [{ id: "n3", title: "Transformer", path: "Nodes/Tr", status: "done" }],
    relations: [
      { id: "e1", toTitle: "向量空间", relationType: "prerequisite", description: "先有内积直觉", evidence: [{ snippet: "x" }] },
    ],
    resources: [{ id: "r1", title: "论文", type: "file" }],
  };

  it("取出标题/路径/正文与两个方向", () => {
    const model = nodeCardModel(payload);
    assert.equal(model.title, "注意力机制");
    assert.equal(model.path, "Nodes/Attention");
    assert.equal(model.status, "learning");
    assert.equal(model.noteText, "第一行\n第二行");
    assert.equal(model.noteTruncated, true);
    assert.deepEqual(model.prerequisites.map((item) => item.title), ["向量空间"]);
    assert.deepEqual(model.dependents.map((item) => item.title), ["Transformer"]);
  });

  it("依赖说明与来源标记", () => {
    const model = nodeCardModel(payload);
    assert.equal(model.relations.length, 1);
    assert.equal(model.relations[0].title, "向量空间");
    assert.equal(model.relations[0].description, "先有内积直觉");
    assert.equal(model.relations[0].hasEvidence, true);
    assert.deepEqual(model.resources, [{ title: "论文", type: "file" }]);
  });

  it("缺字段时退化成空值而不是抛错", () => {
    const model = nodeCardModel({ ok: true });
    assert.equal(model.title, "");
    assert.deepEqual(model.prerequisites, []);
    assert.equal(model.prerequisiteCount, 0);
    assert.equal(model.dependentCount, 0);
    assert.deepEqual(model.relations, []);
    assert.equal(model.noteText, "");
  });

  /*
   * 用户实测（2026-10-17）：当前节点在面板里有 1 个前置 + 1 个被依赖，
   * 但会话里的 `kn_read_node` 卡片却写着「（暂无）」。
   * 根因：`kn_read_node` 默认 `relations: "none"` **只返回关系计数**，
   * 卡片却把空的 `prerequisites` / `dependents` 数组当成"没有关系"。
   * ⇒ 卡片必须用 `relationCounts` 区分「真的没有」与「本次没展开」。
   */
  const countsOnly = {
    ok: true,
    node: { id: "01M4ZQ9194VEGYV78WDQBP8K0C", title: "把一串密钥串成单向哈希链", path: "Nodes/把一串密钥串成单向哈希链.md", status: "todo", primaryDocument: "Nodes/把一串密钥串成单向哈希链.md" },
    note: { text: "", truncated: false },
    relationCounts: { prerequisites: 1, dependents: 1 },
    prerequisites: [],
    dependents: [],
    relations: [],
    relationPage: { direction: "none", offset: 0, total: 0, nextOffset: null },
    resources: [],
  };

  it("默认只返回关系计数时仍知道有关系（不能显示成「暂无」）", () => {
    const model = nodeCardModel(countsOnly);
    assert.deepEqual(model.prerequisites, [], "默认没有展开：列表本来就是空的 ✓");
    assert.deepEqual(model.dependents, []);
    assert.equal(model.prerequisiteCount, 1, "计数必须保留 ✓");
    assert.equal(model.dependentCount, 1);
  });

  it("列表被 relationLimit 截断时计数保留总数量", () => {
    const model = nodeCardModel({
      ...countsOnly,
      relationCounts: { prerequisites: 1, dependents: 3 },
      dependents: [{ id: "d1", title: "TESLE密钥", path: "Nodes/TESLE密钥.md" }],
      relationPage: { direction: "dependents", offset: 0, total: 3, nextOffset: 1 },
    });
    assert.equal(model.dependentCount, 3, "已展开 1 个、总数 3 个 ⇒ 还要提示另有 2 个 ✓");
    assert.equal(model.dependents.length, 1);
  });

  it("没有 relationCounts 的老结果 ⇒ 计数回落到列表长度", () => {
    const model = nodeCardModel({ ok: true, prerequisites: [{ id: "p1", title: "前置", path: "Nodes/前置.md" }] });
    assert.equal(model.prerequisiteCount, 1);
    assert.equal(model.dependentCount, 0);
  });

  it("计数比列表短（坏数据）以列表为准，界面不会出现负数", () => {
    const model = nodeCardModel({ ...countsOnly, relationCounts: { prerequisites: 0, dependents: 0 }, prerequisites: [{ id: "p1", title: "前置", path: "Nodes/前置.md" }] });
    assert.equal(model.prerequisiteCount, 1);
  });
});

describe("NodeCard 把关系计数交给 chips ✓", () => {
  it("空列表 + 计数 > 0 ⇒ 「未展开」；空列表 + 计数 0 ⇒ 「暂无」（纯函数钉住决策本身）", () => {
    assert.deepEqual(relationChipState([], 1), { refs: [], hidden: 1 }, "有关系但没展开 ⇒ hidden > 0（不显示「暂无」✓）");
    assert.deepEqual(relationChipState([], 0), { refs: [], hidden: 0 }, "真的没有关系 ⇒ hidden 0 ⇒ 显示「暂无」✓");
    assert.deepEqual(relationChipState([{ id: "d1", title: "TESLE密钥", path: "Nodes/TESLE密钥.md" }], 3), {
      refs: [{ id: "d1", title: "TESLE密钥", path: "Nodes/TESLE密钥.md" }],
      hidden: 2,
    }, "被 relationLimit 截断 ⇒ 提示另有 2 个 ✓");
    assert.equal(relationChipState([{ id: "p1", title: "前置", path: "Nodes/前置.md" }], 0).hidden, 0, "坏数据（计数比列表短）不会算出负数 ✓");
  });

  it("NodeCard 两个方向都传 `model.*Count`（否则空列表又被画成「暂无」✗）", () => {
    const source = readFileSync(new URL("../src/client/NodeCard.tsx", import.meta.url), "utf8");
    assert.match(source, /chips\(model\.prerequisites, model\.prerequisiteCount, t\)/);
    assert.match(source, /chips\(model\.dependents, model\.dependentCount, t\)/);
    assert.match(source, /relationChipState\(refs, total\)/, "展示决策走纯函数（上面已单测 ✓）");
    assert.match(source, /relationsCollapsed/, "计数 > 0 且列表为空时要有「未展开」文案 ✓");
    assert.match(source, /relationsMore/, "被截断时要提示还有多少未展开 ✓");
  });
});

describe("prereqCardModel（kn_add_prerequisite 的四种结果）", () => {
  it("新建成功：created + 出处", () => {
    const model = prereqCardModel({
      ok: true,
      from: { id: "a", title: "注意力机制", path: "Nodes/Attention" },
      node: { id: "b", title: "向量空间", path: "Nodes/Vec" },
      created: true,
      edge: { id: "e", type: "prerequisite", description: "先有内积直觉" },
      evidenceRecorded: true,
    });
    assert.equal(model.created, true);
    assert.equal(model.evidenceRecorded, true);
    assert.equal(nodeLine(model.from) + " → " + nodeLine(model.node), "注意力机制 → 向量空间");
    assert.equal(model.edgeType, "prerequisite");
  });

  it("命中相近候选：needsConfirmation 且带候选", () => {
    const model = prereqCardModel({
      ok: true,
      from: { id: "a", title: "A", path: "Nodes/A" },
      created: false,
      candidates: [{ id: "c", title: "向量空间模型", path: "Nodes/Vec" }],
      error: { code: "needs_confirmation", message: "x" },
    });
    assert.equal(model.needsConfirmation, true);
    assert.deepEqual(model.candidates.map((item) => item.title), ["向量空间模型"]);
  });

  it("成环与空栈都有可读状态", () => {
    const cyclic = prereqCardModel({ ok: false, cycle: ["A", "B", "A"], error: { code: "cycle_rejected", message: "x" } });
    assert.deepEqual(cyclic.cycle, ["A", "B", "A"]);
    const empty = prereqCardModel({ ok: false, error: { code: "empty_stack", message: "x" } });
    assert.equal(empty.emptyStack, true);
  });
});

describe("makeTranslator", () => {
  it("没有宿主的 t 时用字面文案并做占位符替换", () => {
    const t = makeTranslator(undefined, { counts: "节点 {n} · 依赖 {e}" });
    assert.equal(t("counts", { n: 3, e: 2 }), "节点 3 · 依赖 2");
    assert.equal(t("missing"), "missing");
  });

  it("宿主 t 可用时优先用它", () => {
    const t = makeTranslator((key) => (key === "counts" ? "{n} nodes" : key), { counts: "节点 {n}" });
    assert.equal(t("counts", { n: 3 }), "3 nodes");
  });

  it("宿主 t 抛错时静默回落到字面文案", () => {
    const t = makeTranslator(() => { throw new Error("locale gone"); }, { title: "知识库图谱" });
    assert.equal(t("title"), "知识库图谱");
  });
});
