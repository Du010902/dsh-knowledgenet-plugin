/**
 * 「当前是不是中文」的**唯一判据**。
 *
 * 为什么单独一个模块：这条判据出过一次真实的错 —— 我读的是宿主 locale 快照的 `.id`，
 * 而 `packages/client/locale` 的 `LocaleSnapshot` 字段叫 **`active`**（`{ active, locales, revision }`）。
 * `.id` 永远是 `undefined` ⇒ 判定失败 ⇒ 回落到"猜浏览器语言" ⇒ **中文界面里弹窗是英文**（用户反馈 ✗）。
 *
 * 抽成纯函数还带来两个好处：① 可以直接单测（不用起 React/宿主）；② 调用点不再各自复制一套判定逻辑。
 *
 * 约定：
 * - 只认 `active`，**不认识 `.id`** —— 读错字段的代价见上；
 * - 支持 `zh` / `zh-CN` / `ZH-hans` 这类带地区或大小写的中文标签 ✓；
 * - 拿不到 id 时返回 `undefined`（让调用方自己兜底），**而不是硬猜成英文** ✓。
 */

/** 宿主 locale 快照里我们用到的那一个字段（其余字段与本插件无关） */
export interface LocaleSnapshotLike {
  /** 当前语言 id，例如 `zh` / `zh-CN` / `en`（宿主 `LocaleSnapshot.active`） */
  active?: string;
}

/** 宿主 locale 服务（只声明用到的方法，避免依赖宿主包的类型） */
export interface LocaleServiceLike {
  getLocale?(): LocaleSnapshotLike | undefined;
}

/**
 * 快照是不是中文。
 * @param snapshot - 宿主 locale 快照（允许为空或形状不认识）。
 * @returns `true` = 中文；`false` = 明确不是中文；`undefined` = 拿不到 id（交给调用方兜底）。
 */
export function isZhSnapshot(snapshot: LocaleSnapshotLike | null | undefined): boolean | undefined {
  const active = typeof snapshot?.active === "string" ? snapshot.active.trim() : "";
  if (active === "") return undefined;
  return active.toLowerCase().startsWith("zh");
}

/**
 * 问宿主 locale 服务"当前是不是中文"。
 * @param service - `ctx.get("locale")` 拿到的服务（缺失/API 变了/抛错都算拿不到）。
 * @returns 同 {@link isZhSnapshot}：`true` / `false` / `undefined`。
 */
export function readZh(service: LocaleServiceLike | null | undefined): boolean | undefined {
  try {
    return isZhSnapshot(service?.getLocale?.());
  } catch {
    // 宿主服务抛错不该让插件挂掉：当成"拿不到"，由调用方兜底
    return undefined;
  }
}
