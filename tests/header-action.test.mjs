/**
 * 「添加知识库」表头按钮的纯逻辑测试。
 *
 * 背景：工作区表头没有插槽，只能按宿主结构定位动作容器再追加按钮。定位里最容易错的一步是
 * **别把搜索位当成动作容器**（搜索位自己也有 button），所以用假 DOM 把这条钉住。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ADD_LIBRARY_ID,
  ADD_LIBRARY_ORDER,
  HEADER_BUTTON_CLASS,
  RETRY_DELAYS_MS,
  SEARCH_THROTTLE_MS,
  addLibraryOptions,
  confirmDialogCss,
  describeHeader,
  findHeaderMount,
  graphAddIconDataUrl,
  headerButtonCss,
  pickActionsContainer,
  reportFingerprint,
} from "../src/client/header-action.ts";

/** 极简假 DOM 节点 */
function node({ children = [], text = "", attrs = [] } = {}) {
  const self = {
    children,
    text,
    attrs,
    parentElement: null,
    contains(other) {
      if (other === self) return true;
      return children.some((child) => child.contains(other));
    },
    querySelector(selector) {
      if (selector === "button") return self.buttons > 0 ? self : null;
      if (selector === "[data-row-key]") return self.hasRows === true ? self : null;
      if (selector === 'input[type="text"]') return self.isInput === true ? self : null;
      return null;
    },
  };
  for (const child of children) child.parentElement = self;
  return self;
}

function el(options = {}) {
  const created = node(options);
  created.buttons = options.buttons ?? 0;
  created.hasRows = options.hasRows ?? false;
  created.isInput = options.isInput ?? false;
  return created;
}

describe("表头动作容器的定位", () => {
  it("跳过搜索位，选中含按钮的那个动作容器", () => {
    const input = el({ isInput: true });
    const searchButton = el({ buttons: 1 });
    const searchSlot = el({ children: [input, searchButton] });
    const actions = el({ buttons: 2 });
    const header = el({ children: [searchSlot, actions] });
    assert.equal(pickActionsContainer(header, input), actions);
  });

  it("表头里没有动作容器时返回 null（不猜）", () => {
    const input = el({ isInput: true });
    const header = el({ children: [el({ children: [input] })] });
    assert.equal(pickActionsContainer(header, input), null);
    assert.equal(pickActionsContainer(null, input), null);
  });

  it("沿父链找到「含行」的祖先，再取它的第一个子元素当表头（挂载点）", () => {
    const input = el({ isInput: true });
    const searchSlot = el({ children: [input] });
    const actions = el({ buttons: 2 });
    const header = el({ children: [searchSlot, actions] });
    const rows = el({ hasRows: true });
    el({ children: [header, rows], hasRows: true });
    const doc = { querySelector: (selector) => (selector === 'input[type="text"]' ? input : null) };
    // 挂载点是**表头本身**，不是限宽 60px 的动作簇——塞进簇里第三颗会被 overflow:hidden 裁掉
    assert.equal(findHeaderMount(doc), header);
  });

  it("找不到搜索框或行容器时返回 null（不猜）", () => {
    assert.equal(findHeaderMount({ querySelector: () => null }), null);
    const input = el({ isInput: true });
    assert.equal(findHeaderMount({ querySelector: () => input }), null);
  });
});

describe("按钮样式与注册形状", () => {
  it("样式对齐 shipped 的 .iconButton（28×28 等）", () => {
    const css = headerButtonCss();
    assert.match(css, /\.kn-add-library \{/);
    assert.match(css, /width: 28px; height: 28px/);
    assert.match(css, /border-radius: var\(--dsw-radius-sm/);
    assert.match(css, /interactive-bg-hover/);
    assert.match(css, /mask: var\(--kn-libid-add-icon\)/, "图标用「图谱 + 加号」的合成字形");
    assert.match(css, /data-kn-error/, "失败时按钮自身要能显示错误色");
  });

  it("图标是「图谱 + 加号」的**一枚** 16px 合成图标（不能靠绝对定位的第二个元素）", () => {
    const css = headerButtonCss();
    assert.match(css, /\.kn-add-library-glyph \{/);
    assert.match(css, /width: 16px; height: 16px/, "与旁边三颗按钮同尺寸");
    assert.match(css, /mask: var\(--kn-libid-add-icon\)/);
    assert.ok(!/::after/.test(css), "不该再有绝对定位的加号：那会让图标顶出 16px 框（实测就显得高了一截）");
    assert.ok(!/position: relative/.test(css), "合成图标不需要定位上下文");

    const url = graphAddIconDataUrl();
    assert.ok(url.startsWith('url("data:image/svg+xml,'));
    assert.ok(!/data:image\/svg\+xml,[^"]*[<>#]/.test(url), "URL 里不能出现未编码的 < > #");
    const svg = decodeURIComponent(url.slice('url("data:image/svg+xml,'.length, -2));
    // 与宿主图标同一套规格：16 网格 + 线宽 1（ICON_REGULAR_STROKE），否则粗细和邻居对不上
    assert.ok(svg.includes("viewBox=\"0 0 16 16\""), "与宿主同网格（16）");
    assert.match(svg, /stroke-width="1"/, "与宿主同线宽（1）");
    // 加号（右上）与图谱（左下）都在同一枚里
    assert.match(svg, /M11\.4 4\.4h3\.6/, "加号横线");
    assert.match(svg, /M13\.2 2\.6v3\.6/, "加号竖线");
    assert.match(svg, /circle cx="6\.2" cy="5"/, "图谱节点");
  });

  it("注册选项：sidebar.footer.action + 必填 id + 文案注入面", () => {
    const options = addLibraryOptions({ label: "添加知识库", inject: () => ({ label: "添加知识库" }) });
    assert.equal(options.name, "sidebar.footer.action");
    assert.equal(options.id, ADD_LIBRARY_ID);
    assert.equal(options.order, ADD_LIBRARY_ORDER);
    assert.equal(typeof options.inject, "function");
    assert.equal(options.inject().label, "添加知识库");
    assert.ok(!("locale" in options));
  });

  it("类名常量稳定（样式与注入用的同一个）", () => {
    assert.equal(HEADER_BUTTON_CLASS, "kn-add-library");
    assert.match(headerButtonCss(), new RegExp(`\\.${HEADER_BUTTON_CLASS} `));
  });

  it("锚点查找策略：必须节流 + 必须有重试（只查一次会永久放弃，实测翻过车）", () => {
    assert.ok(SEARCH_THROTTLE_MS > 0, "流式渲染会高频触发，查找必须节流");
    assert.ok(RETRY_DELAYS_MS.length >= 1, "首轮找不到锚点时必须定时重试");
    for (const delay of RETRY_DELAYS_MS) assert.ok(delay > 0 && delay <= 10000);
  });

  it("确认弹窗的样式：模态层要盖在最上面，且 portal 在 body 也能生效", () => {
    const css = confirmDialogCss();
    assert.match(css, /\.kn-modal-backdrop \{/);
    assert.match(css, /position: fixed; inset: 0;/, "必须脱离侧栏布局");
    assert.match(css, /z-index: 9999/);
    assert.match(css, /\.kn-modal \{/);
    assert.match(css, /border-radius: 12px/);
    assert.match(css, /\.kn-modal-actions/);
    assert.match(css, /\.kn-modal-primary/, "确认按钮要有主色");
    // 颜色全走宿主 token，亮暗主题自动跟随
    assert.match(css, /--dsw-alias-bg-layer-1/);
  });
});

describe("结构指纹（上报给宿主，供 kn_status 读出）", () => {
  it("找不到搜索框 → no-search-input", () => {
    const fingerprint = describeHeader({ querySelector: () => null });
    assert.equal(fingerprint.outcome, "no-search-input");
    assert.deepEqual(fingerprint.chain, []);
  });

  it("往上找不到行容器 → no-rows-ancestor，并带上层级指纹", () => {
    const input = el({ isInput: true });
    el({ children: [input] });
    const doc = { querySelector: (selector) => (selector === 'input[type="text"]' ? input : null) };
    const fingerprint = describeHeader(doc);
    assert.equal(fingerprint.outcome, "no-rows-ancestor");
    assert.ok(fingerprint.chain.length >= 1, "要给层级指纹，便于我改选择器");
  });

  it("找到锚点 → injected，并给出表头各子元素（是否有按钮/是否含搜索框）", () => {
    const input = el({ isInput: true });
    const searchSlot = el({ children: [input] });
    const actions = el({ buttons: 2 });
    const header = el({ children: [searchSlot, actions] });
    const rows = el({ hasRows: true });
    el({ children: [header, rows], hasRows: true });
    const doc = { querySelector: (selector) => (selector === 'input[type="text"]' ? input : null) };
    const fingerprint = describeHeader(doc);
    assert.equal(fingerprint.outcome, "injected");
    assert.equal(fingerprint.candidates.length, 2);
    assert.equal(fingerprint.candidates[0].hasInput, true, "搜索位要能被识别出来");
    assert.equal(fingerprint.candidates[1].hasButton, true, "动作容器含按钮");
    assert.equal(fingerprint.chosen, 1, "必须选中动作容器（下标 1），而不是搜索位");
  });

  it("表头里没有可用动作容器 → no-actions-container", () => {
    const input = el({ isInput: true });
    const header = el({ children: [el({ children: [input] })] });
    const rows = el({ hasRows: true });
    el({ children: [header, rows], hasRows: true });
    const doc = { querySelector: (selector) => (selector === 'input[type="text"]' ? input : null) };
    assert.equal(describeHeader(doc).outcome, "no-actions-container");
  });

  it("指纹里不带任何文本内容（只描述形状）", () => {
    const input = el({ isInput: true, text: "秘密查询" });
    const header = el({ children: [el({ children: [input] }), el({ buttons: 1, text: "私密" })] });
    const rows = el({ hasRows: true, text: "工作区里的事项" });
    el({ children: [header, rows], hasRows: true });
    const doc = { querySelector: (selector) => (selector === 'input[type="text"]' ? input : null) };
    const serialized = JSON.stringify(describeHeader(doc));
    assert.ok(!serialized.includes("秘密"), "不得上报文本");
    assert.ok(!serialized.includes("私密"));
    assert.ok(!serialized.includes("工作区里的事项"));
  });

  it("reportFingerprint 用 POST 打同一条路由；后端挂了也不抛", async () => {
    const calls = [];
    const ok = await reportFingerprint(
      "api/knowledgenet.graph",
      { outcome: "injected", chain: [], candidates: [] },
      async (url, init) => { calls.push({ url, init }); return { ok: true }; },
    );
    assert.equal(ok, true);
    assert.equal(calls[0].url, "api/knowledgenet.graph");
    assert.equal(calls[0].init.method, "POST");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.kind, "diag");
    assert.equal(body.outcome, "injected");
    assert.equal(
      await reportFingerprint("api/x", { outcome: "injected", chain: [], candidates: [] }, async () => { throw new Error("offline"); }),
      false,
    );
  });
});
