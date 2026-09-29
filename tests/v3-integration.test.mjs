/**
 * **v3 端到端集成测试**：从建库到工具、面板路由、提案落地/撤销，全部跑在新存储上。
 *
 * 这份测试取代了那批"用 v2 文件夹夹具"的旧套件（旧格式已明确不支持 ✓）：
 * 它按真实使用方式造夹具（`createLibrary` 与面板静默创建同一条路径 ✓），
 * 断言的是**上层契约**（工具返回、面板载荷、边与节点的可观察效果 ✓），
 * 而不是落盘细节 —— 落盘细节由 `v3-store.test.mjs` 覆盖 ✓。
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { __internal } from "../index.js";
import { parseDocument } from "../src/host/v3/frontmatter.ts";
import { removeNode as removeV3Node } from "../src/host/v3/store.ts";
import { cleanupFixtures, makeV3Fixture } from "./support/v3-fixture.mjs";

after(async () => {
  await cleanupFixtures();
});

const execAt = (cwd) => ({ agent: { id: "s1", session: { header: { cwd }, snapshotEvents: () => [] } } });
const toolNamed = (name, config = {}) => {
  const tool = __internal.createTools(config).find((item) => item.name === name);
  assert.ok(tool !== undefined, `没有找到工具 ${name}`);
  return tool;
};
const request = (query, method = "GET", json) => ({
  url: `http://dsh.local/${__internal.GRAPH_API_ROUTE}${query}`,
  method,
  ...(json === undefined ? {} : { json: async () => json }),
});

describe("v3：定位与装载", () => {
  it("工作区里的 .dsh_knowledge 是库根；老格式库给出明确错误", async () => {
    const fx = await makeV3Fixture({ nodes: ["注意力机制"] });
    assert.equal(await __internal.resolveLibraryRoot(fx.workspace, null), fx.root);

    const loaded = await __internal.loadLibrary(fx.root, { refresh: true });
    assert.equal(loaded.storage, "v3");
    assert.equal(loaded.snapshot.nodes.length, 1);
    assert.equal(loaded.snapshot.nodes[0].relativePath, "Nodes/注意力机制.md", "v3 节点是一个 md 文件");

    const legacy = await makeV3Fixture();
    await (await import("node:fs/promises")).writeFile(
      join(legacy.root, "library.json"),
      JSON.stringify({ formatVersion: 2 }),
      "utf8",
    );
    await assert.rejects(
      () => __internal.loadLibrary(legacy.root, { refresh: true }),
      (error) => error.code === "unsupported_format",
      "老格式库必须明确报错，而不是静默当成普通目录",
    );
  });

  it("没有库的工作区返回 library_missing + 建议创建位置（面板据此静默创建）", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const empty = await mkdtemp(join(tmpdir(), "kn-nolib-"));
    await assert.rejects(
      () => __internal.resolveLibraryRoot(empty, null),
      (error) => error.detail?.kind === "library_missing" && String(error.detail?.createPath).endsWith(".dsh_knowledge"),
    );
  });
});

describe("v3：工具（读）", () => {
  it("kn_list_graph 返回节点与关系，字段与面板共用同一份构造逻辑", async () => {
    const fx = await makeV3Fixture({ nodes: ["A", "B"], edges: [["A", "B"]] });
    const result = await toolNamed("kn_list_graph").execute({}, execAt(fx.workspace));
    assert.equal(result.ok, true);
    assert.equal(result.nodes.length, 2);
    assert.equal(result.edges.length, 1);
    const a = result.nodes.find((node) => node.title === "A");
    assert.equal(a.path, "Nodes/A.md", "工具返回的节点字段是 path（与 v2 同形）");
  });

  it("kn_find_node / kn_read_node 能定位并读出正文（只读，不建点）", async () => {
    const fx = await makeV3Fixture({ nodes: ["注意力机制"] });
    const found = await toolNamed("kn_find_node").execute({ query: "注意力机制" }, execAt(fx.workspace));
    assert.equal(found.exact?.title, "注意力机制");

    const read = await toolNamed("kn_read_node").execute({ title: "注意力机制" }, execAt(fx.workspace));
    assert.equal(read.ok, true);
    assert.match(String(read.note?.text ?? ""), /注意力机制 的笔记/);
  });
});

describe("v3：工具（写）", () => {
  it("kn_add_prerequisite 建点 + 加边：磁盘上是两个 md + graph.json 里一条边", async () => {
    const fx = await makeV3Fixture({ nodes: ["向量空间模型"] });
    const result = await toolNamed("kn_add_prerequisite").execute(
      { title: "余弦相似度", fromPath: "Nodes/向量空间模型.md", create: true },
      execAt(fx.workspace),
    );
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    assert.equal(result.created, true);

    const nodes = (await readdir(join(fx.root, "Nodes"))).sort();
    assert.deepEqual(nodes, ["余弦相似度.md", "向量空间模型.md"], "每个节点一个 md ✓");
    const graph = JSON.parse(await readFile(join(fx.root, "graph.json"), "utf8"));
    assert.equal(graph.edges.length, 1);
    assert.equal(typeof graph.edges[0].toId, "string");
  });

  it("kn_write_note 写正文（front-matter 里 rev 递增，正文整体替换）", async () => {
    const fx = await makeV3Fixture({ nodes: ["写笔记目标"] });
    const result = await toolNamed("kn_write_note").execute(
      { title: "写笔记目标", text: "这是新的正文" },
      execAt(fx.workspace),
    );
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));

    const text = await readFile(join(fx.root, "Nodes", "写笔记目标.md"), "utf8");
    const parsed = parseDocument(text);
    assert.match(parsed.body, /这是新的正文/);
    assert.equal(parsed.meta.rev >= 2, true, "rev 应递增");
  });

  it("删节点：直接删掉那个 md（默认彻底删除），并摘掉它的边", async () => {
    const fx = await makeV3Fixture({ nodes: ["A", "B"], edges: [["A", "B"]] });
    const removed = await removeV3Node(fx.root, { id: fx.nodes.B.id });
    assert.equal(removed.ok, true);
    assert.equal(removed.title, "B");
    assert.equal((await readdir(join(fx.root, "Nodes"))).length, 1);
    const graph = JSON.parse(await readFile(join(fx.root, "graph.json"), "utf8"));
    assert.equal(graph.edges.length, 0, "删节点要摘掉相关边");
  });
});

describe("v3：面板 Fetch 路由", () => {
  it("带 root 取数返回完整载荷（与工具同形）", async () => {
    const fx = await makeV3Fixture({ nodes: ["A", "B"], edges: [["A", "B"]] });
    const { body } = await __internal.graphApiPayload({}, {}, request(`?root=${encodeURIComponent(fx.root)}`));
    assert.equal(body.ok, true);
    for (const key of ["library", "focusId", "goals", "nodes", "edges", "counts", "issues", "truncated", "revision"]) {
      assert.ok(key in body, `载荷缺少字段 ${key}`);
    }
    assert.equal(body.counts.nodes, 2);
    assert.equal(body.library.formatVersion, 3);
  });

  it("会话 cwd 指向有库的工作区时能取到数据", async () => {
    const fx = await makeV3Fixture({ nodes: ["A"] });
    const ctx = { agents: { get: () => ({ session: { header: { cwd: fx.workspace } } }) } };
    const { body } = await __internal.graphApiPayload(ctx, {}, request("?sessionId=s1"));
    assert.equal(body.ok, true);
    assert.equal(body.counts.nodes, 1);
  });

  it("POST create-library 产出 v3（Nodes/、graph.json；不再有 Backup/）", async () => {
    const fx = await makeV3Fixture();
    const target = join(fx.workspace, "新工作区", ".dsh_knowledge");
    await (await import("node:fs/promises")).mkdir(target, { recursive: true });
    const { body } = await __internal.handleApiRequest({}, {}, request("", "POST", { kind: "create-library", root: target, title: "新库" }));
    assert.equal(body.ok, true);
    assert.deepEqual((await readdir(target)).sort(), ["Nodes", "graph.json", "library.json"]);
    const manifest = JSON.parse(await readFile(join(target, "library.json"), "utf8"));
    assert.equal(manifest.formatVersion, 3);
  });
});

describe("v3：提案（agent 只能提案；落地/撤销由用户点击）", () => {
  it("提案只写计划文件，不建节点；落地后建点，撤销把刚建的节点删掉", async () => {
    const fx = await makeV3Fixture({ nodes: ["起点"] });
    const proposed = await toolNamed("kn_propose_prerequisites").execute(
      { items: [{ fromId: fx.nodes.起点.id, title: "新增前置" }], summary: "测试提案" },
      execAt(fx.workspace),
    );
    assert.equal(proposed.ok, true);

    // 提案阶段：什么都没建
    assert.deepEqual(await readdir(join(fx.root, "Nodes")), ["起点.md"], "提案不能建节点");

    // 用户勾选并落地
    const ctx = await __internal.loadLibrary(fx.root, { refresh: true });
    const applied = await __internal.applyPlanFromUi(
      { library: ctx, snapshot: ctx.snapshot },
      fx.root,
      { planId: proposed.planId, itemIds: proposed.items.map((item) => item.id) },
    );
    assert.equal(applied.ok, true, JSON.stringify(applied.error ?? {}));
    assert.equal((await readdir(join(fx.root, "Nodes"))).length, 2, "落地应建出前置节点");

    // 撤销：把已建节点移进 Backup/
    // 撤销前重新装载：落地刚建出的节点必须出现在上下文里（否则 removeNodeFromUi 找不到它 ✗）
    const ctxAfterApply = await __internal.loadLibrary(fx.root, { refresh: true });
    const undone = await __internal.undoPlanFromUi(
      { library: ctxAfterApply, snapshot: ctxAfterApply.snapshot },
      fx.root,
      { planId: proposed.planId },
    );
    assert.equal(undone.ok, true, JSON.stringify(undone.error ?? {}));
    assert.equal((await readdir(join(fx.root, "Nodes"))).length, 1, "撤销后应只剩原来的节点");
    assert.equal(await (await import("node:fs/promises")).stat(join(fx.root, "Nodes", "新增前置.md")).then(() => true).catch(() => false), false, "撤销 = 删掉刚建的节点");
  });
});
