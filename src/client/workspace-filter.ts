/**
 * 读侧栏「筛选会话」当前选的是哪一种（隐藏已归档 / 全部对话 / 仅显示已归档）。
 *
 * 为什么需要（用户要求）：节点历史里记着的对话可能**已经被归档**——归档后宿主根本不让打开
 * （点一下毫无反应），可它照样列在节点历史里就说不通了。用户的要求是
 * **「归档的会话跟随工作区的筛选规则」** ⇒ 节点历史得知道侧栏现在选的是哪一种。
 *
 * 为什么去 localStorage 读而不是问服务：这个筛选值是 ui-workspace **会话作用域的 slot store**
 * （`useStore(s => s.archivedFilter)`），宿主没有把它挂到任何 `ctx.get(...)` 的服务面上，
 * 只按 `dsh.workspace.view.v5` 整值 JSON 落进 localStorage（`dsh-client-store` 的 persist ✓）。
 * 所以这里**只读**那个键：认不出来就按宿主的默认值 `default`（隐藏已归档）处理 ✓。
 *
 * 兼容策略：键名带版本号（`v5`），所以按前缀 `dsh.workspace.view` 找、取版本最高的那个，
 * 并在 JSON 里**按字段名**找 `archivedFilter`（不假设它一定在顶层）⇒ 宿主升版本也不会瞎 ✓。
 */

/** 侧栏「筛选会话」的三种模式（取值与宿主 ui-workspace 的 `ArchivedFilter` 一致 ✓） */
export type ArchivedFilter = "default" | "show" | "only";

/** 宿主持久化用的键前缀（`<前缀>.v5` 这种） */
const KEY_PREFIX = "dsh.workspace.view";

/** 递归找字段的最大深度（快照是扁的，给足余量即可 ✓） */
const MAX_DEPTH = 4;

function coerce(value: unknown): ArchivedFilter | null {
  return value === "default" || value === "show" || value === "only" ? value : null;
}

/** 在 JSON 值里按字段名找 `archivedFilter`（不假设层级 ✓） */
function findFilter(value: unknown, depth: number): ArchivedFilter | null {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const direct = coerce(record.archivedFilter);
  if (direct !== null) return direct;
  for (const child of Object.values(record)) {
    const found = findFilter(child, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * 读当前选中的归档筛选。
 * @param storage - 存储对象（默认 `localStorage`；测试可以直接传假的 ✓）。
 * @returns 三种模式之一；没得读 / 读不懂时返回宿主的默认值 `"default"` ✓。
 */
export function readArchivedFilter(storage?: Pick<Storage, "length" | "key" | "getItem"> | null): ArchivedFilter {
  const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  if (store === null || store === undefined) return "default";
  const candidates: Array<{ key: string; raw: string }> = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key === null || !key.startsWith(KEY_PREFIX)) continue;
      const raw = store.getItem(key);
      if (raw !== null) candidates.push({ key, raw });
    }
  } catch {
    return "default";
  }
  /* 版本号大的优先（v5 → v6 也能跟上 ✓；`numeric` 让 v10 > v9 ✓） */
  candidates.sort((left, right) => left.key.localeCompare(right.key, undefined, { numeric: true }));
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const found = findFilter(JSON.parse(candidates[index]!.raw), 0);
      if (found !== null) return found;
    } catch {
      // 这条键不是合法 JSON：试下一条（宿主的键坏了不该影响我们 ✓）
    }
  }
  return "default";
}
