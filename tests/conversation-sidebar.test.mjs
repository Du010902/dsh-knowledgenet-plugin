/**
 * 换会话时"把侧栏标签带过去"的规则（`conversation-sidebar.ts` ✓）。
 *
 * 用户实测 2026-10-11 的那条：控制台里一直刷
 * `GET dsh-app://app/api/changes.summary?sessionId=…&seq=… 404` ✗，
 * 而**卸掉插件就不报了** ✓ ⇒ 是我们在重开它 ✓。
 *
 * 链条：DSH 自己的「修改审阅」标签地址是 `dsh-resource://changes-review/session/<id>/<seq>/<turn>` ✓
 * ⇒ 我们"把源会话的标签原样重开到目标会话"时把它也带过去了 ✗ ⇒ 它一挂载就去读
 * `/api/changes.summary` ✓ ⇒ 那份摘要在宿主**内存**里（重启 / 会话 dispose 就没了 ✗）⇒ 404 ✓。
 * 所以：**属于别的会话的资源标签不跟着走** ✓（本文件钉住这条 ✓）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { carryConversationSidebar, resourceSessionId } from "../src/client/conversation-sidebar.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(HERE, "..", "src", "client", "conversation-sidebar.ts"), "utf8");

const A = "session-aaaa-1111";
const B = "session-bbbb-2222";

describe("认出「会话绑定的资源地址」的属主 ✓", () => {
  it("DSH 的修改审阅地址（就是那条 404 的来源 ✓）", () => {
    assert.equal(resourceSessionId(`dsh-resource://changes-review/session/${A}/17/3`), A);
    assert.equal(resourceSessionId(`dsh-resource://other-kind/session/${B}/1/1`), B);
    assert.equal(resourceSessionId(`dsh-resource://changes-review/session/${encodeURIComponent(A)}/1/1`), A, "百分号转义要还原 ✓");
  });

  it("不是会话绑定的地址 ⇒ undefined（那种照旧带走 ✓）", () => {
    for (const address of [
      "kn-tab://knowledgenet.graph",
      "dsh-resource://file/C%3A%5Cnote.md",
      "dsh-resource://changes-review/session/",
      "dsh-resource://changes-review/session",
      "https://example.com/x",
      "",
    ]) {
      assert.equal(resourceSessionId(address), undefined, `${address} 不该被当成会话资源 ✓`);
    }
    assert.equal(resourceSessionId(`dsh-resource://x/session/%E0%A4%A`), undefined, "坏转义 ⇒ 认不出属主（照旧带走 ✓，绝不丢标签 ✗）");
  });
});

/** 一个够用的假侧栏：`mounted` 可以先停在源会话，再切成目标会话 ✓ */
function fakeSidebar(tabs) {
  const opened = { resources: [], viaOpenTab: [] };
  const sidebar = {
    mounted: { getSnapshot: () => sidebar.current },
    current: A,
    tabsIn: (sessionId) => (sessionId === A ? tabs : []),
    tabDomain: { occurrence: () => ({ navigation: { getSnapshot: () => ({}) } }) },
    isExpanded: () => true,
    openResource: (address, options) => { opened.resources.push({ address, ...options }); },
    openTab: (kind, options) => { opened.viaOpenTab.push({ kind, options }); },
    openTabs: { subscribe: () => () => {} },
    active: () => undefined,
  };
  return { sidebar, opened };
}

/** 源会话里开着这几种标签：我们自己的图谱标签 + 一条**别的会话**的审阅 + 一条文件资源 + 一条**目标会话**的审阅 ✓ */
const TABS = [
  { id: "t-graph", kind: "knowledgenet.graph", contentId: "knowledgenet.graph" },
  { id: "t-review-a", kind: "changes-review", contentId: `dsh-resource://changes-review/session/${A}/17/3` },
  { id: "t-file", kind: "file", contentId: "dsh-resource://file/C%3A%5Cnote.md" },
  { id: "t-review-b", kind: "changes-review", contentId: `dsh-resource://changes-review/session/${B}/4/1` },
];

describe("带过去的时候：别的会话的资源标签不重开 ✓", () => {
  it("源会话里属于**自己**的审阅标签不带走（它就是那条 404 ✗）", () => {
    const { sidebar, opened } = fakeSidebar(TABS);
    const carried = carryConversationSidebar(sidebar, B);
    sidebar.current = B; /* 宿主切到目标会话了 ✓ */
    carried.restore();
    const addresses = opened.resources.map((item) => item.address);
    assert.ok(!addresses.includes(`dsh-resource://changes-review/session/${A}/17/3`), "旧会话的审阅不该被重开 ✗（重开必 404 ✓）");
    assert.ok(addresses.includes(`dsh-resource://changes-review/session/${B}/4/1`), "目标会话自己的审阅照旧 ✓");
    assert.ok(addresses.includes("dsh-resource://file/C%3A%5Cnote.md"), "与会话无关的文件资源照旧带走 ✓");
    assert.deepEqual(opened.viaOpenTab.map((item) => item.kind), ["knowledgenet.graph"], "我们的图谱标签照旧 ✓");
  });

  it("只拦「会话绑定且属主不是目标」的那种 ✗：普通标签、无属主信息的标签照旧恢复 ✓", () => {
    const plain = { id: "t-plain", kind: "some-other-tab", contentId: "some-other-tab" };
    const { sidebar, opened } = fakeSidebar([plain]);
    /* 只有 `openTabIn` 这一条路可走（没有 `openTab` / `openResource` ✓） */
    sidebar.openTab = undefined;
    const viaTabIn = [];
    sidebar.openTabIn = (sessionId, kind, options) => { viaTabIn.push({ sessionId, kind, options }); };
    const carried = carryConversationSidebar(sidebar, B);
    sidebar.current = B;
    carried.restore();
    assert.deepEqual(opened.resources, [], "没有资源标签 ⇒ 不该走 openResource ✓");
    assert.deepEqual(viaTabIn.map((item) => item.kind), ["some-other-tab"], "普通标签照旧恢复（别过度收敛 ✗）");
  });

  it("接线：跳过要留痕，且一条只报一次 ✓（watch 会反复调 restore ✗）", () => {
    assert.ok(source.includes("resourceSessionId(tab.contentId)"), "判定要接在恢复流程里 ✓");
    assert.ok(source.includes('"skipped-cross-session"'), "跳过要留痕（否则以后又看不出是谁重开的 ✗）");
    assert.ok(source.includes("if (!skipped.has(tab.id))"), "同一条别反复上报 ✗");
  });
});
