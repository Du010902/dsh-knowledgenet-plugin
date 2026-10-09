import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeV3Fixture, cleanupFixtures } from './support/v3-fixture.mjs';
import { readUnderstanding, setUnderstanding } from '../src/host/understanding.ts';
after(cleanupFixtures);
test('理解标记保存、重读、撤销标记且不改写正文', async () => {
  const f = await makeV3Fixture({nodes:['A']});
  const node = f.nodes.A;
  const file = join(f.root,node.relativePath);
  const before = await readFile(file,'utf8');
  assert.deepEqual(await readUnderstanding(f.root),{});
  await setUnderstanding(f.root,node.id,true);
  assert.equal((await readUnderstanding(f.root))[node.id],true);
  await setUnderstanding(f.root,node.id,false);
  assert.equal((await readUnderstanding(f.root))[node.id],false);
  assert.equal(await readFile(file,'utf8'),before);
});
test('并发标记不同节点不会互相覆盖',async()=>{
  const f = await makeV3Fixture({nodes:['A','B']});
  await Promise.all([setUnderstanding(f.root,f.nodes.A.id,true),setUnderstanding(f.root,f.nodes.B.id,true)]);
  const read=await readUnderstanding(f.root);
  assert.equal(read[f.nodes.A.id],true);assert.equal(read[f.nodes.B.id],true);
});
test('未知节点与损坏状态文件拒绝写入',async()=>{
  const f=await makeV3Fixture({nodes:['A']});
  await assert.rejects(setUnderstanding(f.root,'unknown',true));
  await writeFile(join(f.root,'understanding.json'),'bad');
  await assert.rejects(setUnderstanding(f.root,f.nodes.A.id,true));
  assert.equal(await readFile(join(f.root,'understanding.json'),'utf8'),'bad');
});

test('普通 Markdown 首次保存固化身份后保留理解标记',async()=>{
 const {readLibrary,writeNote}=await import('../src/host/v3/store.ts');
 const f=await makeV3Fixture();
 await writeFile(join(f.root,'Nodes','ordinary.md'),'# 普通知识\n');
 const library=await readLibrary(f.root,{withNotes:true});
 const node=library.nodes.find(n=>n.relativePath.endsWith('ordinary.md'));
 assert.ok(node.id.startsWith('adopted-'));
 await setUnderstanding(f.root,node.id,true);
 const saved=await writeNote(f.root,{id:node.id,text:'更新后的笔记',expectedHash:node.hash});
 assert.equal(saved.ok,true);assert.notEqual(saved.node.id,node.id);
 assert.equal((await readUnderstanding(f.root))[saved.node.id],true);
});
