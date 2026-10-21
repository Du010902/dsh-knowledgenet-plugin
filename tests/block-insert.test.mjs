import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {Schema} from '@milkdown/kit/prose/model';
import {EditorState,TextSelection} from '@milkdown/kit/prose/state';
import {prepareBlockInsertion,prepareContextInsertion,prepareAfterBlockInsertion,readBlockMenuGroups,blockMenuTextKey,blockMenuGroupTextKey,themeBlockMenuIcon,BLOCK_MENU_LITERAL} from '../src/client/block-insert.ts';
import {patchCrepeBlockMenu} from '../scripts/slash-menu-patch.mjs';
const schema=new Schema({nodes:{doc:{content:'block+'},paragraph:{group:'block',content:'text*'},heading:{group:'block',content:'text*',attrs:{level:{default:1}}},blockquote:{group:'block',content:'block+'},bullet_list:{group:'block',content:'list_item+'},list_item:{content:'paragraph block*'},code_block:{group:'block',content:'text*'},table:{group:'block',content:'table_row+'},table_row:{content:'(table_cell|table_header)+'},table_cell:{content:'paragraph+'},table_header:{content:'paragraph+'},text:{}},marks:{code:{},link:{attrs:{href:{default:''}}}}});
const p=text=>schema.node('paragraph',null,text?schema.text(text):null);
const list=text=>schema.node('bullet_list',null,schema.node('list_item',null,p(text)));
const table=text=>schema.node('table',null,schema.node('table_row',null,schema.node('table_cell',null,p(text))));
function state(node,offset=0){const doc=schema.node('doc',null,node);let pos;doc.descendants((n,at)=>{if(pos===undefined&&n.isTextblock)pos=at+1;});return EditorState.create({doc,selection:TextSelection.create(doc,pos+offset)});}
const viewOf=state=>({state,dispatch(tr){this.state=this.state.apply(tr);}});
function posIn(doc,type,text,offset=0){let hit;doc.descendants((n,at)=>{if(hit===undefined&&n.type.name===type&&(text===undefined||n.textContent===text))hit=at+1+offset;});if(hit===undefined)throw Error('找不到 '+type+'：'+text);return hit;}
const topBlocks=doc=>Array.from({length:doc.childCount},(_,i)=>[doc.child(i).type.name,doc.child(i).textContent]);
test('prepareBlockInsertion：空段落/标题/引用/列表都空出插入位置且保留原文与结构',()=>{
  const heading=schema.node('heading',null,schema.text('标题'));
  for(const [node,name] of [[p(''),'空段落'],[heading,'标题'],[schema.node('blockquote',null,p('引用')),'引用'],[list('列表'),'列表']]){
    const view=viewOf(state(node));
    assert.equal(prepareBlockInsertion(view,view.state.selection.from),true,name+'应能准备插入位置');
    assert.equal(view.state.selection.$from.parent.content.size,0,name+'光标要落在空段落');
    assert.equal(view.state.doc.textContent,node.textContent,name+'原有文字不能丢');
  }
  const headingView=viewOf(state(heading));prepareBlockInsertion(headingView,headingView.state.selection.from);
  assert.equal(headingView.state.doc.lastChild.type.name,'heading','标题块保留在空段落之后');
  const quoteView=viewOf(state(schema.node('blockquote',null,p('引用'))));prepareBlockInsertion(quoteView,quoteView.state.selection.from);
  assert.equal(quoteView.state.doc.firstChild.type.name,'blockquote','引用结构保留');
  const listView=viewOf(state(list('列表')));prepareBlockInsertion(listView,listView.state.selection.from);
  assert.equal(listView.state.doc.firstChild.type.name,'bullet_list','列表结构保留');
});
test('prepareBlockInsertion：只清理触发处的搜索词，前后文字与列表结构保留',()=>{
  for(const wrap of [false,true]){
    const view=viewOf(state(wrap?list('前文 query后文'):p('前文 query后文'),8));
    assert.equal(prepareBlockInsertion(view,view.state.selection.from-5),true,(wrap?'列表内':'段落内')+'应能准备插入位置');
    assert.equal(view.state.doc.textContent,'前文 后文');
    assert.equal(view.state.selection.$from.parent.content.size,0);
    if(wrap)assert.equal(view.state.doc.firstChild.type.name,'bullet_list');
  }
});
test('prepareContextInsertion：段落中间拆成前文/空段落/后文，光标在空段落',()=>{
  const view=viewOf(state(p('前文后文')));
  assert.equal(prepareContextInsertion(view,posIn(view.state.doc,'paragraph','前文后文',2)),true);
  const {doc,selection}=view.state;
  assert.equal(doc.childCount,3,'应拆成三段');
  assert.deepEqual([doc.child(0).textContent,doc.child(1).textContent,doc.child(2).textContent],['前文','','后文']);
  assert.equal(selection.$from.parent.content.size,0,'光标要在空段落');
});
test('prepareContextInsertion：列表项内拆分但列表结构保留',()=>{
  const view=viewOf(state(list('前文后文')));
  assert.equal(prepareContextInsertion(view,posIn(view.state.doc,'paragraph','前文后文',2)),true);
  assert.equal(view.state.doc.firstChild.type.name,'bullet_list','列表结构保留');
  assert.equal(view.state.doc.firstChild.firstChild.childCount,3,'列表项里应有前文/空/后文三段');
  assert.equal(view.state.selection.$from.parent.content.size,0);
});
test('prepareContextInsertion：代码块内 ⇒ 在该顶层块之后插空段落',()=>{
  const view=viewOf(state(schema.node('code_block',null,schema.text('let a = 1;'))));
  assert.equal(prepareContextInsertion(view,posIn(view.state.doc,'code_block','let a = 1;',3)),true);
  const {doc,selection}=view.state;
  assert.deepEqual(topBlocks(doc),[['code_block','let a = 1;'],['paragraph','']]);
  assert.equal(selection.$from.parent.content.size,0);
});
test('prepareContextInsertion：表格单元格内 ⇒ 在整张表格之后插空段落',()=>{
  const view=viewOf(state(table('单元格')));
  assert.equal(prepareContextInsertion(view,posIn(view.state.doc,'paragraph','单元格',1)),true);
  const {doc,selection}=view.state;
  assert.deepEqual(topBlocks(doc),[['table','单元格'],['paragraph','']]);
  assert.equal(doc.child(0).childCount,1,'表格结构不能被拆');
  assert.equal(selection.$from.parent.content.size,0);
});
test('prepareContextInsertion：文档末尾追加、文档开头插入空段落',()=>{
  const end=viewOf(state(p('正文')));
  assert.equal(prepareContextInsertion(end,end.state.doc.content.size),true);
  assert.deepEqual(topBlocks(end.state.doc),[['paragraph','正文'],['paragraph','']]);
  assert.equal(end.state.selection.$from.parent.content.size,0);
  const start=viewOf(state(p('正文')));
  assert.equal(prepareContextInsertion(start,0),true);
  assert.deepEqual(topBlocks(start.state.doc),[['paragraph',''],['paragraph','正文']]);
});
test('prepareAfterBlockInsertion：总在 pos 所属顶层块之后插空段落（含列表整体之后）',()=>{
  const doc=schema.node('doc',null,[p('第一段'),p('第二段')]);
  const view=viewOf(EditorState.create({doc,selection:TextSelection.create(doc,2)}));
  assert.equal(prepareAfterBlockInsertion(view,posIn(doc,'paragraph','第一段',1)),true);
  assert.deepEqual(topBlocks(view.state.doc),[['paragraph','第一段'],['paragraph',''],['paragraph','第二段']]);
  assert.equal(view.state.selection.$from.parent.content.size,0);
  const listView=viewOf(state(list('列表')));
  assert.equal(prepareAfterBlockInsertion(listView,posIn(listView.state.doc,'paragraph','列表',1)),true);
  assert.deepEqual(topBlocks(listView.state.doc),[['bullet_list','列表'],['paragraph','']]);
});
test('readBlockMenuGroups：合法快照保留分组/键/标签/图标/onRun，非法输入为空',()=>{
  const onRun=()=>{};
  assert.deepEqual(readBlockMenuGroups({build:()=>[{key:'advanced',label:'Advanced',items:[{key:'code',label:'Code',icon:'<svg/>',onRun},{label:'缺 key 的项'}]},{key:'empty',label:'Empty',items:[]}]}),[{key:'advanced',label:'Advanced',items:[{key:'code',label:'Code',icon:'<svg/>',onRun}]}]);
  assert.deepEqual(readBlockMenuGroups({build:()=>[{key:'text',items:[{key:'h1'}]}]}),[{key:'text',label:'text',items:[{key:'h1',label:'h1',icon:'',onRun:undefined}]}],'缺字段要用 key / 空串兜底');
  for(const bad of [null,undefined,42,'builder',{},{build:()=>'no'},{build(){throw Error('changed')}}])assert.deepEqual(readBlockMenuGroups(bad),[],String(bad)+' 应返回空数组');
});
test('文案 key：16 个条目 + 3 个分组全覆盖，未知 key 为 null',()=>{
  const texts={text:'blockMenuText',h1:'blockMenuH1',h2:'blockMenuH2',h3:'blockMenuH3',h4:'blockMenuH4',h5:'blockMenuH5',h6:'blockMenuH6',quote:'blockMenuQuote',divider:'blockMenuDivider','bullet-list':'blockMenuBulletList','ordered-list':'blockMenuOrderedList','task-list':'blockMenuTaskList',image:'blockMenuImage',code:'blockMenuCode',table:'blockMenuTable',math:'blockMenuMath'};
  assert.equal(Object.keys(texts).length,16);
  for(const [key,expected] of Object.entries(texts)){assert.equal(blockMenuTextKey(key),expected,'条目 '+key);assert.ok(BLOCK_MENU_LITERAL[expected],'字面兜底缺少 '+expected);}
  for(const [key,expected] of Object.entries({advanced:'blockMenuGroupInsert',text:'blockMenuGroupText',list:'blockMenuGroupList'}))assert.equal(blockMenuGroupTextKey(key),expected,'分组 '+key);
  for(const key of ['unknown','','h7','heading']){assert.equal(blockMenuTextKey(key),null);assert.equal(blockMenuGroupTextKey(key),null);}
});
test('themeBlockMenuIcon：给 <svg 补 fill="currentColor"，已有 fill 不重复加',()=>{
  assert.equal(themeBlockMenuIcon(''),'');
  assert.equal(themeBlockMenuIcon('<svg viewBox="0 0 14 14"><path d="M0 0"/></svg>'),'<svg fill="currentColor" viewBox="0 0 14 14"><path d="M0 0"/></svg>');
  const filled='<svg fill="none" viewBox="0 0 14 14"></svg>';
  assert.equal(themeBlockMenuIcon(filled),filled,'已有 fill 的图标原样返回');
});
test('构建补丁：Crepe 自带斜杠菜单的 shouldShow 改成恒 false，无关源码明确抛错',async()=>{
  const source=await readFile(new URL('../node_modules/@milkdown/crepe/lib/esm/index.js',import.meta.url),'utf8');
  const patched=patchCrepeBlockMenu(source);
  assert.match(patched,/shouldShow\(\)\s*\{\s*return false;?\s*\}/,'shouldShow 应恒 false');
  assert.ok(!patched.includes("currentText.startsWith('/')"),'旧触发条件应被移除');
  assert.throws(()=>patchCrepeBlockMenu('changed'),/Crepe slash menu changed/,'无关源码要明确报错');
});
