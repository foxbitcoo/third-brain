import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { projectBoards, findBoardSnapshot, readBoardImage, safeBoardUrl, validateBoardManifest, validBoardScopeWindow } from '../discovery-boards.mjs';
import { startWorkbenchServer, parseArgs } from '../server.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOucAAAAASUVORK5CYII=','base64');
const digest=value=>createHash('sha256').update(value).digest('hex');
function fixture(root='/private/example') {
  return {version:'discovery-boards/v1',imageRoot:root,generatedAt:'2026-10-18T04:00:00Z',allowedLinkHosts:['example.invalid'],boards:[{id:'daily',title:'业务日报',analysisSourceId:'verified-history',relationNote:'统计日与推送日分别保留。',snapshots:[{id:'snapshot-a',title:'样例日报',statisticsDate:'2026-10-11',pushedAt:'2026-10-18T01:00:00Z',sourceId:'source-a',sourceRef:'chat-a',messageId:'message-a',imageFile:'image.png',sha256:digest(png),sourceUrl:'https://example.invalid/report?id=synthetic'}]}]};
}
const policy=()=>({allowedSourceIds:new Set(['source-a']),excludedSourceIds:new Set(),sourceRefs:new Map([['source-a','chat-a']])});

test('board projection retains separate dates and exposes only local capability routes',()=>{
  const store=fixture();store.boards[0].privateNotes='not-public';
  const result=projectBoards(store,policy()),shot=result.boards[0].snapshots[0];
  assert.equal(shot.statisticsDate,'2026-10-11');assert.match(shot.pushedAt,/2026-10-18/);
  assert.equal(shot.imagePath,'/api/discovery-board-image?board=daily&snapshot=snapshot-a');
  assert.doesNotMatch(JSON.stringify(result),/private\/example|example.invalid|chat-a|message-a|image.png|not-public/);
});
test('source bans, missing approval, changed native identity and permanent message bans hide images and links',()=>{
  const store=fixture();
  for(const p of [{...policy(),excludedSourceIds:new Set(['source-a'])},{...policy(),allowedSourceIds:new Set()},{...policy(),sourceRefs:new Map([['source-a','other-chat']])},{...policy(),blockedLocatorHashes:new Set([digest(JSON.stringify(['wps','chat-a','message-a']))])}]){
    assert.equal(projectBoards(store,p).boards.length,0);assert.equal(findBoardSnapshot(store,p,'daily','snapshot-a'),null);
  }
});
test('a bounded legacy native binding never grants monitoring or extends its window',()=>{
  const store=fixture(), p={...policy(),referenceWindows:new Map([['source-a',{startAt:'2026-10-17T00:00:00Z',endAt:'2026-10-18T02:00:00Z'}]])};
  assert.equal(projectBoards(store,p).boards.length,1);
  p.referenceWindows.get('source-a').endAt='2026-10-18T00:00:00Z';
  assert.equal(projectBoards(store,p).boards.length,0);
  p.referenceWindows.get('source-a').endAt='not-a-date';
  assert.equal(projectBoards(store,p).boards.length,0);
  assert.equal(validBoardScopeWindow({startAt:'not-a-date',endAt:'not-a-date'}),false);
  assert.equal(validBoardScopeWindow({startAt:'2026-10-18T00:00:00Z',endAt:'2026-10-17T00:00:00Z'}),false);
});
test('invalid dates, duplicate snapshot identities and path escapes fail closed',()=>{
  for(const mutate of [s=>{s.boards[0].snapshots[0].statisticsDate='2026-02-30';},s=>{s.boards[0].snapshots[0].imageFile='../escape.png';},s=>{s.boards[0].snapshots.push(s.boards[0].snapshots[0]);},s=>{s.boards[0].snapshots[0].pushedAt='2026-10-18 (private)';}]){
    const store=fixture();mutate(store);assert.throws(()=>validateBoardManifest(store));
  }
});
test('only verified HTTPS destination hosts without credentials are accepted',()=>{
  const hosts=['example.invalid'];
  for(const url of ['http://example.invalid/r','https://other.invalid/r','https://u:p@example.invalid/r','https://example.invalid/r?ticket=secret','https://example.invalid/r?sig=synthetic','https://example.invalid/r#secret','javascript:alert(1)'])assert.equal(safeBoardUrl(url,hosts),null);
  assert.equal(safeBoardUrl('https://example.invalid/r?id=report',hosts),'https://example.invalid/r?id=report');
});
test('binary delivery verifies hash, raster signature, regular file and symlink boundaries',async t=>{
  const root=await mkdtemp(join(tmpdir(),'board-image-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=fixture(root),shot=store.boards[0].snapshots[0];await writeFile(join(root,'image.png'),png);
  assert.equal((await readBoardImage(store,shot,'/different-checkout')).mime,'image/png');
  await assert.rejects(readBoardImage(store,{...shot,sha256:'0'.repeat(64)},'/different-checkout'));
  await symlink(join(root,'image.png'),join(root,'link.png'));
  await assert.rejects(readBoardImage(store,{...shot,imageFile:'link.png'},'/different-checkout'));
  await assert.rejects(readBoardImage(store,shot,root));
});
test('HTTP previews and redirects recheck current source controls and reject arbitrary parameters',async t=>{
  const root=await mkdtemp(join(tmpdir(),'board-route-'));let server;t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const manifest=join(root,'boards.json'),attention=join(root,'attention.json');await writeFile(join(root,'image.png'),png);await writeFile(manifest,JSON.stringify(fixture(root)));
  const controls={version:1,sources:[{id:'source-a',chatId:'chat-a',tier:'priority',status:'active',manualOverride:true,matchedWorklines:[]}]};await writeFile(attention,JSON.stringify(controls));
  server=await startWorkbenchServer({port:0,discoveryBoardsPath:manifest,attentionPath:attention});const base=`http://127.0.0.1:${server.address().port}`;
  const listing=await (await fetch(`${base}/api/discovery-boards`)).json();const shot=listing.boards[0].snapshots[0];
  let response=await fetch(base+shot.imagePath);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
  response=await fetch(base+shot.linkPath,{redirect:'manual'});assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://example.invalid/report?id=synthetic');
  assert.equal((await fetch(base+shot.imagePath+'&path=/private/file')).status,400);
  assert.equal((await fetch(base+shot.imagePath,{headers:{Origin:'https://other.invalid'}})).status,403);
  controls.sources[0].status='excluded';await writeFile(attention,JSON.stringify(controls));
  assert.equal((await fetch(base+shot.imagePath)).status,404);assert.equal((await fetch(base+shot.linkPath,{redirect:'manual'})).status,404);
  assert.equal((await (await fetch(`${base}/api/discovery-boards`)).json()).boards.length,0);
  assert.equal((await fetch(`${base}/api/discovery-boards`,{method:'POST'})).status,405);
  assert.equal(parseArgs(['--discovery-boards',manifest]).discoveryBoardsPath,manifest);
});

test('snapshot OCR is versioned and pinned to image bytes; stale OCR and invalid comparison dates fail closed',()=>{
  const store=fixture(),shot=store.boards[0].snapshots[0];shot.comparisonDate='2026-10-04';shot.ocr={status:'COMPLETED',version:'ocr-v1',createdAt:'2026-10-18T03:00:00Z',imageSha256:shot.sha256,text:'样例图表识别'};
  assert.equal(validateBoardManifest(store),store);const projection=projectBoards(store,policy()).boards[0].snapshots[0];
  assert.equal(projection.comparisonDate,'2026-10-04');assert.equal(projection.ocr.version,'ocr-v1');assert.equal(projection.imageSha256,shot.sha256);
  assert.doesNotMatch(JSON.stringify(projection),/样例图表识别/);
  shot.ocr.imageSha256='b'.repeat(64);assert.throws(()=>validateBoardManifest(store));
  shot.ocr.imageSha256=shot.sha256;shot.comparisonDate='2026-02-30';assert.throws(()=>validateBoardManifest(store));
});
