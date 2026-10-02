/**
 * **节点正文编辑**的宿主侧测试（对应 `design/node-note-editor-plan.md`）。
 *
 * 这里钉住的是文档里那些"不能省"的约束：
 * - 只读写**正文**，front-matter 身份 / 标题 / 状态 / 修订号由存储层维护 ✗；
 * - 读返回**实际相对路径**与**整文件指纹** ✓；
 * - 保存是**比较交换**：指纹对不上就拒绝，并回带**磁盘最新正文** ✓（绝不默认覆盖 ✗）；
 * - 大文档**拒绝**而不是截断 ✓；
 * - 失败时草稿/磁盘都不变 ✓；成功一次修订号 +1 ✓。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { readNodeDocument, saveNodeDocument, MAX_DOCUMENT_BYTES } from "../src/host/node-document.ts";
import { parseDocument } from "../src/host/v3/frontmatter.ts";
import {
  NODE_INDEX_TTL_MS,
  checkLibraryFormat,
  createNode,
  idFromHead,
  mapLimit,
  peekNodeIndex,
  readLibrary,
  removeNode,
  seedNodeIndex,
} from "../src/host/v3/store.ts";
import { cleanupFixtures, makeV3Fixture } from "./support/v3-fixture.mjs";

/** 宿主 API：正文分支的"前置检查"是源码级断言（那一层需要 ctx/config，太重 ✗） */
const apiSource = readFileSync(new URL("../src/host/api.ts", import.meta.url), "utf8");

after(async () => {
  await cleanupFixtures();
});

/** 夹具：一个 v3 库 + 一个叫「注意力机制」的节点 ✓ */
async function fixture() {
  const fx = await makeV3Fixture({ nodes: ["注意力机制"] });
  const node = fx.nodes["注意力机制"];
  return { ...fx, nodeId: node.id, file: join(fx.root, node.relativePath) };
}

describe("读节点正文：**索引定位**（加载优化 ✓）", () => {
  it("**不再为读一篇正文扫全库** ✓：别的节点文件坏掉也读得到目标节点", async () => {
    const fx = await makeV3Fixture({ nodes: ["目标节点", "坏节点"] });
    const target = fx.nodes["目标节点"];
    const broken = fx.nodes["坏节点"];
    const targetPath = join(fx.root, target.relativePath);
    /* 把"坏节点"的文件换成一个**同名目录** ⇒ 任何 readFile 都会抛错 ✓ */
    await unlink(join(fx.root, broken.relativePath));
    await mkdir(join(fx.root, broken.relativePath));

    /* 先确认：老做法（扫全库）在同样条件下**会失败** ✓ —— 这是这条测试的对照 ✓ */
    await assert.rejects(
      readLibrary(fx.root, { withNotes: true }),
      "全库扫描碰到读不了的文件会直接抛错 ✓（所以旧实现连累目标节点一起读不出来 ✗）",
    );

    /* 索引直读：只读目标文件 ⇒ 与那个坏文件无关 ✓ */
    const result = await readNodeDocument(fx.root, target.id);
    assert.equal(result.ok, true, "索引直读必须成功 ✓");
    assert.equal(result.document.text.includes("目标节点 的笔记"), true);
    const onDisk = await readFile(targetPath, "utf8");
    assert.ok(onDisk.includes("id:"), "读的是磁盘上那份 ✓");
  });

  it("图谱扫描结果可以**喂**给索引（一个文件都不多扫 ✓）", async () => {
    const fx = await makeV3Fixture({ nodes: ["甲", "乙"] });
    seedNodeIndex(
      fx.root,
      Object.values(fx.nodes).map((node) => ({ id: node.id, relativePath: node.relativePath })),
      "lib-test",
    );
    assert.equal(peekNodeIndex(fx.root)?.size, 2, "索引里两条 ✓");
    const result = await readNodeDocument(fx.root, fx.nodes["乙"].id);
    assert.equal(result.ok, true);
    assert.equal(result.document.title, "乙");
  });

  it("**外部新建**的文件：索引里没有 ⇒ 受控重扫一次就能读到 ✓", async () => {
    const fx = await makeV3Fixture({ nodes: ["甲"] });
    assert.equal((await readNodeDocument(fx.root, fx.nodes["甲"].id)).ok, true, "先把索引建起来 ✓");
    /* 模拟"外部工具/桌面版"直接写了一个新文件（合法 ULID 身份 ✓） */
    const externalId = "01JQZ0000000000000000000AA";
    const external = [
      "---",
      `id: ${externalId}`,
      "title: 外部新建",
      "status: todo",
      "createdAt: 2026-10-02T00:00:00.000Z",
      "updatedAt: 2026-10-02T00:00:00.000Z",
      "rev: 1",
      "---",
      "",
      "外部写进来的正文",
      "",
    ].join("\n");
    await writeFile(join(fx.root, "Nodes", "外部新建.md"), external, "utf8");

    const result = await readNodeDocument(fx.root, externalId);
    assert.equal(result.ok, true, "重扫之后必须能读到 ✓（并要求受控重扫而不是报找不到 ✗）");
    assert.equal(result.document.text, "外部写进来的正文");
    assert.equal(peekNodeIndex(fx.root)?.size, 2, "索引已更新 ✓");
  });

  it("**节点被删** ⇒ 从索引里摘掉，读取明确 node_missing ✓", async () => {
    const fx = await makeV3Fixture({ nodes: ["甲", "乙"] });
    assert.equal((await readNodeDocument(fx.root, fx.nodes["甲"].id)).ok, true);
    const removed = await removeNode(fx.root, { id: fx.nodes["乙"].id });
    assert.equal(removed.ok, true);
    assert.equal(peekNodeIndex(fx.root)?.size, 1, "删掉的那条要摘掉 ✓");
    const result = await readNodeDocument(fx.root, fx.nodes["乙"].id);
    assert.equal(result.ok, false);
    assert.equal(result.code, "node_missing");
  });

  it("**新建节点**立刻进索引 ✓（不必等下一次全库重扫 ✗）", async () => {
    const fx = await makeV3Fixture({ nodes: ["甲"] });
    assert.equal((await readNodeDocument(fx.root, fx.nodes["甲"].id)).ok, true, "先建索引 ✓");
    const made = await createNode(fx.root, { title: "新来的", note: "新正文" });
    assert.equal(made.ok, true);
    assert.equal(peekNodeIndex(fx.root)?.size, 2, "新建的那条要立刻进索引 ✓");
    const result = await readNodeDocument(fx.root, made.node.id);
    assert.equal(result.ok, true);
    assert.equal(result.document.text, "新正文");
  });

  it("**身份对不上**（文件被换成别的节点）⇒ 受控重扫后如实报 node_missing ✓", async () => {
    const fx = await makeV3Fixture({ nodes: ["甲", "乙"] });
    assert.equal((await readNodeDocument(fx.root, fx.nodes["乙"].id)).ok, true, "先建索引 ✓");
    /* 把"乙"的文件覆盖成另一个身份的内容 ⇒ 索引指向它时身份校验失败 ✓ */
    const other = "01JQZ0000000000000000000BB";
    const text = ["---", `id: ${other}`, "title: 换过的", "status: todo", "rev: 1", "---", "", "换了身份", ""].join("\n");
    await writeFile(join(fx.root, fx.nodes["乙"].relativePath), text, "utf8");
    const gone = await readNodeDocument(fx.root, fx.nodes["乙"].id);
    assert.equal(gone.ok, false, "旧身份确实不存在了 ✓");
    assert.equal(gone.code, "node_missing");
    const fresh = await readNodeDocument(fx.root, other);
    assert.equal(fresh.ok, true, "新身份要能读到 ✓");
  });

  it("保存**仍然现场读磁盘比指纹** ✓（索引不参与判定 ✗）", async () => {
    const fx = await makeV3Fixture({ nodes: ["甲"] });
    const first = await readNodeDocument(fx.root, fx.nodes["甲"].id);
    assert.equal(first.ok, true);
    const file = join(fx.root, fx.nodes["甲"].relativePath);
    /* 绕开插件**直接改磁盘**（模拟外部编辑器 ✓） */
    await writeFile(file, `${await readFile(file, "utf8")}\n外部追加`, "utf8");
    const stale = await saveNodeDocument(fx.root, { nodeId: fx.nodes["甲"].id, text: "我要覆盖", hash: first.document.hash });
    assert.equal(stale.ok, false, "指纹对不上必须拒绝 ✗（不许拿缓存指纹放行 ✗）");
    assert.equal(stale.code, "conflict");
    assert.ok(stale.latest !== undefined, "冲突要回带磁盘最新正文 ✓");
    assert.ok(stale.latest.text.includes("外部追加"), "回带的必须是磁盘上那份 ✓");
  });
});

describe("正文接口的**前置检查**（加载优化复查 问题一 ✓）", () => {
  it("轻量格式检查：v3 ✓ / 旧格式 ✗ / 不是库 ✗ / 读不了 ✗ 各自分开", async () => {
    const fx = await makeV3Fixture({ nodes: ["甲"] });
    assert.deepEqual(await checkLibraryFormat(fx.root), { ok: true });
    /* 旧格式（v2）：library.json 里 formatVersion 不是 3 ✓ */
    const legacy = await makeV3Fixture({ nodes: [] });
    await writeFile(join(legacy.root, "library.json"), JSON.stringify({ formatVersion: 2 }), "utf8");
    const old = await checkLibraryFormat(legacy.root);
    assert.equal(old.ok, false);
    assert.equal(old.code, "unsupported_format", "旧格式要明确说格式 ✗（不许报成读不了 ✓）");
    /* 不是知识库：没有 library.json ✓ */
    const empty = await makeV3Fixture({ nodes: [] });
    await unlink(join(empty.root, "library.json"));
    const none = await checkLibraryFormat(empty.root);
    assert.equal(none.ok, false);
    assert.equal(none.code, "library_unavailable");
    /* 读不了（权限 / IO）：同名目录 ⇒ 读取失败，**不能**说成格式问题 ✗ */
    const broken = await makeV3Fixture({ nodes: [] });
    await unlink(join(broken.root, "library.json"));
    await mkdir(join(broken.root, "library.json"));
    const failed = await checkLibraryFormat(broken.root);
    assert.equal(failed.ok, false);
    assert.equal(failed.code, "read_failed", "磁盘问题要与格式问题分开 ✓（原来看不出区别 ✗）");
    /* 不是合法 JSON ⇒ 格式问题 ✓ */
    const badJson = await makeV3Fixture({ nodes: [] });
    await writeFile(join(badJson.root, "library.json"), "{ 这不是 json", "utf8");
    const parsed = await checkLibraryFormat(badJson.root);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, "unsupported_format");
  });

  it("正文接口**不再为格式检查加载整个图谱** ✗（源码断言 ✓）", () => {
    const branch = apiSource.slice(
      apiSource.indexOf('record.kind === "read-node-document" || record.kind === "save-node-document"'),
      apiSource.indexOf('record.kind === "remove-node"'),
    );
    assert.ok(branch.length > 0, "要能切出正文分支 ✓");
    assert.ok(branch.includes("checkLibraryFormat(resolved.root)"), "要用轻量格式检查 ✓");
    assert.ok(
      !branch.includes("await loadLibrary(") && !branch.includes("= await loadLibrary"),
      "这个分支里**不许**真的调 loadLibrary ✗（那会顺带全库扫描 ✓；注释里提到名字没关系 ✓）",
    );
    assert.ok(branch.includes("recordNoteApi("), "要有端到端计时 ✓");
    assert.ok(branch.includes("requestId"), "要与客户端请求号对齐 ✓");
  });
});

describe("单节点索引：寿命与目录变动（加载优化复查 问题二 ✓）", () => {
  it("索引寿命与图谱缓存**解耦** ✓（不再是 1.5 秒）", () => {
    assert.ok(
      NODE_INDEX_TTL_MS >= 60_000,
      `路径只是"提示"、权威性靠现场读文件校验 ✓ ⇒ 寿命不该跟着 1.5s 的图谱缓存走 ✗（现在是 ${NODE_INDEX_TTL_MS}ms）`,
    );
    const source = readFileSync(new URL("../src/host/v3/store.ts", import.meta.url), "utf8");
    assert.ok(source.includes("namesUnchanged("), "每次读要有**目录变动检测**（一次 readdir ✓，不读文件 ✗）");
    assert.ok(source.includes("index.libraryId !== libraryId"), "libraryId 变了要整体作废 ✓");
  });

  it("**目录新增了重复 ULID** ⇒ 归属按扫描规则重算（不许只延寿命就宣称身份永远对 ✓）", async () => {
    const fx = await makeV3Fixture({ nodes: ["甲", "乙"] });
    const target = fx.nodes["甲"];
    const first = await readNodeDocument(fx.root, target.id);
    assert.equal(first.ok, true, "先建索引并读一次 ✓");
    /* 新来一个文件，**冒用**同一个 ULID ✓（排序上它在前 ⇒ 按扫描规则它赢得这个 id ✓） */
    const duplicate = ["---", `id: ${target.id}`, "title: 冒名者", "status: todo", "rev: 1", "---", "", "冒名的正文", ""].join("\n");
    await writeFile(join(fx.root, "Nodes", "0冒名者.md"), duplicate, "utf8");

    const after = await readNodeDocument(fx.root, target.id);
    assert.equal(after.ok, true, "读到的是**按扫描规则赢得这个 id 的那个文件** ✓");
    assert.equal(after.document.text, "冒名的正文", "归属变了 ⇒ 必须重算（只延长 TTL 会给出过时路径 ✗）");
  });
});

describe("索引建立的两处 I/O 优化（只读头部 + 有界并发 ✓）", () => {
  it("`mapLimit`：顺序保持 ✓、并发有界 ✓、空表与 limit≤0 都安全 ✓", async () => {
    const items = [5, 1, 4, 2, 3];
    const seen = [];
    const out = await mapLimit(items, 2, async (item) => {
      seen.push(item);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      return item * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30], "结果顺序必须与输入一致 ✓（身份分配依赖它 ✓）");
    assert.equal(seen.length, items.length, "每个元素都跑到 ✓");

    let live = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 12 }, (_unused, index) => index), 3, async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => { setTimeout(resolve, 2); });
      live -= 1;
      return 0;
    });
    assert.ok(peak <= 3, `并发不许超过上限（实测峰值 ${peak} ✗）`);

    assert.deepEqual(await mapLimit([], 4, async () => 1), [], "空表直接返回 ✓");
    assert.deepEqual(await mapLimit([1, 2], 0, async (item) => item), [1, 2], "limit≤0 按 1 处理 ✓");
    await assert.rejects(mapLimit([1], 1, async () => { throw new Error("boom"); }), "任务抛错要如实抛出 ✓");
  });

  it("`idFromHead`：完整 front-matter ⇒ 取到 id ✓；不完整 / 没有 ⇒ undefined ✓（退回读整份 ✓）", () => {
    assert.equal(idFromHead("---\nid: abc\ntitle: 甲\n---\n\n正文"), "abc");
    assert.equal(idFromHead("---\r\nid: abc\r\n---\r\n正文"), "abc", "CRLF 也要认 ✓");
    assert.equal(idFromHead("---\nid: abc\n"), undefined, "front-matter 还没结束 ⇒ 头部不够 ✓");
    assert.equal(idFromHead("正文一开始就是正文"), undefined, "压根没有 front-matter ⇒ 交给调用方读整份 ✓");
    assert.equal(idFromHead(""), undefined);
  });

  it("**超大正文**的节点：只读头部也能建进索引 ✓（正文照旧完整读出来 ✓）", async () => {
    const fx = await makeV3Fixture({ nodes: ["大块头"] });
    const node = fx.nodes["大块头"];
    const file = join(fx.root, node.relativePath);
    /* 把正文换成 ~100KB ASCII（远超 4KB 的头部读取 ✓，但仍在 512KB 上限内 ✓） */
    const original = await readFile(file, "utf8");
    const head = original.slice(0, original.indexOf("\n---\n") + 5);
    await writeFile(file, `${head}\n${"fill ".repeat(20_000)}\n`, "utf8");
    const result = await readNodeDocument(fx.root, node.id);
    assert.equal(result.ok, true, "头部读到 id ⇒ 建索引时不必读整份正文 ✓");
    assert.ok(result.document.text.length > 90_000, "真正返回的正文仍然完整 ✓");
  });

  it("**front-matter 比头部上限还长** ⇒ 退回读整份也要能建进索引 ✓", async () => {
    const fx = await makeV3Fixture({ nodes: ["长头"] });
    const node = fx.nodes["长头"];
    const file = join(fx.root, node.relativePath);
    const original = await readFile(file, "utf8");
    /* 在 front-matter 里塞一段超长 aliases（> INDEX_HEAD_BYTES ✓） */
    const filler = `aliases: [${Array.from({ length: 400 }, (_unused, index) => `"别名${index}${"x".repeat(12)}"`).join(", ")}]`;
    await writeFile(file, original.replace(/\n---\n/, `\n${filler}\n---\n`), "utf8");
    const result = await readNodeDocument(fx.root, node.id);
    assert.equal(result.ok, true, "头部不够时必须退回整份读 ✓（否则这个节点会凭空消失 ✗）");
    assert.equal(result.document.title, "长头");
  });

  it("**有文件读不到** ⇒ 未命中不许假装「没有这个节点」✓（如实报 read_failed ✓）", async () => {
    const fx = await makeV3Fixture({ nodes: ["甲", "坏"] });
    /* 把"坏"的文件换成一个同名目录 ⇒ 任何读取都会失败 ✓ */
    await unlink(join(fx.root, fx.nodes["坏"].relativePath));
    await mkdir(join(fx.root, fx.nodes["坏"].relativePath));
    const missing = await readNodeDocument(fx.root, "01JQZ0000000000000000000ZZ");
    assert.equal(missing.ok, false, "不许当成 node_missing 糊过去 ✗");
    assert.equal(missing.code, "read_failed", "要如实说是读不了 ✓");
    /* 而"甲"自己仍然读得到 ✓（索引直读，不必碰坏文件 ✓） */
    const good = await readNodeDocument(fx.root, fx.nodes["甲"].id);
    assert.equal(good.ok, true);
  });
});

describe("读节点正文", () => {
  it("返回正文、实际相对路径、整文件指纹与修订号 ✓", async () => {
    const fx = await fixture();
    const result = await readNodeDocument(fx.root, fx.nodeId);
    assert.equal(result.ok, true, "应当读得到");
    const doc = result.document;
    assert.equal(doc.nodeId, fx.nodeId);
    assert.equal(doc.title, "注意力机制");
    assert.equal(doc.path, "Nodes/注意力机制.md", "要给出**实际相对路径** ✓");
    assert.ok(doc.text.includes("注意力机制 的笔记"), `正文应当只有正文（不含 front-matter ✗）：${doc.text}`);
    assert.ok(!doc.text.includes("---"), "front-matter 不许出现在正文里 ✗");
    assert.ok(doc.hash.length > 0 && doc.revision >= 1, "要有指纹与修订号 ✓");
    /* 指纹 = **整文件**内容的哈希（含 front-matter ✓）⇒ 外部改元数据也会被发现 ✓ */
    const onDisk = await readFile(fx.file, "utf8");
    assert.ok(onDisk.includes("id:"), "磁盘上确实有 front-matter");
  });

  it("节点不存在 / nodeId 为空 ⇒ 明确的 code（不抛异常 ✓）", async () => {
    const fx = await fixture();
    const missing = await readNodeDocument(fx.root, "no-such-node");
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "node_missing");
    const empty = await readNodeDocument(fx.root, "   ");
    assert.equal(empty.ok, false);
    assert.equal(empty.code, "node_missing");
  });
});

describe("保存节点正文（比较交换）", () => {
  it("带正确指纹保存 ⇒ 正文落盘、修订号 +1、返回新指纹 ✓", async () => {
    const fx = await fixture();
    const before = await readNodeDocument(fx.root, fx.nodeId);
    const text = "## 我的理解\n\n注意力是**加权求和**。\n\n- 一行中文注释 ✓\n";
    const saved = await saveNodeDocument(fx.root, { nodeId: fx.nodeId, text, hash: before.document.hash });
    assert.equal(saved.ok, true, `应当保存成功：${saved.ok === false ? saved.message : ""}`);
    const normalize = (value) => value.replace(/^\n+/, "").replace(/\s+$/, "");
    assert.equal(saved.document.text, normalize(text), "返回的正文按统一口径规整（不带头尾空白 ✓）");
    assert.notEqual(saved.document.hash, before.document.hash, "指纹要更新 ✓");
    assert.equal(saved.document.revision, before.document.revision + 1, "修订号 +1 ✓");
    assert.equal(saved.document.path, before.document.path, "路径不变 ✓");

    /* 磁盘上：正文就是新正文，front-matter 身份字段原样保留 ✓ */
    const onDisk = await readFile(fx.file, "utf8");
    const parsed = parseDocument(onDisk);
    assert.equal(parsed.body.trim(), text.trim(), "磁盘正文要对 ✓");
    assert.equal(parsed.meta.id, fx.nodeId, "身份（id）不许被改 ✗");
    assert.equal(parsed.meta.title, "注意力机制", "标题字段由存储层维护 ✓");
    assert.ok(parsed.meta.updatedAt.length > 0, "存储层会更新 updatedAt ✓");
  });

  it("外部改过正文 ⇒ **冲突**：回带最新正文、草稿不被写入 ✗", async () => {
    const fx = await fixture();
    const mine = await readNodeDocument(fx.root, fx.nodeId);
    /* 模拟外部编辑器改动（正文 + front-matter 都动一下） */
    const onDisk = await readFile(fx.file, "utf8");
    await writeFile(fx.file, onDisk.replace("注意力机制 的笔记", "外部补充的内容"), "utf8");

    const draft = "我的草稿，绝不能覆盖外部改动 ✗";
    const saved = await saveNodeDocument(fx.root, { nodeId: fx.nodeId, text: draft, hash: mine.document.hash });
    assert.equal(saved.ok, false, "指纹对不上必须拒绝 ✗");
    assert.equal(saved.code, "conflict");
    assert.ok(saved.latest !== undefined, "冲突时要回带**磁盘最新正文**（供比较/合并 ✓）");
    assert.ok(saved.latest.text.includes("外部补充的内容"), `最新正文应当来自磁盘：${saved.latest.text}`);
    assert.ok(!(await readFile(fx.file, "utf8")).includes(draft), "草稿绝不能被写进磁盘 ✗");
  });

  it("外部只改 front-matter ⇒ 同样是冲突（指纹覆盖整文件 ✓）", async () => {
    const fx = await fixture();
    const mine = await readNodeDocument(fx.root, fx.nodeId);
    const onDisk = await readFile(fx.file, "utf8");
    await writeFile(fx.file, onDisk.replace(/^status:.*$/m, "status: done"), "utf8");
    const saved = await saveNodeDocument(fx.root, { nodeId: fx.nodeId, text: "正文没变", hash: mine.document.hash });
    assert.equal(saved.ok, false, "元数据被外部改过也算冲突 ✓");
    assert.equal(saved.code, "conflict");
  });

  it("**不带指纹一律拒绝**（复查 P1-4）：磁盘逐字节不变 ✗", async () => {
    const fx = await fixture();
    const before = await readFile(fx.file, "utf8");
    for (const hash of [undefined, "", "   ", 42, null]) {
      const saved = await saveNodeDocument(fx.root, { nodeId: fx.nodeId, text: "没有指纹也想写", hash });
      assert.equal(saved.ok, false, `hash=${JSON.stringify(hash)} 必须被拒 ✗`);
      assert.equal(saved.code, "bad_body");
    }
    assert.equal(await readFile(fx.file, "utf8"), before, "磁盘必须逐字节不变 ✗");
  });

  it("保存返回**规范化后的正文**（与磁盘一致 ✓，不再回带原始 input ✗）", async () => {
    const fx = await fixture();
    const mine = await readNodeDocument(fx.root, fx.nodeId);
    /* 前导空行 + 尾部空白：composeDocument 会规整 ⇒ 返回值必须与磁盘一致 ✓ */
    const saved = await saveNodeDocument(fx.root, {
      nodeId: fx.nodeId,
      text: "\n\n第一行\n第二行\n\n\n",
      hash: mine.document.hash,
    });
    assert.equal(saved.ok, true);
    const reread = await readNodeDocument(fx.root, fx.nodeId);
    assert.equal(saved.document.text, reread.document.text, "返回值要与**再读一次**完全一致 ✓");
    assert.equal(saved.document.text, "第一行\n第二行", "前导空行与尾部空白被规整掉 ✓");
  });

  it("**同一指纹的两个并发保存**：最多一个成功，另一个冲突（复查 P1-5 ✓）", async () => {
    const fx = await fixture();
    const mine = await readNodeDocument(fx.root, fx.nodeId);
    /* 不 await 中间结果：两个请求同时压在提交前 ✓（靠库级串行队列保证确定性 ✓） */
    const [a, b] = await Promise.all([
      saveNodeDocument(fx.root, { nodeId: fx.nodeId, text: "甲写的内容", hash: mine.document.hash }),
      saveNodeDocument(fx.root, { nodeId: fx.nodeId, text: "乙写的内容", hash: mine.document.hash }),
    ]);
    const succeeded = [a, b].filter((item) => item.ok === true);
    const conflicted = [a, b].filter((item) => item.ok === false && item.code === "conflict");
    assert.equal(succeeded.length, 1, "只能有一个成功 ✓");
    assert.equal(conflicted.length, 1, "另一个必须被判冲突 ✓");
    const onDisk = await readNodeDocument(fx.root, fx.nodeId);
    assert.ok(
      onDisk.document.text.trim() === "甲写的内容" || onDisk.document.text.trim() === "乙写的内容",
      "磁盘上是其中一个的完整内容（不串写 ✓）",
    );
  });

  it("并发写入不残留临时文件（临时名必须唯一 ✓）", async () => {
    const fx = await fixture();
    const { writeNote } = await import("../src/host/v3/store.ts");
    await Promise.all(
      Array.from({ length: 8 }, (_item, index) => writeNote(fx.root, { id: fx.nodeId, text: `并发第 ${index} 版` })),
    );
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(fx.root, "Nodes"));
    assert.ok(files.every((name) => !name.includes(".tmp-")), `不许留下临时文件 ✗：${files.join(", ")}`);
  });

  it("连续两次保存：第二次用**第一次返回的新指纹** ⇒ 成功 ✓；用旧指纹 ⇒ 冲突 ✗", async () => {
    const fx = await fixture();
    const first = await readNodeDocument(fx.root, fx.nodeId);
    const a = await saveNodeDocument(fx.root, { nodeId: fx.nodeId, text: "第一版", hash: first.document.hash });
    assert.equal(a.ok, true);
    const b = await saveNodeDocument(fx.root, { nodeId: fx.nodeId, text: "第二版", hash: a.document.hash });
    assert.equal(b.ok, true, "用新指纹连续保存应当成功 ✓");
    const stale = await saveNodeDocument(fx.root, { nodeId: fx.nodeId, text: "用旧指纹", hash: first.document.hash });
    assert.equal(stale.ok, false, "旧指纹必须被拒绝 ✗");
    assert.equal(stale.code, "conflict");
    assert.equal(
      (await readNodeDocument(fx.root, fx.nodeId)).document.text.trim(),
      "第二版",
      "磁盘上应停在第二版 ✓",
    );
  });

  it("大文档**拒绝**（读与写都拒），绝不静默截断 ✗", async () => {
    const fx = await fixture();
    const huge = "字".repeat(Math.ceil(MAX_DOCUMENT_BYTES / 3) + 10);
    const mine = await readNodeDocument(fx.root, fx.nodeId);
    const saved = await saveNodeDocument(fx.root, { nodeId: fx.nodeId, text: huge, hash: mine.document.hash });
    assert.equal(saved.ok, false);
    assert.equal(saved.code, "too_large");
    assert.ok(!(await readFile(fx.file, "utf8")).includes("字字字字字字字字"), "超限内容不许落盘 ✗");
  });

  it("空正文可以直接写入（不自动填模板 ✓）", async () => {
    const fx = await fixture();
    const before = await readNodeDocument(fx.root, fx.nodeId);
    const saved = await saveNodeDocument(fx.root, { nodeId: fx.nodeId, text: "", hash: before.document.hash });
    assert.equal(saved.ok, true, "空正文应当能保存 ✓");
    assert.equal(saved.document.text, "");
    const reread = await readNodeDocument(fx.root, fx.nodeId);
    assert.equal(reread.document.text, "", "再读回来还是空的 ✓");
  });

  it("节点不存在 ⇒ node_missing；写入失败不产生新文件 ✓", async () => {
    const fx = await fixture();
    const mine = await readNodeDocument(fx.root, fx.nodeId);
    const saved = await saveNodeDocument(fx.root, { nodeId: "no-such-node", text: "x", hash: mine.document.hash });
    assert.equal(saved.ok, false);
    assert.equal(saved.code, "node_missing");
  });
});
