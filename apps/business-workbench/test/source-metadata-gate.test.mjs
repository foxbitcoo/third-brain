import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {refreshSources} from '../source-refresh.mjs';
import {loadAttention,readPlan} from '../source-attention.mjs';
const now='2026-10-15T08:00:00Z';
test('active metadata alone cannot authorize reading a new candidate; missing model fails closed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'metadata-gate-'));try{
 const policyPath=join(dir,'p.json');await writeFile(policyPath,JSON.stringify({version:1,sources:[]}));let reads=0;
 const receipt=await refreshSources({policyPath,config:{sources:[],worklines:['工作'],keywordDiscovery:{rules:[{workline:'工作',keywords:['release']}]}},output:join(dir,'out'),now,adapter:{recent:async()=>({complete:true,items:[{id:'unknown',chatId:'u',name:'公司大群',kind:'group',lastActiveAt:now}]}),messages:async()=>{reads++;throw Error('no read');},searchMessages:async()=>{reads++;throw Error('no search');}},judge:async()=>{throw Error('no body judge');}});
 assert.equal(receipt.status,'PARTIAL');assert.equal(receipt.keywordDiscovery.status,'PARTIAL');assert.equal(reads,0);const s=(await loadAttention(policyPath)).sources[0];assert.equal(s.status,'candidate');assert.equal(readPlan({sources:[s]},Date.parse(now)).length,0);assert.equal(receipt.selectedCount,0);
 }finally{await rm(dir,{recursive:true});}
});
import {screenSourceMetadata,canPreviewSource} from '../source-metadata-gate.mjs';
import {isTrustedListeningSource,demoteKeywordOnlySource,saveChange} from '../source-attention.mjs';
import {discoverGroupKeywords} from '../group-keyword-discovery.mjs';
import {createMetadataJudge} from '../refresh-judges.mjs';
const candidate=id=>({id,chatId:id,name:'业务协作 '+id,kind:'group',status:'candidate',tier:'on_match',manualOverride:false,matchedWorklines:[],evidenceRefs:[]});
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'gate-cases-'));const policyPath=join(dir,'p.json');try{await writeFile(policyPath,JSON.stringify({version:1,sources:[]}));await fn({dir,policyPath});}finally{await rm(dir,{recursive:true});}}
test('batch metadata decisions never receive snippets; insufficient, failed, duplicate and excluded answers cannot read',()=>fixture(async({policyPath})=>{
 const rows=Array.from({length:53},(_,i)=>({...candidate('g'+i),lastMessage:'private body must not leave metadata boundary',text:'private body'}));rows.push({...candidate('blocked'),status:'excluded'});await writeFile(policyPath,JSON.stringify({version:1,sources:rows}));const batches=[];
 const result=await screenSourceMetadata({policyPath,sourceIds:rows.map(s=>s.id),worklines:['w'],now,metadataJudge:async({sources})=>{batches.push(sources);assert.equal(JSON.stringify(sources).includes('private body'),false);return{model:'deepseek-v4-pro',decisions:sources.flatMap(s=>s.id==='g0'?[{sourceId:s.id,decision:'allow_preview',reason:'支持特定业务目标',matchedWorklines:['w']}]:s.id==='g1'?[{sourceId:s.id,decision:'irrelevant',reason:'生活事务',matchedWorklines:[]}]:s.id==='g2'?[{sourceId:s.id,decision:'allow_preview',reason:'未知目标',matchedWorklines:['unknown']}]:s.id==='g3'?[{sourceId:s.id,decision:'insufficient',reason:'泛群名无法确认',matchedWorklines:[]},{sourceId:s.id,decision:'allow_preview',reason:'重复结果',matchedWorklines:['w']}]:[{sourceId:s.id,decision:'insufficient',reason:'缺乏业务线索',matchedWorklines:[]}])};}});
 assert.deepEqual(batches.map(b=>b.length),[50,3]);assert.equal(result.status,'PARTIAL');const store=await loadAttention(policyPath);assert.deepEqual(store.sources.filter(canPreviewSource).map(s=>s.id),['g0']);assert.equal(store.sources.find(s=>s.id==='blocked').metadataGate,undefined);assert.ok(store.sources.every(s=>s.status!=='active'));
}));
test('metadata-approved keyword hit and mere business association do not become listening without model recommendation',()=>fixture(async({dir,policyPath})=>{
 const metadataJudge=async({sources})=>({decisions:sources.map(s=>({sourceId:s.id,decision:'allow_preview',reason:'具体工作协作',matchedWorklines:['w']}))});
 const receipt=await refreshSources({policyPath,config:{sources:[],worklines:['w'],keywordDiscovery:{minRequestIntervalMs:0,rules:[{workline:'w',keywords:['release']}]}},output:join(dir,'out'),now,metadataJudge,adapter:{recent:async()=>({complete:true,items:[{...candidate('broadcast'),lastActiveAt:now}]}),searchMessages:async()=>({complete:true,items:[{chatId:'broadcast',id:'k',occurredAt:now,text:'release'}]}),messages:async()=>({complete:true,status:'VERIFIED',items:[{id:'m',occurredAt:now,text:'公司公告'}]})},judge:async()=>({reason:'仅公司广播，无须持续跟进',monitoringRecommended:false,matchedWorklines:['w'],evidenceRefs:['m']})});
 const s=(await loadAttention(policyPath)).sources[0];assert.equal(s.status,'candidate');assert.equal(s.keywordEvidence.length,1);assert.equal(readPlan({sources:[s]},Date.parse(now)).length,0);assert.equal(receipt.sourceReceipts.length,0);
}));
test('legacy imported evidence and manual whitelist remain trusted; keyword-only active has deterministic migration',()=>{
 const legacy={...candidate('legacy'),status:'active',tier:'normal',decisionOrigin:'imported',matchedWorklines:['w'],evidenceRefs:['verified-message']};
 const keyword={...candidate('keyword'),status:'active',decisionOrigin:'keyword',keywordEvidence:[{messageId:'k'}],lastKeywordMatchedAt:now,keywordMatchedWorklines:['w']};
 assert.equal(isTrustedListeningSource(legacy),true);assert.equal(isTrustedListeningSource({...legacy,evidenceRefs:[]}),false);assert.equal(demoteKeywordOnlySource(legacy,now),legacy);assert.equal(demoteKeywordOnlySource(keyword,now).status,'candidate');assert.equal(readPlan({sources:[legacy,keyword]},Date.parse(now)).length,1);
 assert.equal(demoteKeywordOnlySource({...keyword,manualOverride:true},now).status,'active');assert.equal(isTrustedListeningSource({...legacy,status:'excluded',manualOverride:true}),false);
});
test('failed metadata call blocks new bodies; exclusion during metadata call wins over a positive model answer',()=>fixture(async({policyPath})=>{
 await writeFile(policyPath,JSON.stringify({version:1,sources:[candidate('a')]}));await screenSourceMetadata({policyPath,sourceIds:['a'],worklines:['w'],now,metadataJudge:async()=>{throw Error('provider unavailable');}});assert.equal(canPreviewSource((await loadAttention(policyPath)).sources[0]),false);
 await screenSourceMetadata({policyPath,sourceIds:['a'],worklines:['w'],now:'2026-10-16T08:00:00Z',metadataJudge:async()=>{await saveChange(policyPath,'a','exclude');return{decisions:[{sourceId:'a',decision:'allow_preview',reason:'业务关联',matchedWorklines:['w']}]};}});assert.equal((await loadAttention(policyPath)).sources[0].status,'excluded');assert.equal(canPreviewSource((await loadAttention(policyPath)).sources[0]),false);
}));
test('resume-only keeps its unauthorized pending cursor and never searches candidate bodies',()=>fixture(async({policyPath})=>{
 const config={sources:[],worklines:['w'],keywordDiscovery:{minRequestIntervalMs:0,rules:[{workline:'w',keywords:['release']}]}};const row={...candidate('a'),lastActiveAt:now};
 const metadataJudge=async()=>({decisions:[{sourceId:'a',decision:'allow_preview',reason:'明确业务元数据',matchedWorklines:['w']}]});
 const first=await discoverGroupKeywords({policyPath,config,now,metadataJudge,adapter:{recent:async()=>({complete:true,items:[row]}),searchMessages:async()=>({complete:false,nextPageToken:'p2',items:[]})},limits:{maxSearchPages:1}});
 const nextNow='2026-10-16T08:00:00Z';let searches=0;
 const second=await discoverGroupKeywords({policyPath,config:{...config,keywordDiscovery:{...config.keywordDiscovery,resumeOnly:true,targetWindow:first.window}},now:nextNow,adapter:{recent:async()=>({complete:true,items:[{...row,lastActiveAt:nextNow}]}),searchMessages:async()=>{searches++;throw Error('must not search');}}});
 assert.equal(searches,0);assert.equal(second.pendingJobs,1);assert.equal((await loadAttention(policyPath)).keywordDiscovery.jobs[0].pageToken,'p2');
}));
test('metadata judge defaults to DeepSeek Pro and explicitly does not imply a message-backed verdict',async()=>{
 let sent;const judge=createMetadataJudge({modelCall:async input=>{sent=input;return{decisions:[]};}});await judge({sources:[{id:'u',name:'公司大群',kind:'group'}],worklines:['w']});assert.equal(sent.model,'deepseek-v4-pro');assert.equal(sent.stage,'source_metadata_gate');assert.match(sent.messages[0].content,/insufficient/);assert.match(sent.messages[0].content,/没有消息正文/);
});

test('malformed model decisions persist failure and do not crash the gate',()=>fixture(async({policyPath})=>{
 await writeFile(policyPath,JSON.stringify({version:1,sources:[candidate('a')]}));
 const result=await screenSourceMetadata({policyPath,sourceIds:['a'],worklines:['w'],now,metadataJudge:async()=>({decisions:{}})});
 const row=(await loadAttention(policyPath)).sources[0];assert.equal(result.status,'PARTIAL');assert.equal(row.metadataGate.status,'FAILED');assert.equal(row.metadataGate.promptVersion,'source-metadata-v1');assert.equal(canPreviewSource(row),false);
}));
test('a delayed old allow cannot overwrite a newer deny',()=>fixture(async({policyPath})=>{
 await writeFile(policyPath,JSON.stringify({version:1,sources:[candidate('a')]}));let release,started;
 const ready=new Promise(r=>started=r),blocked=new Promise(r=>release=r);
 const old=screenSourceMetadata({policyPath,sourceIds:['a'],worklines:['w'],now,metadataJudge:async()=>{started();await blocked;return{decisions:[{sourceId:'a',decision:'allow_preview',reason:'旧关联',matchedWorklines:['w']}]};}});
 await ready;await screenSourceMetadata({policyPath,sourceIds:['a'],worklines:['w'],now:'2026-10-15T09:00:00Z',metadataJudge:async()=>({decisions:[{sourceId:'a',decision:'irrelevant',reason:'新业务判断',matchedWorklines:[]}]})});
 release();await old;const row=(await loadAttention(policyPath)).sources[0];assert.equal(row.metadataGate.decision,'irrelevant');assert.equal(row.metadataGate.evaluatedAt,'2026-10-15T09:00:00Z');assert.equal(canPreviewSource(row),false);
}));
