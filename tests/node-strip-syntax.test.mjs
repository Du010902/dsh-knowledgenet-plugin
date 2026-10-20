/**
 * **Node 类型剥离（strip-only）兼容性守卫** ✓。
 *
 * 背景：本仓库的单测用 `node --test` 直接 import `.ts` 源文件 ✓ —— Node 的类型剥离模式
 * **不支持** TypeScript 的"运行时语法"（参数属性 / enum / namespace / `import =` / 装饰器）✗，
 * 命中时整个测试文件会在加载阶段 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` 直接炸 ✗
 * （真实踩过：`learning-state.ts` 的 `constructor(private readonly …)` 让 3 个测试文件全红 ✓）。
 *
 * 这里把"允许被单测直接 import 的源码"（`src/**`，**排除逐字节冻结的 `src/vendor/upstream/`** ✓）
 * 扫一遍 ✓：一旦有人再写回去，这里先红，而不是等某个测试文件神秘加载失败 ✓。
 *
 * 为什么排除 vendor ✗：那是上游的逐字节副本（`scripts/sync-vendor.mjs` 校验一致 ✓），
 * 不能手改 ✓；其中的参数属性只有被单测直接 import 时才会炸 ✓（当前没有 ✓）。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");
const SRC = path.join(PLUGIN, "src");

/** 递归列出 `.ts`（不含 `.tsx` —— 单测不 import TSX ✓） */
async function listTsFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "vendor") continue; /* 上游冻结副本 ⇒ 不扫 ✓ */
      files.push(...await listTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/** 去掉注释再匹配（否则注释里举例的 `constructor(private …)` 会误报 ✗） */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** strip-only 模式不支持的几种语法 ✓（只列"运行期必须被剥掉/改写"的那几种 ✓） */
const FORBIDDEN = [
  {
    name: "构造参数属性（constructor(private/public/protected/readonly …)）",
    pattern: /constructor\s*\([^)]*\b(?:private|public|protected|readonly)\s+[A-Za-z_$]/,
  },
  { name: "enum", pattern: /^\s*(?:export\s+)?(?:const\s+)?enum\s+[A-Za-z_$]/m },
  { name: "namespace", pattern: /^\s*(?:export\s+)?namespace\s+[A-Za-z_$]/m },
  { name: "import = / export =", pattern: /^\s*(?:import\s+[A-Za-z_$][\w$]*\s*=|export\s*=)/m },
];

describe("Node strip-only 兼容性", () => {
  it("非 vendor 的 src/**/*.ts 里没有 strip-only 不支持的语法", async () => {
    const files = await listTsFiles(SRC);
    assert.ok(files.length > 50, `扫描到的 .ts 文件太少（${files.length}）⇒ 路径可能错了`);
    const offenders = [];
    for (const file of files) {
      const source = stripComments(await readFile(file, "utf8"));
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(source)) {
          offenders.push(`${path.relative(PLUGIN, file).replaceAll("\\", "/")}：${name}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "单测会用 Node 的类型剥离模式直接 import 这些文件 ⇒ 写入下面语法会让测试文件加载失败 ✗\n"
      + "（显式字段 + 赋值即可等价替代参数属性 ✓）\n"
      + offenders.join("\n"),
    );
  });
});
