import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {reviewedWorklineDocument,syncReviewedWorkline} from '../sync-workline-document.mjs';

function fixture(){
 const ref={text:'本月上限与预测分别核对。',evidence_ids:['e']};
 const evidence={id:'e',source_id:'source',source_ids:['source'],source_type:'im',source_title:'示例来源',speaker:'示例负责人',occurred_at:'2026-01-01T00:00:00Z',text:'上限为已确认目标，预测仍待复核。',locator:'example'};
 const run={id:'review',model:'assistant review',provider:'local',route:'A',status:'VERIFIED',inputSourceIds:['source'],provenance:{input_cutoff:'2026-01-02T00:00:00Z',input_evidence_ids:['e']},metrics:{latency_ms:null,input_tokens:null,output_tokens:null,cost_cny:null},audit:{citations:'valid',review_status:'REVIEWED'},answer:{summary:ref.text,developments:[],viewpoints:[],decisions:[],open_questions:[],next_steps:[]}};
 return {dataset:{schema_version:'business-qa-v1',dataset_id:'example',as_of:'2026-01-02T00:00:00Z',cases:[{id:'work',title:'示例成本',question:'当前状态？',scope:'授权来源',as_of:'2026-01-02T00:00:00Z',evidence:[evidence],runs:[run]}]},
  guide:{schema_version:'business-reading-guide-v1',dataset_id:'example',cases:[{case_id:'work',title:'示例成本',run_id:'review',comparison_run_id:null,current:ref,follow_up:{person:'示例负责人',...ref},confirm:ref,boundary:ref,answer_url:null}]},documentPolicy:{version:'document-source-policy-v1',documents:[]},allowedSources:new Set(['source']),caseId:'work'};
}
test('only reviewed current cards with currently allowed evidence can be synchronized',()=>{
 const f=fixture();assert.match(reviewedWorklineDocument(f).content,/原文依据/);
 assert.throws(()=>reviewedWorklineDocument({...f,minimumAsOf:'2026-01-03T00:00:00Z'}),/WORKLINE_REVIEW_REQUIRED/);
 assert.throws(()=>reviewedWorklineDocument({...f,allowedSources:new Set()}),/WORKLINE_SOURCE_NOT_ALLOWED/);
 f.dataset.cases[0].runs[0].audit.review_status='PENDING_USER';
 assert.throws(()=>reviewedWorklineDocument(f),/WORKLINE_REVIEW_REQUIRED/);
});
async function setup(t){
 const dir=await mkdtemp(join(tmpdir(),'workline-doc-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const f=fixture(),config={enabled:true,userAuthorized:true,caseId:'work',documentToken:'ExampleDocToken123',receiptPath:join(dir,'receipt.json')};
 for(const [key,value] of Object.entries({datasetPath:f.dataset,readingGuidePath:f.guide,documentPolicyPath:f.documentPolicy,attentionPath:{version:1,sources:[{id:'source',kind:'group',name:'示例',tier:'normal',status:'active',manualOverride:true,matchedWorklines:[]}]}})){
  config[key]=join(dir,key+'.json');await writeFile(config[key],JSON.stringify(value));
 }
 const path=join(dir,'config.json');await writeFile(path,JSON.stringify(config));
 return {dir,f,config,path};
}
test('successful writes are read back; unchanged content rechecks the remote document without duplicate insertion',async t=>{
 const s=await setup(t);let content='<title>示例成本</title>',writes=0,reads=0;
 const adapter={fetch:async()=>{reads++;return{document_id:s.config.documentToken,content,revision_id:2};},insert:async(_token,xml)=>{writes++;content+=xml;}};
 assert.equal((await syncReviewedWorkline(s.path,{adapter})).changed,true);
 assert.equal((await syncReviewedWorkline(s.path,{adapter})).changed,false);
 assert.equal(writes,1);assert.equal(reads,3);
 assert.equal(JSON.parse(await readFile(s.config.receiptPath)).status,'SYNCED');
});
test('an ambiguous write is not automatically replayed, but can be recovered through complete remote readback',async t=>{
 const s=await setup(t);let writes=0,content='<title>示例成本</title>';
 const adapter={fetch:async()=>({document_id:s.config.documentToken,content}),insert:async()=>{writes++;throw Error('connection lost');}};
 await assert.rejects(syncReviewedWorkline(s.path,{adapter}),/connection lost/);
 await assert.rejects(syncReviewedWorkline(s.path,{adapter}),/DOCUMENT_WRITE_STATUS_UNKNOWN/);assert.equal(writes,1);
 content+=reviewedWorklineDocument(s.f).content;
 assert.equal((await syncReviewedWorkline(s.path,{adapter})).status,'SYNCED');assert.equal(writes,1);
});
test('revoked access or stale review produces no document request',async t=>{
 const s=await setup(t);let calls=0;
 const adapter={fetch:async()=>{calls++;},insert:async()=>{calls++;}};
 await assert.rejects(syncReviewedWorkline(s.path,{adapter,minimumAsOf:'2026-01-03T00:00:00Z'}),/WORKLINE_REVIEW_REQUIRED/);
 await writeFile(s.config.attentionPath,JSON.stringify({version:1,sources:[{id:'source',tier:'normal',status:'excluded',matchedWorklines:[]}]}));
 await assert.rejects(syncReviewedWorkline(s.path,{adapter}),/WORKLINE_SOURCE_NOT_ALLOWED/);assert.equal(calls,0);
});
test('an unrelated receipt binding is rejected before document writes',async t=>{
 const s=await setup(t);await writeFile(s.config.receiptPath,JSON.stringify({caseId:'other',documentToken:s.config.documentToken,status:'SYNCED'}));
 let calls=0;await assert.rejects(syncReviewedWorkline(s.path,{adapter:{fetch:async()=>{calls++;}}}),/DOCUMENT_BINDING_CHANGED/);assert.equal(calls,0);
});
test('a source excluded during document reading prevents the subsequent write',async t=>{
 const s=await setup(t);let writes=0;
 const adapter={fetch:async()=>{
  await writeFile(s.config.attentionPath,JSON.stringify({version:1,sources:[{id:'source',tier:'normal',status:'excluded',matchedWorklines:[]}]}));
  return{document_id:s.config.documentToken,content:'<title>示例成本</title>'};
 },insert:async()=>{writes++;}};
 await assert.rejects(syncReviewedWorkline(s.path,{adapter}),/WORKLINE_SOURCE_NOT_ALLOWED/);assert.equal(writes,0);
});
test('a newer case timestamp cannot promote an older selected review',()=>{
 const f=fixture();f.dataset.as_of=f.dataset.cases[0].as_of='2026-01-03T00:00:00Z';
 assert.throws(()=>reviewedWorklineDocument({...f,minimumAsOf:'2026-01-03T00:00:00Z'}),/WORKLINE_REVIEW_REQUIRED/);
});
test('non-cited inputs and mixed allowed/excluded identities are still checked before requests',async t=>{
 const s=await setup(t),d=s.f.dataset,item=d.cases[0];
 item.evidence.push({...item.evidence[0],id:'hidden',source_id:'denied',source_ids:['denied','source']});
 item.runs[0].provenance.input_evidence_ids.push('hidden');item.runs[0].inputSourceIds.push('denied');
 await writeFile(s.config.datasetPath,JSON.stringify(d));
 await writeFile(s.config.attentionPath,JSON.stringify({version:1,sources:[{id:'source',tier:'normal',status:'active',manualOverride:true,matchedWorklines:[]},{id:'denied',tier:'normal',status:'excluded',matchedWorklines:[]}]}));
 let calls=0;await assert.rejects(syncReviewedWorkline(s.path,{adapter:{fetch:async()=>{calls++;}}}),/WORKLINE_SOURCE_NOT_ALLOWED/);assert.equal(calls,0);
});
test('a checkout child beginning with two dots is not a private external directory',async t=>{
 const dir=await mkdtemp(fileURLToPath(new URL('../../../..private-sync-',import.meta.url)));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'config.json');await writeFile(path,'{}');
 await assert.rejects(syncReviewedWorkline(path),/PRIVATE_SYNC_PATH_REQUIRED/);
});
