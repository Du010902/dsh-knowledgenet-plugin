/**
 * 弹窗文案跟随宿主语言设置（用户反馈 2026-09）。
 *
 * 现象：中文界面里，划词弹窗的按钮/标签全是英文（`Nodes to add` / `Create standalone` / `Cancel`…），
 * 而且同一份文案在别处又是中文 —— 看起来"中英随机混排"。
 *
 * 根因（两条叠在一起）：
 * 1. **读错了字段**：宿主 locale 快照 `LocaleSnapshot` 上是 `active`，我读的是 `.id`
 *    ⇒ 永远 `undefined` ⇒ 回落到"猜浏览器语言"（Electron 里常是 en）⇒ 判成英文 ✗；
 * 2. **文案在注册时钉死**：即便判对了，用户在设置里切语言也要刷新页面才生效 ✗。
 *
 * 修法：判据抽成 `locale-choice.ts`（只认 `active`，拿不到就交给调用方兜底）；
 * 文案改成"每次渲染现取"（`registerChatSelectionBar(ctx, copy)` 收的是生成函数）——
 * 宿主切语言时槽位出口会整体重渲染（`useLocaleRevision`），于是弹窗立刻跟着变 ✓。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { isZhSnapshot, readZh } = await import("../src/client/locale-choice.ts");

const index = await readFile(path.join(HERE, "..", "src", "client", "index.ts"), "utf8");
const badges = await readFile(path.join(HERE, "..", "src", "client", "badges.ts"), "utf8");

describe("语言判定：只认宿主快照的 active", () => {
  it("zh / zh-CN / 大小写混写都算中文", () => {
    assert.equal(isZhSnapshot({ active: "zh" }), true);
    assert.equal(isZhSnapshot({ active: "zh-CN" }), true);
    assert.equal(isZhSnapshot({ active: "ZH-hans" }), true);
    assert.equal(isZhSnapshot({ active: "  zh  " }), true, "两侧空白要容忍");
  });

  it("en / ja 这类明确不是中文", () => {
    assert.equal(isZhSnapshot({ active: "en" }), false);
    assert.equal(isZhSnapshot({ active: "ja" }), false);
  });

  it("拿不到 id 时返回 undefined（交给调用方兜底，不硬猜）", () => {
    assert.equal(isZhSnapshot({}), undefined);
    assert.equal(isZhSnapshot({ active: "   " }), undefined);
    assert.equal(isZhSnapshot(null), undefined);
    assert.equal(isZhSnapshot(undefined), undefined);
    assert.equal(readZh(undefined), undefined);
    assert.equal(readZh({}), undefined);
  });

  it("**`.id` 不是宿主的字段**：旧写法读它 ⇒ 永远 undefined ⇒ 中文界面出英文（这就是那个 bug）", () => {
    assert.equal(isZhSnapshot({ id: "zh" }), undefined, "别再把 .id 当判据");
  });

  it("readZh 走服务的 getLocale()；服务抛错也只当「拿不到」", () => {
    assert.equal(readZh({ getLocale: () => ({ active: "zh" }) }), true);
    assert.equal(readZh({ getLocale: () => ({ active: "en" }) }), false);
    assert.equal(readZh({ getLocale: () => undefined }), undefined);
    assert.equal(readZh({ getLocale: () => { throw new Error("boom"); } }), undefined);
  });
});

describe("接线：文案每次渲染现取，语言跟随宿主设置", () => {
  it("入口用 readZh(...) 判语言，不再读 getLocale().id", () => {
    assert.ok(index.includes("readZh("), "要复用共用判定函数");
    assert.equal(/getLocale\?\.\(\)\?\.id/.test(index), false, "不许再读不存在的 .id");
    assert.ok(
      index.includes("const zhNow = (): boolean => readZh(localeServiceNow()) ?? !prefersEnglish()"),
      "每次调用现读快照",
    );
    assert.ok(index.includes("const localeServiceNow = (): LocaleServiceLike | undefined =>"), "服务按需现取，不缓存");
    assert.ok(index.includes("const selectionCopy = (): ChatSelectionCopy =>"), "文案按次生成");
    assert.ok(index.includes("registerChatSelectionBar(ctx as never, selectionCopy)"), "把生成函数交给注册处");
  });

  it("注册处每次渲染调 copy()，而不是注册时钉死一份", () => {
    assert.ok(badges.includes("export type ChatSelectionCopy ="), "文案类型由组件 props 反推");
    assert.ok(badges.includes("copy: () => ChatSelectionCopy,"), "签名收的是生成函数");
    assert.ok(/copy:\s*copy\(\),/.test(badges), "槽位渲染时现取文案（切语言即生效）");
  });
});
