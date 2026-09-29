/**
 * 「插件内容只在知识库里可见」的**判定逻辑**（轻量模块：只依赖 node:fs/node:path，便于单测）。
 *
 * 目标（用户要求）：**只有用「添加知识库」按钮登记过的工作区**，其会话才能看到插件的提示词与 `kn_*` 工具；
 * 普通工作区（哪怕目录里就有 `library.json`）一律看不到。
 *
 * 机制（来自 harness `packages/core/tools/lib/types/index.d.ts`）：
 * - `tools.register(definition)` 是**全局**注册（所有会话都能看到）；
 * - `tools.restrict({ deny: [...] })` 是**按 agent 作用域**过滤全局工具（"Restrict global tools
 *   for the calling agent scope"）⇒ 在 agent 作用域调用它，就能只对该会话隐藏。
 *
 * 所以判定必须**同步**、且在 `agent/created` 时立刻给出（否则首轮会漏出去）：这里用
 * `existsSync` 向上找 `library.json`，最多 16 层，不做任何耗时扫描。
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { LIBRARY_FILE } from "../vendor/upstream/data/v2/paths.ts";
/** 知识库所在的工作区子目录名（与 library.ts 的 KNOWLEDGE_DIR 保持一致） */
const KNOWLEDGE_DIR = ".dsh_knowledge";

/** 向上查找的最大层数（与 library.ts 的 resolveLibraryRoot 保持一致） */
export const MAX_UPWARD = 16;

/** 可注入的探测面（测试用；默认用 node:fs 的 existsSync） */
export interface IsolationProbe {
  exists?: (absolutePath: string) => boolean;
  isAbsolute?: (path: string) => boolean;
}

/**
 * 某个目录（或其祖先，最多 `MAX_UPWARD` 层）里的**知识库根**。
 *
 * 新模型（用户设计，**不做兼容**）：库只可能在 `<工作区>/.dsh_knowledge/`；
 * 工作区根目录里就算有 library.json 也不认（"一个工作区 = 一个知识库"，边界清晰）。
 * 这几行刻意与 `library.ts` 的 `libraryRootCandidates` 保持一致——本模块必须只依赖
 * node:fs/node:path，不能引入 library.ts 的重量级依赖。
 *
 * @param dir - 起始目录。
 * @param probe - 可注入的探测面。
 * @returns 找到库根则返回它；否则 undefined。
 */
export function findLibraryRootSync(dir: string, probe: IsolationProbe = {}): string | undefined {
  const exists = probe.exists ?? existsSync;
  if (typeof dir !== "string" || dir.trim() === "") return undefined;
  let current = resolve(dir.trim());
  for (let depth = 0; depth < MAX_UPWARD; depth += 1) {
    const candidate = join(current, KNOWLEDGE_DIR);
    if (exists(join(candidate, LIBRARY_FILE))) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/**
 * **这个会话的工作区有没有知识库**——决定要不要暴露提示词与工具。
 *
 * 新模型下判据变成"目录自描述"：`<工作区>/.dsh_knowledge/library.json` 存在即启用
 * （或工作区根本身就是库，兼容独立知识库工作区）。没有 ⇒ 按普通工作区对待。
 * 于是不再需要登记表、客户端同步、自动清理那一整套 ✓。
 *
 * @param cwd - 会话工作目录。
 * @param probe - 可注入的探测面。
 * @returns true = 这个工作区有知识库（工具与提示词可见）。
 */
export function isLibrarySession(cwd: string | undefined, probe: IsolationProbe = {}): boolean {
  const exists = probe.exists ?? existsSync;
  if (typeof cwd !== "string" || cwd.trim() === "") return false;
  return findLibraryRootSync(cwd, { exists, isAbsolute: probe.isAbsolute }) !== undefined;
}
