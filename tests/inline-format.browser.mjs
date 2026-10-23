/**
 * **行内格式（真实面板）浏览器 E2E** —— `design/inline-format-fix.md`。
 *
 * 第四轮用户反馈之后：右键菜单里的「行内格式」组已删掉（和"选中文字后的浮动工具栏"重复 ✗），
 * 行内格式只走**划词选中 → 浮动工具栏**（8 个按钮 = 加粗/斜体/删除线/行内代码/行内公式/链接/
 * 清除格式/＋添加前置节点）+ 快捷键；右键菜单恢复成纯块插入 ✓。
 *
 * 这里用**真实面板级**驱动（骨架同 `tests/note-images.browser.mjs`）：
 * 造 v3 库 → 真实 `GraphPanel` + 假 `/api/` → 搜索节点 → 「编辑笔记」→ 在**真实编辑器 UI** 上
 * 划词、点工具栏、填链接，再用 Ctrl+S 的**保存请求正文**核对 Markdown；最后反向断言
 * 右键菜单里**不再**出现行内格式组/条目（仍是图片/代码块/表格/公式块…）。
 *
 * 宿主 `@deepseek-ai/dsh-client-ui-primitives` 的两件组件由模块表注入替身：
 * - `Menu`：portal 到 body、role=menu/menuitem、Esc / 点外面 onClose、getAnchorRect（定位夹进视口）；
 * - `ImageLightbox`：本测试用不到（只在不打开时返回 null）。
 *
 * 运行：
 *   $env:KN_PROJECT='D:/AppInstallation/DSH/deepseek-harness'
 *   node --test tests/inline-format.browser.mjs
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {after, describe, it} from 'node:test';

import {__internal} from '../index.js';
import {writeNote} from '../src/host/v3/store.ts';
import {cleanupFixtures, makeV3Fixture} from './support/v3-fixture.mjs';

const project = process.env.KN_PROJECT;
if (!project) throw Error('Set KN_PROJECT to the DSH dependency checkout.');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const DEPS = REPO + '/.tmp-build-deps';
const CHROME = process.env.KN_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TITLE = '行内格式';
const BODY = '前文后文';
/** 带代码块的夹具：i3（复制按钮=结构化）/ i4（选中复制=纯文本）用 ✓ */
const CODE_BODY = [
  '正文', '', '```js', '#include<iostream>', 'using namespace std;', '',
  'int main() {', '    cout << "hi" << endl;', '    return 0;', '}', '```',
].join('\n');
const VIEWPORT = {width: 1920, height: 1080};
const PANEL_WIDTH = 900;
/** 行内代码样式（i2）：CSSOM 读含 var() 的简写会得到空串 ✗ ⇒ 直接读源码里的那条规则 ✓ */
const EDITOR_OVERRIDES_CSS = readFileSync(new URL('../src/client/editor-overrides.css', import.meta.url), 'utf8');

after(async () => {
  await cleanupFixtures();
});

function pnpmEntries(base) {
  try { return readdirSync(base).filter(name => !name.startsWith('@')); } catch { return []; }
}
function firstExisting(candidates, label) {
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  throw new Error(`找不到${label}；尝试过：\n${candidates.filter(Boolean).join('\n')}`);
}
/** 扫描 .pnpm 找 rolldown / playwright / react-dom（不写死版本号 ✓） */
function resolveTooling() {
  const rolldownPath = firstExisting([
    process.env.KN_ROLLDOWN,
    ...[DEPS, project].flatMap(base => pnpmEntries(`${base}/node_modules/.pnpm`)
      .filter(name => name.startsWith('rolldown@'))
      .map(name => `${base}/node_modules/.pnpm/${name}/node_modules/rolldown/dist/index.mjs`)),
  ], 'rolldown');
  const playwrightPath = firstExisting([
    process.env.KN_PLAYWRIGHT,
    ...pnpmEntries(`${project}/node_modules/.pnpm`)
      .filter(name => name.startsWith('playwright@'))
      .map(name => `${project}/node_modules/.pnpm/${name}/node_modules/playwright/index.mjs`),
  ], 'playwright');
  const reactDomDir = pnpmEntries(`${project}/node_modules/.pnpm`).find(name => name.startsWith('react-dom@18.3.1'));
  const reactRequire = createRequire(firstExisting([
    reactDomDir ? `${project}/node_modules/.pnpm/${reactDomDir}/node_modules/react-dom/package.json` : undefined,
  ], 'react-dom'));
  return { rolldownPath, playwrightPath, reactRequire };
}

/** 页面里的小工具：**穿透 Shadow DOM**（面板在 shadow root 里 ✓） */
function installPageHelpers() {
  const deepAll = (selector, root = document) => {
    const out = [];
    const visit = (node) => {
      out.push(...node.querySelectorAll(selector));
      for (const el of node.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(root);
    return out;
  };
  window.__knTest = { deepAll, deepOne: selector => deepAll(selector)[0] ?? null };
}

/** 宿主 `Menu` / `ImageLightbox` 的契约替身（只实现插件真正用到的部分 ✓） */
const HOST_STUB = `
function HostMenu(props){
  const anchor = (props.getAnchorRect?.() ?? {left: 0, top: 0});
  const boxRef = React.useRef(null);
  const [pos, setPos] = React.useState({left: anchor.left ?? 0, top: anchor.top ?? 0});
  React.useLayoutEffect(() => {
    if (!props.open || boxRef.current === null) { setPos({left: anchor.left ?? 0, top: anchor.top ?? 0}); return; }
    const width = boxRef.current.offsetWidth || 240, height = boxRef.current.offsetHeight || 320;
    setPos({
      left: Math.max(12, Math.min(anchor.left ?? 0, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(anchor.top ?? 0, window.innerHeight - height - 12)),
    });
  }, [props.open, anchor.left, anchor.top]);
  React.useEffect(() => {
    if (!props.open) return undefined;
    const onKey = e => { if (e.key === 'Escape') props.onClose?.(); };
    const onPointer = e => {
      const menu = document.querySelector('[data-kn-block-menu]');
      if (menu !== null && !menu.contains(e.target)) props.onClose?.();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [props.open, props.onClose]);
  if (!props.open) return null;
  const items = props.items ?? [];
  return ReactDOM.createPortal(
    React.createElement('div', {
      'data-kn-block-menu': '', role: 'menu', ref: boxRef,
      style: {position: 'fixed', left: pos.left + 'px', top: pos.top + 'px', zIndex: 9999, background: '#fff', border: '1px solid #888', padding: '4px'},
    },
      items.map((item, index) => item.type === 'separator'
        ? React.createElement('hr', {key: item.id ?? index})
        : item.type === 'label'
          ? React.createElement('div', {key: item.id ?? index, 'data-menu-label': item.text ?? ''}, item.text ?? '')
          : React.createElement('button', {key: item.id ?? index, type: 'button', role: 'menuitem',
              onClick: () => props.onSelect?.(item.id)}, item.label ?? item.id))),
    document.body);
}
const ImageLightbox = function ImageLightbox() { return null; };
const hostPrimitives = {Menu: HostMenu, ImageLightbox};
window.__ModuleLoader__ = {load: ({factory}) => {
  window.plugin = factory(name => ({
    'react': React, 'react-dom': ReactDOM, 'react/jsx-runtime': JSX,
    '@deepseek-ai/dsh-client-ui-primitives': hostPrimitives,
  }[name]));
}};
`;

async function startHarness(body = BODY) {
  const fixture = await makeV3Fixture({nodes: [TITLE]});
  const nodeId = fixture.nodes[TITLE].id;
  const written = await writeNote(fixture.root, {id: nodeId, text: body});
  if (written.ok !== true) throw new Error(`写夹具正文失败：${written.code} ${written.message}`);

  const tooling = resolveTooling();
  const {rolldown} = await import(pathToFileURL(tooling.rolldownPath).href);
  const {chromium} = await import(pathToFileURL(tooling.playwrightPath).href);

  const entry = `import React from 'react';import * as ReactDOM from 'react-dom';import * as JSX from 'react/jsx-runtime';import {createRoot} from 'react-dom/client';
${HOST_STUB}
window.mountGraph = () => {
  const root = createRoot(document.getElementById('app'));
  function App() {
    return React.createElement(window.plugin.GraphPanel, {
      sessionId: 'chat',
      useWorkspaces: () => ({items: [{path: ${JSON.stringify(fixture.workspace)}, sessionIds: ['chat']}]}),
      useTabInfo: () => ({tab: {navigation: {params: {root: ${JSON.stringify(fixture.root)}}}}}),
    });
  }
  root.render(React.createElement(App));
};`;
  const build = await rolldown({
    input: 'virtual:entry',
    plugins: [{
      name: 'kn-inline-format-test',
      resolveId(id) {
        if (id === 'virtual:entry') return id;
        if (['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'].includes(id)) return tooling.reactRequire.resolve(id);
        return null;
      },
      load(id) { return id === 'virtual:entry' ? entry : null; },
    }],
  });
  let app;
  try { app = (await build.generate({format: 'iife'})).output.find(item => item.type === 'chunk').code; }
  finally { await build.close(); }

  const compiled = readFileSync(`${REPO}/client.js`, 'utf8').replace(
    'exports.apply = apply;',
    'exports.apply = apply; exports.GraphPanel = GraphPanel;',
  );
  if (!compiled.includes('exports.GraphPanel = GraphPanel;')) throw new Error('client.js 里没有 exports.apply，无法暴露 GraphPanel');

  const state = new __internal.LearningState(3000);
  const ctx = {get: name => (name === 'sessionPersistence' ? {stat: async id => (id === 'chat' ? {header: {cwd: fixture.workspace}} : undefined)} : undefined)};
  /** 真实保存请求的正文（Ctrl+S 时捕获 ✓ —— 断言 Markdown 不靠 DOM 猜 ✓） */
  const saves = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url.startsWith('/api/')) {
        let bytes = '';
        for await (const chunk of request) bytes += chunk;
        const requestBody = bytes ? JSON.parse(bytes) : undefined;
        if (requestBody?.kind === 'save-node-document' && typeof requestBody.text === 'string') saves.push(requestBody.text);
        const result = await __internal.handleApiRequest(ctx, {focusLeaseMs: 3000}, {
          url: `http://localhost${request.url}`,
          method: request.method,
          json: async () => requestBody,
        }, state);
        response.statusCode = result.status;
        if (result.raw) {
          const buffer = Buffer.from(await result.raw.arrayBuffer());
          response.setHeader('content-type', result.raw.headers.get('content-type') ?? 'application/octet-stream');
          response.end(buffer);
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result.body));
        return;
      }
      response.setHeader('content-type', request.url.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
      response.end(request.url === '/app.js' ? app : request.url === '/plugin.js' ? compiled
        : `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}#app{height:${VIEWPORT.height}px;width:${PANEL_WIDTH}px}</style><div id="app"></div><script src="/app.js"></script><script src="/plugin.js"></script><script>mountGraph()</script>`);
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));

  const browser = await chromium.launch({executablePath: CHROME, headless: true});
  /* i3/i4 需要真实剪贴板读写（复制按钮 / 手动选中复制 / Ctrl+V）✓ */
  const context = await browser.newContext({viewport: VIEWPORT, permissions: ['clipboard-read', 'clipboard-write']});
  const page = await context.newPage();
  await page.addInitScript(installPageHelpers);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const requests = [];
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    requests.push({url: request.url(), body: (request.postData() ?? '').slice(0, 160)});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);

  const editor = () => page.locator('.kn-editor-rich .ProseMirror').first();
  const paragraph = () => page.locator('.kn-editor-rich .ProseMirror p').first();
  const menu = page.locator('[data-kn-block-menu]');

  async function openNote() {
    await page.getByRole('searchbox').waitFor({timeout: 20000});
    await page.getByRole('searchbox').fill(TITLE);
    await page.getByRole('option', {name: TITLE, exact: true}).click({timeout: 20000});
    await page.getByRole('button', {name: '编辑笔记', exact: true}).click({timeout: 20000});
    await page.locator('.kn-editor-title').filter({hasText: TITLE}).waitFor({timeout: 20000});
    await editor().waitFor({timeout: 30000});
    await page.waitForFunction(() => (window.__knTest.deepOne('.kn-editor-rich .ProseMirror')?.innerText ?? '').trim().length > 0, undefined, {timeout: 30000});
    await page.waitForTimeout(300);
  }

  /** 把光标放进正文（点段落左侧一点），再在同一坐标右键 ⇒ 行内格式菜单 */
  async function rightClickInParagraph() {
    const box = await paragraph().boundingBox();
    assert.notEqual(box, null, '正文段落要有布局盒子');
    const point = {x: box.x + Math.min(12, box.width / 3), y: box.y + box.height / 2};
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(80);
    await page.mouse.click(point.x, point.y, {button: 'right'});
    await menu.waitFor({state: 'visible', timeout: 8000});
    return menu;
  }

  async function clickMenuItem(label) {
    await menu.getByRole('menuitem', {name: label, exact: true}).click();
    await page.waitForTimeout(120);
  }

  async function saveNow() {
    const before = saves.length;
    /* 等编辑器的 onChange 冒到 NodeDocumentEditor（dirty 才算 canSave ✓） */
    await page.waitForTimeout(350);
    await page.keyboard.press('Control+s');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (saves.length > before) return saves.at(-1);
      await page.waitForTimeout(50);
    }
    const debug = await page.evaluate(() => {
      const inner = window.__knTest.deepOne('.kn-editor-rich .ProseMirror');
      const root = inner?.getRootNode();
      return {
        focused: inner !== null && inner === root?.activeElement,
        notices: [...window.__knTest.deepAll('.kn-editor-error, .kn-editor-notice')].map(el => el.innerText),
      };
    });
    throw new Error(`Ctrl+S 没有触发保存（saves=${saves.length}，requests=${JSON.stringify(requests.slice(-4))}，debug=${JSON.stringify(debug)}，pageErrors=${JSON.stringify(pageErrors)}）`);
  }

  async function reloadEditor() {
    await page.reload();
    await openNote();
  }

  async function close() {
    await browser.close().catch(() => {});
    await new Promise(done => server.close(done));
    state.dispose();
  }
  return {page, openNote, rightClickInParagraph, clickMenuItem, saveNow, reloadEditor, close, pageErrors, saves, requests, editor, paragraph, menu, fixture, nodeId};
}

/** 失败时把现场（菜单/DOM/保存正文/错误）打出来 ✓ */
async function diagnostics(harness, error) {
  let facts = {};
  try {
    facts = await harness.page.evaluate(() => ({
      editor: window.__knTest.deepOne('.kn-editor-rich .ProseMirror')?.innerText,
      html: window.__knTest.deepOne('.kn-editor-rich .ProseMirror')?.innerHTML.slice(0, 1200),
      menu: window.__knTest.deepOne('[data-kn-block-menu]')?.innerText ?? null,
      toolbar: window.__knTest.deepOne('.milkdown-toolbar')?.innerText ?? null,
      latex: window.__knTest.deepOne('.milkdown-latex-inline-edit')?.dataset.show ?? null,
      linkEdit: window.__knTest.deepOne('.milkdown-link-edit')?.innerText ?? null,
    }));
  } catch { /* 页面可能已经关了 ✓ */ }
  console.error('诊断：' + JSON.stringify({...facts, saves: harness.saves.slice(-2), pageErrors: harness.pageErrors, error: String(error)}));
  throw error;
}

describe('行内格式（真实面板 UI：划词后的浮动工具栏 ✓）', () => {
  it('a. 划词选中文字 ⇒ 浮动工具栏 8 个按钮（中文 title，含 clear 与「添加前置节点」）', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      const toolbar = await showToolbar(harness);
      const buttons = toolbar.locator('button[data-toolbar-item]');
      assert.equal(await buttons.count(), 8, '工具栏要有 8 个按钮（加粗/斜体/删除线/行内代码/行内公式/链接/清除格式/添加前置节点）');
      assert.deepEqual(
        await buttons.evaluateAll(els => els.map(el => el.getAttribute('data-toolbar-item'))),
        ['bold', 'italic', 'strikethrough', 'code', 'latex', 'link', 'clear', 'add-prerequisite'],
        '工具栏 8 个按钮（含 clear 与 add-prerequisite）',
      );
      const titles = await buttons.evaluateAll(els => els.map(el => el.getAttribute('title') ?? ''));
      for (const title of titles) assert.ok(/[\u4e00-\u9fff]/.test(title), `按钮 title 要是中文：${JSON.stringify(title)}`);
      for (const want of ['加粗', '斜体', '删除线', '行内代码', '行内公式', '链接', '清除文字格式', '添加前置节点']) {
        assert.ok(titles.some(title => title.includes(want)), `工具栏缺中文 title「${want}」：${JSON.stringify(titles)}`);
      }
      assert.equal(await harness.page.locator('.kn-note-selection').count(), 0, '选区旁不许再有独立的旧浮钮（已并进工具栏）');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('b. 工具栏「加粗 / 清除格式」：选区加粗落盘 **，clear 后去掉且 Markdown 同步', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      const before = await editorShape(harness);
      await clickToolbar(harness, 'bold');
      assert.equal(await harness.editor().locator('strong').first().textContent(), BODY, '选中文字加粗 ⇒ <strong>前文后文</strong>');
      assert.deepEqual(await editorShape(harness), before, '点工具栏按钮不能插入多余空段落 / 不能改正文结构');
      const boldSaved = await harness.saveNow();
      assert.ok(boldSaved.includes('**'), `加粗后保存的 Markdown 要含 **：${JSON.stringify(boldSaved)}`);

      const toolbar = await showToolbar(harness);
      await toolbar.locator('button[data-toolbar-item="clear"]').click();
      await harness.page.waitForTimeout(250);
      assert.equal(await harness.editor().locator('strong').count(), 0, '点 clear 要把选中文字的 strong 去掉');
      assert.deepEqual(await editorShape(harness), before, 'clear 之后文档结构仍是原来的单段');
      const clearedSaved = await harness.saveNow();
      assert.ok(!clearedSaved.includes('**'), `清除格式后保存的 Markdown 不能还有 **：${JSON.stringify(clearedSaved)}`);
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('c. 工具栏「行内代码」：选中文字 ⇒ <code>前文后文</code>，保存 Markdown 含反引号', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      const before = await editorShape(harness);
      await clickToolbar(harness, 'code');
      const code = harness.editor().locator('code');
      await code.waitFor({state: 'visible', timeout: 5000});
      assert.equal(await code.textContent(), BODY, '选中文字应整段变成行内代码');
      assert.deepEqual(await editorShape(harness), before, '点「行内代码」不能插入多余空段落');
      const saved = await harness.saveNow();
      assert.ok(saved.includes('`' + BODY + '`'), `保存的 Markdown 要含 \`前文后文\`：${JSON.stringify(saved)}`);
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('d. 工具栏「行内公式」：选中文字 ⇒ 转 inline math，保存 Markdown 含 $前文后文$', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      const before = await editorShape(harness);
      await clickToolbar(harness, 'latex');
      await harness.page.waitForTimeout(500);
      const after = await editorShape(harness);
      assert.equal(after.blocks, before.blocks, '点「行内公式」不能插入多余空段落（块数不变）');
      const math = await harness.page.evaluate(() => ({
        nodes: window.__knTest.deepAll('.kn-editor-rich [data-type="math_inline"]').length,
        katex: window.__knTest.deepAll('.kn-editor-rich .katex').length,
      }));
      assert.ok(math.nodes >= 1 || math.katex >= 1, `选区应转成行内公式：${JSON.stringify(math)}`);
      const saved = await harness.saveNow();
      assert.ok(saved.includes('$' + BODY + '$'), `保存的 Markdown 要含 $前文后文$：${JSON.stringify(saved)}`);
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('d2. 行内公式编辑小浮窗：确认按钮自适应宽度、文字不换行（用户截图回归）', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      await clickToolbar(harness, 'latex');
      await harness.page.waitForTimeout(500);
      /* 点刚转出来的行内公式 ⇒ Crepe 的行内编辑小浮窗出现（真实面板 + shadow DOM 穿透 ✓） */
      const math = harness.page.locator('.kn-editor-rich [data-type="math_inline"]').first();
      await math.click();
      await harness.page.waitForTimeout(400);
      const metrics = await harness.page.evaluate(() => {
        const tip = window.__knTest.deepOne('.kn-editor-rich .milkdown-latex-inline-edit[data-show="true"]');
        if (tip === null) return null;
        const button = tip.querySelector('.container button');
        if (button === null) return null;
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return {
          text: button.textContent,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          whiteSpace: style.whiteSpace,
          scrollHeight: button.scrollHeight,
          clientHeight: button.clientHeight,
        };
      });
      assert.notEqual(metrics, null, '行内公式编辑小浮窗要出现（否则无法验证按钮布局）');
      assert.equal(metrics.text, '完成', '确认按钮文案是「完成」');
      /*
       * 用户截图：Crepe 主题把按钮写死 24×24（图标位）⇒ 中文被挤成竖排 ✗。
       * 现在应是正常文字按钮：自适应宽度（≥40）、文字单行（nowrap、scrollHeight 不超过 clientHeight）✓。
       */
      assert.ok(metrics.width >= 40, `确认按钮要自适应宽度（≥40px）：${JSON.stringify(metrics)}`);
      assert.ok(metrics.height >= 22 && metrics.height <= 32, `确认按钮高度要正常（22–32px）：${JSON.stringify(metrics)}`);
      assert.equal(metrics.whiteSpace, 'nowrap', '确认按钮文字不能换行');
      assert.ok(metrics.scrollHeight <= metrics.clientHeight + 1, `「完成」不能折成两行：${JSON.stringify(metrics)}`);
      /*
       * 用户要求：点「完成」后小浮窗要**消失** ✓（Crepe 自己只更新公式值、不隐藏浮窗 ✗）。
       * 插件在确认后把选区挪到公式后面 ⇒ 浮窗收起、焦点回正文 ✓。
       */
      const confirm = harness.page.locator('.kn-editor-rich .milkdown-latex-inline-edit .container button').first();
      await confirm.click();
      await harness.page.waitForTimeout(400);
      const dismissed = await harness.page.evaluate(() => {
        const tip = window.__knTest.deepOne('.kn-editor-rich .milkdown-latex-inline-edit');
        if (tip === null) return null;
        /* 面板在 shadow DOM 里：焦点要按"编辑器所在文档树的 activeElement"判断 ✓ */
        const editor = window.__knTest.deepOne('.kn-editor-rich .ProseMirror');
        const focusRoot = editor === null ? null : editor.getRootNode();
        return {
          show: tip.getAttribute('data-show'),
          display: getComputedStyle(tip).display,
          focused: editor !== null && focusRoot !== null && focusRoot.activeElement === editor,
        };
      });
      assert.notEqual(dismissed, null, '小浮窗节点应仍在 DOM 里（只是隐藏）');
      assert.notEqual(dismissed.show, 'true', '点「完成」后小浮窗必须收起（data-show 不能还是 true）');
      assert.equal(dismissed.display, 'none', '点「完成」后小浮窗必须隐藏（display none）');
      assert.equal(dismissed.focused, true, '点「完成」后焦点要回到正文，方便继续输入');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('e. 工具栏「链接」：输入框中文占位 + URL 落盘，选中文字成为链接文字', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      const before = await editorShape(harness);
      await clickToolbar(harness, 'link');
      await harness.page.waitForTimeout(300);
      const input = harness.page.locator('.milkdown-link-edit .input-area');
      /* Lead 已修「点工具栏被当成点下方空白」⇒ 输入框必须一直可见、文档不能多出空段落 ✓ */
      await input.waitFor({state: 'visible', timeout: 8000});
      assert.equal(await input.isVisible(), true, '链接输入框不能一闪而过（点工具栏不该被当成点正文下方空白）');
      assert.equal(await input.getAttribute('placeholder'), '粘贴链接…', '链接输入框占位符要中文');
      assert.deepEqual(await editorShape(harness), before, '点「链接」不能插入多余空段落 / 不能改正文');
      await input.fill('https://example.com');
      await input.press('Enter');
      await harness.page.waitForTimeout(300);
      const saved = await harness.saveNow();
      assert.ok(saved.includes('https://example.com'), `保存的 Markdown 要含链接地址：${JSON.stringify(saved)}`);
      assert.ok(saved.includes('前文后文'), '选中文字要成为链接文字');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('f. 工具栏「＋ 添加前置节点」：打开关系面板并预填选中原文', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      const before = await editorShape(harness);
      await clickToolbar(harness, 'add-prerequisite');
      const popover = harness.page.locator('.kn-note-relations-popover');
      await popover.waitFor({state: 'visible', timeout: 8000});
      assert.ok((await popover.innerText()).includes('添加前置'), '关系面板要切到「添加前置」✓');
      assert.equal(await popover.locator('input').inputValue(), BODY, '标题要预填**选中的原文** ✓');
      assert.deepEqual(await editorShape(harness), before, '点「添加前置节点」不能插入多余空段落');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('g. 右键菜单反向断言：不再有「行内格式」组/条目，仍是纯块插入菜单', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      await rightClickBlockMenu(harness);
      const menuText = await harness.menu.innerText();
      for (const gone of ['行内格式', '加粗', '斜体', '删除线', '行内代码', '行内公式', '清除文字格式']) {
        assert.ok(!menuText.includes(gone), `右键菜单不该再有行内格式内容「${gone}」：${JSON.stringify(menuText)}`);
      }
      const items = await harness.menu.locator('[role="menuitem"]').allTextContents();
      for (const want of ['图片', '代码块', '表格', '公式块']) {
        assert.ok(items.includes(want), `右键菜单仍应是块插入菜单（缺「${want}」）：${JSON.stringify(items)}`);
      }
      for (const group of ['插入', '文本', '列表']) assert.ok(menuText.includes(group), `块菜单分组「${group}」要保留：${JSON.stringify(menuText)}`);
      assert.equal(await harness.editor().evaluate(el => el.children.length), 1, '块菜单不能拆段落');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('h. 公式块（shadow DOM 真实面板）：右键插入后首次输入不会把源码编辑区收起来', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      await rightClickBlockMenu(harness);
      await harness.clickMenuItem('公式块');
      await harness.page.waitForTimeout(700);
      const editorArea = harness.page.locator('.kn-editor-rich .milkdown-code-block .codemirror-host .cm-content').first();
      await editorArea.waitFor({state: 'visible', timeout: 8000});
      await editorArea.click();
      await harness.page.waitForTimeout(250);
      await harness.page.keyboard.type('E');
      await harness.page.waitForTimeout(500);
      /*
       * 用户第九/十轮实测：公式块第一次输入后「编辑源码」界面被自动收起 ✗。
       * 面板内容在 shadow DOM 里 ⇒ `document.activeElement` 只是 shadow host ✗，
       * 补丁必须看 `getRootNode().activeElement` 才能判断"焦点还在 CodeMirror 里"✓。
       */
      const editing = await harness.page.evaluate(() => {
        const host = window.__knTest.deepOne('.kn-editor-rich .milkdown-code-block .codemirror-host');
        if (host === null) return null;
        return {hidden: host.classList.contains('hidden') || getComputedStyle(host).display === 'none'};
      });
      assert.notEqual(editing, null, '公式块的源码编辑区要存在');
      assert.equal(editing.hidden, false, '公式块第一次输入后编辑源码界面不能自动收起');
      await harness.page.keyboard.type('=mc^2');
      await harness.page.waitForTimeout(300);
      const saved = await harness.saveNow();
      assert.ok(saved.includes('E=mc^2'), `公式块内容要完整落盘：${JSON.stringify(saved)}`);
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('i. Ctrl+S 保存后焦点与光标位置仍在（不用鼠标重开才能继续写）', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      await harness.paragraph().click();
      await harness.page.waitForTimeout(300);
      await harness.page.keyboard.press('End');
      await harness.page.keyboard.type('X');
      await harness.page.waitForTimeout(350);
      /* 保存期间编辑器会切只读（contenteditable=false ⇒ 浏览器会把焦点移走 ✗） */
      await harness.saveNow();
      /* 等保存完成 + 焦点恢复（补丁在 readOnly 结束时把焦点还给正文 ✓） */
      await harness.page.waitForFunction(() => {
        const editor = window.__knTest.deepOne('.kn-editor-rich .ProseMirror');
        if (editor === null) return false;
        const root = editor.getRootNode();
        return root !== null && root.activeElement === editor;
      }, undefined, {timeout: 8000}).catch(() => {});
      const focus = await harness.page.evaluate(() => {
        const editor = window.__knTest.deepOne('.kn-editor-rich .ProseMirror');
        if (editor === null) return null;
        const root = editor.getRootNode();
        return {focused: root !== null && root.activeElement === editor, text: editor.innerText};
      });
      assert.notEqual(focus, null, '编辑器要存在');
      assert.equal(focus.focused, true, '保存后焦点要回到正文（光标竖线还在）');
      /* 不点鼠标、直接接着输入 ⇒ 应该落在保存时的位置后面 ✓ */
      await harness.page.keyboard.type('Y');
      await harness.page.waitForTimeout(350);
      const text = await harness.editor().innerText();
      assert.ok(text.includes('XY'), `保存后不用点击就能接着输入（光标位置没丢）：${JSON.stringify(text)}`);
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('j. 代码块/公式块上下留白收紧：公式块工具条浮层化、块高度明显变小', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      /* 插入公式块并输入一个字符（进入有预览的编辑态） */
      await rightClickBlockMenu(harness);
      await harness.clickMenuItem('公式块');
      await harness.page.waitForTimeout(700);
      const formulaEditor = harness.page.locator('.kn-editor-rich .milkdown-code-block .codemirror-host .cm-content').first();
      await formulaEditor.click();
      await harness.page.waitForTimeout(250);
      await harness.page.keyboard.type('E');
      await harness.page.waitForTimeout(400);
      /* 悬停露出浮层工具条 ⇒ 点「只看结果」切预览态 */
      await harness.page.locator('.kn-editor-rich .milkdown-code-block').first().hover();
      await harness.page.waitForTimeout(250);
      await harness.page.locator('.kn-editor-rich .milkdown-code-block .preview-toggle-button').first().click();
      await harness.page.waitForTimeout(400);
      /* 再插一个普通代码块，量通用块 ✓ */
      await rightClickBlockMenu(harness);
      await harness.clickMenuItem('代码块');
      await harness.page.waitForTimeout(600);
      const blocks = await harness.page.evaluate(() => window.__knTest.deepAll('.kn-editor-rich .milkdown-code-block').map(block => {
        const rect = block.getBoundingClientRect();
        const style = getComputedStyle(block);
        const tools = block.querySelector(':scope > .tools');
        const formula = block.querySelector('.preview .katex-display') !== null;
        return {
          formula,
          height: Math.round(rect.height),
          marginTop: style.marginTop,
          toolsPosition: tools === null ? null : getComputedStyle(tools).position,
          toolsHeight: tools === null ? null : Math.round(tools.getBoundingClientRect().height),
        };
      }));
      const formulaBlock = blocks.find(block => block.formula);
      const codeBlock = blocks.find(block => !block.formula);
      assert.notEqual(formulaBlock, undefined, '公式块要存在');
      assert.notEqual(codeBlock, undefined, '普通代码块要存在');
      /* 公式块：工具条必须脱离文档流（不再常驻占一行）、块高明显变小、外边距 8px ✓ */
      assert.equal(formulaBlock.toolsPosition, 'absolute', '公式块工具条要浮层化（不占排版高度）');
      assert.ok(formulaBlock.height <= 60, `公式块高度应收紧（≤60px）：${JSON.stringify(formulaBlock)}`);
      assert.equal(formulaBlock.marginTop, '8px', '公式块上下外边距要 8px');
      /* 通用代码块：工具条 ≤26px、块高 ≤70px、外边距 8px ✓ */
      assert.ok(codeBlock.toolsHeight <= 26, `代码块工具条高度要收紧（≤26px）：${JSON.stringify(codeBlock)}`);
      assert.ok(codeBlock.height <= 70, `普通代码块高度要收紧（≤70px）：${JSON.stringify(codeBlock)}`);
      assert.equal(codeBlock.marginTop, '8px', '代码块上下外边距要 8px');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('i2. 行内代码样式跟随 DSH：inline-flex / 0.5px 边 / 0.875em / 5px 内边距', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      await clickToolbar(harness, 'code');
      await harness.page.locator('.kn-editor-rich .ProseMirror code').first().waitFor({state: 'visible', timeout: 5000});
      const style = await harness.page.evaluate(() => {
        const code = window.__knTest.deepOne('.kn-editor-rich .ProseMirror code');
        const paragraph = window.__knTest.deepOne('.kn-editor-rich .ProseMirror p');
        if (code === null || paragraph === null) return null;
        const cs = getComputedStyle(code);
        const ps = getComputedStyle(paragraph);
        return {
          display: cs.display,
          borderWidth: parseFloat(cs.borderTopWidth),
          borderRadius: cs.borderTopLeftRadius,
          paddingLeft: cs.paddingLeft,
          fontSize: parseFloat(cs.fontSize),
          paragraphFontSize: parseFloat(ps.fontSize),
        };
      });
      assert.notEqual(style, null, '行内代码元素要存在');
      /* 计算样式：规则真的生效 ✓（Chrome 的 border used value 会把 0.5px 取整成 1px，
         所以 0.5px 那条从下面的源码声明断言 ✓） */
      assert.equal(style.display, 'inline-flex', '行内代码要 inline-flex（DSH 同款）');
      assert.equal(style.paddingLeft, '5px', '左右内边距要是 5px');
      assert.ok(style.borderWidth > 0 && style.borderWidth <= 1, `边框要细（used value ${style.borderWidth}px）`);
      assert.notEqual(style.borderRadius, '0px', '圆角要走 --dsw-radius-sm（不是直角）');
      const expectedFontSize = style.paragraphFontSize * 0.875;
      assert.ok(Math.abs(style.fontSize - expectedFontSize) <= 0.5, `字号 ≈ 正文 0.875（正文 ${style.paragraphFontSize}px，代码 ${style.fontSize}px）`);
      /* 声明本身要是 DSH 同款 ✓（简写里含 var() 时 CSSOM 取到空串 ✗ ⇒ 读源码规则块 ✓） */
      const ruleAt = EDITOR_OVERRIDES_CSS.indexOf('.kn-root .kn-editor-rich .milkdown :not(pre) > code {');
      assert.notEqual(ruleAt, -1, '样式表里要有行内代码那条规则');
      const ruleBlock = EDITOR_OVERRIDES_CSS.slice(ruleAt, ruleAt + 900);
      for (const part of [
        'display: inline-flex',
        'font-size: 0.875em',
        'padding: 0 5px',
        'border-width: 0.5px',
        'border-style: solid',
        'border-radius: var(--dsw-radius-sm',
        'background: var(--dsw-alias-markdown-inline-code)',
      ]) {
        assert.ok(ruleBlock.includes(part), `行内代码样式要有 ${part} ✓`);
      }
      assert.ok(!/border-color:\s*var\([^)]*,/.test(ruleBlock), '颜色 token 不许再带硬编码兜底 ✗');
      assert.ok(!/color:\s*#[0-9a-f]{6}/i.test(ruleBlock), '行内代码不许再用硬编码红色文字 ✗');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('i3. 右上角「复制」按钮 = 结构化复制：粘贴还原成完整代码块（数量 +1）', async () => {
    const harness = await startHarness(CODE_BODY);
    try {
      await harness.openNote();
      const blocks = harness.page.locator('.kn-editor-rich .milkdown-code-block');
      const before = await blocks.count();
      assert.ok(before >= 1, '夹具里要有代码块');
      const first = blocks.first();
      await first.hover();
      await harness.page.waitForTimeout(250);
      await first.locator('.copy-button').first().click({force: true});
      await harness.page.waitForTimeout(700);
      /* 点正文段落末尾 ⇒ Ctrl+V ⇒ 多出一个完整代码块 ✓ */
      await harness.paragraph().click();
      await harness.page.waitForTimeout(300);
      await harness.page.keyboard.press('End');
      await harness.page.keyboard.press('Control+V');
      await harness.page.waitForTimeout(900);
      assert.equal(await blocks.count(), before + 1, '复制按钮的剪贴板粘贴后要还原成完整代码块（块数 +1）');
      assert.ok((await harness.editor().innerText()).includes('cout'), '原代码块内容保留');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('i4. 手动选中复制 = 纯文本粘贴（不还原成块），且「复制按钮」记忆不串', async () => {
    const harness = await startHarness(CODE_BODY);
    try {
      await harness.openNote();
      const blocks = harness.page.locator('.kn-editor-rich .milkdown-code-block');
      const before = await blocks.count();
      /* 先点一次「复制」按钮（结构化，留下"刚复制块"记忆） */
      const first = blocks.first();
      await first.hover();
      await harness.page.waitForTimeout(250);
      await first.locator('.copy-button').first().click({force: true});
      await harness.page.waitForTimeout(600);
      /* 再在代码块里手动全选复制（应覆盖记忆、只写纯文本） */
      const cmContent = harness.page.locator('.kn-editor-rich .milkdown-code-block .cm-content').first();
      await cmContent.click();
      await harness.page.waitForTimeout(300);
      await harness.page.keyboard.press('Control+A');
      await harness.page.keyboard.press('Control+C');
      await harness.page.waitForTimeout(400);
      const clipboard = await harness.page.evaluate(async () => {
        try {
          const items = await navigator.clipboard.read();
          return {types: [...new Set(items.flatMap(item => item.types))], text: await navigator.clipboard.readText()};
        } catch (error) { return {error: String(error)}; }
      });
      if (!('error' in clipboard)) {
        assert.ok(clipboard.types.includes('text/plain'), '手动选中复制至少要写 text/plain');
        assert.ok(!clipboard.types.some(type => type.startsWith('web ') || type.includes('kn-code-block')), `手动选中复制不许写结构化载荷：${JSON.stringify(clipboard.types)}`);
        assert.ok(clipboard.text.includes('cout'), '剪贴板纯文本要含选中的代码');
      }
      /* 粘贴到正文段落末 ⇒ 纯文本、不新增代码块 ✓ */
      await harness.paragraph().click();
      await harness.page.waitForTimeout(300);
      await harness.page.keyboard.press('End');
      await harness.page.keyboard.press('Control+V');
      await harness.page.waitForTimeout(900);
      assert.equal(await blocks.count(), before, '手动选中复制的粘贴不许还原成代码块（块数不变）');
      assert.ok((await harness.editor().innerText()).includes('cout'), '代码内容要按纯文本插入');
      /* 复核查出的边界：同一段"手动选中复制"连续粘贴第二次也必须还是纯文本 ✓（标记不被粘贴消费 ✓） */
      await harness.page.keyboard.press('Control+V');
      await harness.page.waitForTimeout(900);
      assert.equal(await blocks.count(), before, '同一剪贴板第二次粘贴也不许还原成代码块（块数仍不变）');
      /*
       * 用户实测回归：纯文本粘贴里的尖括号（如 `#include<iostream>`）由序列化转义成 `\<iostream>` ✓，
       * 不能被语法嗅探误报成"原始 HTML 标签"、冒出"正文编辑器无法原样保留的语法"提示 ✗。
       */
      const notices = await harness.page.evaluate(() =>
        window.__knTest.deepAll('.kn-editor-notice').map(element => element.innerText));
      assert.ok(
        !notices.some(text => text.includes('无法原样保留')),
        `纯文本粘贴不应触发"无法原样保留"提示：${JSON.stringify(notices)}`,
      );
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('j2. 「＋ 添加前置」移进「前置」弹窗；点旁边空白 / Esc ⇒ 关闭', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      /* 标题栏里有两个 `.kn-note-relations`（对话入口 + 关系）：按「前置」按钮认关系那一个 ✓ */
      const relationsRoot = harness.page.locator('.kn-editor-heading > .kn-note-relations')
        .filter({has: harness.page.getByRole('button', {name: /^前置/})});
      assert.equal(await relationsRoot.count(), 1, '要找到关系组件');
      assert.equal(await relationsRoot.locator('> button').count(), 2, '标题栏只剩「前置」「被依赖」两颗按钮');
      assert.equal(await harness.page.locator('.kn-editor-heading .kn-note-relations-add').count(), 0, '标题栏不再有「＋ 添加前置」');
      const popover = harness.page.locator('.kn-note-relations-popover');
      const preButton = relationsRoot.locator('> button').first();
      const dependButton = relationsRoot.locator('> button').nth(1);
      /* 「前置」弹窗里才有入口 ✓ */
      await preButton.click();
      await popover.waitFor({state: 'visible', timeout: 8000});
      const add = popover.locator('.kn-note-relations-add');
      await add.waitFor({state: 'visible', timeout: 5000});
      assert.ok((await add.innerText()).includes('添加前置'), '弹窗里的入口文案是「＋ 添加前置」');
      await add.click();
      await harness.page.waitForTimeout(250);
      await popover.locator('input').waitFor({state: 'visible', timeout: 5000});
      /* 点旁边空白 ⇒ 关闭 ✓（shadow DOM 安全 ✓） */
      await harness.page.mouse.click(400, 300);
      await harness.page.waitForTimeout(350);
      assert.equal(await popover.count(), 0, '点弹窗旁边空白要关闭');
      /* 被依赖弹窗 + Esc ⇒ 关闭 ✓ */
      await dependButton.click();
      await popover.waitFor({state: 'visible', timeout: 8000});
      await harness.page.keyboard.press('Escape');
      await harness.page.waitForTimeout(350);
      assert.equal(await popover.count(), 0, 'Esc 要关闭弹窗');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });
});

/** 编辑器块结构（块数 + 文本）：钉住"点工具栏不会插入多余空段落" ✓（忽略 Crepe 的 placeholder 装饰节点 ✓） */
async function editorShape(harness) {
  return harness.editor().evaluate(el => {
    const blocks = [...el.children].filter(child => !child.classList.contains('crepe-placeholder'));
    return {blocks: blocks.length, text: blocks.map(child => child.textContent).join('\n').trim()};
  });
}

/** 划词选中正文整段并等浮动工具栏出现（click 后等 300ms 避开既有选区时序 flake ✓） */
async function showToolbar(harness) {
  await harness.paragraph().click();
  await harness.page.waitForTimeout(300);
  await harness.page.keyboard.press('Home');
  await harness.page.keyboard.press('Shift+End');
  await harness.page.waitForTimeout(150);
  const toolbar = harness.page.locator('.milkdown-toolbar[data-show="true"]');
  await toolbar.waitFor({state: 'visible', timeout: 8000});
  return toolbar;
}

/** 划词 + 点工具栏某一项（命令只作用于选区 ✓） */
async function clickToolbar(harness, item) {
  const toolbar = await showToolbar(harness);
  await toolbar.locator('button[data-toolbar-item="' + item + '"]').click();
  await harness.page.waitForTimeout(250);
}

/** 光标收进段落（无选区）后右键 ⇒ 块插入菜单 */
async function rightClickBlockMenu(harness) {
  const box = await harness.paragraph().boundingBox();
  assert.notEqual(box, null, '正文段落要有布局盒子');
  const point = {x: box.x + Math.min(12, box.width / 3), y: box.y + box.height / 2};
  await harness.page.mouse.click(point.x, point.y);
  await harness.page.waitForTimeout(300);
  await harness.page.mouse.click(point.x, point.y, {button: 'right'});
  await harness.menu.waitFor({state: 'visible', timeout: 8000});
}
