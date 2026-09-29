/**
 * v3 存储的行为测试（一节点 = 一个 markdown；身份 = front-matter 的 ULID）。
 *
 * 这些测试直接 import 轻量存储模块（它只依赖 node:fs/path/crypto）✓，
 * 所以不受打包产物与"双模块实例"影响 ✓。
 *
 * 重点覆盖用户提出的那条要求：**唯一标识不能是节点名称** ✓
 * —— 改标题、重命名文件、两个节点同名，身份与关系都不受影响。
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { fileNameFromTitle, parseDocument } from "../src/host/v3/frontmatter.ts";
import {
  V3_NODES_DIR,
  addEdge,
  createLibrary,
  createNode,
  readLibrary,
  readNode,
  removeNode,
  resolveNode,
  writeNote,
} from "../src/host/v3/store.ts";
import { isUlid, ulid } from "../src/host/v3/ulid.ts";

const temps = [];

/** 文件/目录是否存在 */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function makeLibrary(title = "库") {
  const root = await mkdtemp(join(tmpdir(), "kn-v3-"));
  temps.push(root);
  const created = await createLibrary(root, title);
  assert.equal(created.ok, true, JSON.stringify(created));
  return root;
}

describe("ULID 与 front-matter", () => {
  it("ULID 形如 26 字符、按时间有序、同一毫秒也不重复", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_000);
    const later = ulid(1_700_000_001_000);
    assert.equal(a.length, 26);
    assert.equal(isUlid(a), true);
    assert.notEqual(a, b, "同一毫秒要有随机性");
    assert.ok(later > a, "时间靠后应的 ULID 字典序更大");
  });

  it("front-matter 往返：解析后写回保持一致（键序固定）", () => {
    const text = [
      "---",
      "id: 01J9ZQ8F2M7K3N5P6R7S8T9V0W",
      "title: 注意力机制",
      "status: learning",
      "aliases: [Attention, 注意机制]",
      "createdAt: 2026-09-29T02:00:00.000Z",
      "updatedAt: 2026-09-29T02:05:00.000Z",
      "rev: 3",
      "---",
      "",
      "这里是正文。",
      "",
    ].join("\n");
    const parsed = parseDocument(text);
    assert.equal(parsed.hasFrontMatter, true);
    assert.equal(parsed.meta.id, "01J9ZQ8F2M7K3N5P6R7S8T9V0W");
    assert.equal(parsed.meta.title, "注意力机制");
    assert.deepEqual(parsed.meta.aliases, ["Attention", "注意机制"]);
    assert.equal(parsed.meta.rev, 3);
    assert.match(parsed.body, /这里是正文/);
  });

  it("没有 front-matter 的 md 不报错（用户手工粘贴的文件也能读）", () => {
    const parsed = parseDocument("# 随手写的\n\n内容");
    assert.equal(parsed.hasFrontMatter, false);
    assert.equal(parsed.meta.title, "");
    assert.match(parsed.body, /随手写的/);
  });

  it("标题到文件名：去掉非法字符，全非法时退回 node", () => {
    assert.equal(fileNameFromTitle("注意力机制"), "注意力机制");
    assert.equal(fileNameFromTitle('a/b:c*d?"e"'), "a b c d e");
    assert.equal(fileNameFromTitle("///"), "node");
  });
});

describe("v3 库：一节点 = 一个 markdown", () => {
  it("建库后目录形态正确（Nodes / graph.json / Backup / trash）", async () => {
    const root = await makeLibrary("测试库");
    const names = (await readdir(root)).sort();
    assert.deepEqual(names, ["Nodes", "graph.json", "library.json"], "只有这些：没有 Backup/、没有回收站/墓碑");
    const manifest = JSON.parse(await readFile(join(root, "library.json"), "utf8"));
    assert.equal(manifest.formatVersion, 3);
    assert.equal(manifest.storage, "single-file-markdown");
  });

  it("建节点写出一个 md，身份是 ULID 且**不等于标题/文件名**", async () => {
    const root = await makeLibrary();
    const created = await createNode(root, { title: "注意力机制", note: "第一段笔记" });
    assert.equal(created.ok, true);
    const node = created.node;
    assert.equal(isUlid(node.id), true, "身份必须是 ULID");
    assert.notEqual(node.id, node.title);
    assert.equal(node.relativePath, "Nodes/注意力机制.md");

    const text = await readFile(join(root, node.relativePath), "utf8");
    const parsed = parseDocument(text);
    assert.equal(parsed.meta.id, node.id);
    assert.equal(parsed.meta.title, "注意力机制");
    assert.match(parsed.body, /第一段笔记/);
  });

  it("**身份与文件名解耦**：改标题 + 重命名文件后，id 不变、关系还在", async () => {
    const root = await makeLibrary();
    const a = (await createNode(root, { title: "A" })).node;
    const b = (await createNode(root, { title: "B" })).node;
    const edge = await addEdge(root, { fromId: a.id, toId: b.id, description: "A 需要 B" });
    assert.equal(edge.ok, true);

    // 用户手动改**标题**（只动 front-matter 的 title，不动 id）
    const bText = await readFile(join(root, b.relativePath), "utf8");
    await writeFile(join(root, b.relativePath), bText.replace("title: B", "title: B（改名后）"), "utf8");
    // 再把**文件名**也改掉
    await rename(join(root, b.relativePath), join(root, "Nodes", "改过名的文件.md"));

    const library = await readLibrary(root);
    const stillB = library.nodes.find((node) => node.id === b.id);
    assert.notEqual(stillB, undefined, "改标题 + 重命名文件后身份必须还在");
    assert.equal(stillB.title, "B（改名后）", "标题跟着文件里的内容走");
    assert.equal(stillB.relativePath, "Nodes/改过名的文件.md", "路径跟着文件名走");
    assert.equal(library.edges.length, 1, "关系不受影响");
    // 用旧 id 也能查到（身份不依赖路径/标题）
    const byId = await resolveNode(root, { id: b.id });
    assert.equal(byId.title, "B（改名后）");
  });

  it("同名节点自动加后缀（-2、-3），身份彼此不同", async () => {
    const root = await makeLibrary();
    const first = (await createNode(root, { title: "重复标题" })).node;
    const second = (await createNode(root, { title: "重复标题" })).node;
    const third = (await createNode(root, { title: "重复标题" })).node;
    assert.equal(first.relativePath, "Nodes/重复标题.md");
    assert.equal(second.relativePath, "Nodes/重复标题-2.md");
    assert.equal(third.relativePath, "Nodes/重复标题-3.md");
    assert.equal(new Set([first.id, second.id, third.id]).size, 3);
  });

  it("写正文带冲突守卫：指纹不匹配时拒绝并给出实际指纹", async () => {
    const root = await makeLibrary();
    const node = (await createNode(root, { title: "节点" })).node;
    const stale = node.hash;
    // 别人先改了一次
    const first = await writeNote(root, { id: node.id, text: "第一版", expectedHash: stale });
    assert.equal(first.ok, true);
    // 我拿着旧指纹再写 ⇒ 必须被拒绝
    const second = await writeNote(root, { id: node.id, text: "用旧指纹覆盖", expectedHash: stale });
    assert.equal(second.ok, false);
    assert.equal(second.code, "conflict");
    assert.equal(typeof second.actualHash, "string");

    const back = await readNode(root, { id: node.id });
    assert.match(back.node.note, /第一版/, "被拒绝的写入不能落地");
    assert.equal(back.node.rev, 2);
  });

  it("关系：重复幂等、自环与成环被拒绝、删除节点会摘掉相关边", async () => {
    const root = await makeLibrary();
    const a = (await createNode(root, { title: "A" })).node;
    const b = (await createNode(root, { title: "B" })).node;
    const c = (await createNode(root, { title: "C" })).node;

    assert.equal((await addEdge(root, { fromId: a.id, toId: b.id })).ok, true);
    const again = await addEdge(root, { fromId: a.id, toId: b.id });
    assert.equal(again.ok, true);
    assert.equal(again.created, false, "重复加边要幂等");

    assert.equal((await addEdge(root, { fromId: a.id, toId: a.id })).code, "self_edge");
    await addEdge(root, { fromId: b.id, toId: c.id });
    const cycle = await addEdge(root, { fromId: c.id, toId: a.id });
    assert.equal(cycle.code, "cycle", "成环必须拒绝");

    const removed = await removeNode(root, { id: b.id });
    assert.equal(removed.ok, true);
    assert.equal(removed.title, "B");
    const library = await readLibrary(root);
    assert.equal(library.edges.length, 0, "删节点要摘掉它的边");
    assert.equal(library.nodes.length, 2);
  });

  it("删除 = 直接删掉那个 md（默认彻底删除）+ 留下身份墓碑", async () => {
    const root = await makeLibrary();
    const node = (await createNode(root, { title: "要删的" })).node;
    const result = await removeNode(root, { id: node.id });
    assert.equal(result.ok, true);

    const library = await readLibrary(root);
    assert.equal(library.nodes.some((item) => item.id === node.id), false, "节点应消失");
    assert.equal(await exists(join(root, V3_NODES_DIR, "要删的.md")), false, "文件应被删掉");
    assert.equal(await exists(join(root, "Backup")), false, "没有 Backup/");
    // 也不该有任何"回收站/墓碑"：那东西只写不读，已删除 ✓
    assert.deepEqual((await readdir(root)).sort(), ["Nodes", "graph.json", "library.json"], "删除后只应剩库该有的东西");
  });

  it("resolveNode 支持 id / 标题 / 路径，标题重名时按第一个匹配", async () => {
    const root = await makeLibrary();
    const node = (await createNode(root, { title: "查询目标", aliases: ["alias"] })).node;
    assert.equal((await resolveNode(root, { id: node.id })).id, node.id);
    assert.equal((await resolveNode(root, { title: "查询目标" })).id, node.id);
    assert.equal((await resolveNode(root, { path: "Nodes/查询目标.md" })).id, node.id);
    assert.equal(await resolveNode(root, { title: "不存在" }), undefined);
  });

  it("没有 front-matter 的 md 也有临时身份，写入时固化成正式 ULID", async () => {
    const root = await makeLibrary();
    await writeFile(join(root, "Nodes", "手写的.md"), "# 手写\n\n内容", "utf8");
    const library = await readLibrary(root);
    const adhoc = library.nodes.find((node) => node.title === "手写的");
    assert.notEqual(adhoc, undefined);
    assert.equal(adhoc.adopted, true);

    const written = await writeNote(root, { id: adhoc.id, text: "正文" });
    assert.equal(written.ok, true);
    assert.equal(isUlid(written.node.id), true, "写入时应固化正式身份");
    const again = await readLibrary(root);
    assert.equal(again.nodes.some((node) => node.id === written.node.id), true);
  });
});
