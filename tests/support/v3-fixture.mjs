/**
 * v3 测试夹具：造一个"工作区 + `.dsh_knowledge` 里的 v3 库"。
 *
 * 为什么不复用老的 v2 夹具：新模型**只认 v3** ✓（一节点一个 markdown、身份是 front-matter 的 ULID）。
 * 直接把 v2 文件夹夹具搬过来只会得到 `unsupported_format` ✗ —— 所以夹具按真实使用方式造：
 * 先 `createLibrary`（与面板"首次静默创建"同一条路径 ✓），再用 v3 store 建点/连边 ✓。
 *
 * 注意：这是 `.mjs`，**不能出现任何 TS 语法**（类型注解/interface/type 导入 ✗）。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addEdge, createLibrary, createNode } from "../../src/host/v3/store.ts";

const created = [];

/** 测试结束时统一清理（避免 tmp 里堆垃圾） */
export async function cleanupFixtures() {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
}

/**
 * 造一个 v3 库；seed 里可以顺手建点与连边。
 * @param {{ nodes?: string[], edges?: Array<[string, string]> }} [seed] nodes = 要建的标题；edges = [依赖方, 前置] 标题对。
 * @param {string} [prefix] 临时目录前缀。
 * @returns {Promise<{ workspace: string, root: string, nodes: Record<string, object> }>}
 */
export async function makeV3Fixture(seed = {}, prefix = "kn-v3fx-") {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  created.push(workspace);
  const root = join(workspace, ".dsh_knowledge");
  await mkdir(root, { recursive: true });

  const library = await createLibrary(root, "测试库");
  if (!library.ok) throw new Error(`夹具建库失败：${library.code} ${library.message}`);

  const nodes = {};
  for (const title of seed.nodes ?? []) {
    const made = await createNode(root, { title, note: `${title} 的笔记` });
    if (!made.ok) throw new Error(`夹具建点失败：${made.code} ${made.message}`);
    nodes[title] = made.node;
  }
  for (const [from, to] of seed.edges ?? []) {
    const fromNode = nodes[from];
    const toNode = nodes[to];
    if (fromNode === undefined || toNode === undefined) continue;
    await addEdge(root, { fromId: fromNode.id, toId: toNode.id, description: `${from} 需要 ${to}` });
  }

  return { workspace, root, nodes };
}
