import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {refreshSources as runRefreshSources,decideSource} from '../source-refresh.mjs';import {saveChange,loadAttention,readPlan} from '../source-attention.mjs';
const metadataJudge=async({sources,worklines})=>({decisions:sources.map(s=>({sourceId:s.id,decision:'allow_preview',reason:'具体业务协作元数据',matchedWorklines:worklines.slice(0,1)}))});
const refreshSources=options=>runRefreshSources({metadataJudge,...options});
const source={decisionOrigin:'imported',evidenceRefs:['old-evidence'],id:'s1',name:'work',kind:'group',tier:'normal',status:'active',manualOverride:false,matchedWorklines:['w'],lastActiveAt:'2026-09-01T00:00:00Z',history:[]};
const now='2026-10-14T08:00:00Z';
test('decay is gradual, failed observations cannot demote and replay is idempotent',()=>{const o={status:'VERIFIED',complete:true,hash:'a',reason:'窗口没有相关信号',matchedWorklines:[]};assert.equal(decideSource(source,{...o,status:'FAILED'},now),source);const next=decideSource({...source,firstReviewedAt:'2026-09-01T00:00:00Z'},o,now);assert.equal(next.tier,'on_match');assert.equal(decideSource(next,o,now),next);assert.equal(decideSource({...source,manualOverride:true},o,now).tier,'normal');});
test('old matched evidence cannot extend on-match lease by fresh evaluation time',()=>{assert.equal(readPlan({sources:[{...source,tier:'on_match',lastMatchedAt:'2026-10-01T00:00:00Z',lastEvaluatedAt:now}]},Date.parse(now)).length,0);});
test('refresh discovers group and direct, respects concurrent exclusion and advances only successful source cursors',async()=>{const dir=await mkdtemp(join(tmpdir(),'refresh-'));try{const path=join(dir,'policy.json');await writeFile(path,JSON.stringify({version:1,sources:[source,{...source,id:'blocked',status:'excluded',manualOverride:true}]}));const calls=[];
 const adapter={recent:async()=>({complete:true,items:[{id:'s1',chatId:'one',kind:'group',name:'work',lastActiveAt:now},{id:'new',chatId:'two',kind:'direct',name:'new contact',lastActiveAt:now},{id:'blocked',chatId:'three',kind:'group',name:'excluded',lastActiveAt:now}]}),messages:async(r,opts)=>{calls.push(r.id);if(r.id==='blocked')throw Error('must not read');if(opts.order==='asc'&&r.id==='s1')return{status:'FAILED',complete:false,items:[]};return{status:'VERIFIED',complete:true,items:[{id:'m1',occurredAt:'2026-10-14T07:00:00Z',text:'work'}]};}};
 const judge=async({source:r})=>{if(r.id==='new')await saveChange(path,'s1','exclude');return{monitoringRecommended:true,matchedWorklines:['w'],reason:'明确工作关联',evidenceRefs:['m1'],directResponsibility:true};};
 const receipt=await refreshSources({policyPath:path,config:{sources:[{source_key:'s1',chat_id:'one'}],worklines:['w'],fixed_cutoff:'2026-10-14T06:00:00Z'},output:join(dir,'out'),adapter,judge,now});const policy=await loadAttention(path);assert.equal(policy.sources.find(s=>s.id==='s1').status,'excluded');assert.equal(policy.sources.find(s=>s.id==='s1').lastReadThrough,undefined);assert.equal(policy.sources.find(s=>s.id==='new').lastReadThrough,now);assert.equal(calls.includes('blocked'),false);assert.equal(receipt.evidenceCount,1);assert.equal(JSON.parse(await readFile(join(dir,'out/preview-evidence.json'))).some(p=>p.source.id==='s1'),false);
 }finally{await rm(dir,{recursive:true});}});
test('concurrent writers preserve both manual controls',async()=>{const dir=await mkdtemp(join(tmpdir(),'locking-'));try{const p=join(dir,'p.json');await writeFile(p,JSON.stringify({version:1,sources:[source,{...source,id:'s2'}]}));await Promise.all([saveChange(p,'s1','exclude'),saveChange(p,'s2','set_tier','priority')]);const d=await loadAttention(p);assert.equal(d.sources[0].status,'excluded');assert.equal(d.sources[1].tier,'priority');}finally{await rm(dir,{recursive:true});}});
test('manual on-match keeps tier while fresh trusted evidence refreshes its lease',()=>{const s={...source,tier:'on_match',manualOverride:true,lastMatchedAt:'2026-10-01T00:00:00Z'};const n=decideSource(s,{status:'VERIFIED',complete:true,hash:'new',reason:'新行动',matchedWorklines:['w'],evidenceRefs:['m'],lastMatchedAt:now,directResponsibility:true},now);assert.equal(n.tier,'on_match');assert.equal(n.manualOverride,true);assert.equal(readPlan({sources:[n]},Date.parse(now)).length,1);});
test('new source gets reserved preview even when known registry exceeds budget',async()=>{const dir=await mkdtemp(join(tmpdir(),'reserve-'));try{const path=join(dir,'p.json');const known=Array.from({length:25},(_,i)=>({...source,id:'k'+i,chatId:'k'+i,lastEvaluatedAt:'2026-10-13T08:00:00Z'}));await writeFile(path,JSON.stringify({version:1,sources:known}));const preview=[];await refreshSources({policyPath:path,config:{sources:[],worklines:['w']},output:join(dir,'out'),now,limits:{maxPreviews:2},adapter:{recent:async()=>({complete:true,items:[...known.map(s=>({...s,lastActiveAt:now})),{id:'new',chatId:'new',name:'new',kind:'group',lastActiveAt:now}]}),messages:async(s,o)=>{if(o.order==='desc')preview.push(s.id);return{status:'VERIFIED',complete:true,items:[]};}},judge:async()=>({reason:'没有相关活动',matchedWorklines:[],evidenceRefs:[]})});assert.equal(preview.includes('new'),true);assert.equal(preview.some(id=>id.startsWith('k')),true);assert.equal(preview.length,2);}finally{await rm(dir,{recursive:true});}});
test('failure in preview is PARTIAL and keeps original cursor and tier',async()=>{const dir=await mkdtemp(join(tmpdir(),'failure-'));try{const path=join(dir,'p.json');await writeFile(path,JSON.stringify({version:1,sources:[source]}));const receipt=await refreshSources({policyPath:path,config:{sources:[{source_key:'s1',chat_id:'one'}],worklines:['w'],fixed_cutoff:'2026-10-14T07:00:00Z'},output:join(dir,'out'),now,adapter:{recent:async()=>({complete:true,items:[{...source,chatId:'one',lastActiveAt:now}]}),messages:async()=>({status:'FAILED',complete:false,items:[]})},judge:async()=>{throw Error('must not judge');}});assert.equal(receipt.status,'PARTIAL');assert.equal(receipt.observations[0].stage,'preview');const s=(await loadAttention(path)).sources[0];assert.equal(s.lastReadThrough,undefined);assert.equal(s.tier,'normal');}finally{await rm(dir,{recursive:true});}});

test('evidence persistence failure leaves source cursor unchanged',async()=>{const dir=await mkdtemp(join(tmpdir(),'durable-'));try{const path=join(dir,'p.json'),out=join(dir,'out');await writeFile(path,JSON.stringify({version:1,sources:[source]}));await mkdir(join(out,'refresh-evidence.json'),{recursive:true});await assert.rejects(refreshSources({policyPath:path,config:{sources:[{source_key:'s1',chat_id:'one'}],worklines:['w'],fixed_cutoff:'2026-10-14T07:00:00Z'},output:out,now,adapter:{recent:async()=>({complete:true,items:[{...source,chatId:'one',lastActiveAt:now}]}),messages:async()=>({status:'VERIFIED',complete:true,items:[]})},judge:async()=>({reason:'本窗口无相关活动',matchedWorklines:[],evidenceRefs:[]})}));assert.equal((await loadAttention(path)).sources[0].lastReadThrough,undefined);}finally{await rm(dir,{recursive:true});}});
test('unmatched new observation is separate from retained attention reason',()=>{const s={...source,lastActiveAt:now,reason:'已建立的业务关联'};const n=decideSource(s,{status:'VERIFIED',complete:true,hash:'no-match',reason:'本次未命中',matchedWorklines:[]},now);assert.equal(n.reason,'已建立的业务关联');assert.equal(n.lastAssessmentReason,'本次未命中');});

test('rolling evidence accumulates independent days, deduplicates content and rejects future evidence',()=>{
 let s={...source,tier:'on_match',status:'candidate'};
 const observe=(id,time,text='unique '+id)=>({status:'VERIFIED',complete:true,hash:id+time,reason:'业务相关',matchedWorklines:['w'],evidenceRefs:[id],effectiveEvidence:[{messageId:id,contentHash:text,occurredAt:time,worklines:['w']}]});
 for(let i=1;i<=3;i++)s=decideSource(s,observe('m'+i,`2026-10-${10+i}T07:00:00Z`),`2026-10-${10+i}T08:00:00Z`);
 assert.equal(s.tier,'normal');assert.equal(s.effectiveSignalDays,3);
 const replay=decideSource(s,observe('forwarded','2026-10-14T07:00:00Z','unique m1'),now);
 assert.equal(replay.effectiveSignalDays,3);assert.equal(Date.parse(replay.lastMatchedAt),Date.parse('2026-10-13T07:00:00Z'));
 const future=decideSource(s,observe('future','2026-10-15T07:00:00Z'),now);
 assert.equal(future.effectiveSignalDays,3);assert.equal(future.lastMatchedAt,s.lastMatchedAt);
});
test('legacy decay starts on complete re-review and ignores noisy activity, then exits gradually',()=>{
 const o={status:'VERIFIED',complete:true,hash:'quiet1',reason:'本窗口无相关业务信息',matchedWorklines:[]};
 const first=decideSource({...source,lastActiveAt:now},o,now);assert.equal(first.tier,'normal');assert.equal(first.firstReviewedAt,now);
 const truncated=decideSource(first,{...o,hash:'partial',complete:false},'2026-11-01T08:00:00Z');assert.equal(truncated,first);
 const second=decideSource({...first,lastActiveAt:'2026-10-29T08:00:00Z'},{...o,hash:'quiet2'},'2026-10-29T08:00:00Z');assert.equal(second.tier,'on_match');
 const third=decideSource(second,{...o,hash:'quiet3'},'2026-11-06T08:00:00Z');assert.equal(third.status,'candidate');
});
test('all discovered metadata is durable and an unchecked candidate survives busy newer sources',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'queue-'));try{const path=join(dir,'p.json');await writeFile(path,JSON.stringify({version:1,sources:[]}));let batch=0;const previews=[];
 const adapter={recent:async()=>({complete:true,items:(batch?['a','d','e']:['a','b','c']).map(id=>({id,chatId:id,kind:'group',name:id,lastActiveAt:now}))}),messages:async(s,o)=>{if(o.order==='desc')previews.push(s.id);return {status:'VERIFIED',complete:true,items:[]};}};
 const config={sources:[],worklines:['w']},judge=async()=>({reason:'没有业务信息',matchedWorklines:[],evidenceRefs:[]});
 await refreshSources({policyPath:path,config,output:join(dir,'one'),adapter,judge,now,limits:{maxPreviews:1}});
 assert.equal((await loadAttention(path)).sources.length,3);assert.deepEqual(previews,['a']);batch=1;
 await refreshSources({policyPath:path,config,output:join(dir,'two'),adapter,judge,now:'2026-10-15T08:00:00Z',limits:{maxPreviews:1}});
 assert.equal((await loadAttention(path)).sources.length,5);assert.equal(previews[1],'b');
 }finally{await rm(dir,{recursive:true});}
});
test('workline discovery receives batch before source judgment and exclusion applies across hook',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'workline-hook-'));try{const path=join(dir,'p.json');await writeFile(path,JSON.stringify({version:1,sources:[{...source,chatId:'one'}]}));let called=false;
 const receipt=await refreshSources({policyPath:path,config:{sources:[],worklines:['w']},output:join(dir,'out'),now,adapter:{recent:async()=>({complete:true,items:[]}),messages:async()=>({status:'VERIFIED',complete:true,items:[{id:'x',occurredAt:now,text:'new objective'}]})},discoverWorklines:async x=>{assert.equal(x.sources.length,1);called=true;await saveChange(path,'s1','exclude');return{expandedWorklines:['new workline'],receipt:{status:'VERIFIED'}};},judge:async()=>{throw Error('excluded after hook must not judge');}});
 assert.equal(called,true);assert.equal(receipt.observations.length,0);assert.equal((await loadAttention(path)).sources[0].status,'excluded');
 }finally{await rm(dir,{recursive:true});}
});
test('reading plan puts priority before normal regardless of registry order',()=>{
 const plan=readPlan({sources:[source,{...source,id:'urgent',tier:'priority'},{...source,id:'late',tier:'on_match',lastMatchedAt:now}]},Date.parse(now));
 assert.deepEqual(plan.map(s=>s.sourceKey),['urgent','s1','late']);
});
test('future message timestamps do not demote sources or advance successful cursors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'future-'));try{const path=join(dir,'p.json');await writeFile(path,JSON.stringify({version:1,sources:[{...source,chatId:'one',firstReviewedAt:'2026-09-01T00:00:00Z'}]}));
 const receipt=await refreshSources({policyPath:path,config:{sources:[],worklines:['w']},output:join(dir,'out'),now,adapter:{recent:async()=>({complete:true,items:[]}),messages:async()=>({status:'VERIFIED',complete:true,items:[{id:'future',occurredAt:'2026-10-15T00:00:00Z',text:'later'}]})},judge:async({messages})=>{assert.equal(messages.length,0);return{reason:'无可用证据',matchedWorklines:[],evidenceRefs:[]};}});
 const s=(await loadAttention(path)).sources[0];assert.equal(s.tier,'normal');assert.equal(s.lastReadThrough,undefined);assert.equal(receipt.status,'PARTIAL');assert.equal(receipt.evidenceCount,0);
 }finally{await rm(dir,{recursive:true});}
});

test('bounded PARTIAL adapter previews support positive evidence but never negative demotion',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bounded-preview-'));try{const path=join(dir,'p.json');const legacy={...source,id:'quiet',chatId:'quiet',firstReviewedAt:'2026-09-01T00:00:00Z'};await writeFile(path,JSON.stringify({version:1,sources:[legacy]}));let discovered=[];const judged=[];
 const receipt=await refreshSources({policyPath:path,config:{sources:[],worklines:['w']},output:join(dir,'out'),now,adapter:{recent:async()=>({complete:true,items:[{id:'new',chatId:'new',kind:'group',name:'busy',lastActiveAt:now}]}),messages:async(s,o)=>o.order==='desc'?{status:'PARTIAL',complete:false,items:[{id:'m-'+s.id,occurredAt:now,text:s.id+' substantive context'}]}:{status:'VERIFIED',complete:true,items:[]}},discoverWorklines:async({sources})=>{discovered=sources.map(s=>s.source.id);return{expandedWorklines:['w'],receipt:{status:'VERIFIED'}};},judge:async({source:s})=>{judged.push(s.id);return s.id==='new'?{monitoringRecommended:true,reason:'明确本人行动',matchedWorklines:['w'],evidenceRefs:['m-new'],directResponsibility:true}:{reason:'窗口中暂无相关信息',matchedWorklines:[],evidenceRefs:[]};}});
 assert.deepEqual(discovered.sort(),['new','quiet']);assert.deepEqual(judged.sort(),['new','quiet']);const store=await loadAttention(path);assert.equal(store.sources.find(s=>s.id==='new').tier,'priority');assert.equal(store.sources.find(s=>s.id==='quiet').tier,'normal');assert.equal(receipt.observations.find(o=>o.id==='quiet').complete,false);
 }finally{await rm(dir,{recursive:true});}
});
test('nested workline discovery FAILED and PARTIAL statuses propagate to overall receipt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nested-discovery-'));try{const path=join(dir,'p.json');await writeFile(path,JSON.stringify({version:1,sources:[]}));
 for(const status of ['FAILED','PARTIAL','NOT_RUN']){
 const receipt=await refreshSources({policyPath:path,config:{sources:[],worklines:['w']},output:join(dir,status),now,adapter:{recent:async()=>({complete:true,items:[]})},discoverWorklines:async()=>({expandedWorklines:['w'],receipt:{status}}),judge:async()=>{throw Error('no sources');}});
 assert.equal(receipt.status,status==='NOT_RUN'?'VERIFIED':'PARTIAL');}
 }finally{await rm(dir,{recursive:true});}
});
test('unsupported model positives fail rather than becoming quiet negative judgments',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'unsupported-positive-'));try{const path=join(dir,'p.json');const variants=[
 {matchedWorklines:['w'],evidenceRefs:['hallucinated']},
 {matchedWorklines:['unknown-workline'],evidenceRefs:['m1']},
 {matchedWorklines:['w'],evidenceRefs:[]},
 {matchedWorklines:[],evidenceRefs:[],directResponsibility:true},
 {matchedWorklines:[],evidenceRefs:[],blockingDecision:true},
 {matchedWorklines:'w',evidenceRefs:['m1']},
 {matchedWorklines:[],evidenceRefs:'m1'}
 ];
 for(const [i,variant]of variants.entries()){
 await writeFile(path,JSON.stringify({version:1,sources:[{...source,chatId:'one',firstReviewedAt:'2026-09-01T00:00:00Z'}]}));
 const receipt=await refreshSources({policyPath:path,config:{sources:[],worklines:['w']},output:join(dir,String(i)),now,adapter:{recent:async()=>({complete:true,items:[]}),messages:async()=>({status:'VERIFIED',complete:true,items:[{id:'m1',occurredAt:now,text:'usable context'}]})},judge:async()=>({reason:'模型声称正关联',...variant})});
 const s=(await loadAttention(path)).sources[0];assert.equal(s.tier,'normal',JSON.stringify(variant));assert.equal(s.lastEvaluatedAt,undefined);assert.equal(receipt.status,'PARTIAL');assert.equal(receipt.observations[0].status,'FAILED');assert.equal(receipt.observations[0].reason,'INVALID_JUDGMENT');
 }
 }finally{await rm(dir,{recursive:true});}
});

test('keyword recency never protects monitoring without fresh business evidence',()=>{
 const quiet={status:'VERIFIED',complete:true,hash:'new-negative',reason:'本窗口没有有效业务进展',matchedWorklines:[]};
 const base={...source,firstReviewedAt:'2026-09-01T00:00:00Z',lastMatchedAt:'2026-09-01T00:00:00Z',lastKeywordMatchedAt:now,keywordMatchedWorklines:['keyword-only']};
 assert.equal(decideSource({...base,tier:'priority'},quiet,now).tier,'normal');assert.equal(decideSource({...base,tier:'normal'},quiet,now).tier,'on_match');
 assert.equal(decideSource({...base,tier:'on_match'},quiet,now).status,'candidate');
 assert.equal(decideSource({...base,tier:'normal',manualOverride:true},quiet,now).tier,'normal');
});
