/**
 * **Vue 的编译期特性开关**（用户实测 2026-10-11：控制台里那条
 * `Feature flags __VUE_OPTIONS_API__, __VUE_PROD_DEVTOOLS__, __VUE_PROD_HYDRATION_MISMATCH_DETAILS__ …` 警告 ✗）。
 *
 * Crepe 内联进来的是 Vue 的 **esm-bundler** 构建 ✓ ⇒ 它要求这三个全局量在**打包期**被替换掉 ✗，
 * 否则运行时 `initFeatureFlags()` 会 `console.warn` 一遍（值本身有兜底 ✓：`OPTIONS_API` 默认 `true`、
 * 另两个默认 `false` ✓）。我们在 `build.mjs` 的 `transform.define` 里注入**那三个兜底值** ✓
 * ⇒ 运行时行为一模一样 ✓，警告消失 ✓（另两个 `false` 顺带把 devtools / hydration 的代码摇掉 ✓）。
 *
 * 这里钉两件事：① 构建期确实注入了 ✓；② **产物里不再有裸标识符**、那条警告分支已经被摇成空数组 ✓
 * （只看构建脚本会被"写了但没生效"骗过去 ✗，所以要连着产物一起看 ✓）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const build = await readFile(path.join(ROOT, "build.mjs"), "utf8");
const client = await readFile(path.join(ROOT, "client.js"), "utf8");

/** 三个开关与它们的兜底值 ✓（顺序：Vue 源码里 `initFeatureFlags` 检查的那三个 ✓） */
const FLAGS = [
  ["__VUE_OPTIONS_API__", "true"],
  ["__VUE_PROD_DEVTOOLS__", "false"],
  ["__VUE_PROD_HYDRATION_MISMATCH_DETAILS__", "false"],
];

describe("Vue 特性开关：构建期注入 ✓", () => {
  it("三个开关都显式定义成 Vue 自己的兜底值（⇒ 行为不变，只去掉警告 ✓）", () => {
    for (const [flag, value] of FLAGS) {
      assert.ok(
        build.includes(`${flag}: "${value}"`),
        `build.mjs 要在客户端构建里注入 ${flag}: ${JSON.stringify(value)} ✓（缺一个就还会警告 ✗）`,
      );
    }
    assert.ok(
      /transform:\s*\{[\s\S]{0,900}__VUE_OPTIONS_API__/.test(build),
      "要注入在 `transform.define` 里 ✓（rolldown 的 InputOptions 不吃顶层 `define` ✗，见文件里的老注释 ✓）",
    );
  });
});

describe("Vue 特性开关：产物侧证据 ✓", () => {
  it("产物里没有裸标识符（define 真生效了 ✓，不是写了个寂寞 ✗）", () => {
    for (const [flag] of FLAGS) {
      assert.ok(!client.includes(`typeof ${flag}`), `${flag} 不该以裸标识符留在产物里 ✗`);
      assert.ok(!client.includes(`${flag} !==`), `${flag} 不该以裸标识符留在产物里 ✗`);
      assert.ok(!client.includes(`getGlobalThis().${flag}`), `${flag} 的运行时兜底分支也该被摇掉 ✓`);
    }
  });

  it("那条警告分支已经被摇空（`needWarn` 不再有任何 push ✓）", () => {
    const at = client.indexOf("function initFeatureFlags");
    assert.notEqual(at, -1, "Vue 的 initFeatureFlags 应该还在（它是运行时的一部分 ✓）");
    const body = client.slice(at, at + 600);
    assert.ok(body.includes("const needWarn = []"), "要有那个警告数组 ✓");
    assert.ok(
      !body.includes("needWarn.push"),
      "三个开关都在构建期注入 ⇒ 不该再往 needWarn 里 push（有 push 就会警告 ✗）",
    );
  });

  it("宿主半与客户端半都不再引用这些标识符（内联的 Vue 只在客户端半 ✓）", async () => {
    const host = await readFile(path.join(ROOT, "index.js"), "utf8");
    for (const [flag] of FLAGS) {
      assert.ok(!host.includes(`typeof ${flag}`), `宿主半不该有 ${flag} ✗`);
    }
  });
});
