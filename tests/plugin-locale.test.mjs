/**
 * **插件语言跟随系统** ✓（用户实测："当前插件的语言似乎没有跟随系统变化"✗）。
 *
 * 实测到的两件事：
 * ① 宿主语言切到英文后，插件芯片仍显示「图谱」✗ —— 而英文字典里明明有 `tabShort: "Graph"` ✓
 *    ⇒ 注入的 `t` 没能解析出我们的命名空间 ✓；
 * ② 旧 `registerLocale` **一次失败就放弃** ✗ —— 插件可能先于 locale 服务 apply ✓
 *    ⇒ 字典永远没注册上 ✓ ⇒ 全插件回落到中文字面文案 ✓。
 *
 * 这里钉住修复后的三层取词与注册时机 ✓：
 * ① 宿主 `t` ✓ → ② **插件自己 `bind` 出来的翻译函数** ✓ → ③ 组件内字面文案 ✓；
 * 注册**每次取用都补试** ✓，并按宿主已声明的语言 id（`en-US` / `zh-CN` ✓）各注册一份 ✓。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));

import {
  attachPluginLocale,
  localeRegistrations,
  pluginLocaleText,
  pluginTranslate,
  resetPluginLocaleForTests,
} from "../src/client/plugin-locale.ts";
import { makeTranslator } from "../src/client/card-model.ts";

const ZH = { tabShort: "图谱", hello: "你好 {name}" };
const EN = { tabShort: "Graph", hello: "Hello {name}" };

/** 假的宿主 locale 服务 ✓（只实现契约里用到的那几个方法 ✓） */
function fakeService(options = {}) {
  const dicts = new Map();
  const register = (ns, locale, dict) => {
    const key = `${ns}::${locale}`;
    if (dicts.has(key)) throw new Error(`duplicate ${key}`);
    dicts.set(key, dict);
    return () => { dicts.delete(key); };
  };
  const service = {
    register,
    getLocale: () => ({ active: options.active ?? "en", locales: (options.declared ?? ["zh", "en"]).map((id) => ({ id })) }),
    bind: (ns) => (key) => dicts.get(`${ns}::${service.getLocale().active}`)?.[key] ?? key,
  };
  return { service, dicts };
}

describe("插件语言跟随系统 ✓", () => {
  it("**服务晚到也能补上** ✓（旧实现一次失败就永远放弃 ✗）", () => {
    resetPluginLocaleForTests();
    let available = false;
    const { service, dicts } = fakeService({ active: "en", declared: ["zh", "en"] });
    attachPluginLocale(() => (available ? service : undefined), "kn", ZH, EN);
    assert.equal(pluginTranslate(), null, "服务还没到 ⇒ 拿不到翻译函数（调用方回落到字面文案 ✓）");
    available = true;
    const translate = pluginTranslate();
    assert.notEqual(translate, null, "服务一到，**下一次取用**就该注册成功 ✓");
    assert.equal(translate("tabShort"), "Graph", "英文环境 ⇒ 英文 ✓（这就是芯片上那个短名 ✓）");
    assert.ok(dicts.has("kn::en") && dicts.has("kn::zh"), "中英两份都要注册 ✓");
  });

  it("宿主声明的语言 id 也要各注册一份 ✓（`en-US` / `zh-CN` 不能漏 ✗）", () => {
    const list = localeRegistrations(["en-US", "zh-CN", "en", "zh"], ZH, EN);
    assert.deepEqual(list.map(([locale]) => locale), ["zh", "en", "en-US", "zh-CN"], "去重 + 顺序稳定 ✓");
    const enUs = list.find(([locale]) => locale === "en-US");
    const zhCn = list.find(([locale]) => locale === "zh-CN");
    assert.equal(enUs?.[1], EN, "`en-US` 用英文字典 ✓");
    assert.equal(zhCn?.[1], ZH, "`zh-CN` 用中文字典 ✓");
  });

  it("`en-US` 这种活动语言也能翻出英文 ✓（这是用户截图那一刻的情形 ✓）", () => {
    resetPluginLocaleForTests();
    const { service } = fakeService({ active: "en-US", declared: ["zh-CN", "en-US"] });
    attachPluginLocale(() => service, "kn", ZH, EN);
    const translate = pluginTranslate();
    assert.notEqual(translate, null);
    assert.equal(translate("tabShort"), "Graph", "活动语言是 `en-US` ⇒ 必须命中英文字典 ✓");
    resetPluginLocaleForTests();
  });

  it("重复注册会抛 ⇒ **逐个语言记成功状态** ✓，不整批重来 ✓", () => {
    resetPluginLocaleForTests();
    const { service, dicts } = fakeService({ active: "en", declared: ["zh", "en"] });
    attachPluginLocale(() => service, "kn", ZH, EN);
    pluginTranslate();
    const before = dicts.size;
    pluginTranslate(); /* 再取一次：不许重复注册（会抛）✓，也不许把已注册的清掉 ✓ */
    assert.equal(dicts.size, before, "第二次取用不该再注册 ✓");
    assert.equal(pluginTranslate()("tabShort"), "Graph", "翻译函数仍然可用 ✓");
    resetPluginLocaleForTests();
  });

  it("**三层取词** ✓：宿主 `t` → 插件绑定 → 字面文案", () => {
    resetPluginLocaleForTests();
    /* ① 宿主给得出就用宿主的 ✓（宿主可能还带 common 命名空间的词 ✓） */
    const host = makeTranslator((key) => (key === "hello" ? "宿主你好 {name}" : key), ZH);
    assert.equal(host("hello", { name: "杜" }), "宿主你好 杜", "宿主优先 ✓");
    /* ② 宿主解析不出来（返回键名 ✓）⇒ 走**插件自己绑定的**那层 ✓ */
    const { service } = fakeService({ active: "en", declared: ["zh", "en"] });
    attachPluginLocale(() => service, "kn", ZH, EN);
    const viaPlugin = makeTranslator((key) => key, ZH);
    assert.equal(viaPlugin("tabShort"), "Graph", "宿主解析不出 ⇒ 插件绑定接手 ✓（英文 ✓）");
    /* ③ 两套都没有 ⇒ 字面文案 ✓（界面不会空 ✓），并且仍然做占位符替换 ✓ */
    resetPluginLocaleForTests();
    const literal = makeTranslator(undefined, ZH);
    assert.equal(literal("tabShort"), "图谱", "全都没有 ⇒ 字面文案 ✓");
    assert.equal(literal("hello", { name: "杜" }), "你好 杜", "占位符替换照旧 ✓");
    assert.equal(literal("missing.key"), "missing.key", "都没有时回键名 ✓（方便发现漏配 ✓）");
  });

  it("没有登记（宿主连 locale 服务都没有 ✓）⇒ 一律安全返回 ✓", () => {
    resetPluginLocaleForTests();
    assert.equal(pluginTranslate(), null, "没 attach ⇒ null ✓");
    attachPluginLocale(() => undefined, "kn", ZH, EN);
    assert.equal(pluginTranslate(), null, "服务取不到 ⇒ null ✓");
    attachPluginLocale(() => ({ register: () => { throw new Error("拒绝注册"); } }), "kn", ZH, EN);
    assert.equal(pluginTranslate(), null, "注册被拒 ⇒ null ✓（调用方回落到字面文案 ✓）");
    resetPluginLocaleForTests();
  });
});

/*
 * **漏网的硬编码中文** ✗（用户第二轮："还漏了一个，再检查一下还有没有漏下的"✓）。
 *
 * 两个扫描 ✓：
 * ① 组件里的**字面兜底字典**（`const LITERAL = { key: "中文" }` ✓）——
 *    每个键都必须在**中英两份词典**里 ✓，否则英文界面下会漏出中文 ✓（这正是用户截图那一幕 ✓）；
 * ② `.tsx` 里**直接写在 JSX 上的中文**（文本节点 / `aria-label` / `title` / `placeholder` ✓）——
 *    一律不许有 ✓（要显示中文也得走词典 ✓）。
 */
/*
 * **插件自带词典兜底** ✓（用户实测 2026-11："学习疑问"按钮切到英文后仍是中文 ✗）。
 *
 * 根因（宿主字典停在旧版 ✓）：宿主对同一命名空间**重复注册会抛** ✓ ——
 * 插件热重载/升级后旧实例注册的字典仍占着命名空间 ✓ ⇒ 新实例的注册全部失败（被 catch 掉）✓
 * ⇒ **这一版新增的键**（问题功能的"学习疑问"等 ✓）在宿主字典里永远没有 ✓。
 * 而 `makeTranslator` 的前两层（宿主 `t` / `pluginTranslate`）都走宿主字典 ⇒ 一起失败 ✓
 * ⇒ 回落到中文字面 ✓；老键有旧字典 ⇒ 仍是英文 ✓ ⇒ 看起来"只有这个新按钮不跟随语言"✓。
 *
 * 修法两层：
 * ① `pluginLocaleText` 在宿主字典取不到时，直接用**插件自带的最新字典**（按当前语言选 ✓）；
 * ② `attachPluginLocale` 返回注销函数，插件卸载时撤掉宿主字典 ⇒ 下一次 apply 能注册完整字典 ✓。
 */
describe("插件自带词典兜底 ✓（宿主字典落后于插件这一版时）", () => {
  /** 模拟"旧实例还占着命名空间"的宿主：register 全抛、bind 只能翻出旧键 */
  const staleService = () => {
    const state = { active: "en" };
    const hostZh = { oldKey: "旧键" };
    const hostEn = { oldKey: "Old key" };
    const service = {
      register: () => { throw new Error("locale namespace already has locale (stale plugin instance)"); },
      getLocale: () => ({ active: state.active, locales: [{ id: "zh" }, { id: "en" }] }),
      bind: () => (key) => (state.active === "zh" ? hostZh : hostEn)[key] ?? key,
    };
    return { service, state };
  };

  it("宿主字典缺的新键 ⇒ 用插件自带字典按当前语言翻译 ✓（切换语言立即跟随 ✓）", () => {
    resetPluginLocaleForTests();
    const { service, state } = staleService();
    const ZH = { oldKey: "旧键", questions: "学习疑问" };
    const EN = { oldKey: "Old key", questions: "Learning questions" };
    attachPluginLocale(() => service, "kn", ZH, EN);
    const t = makeTranslator(undefined, ZH);
    assert.equal(t("oldKey"), "Old key", "宿主字典有的键照旧用宿主 ✓");
    assert.equal(t("questions"), "Learning questions", "宿主字典缺的新键必须由插件自带字典补成英文 ✓");
    state.active = "zh";
    assert.equal(t("questions"), "学习疑问", "切回中文后下一次调用立即跟随 ✓");
    assert.equal(pluginLocaleText("questions"), "学习疑问", "pluginLocaleText 也跟随当前语言 ✓");
    resetPluginLocaleForTests();
  });

  it("**注销**：插件卸载要撤掉宿主字典，重新登记（新一版含新键）才能注册 ✓", () => {
    resetPluginLocaleForTests();
    const dicts = new Map();
    const service = {
      register: (ns, locale, dict) => {
        const key = `${ns}::${locale}`;
        if (dicts.has(key)) throw new Error(`duplicate ${key}`);
        dicts.set(key, dict);
        return () => { dicts.delete(key); };
      },
      getLocale: () => ({ active: "en", locales: [{ id: "zh" }, { id: "en" }] }),
      bind: (ns) => (key) => dicts.get(`${ns}::en`)?.[key] ?? key,
    };
    const dispose = attachPluginLocale(() => service, "kn", { questions: "学习疑问" }, { questions: "Learning questions" });
    assert.equal(pluginTranslate()("questions"), "Learning questions");
    assert.ok(dicts.has("kn::zh") && dicts.has("kn::en"), "正常注册两份字典 ✓");
    dispose();
    assert.equal(dicts.size, 0, "卸载时必须把宿主字典**撤掉**（否则下一次 apply 注册不上 ✗）");
    assert.equal(pluginTranslate(), null, "注销后不能再返回旧翻译函数 ✓");
    /* 模拟热重载后的新一版：字典里多了新键，能重新注册成功 ✓ */
    attachPluginLocale(() => service, "kn", { questions: "学习疑问", extra: "新问题" }, { questions: "Learning questions", extra: "New question" });
    assert.equal(pluginTranslate()("extra"), "New question", "重新登记后新键也要能查到 ✓");
    resetPluginLocaleForTests();
  });

  it("语言未知时不瞎猜（交给调用方的字面文案兜底）✓", () => {
    resetPluginLocaleForTests();
    const service = {
      register: () => () => {},
      getLocale: () => ({ locales: [] }),
      bind: () => (key) => key,
    };
    attachPluginLocale(() => service, "kn", { questions: "学习疑问" }, { questions: "Learning questions" });
    assert.equal(pluginLocaleText("questions"), null, "拿不到 active 时不能硬猜成中/英 ✓");
    resetPluginLocaleForTests();
  });
});

describe("硬编码中文不许再漏 ✓", () => {
  const dir = path.join(HERE, "..", "src", "client");
  const dict = readFileSync(path.join(dir, "index.ts"), "utf8");
  const zh = dict.slice(dict.indexOf("const DICT_ZH"), dict.indexOf("const DICT_EN"));
  const en = dict.slice(dict.indexOf("const DICT_EN"));

  it("组件的字面兜底字典：键必须在中英词典里都有 ✓", () => {
    const missing = [];
    for (const name of readdirSync(dir)) {
      if (!/\.tsx?$/.test(name)) continue;
      const code = readFileSync(path.join(dir, name), "utf8");
      for (const block of code.matchAll(/(?:const LITERAL|const [A-Z_]+_LITERAL)[^=]*=\s*\{([\s\S]*?)\n\};/g)) {
        for (const entry of block[1].matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*"/gm)) {
          const key = entry[1];
          for (const [label, dictText] of [["中文", zh], ["英文", en]]) {
            if (!new RegExp(`^\\s{2}${key}:`, "m").test(dictText)) missing.push(`${name}:${key}(缺${label})`);
          }
        }
      }
    }
    assert.deepEqual(missing, [], `这些键没进词典 ✗（英文界面会漏出中文 ✓）：${missing.join(", ")}`);
  });

  it("`.tsx` 里不许直接写中文到 JSX 上 ✓", () => {
    const offenders = [];
    for (const name of readdirSync(dir)) {
      if (!/\.tsx$/.test(name)) continue;
      const lines = readFileSync(path.join(dir, name), "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        const trim = line.trim();
        if (/^\s*(\*|\/\*|\/\/)/.test(trim)) return; /* 注释不算 ✓ */
        if (!/[\u4e00-\u9fa5]/.test(line)) return;
        if (/>[^<>{}]*[\u4e00-\u9fa5][^<>{}]*</.test(line) || /(aria-label|title|placeholder|alt)="[^"]*[\u4e00-\u9fa5]/.test(line)) {
          offenders.push(`${name}:${index + 1}`);
        }
      });
    }
    assert.deepEqual(offenders, [], `这些位置直接写了中文 ✗（要走词典 ✓）：${offenders.join(", ")}`);
  });
});
