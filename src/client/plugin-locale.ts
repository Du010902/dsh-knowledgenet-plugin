/**
 * **插件自己的翻译函数** ✓（用户实测：英文界面下插件仍然是中文 ✗ ——
 * "当前插件的语言似乎没有跟随系统变化"✓）。
 *
 * ## 为什么不能只靠宿主注入的 `t`
 *
 * 实测：把宿主语言切成**英文**之后，插件芯片仍然显示「图谱」✗，
 * 而我们的英文字典里 **确实** 有 `tabShort: "Graph"` ✓
 * ⇒ 那个 `t` 没能把我们的命名空间解析出来 ✓（注册时机或命名空间没落到组件上 ✓）。
 *
 * ## 做法
 *
 * 自己 `bind` 一次 ✓：`locale.bind(ns)` 返回的函数**在调用时读当前语言** ✓
 * ⇒ 语言切过去之后**下一次渲染**就是新语言 ✓，不需要任何缓存失效 ✓。
 *
 * ## 注册时机（这是之前真正的坑 ✗）
 *
 * 插件可能**先于** locale 服务 apply ✓（`ctx.get("locale")` 那一刻还是 `undefined` ✗）——
 * 旧实现一次失败就 `return undefined` ✗ ⇒ 字典**永远没注册上** ✗ ⇒ 全插件回落到中文字面文案 ✓
 * （英文界面里满屏中文 ✓，正是用户截图 ✓）。
 * 现在改成：**每次取用时补试一次** ✓，直到注册成功 ✓。
 *
 * 另外把宿主**已声明的语言 id** 也各注册一份 ✓（`en-US` / `zh-CN` 这类 id 也能命中 ✓，
 * 不再只认裸 `"en"` / `"zh"` ✗）。重复注册会抛 ✓ ⇒ **按语言逐个记成功状态** ✓，不整批重来 ✓。
 *
 * 本文件只有纯逻辑 ✓（不碰 DOM / React ✓）⇒ 可以直接单测 ✓。
 */
import type { LocaleServiceLike } from "./locale-choice.ts";

/** 一个可翻译函数 ✓（`bind` 的返回值 ✓） */
export type PluginTranslate = (key: string) => string;

/** 宿主 locale 服务里我们用到的那几个方法 ✓（其余与本插件无关 ✓） */
export interface PluginLocaleService extends LocaleServiceLike {
  /** 注册一份字典 ✓ */
  register?(ns: string, locale: string, dict: Record<string, string>): unknown;
  /** 绑定命名空间 ⇒ 一个**在调用时**读当前语言的翻译函数 ✓ */
  bind?(ns: string): PluginTranslate;
  /** 当前快照（`locales` 里是宿主已声明的语言 id ✓） */
  getLocale?(): { active?: string; locales?: ReadonlyArray<{ id?: string }> } | undefined;
}

/** 插件登记进来的东西 ✓ */
interface Registration {
  /** 现读服务（**不缓存** ✓ —— 服务可能比插件晚到 ✓） */
  service: () => PluginLocaleService | undefined;
  /** 命名空间 ✓ */
  ns: string;
  /** 中文字典 ✓ */
  zh: Record<string, string>;
  /** 英文字典 ✓ */
  en: Record<string, string>;
  /** 已经成功注册过的 `(ns, locale)` ✓（重复注册会抛 ✓） */
  done: Set<string>;
  /** 绑定好的翻译函数（拿到 `bind` 之后才有 ✓） */
  bound: PluginTranslate | null;
}

let registration: Registration | null = null;

/**
 * 把插件的中英字典登记进来 ✓（`apply` 里调一次 ✓）。
 *
 * @param service - 现读宿主 locale 服务的函数 ✓（每次调用都重新取 ✓，不缓存 ✓）。
 * @param ns - 命名空间 ✓。
 * @param zh - 中文字典 ✓。
 * @param en - 英文字典 ✓。
 */
export function attachPluginLocale(
  service: () => PluginLocaleService | undefined,
  ns: string,
  zh: Record<string, string>,
  en: Record<string, string>,
): void {
  registration = { service, ns, zh, en, done: new Set(), bound: null };
}

/** 语言 id 是不是中文 ✓（`zh` / `zh-CN` / `ZH-hans` 都算 ✓） */
function isZhLocale(id: string): boolean {
  return id.toLowerCase().startsWith("zh");
}

/**
 * 该注册的 `(ns, locale)` 清单 ✓：先裸 `zh`/`en` ✓，再把宿主已声明的 id 逐个补上 ✓。
 *
 * @param declared - 宿主快照里的语言 id ✓。
 * @returns 去重后的 `[locale, dict]` 列表 ✓。
 */
export function localeRegistrations(
  declared: readonly string[],
  zh: Record<string, string>,
  en: Record<string, string>,
): Array<[string, Record<string, string>]> {
  const out: Array<[string, Record<string, string>]> = [["zh", zh], ["en", en]];
  const seen = new Set(out.map(([locale]) => locale));
  for (const id of declared) {
    const locale = typeof id === "string" ? id.trim() : "";
    if (locale === "" || seen.has(locale)) continue;
    seen.add(locale);
    out.push([locale, isZhLocale(locale) ? zh : en]);
  }
  return out;
}

/**
 * 尽量把字典注册上、并拿到翻译函数 ✓（**幂等** ✓，可以每次取用时都调 ✓）。
 *
 * @returns 翻译函数；服务还没到 / 注册被拒 ⇒ `null` ✓（调用方回落到字面文案 ✓）。
 */
export function pluginTranslate(): PluginTranslate | null {
  const current = registration;
  if (current === null) return null;
  if (current.bound !== null) return current.bound;
  const service = current.service();
  if (service?.register === undefined) return null;
  let declared: string[] = [];
  try {
    declared = (service.getLocale?.()?.locales ?? [])
      .map((item) => (typeof item?.id === "string" ? item.id : ""))
      .filter((id) => id !== "");
  } catch {
    declared = [];
  }
  for (const [locale, dict] of localeRegistrations(declared, current.zh, current.en)) {
    if (current.done.has(locale)) continue;
    try {
      service.register(current.ns, locale, dict);
      current.done.add(locale);
    } catch {
      /* 重名 / 这门外语宿主不认 ✓ ⇒ 跳过这一门 ✓，下次再试 ✓（其它语言继续 ✓） */
    }
  }
  if (typeof service.bind === "function") {
    try {
      current.bound = service.bind(current.ns);
    } catch {
      current.bound = null;
    }
  }
  return current.bound;
}

/**
 * 现在是不是中文界面 ✓（读宿主快照的 `active` ✓）。
 *
 * 给"必须在注册时就定下来"的文案用 ✓（标签定义里的芯片名 / 引导卡标题 ✓ ——
 * 它们只在注册那一刻算一次 ✗，所以之前用 `document.documentElement.lang` 猜 ✗
 * ⇒ 英文界面里显示中文 ✓，用户实测 ✓）。
 *
 * @returns `true` / `false`；拿不到 ⇒ `undefined` ✓（调用方自己兜底 ✓）。
 */
export function pluginIsZh(): boolean | undefined {
  const current = registration;
  if (current === null) return undefined;
  try {
    const active = current.service()?.getLocale?.()?.active;
    if (typeof active !== "string" || active.trim() === "") return undefined;
    return active.trim().toLowerCase().startsWith("zh");
  } catch {
    return undefined;
  }
}

/** 只给测试用：清掉登记状态 ✓ */
export function resetPluginLocaleForTests(): void {
  registration = null;
}
