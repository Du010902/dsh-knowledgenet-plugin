/**
 * 客户端卡片模型测试（纯函数，无需 DOM）。
 *
 * 客户端半没法在 DSH 里跑单测，但「工具结果 → 界面模型」是纯函数，
 * 而这里正是最容易悄悄坏掉的地方：宿主改了字段名，卡片就会变成空白。
 * 因此这些断言直接钉住**宿主真实产出的形状**（与 tests/mutate.test.mjs 里调用的工具对齐）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeTranslator, nodeCardModel, nodeLine, parseToolResult, prereqCardModel } from "../src/client/card-model.ts";

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
    assert.deepEqual(model.relations, []);
    assert.equal(model.noteText, "");
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
