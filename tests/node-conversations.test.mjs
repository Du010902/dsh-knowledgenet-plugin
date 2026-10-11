import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeV3Fixture, cleanupFixtures } from './support/v3-fixture.mjs';
import { listNodeConversations, recordNodeConversation } from '../src/host/node-conversations.ts';
import { readLibrary, writeNote } from '../src/host/v3/store.ts';
import { handleApiRequest } from '../src/host/api.ts';
import { makeConversationActions, pickWorkspaceId } from '../src/client/node-conversations.ts';
after(cleanupFixtures);

test('节点保存多条对话，重读、去重和并发不会改写笔记或另一节点',async()=>{
 const f=await makeV3Fixture({nodes:['A','B']});const file=join(f.root,f.nodes.A.relativePath);const before=await readFile(file,'utf8');
 assert.deepEqual(await listNodeConversations(f.root,f.nodes.A.id),[]);
 await Promise.all([recordNodeConversation(f.root,f.nodes.A.id,'chat-1'),recordNodeConversation(f.root,f.nodes.A.id,'chat-2'),recordNodeConversation(f.root,f.nodes.B.id,'chat-3')]);
 await recordNodeConversation(f.root,f.nodes.A.id,'chat-1');
 assert.deepEqual(new Set((await listNodeConversations(f.root,f.nodes.A.id)).map(i=>i.sessionId)),new Set(['chat-1','chat-2']));
 assert.equal((await listNodeConversations(f.root,f.nodes.B.id))[0].sessionId,'chat-3');assert.equal(await readFile(file,'utf8'),before);
 const index=JSON.parse(await readFile(join(f.root,'node-conversations.json'),'utf8'));assert.equal(index.version,1);assert.deepEqual(Object.keys(index).sort(),['nodes','version']);
});
test('未知节点及损坏记录不覆盖已有文件',async()=>{
 const f=await makeV3Fixture({nodes:['A']});await assert.rejects(recordNodeConversation(f.root,'missing','chat'));
 await writeFile(join(f.root,'node-conversations.json'),'broken');await assert.rejects(recordNodeConversation(f.root,f.nodes.A.id,'chat'));assert.equal(await readFile(join(f.root,'node-conversations.json'),'utf8'),'broken');
});
test('普通 Markdown 固化节点身份后保留对话历史',async()=>{
 const f=await makeV3Fixture();await writeFile(join(f.root,'Nodes','ordinary.md'),'正文');const lib=await readLibrary(f.root,{withNotes:true});const n=lib.nodes.find(n=>n.relativePath.endsWith('ordinary.md'));
 await recordNodeConversation(f.root,n.id,'chat');const saved=await writeNote(f.root,{id:n.id,text:'新正文',expectedHash:n.hash});assert.equal(saved.ok,true);assert.notEqual(saved.node.id,n.id);assert.equal((await listNodeConversations(f.root,saved.node.id))[0].sessionId,'chat');
});
test('插件 HTTP 返回历史和工作区，记录操作不需要修改 Session 服务',async()=>{
 const f=await makeV3Fixture({nodes:['A']});const post=body=>handleApiRequest({}, {libraryRoot:f.root}, {url:'http://dsh.local/api',method:'POST',json:async()=>({...body,root:f.root})});
 const empty=await post({kind:'node-conversations',nodeId:f.nodes.A.id});assert.equal(empty.body.cwd,f.workspace);assert.deepEqual(empty.body.conversations,[]);
 const saved=await post({kind:'record-node-conversation',nodeId:f.nodes.A.id,conversationId:'chat'});assert.equal(saved.body.ok,true);assert.equal(saved.body.conversations[0].sessionId,'chat');
 const read=await post({kind:'node-conversations',nodeId:f.nodes.A.id});assert.equal(read.body.conversations.length,1);
 const invalid=await post({kind:'record-node-conversation',nodeId:f.nodes.A.id,conversationId:42});assert.equal(invalid.status,400);
});
test('标准创建只传 cwd；记录失败重试同一对话，打开历史只调用导航',async()=>{
 const created=[];const opened=[];let fail=true;const records=[];
 const services={sessions:{create:async opts=>{created.push(opts);return 'new-chat';},list:{getSnapshot:()=>({byId:{'new-chat':{title:'当前标题'}}})}},uiWorkspace:{openSession:id=>opened.push(id)}};
 const fetcher=async(url,opts)=>{const b=JSON.parse(opts.body);let body={ok:true,root:'/workspace/.dsh_knowledge',cwd:'/workspace',conversations:records};if(b.kind==='record-node-conversation'){if(fail){fail=false;body={ok:false,error:{message:'disk failed'}};}else{records.push({sessionId:b.conversationId,createdAt:1});}}return{ok:true,json:async()=>body};};
 const actions=makeConversationActions(()=>services,fetcher);await assert.rejects(actions.create('node'),/disk failed/);assert.equal(opened.length,0);assert.equal(await actions.create('node'),'new-chat');assert.deepEqual(created,[{cwd:'/workspace'}]);assert.equal(records.length,1);
 actions.open('new-chat');assert.deepEqual(opened,['new-chat']);assert.equal(actions.title('new-chat'),'当前标题');assert.equal(created.length,1);
});
test('同一节点并发创建合并为一次，服务缺失时不会创建或记录',async()=>{
 let count=0;const services={sessions:{create:async()=>{count++;return 'chat'}},uiWorkspace:{openSession:()=>{}}};const fetcher=async()=>({ok:true,json:async()=>({ok:true,root:'/lib',cwd:'/cwd',conversations:[]})});
 const actions=makeConversationActions(()=>services,fetcher);assert.deepEqual(await Promise.all([actions.create('node'),actions.create('node')]),['chat','chat']);assert.equal(count,1);await assert.rejects(makeConversationActions(()=>undefined,fetcher).create('node'),/unavailable/);
});
test('新建对话挂到节点所在的工作区（只传 workspaceId，不落「未分组」）',async()=>{
 const created=[];
 const services={sessions:{create:async opts=>{created.push(opts);return 'chat-1';}},uiWorkspace:{openSession:()=>{}},workspaces:{list:{getSnapshot:()=>({items:[{workspaceId:'w1',path:'D:\\Note\\kb',sessionIds:['other']}]})}}};
 const fetcher=async()=>({ok:true,json:async()=>({ok:true,root:'D:\\Note\\kb\\.dsh_knowledge',cwd:'D:\\Note\\kb',conversations:[]})});
 assert.equal(await makeConversationActions(()=>services,fetcher).create('node'),'chat-1');
 assert.deepEqual(created,[{workspaceId:'w1'}],'只传 workspaceId（传了它宿主就不看 cwd ✓）');
});
test('路径对不上工作区时退回当前会话归属的工作区；都认不出才只传 cwd',async()=>{
 const created=[];
 const services={sessions:{create:async opts=>{created.push(opts);return 'chat-2';}},uiWorkspace:{openSession:()=>{}},workspaces:{list:{getSnapshot:()=>({items:[{workspaceId:'w9',path:'/elsewhere',sessionIds:['s1']}]})}}};
 const answer=cwd=>({ok:true,json:async()=>({ok:true,root:'/lib',cwd,conversations:[]})});
 await makeConversationActions(()=>services,async()=>answer('/nowhere')).create('node',{sessionId:'s1'});
 await makeConversationActions(()=>services,async()=>answer('/nowhere')).create('other-node');
 assert.deepEqual(created,[{workspaceId:'w9'},{cwd:'/nowhere'}]);
});
test('pickWorkspaceId：路径优先（分隔符/大小写容忍），认不出来返回 undefined',()=>{
 const snapshot={items:[{workspaceId:'w1',path:'D:\\Note\\kb\\',sessionIds:[]},{workspaceId:'w2',path:'/b',sessionIds:['s1']}]};
 assert.equal(pickWorkspaceId(snapshot,{cwd:'d:/note/kb'}),'w1','Windows 分隔符与大小写要对得上 ✓');
 assert.equal(pickWorkspaceId(snapshot,{cwd:'/b',sessionId:'s1'}),'w2');
 assert.equal(pickWorkspaceId(snapshot,{sessionId:'s1'}),'w2','路径认不出时按会话归属 ✓');
 assert.equal(pickWorkspaceId(snapshot,{cwd:'/missing'}),undefined);
 assert.equal(pickWorkspaceId({items:[{path:'/b'}]},{cwd:'/b'}),undefined,'没有 workspaceId 不算命中 ✓');
 assert.equal(pickWorkspaceId(undefined,{cwd:'/b'}),undefined,'老宿主没有服务时安全退出 ✓');
 assert.equal(pickWorkspaceId({items:'nope'},{cwd:'/b'}),undefined,'快照形状不对不猜 ✓');
});
test('新对话优先走宿主自己的工作区新会话（复用空白 ⇒ 不额外建会话、不换会话）',async()=>{
 const calls=[];
 const services={sessions:{create:async opts=>{calls.push(['create',opts]);return 'made';},list:{getSnapshot:()=>({phase:'ready',byId:{}})}},uiWorkspace:{openSession:()=>{},connectWorkspace:async id=>{calls.push(['connect',id]);return 'reused';}},workspaces:{list:{getSnapshot:()=>({items:[{workspaceId:'w1',path:'/workspace',sessionIds:[]}]})}}};
 const fetcher=async()=>({ok:true,json:async()=>({ok:true,root:'/workspace/.dsh_knowledge',cwd:'/workspace',conversations:[]})});
 const actions=makeConversationActions(()=>services,fetcher);
 assert.equal(await actions.create('node'),'reused');
 assert.deepEqual(calls,[['connect','w1']],'只调 connectWorkspace，不再自己建会话 ✓');
});
test('空白会话立即保存关联；首次消息通知更新显示，重挂载仍能取得历史',async()=>{
 let snapshot={phase:'ready',byId:{'blank-1':{blank:true}}};const listeners=new Set();const records=[];const events=[];
 const services={sessions:{create:async()=>'blank-1',list:{getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}}},uiWorkspace:{openSession:()=>{}}};
 const fetcher=async(url,opts)=>{const body=JSON.parse(opts.body);if(body.kind==='record-node-conversation')records.push({sessionId:body.conversationId,createdAt:1});return{ok:true,json:async()=>({ok:true,root:'/lib',cwd:'/workspace',conversations:records})};};
 const actions=makeConversationActions(()=>services,fetcher);const stop=actions.subscribe(changed=>events.push(changed));
 await actions.create('node');assert.equal(records.length,1);assert.deepEqual(events,[true]);assert.equal(actions.hasContent('blank-1'),false);
 stop();assert.equal(listeners.size,0);
 const second=makeConversationActions(()=>services,fetcher);const stopSecond=second.subscribe(changed=>events.push(changed));
 assert.equal((await second.list('node')).conversations.length,1);
 snapshot={phase:'ready',byId:{'blank-1':{blank:false,title:'第一轮'}}};for(const fn of [...listeners])fn();
 assert.equal(second.hasContent('blank-1'),true);assert.equal(second.title('blank-1'),'第一轮');assert.equal(events.at(-1),false);assert.equal(records.length,1);
 stopSecond();assert.equal(listeners.size,0);
});
test('列表还没就绪 / 会话不在列表里时按「有内容」处理（绝不把真对话藏起来）',()=>{
 const services={sessions:{create:async()=>'x',list:{getSnapshot:()=>({phase:'pending',byId:{}})}},uiWorkspace:{openSession:()=>{}}};
 const actions=makeConversationActions(()=>services,async()=>({ok:true,json:async()=>({ok:true,root:'/lib',cwd:'/cwd',conversations:[]})}));
 assert.equal(actions.hasContent('unknown-session'),true);
 assert.equal(makeConversationActions(()=>undefined,async()=>({ok:true,json:async()=>({})})).hasContent('x'),true,'没有服务时也不隐藏 ✓');
});
test('节点历史列表按 recordState 过滤（空白 + 归档筛选都由它决定 ✓）',async()=>{
 const source=await readFile(new URL('../src/client/NodeConversations.tsx',import.meta.url),'utf8');
 assert.match(source,/nodeConversations\.recordState\(item\.sessionId/,'列表要按 recordState 过滤 ✓');
 assert.match(source,/nodeConversations\.archivedFilter\(\)/,'筛选值每轮只读一次再逐行用 ✓');
 assert.ok(!/if \(!open\) return;\s*\n\s*const timer = setInterval/.test(source),'复读**不许**只在弹窗打开时进行（去侧栏改筛选会把弹窗关掉 ✗）');
 assert.match(source,/setInterval\(\(\) => setFilterRevision/,'要一直在后台复读筛选值 ✓');
 assert.ok(!/const rows = useMemo/.test(source),'列表每轮现算，不做记忆化（否则重新打开弹窗会先显示旧值 ✗）');
 assert.match(source,/disabled=\{busy \|\| archived\}/,'已归档的那条要禁掉（点不开的东西不许看着能点 ✗）');
 assert.match(source,/nodeChatArchived/,'已归档要标出来 ✓');
});

function sidebarFixture(){
 let mounted='old';let expanded=true;const listeners=new Set();const opened=[];const focused=[];
 const source=[{id:'graph',kind:'knowledgenet',contentId:'sidebar://knowledgenet'},{id:'web',kind:'browser',contentId:'sidebar://browser/original'},{id:'file',kind:'document',contentId:'dsh-resource://file/report.md'}];
 const surfaces=new Map([['old',source]]);
 const sidebar={mounted:{getSnapshot:()=>mounted,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}},tabsIn:id=>surfaces.get(id)??[],active:()=>({id:'graph'}),isExpanded:()=>expanded,toggleExpanded:()=>{expanded=!expanded;},focus:id=>focused.push(id),tabDomain:{occurrence:(session,tab)=>({navigation:{getSnapshot:()=>({params:{owner:tab.id}})}})},openTab:(kind,options)=>{opened.push([mounted,kind,options]);const list=surfaces.get(mounted)??[];list.push({id:'new-'+kind,kind,contentId:'sidebar://'+kind});surfaces.set(mounted,list);expanded=true;},openResource:(address,options)=>{opened.push([mounted,address,options]);const list=surfaces.get(mounted)??[];list.push({id:'new-file',kind:options.kind,contentId:address});surfaces.set(mounted,list);expanded=true;}};
 return {sidebar,opened,focused,listeners,surfaces,setMounted(id){mounted=id;for(const fn of [...listeners])fn();},setExpanded(v){expanded=v;}};
}
test('延迟挂载后恢复图谱、浏览器和文件标签及参数，一次恢复且保留原会话',()=>{
 const fixture=sidebarFixture();const services={sessions:{create:async()=>'x'},sidebarRight:fixture.sidebar,uiWorkspace:{openSession:()=>fixture.setMounted(undefined)}};
 const actions=makeConversationActions(()=>services,async()=>{});actions.open('new');assert.equal(fixture.opened.length,0);assert.equal(fixture.listeners.size,1);
 fixture.setMounted('new');assert.equal(fixture.opened.length,3);assert.deepEqual(fixture.opened.map(entry=>entry[1]),['knowledgenet','browser','dsh-resource://file/report.md']);assert.deepEqual(fixture.opened[1][2],{params:{owner:'web'}});assert.equal(fixture.surfaces.get('old').length,3);assert.deepEqual(fixture.focused,['new-knowledgenet']);assert.equal(fixture.listeners.size,0);
 fixture.setMounted('new');assert.equal(fixture.opened.length,3);
});
test('已有目标标签保留且不改写参数；折叠状态恢复；同会话不会重开标签',()=>{
 const fixture=sidebarFixture();fixture.setExpanded(false);fixture.surfaces.set('new',[{id:'existing-file',kind:'document',contentId:'dsh-resource://file/report.md'}]);
 const actions=makeConversationActions(()=>({sessions:{create:async()=>'x'},sidebarRight:fixture.sidebar,uiWorkspace:{openSession:id=>fixture.setMounted(id)}}),async()=>{});
 actions.open('new');assert.equal(fixture.opened.length,2);assert.equal(fixture.sidebar.isExpanded(),false);assert.equal(fixture.surfaces.get('new')[0].id,'existing-file');actions.open('new');assert.equal(fixture.opened.length,2);
});
test('快速改换目标、用户另行导航、插件释放均取消旧恢复任务',()=>{
 const fixture=sidebarFixture();const actions=makeConversationActions(()=>({sessions:{create:async()=>'x'},sidebarRight:fixture.sidebar,uiWorkspace:{openSession:()=>{}}}),async()=>{});
 actions.open('first');actions.open('second');assert.equal(fixture.listeners.size,1);fixture.setMounted('first');assert.equal(fixture.opened.length,0);assert.equal(fixture.listeners.size,0);
 fixture.setMounted('old');actions.open('third');actions.dispose();assert.equal(fixture.listeners.size,0);fixture.setMounted('third');assert.equal(fixture.opened.length,0);
});
test('会话与工作区变化主动通知，服务替换重新订阅，解绑后不残留监听',()=>{
 const first=new Set();const second=new Set();const workspaces=new Set();const watch=set=>({subscribe:fn=>{set.add(fn);return()=>set.delete(fn);},getSnapshot:()=>({byId:{}})});
 let services={sessions:{create:async()=>'',list:watch(first)},uiWorkspace:{openSession:()=>{}},workspaces:{list:watch(workspaces)}};
 const actions=makeConversationActions(()=>services,async()=>{});const events=[];const stop=actions.subscribe(v=>events.push(v));for(const fn of first)fn();for(const fn of workspaces)fn();assert.deepEqual(events,[false,false]);
 services={...services,sessions:{...services.sessions,list:watch(second)}};actions.servicesChanged();assert.equal(first.size,0);assert.equal(second.size,1);assert.equal(events.at(-1),true);stop();assert.equal(second.size,0);assert.equal(workspaces.size,0);
});

test('确定已删除的会话隐藏，目录尚未就绪及已归档会话保留适当显示',()=>{
 let catalog={phase:'pending',byId:{}};let archivedSessionIds=[];
 const services={sessions:{create:async()=>'',list:{getSnapshot:()=>catalog}},workspaces:{list:{getSnapshot:()=>({archivedSessionIds})}},uiWorkspace:{openSession:()=>{}}};
 const actions=makeConversationActions(()=>services,async()=>{});assert.equal(actions.recordState('gone','show'),'show');catalog={phase:'ready',byId:{}};assert.equal(actions.recordState('gone','show'),'hide');archivedSessionIds=['gone'];assert.equal(actions.recordState('gone','show'),'archived');
});
test('同一个资源的两个来源标签分别恢复，目标既有标签只匹配其中一个',()=>{
 const fixture=sidebarFixture();fixture.surfaces.get('old').push({id:'second-file',kind:'document',contentId:'dsh-resource://file/report.md'});fixture.surfaces.set('new',[{id:'existing-file',kind:'document',contentId:'dsh-resource://file/report.md'}]);
 const actions=makeConversationActions(()=>({sessions:{create:async()=>'x'},sidebarRight:fixture.sidebar,uiWorkspace:{openSession:id=>fixture.setMounted(id)}}),async()=>{});actions.open('new');assert.equal(fixture.surfaces.get('new').filter(tab=>tab.kind==='document').length,2);assert.equal(fixture.opened.find(item=>item[1].startsWith('dsh-resource://'))[2].revealIfOpened,false);
});


test('安装版先公布目标会话但尚未采用侧栏存储时，恢复等待采用，不丢标签', async()=>{
 const fixture=sidebarFixture();const events=new Set();let ready=false;
 fixture.sidebar.openTabs={subscribe:fn=>{events.add(fn);return()=>events.delete(fn);}};
 const open=fixture.sidebar.openTab;fixture.sidebar.openTab=(...args)=>{if(!ready)throw Error('sidebarRight: no session surface is mounted');open(...args);};
 const actions=makeConversationActions(()=>({sessions:{create:async()=>'new'},sidebarRight:fixture.sidebar,uiWorkspace:{openSession:id=>fixture.setMounted(id)}}),async()=>{});
 assert.doesNotThrow(()=>actions.open('new'));assert.equal(fixture.opened.length,0);assert.equal(fixture.listeners.size,1);
 ready=true;for(const fn of [...events])fn();assert.deepEqual(fixture.opened.map(item=>item[1]),['knowledgenet','browser','dsh-resource://file/report.md']);assert.equal(fixture.sidebar.isExpanded(),true);assert.equal(fixture.listeners.size,0);assert.equal(events.size,0);assert.equal(fixture.surfaces.get('old').length,3);
});


test('恢复标签触发宿主同步通知时不重入，不重复创建',()=>{
 const fixture=sidebarFixture();const events=new Set();fixture.sidebar.openTabs={subscribe:fn=>{events.add(fn);return()=>events.delete(fn);}};
 const open=fixture.sidebar.openTab;fixture.sidebar.openTab=(...args)=>{open(...args);for(const fn of [...events])fn();};
 const actions=makeConversationActions(()=>({sessions:{create:async()=>'new'},sidebarRight:fixture.sidebar,uiWorkspace:{openSession:id=>fixture.setMounted(id)}}),async()=>{});
 actions.open('new');assert.equal(fixture.opened.length,3);assert.equal(fixture.listeners.size,0);assert.equal(events.size,0);
});
