import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {loadAttention,updateAttention} from './source-attention.mjs';
import {screenSourceMetadata,canPreviewSource} from './source-metadata-gate.mjs';
export const GROUP_DISCOVERY_POLICY={recentDays:7,maxRecent:5000,maxSearchPages:100,pageSize:50,minRequestIntervalMs:250,retryCooldownMs:60000};
const DAY=86400000,hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const generic=new Set(['项目','工作','数据','成本','模型','测试','需求','进展','业务','上线','评测']);
export function keywordRules(config={}){const result=[];for(const r of config.rules||[]){if(typeof r.workline!=='string'||!r.workline.trim())continue;for(const text of r.keywords||[]){if(typeof text!=='string')continue;const keyword=text.trim();if(keyword.length<2||keyword.length>80||generic.has(keyword))continue;if(!result.some(x=>x.workline===r.workline&&x.keyword===keyword))result.push({workline:r.workline,keyword});}}return result;}
function sameWindow(state,startAt,endAt,rules){return state?.startAt===startAt&&state?.endAt===endAt&&state?.rulesHash===hash(rules);}
function liveGroups(store,chatIds){return chatIds.filter(id=>store.sources.some(s=>String(s.chatId)===id&&s.kind==='group'&&canPreviewSource(s)));}
async function runGroupKeywords({policyPath,config,adapter,now,metadata,metadataJudge,limits={}}){
 const p={...GROUP_DISCOVERY_POLICY,...config.keywordDiscovery,...limits},rules=keywordRules(p);const startAt=new Date(Date.parse(now)-p.recentDays*DAY).toISOString();
 const recent=metadata||await adapter.recent({startAt,endAt:now,maxItems:p.maxRecent});
 const initial=await loadAttention(policyPath),known=new Map(config.sources?.map(s=>[String(s.chat_id),s.source_key])||[]);for(const s of initial.sources)if(s.chatId)known.set(String(s.chatId),s.id);
 const rows=recent.items.filter((r,i,all)=>all.findIndex(x=>String(x.chatId)===String(r.chatId))===i).filter(r=>r.kind==='group'&&r.chatId&&r.lastActiveAt>=startAt&&r.lastActiveAt<=now).map(r=>({...r,chatId:String(r.chatId),id:known.get(String(r.chatId))||r.id}));
 await updateAttention(policyPath,s=>{for(const r of rows){const found=s.sources.find(x=>x.id===r.id);if(found){if(found.status!=='excluded'&&(!found.lastActiveAt||r.lastActiveAt>found.lastActiveAt))found.lastActiveAt=r.lastActiveAt;continue;}s.sources.push({id:r.id,chatId:r.chatId,name:r.name,kind:'group',tier:'on_match',status:'candidate',manualOverride:false,matchedWorklines:[],evidenceRefs:[],firstDiscoveredAt:now,lastActiveAt:r.lastActiveAt,reason:'最近7天活跃群，待关键词检索',history:[]});}return s;});
 if(!rules.length){const receipt={status:'NOT_CONFIGURED',at:now,metadataComplete:recent.complete,metadataCount:rows.length,pages:0,pendingJobs:0,hits:[],reason:'未配置有效业务关键词，未执行关键词检索'};await updateAttention(policyPath,s=>{s.keywordDiscovery={...receipt,jobs:[]};return s;});return receipt;}
 const metadataGate=await screenSourceMetadata({policyPath,sourceIds:[...rows.map(r=>r.id),...initial.sources.filter(s=>initial.keywordDiscovery?.jobs?.some(j=>j.chatIds.includes(String(s.chatId)))).map(s=>s.id)],worklines:config.worklines||[],metadataJudge,now});
 const state=(await loadAttention(policyPath)).keywordDiscovery;
 if(Date.parse(state?.retryAfterUntil)>Date.parse(now)){const receipt={status:'PARTIAL',at:now,metadataComplete:state.metadataComplete===true,latestMetadataComplete:recent.complete,metadataCount:rows.length,pages:0,pendingJobs:state.jobs?.length||0,hits:state.hits||[],reason:'SEARCH_RATE_LIMIT_COOLDOWN',retryAfterUntil:state.retryAfterUntil};await updateAttention(policyPath,s=>{if(s.keywordDiscovery){s.keywordDiscovery.status='PARTIAL';s.keywordDiscovery.at=now;s.keywordDiscovery.reason=receipt.reason;}return s;});return receipt;}
 // An unfinished fixed window is resumed before creating the next rolling seven-day scan.
 const resume=state?.jobs?.length&&state.rulesHash===hash(rules);
 let scan=resume?structuredClone(state):{version:1,startAt,endAt:now,rulesHash:hash(rules),jobs:[],hits:[],completedJobs:0,quarantinedJobs:structuredClone(state?.quarantinedJobs||[])};
 if(!resume&&!sameWindow(state,startAt,now,rules)){const gateStore=await loadAttention(policyPath);const groups=rows.filter(r=>canPreviewSource(gateStore.sources.find(s=>s.id===r.id)));for(const rule of rules)for(let i=0;i<groups.length;i+=50)scan.jobs.push({...rule,chatIds:groups.slice(i,i+50).map(g=>g.chatId),pageToken:null});}else if(!resume&&sameWindow(state,startAt,now,rules))scan=structuredClone(state);
 scan.quarantinedJobs||=[];
 scan.metadataComplete=resume||sameWindow(state,startAt,now,rules)?state.metadataComplete===true:recent.complete===true;
 scan.latestMetadataComplete=recent.complete===true;
 scan.at=now;scan.status='PARTIAL';delete scan.retryAfterUntil;delete scan.reason;
 const persist=()=>updateAttention(policyPath,s=>{const allowed=new Set(s.sources.filter(x=>x.status!=='excluded').map(x=>x.id));scan.hits=scan.hits.filter(h=>allowed.has(h.sourceId));s.keywordDiscovery=structuredClone(scan);return s;});
 await persist();let pages=0,lastRequestAt=0;const failures=[],failedJobs=new Set();
 const jobKey=job=>hash({keyword:job.keyword,workline:job.workline,chatIds:job.chatIds});
 while(scan.jobs.length&&pages<p.maxSearchPages){
  const nextIndex=scan.jobs.findIndex(job=>!failedJobs.has(jobKey(job)));if(nextIndex<0)break;
  const [job]=scan.jobs.splice(nextIndex,1),fresh=await loadAttention(policyPath),chatIds=liveGroups(fresh,job.chatIds);if(!chatIds.length){if(!job.chatIds.some(id=>fresh.sources.some(s=>String(s.chatId)===id&&s.status!=='excluded'))){scan.completedJobs++;await persist();continue;}scan.jobs.push(job);failedJobs.add(jobKey(job));continue;}
  // Changed allowlists invalidate a provider cursor; replay the still-allowed block safely.
  if(chatIds.length!==job.chatIds.length){const deferred=job.chatIds.filter(id=>!chatIds.includes(id)&&fresh.sources.some(s=>String(s.chatId)===id&&s.status!=='excluded'));if(deferred.length){const held={...job,chatIds:deferred,pageToken:null};scan.jobs.push(held);failedJobs.add(jobKey(held));}job.pageToken=null;}
  job.chatIds=chatIds;const delay=Number(p.minRequestIntervalMs)- (Date.now()-lastRequestAt);if(delay>0)await new Promise(resolve=>setTimeout(resolve,Math.min(delay,60000)));pages++;lastRequestAt=Date.now();
  try{const result=await adapter.searchMessages({...job,startAt:scan.startAt,endAt:scan.endAt,pageSize:p.pageSize});
   if(!Array.isArray(result.items)||(!result.complete&&!result.nextPageToken))throw Error('INVALID_SEARCH_PAGE');
   if(result.nextPageToken&&result.nextPageToken===job.pageToken)throw Error('REPEATED_SEARCH_CURSOR');
   const current=await loadAttention(policyPath);
   for(const message of result.items){const source=current.sources.find(s=>String(s.chatId)===String(message.chatId)&&s.kind==='group'&&s.status!=='excluded');if(!source||!chatIds.includes(String(message.chatId))||!message.id||!Number.isFinite(Date.parse(message.occurredAt))||message.occurredAt<scan.startAt||message.occurredAt>scan.endAt||!String(message.text||'').toLocaleLowerCase().includes(job.keyword.toLocaleLowerCase()))continue;
    const hit={sourceId:source.id,chatId:String(message.chatId),workline:job.workline,keyword:job.keyword,messageId:message.id,occurredAt:message.occurredAt,contentHash:hash(String(message.text))};
    if(!scan.hits.some(h=>h.sourceId===hit.sourceId&&h.messageId===hit.messageId&&h.keyword===hit.keyword&&h.workline===hit.workline))scan.hits.push(hit);
   }
   delete job.failureAttempts;
   if(result.nextPageToken)scan.jobs.push({...job,pageToken:result.nextPageToken});else scan.completedJobs++;
   await persist();
  }catch(e){
   const reason=e.code||e.message||e.name;failedJobs.add(jobKey(job));failures.push({keyword:job.keyword,workline:job.workline,chatIds:job.chatIds,reason});
   if(reason==='WPS_HTTP_429'){scan.jobs.push(job);scan.retryAfterUntil=new Date(Date.parse(now)+Math.max(Number.isFinite(e.retryAfterMs)?e.retryAfterMs:0,p.retryCooldownMs)).toISOString();await persist();break;}
   job.failureAttempts=(job.failureAttempts||0)+1;
   if(reason==='WPS_HTTP_403'||job.failureAttempts>=2)scan.quarantinedJobs.push({...job,startAt:scan.startAt,endAt:scan.endAt,status:'QUARANTINED',reason,lastFailedAt:now});
   else scan.jobs.push(job);
   await persist();
  }
 }
 scan.failures=failures;scan.pages=pages;scan.pendingJobs=scan.jobs.length;scan.needsNewWindow=scan.endAt!==now;
 scan.unresolvedJobs=scan.quarantinedJobs.filter(job=>job.startAt===scan.startAt&&job.endAt===scan.endAt).length;
 scan.status=metadataGate.status!=='VERIFIED'||!scan.metadataComplete||!recent.complete||scan.jobs.length||failures.length||scan.unresolvedJobs||scan.needsNewWindow?'PARTIAL':'VERIFIED';
 await persist();
 const applied=await updateAttention(policyPath,s=>{for(const row of s.sources){if(row.status==='excluded')continue;const hits=scan.hits.filter(h=>h.sourceId===row.id);if(!hits.length)continue;const previous=row.keywordEvidence||[];row.keywordEvidence=[...previous,...hits.map(({text,...h})=>h)].filter((h,i,a)=>Date.parse(h.occurredAt)>=Date.parse(now)-7*DAY&&a.findIndex(x=>x.messageId===h.messageId&&x.keyword===h.keyword&&x.workline===h.workline)===i);row.keywordMatchedWorklines=[...new Set(row.keywordEvidence.map(h=>h.workline))];row.lastKeywordMatchedAt=row.keywordEvidence.map(h=>h.occurredAt).sort().at(-1);row.keywordReason=`命中业务关键词：${[...new Set(hits.map(h=>h.keyword))].join('、')}；待核实主线关联`;
   // Keyword hits are recall evidence only; semantic review owns listening admission.
  }if(s.keywordDiscovery)s.keywordDiscovery.hits=s.keywordDiscovery.hits.filter(h=>s.sources.some(row=>row.id===h.sourceId&&row.status!=='excluded'));return s;});
 const allowed=new Set(applied.sources.filter(s=>s.status!=='excluded').map(s=>s.id));const hits=scan.hits.filter(h=>allowed.has(h.sourceId));
 return{status:scan.status,metadataGate,at:now,needsNewWindow:scan.endAt!==now,window:{startAt:scan.startAt,endAt:scan.endAt},resumed:!!resume,metadataComplete:scan.metadataComplete,latestMetadataComplete:recent.complete,metadataCount:rows.length,ruleCount:rules.length,pages,completedJobs:scan.completedJobs,pendingJobs:scan.jobs.length,unresolvedJobs:scan.unresolvedJobs,quarantinedJobs:scan.quarantinedJobs,failures,hits,retryAfterUntil:scan.retryAfterUntil,formalMemoryUpdated:false,semanticJudgments:false};
}
function ownerIsDead(owner){
 if(!Number.isInteger(owner?.pid)||owner.pid<=0||typeof owner.token!=='string')return false;
 try{process.kill(owner.pid,0);return false;}catch(e){return e.code==='ESRCH';}
}
async function acquireDiscoveryLock(lock){
 const owner={pid:process.pid,token:randomUUID()};
 try{await mkdir(lock,{mode:0o700});}catch(e){
  if(e.code!=='EEXIST')throw e;
  let old;try{old=JSON.parse(await readFile(join(lock,'owner.json'),'utf8'));}catch{return null;}
  if(!ownerIsDead(old))return null;
  // Only one contender can reclaim this directory, and only after rereading its dead owner.
  try{await mkdir(join(lock,'reclaim'),{mode:0o700});}catch{return null;}
  let current;try{current=JSON.parse(await readFile(join(lock,'owner.json'),'utf8'));}catch{await rm(join(lock,'reclaim'),{recursive:true,force:true});return null;}
  if(current.token!==old.token||!ownerIsDead(current)){await rm(join(lock,'reclaim'),{recursive:true,force:true});return null;}
  const stale=lock+'.stale-'+randomUUID();await rename(lock,stale);await rm(stale,{recursive:true});
  try{await mkdir(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')return null;throw e;}
 }
 try{await writeFile(join(lock,'owner.json'),JSON.stringify(owner),{mode:0o600});}catch(e){await rm(lock,{recursive:true});throw e;}
 return owner;
}
export async function discoverGroupKeywords(options){
 const lock=options.policyPath+'.keyword-discovery.lock',owner=await acquireDiscoveryLock(lock);
 if(!owner)return{status:'PARTIAL',at:options.now,metadataCount:options.metadata?.items?.length||0,metadataComplete:options.metadata?.complete||false,pages:0,pendingJobs:null,hits:[],reason:'DISCOVERY_BUSY'};
 try{
  // One-off catch-up jobs must never turn into a new rolling discovery scan.
  // Check under the same lock as the resumed run so another worker cannot
  // complete or replace the target window between the check and execution.
  if(options.config.keywordDiscovery?.resumeOnly){
   const target=options.config.keywordDiscovery.targetWindow;
   if(!target?.startAt||!target?.endAt||!Number.isFinite(Date.parse(target.startAt))||!Number.isFinite(Date.parse(target.endAt)))throw Error('RESUME_TARGET_REQUIRED');
   const state=(await loadAttention(options.policyPath)).keywordDiscovery;
   const result=(status,reason=status)=>({status,reason,at:options.now,window:state?{startAt:state.startAt,endAt:state.endAt}:null,targetWindow:target,metadataCount:0,metadataComplete:state?.metadataComplete===true,metadataRequested:false,pages:0,pendingJobs:state?.jobs?.length||0,hits:[],formalMemoryUpdated:false,semanticJudgments:false});
   if(state?.startAt!==target.startAt||state?.endAt!==target.endAt)return result('WINDOW_REPLACED');
   if(!state.jobs?.length)return result('NO_PENDING');
   if(state.rulesHash!==hash(keywordRules({...GROUP_DISCOVERY_POLICY,...options.config.keywordDiscovery,...options.limits})))return result('WINDOW_REPLACED','RULES_CHANGED');
  }
  return await runGroupKeywords(options);
 }finally{
  // Do not remove a replacement owner's lock.
  let current;try{current=JSON.parse(await readFile(join(lock,'owner.json'),'utf8'));}catch{}
  if(current?.token===owner.token)await rm(lock,{recursive:true});
 }
}
export async function saveGroupDiscovery(output,receipt,policyPath){await mkdir(output,{recursive:true,mode:0o700});const store=await loadAttention(policyPath),safe=receipt.hits.map(({text,...hit})=>hit);const save=(file,data)=>writeFile(join(output,file),JSON.stringify(data,null,2)+'\n',{mode:0o600});await save('discovery-receipt.json',{...receipt,hits:safe});await save('keyword-evidence.json',receipt.hits);await save('discovered-groups.json',store.sources.filter(s=>s.kind==='group'&&s.status!=='excluded').map(s=>({id:s.id,chatId:s.chatId,name:s.name,status:s.status,tier:s.tier,manualOverride:s.manualOverride,reason:s.reason,keywordReason:s.keywordReason,keywordEvidence:s.keywordEvidence||[]})));}
