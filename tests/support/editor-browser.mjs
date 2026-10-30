import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Real bundled editor, browser keyboard/clipboard and Markdown serialization. */
export async function startEditorBrowser() {
  const project = process.env.KN_PROJECT;
  if (!project) throw Error('Set KN_PROJECT to the DSH checkout.');
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const pnpm = resolve(project, 'node_modules/.pnpm');
  const entries = readdirSync(pnpm);
  const pkg = (prefix, file) => pathToFileURL(resolve(pnpm, entries.find(n => n.startsWith(prefix)), 'node_modules', file));
  const { rolldown } = await import(pkg('rolldown@', 'rolldown/dist/index.mjs'));
  const { chromium } = await import(pkg('playwright@', 'playwright/index.mjs'));
  const require = createRequire(pkg('react-dom@18.3.1', 'react-dom/package.json'));
  const entry = `import React from 'react';import * as ReactDOM from 'react-dom';import * as JSX from 'react/jsx-runtime';import {createRoot} from 'react-dom/client';
  window.__ModuleLoader__={load:({factory})=>window.plugin=factory(name=>({'react':React,'react-dom':ReactDOM,'react/jsx-runtime':JSX,'@deepseek-ai/dsh-client-ui-primitives':{Menu:()=>null,ImageLightbox:()=>null}}[name]))};
  const root=createRoot(document.getElementById('app'));let sequence=0;window.mount=(markdown,readOnly=false)=>{window.handle=React.createRef();root.render(React.createElement(window.plugin.MarkdownRichEditor,{key:++sequence,markdown,readOnly,handleRef:window.handle,onChange:()=>{}}));};
  window.mountDocument=()=>{window.saveRequests=[];let doc={nodeId:'shortcut-note',title:'快捷键测试',text:'original',path:'Nodes/test.md',hash:'test-hash',revision:1};root.render(React.createElement(window.plugin.NodeDocumentEditor,{key:++sequence,nodeId:doc.nodeId,libraryKey:'keyboard-tests',onClose:()=>{},fetcher:async(url,init)=>{const body=JSON.parse(init.body);if(body.kind==='save-node-document'){window.saveRequests.push(body);doc={...doc,text:body.text,hash:'saved-hash',revision:2};}return{json:async()=>({ok:true,document:doc})};}}));};
  window.mountDialog=()=>{window.dialogActions=[];root.render(React.createElement(window.plugin.ConfirmDialog,{key:++sequence,title:'未保存的笔记',message:'保存后关闭？',confirmLabel:'保存并关闭',cancelLabel:'继续编辑',extraLabel:'放弃修改',onCancel:()=>window.dialogActions.push('cancel'),onExtra:()=>window.dialogActions.push('discard'),onConfirm:()=>window.dialogActions.push('confirm')}));};`;
  const build = await rolldown({ input: 'virtual:entry', plugins: [{ name: 'editor-browser',
    resolveId(id) { if (id === 'virtual:entry') return id; if (['react','react-dom','react-dom/client','react/jsx-runtime'].includes(id)) return require.resolve(id); },
    load(id) { if (id === 'virtual:entry') return entry; },
  }] });
  let app;
  try { app = (await build.generate({ format: 'iife' })).output.find(i => i.type === 'chunk').code; }
  finally { await build.close(); }
  const compiled = readFileSync(resolve(repo, 'client.js'), 'utf8').replace('exports.apply = apply;', 'exports.apply = apply; exports.MarkdownRichEditor = MarkdownRichEditor; exports.NodeDocumentEditor = NodeDocumentEditor; exports.ConfirmDialog = ConfirmDialog;');
  const server = createServer((req, res) => {
    res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(req.url === '/app.js' ? app : req.url === '/plugin.js' ? compiled : `<!doctype html><meta charset="utf-8"><style>
      body{font-family:system-ui;margin:20px}#app{height:700px;width:800px;overflow:auto}.kn-editor-rich{padding:16px;position:relative}
      .milkdown .ProseMirror{padding:8px;min-height:400px;white-space:pre-wrap}.milkdown > :not(.ProseMirror){display:none!important}
      </style><div id="app"></div><script src="/app.js"></script><script src="/plugin.js"></script>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.KN_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    return { page, errors,
      async mount(markdown, readOnly = false) {
        await page.evaluate(([text, locked]) => window.mount(text, locked), [markdown, readOnly]);
        await page.waitForFunction(() => window.handle?.current?.isReady());
        await page.locator('.ProseMirror').waitFor({ state: 'visible' });
      },
      flush: () => page.evaluate(() => window.handle.current.flush()),
      async paste(plain, { html = '', target = '.ProseMirror', plainShortcut = false } = {}) {
        return page.locator(target).evaluate((el, { plain, html, plainShortcut }) => {
          if (plainShortcut) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', ctrlKey: true, shiftKey: true, bubbles: true }));
          const data = new DataTransfer(); data.setData('text/plain', plain); if (html) data.setData('text/html', html);
          const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
          el.dispatchEvent(event); return event.defaultPrevented;
        }, { plain, html, plainShortcut });
      },
      async close() { await browser.close(); await new Promise(r => server.close(r)); },
    };
  } catch (error) { await browser?.close(); await new Promise(r => server.close(r)); throw error; }
}
