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
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { readNodeDocument, saveNodeDocument, MAX_DOCUMENT_BYTES } from "../src/host/node-document.ts";
import { parseDocument } from "../src/host/v3/frontmatter.ts";
import { cleanupFixtures, makeV3Fixture } from "./support/v3-fixture.mjs";

after(async () => {
  await cleanupFixtures();
});

/** 夹具：一个 v3 库 + 一个叫「注意力机制」的节点 ✓ */
async function fixture() {
  const fx = await makeV3Fixture({ nodes: ["注意力机制"] });
  const node = fx.nodes["注意力机制"];
  return { ...fx, nodeId: node.id, file: join(fx.root, node.relativePath) };
}

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
