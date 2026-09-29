/**
 * 「在选定位置新建文件夹」的测试。
 *
 * 它是「创建知识库」的第一步，也是实际翻车过的一步——失败时**原因必须能带回来**
 * （先前走客户端 Service，异常被吞掉，界面只能说"新建文件夹失败"）。这里钉住：
 * 正常新建、已存在、名字非法、父目录不存在、空参数，且失败时**不留下半个目录**。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createSubdirectory } from "../src/host/create-dir.ts";

const exists = (path) => stat(path).then(() => true).catch(() => false);

describe("新建知识库文件夹", () => {
  it("在位置下新建一层目录，返回绝对路径", async () => {
    const parent = await mkdtemp(join(tmpdir(), "kn-mkdir-"));
    const result = await createSubdirectory({ parent, name: "我的新库" });
    assert.equal(result.ok, true);
    assert.equal(result.path, join(parent, "我的新库"));
    assert.equal(await exists(join(parent, "我的新库")), true);
    // 新目录是空的（宿主初始化知识库要求空目录）
    assert.deepEqual(await readdir(join(parent, "我的新库")), []);
  });

  it("同名目录已存在 → 报 exists（不能静默复用别人的目录）", async () => {
    const parent = await mkdtemp(join(tmpdir(), "kn-mkdir-"));
    await mkdir(join(parent, "已存在"));
    const result = await createSubdirectory({ parent, name: "已存在" });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "exists");
    assert.match(result.error?.message ?? "", /已存在/);
  });

  it("名字含分隔符/保留字符 → 报 name_invalid，且什么都不建", async () => {
    const parent = await mkdtemp(join(tmpdir(), "kn-mkdir-"));
    for (const bad of ["a/b", "a\\b", "a:b", "a?b", 'a"b', "a<b", "a|b"]) {
      const result = await createSubdirectory({ parent, name: bad });
      assert.equal(result.ok, false, `应拒绝：${bad}`);
      assert.equal(result.error?.code, "name_invalid");
    }
    assert.deepEqual(await readdir(parent), [], "不该建出任何东西");
  });

  it("父目录不存在/不是目录 → 报 parent_missing", async () => {
    const parent = await mkdtemp(join(tmpdir(), "kn-mkdir-"));
    const missing = await createSubdirectory({ parent: join(parent, "没有这个"), name: "x" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "parent_missing");
    const empty = await createSubdirectory({ parent: "", name: "x" });
    assert.equal(empty.error?.code, "parent_required");
    const noName = await createSubdirectory({ parent, name: "  " });
    assert.equal(noName.error?.code, "name_required");
  });
});
