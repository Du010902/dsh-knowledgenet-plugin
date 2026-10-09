import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {handleApiRequest} from '../src/host/api.ts';
import {makeV3Fixture,cleanupFixtures} from './support/v3-fixture.mjs';
after(cleanupFixtures);
test('同名图片并发上传不覆盖，取图返回相同字节',async()=>{
 const f=await makeV3Fixture({nodes:['A']});
 const config={libraryRoot:f.root,imageDir:'image'};
 const dataUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz8AAAAASUVORK5CYII=';
 const saves=await Promise.all(Array.from({length:3},()=>handleApiRequest({},config,{url:'http://dsh.local/api',method:'POST',json:async()=>({kind:'image-save',root:f.root,name:'sample.png',dataUrl})})));
 assert.equal(new Set(saves.map(s=>s.body.path)).size,3);
 for(const saved of saves){assert.equal(saved.body.ok,true);const bytes=await readFile(join(f.root,saved.body.path));assert.deepEqual(bytes,Buffer.from(dataUrl.split(',')[1],'base64'));const get=await handleApiRequest({},config,{url:'http://dsh.local/api?kind=image&root='+encodeURIComponent(f.root)+'&path='+encodeURIComponent(saved.body.path)});assert.equal(get.status,200);assert.deepEqual(Buffer.from(await get.raw.arrayBuffer()),bytes);}
});

test('图片 Markdown 保存后重读保留相对路径、空图注和缩放比例',async()=>{
 const f=await makeV3Fixture({nodes:['A']});const config={libraryRoot:f.root,imageDir:'image'};
 const request=async(body)=>handleApiRequest({},config,{url:'http://dsh.local/api',method:'POST',json:async()=>({...body,root:f.root})});
 const read=await request({kind:'read-node-document',nodeId:f.nodes.A.id});assert.equal(read.body.ok,true);
 const markdown='# 图片笔记\n\n![0.75](image/sample.png "")\n';
 const save=await request({kind:'save-node-document',nodeId:f.nodes.A.id,text:markdown,hash:read.body.document.hash});assert.equal(save.body.ok,true);
 const reopened=await request({kind:'read-node-document',nodeId:f.nodes.A.id});assert.equal(reopened.body.ok,true);assert.ok(reopened.body.document.text.includes('![0.75](image/sample.png "")'));assert.ok(!reopened.body.document.text.includes('blob:'));
});

test('理解状态通过接口保存并由图谱读取，正文保持不变',async()=>{
 const f=await makeV3Fixture({nodes:['A']});const config={libraryRoot:f.root,imageDir:'image',graphMaxNodes:400};
 const before=await readFile(join(f.root,f.nodes.A.relativePath),'utf8');
 const set=await handleApiRequest({},config,{url:'http://dsh.local/api',method:'POST',json:async()=>({kind:'set-understanding',root:f.root,nodeId:f.nodes.A.id,understood:true})});assert.equal(set.body.ok,true);
 const graph=await handleApiRequest({},config,{url:'http://dsh.local/api?root='+encodeURIComponent(f.root)});assert.equal(graph.body.ok,true);assert.equal(graph.body.understanding[f.nodes.A.id],true);
 assert.equal(await readFile(join(f.root,f.nodes.A.relativePath),'utf8'),before);
});
