import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {discoverGroupKeywords as runDiscovery,keywordRules} from '../group-keyword-discovery.mjs';
import {loadAttention,readPlan,saveChange} from '../source-attention.mjs';
import {refreshSources as runRefreshSources} from '../source-refresh.mjs';
const metadataJudge=async({sources,worklines})=>({decisions:sources.map(s=>({sourceId:s.id,decision:'allow_preview',reason:'已提供具体业务协作元数据',matchedWorklines:worklines.length?worklines:['w']}))});
const discoverGroupKeywords=options=>runDiscovery({metadataJudge,...options});
const refreshSources=options=>runRefreshSources({metadataJudge,...options});
const now='2026-10-15T08:00:00Z';
const row=id=>({id,chatId:id,kind:'group',name:id,lastActiveAt:now});
const config={sources:[],worklines:['mobile'],keywordDiscovery:{minRequestIntervalMs:0,rules:[{workline:'mobile',keywords:['applink']}]}};
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'keyword-'));const policyPath=join(dir,'policy.json');await writeFile(policyPath,JSON.stringify({version:1,sources:[]}));try{await fn({dir,policyPath});}finally{await rm(dir,{recursive:true});}}
const message=(chatId,id='m')=>({chatId,id,occurredAt:now,text:'applink业务讨论'});
test('auditable terms reject generic keywords and do not manufacture terms from workline titles',()=>{assert.deepEqual(keywordRules({rules:[{workline:'mobile',keywords:['成本','项目',' a ','applink','applink']}]}),[{workline:'mobile',keyword:'applink'}]);});
test('keyword recall is independent of the 24-source semantic budget, keyword hits remain candidate until semantic monitoring admission',async()=>fixture(async({dir,policyPath})=>{
 const groups=Array.from({length:61},(_,i)=>row('g'+i)),queries=[];let judges=0;
 const adapter={recent:async()=>({complete:true,items:groups}),searchMessages:async job=>{queries.push(job);return{items:job.chatIds.map(id=>message(id)),complete:true};},messages:async()=>({items:[],status:'VERIFIED',complete:true})};
 const receipt=await refreshSources({policyPath,config,output:join(dir,'out'),adapter,judge:async()=>{judges++;throw Error('provider unavailable');},now,limits:{maxPreviews:2}});
 const sources=(await loadAttention(policyPath)).sources;assert.equal(queries.length,2);assert.ok(queries.every(j=>j.chatIds.length<=50));assert.equal(judges,2);assert.equal(receipt.keywordDiscovery.hits.length,61);assert.equal(sources.filter(s=>s.status==='candidate').length,61);assert.equal(readPlan({sources},Date.parse(now)).length,0);assert.ok(sources.every(s=>s.effectiveEvidence===undefined&&s.matchedWorklines.length===0));
}));
test('page budget persists fixed-window cursors and resumes without pretending a full scan',async()=>fixture(async({policyPath})=>{
 const pages=[];const adapter={recent:async()=>({complete:true,items:[row('a')]}),searchMessages:async j=>{pages.push(j);return j.pageToken?{items:[message('a','m2')],complete:true}:{items:[message('a','m1')],nextPageToken:'page2',complete:false};}};
 const a=await discoverGroupKeywords({policyPath,config,adapter,now,limits:{maxSearchPages:1}});assert.equal(a.status,'PARTIAL');assert.equal(a.pendingJobs,1);
 const b=await discoverGroupKeywords({policyPath,config,adapter,now:'2026-10-15T09:00:00Z',limits:{maxSearchPages:1}});assert.equal(b.status,'PARTIAL');assert.equal(b.needsNewWindow,true);assert.equal(b.resumed,true);assert.equal(b.hits.length,2);assert.equal(pages[1].pageToken,'page2');assert.equal(pages[1].endAt,now);
 const source=(await loadAttention(policyPath)).sources[0];assert.equal(source.lastKeywordMatchedAt,now);assert.equal(source.keywordEvidence.length,2);
}));
test('failed search retains pending work and never demotes sources or invents an empty result',async()=>fixture(async({policyPath})=>{
 await writeFile(policyPath,JSON.stringify({version:1,sources:[{...row('a'),status:'active',tier:'normal',manualOverride:false,matchedWorklines:['w'],reason:'established'}]}));
 const result=await discoverGroupKeywords({policyPath,config,adapter:{recent:async()=>({complete:true,items:[row('a')]}),searchMessages:async()=>{throw Error('HTTP503');}},now});assert.equal(result.status,'PARTIAL');assert.equal(result.pendingJobs,1);assert.equal(result.failures[0].reason,'HTTP503');assert.equal((await loadAttention(policyPath)).sources[0].tier,'normal');
}));
test('manual decisions and exclusions win before request and during return; cross-source leakage is dropped',async()=>fixture(async({policyPath})=>{
 await writeFile(policyPath,JSON.stringify({version:1,sources:[{...row('blocked'),status:'excluded',tier:'on_match',manualOverride:true,matchedWorklines:[]},{...row('manual'),status:'candidate',tier:'normal',manualOverride:true,matchedWorklines:[],reason:'manual'}]}));
 const result=await discoverGroupKeywords({policyPath,config,adapter:{recent:async()=>({complete:true,items:[row('blocked'),row('a'),row('manual')]}),searchMessages:async j=>{assert.equal(j.chatIds.includes('blocked'),false);await saveChange(policyPath,'a','exclude');return{items:[message('blocked'),message('a'),message('manual'),message('unrequested')],complete:true};}},now});
 assert.deepEqual(result.hits.map(h=>h.sourceId),['manual']);const sources=(await loadAttention(policyPath)).sources;assert.equal(sources.find(s=>s.id==='a').status,'excluded');assert.equal(sources.find(s=>s.id==='manual').status,'candidate');assert.equal(sources.find(s=>s.id==='manual').tier,'normal');assert.equal(sources.find(s=>s.id==='manual').reason,'manual');
}));
test('old hits cannot renew a lease to scan time and truncated metadata cannot claim completion',async()=>fixture(async({policyPath})=>{
 const old='2026-10-10T08:00:00Z';const receipt=await discoverGroupKeywords({policyPath,config,adapter:{recent:async()=>({complete:false,items:[row('a')]}),searchMessages:async()=>({items:[{...message('a'),occurredAt:old}],complete:true})},now});assert.equal(receipt.status,'PARTIAL');const s=(await loadAttention(policyPath)).sources[0];assert.equal(s.lastKeywordMatchedAt,old);assert.equal(s.status,'candidate');assert.equal(readPlan({sources:[s]},Date.parse(now)).length,0);
}));
test('new direct contacts are discovered across seven days with at most three days of preview',async()=>fixture(async({dir,policyPath})=>{
 let previewStart;const receipt=await refreshSources({policyPath,config:{sources:[],worklines:['w']},output:join(dir,'out'),now,adapter:{recent:async()=>({complete:true,items:[{...row('d'),kind:'direct',lastActiveAt:'2026-10-12T08:00:00Z'}]}),messages:async(s,o)=>{previewStart=o.startAt;return{items:[],status:'VERIFIED',complete:true};}},judge:async()=>({matchedWorklines:[],evidenceRefs:[],reason:'未见业务信息'})});assert.equal(receipt.selectedCount,1);assert.equal(previewStart,'2026-10-12T08:00:00.000Z');assert.equal((await loadAttention(policyPath)).sources[0].status,'candidate');
}));

test('one permanently forbidden keyword does not block other jobs or retry itself within the run',async()=>fixture(async({policyPath})=>{
 const calls=[],cfg={...config,keywordDiscovery:{...config.keywordDiscovery,rules:[{workline:'mobile',keywords:['blocked-term','applink']}]}};
 const result=await discoverGroupKeywords({policyPath,config:cfg,adapter:{recent:async()=>({complete:true,items:[row('a')]}),searchMessages:async job=>{calls.push(job.keyword);if(job.keyword==='blocked-term')throw Object.assign(Error('forbidden'),{code:'WPS_HTTP_403'});return{items:[message('a')],complete:true};}},now});
 assert.deepEqual(calls,['blocked-term','applink']);assert.equal(result.status,'PARTIAL');assert.equal(result.pendingJobs,0);assert.equal(result.unresolvedJobs,1);assert.equal(result.hits.length,1);const state=(await loadAttention(policyPath)).keywordDiscovery;assert.equal(state.status,'PARTIAL');assert.equal(state.failures[0].reason,'WPS_HTTP_403');
}));
test('global 429 stops this run and persists provider cooldown without hammering later jobs',async()=>fixture(async({policyPath})=>{
 let calls=0;const cfg={...config,keywordDiscovery:{...config.keywordDiscovery,rules:[{workline:'mobile',keywords:['limited-term','applink']}]}};
 const adapter={recent:async()=>({complete:true,items:[row('a')]}),searchMessages:async()=>{calls++;throw Object.assign(Error('limited'),{code:'WPS_HTTP_429',retryAfterMs:120000});}};
 const first=await discoverGroupKeywords({policyPath,config:cfg,adapter,now});assert.equal(calls,1);assert.equal(first.pendingJobs,2);assert.equal(first.retryAfterUntil,'2026-10-15T08:02:00.000Z');
 const second=await discoverGroupKeywords({policyPath,config:cfg,adapter,now:'2026-10-15T08:00:30Z'});assert.equal(calls,1);assert.equal(second.reason,'SEARCH_RATE_LIMIT_COOLDOWN');assert.equal(second.status,'PARTIAL');
}));
test('empty jobs do not erase incomplete metadata on persisted state or on same-window replay',async()=>fixture(async({policyPath})=>{
 let complete=false;const adapter={recent:async()=>({complete,items:[row('a')]}),searchMessages:async()=>({items:[],complete:true})};
 await discoverGroupKeywords({policyPath,config,adapter,now});let state=(await loadAttention(policyPath)).keywordDiscovery;assert.equal(state.jobs.length,0);assert.equal(state.metadataComplete,false);assert.equal(state.status,'PARTIAL');
 complete=true;const replay=await discoverGroupKeywords({policyPath,config,adapter,now});state=(await loadAttention(policyPath)).keywordDiscovery;assert.equal(replay.status,'PARTIAL');assert.equal(state.metadataComplete,false);
}));
test('alive or unknown lock owners remain busy, a confirmed exited owner is recovered',async()=>fixture(async({policyPath})=>{
 const lock=policyPath+'.keyword-discovery.lock';await mkdir(lock);const adapter={recent:async()=>({complete:true,items:[]})};
 assert.equal((await discoverGroupKeywords({policyPath,config,adapter,now})).reason,'DISCOVERY_BUSY');
 await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid,token:'alive'}));assert.equal((await discoverGroupKeywords({policyPath,config,adapter,now})).reason,'DISCOVERY_BUSY');
 const {spawn}=await import('node:child_process');const child=spawn(process.execPath,['-e','process.exit(0)']);await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 await writeFile(join(lock,'owner.json'),JSON.stringify({pid:child.pid,token:'dead'}));const recovered=await discoverGroupKeywords({policyPath,config,adapter,now});assert.equal(recovered.status,'VERIFIED');await assert.rejects(readFile(join(lock,'owner.json')),{code:'ENOENT'});
}));

test('quarantined 403 does not pin subsequent daily scans to the old window or hide unchecked work',async()=>fixture(async({policyPath})=>{
 const cfg={...config,keywordDiscovery:{...config.keywordDiscovery,rules:[{workline:'mobile',keywords:['blocked-term','applink']}]}};let current=now;const calls=[];
 const adapter={recent:async()=>({complete:true,items:[{...row('a'),lastActiveAt:current},...(current!==now?[{...row('new-group'),lastActiveAt:current}]:[])]}),searchMessages:async job=>{calls.push({keyword:job.keyword,endAt:job.endAt,chatIds:job.chatIds});if(job.keyword==='blocked-term')throw Object.assign(Error('forbidden'),{code:'WPS_HTTP_403'});return{items:job.chatIds.map(id=>({...message(id),occurredAt:current})),complete:true};}};
 const first=await discoverGroupKeywords({policyPath,config:cfg,adapter,now:current});assert.equal(first.status,'PARTIAL');assert.equal(first.pendingJobs,0);assert.equal(first.quarantinedJobs.length,1);assert.equal(first.quarantinedJobs[0].pageToken,null);assert.equal(first.quarantinedJobs[0].endAt,now);
 current='2026-10-16T08:00:00Z';const second=await discoverGroupKeywords({policyPath,config:cfg,adapter,now:current});assert.equal(second.resumed,false);assert.equal(second.window.endAt,current);assert.equal(second.pendingJobs,0);assert.ok(second.hits.some(hit=>hit.sourceId==='new-group'));assert.ok(calls.some(call=>call.endAt===current&&call.chatIds.includes('new-group')));assert.equal(second.quarantinedJobs.length,2);assert.equal(second.status,'PARTIAL');
}));
test('temporary job failures get one cross-run retry before quarantine, while later windows can retry afresh',async()=>fixture(async({policyPath})=>{
 let requests=0;const adapter={recent:async()=>({complete:true,items:[row('a')]}),searchMessages:async()=>{requests++;throw Object.assign(Error('temporary'),{code:'WPS_HTTP_503'});}};
 const first=await discoverGroupKeywords({policyPath,config,adapter,now});assert.equal(first.pendingJobs,1);assert.equal(first.quarantinedJobs.length,0);assert.equal(requests,1);
 const second=await discoverGroupKeywords({policyPath,config,adapter,now:'2026-10-15T09:00:00Z'});assert.equal(second.pendingJobs,0);assert.equal(second.quarantinedJobs.length,1);assert.equal(second.quarantinedJobs[0].failureAttempts,2);assert.equal(requests,2);
 const third=await discoverGroupKeywords({policyPath,config,adapter,now:'2026-10-16T08:00:00Z'});assert.equal(third.resumed,false);assert.equal(third.pendingJobs,1);assert.equal(requests,3);assert.equal(third.quarantinedJobs.length,1);
}));

test('resume-only stops on an empty target queue without requesting metadata or creating a new window',async()=>fixture(async({policyPath})=>{
 const targetWindow={startAt:'2026-10-08T08:00:00.000Z',endAt:now};
 const initial={version:1,sources:[],keywordDiscovery:{...targetWindow,jobs:[],metadataComplete:true,status:'PARTIAL'}};
 await writeFile(policyPath,JSON.stringify(initial));const before=await readFile(policyPath,'utf8');
 const noRequest=async()=>{assert.fail('resume-only must not request completed work');};
 const result=await discoverGroupKeywords({policyPath,config:{...config,keywordDiscovery:{...config.keywordDiscovery,resumeOnly:true,targetWindow}},adapter:{recent:noRequest,searchMessages:noRequest},now:'2026-10-16T08:00:00Z'});
 assert.equal(result.status,'NO_PENDING');assert.equal(result.pendingJobs,0);assert.equal(result.metadataRequested,false);assert.equal(await readFile(policyPath,'utf8'),before);
}));

test('resume-only refuses a replaced window before requesting metadata or changing sources',async()=>fixture(async({policyPath})=>{
 const targetWindow={startAt:'2026-10-08T08:00:00.000Z',endAt:now};
 const initial={version:1,sources:[{...row('a'),status:'candidate',tier:'on_match',manualOverride:false,matchedWorklines:[]}],keywordDiscovery:{startAt:'2026-10-09T08:00:00.000Z',endAt:'2026-10-16T08:00:00Z',jobs:[{keyword:'applink',workline:'mobile',chatIds:['a'],pageToken:'p2'}]}};
 await writeFile(policyPath,JSON.stringify(initial));const before=await readFile(policyPath,'utf8');
 const noRequest=async()=>{assert.fail('resume-only must not request a replacement window');};
 const result=await discoverGroupKeywords({policyPath,config:{...config,keywordDiscovery:{...config.keywordDiscovery,resumeOnly:true,targetWindow}},adapter:{recent:noRequest,searchMessages:noRequest},now:'2026-10-16T09:00:00Z'});
 assert.equal(result.status,'WINDOW_REPLACED');assert.equal(result.pendingJobs,1);assert.equal(result.metadataRequested,false);assert.equal(await readFile(policyPath,'utf8'),before);
}));
