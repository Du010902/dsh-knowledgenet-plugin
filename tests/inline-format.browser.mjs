/**
 * **行内格式（真实面板）浏览器 E2E** —— `design/inline-format-fix.md`。
 *
 * 旧版 `inline-format.browser.mjs` 只直接调命令（命令本身能跑通，但用户实测"UI 里没反应" ✗）。
 * 这里改成**真实面板级**驱动（骨架同 `tests/note-images.browser.mjs`）：
 * 造 v3 库 → 真实 `GraphPanel` + 假 `/api/` → 搜索节点 → 「编辑笔记」→ 在**真实编辑器 UI** 上
 * 右键/工具栏/种子输入，再用 Ctrl+S 的**保存请求正文**核对 Markdown。
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
const VIEWPORT = {width: 1920, height: 1080};
const PANEL_WIDTH = 900;

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

async function startHarness() {
  const fixture = await makeV3Fixture({nodes: [TITLE]});
  const nodeId = fixture.nodes[TITLE].id;
  const written = await writeNote(fixture.root, {id: nodeId, text: BODY});
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
  const context = await browser.newContext({viewport: VIEWPORT});
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
    await page.waitForFunction(() => window.__knTest.deepOne('.kn-editor-rich .ProseMirror')?.innerText.includes('文后文'), undefined, {timeout: 30000});
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
      hint: window.__knTest.deepOne('.kn-inline-hint')?.innerText ?? null,
      toolbar: window.__knTest.deepOne('.milkdown-toolbar')?.innerText ?? null,
      latex: window.__knTest.deepOne('.milkdown-latex-inline-edit')?.dataset.show ?? null,
      linkEdit: window.__knTest.deepOne('.milkdown-link-edit')?.innerText ?? null,
    }));
  } catch { /* 页面可能已经关了 ✓ */ }
  console.error('诊断：' + JSON.stringify({...facts, saves: harness.saves.slice(-2), pageErrors: harness.pageErrors, error: String(error)}));
  throw error;
}

describe('行内格式（真实面板 UI）', () => {
  it('a. 光标处右键 ⇒ 「行内格式」组 + 7 个中文条目，且不拆段落', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      const box = await harness.paragraph().boundingBox();
      assert.notEqual(box, null, '正文段落要有布局盒子');
      const point = {x: box.x + Math.min(12, box.width / 3), y: box.y + box.height / 2};
      await harness.page.mouse.click(point.x, point.y);
      await harness.page.waitForTimeout(80);
      await harness.page.mouse.click(point.x, point.y, {button: 'right'});
      await harness.menu.waitFor({state: 'visible', timeout: 8000});

      const text = await harness.menu.innerText();
      assert.ok(text.includes('行内格式'), `菜单要有「行内格式」分组标题：${JSON.stringify(text)}`);
      const items = await harness.menu.locator('[role="menuitem"]').allTextContents();
      assert.deepEqual(
        items.slice(0, 7),
        ['加粗', '斜体', '删除线', '行内代码', '行内公式', '链接', '清除文字格式'],
        `行内格式组应排最前且 7 项齐全（实际 ${JSON.stringify(items)}）`,
      );
      const editorText = await harness.editor().innerText();
      assert.equal(editorText, BODY, '打开菜单不能改正文');
      assert.equal(await harness.editor().evaluate(el => el.children.length), 1, '行内菜单不能拆段落（body 仍是一个 p）');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('b. 点「加粗」⇒ 短提示 + 输入 X 得到 <strong>X</strong>，保存的 Markdown 含 **X**', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      await harness.rightClickInParagraph();
      await harness.clickMenuItem('加粗');
      const hint = harness.page.locator('.kn-inline-hint');
      await hint.waitFor({state: 'visible', timeout: 3000});
      assert.match(await hint.innerText(), /已开启加粗/, '空光标加粗要给短提示');
      await harness.page.keyboard.type('X');
      await harness.page.waitForFunction(() =>
        window.__knTest.deepOne('.kn-editor-rich .ProseMirror strong')?.textContent === 'X', undefined, {timeout: 5000});
      const saved = await harness.saveNow();
      assert.ok(saved.includes('**X**'), `保存的 Markdown 要含 **X**：${JSON.stringify(saved)}`);
      await harness.reloadEditor();
      assert.equal(await harness.editor().locator('strong').textContent(), 'X', '重新载入后加粗标记仍在');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('c. 点「行内代码」⇒ 占位 <code>代码</code>，连续键入 YZ 后整段都在 code 里，Markdown 含 `YZ`', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      await harness.rightClickInParagraph();
      await harness.clickMenuItem('行内代码');
      const code = harness.editor().locator('code');
      await code.waitFor({state: 'visible', timeout: 5000});
      assert.equal(await code.textContent(), '代码', '空光标要插入被选中的占位文字');
      /* 连敲两个字符：`inlineCode` 是 inclusive:false，第二字会落在标记右边界外 ✗ ——
         插件用"光标没挪开就继续带标记插入"补上了，这里就是钉这条（verify 复核建议 ✓）。*/
      await harness.page.keyboard.type('YZ');
      await harness.page.waitForFunction(() =>
        window.__knTest.deepOne('.kn-editor-rich .ProseMirror code')?.textContent === 'YZ', undefined, {timeout: 5000});
      const saved = await harness.saveNow();
      assert.ok(saved.includes('`YZ`'), `保存的 Markdown 要含 \`YZ\`：${JSON.stringify(saved)}`);
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('d. 点「行内公式」⇒ 编辑框出现且已聚焦；输入 x^2 + Enter，保存含 $x^2$，重载后仍在', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      await harness.rightClickInParagraph();
      await harness.clickMenuItem('行内公式');
      const latex = harness.page.locator('.milkdown-latex-inline-edit[data-show="true"]');
      await latex.waitFor({state: 'visible', timeout: 8000});
      const focused = await harness.page.evaluate(() => {
        const inner = window.__knTest.deepOne('.milkdown-latex-inline-edit .ProseMirror');
        return inner !== null && inner === inner.getRootNode().activeElement;
      });
      assert.equal(focused, true, '插入空公式后编辑框要自动获得焦点');
      await harness.page.keyboard.type('x^2');
      await harness.page.keyboard.press('Enter');
      await harness.page.waitForTimeout(300);
      const saved = await harness.saveNow();
      assert.match(saved, /\$x\^2\$/, `保存的 Markdown 要含 $x^2$：${JSON.stringify(saved)}`);
      await harness.reloadEditor();
      await harness.page.locator('.kn-editor-rich .katex, .kn-editor-rich [data-type="math_inline"]').first().waitFor({state: 'visible', timeout: 8000});
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('e. 点「链接」⇒ 输入框占位符是中文「粘贴链接…」，输入 URL + Enter 落成链接', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      await harness.rightClickInParagraph();
      await harness.clickMenuItem('链接');
      const input = harness.page.locator('.milkdown-link-edit .input-area');
      await input.waitFor({state: 'visible', timeout: 8000});
      assert.equal(await input.getAttribute('placeholder'), '粘贴链接…', '链接输入框占位符要中文');
      await input.fill('https://example.com');
      await input.press('Enter');
      await harness.page.waitForTimeout(300);
      const saved = await harness.saveNow();
      assert.ok(saved.includes('https://example.com'), `保存的 Markdown 要含链接地址：${JSON.stringify(saved)}`);
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('f. 选中文字 ⇒ 悬浮工具栏 7 个中文 title（含 clear）；点 clear 去掉 strong', async () => {
    const harness = await startHarness();
    try {
      await harness.openNote();
      await selectAll(harness);
      const toolbar = harness.page.locator('.milkdown-toolbar[data-show="true"]');
      await toolbar.waitFor({state: 'visible', timeout: 8000});
      const buttons = toolbar.locator('button[data-toolbar-item]');
      assert.equal(await buttons.count(), 7, '工具栏要有 7 个按钮（加粗/斜体/删除线/行内代码/行内公式/链接/清除格式）');
      const titles = await buttons.evaluateAll(els => els.map(el => el.getAttribute('title') ?? ''));
      for (const title of titles) assert.ok(/[\u4e00-\u9fff]/.test(title), `按钮 title 要是中文：${JSON.stringify(title)}`);
      for (const want of ['加粗', '斜体', '删除线', '行内代码', '行内公式', '链接', '清除文字格式']) {
        assert.ok(titles.some(title => title.startsWith(want)), `工具栏缺中文 title「${want}」：${JSON.stringify(titles)}`);
      }
      assert.deepEqual(
        await buttons.evaluateAll(els => els.map(el => el.getAttribute('data-toolbar-item'))),
        ['bold', 'italic', 'strikethrough', 'code', 'latex', 'link', 'clear'],
        '工具栏 7 个按钮（含 clear）',
      );
      await toolbar.locator('button[data-toolbar-item="bold"]').click();
      await harness.page.waitForTimeout(200);
      assert.equal(await harness.editor().locator('strong').first().textContent(), BODY, '点加粗要给整段加 <strong>');
      const boldSaved = await harness.saveNow();
      assert.ok(boldSaved.includes('**'), `加粗后保存的 Markdown 要含 **：${JSON.stringify(boldSaved)}`);
      if (!(await harness.page.locator('.milkdown-toolbar[data-show="true"]').isVisible().catch(() => false))) {
        await selectAll(harness);
        await harness.page.locator('.milkdown-toolbar[data-show="true"]').waitFor({state: 'visible', timeout: 8000});
      }
      await harness.page.locator('.milkdown-toolbar[data-show="true"] button[data-toolbar-item="clear"]').click();
      await harness.page.waitForTimeout(200);
      assert.equal(await harness.editor().locator('strong').count(), 0, '点 clear 要把选中文字的 strong 去掉');
      const clearedSaved = await harness.saveNow();
      assert.ok(!clearedSaved.includes('**'), `清除格式后保存的 Markdown 不能还有 **：${JSON.stringify(clearedSaved)}`);
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });
});

/** 选中正文整段（Home → Shift+End）⇒ 触发 Crepe 悬浮工具栏 */
async function selectAll(harness) {
  await harness.paragraph().click();
  await harness.page.keyboard.press('Home');
  await harness.page.keyboard.press('Shift+End');
  await harness.page.waitForTimeout(150);
}
