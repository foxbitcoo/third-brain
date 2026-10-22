import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagnosticModel } from '../diagnostic-adapters.mjs';
import { diagnosticMemorySourceContext } from '../diagnostic-memory-sources.mjs';
import { createDiagnosticService } from '../diagnostic-service.mjs';
import { selectMemorySnapshot } from '../diagnostic-memory.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');

test('actual outbound system contains the revalidated memory block and receipt identifies those exact bytes', async () => {
  const snapshot = { hash: 'snapshot-hash', selected: [{ id:'memory-a',version:1,hash:'record-hash',text:'The numerator is successful requests.',kind:'METRIC_DEFINITION',sourceRefs:[] }] };
  let active = true, sent;
  const model = createDiagnosticModel({ credential:async()=> 'synthetic-key', memoryFor:async()=>active?snapshot:{selected:[],hash:'empty'}, fetchImpl:async(_url, options)=>{
    sent=JSON.parse(options.body);
    return new Response(JSON.stringify({ id:'provider-response',model:'deepseek-v4-pro',usage:{prompt_tokens:120,completion_tokens:40},choices:[{finish_reason:'stop',message:{content:JSON.stringify({decision:'query',recipeId:'r1',reason:'Read counts'})}}] }));
  } });
  const input={run:{id:'test',question:'How many?',rounds:[],businessContext:[],memorySnapshot:snapshot},source:{id:'source',version:'v1',title:'Source',definition:'Counts',recipes:[{id:'r1'}]}};
  const result=await model.plan(input), receipt=result.callReceipt.memoryInjection;
  assert.ok(sent.messages[0].content.includes('The numerator is successful requests.'));
  assert.ok(!sent.messages[1].content.includes('The numerator is successful requests.'));
  assert.equal(receipt.role,'system'); assert.equal(receipt.status,'PROVIDER_RESPONDED');
  assert.equal(receipt.systemPromptSha256,sha(sent.messages[0].content)); assert.equal(receipt.blockSha256,sha(receipt.block));
  assert.deepEqual(receipt.memoryIds,['memory-a']);
  active=false;
  const disabled=await model.plan(input);
  assert.deepEqual(disabled.callReceipt.memoryInjection.memoryIds,[]);
  assert.ok(!sent.messages[0].content.includes('The numerator is successful requests.'));
});

test('named memory evidence requires current policy and exact source bytes; absent evidence never grants permission', async t => {
  const root=await realpath(await mkdtemp(join(tmpdir(),'memory-source-policy-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const bodyPath=join(root,'source.txt'),path=join(root,'sources.json');await writeFile(bodyPath,'Verified body');
  await writeFile(path,JSON.stringify({sources:[{sourceId:'document-a',version:'revision-1',hash:sha('Verified body'),path:bodyPath}]}));
  const options={path,checkoutRoot:join(root,'checkout'),source:{id:'analysis',version:'v1'}};
  assert.deepEqual((await diagnosticMemorySourceContext(options)).allowedSourceIds,['analysis']);
  const allowed=await diagnosticMemorySourceContext({...options,authorizeSource:async()=>true});
  assert.equal(allowed.sourceVersions['document-a'],'revision-1');
  assert.equal(allowed.sourceHashes['document-a'],sha('Verified body'));
  const record={id:'m1',version:1,hash:'m1-hash',kind:'METRIC_DEFINITION',title:'Counts',text:'Counts numerator',keywords:['counts'],status:'SOURCE_VERIFIED',knownAt:'2026-01-01T00:00:00Z',sourceRefs:[{sourceId:'document-a',version:'revision-1',hash:'obsolete-source-hash',knownAt:'2026-01-01T00:00:00Z'}],applicability:{sourceIds:['analysis']}};
  const selection=selectMemorySnapshot({...allowed,records:[record],question:'counts',source:options.source,cutoff:'2026-10-18T00:00:00Z'});
  assert.equal(selection.selected.length,0);assert.equal(selection.excluded[0].reason,'EVIDENCE_CONTENT_CHANGED');
  await writeFile(bodyPath,'Changed body');
  const changed=await diagnosticMemorySourceContext({...options,authorizeSource:async()=>true});
  assert.deepEqual(changed.allowedSourceIds,['analysis']);assert.equal(changed.excluded[0].reason,'SOURCE_CONTENT_CHANGED');
});

test('service snapshots source-backed memory, preserves its history and suppresses old content after source revocation', async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'memory-service-policy-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const source={id:'source',title:'Counts',version:'v1',definition:'Counts',definitionVerified:true,userAuthorized:true,recipes:[{id:'r1',title:'Counts',tool:'execute_raw_sql',complexSqlVerified:true,arguments:{sql:'SELECT 1'}}]};
  const configPath=join(root,'config.json'),body=join(root,'document.txt'),manifest=join(root,'manifest.json');
  await writeFile(body,'Numerator meaning'); await writeFile(manifest,JSON.stringify({sources:[{sourceId:'doc',version:'v1',hash:sha('Numerator meaning'),path:body}]}));
  await writeFile(configPath,JSON.stringify({version:'diagnostic-config-v1',storeDirectory:join(root,'runs'),memorySourcesPath:manifest,sources:[source]}));
  const record={id:'m1',version:1,hash:'record',kind:'METRIC_DEFINITION',title:'Numerator',text:'Numerator meaning',keywords:['numerator'],knownAt:'2026-01-01T00:00:00Z',status:'SOURCE_VERIFIED',sourceRefs:[{sourceId:'doc',version:'v1',hash:sha('Numerator meaning'),locator:'section',knownAt:'2026-01-01T00:00:00Z'}],applicability:{sourceIds:['source'],sourceVersions:{source:'v1'}}};
  let authorized=true;
  const service=await createDiagnosticService({configPath,checkoutRoot:join(root,'checkout'),authorizeMemorySource:async()=>authorized,memoryStore:{list:async()=>[record],close:async()=>{}},query:async()=>{},model:{plan:async()=>({decision:'needs_human',reason:'Missing date',questions:['Which date?']}),review:async()=>{}}});
  t.after(()=>service.close());
  assert.equal((await service.memoryList()).records.length,1);
  const created=await service.create({question:'numerator meaning?',sourceId:'source',trigger:'manual'});
  assert.equal(created.run.memorySnapshot.selected.length,1);
  assert.equal((await service.get(created.run.id)).run.memorySnapshot.selected[0].text,'Numerator meaning');
  authorized=false;
  assert.equal((await service.memoryList()).records.length,0);
  assert.equal((await service.get(created.run.id)).run.status,'SUPPRESSED');
  await assert.rejects(service.memoryAction({id:'m1',action:'confirm'}),error=>error.code==='SOURCE_POLICY_CHANGED');
});
