/**
 * **外部代码粘贴健壮性 + 空引用块退出**的浏览器 E2E（真实构建产物 `client.js`）。
 *
 * 用户第三轮反馈（两张截图）：
 * ① 从外部复制代码粘进正文后：引用块每行被加 `>`、`#include<iostream>` 变成原始 HTML、
 *    空行分段、出现畸形表格/`<br />`，最后整篇被踢进纯文本 ✗；
 * ② 引用块删空后变成一条清不掉的竖条（空 blockquote 无法删除）✗。
 *
 * 这里用**真实 client.js 独立挂 MarkdownRichEditor**（paste / 按键都在编辑器内部），
 * 用合成 `ClipboardEvent`（DataTransfer 带 text/plain、text/html）驱动粘贴：
 * a. 纯文本 C++ ⇒ 完整代码块（原文逐字、无 HTML 节点、原段落保留）；
 * b. 引用块内粘贴同一段代码 ⇒ 代码块出现且引用结构不丢；
 * c. 普通多行中文 ⇒ 不误判成代码块；
 * d. 以 ``` 开头的围栏 Markdown ⇒ 不被启发式接管（围栏不塞进代码块）；
 * e. 空引用块在边缘按 Backspace ⇒ 整块删掉、后面的正文保留；
 * f. 单段落引用在开头 Backspace / 末尾 Delete ⇒ 拆壳、文字保留。
 *
 * 运行：
 *   $env:KN_PROJECT='D:/AppInstallation/DSH/deepseek-harness'
 *   node --test tests/block-robustness.browser.mjs
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {describe, it} from 'node:test';

const project = process.env.KN_PROJECT;
if (!project) throw Error('Set KN_PROJECT to the DSH dependency checkout.');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const DEPS = REPO + '/.tmp-build-deps';
const CHROME = process.env.KN_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** 用户截图里的外部 C++ 样本（含尖括号 / 空行 / 缩进 ✓） */
const EXTERNAL_CPP = [
  '#include<iostream>',
  'using namespace std;',
  '',
  'int main() {',
  '    int a, b;',
  '    cin >> a >> b;',
  '    cout << a + b << endl;',
  '    return 0;',
  '}',
].join('\n');

function pnpmEntries(base) {
  try { return readdirSync(base).filter(name => !name.startsWith('@')); } catch { return []; }
}
function firstExisting(candidates, label) {
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  throw new Error(`找不到${label}；尝试过：\n${candidates.filter(Boolean).join('\n')}`);
}
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

/** 宿主 ui-primitives 的替身：本测试不点菜单，但编辑器 import 了 Menu / ImageLightbox ✓ */
const HOST_STUB = `
function HostMenu(props) { return null; }
const ImageLightbox = function ImageLightbox() { return null; };
window.__hostPrimitives = {Menu: HostMenu, ImageLightbox};
window.__ModuleLoader__ = {load: ({factory}) => {
  window.plugin = factory(name => ({
    'react': React, 'react-dom': ReactDOM, 'react/jsx-runtime': JSX,
    '@deepseek-ai/dsh-client-ui-primitives': window.__hostPrimitives,
  }[name]));
}};
`;

async function startHarness() {
  const tooling = resolveTooling();
  const {rolldown} = await import(pathToFileURL(tooling.rolldownPath).href);
  const {chromium} = await import(pathToFileURL(tooling.playwrightPath).href);
  const entry = `import React from 'react';import * as ReactDOM from 'react-dom';import * as JSX from 'react/jsx-runtime';import {createRoot} from 'react-dom/client';
${HOST_STUB}
const root = createRoot(document.getElementById('app'));
let sequence = 0;
window.mount = (markdown) => {
  window.handle = React.createRef();
  root.render(React.createElement(window.plugin.MarkdownRichEditor, {
    key: ++sequence, markdown, readOnly: false, handleRef: window.handle,
    report: () => {}, onChange: () => {},
  }));
};`;
  const build = await rolldown({
    input: 'virtual:entry',
    plugins: [{
      name: 'kn-robustness-test',
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
    'exports.apply = apply; exports.MarkdownRichEditor = MarkdownRichEditor;',
  );
  if (!compiled.includes('exports.MarkdownRichEditor = MarkdownRichEditor;')) throw Error('client.js 里没有 exports.apply，无法暴露 MarkdownRichEditor；先构建');

  const server = createServer((request, response) => {
    response.setHeader('content-type', request.url.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    response.end(request.url === '/app.js' ? app : request.url === '/plugin.js' ? compiled
      : `<!doctype html><meta charset="utf-8"><style>
body{margin:20px}
#app{width:900px;height:700px;overflow:auto;border:1px solid #ccc}
.kn-editor-rich{height:650px;padding:16px 18px 0;overflow:auto;position:relative}
.milkdown{width:100%;max-width:860px;min-height:300px;margin:0 auto}
.kn-editor-rich .milkdown .ProseMirror{padding:8px 6px 28px}
/* Crepe 浮动 UI 在宿主里由主题 CSS 控制显隐；测试页没有主题 CSS ⇒ 直接收起，免得挡住点击 */
.milkdown > :not(.ProseMirror){display:none!important}
</style><div id="app"></div><script src="/app.js"></script><script src="/plugin.js"></script>`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));

  const browser = await chromium.launch({executablePath: CHROME, headless: true});
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);

  async function mount(markdown) {
    await page.evaluate(value => window.mount(value), markdown);
    await page.waitForFunction(() => window.handle?.current?.isReady(), undefined, {timeout: 20000});
    await page.locator('.kn-editor-rich .ProseMirror').waitFor({state: 'visible', timeout: 20000});
    await page.waitForTimeout(300);
  }
  const flush = () => page.evaluate(() => window.handle.current.flush());
  /** 合成粘贴事件（真实 ClipboardEvent + DataTransfer ✓） */
  async function paste({plain = null, html = null}) {
    await page.evaluate(({plain, html}) => {
      const editor = document.querySelector('.kn-editor-rich .ProseMirror');
      const data = new DataTransfer();
      if (plain !== null) data.setData('text/plain', plain);
      if (html !== null) data.setData('text/html', html);
      editor.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
    }, {plain, html});
    await page.waitForTimeout(400);
  }
  /** 点段落末尾（键盘前先等 300ms，避开既有选区时序 flake ✓） */
  async function caretAtEnd(locator) {
    await locator.click();
    await page.waitForTimeout(300);
    await page.keyboard.press('End');
    await page.waitForTimeout(100);
  }
  async function caretAtStart(locator) {
    await locator.click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Home');
    await page.waitForTimeout(100);
  }
  async function close() {
    await browser.close().catch(() => {});
    await new Promise(done => server.close(done));
  }
  return {page, mount, flush, paste, caretAtEnd, caretAtStart, close, pageErrors};
}

async function diagnostics(harness, error) {
  let facts = {};
  try {
    facts = await harness.page.evaluate(() => ({
      markdown: window.handle?.current?.flush?.() ?? null,
      html: document.querySelector('.kn-editor-rich .ProseMirror')?.innerHTML.slice(0, 1500) ?? null,
      text: document.querySelector('.kn-editor-rich .ProseMirror')?.innerText ?? null,
      codeBlocks: document.querySelectorAll('.milkdown-code-block').length,
      blockquotes: document.querySelectorAll('.kn-editor-rich blockquote').length,
    }));
  } catch { /* 页面可能已经关了 ✓ */ }
  console.error('诊断：' + JSON.stringify({...facts, pageErrors: harness.pageErrors, error: String(error)}));
  throw error;
}

const CODE_FENCE = '```';
const quoteLines = markdown => markdown.split('\n').filter(line => line.trimStart().startsWith('>'));

describe('外部代码粘贴健壮性（真实 client.js）', () => {
  it('a. 纯文本 C++ ⇒ 完整代码块：原文逐字、无 HTML 节点、原段落保留', async () => {
    const harness = await startHarness();
    try {
      await harness.mount('原文段落');
      await harness.caretAtEnd(harness.page.locator('.kn-editor-rich .ProseMirror p').first());
      await harness.paste({plain: EXTERNAL_CPP});
      await harness.page.locator('.milkdown-code-block').waitFor({state: 'visible', timeout: 8000});
      const markdown = await harness.flush();
      assert.ok(markdown.includes(CODE_FENCE), `应出现代码围栏：${JSON.stringify(markdown)}`);
      assert.ok(markdown.includes('原文段落'), '原段落要保留');
      assert.ok(markdown.includes('#include<iostream>'), '尖括号内容要逐字保留');
      assert.equal(markdown.split('#include<iostream>').length - 1, 1, '#include<iostream> 只出现一次');
      assert.ok(markdown.includes('    cin >> a >> b;'), '缩进要原样保留');
      const facts = await harness.page.evaluate(() => ({
        htmlNodes: document.querySelectorAll('[data-type="html"]').length,
        codeText: document.querySelector('.milkdown-code-block')?.textContent ?? '',
      }));
      assert.equal(facts.htmlNodes, 0, '不许产生原始 HTML 节点');
      assert.ok(facts.codeText.includes('#include<iostream>'), '尖括号应作为代码文本显示（不是 HTML 元素）');
      assert.ok(!facts.codeText.includes(CODE_FENCE), '代码块内容里不该混入围栏本身');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('b. 引用块内粘贴同一段代码 ⇒ 代码块出现且引用结构不丢', async () => {
    const harness = await startHarness();
    try {
      await harness.mount('> 引用文字\n\n正文');
      await harness.caretAtEnd(harness.page.locator('.kn-editor-rich .ProseMirror blockquote p').first());
      await harness.paste({plain: EXTERNAL_CPP});
      await harness.page.locator('.milkdown-code-block').waitFor({state: 'visible', timeout: 8000});
      const markdown = await harness.flush();
      assert.ok(markdown.includes('引用文字'), '引用里的原文要保留');
      assert.ok(markdown.includes(CODE_FENCE), '代码块要出现');
      assert.ok(markdown.includes('#include<iostream>'), '代码内容要逐字保留');
      assert.ok(quoteLines(markdown).length > 0, `引用结构不能丢：${JSON.stringify(markdown)}`);
      const insideQuote = await harness.page.evaluate(() => document.querySelector('.milkdown-code-block')?.closest('blockquote') !== null);
      assert.equal(insideQuote, true, '代码块应在引用块里面');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('c. 普通多行中文 ⇒ 不误判成代码块（仍走 Markdown 粘贴）', async () => {
    const harness = await startHarness();
    try {
      await harness.mount('起始段');
      await harness.caretAtEnd(harness.page.locator('.kn-editor-rich .ProseMirror p').first());
      await harness.paste({plain: '第一段\n\n第二段'});
      assert.equal(await harness.page.locator('.milkdown-code-block').count(), 0, '普通文字不许变成代码块');
      const markdown = await harness.flush();
      assert.ok(markdown.includes('第一段') && markdown.includes('第二段'), `文字要保留：${JSON.stringify(markdown)}`);
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('d. 以 ``` 开头的围栏 Markdown ⇒ 不被启发式接管（围栏不塞进代码块）', async () => {
    const harness = await startHarness();
    try {
      await harness.mount('起始段');
      await harness.caretAtEnd(harness.page.locator('.kn-editor-rich .ProseMirror p').first());
      await harness.paste({plain: '```\nint x = 1;\n```'});
      await harness.page.waitForTimeout(300);
      const markdown = await harness.flush();
      const codeTexts = await harness.page.locator('.milkdown-code-block').allTextContents();
      for (const text of codeTexts) {
        assert.ok(!text.includes(CODE_FENCE), `围栏不许被塞进代码块内容：${JSON.stringify(text)}`);
      }
      assert.ok(!markdown.includes('````'), `不许出现四连反引号（嵌套/转义信号）：${JSON.stringify(markdown)}`);
      assert.ok(!codeTexts.some(text => text.includes('int x = 1;') && text.includes(CODE_FENCE)), '不许把整段围栏当代码原文');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('e. 空引用块边缘按 Backspace ⇒ 整块删掉、后面的正文保留', async () => {
    const harness = await startHarness();
    try {
      await harness.mount('> 引用文字\n\n正文');
      const quoteParagraph = harness.page.locator('.kn-editor-rich .ProseMirror blockquote p').first();
      await quoteParagraph.click();
      await harness.page.waitForTimeout(300);
      await harness.page.keyboard.press('Home');
      await harness.page.keyboard.press('Shift+End');
      await harness.page.keyboard.press('Backspace');
      await harness.page.waitForTimeout(200);
      /* 再在空引用里 Home + Backspace ⇒ 退出引用 */
      await harness.page.keyboard.press('Home');
      await harness.page.keyboard.press('Backspace');
      await harness.page.waitForTimeout(300);
      const markdown = await harness.flush();
      assert.equal(quoteLines(markdown).length, 0, `不许留下引用行：${JSON.stringify(markdown)}`);
      assert.ok(markdown.includes('正文'), '后面的正文要保留');
      assert.equal(await harness.page.locator('.kn-editor-rich blockquote').count(), 0, '空引用块要整块消失');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('f. 单段落引用拆壳：开头 Backspace / 末尾 Delete 都保留文字', async () => {
    const harness = await startHarness();
    try {
      await harness.mount('> 引用文字\n\n正文');
      const quoteParagraph = harness.page.locator('.kn-editor-rich .ProseMirror blockquote p').first();
      await harness.caretAtStart(quoteParagraph);
      await harness.page.keyboard.press('Backspace');
      await harness.page.waitForTimeout(300);
      let markdown = await harness.flush();
      assert.equal(quoteLines(markdown).length, 0, `Backspace 拆壳后不许有引用行：${JSON.stringify(markdown)}`);
      assert.ok(markdown.includes('引用文字'), '文字要保留');
      assert.ok(markdown.includes('正文'), '后面的正文要保留');
      assert.equal(await harness.page.locator('.kn-editor-rich blockquote').count(), 0, '引用壳要消失');

      await harness.mount('> 引用文字\n\n正文');
      await harness.caretAtEnd(harness.page.locator('.kn-editor-rich .ProseMirror blockquote p').first());
      await harness.page.keyboard.press('Delete');
      await harness.page.waitForTimeout(300);
      markdown = await harness.flush();
      assert.equal(quoteLines(markdown).length, 0, `Delete 拆壳后不许有引用行：${JSON.stringify(markdown)}`);
      assert.ok(markdown.includes('引用文字'), 'Delete 方向也要保留文字');
      assert.equal(await harness.page.locator('.kn-editor-rich blockquote').count(), 0, '引用壳要消失');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('g. 表格单元格里粘贴代码 ⇒ 插到整张表之后，表格不被拆开', async () => {
    const harness = await startHarness();
    try {
      await harness.mount('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |');
      const cell = harness.page.locator('.kn-editor-rich .ProseMirror td').first();
      await cell.waitFor({state: 'visible', timeout: 15000});
      await cell.click();
      await harness.page.waitForTimeout(300);
      await harness.paste({plain: EXTERNAL_CPP});
      await harness.page.locator('.milkdown-code-block').waitFor({state: 'visible', timeout: 8000});
      const markdown = await harness.flush();
      const tableLines = markdown.split('\n').filter(line => line.trim().startsWith('|'));
      assert.equal(tableLines.length, 3, `表格应仍是 3 行（表头/分隔/数据）：${JSON.stringify(markdown)}`);
      assert.ok(markdown.includes('| 甲 | 乙 |'), '表头不能被拆');
      assert.ok(markdown.includes('| 1 | 2 |'), '数据行不能被拆');
      for (const cellText of ['甲', '乙', '1', '2']) {
        assert.equal(markdown.split(cellText).length - 1, 1, `「${cellText}」应只出现一次（表格没被拆成两半）`);
      }
      assert.ok(markdown.indexOf(CODE_FENCE) > markdown.indexOf('| 1 | 2 |'), `代码围栏要在表格之后：${JSON.stringify(markdown)}`);
      assert.ok(markdown.indexOf('#include<iostream>') > markdown.indexOf('| 1 | 2 |'), '代码内容也要在表格之后');
      assert.equal(await harness.page.locator('.kn-editor-rich .ProseMirror .milkdown-table-block').count(), 1, 'DOM 里只应有一个表格块');
      assert.equal(await harness.page.locator('.kn-editor-rich .milkdown-table-block .milkdown-code-block').count(), 0, '代码块不能在表格里面');
      assert.equal(await harness.page.evaluate(() => document.querySelectorAll('[data-type="html"]').length), 0, '不许产生原始 HTML 节点');
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });

  it('h. 标题末尾粘贴代码 ⇒ 代码块在标题之后、标题保留', async () => {
    const harness = await startHarness();
    try {
      await harness.mount('# 标题');
      const heading = harness.page.locator('.kn-editor-rich .ProseMirror h1').first();
      await heading.waitFor({state: 'visible', timeout: 15000});
      await harness.caretAtEnd(heading);
      await harness.paste({plain: EXTERNAL_CPP});
      await harness.page.locator('.milkdown-code-block').waitFor({state: 'visible', timeout: 8000});
      const markdown = await harness.flush();
      assert.ok(markdown.includes('# 标题'), `标题要保留：${JSON.stringify(markdown)}`);
      assert.ok(markdown.includes('#include<iostream>'), '代码内容要出现');
      assert.ok(markdown.indexOf(CODE_FENCE) > markdown.indexOf('# 标题'), `代码围栏要在标题之后：${JSON.stringify(markdown)}`);
      assert.deepEqual(harness.pageErrors, []);
    } catch (error) { await diagnostics(harness, error); }
    finally { await harness.close(); }
  });
});
