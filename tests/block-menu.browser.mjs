import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
/**
 * **右键块插入菜单的浏览器端到端测试**（`design/editor-block-menu-redesign.md`）。
 *
 * 用**真实构建产物** `client.js` + headless Chrome 钉住右键菜单的接线：
 * a. 段落右键弹菜单（中文条目、弹在右键坐标附近）；b. 选「代码块」真的插入且 Markdown 含 ```；
 * c. Esc 关菜单且正文不变；d. 输入 "/" 不再弹任何菜单、"/" 只是普通字符；
 * e. 正文下方空白右键 ⇒ 菜单出现且插到文档末尾；f. 表格单元格右键 ⇒ 表格菜单而非块菜单；
 * g. 代码块内右键 ⇒ 不弹块菜单；h. ＋ 块手柄 ⇒ 同一菜单且插在悬停段之后；
 * i. 已有文字选区右键 ⇒ 不弹块菜单（保留原生菜单）；j. 全程无 pageerror。
 *
 * ⚠️ 宿主 `Menu`（`@deepseek-ai/dsh-client-ui-primitives`）没有 DSH 样式表可加载，
 * 这里按宿主契约注入**替身**（portal 到 body、role=menu + role=menuitem、Esc / 点外面 onClose、
 * getAnchorRect 定位）—— 验证的是**插件的接线**；宿主组件自身行为由宿主仓库测试覆盖。
 * 替身 + React 都直接写进 entry 字符串（与 `tests/note-images.browser.mjs` 同一手法）。
 * 替身的定位按宿主行为**夹进视口**（`left/top` 不越界），否则 `＋` 手柄贴着边缘时菜单会点到视口外。
 *
 * ⚠️ 页面样式按生产补：Crepe 主题 CSS 生产里由 `build.mjs` 拼进面板样式（KN_PANEL_CSS），
 * harness 没有 ⇒ 直接读同一份 `theme/common/block-edit.css`（块手柄 / 斜杠菜单的定位与 data-show 显隐），
 * 再给 `.milkdown` 居中阅读栏 + 面板内边距 —— 否则块手柄没有左侧空间、浮动 UI 会排在文档流里吃掉右键。
 *
 * 运行：
 *   $env:KN_PROJECT='D:/AppInstallation/DSH/deepseek-harness'
 *   node --test tests/block-menu.browser.mjs
 */
const project=process.env.KN_PROJECT;if(!project)throw Error('Set KN_PROJECT.');
const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'..').replace(/\\/g,'/');
const deps=REPO+'/.tmp-build-deps';
function pnpmEntries(base){try{return readdirSync(base).filter(name=>!name.startsWith('@'));}catch{return[];}}
function firstExisting(candidates,label){for(const candidate of candidates)if(candidate&&existsSync(candidate))return candidate;throw Error(`找不到${label}；尝试过：\n${candidates.filter(Boolean).join('\n')}`);}
const rolldownPath=firstExisting([process.env.KN_ROLLDOWN,...[deps,project].flatMap(base=>pnpmEntries(base+'/node_modules/.pnpm').filter(name=>name.startsWith('rolldown@')).map(name=>`${base}/node_modules/.pnpm/${name}/node_modules/rolldown/dist/index.mjs`))],'rolldown');
const playwrightPath=firstExisting([process.env.KN_PLAYWRIGHT,...pnpmEntries(project+'/node_modules/.pnpm').filter(name=>name.startsWith('playwright@')).map(name=>`${project}/node_modules/.pnpm/${name}/node_modules/playwright/index.mjs`)],'playwright');
const reactDomDir=pnpmEntries(project+'/node_modules/.pnpm').find(name=>name.startsWith('react-dom@18.3.1'));
const req=createRequire(firstExisting([process.env.KN_REACTDOM,reactDomDir?`${project}/node_modules/.pnpm/${reactDomDir}/node_modules/react-dom/package.json`:undefined],'react-dom'));
const {rolldown}=await import(pathToFileURL(rolldownPath).href);
const {chromium}=await import(pathToFileURL(playwrightPath).href);
/** 宿主 Menu 的替身：portal 到 body；定位按宿主行为**夹进视口**；Esc / 点菜单外 ⇒ onClose；条目 id 即 Crepe key */
const entry=`import React from 'react';import * as ReactDOM from 'react-dom';import * as JSX from 'react/jsx-runtime';import {createRoot} from 'react-dom/client';
function HostMenu(props){
  const anchor=(props.getAnchorRect?.()??{left:0,top:0});
  const boxRef=React.useRef(null);
  const [pos,setPos]=React.useState({left:anchor.left??0,top:anchor.top??0});
  React.useLayoutEffect(()=>{
    if(!props.open||boxRef.current===null){setPos({left:anchor.left??0,top:anchor.top??0});return;}
    const width=boxRef.current.offsetWidth||240,height=boxRef.current.offsetHeight||320;
    setPos({left:Math.max(12,Math.min(anchor.left??0,window.innerWidth-width-12)),top:Math.max(12,Math.min(anchor.top??0,window.innerHeight-height-12))});
  },[props.open,anchor.left,anchor.top]);
  React.useEffect(()=>{
    if(!props.open)return undefined;
    const onKey=e=>{if(e.key==='Escape')props.onClose?.();};
    const onPointer=e=>{const menu=document.querySelector('[data-kn-block-menu]');if(menu!==null&&!menu.contains(e.target))props.onClose?.();};
    document.addEventListener('keydown',onKey,true);
    document.addEventListener('pointerdown',onPointer,true);
    return ()=>{document.removeEventListener('keydown',onKey,true);document.removeEventListener('pointerdown',onPointer,true);};
  },[props.open,props.onClose]);
  if(!props.open)return null;
  const items=props.items??[];
  return ReactDOM.createPortal(React.createElement('div',{'data-kn-block-menu':'',role:'menu',ref:boxRef,style:{position:'fixed',left:pos.left+'px',top:pos.top+'px',zIndex:9999,background:'#fff',border:'1px solid #888',padding:'4px'}},
    items.map((item,index)=>item.type==='separator'
      ?React.createElement('hr',{key:item.id??index,'data-menu-separator':''})
      :item.type==='label'
        ?React.createElement('div',{key:item.id??index,'data-menu-label':item.text??''},item.text??'')
        :React.createElement('button',{key:item.id??index,type:'button',role:'menuitem','data-menu-id':item.id,onClick:()=>props.onSelect?.(item.id)},item.label??item.id))),
    document.body);
}
const hostPrimitives={Menu:HostMenu};
window.__ModuleLoader__={load:({factory})=>{window.plugin=factory(name=>({'react':React,'react-dom':ReactDOM,'react/jsx-runtime':JSX,'@deepseek-ai/dsh-client-ui-primitives':hostPrimitives}[name]));}};
const root=createRoot(document.getElementById('app'));let sequence=0;window.mount=(markdown)=>{window.handle=React.createRef();root.render(React.createElement(window.plugin.MarkdownRichEditor,{key:++sequence,markdown,readOnly:false,handleRef:window.handle,report:(step,detail)=>{(window.reports??=[]).push({step,detail});},onChange:value=>window.markdown=value}));};`;
const build=await rolldown({input:'entry',plugins:[{name:'test',resolveId(id){if(id==='entry')return id;try{return req.resolve(id);}catch{}},load(id){if(id==='entry')return entry;}}]});const {output}=await build.generate({format:'iife'});await build.close();
const code=output.find(item=>item.type==='chunk').code;
const compiled=readFileSync(new URL('../client.js',import.meta.url),'utf8').replace('exports.apply = apply;','exports.apply = apply; exports.MarkdownRichEditor = MarkdownRichEditor;');
if(!compiled.includes('exports.MarkdownRichEditor = MarkdownRichEditor;'))throw Error('client.js 里没有 exports.apply，无法暴露 MarkdownRichEditor；先构建');
/*
 * 生产里 Crepe 主题 CSS 由面板样式一起注入（`build.mjs` 把 crepe common + theme 拼进 KN_PANEL_CSS）；
 * harness 直接挂 MarkdownRichEditor、没有面板样式 ⇒ 读同一份 Crepe `block-edit.css`（块手柄 / 斜杠菜单的
 * 定位与 data-show 显隐），再按生产布局补：居中阅读栏（≤860px）+ 面板内边距，手柄才有左侧空间。
 */
const blockEditCss=readFileSync(new URL('../node_modules/@milkdown/crepe/lib/theme/common/block-edit.css',import.meta.url),'utf8');
const pageHtml=`<!doctype html><meta charset="utf-8"><style>${blockEditCss}
body{margin:20px}
#app{position:relative;width:1200px;height:700px;overflow:auto;border:1px solid #ccc}
.kn-editor-rich{height:650px;padding:16px 18px 0;overflow:auto;position:relative}
.milkdown{width:100%;max-width:860px;min-height:300px;margin:0 auto}
.kn-editor-rich .milkdown .ProseMirror{padding:8px 6px 28px}
/* 其余浮动 UI 在测试里不需要（生产由各自主题 CSS 控制显隐） */
.milkdown-toolbar,.milkdown-tooltip,.milkdown-link-preview,.milkdown-link-edit,.language-picker,.search-box,.language-list{display:none!important}
</style><div id="app" class="kn-editor-body"></div><script src="/app.js"></script><script src="/plugin.js"></script>`;
const server=createServer((request,response)=>{response.setHeader('Content-Type',request.url.endsWith('.js')?'text/javascript':'text/html');response.end(request.url==='/app.js'?code:request.url==='/plugin.js'?compiled:pageHtml);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.KN_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
let page;const errors=[];let step='init';
try{
  page=await browser.newPage();page.on('pageerror',e=>errors.push('['+step+'] '+e.message));await page.goto('http://127.0.0.1:'+server.address().port);
  const menu=page.locator('[data-kn-block-menu]');
  const menuItems=()=>menu.locator('[role="menuitem"]');
  const mount=async markdown=>{await page.evaluate(value=>window.mount(value),markdown);await page.waitForFunction(()=>window.handle?.current?.isReady());};
  const flush=()=>page.evaluate(()=>window.handle.current.flush());
  const options=async()=>{const labels=await menuItems().allTextContents();return labels;};
  const requireOptions=async wanted=>{const labels=await options();for(const label of wanted)if(!labels.includes(label))throw Error('菜单缺少「'+label+'」：'+JSON.stringify(labels));};
  const rightClick=async(locator,offsetY=0)=>{const box=await locator.boundingBox();if(box===null)throw Error('拿不到右键目标坐标');const x=box.x+Math.min(box.width/2,160),y=box.y+(offsetY||box.height/2);await page.mouse.click(x,y,{button:'right'});return{x,y};};
  step='a';/* a. 段落右键 ⇒ [role=menu] 出现，中文条目齐全，且弹在右键坐标附近 */
  await mount('普通正文');
  const point=await rightClick(page.locator('.ProseMirror p').first());
  await page.locator('[role="menu"]').first().waitFor({state:'visible',timeout:5000});
  if(await menu.count()!==1)throw Error('段落右键没有弹出块菜单');
  await requireOptions(['代码块','公式块','表格','图片','标题 1','无序列表']);
  /* 第四轮：行内格式组已从右键菜单删掉（改走划词后的浮动工具栏）⇒ 右键只剩 Crepe 的块条目 ✓ */
  const expectedOrder=['图片','代码块','表格','公式块','正文','标题 1','标题 2','标题 3','标题 4','标题 5','标题 6','引用','分隔线','无序列表','有序列表','任务列表'];
  const labels=await options();
  if(JSON.stringify(labels)!==JSON.stringify(expectedOrder))throw Error('菜单条目/顺序不符合预期（块条目 + Crepe 源顺序）：'+JSON.stringify(labels));
  const groupText=await menu.innerText();
  for(const group of ['插入','文本','列表'])if(!groupText.includes(group))throw Error('菜单缺少分组「'+group+'」：'+JSON.stringify(groupText));
  for(const gone of ['行内格式','加粗','斜体','删除线','行内代码','行内公式'])if(groupText.includes(gone))throw Error('右键菜单不该再有行内格式条目「'+gone+'」：'+JSON.stringify(groupText));
  const popup=await menu.evaluate(element=>{const rect=element.getBoundingClientRect();return{left:rect.left,top:rect.top};});
  if(Math.abs(popup.left-point.x)>8||Math.abs(popup.top-point.y)>8)throw Error('菜单没弹在右键坐标附近：'+JSON.stringify({point,popup}));
  await page.keyboard.press('Escape');
  step='b';/* b. 点「代码块」⇒ 出现 .milkdown-code-block，flush 的 Markdown 含 ``` 且原文保留 */
  await mount('普通正文');
  await rightClick(page.locator('.ProseMirror p').first());
  await menu.getByRole('menuitem',{name:'代码块',exact:true}).click();
  await page.locator('.milkdown-code-block').waitFor({state:'visible',timeout:5000});
  const inserted=await flush();
  if(!inserted.includes('```'))throw Error('插入代码块后 Markdown 缺 ```：'+JSON.stringify(inserted));
  if(!inserted.includes('普通')||!inserted.includes('正文'))throw Error('插入代码块损坏原文：'+JSON.stringify(inserted));
  step='b2';/* b2. 右键插「公式块」⇒ 首次输入源码时编辑区不能自动收起来（用户实测 bug 回归） */
  await mount('普通正文');
  await rightClick(page.locator('.ProseMirror p').first());
  await menu.getByRole('menuitem',{name:'公式块',exact:true}).click();
  await page.waitForTimeout(700);
  if(await page.locator('.milkdown-code-block').count()===0)throw Error('右键插入公式块失败');
  const formulaEditor=page.locator('.milkdown-code-block .codemirror-host .cm-content').first();
  await formulaEditor.click();
  await page.waitForTimeout(250);
  await page.keyboard.type('e');
  await page.waitForTimeout(500);
  const editing=await page.evaluate(()=>{
    const host=document.querySelector('.milkdown-code-block .codemirror-host');
    if(host===null)return null;
    return {hidden:host.classList.contains('hidden')||getComputedStyle(host).display==='none'};
  });
  if(editing===null)throw Error('公式块的源码编辑区不存在');
  if(editing.hidden)throw Error('公式块第一次输入后「编辑源码」界面被关掉了（用户实测 bug）：'+JSON.stringify(editing));
  const firstFormula=await flush();
  if(!firstFormula.includes('$$\ne\n$$'))throw Error('公式块 Markdown 不符合预期：'+JSON.stringify(firstFormula));
  await page.keyboard.type('=mc^2');
  await page.waitForTimeout(300);
  const moreFormula=await flush();
  if(!moreFormula.includes('e=mc^2'))throw Error('公式块后续输入丢失：'+JSON.stringify(moreFormula));
  step='c';/* c. Esc 关闭菜单且文档不变 */
  await mount('正文');
  await rightClick(page.locator('.ProseMirror p').first());
  await menu.waitFor({state:'visible',timeout:5000});
  await page.keyboard.press('Escape');
  await menu.waitFor({state:'hidden',timeout:5000});
  const escaped=await flush();
  if(escaped.trim()!=='正文')throw Error('Esc 关闭菜单后正文被改：'+JSON.stringify(escaped));
  step='d';/* d. 输入 "/" ⇒ 不弹任何菜单，正文字面留下 "/" */
  await mount('正文');
  await page.locator('.ProseMirror p').click();
  await page.keyboard.press('End');
  await page.keyboard.type('/');
  await page.waitForTimeout(300);
  if(await menu.count())throw Error('输入 / 弹出了块菜单');
  if(await page.locator('.milkdown-slash-menu[data-show="true"]').count())throw Error('输入 / 仍弹出 Crepe 斜杠菜单');
  const domText=await page.evaluate(()=>document.querySelector('.ProseMirror')?.innerText);
  if(!domText?.includes('/'))throw Error('"/" 没有作为普通字符留在正文：'+JSON.stringify(domText));
  if(!(await flush()).includes('/'))throw Error('"/" 没有进入 Markdown：'+JSON.stringify(await flush()));
  step='e';/* e. 正文下方空白处右键 ⇒ 菜单出现，选「代码块」插到文档末尾 */
  await mount('正文');
  const lastBlock=await page.locator('.ProseMirror p').last().boundingBox();
  const milkdownBox=await page.locator('.milkdown').first().boundingBox();
  if(lastBlock===null||milkdownBox===null)throw Error('拿不到正文/编辑器坐标');
  const blankPoint={x:milkdownBox.x+milkdownBox.width-40,y:milkdownBox.y+250};
  if(blankPoint.y<=lastBlock.y+lastBlock.height)throw Error('空白落点没有在最后一个块下方：'+JSON.stringify({blankPoint,lastBlock}));
  await page.mouse.click(blankPoint.x,blankPoint.y,{button:'right'});
  await menu.waitFor({state:'visible',timeout:5000});
  await menu.getByRole('menuitem',{name:'代码块',exact:true}).click();
  await page.locator('.milkdown-code-block').waitFor({state:'visible',timeout:5000});
  const appended=await flush();
  if(!/正文[\s\S]*```/.test(appended))throw Error('空白处右键插入没有落到文档末尾：'+JSON.stringify(appended));
  step='f';/* f. 表格单元格右键 ⇒ 弹 .kn-table-menu（表格菜单），不弹块菜单 */
  await mount('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |');
  const cell=page.locator('.milkdown-table-block td').first();
  await cell.waitFor({state:'visible',timeout:15000});
  /* 先把光标放进这个单元格再右键：Crepe 的 TableNodeView.handleClick 在"点到别的单元格"时
     会用 requestAnimationFrame 派发它捕获的旧事务（与本插件无关的既有行为），
     先落光标可让 E2E 只盯"表格右键走表格菜单"这条接线 */
  await cell.click();
  await page.waitForTimeout(150);
  const cellBox=await cell.boundingBox();
  await page.mouse.click(cellBox.x+cellBox.width/2,cellBox.y+cellBox.height/2,{button:'right'});
  await page.locator('.kn-table-menu').waitFor({state:'visible',timeout:5000});
  await page.waitForTimeout(200);
  if(await menu.count())throw Error('表格单元格右键弹了块菜单');
  step='g';/* g. 代码块内右键 ⇒ 不弹块菜单 */
  await mount('```js\nlet a = 1;\n```');
  const codeBlock=page.locator('.milkdown-code-block').first();
  await codeBlock.waitFor({state:'visible',timeout:15000});
  const codeBox=await codeBlock.boundingBox();
  await page.mouse.click(codeBox.x+codeBox.width/2,codeBox.y+24,{button:'right'});
  await page.waitForTimeout(300);
  if(await menu.count())throw Error('代码块内右键弹了块菜单');
  step='h';/* h. ＋ 块手柄 ⇒ 同一块菜单，且插在悬停段之后 */
  await mount('第一段\n\n第二段');
  const hoveredParagraph=page.locator('.ProseMirror p').first();
  await hoveredParagraph.hover();
  const handle=page.locator('.milkdown-block-handle[data-show="true"]').first();
  await handle.waitFor({state:'visible',timeout:5000});
  await handle.locator('.operation-item').first().click();
  await menu.waitFor({state:'visible',timeout:5000});
  await menu.getByRole('menuitem',{name:'代码块',exact:true}).click();
  await page.locator('.milkdown-code-block').waitFor({state:'visible',timeout:5000});
  const afterHandle=await flush();
  const paragraphAt=afterHandle.indexOf('第一段'),fenceAt=afterHandle.indexOf('```'),secondAt=afterHandle.indexOf('第二段');
  if(!(paragraphAt>=0&&fenceAt>paragraphAt&&secondAt>fenceAt))throw Error('＋手柄插入位置不对（应在悬停段之后、第二段之前）：'+JSON.stringify(afterHandle));
  step='i';/* i. 已有文字选区右键 ⇒ 不弹块菜单（保留原生菜单），正文不变 */
  await mount('选中这段文字');
  const selectedParagraph=page.locator('.ProseMirror p').first();
  await selectedParagraph.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  const selectedBox=await selectedParagraph.boundingBox();
  await page.mouse.click(selectedBox.x+selectedBox.width/2,selectedBox.y+selectedBox.height/2,{button:'right'});
  await page.waitForTimeout(300);
  if(await menu.count())throw Error('已有文字选区时右键仍弹出块菜单');
  const selectionText=(await flush()).trim();
  if(selectionText!=='选中这段文字')throw Error('已有文字选区时右键改动了正文：'+JSON.stringify(selectionText));
  step='j';/* j. 无 pageerror */
  if(errors.length)throw Error(errors.join('\n'));
  console.log('浏览器通过：段落右键弹中文块菜单并插入代码块；公式块首次输入不收编辑区；Esc 不改正文；输入 / 不再弹菜单；空白处右键插到末尾；表格/代码块右键不弹块菜单；＋手柄插在悬停段之后；有选区右键不弹块菜单；无运行时异常。');
}catch(error){
  if(page)await page.evaluate(()=>({markdown:window.handle?.current?.flush?.(),reports:window.reports?.slice(-12),menus:[...document.querySelectorAll('[data-kn-block-menu],[role="menu"]')].map(e=>({cls:e.className,text:e.innerText.slice(0,200)})),body:document.body.innerHTML.slice(0,300)})).then(diagnostics=>console.error('诊断：'+JSON.stringify({...diagnostics,pageErrors:errors}))).catch(()=>{});
  throw error;
}finally{await browser.close();await new Promise(r=>server.close(r));}
