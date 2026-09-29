/**
 * 把插件需要复用的上游源码「字节一致」地同步进 dsh-plugin/（自包含约束）。
 *
 * 背景：本方案要求插件的全部代码都在 dsh-plugin/ 内，且不改动项目源码。
 * 因此上游文件只读、复制进 src/vendor/upstream/，并**镜像原始相对结构**，
 * 让副本之间的 `./paths.ts`、`../errors.ts` 相对导入继续成立。
 *
 * 唯一不是副本的是 src/vendor/upstream/store.ts（只导出 STATUS_DISPLAY 的替身，
 * 见该文件头部说明）。
 *
 * 本脚本只写入 dsh-plugin/ 内部，绝不写上游。
 * 用法：node scripts/sync-vendor.mjs [--check]
 *   --check  只校验副本与上游是否一致（不写文件），用于 CI/测试
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(SCRIPT_DIR, "..");
/**
 * 上游源码（KnowledgeNet）所在的父项目。插件独立成仓库后父目录不再是项目 ⇒
 * 用 `KN_PROJECT` 显式指定：
 *   $env:KN_PROJECT='D:\资料\file_useless\test\KnowledgeNet'; node scripts/sync-vendor.mjs --check
 */
const PROJECT_DIR = path.resolve(process.env.KN_PROJECT ?? path.join(PLUGIN_DIR, ".."));
const CHECK_ONLY = process.argv.includes("--check");

/** 上游文件 → 插件内副本（相对各自根目录），镜像原始相对结构 */
const FILE_MAP = [
  // 领域层：错误、类型、uuid、图算法
  ["src/data/errors.ts", "src/vendor/upstream/data/errors.ts"],
  ["src/data/types.ts", "src/vendor/upstream/data/types.ts"],
  ["src/data/chatTypes.ts", "src/vendor/upstream/data/chatTypes.ts"],
  ["src/data/uuid.ts", "src/vendor/upstream/data/uuid.ts"],
  ["src/data/engine.ts", "src/vendor/upstream/data/engine.ts"],
  // v2 开放文件模型（纯逻辑，依赖上面几个）
  ["src/data/v2/paths.ts", "src/vendor/upstream/data/v2/paths.ts"],
  ["src/data/v2/schema.ts", "src/vendor/upstream/data/v2/schema.ts"],
  ["src/data/v2/fs.ts", "src/vendor/upstream/data/v2/fs.ts"],
  ["src/data/v2/hash.ts", "src/vendor/upstream/data/v2/hash.ts"],
  ["src/data/v2/nodeMeta.ts", "src/vendor/upstream/data/v2/nodeMeta.ts"],
  ["src/data/v2/notes.ts", "src/vendor/upstream/data/v2/notes.ts"],
  ["src/data/v2/relations.ts", "src/vendor/upstream/data/v2/relations.ts"],
  ["src/data/v2/resources.ts", "src/vendor/upstream/data/v2/resources.ts"],
  ["src/data/v2/scanner.ts", "src/vendor/upstream/data/v2/scanner.ts"],
  // 二维聚焦视图与它自己依赖的模块
  ["src/graph/levels.ts", "src/vendor/upstream/graph/levels.ts"],
  ["src/components/GraphSpace.tsx", "src/vendor/upstream/components/GraphSpace.tsx"],
  ["src/components/icons.tsx", "src/vendor/upstream/components/icons.tsx"],
  ["src/components/graphMode.ts", "src/vendor/upstream/components/graphMode.ts"],
  ["src/components/nodeContextMenu.ts", "src/vendor/upstream/components/nodeContextMenu.ts"],
  ["src/styles/graph.css", "src/vendor/upstream/styles/graph.css"],
  // 三维空间视图：组件 + 引擎/渲染/布局全套（含 worker 内核与它的类型声明）
  ["src/components/GraphUniverse.tsx", "src/vendor/upstream/components/GraphUniverse.tsx"],
  ["src/graph3d/adapter.ts", "src/vendor/upstream/graph3d/adapter.ts"],
  ["src/graph3d/camera.ts", "src/vendor/upstream/graph3d/camera.ts"],
  ["src/graph3d/engine.ts", "src/vendor/upstream/graph3d/engine.ts"],
  ["src/graph3d/forces.ts", "src/vendor/upstream/graph3d/forces.ts"],
  ["src/graph3d/labels.ts", "src/vendor/upstream/graph3d/labels.ts"],
  ["src/graph3d/layoutCore.ts", "src/vendor/upstream/graph3d/layoutCore.ts"],
  ["src/graph3d/layout.worker.ts", "src/vendor/upstream/graph3d/layout.worker.ts"],
  ["src/graph3d/layoutClient.ts", "src/vendor/upstream/graph3d/layoutClient.ts"],
  ["src/graph3d/navigation.ts", "src/vendor/upstream/graph3d/navigation.ts"],
  ["src/graph3d/palette.ts", "src/vendor/upstream/graph3d/palette.ts"],
  ["src/graph3d/renderer.ts", "src/vendor/upstream/graph3d/renderer.ts"],
  ["src/graph3d/session.ts", "src/vendor/upstream/graph3d/session.ts"],
  ["src/graph3d/topology.ts", "src/vendor/upstream/graph3d/topology.ts"],
  ["src/graph3d/types.ts", "src/vendor/upstream/graph3d/types.ts"],
  ["src/graph3d/d3-force-3d.d.ts", "src/vendor/upstream/graph3d/d3-force-3d.d.ts"],
];

/** 目录整体镜像（测试夹具，让测试也自包含） */
const TREE_MAP = [["fixtures/v2", "tests/fixtures/v2"]];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(abs, base)));
    else out.push(path.relative(base, abs).replaceAll("\\", "/"));
  }
  return out;
}

function assertInsidePlugin(abs) {
  const rel = path.relative(PLUGIN_DIR, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`拒绝写入插件目录之外：${abs}`);
  }
}

async function buildPlan() {
  const plan = [];
  for (const [fromRel, toRel] of FILE_MAP) {
    const from = path.join(PROJECT_DIR, fromRel);
    const to = path.join(PLUGIN_DIR, toRel);
    assertInsidePlugin(to);
    await stat(from).catch(() => {
      throw new Error(
        `上游文件不存在：${fromRel}（是否改过 src/ 结构？当前上游根目录：${PROJECT_DIR}；`
        + "若插件已独立成仓库，请用 KN_PROJECT 指向 KnowledgeNet 项目）",
      );
    });
    plan.push({ fromRel, toRel, from, to });
  }
  for (const [fromRel, toRel] of TREE_MAP) {
    const fromRoot = path.join(PROJECT_DIR, fromRel);
    const toRoot = path.join(PLUGIN_DIR, toRel);
    assertInsidePlugin(toRoot);
    const files = await walk(fromRoot);
    for (const file of files) {
      plan.push({
        fromRel: `${fromRel}/${file}`,
        toRel: `${toRel}/${file}`,
        from: path.join(fromRoot, file),
        to: path.join(toRoot, file),
      });
    }
  }
  return plan.sort((a, b) => a.toRel.localeCompare(b.toRel));
}

const plan = await buildPlan();
const records = {};
let copied = 0;
let drift = 0;

for (const item of plan) {
  const upstream = await readFile(item.from);
  const upstreamHash = sha256(upstream);
  const current = await readFile(item.to).catch(() => null);
  const currentHash = current === null ? null : sha256(current);

  if (CHECK_ONLY) {
    if (currentHash !== upstreamHash) {
      drift += 1;
      console.error(
        `[drift] ${item.toRel}\n  上游 ${item.fromRel} = ${upstreamHash}\n  副本 = ${currentHash ?? "(缺失)"}`,
      );
    }
    continue;
  }

  if (currentHash !== upstreamHash) {
    await mkdir(path.dirname(item.to), { recursive: true });
    await copyFile(item.from, item.to);
    copied += 1;
  }
  records[item.toRel] = { from: item.fromRel, sha256: upstreamHash, bytes: upstream.byteLength };
}

if (CHECK_ONLY) {
  if (drift > 0) {
    console.error(`\n${drift} 个副本与上游不一致，运行：node scripts/sync-vendor.mjs`);
    process.exit(1);
  }
  console.log(`vendor 一致：${plan.length} 个文件`);
} else {
  const manifestPath = path.join(PLUGIN_DIR, "scripts/vendor-manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify({ upstreamRoot: "..", files: records }, null, 2)}\n`,
    "utf8",
  );
  console.log(`vendor 同步完成：${plan.length} 个文件，更新 ${copied} 个，清单 ${path.relative(PLUGIN_DIR, manifestPath)}`);
}
