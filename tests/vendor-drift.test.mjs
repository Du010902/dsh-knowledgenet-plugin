/**
 * vendor 漂移检测。
 *
 * 「插件代码全在 dsh-plugin/ 内」是用**副本**换来的，代价是上游改了 `src/data/v2/*`
 * 之后副本会过时。这个测试把代价变成一次响亮的失败，并给出修复命令。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");
const PROJECT = path.resolve(PLUGIN, "..");

const manifest = JSON.parse(await readFile(path.join(PLUGIN, "scripts", "vendor-manifest.json"), "utf8"));

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

describe("vendor 副本与上游一致", () => {
  const entries = Object.entries(manifest.files);

  it("清单非空，且覆盖领域层与画布", () => {
    assert.ok(entries.length >= 60, `清单只有 ${entries.length} 项，疑似同步不完整`);
    const rels = entries.map(([rel]) => rel);
    assert.ok(rels.includes("src/vendor/upstream/data/v2/scanner.ts"));
    assert.ok(rels.includes("src/vendor/upstream/components/GraphSpace.tsx"));
    assert.ok(rels.includes("src/vendor/upstream/styles/graph.css"));
  });

  for (const [rel, record] of entries) {
    it(`${rel} 与 ${record.from} 一致`, async () => {
      const copy = await readFile(path.join(PLUGIN, rel));
      assert.equal(sha256(copy), record.sha256, `${rel} 的副本与清单不符，运行 npm run sync`);

      const upstreamPath = path.join(PROJECT, record.from);
      let upstream;
      try {
        upstream = await readFile(upstreamPath);
      } catch {
        // 插件被单独拷走（没有上游仓库）时，只能校验副本自身与清单
        return;
      }
      assert.equal(
        sha256(upstream),
        record.sha256,
        `上游 ${record.from} 已经变了，副本过时：运行 node scripts/sync-vendor.mjs 重新同步`,
      );
    });
  }
});
