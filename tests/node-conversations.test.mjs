import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeV3Fixture, cleanupFixtures } from './support/v3-fixture.mjs';
import { listNodeConversations, recordNodeConversation } from '../src/host/node-conversations.ts';
import { readLibrary, writeNote } from '../src/host/v3/store.ts';
import { handleApiRequest } from '../src/host/api.ts';
import { makeConversationActions } from '../src/client/node-conversations.ts';
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
