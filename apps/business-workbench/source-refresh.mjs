import {discoverGroupKeywords,saveGroupDiscovery} from './group-keyword-discovery.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {loadAttention,updateAttention,readPlan,demoteKeywordOnlySource} from './source-attention.mjs';
import {screenSourceMetadata,canPreviewSource} from './source-metadata-gate.mjs';
import {accumulateRefreshHistory} from './history-refresh.mjs';
export const REFRESH_POLICY={version:'discovery-v3',recentDays:7,maxRecent:5000,maxPreviews:24,previewMessages:20,previewDays:3,maxReadPages:4,pageSize:50,evidenceDays:14,normalSignalDays:3,demoteAfterDays:14,cooldownDays:7,matchHours:24};
const DAY=86400000;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const validTime=(time,now)=>Number.isFinite(Date.parse(time))&&Date.parse(time)<=Date.parse(now);
const dayOf=time=>new Date(Date.parse(time)+8*3600000).toISOString().slice(0,10);
function rollingEvidence(previous,incoming,now,p){
 const cutoff=Date.parse(now)-p.evidenceDays*DAY,ids=new Set(),hashes=new Set(),result=[];
 // Preserve the first timestamp of a message/content. Replays cannot refresh an old signal.
 for(const e of [...(previous||[]),...(incoming||[])]){
  if(!e.messageId||!e.contentHash||!validTime(e.occurredAt,now)||Date.parse(e.occurredAt)<cutoff||!e.worklines?.length||ids.has(e.messageId)||hashes.has(e.contentHash))continue;
  ids.add(e.messageId);hashes.add(e.contentHash);result.push({...e,occurredAt:new Date(Date.parse(e.occurredAt)).toISOString()});
 }
 return result.sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
}
export function decideSource(s,o,now,p=REFRESH_POLICY){
 if(s.status==='excluded'||o.status!=='VERIFIED'||!o.complete||!o.reason||!validTime(now,now))return s;
 if(s.lastObservationHash===o.hash||Date.parse(s.lastEvaluatedAt)>Date.parse(now))return s;
 const next={...s,lastObservationHash:o.hash,lastEvaluatedAt:now,firstReviewedAt:s.firstReviewedAt||now,ruleVersion:p.version,decisionOrigin:'auto'};
 const matches=o.matchedWorklines||[];
 const incoming=o.effectiveEvidence||(o.evidenceRefs||[]).map(id=>({messageId:id,contentHash:digest(id),occurredAt:o.lastMatchedAt,worklines:matches}));
 const effective=rollingEvidence(s.effectiveEvidence,incoming,now,p);
 const current=rollingEvidence([],incoming,now,p);const valid=matches.length&&current.length;
 next.effectiveEvidence=effective;next.effectiveSignalDays=new Set(effective.map(e=>dayOf(e.occurredAt))).size;
 let tier=s.tier,status=s.status;
 if(valid){next.associationReview={status:'VERIFIED',monitoringRecommended:true,reason:o.reason,model:o.model,promptVersion:o.promptVersion,evidenceRefs:o.evidenceRefs,at:now};tier=o.directResponsibility||o.blockingDecision?'priority':next.effectiveSignalDays>=p.normalSignalDays?'normal':'on_match';status='active';next.lastMatchedAt=effective.at(-1).occurredAt;next.matchedWorklines=[...new Set(effective.flatMap(e=>e.worklines))];next.evidenceRefs=effective.map(e=>e.messageId);next.candidateWorklines=[...new Set([...(s.candidateWorklines||[]),...(o.candidateWorklines||[])])].filter(w=>next.matchedWorklines.includes(w));}
 const anchors=[next.lastMatchedAt].filter(t=>validTime(t,now)).sort();
 const anchor=Date.parse(anchors.at(-1)||next.firstReviewedAt);
 const quiet=Date.parse(now)-anchor>=p.demoteAfterDays*DAY;
 const cooled=Date.parse(now)-Date.parse(s.lastTierChangedAt||'1970-01-01')>=p.cooldownDays*DAY;
 if(!valid&&s.status!=='candidate'&&quiet&&cooled){if(s.tier==='priority')tier='normal';else if(s.tier==='normal')tier='on_match';else status='candidate';next.matchedWorklines=[];}
 // A lower recommendation from a sampled preview cannot erase recent useful evidence.
 if(valid&&['priority','normal','on_match'].indexOf(tier)>['priority','normal','on_match'].indexOf(s.tier)&&(!quiet||!cooled))tier=s.tier;
 if(s.manualOverride){tier=s.tier;status=s.status;next.decisionOrigin='manual';}
 next.lastAssessmentReason=o.reason;next.reason=valid||!s.matchedWorklines?.length||!next.matchedWorklines?.length?o.reason:s.reason;next.tier=tier;next.status=status;
 if(tier!==s.tier||status!==s.status)next.lastTierChangedAt=now;
 next.history=[{at:now,origin:'auto',action:'evaluate',before:{tier:s.tier,status:s.status},after:{tier,status},reason:o.reason,evidenceRefs:o.evidenceRefs,model:o.model,ruleVersion:p.version,effectiveSignalDays:next.effectiveSignalDays},...(s.history||[])].slice(0,100);return next;
}
export async function refreshSources({policyPath,config,output,adapter,judge,metadataJudge,discoverWorklines,now=new Date(Math.floor(Date.now()/1000)*1000).toISOString(),limits={}}){
 const p={...REFRESH_POLICY,...limits};await mkdir(output,{recursive:true,mode:0o700});
 const save=(n,v)=>writeFile(join(output,n),JSON.stringify(v,null,2)+'\n',{mode:0o600});
 const initial=await loadAttention(policyPath);const known=new Map(config.sources.map(s=>[String(s.chat_id),s]));
 for(const s of initial.sources)if(s.chatId&&!known.has(String(s.chatId)))known.set(String(s.chatId),{source_key:s.id});
 const recent=await adapter.recent({startAt:new Date(Date.parse(now)-p.recentDays*DAY).toISOString(),endAt:now,maxItems:p.maxRecent});
 const rows=recent.items.map(r=>{const old=known.get(r.chatId);return {...r,id:old?.source_key||r.id};});
 const current=await loadAttention(policyPath);const indexed=new Map(current.sources.map(s=>[s.id,s]));
 const keywordDiscovery=await discoverGroupKeywords({policyPath,config,adapter,now,metadata:recent,metadataJudge});
 await saveGroupDiscovery(output,keywordDiscovery,policyPath);
 for(const s of current.sources){const binding=config.sources.find(x=>x.source_key===s.id);if(!rows.some(r=>r.id===s.id)&&(s.chatId||binding?.chat_id))rows.push({id:s.id,chatId:String(s.chatId||binding.chat_id),name:s.name,kind:s.kind,lastActiveAt:s.lastActiveAt||'1970-01-01T00:00:00Z',inherited:true});}
 const candidates=rows.filter(r=>r.id&&r.chatId&&['group','direct'].includes(r.kind)&&validTime(r.lastActiveAt,now)&&indexed.get(r.id)?.status!=='excluded');
 // Persist every eligible metadata row before the bounded preview. Unchecked entries survive later runs.
 await updateAttention(policyPath,store=>{
  store.sources=store.sources.map(s=>demoteKeywordOnlySource(s,now));
  for(const r of candidates){if(!store.sources.some(s=>s.id===r.id))store.sources.push({id:r.id,chatId:r.chatId,name:r.name,kind:r.kind,tier:'on_match',status:'candidate',manualOverride:false,matchedWorklines:[],evidenceRefs:[],firstDiscoveredAt:now,lastActiveAt:r.lastActiveAt,reason:'近期会话发现，业务关联待核实',history:[]});}
  return store;
 });
 const metadataGate=await screenSourceMetadata({policyPath,sourceIds:candidates.map(r=>r.id),worklines:config.worklines||[],metadataJudge,now});
 const queue=new Map((await loadAttention(policyPath)).sources.map(s=>[s.id,s]));
 const eligible=candidates.filter(r=>canPreviewSource(queue.get(r.id)));
 const order=(a,b)=>(queue.get(a.id)?.lastPreviewAttemptAt||'').localeCompare(queue.get(b.id)?.lastPreviewAttemptAt||'')||(queue.get(a.id)?.firstDiscoveredAt||'').localeCompare(queue.get(b.id)?.firstDiscoveredAt||'')||a.id.localeCompare(b.id);
 eligible.sort(order);
 const isUnreviewed=r=>['candidate','active'].includes(queue.get(r.id)?.status)&&!queue.get(r.id)?.lastEvaluatedAt;
 const newRows=eligible.filter(isUnreviewed),oldRows=eligible.filter(r=>!isUnreviewed(r));
 const reserved=[...newRows.slice(0,Math.ceil(p.maxPreviews/2)),...oldRows.slice(0,Math.floor(p.maxPreviews/2))];
 const selected=config.previewSourceIds?eligible.filter(r=>config.previewSourceIds.includes(r.id)).slice(0,p.maxPreviews):[...reserved,...eligible.filter(r=>!reserved.includes(r)).slice(0,p.maxPreviews-reserved.length)];const observations=[],previews=[];
 for(const r of selected){
  const fresh=await loadAttention(policyPath);if(!canPreviewSource(fresh.sources.find(s=>s.id===r.id)))continue;
  const startAt=new Date(Date.parse(now)-p.previewDays*DAY).toISOString();
  try{
   const sample=await adapter.messages(r,{startAt,endAt:now,maxPages:1,pageSize:p.previewMessages,order:'desc',allowed:async()=>canPreviewSource((await loadAttention(policyPath)).sources.find(s=>s.id===r.id))});
   if((await loadAttention(policyPath)).sources.some(s=>s.id===r.id&&s.status==='excluded'))continue;
   const items=(sample.items||[]).filter(m=>m.id&&validTime(m.occurredAt,now)&&Date.parse(m.occurredAt)>=Date.parse(startAt));
   previews.push({source:r,...sample,complete:sample.complete&&items.length===(sample.items||[]).length,items});
  }catch(e){observations.push({id:r.id,status:'FAILED',stage:'preview',reason:e.code||e.name});}
 }
 let worklines=[...config.worklines],worklineDiscovery={status:'NOT_RUN'};
 if(discoverWorklines){
  try{const fresh=await loadAttention(policyPath),excludedSourceIds=fresh.sources.filter(s=>s.status==='excluded').map(s=>s.id);
   worklineDiscovery=await discoverWorklines({sources:previews.filter(x=>!excludedSourceIds.includes(x.source.id)&&['VERIFIED','PARTIAL'].includes(x.status)).map(x=>({source:x.source,messages:x.items,status:x.status,complete:x.complete})),worklines,now,policyPath,excludedSourceIds});
   if(Array.isArray(worklineDiscovery.expandedWorklines))worklines=[...new Set([...worklines,...worklineDiscovery.expandedWorklines.filter(w=>typeof w==='string'&&w.trim())])];
  }catch(e){worklineDiscovery={status:'FAILED',reason:e.code||e.name};}
 }
 for(const sample of previews){const r=sample.source;const fresh=await loadAttention(policyPath);if(fresh.sources.find(s=>s.id===r.id)?.status==='excluded')continue;
  if(!['VERIFIED','PARTIAL'].includes(sample.status)){observations.push({id:r.id,status:'FAILED',stage:'preview',reason:'消息预读失败，保持原档位'});continue;}
  try{
   const answer=await judge({source:{...r,previousWorklines:fresh.sources.find(s=>s.id===r.id)?.matchedWorklines||[]},worklines,worklineAnchors:worklineDiscovery.anchors||[],messages:sample.items});
   const evidence=new Map(sample.items.map(m=>[m.id,m]));
   // Unsupported positive assertions are invalid judgments, never evidence of an empty/quiet window.
   if(!answer||typeof answer.reason!=='string'||!answer.reason.trim()||!Array.isArray(answer.evidenceRefs)||!Array.isArray(answer.matchedWorklines)
    ||answer.evidenceRefs.some(id=>typeof id!=='string'||!evidence.has(id))
    ||answer.matchedWorklines.some(w=>typeof w!=='string'||!worklines.includes(w))
    ||(answer.matchedWorklines.length&&typeof answer.monitoringRecommended!=='boolean')
    ||['directResponsibility','blockingDecision'].some(key=>answer[key]!==undefined&&typeof answer[key]!=='boolean')
    ||(answer.matchedWorklines.length&&!answer.evidenceRefs.length)
    ||((answer.directResponsibility||answer.blockingDecision)&&(!answer.evidenceRefs.length||!answer.matchedWorklines.length)))throw Object.assign(new Error('Invalid source judgment'),{code:'INVALID_JUDGMENT'});
   const refs=[...new Set(answer.evidenceRefs)],matchedWorklines=answer.monitoringRecommended===true?[...new Set(answer.matchedWorklines)]:[];
   const effectiveEvidence=refs.map(id=>{const m=evidence.get(id);return{messageId:id,occurredAt:m.occurredAt,contentHash:digest(m.text||m.body||m.content||{id}),worklines:matchedWorklines};});
   const times=effectiveEvidence.map(e=>e.occurredAt).sort();
   const candidateNames=new Set((worklineDiscovery.anchors||[]).filter(w=>w.status==='candidate').map(w=>w.title));
   const o={candidateWorklines:matchedWorklines.filter(w=>candidateNames.has(w)),id:r.id,status:'VERIFIED',complete:sample.status==='VERIFIED'&&sample.complete,reason:answer.reason,matchedWorklines,evidenceRefs:refs,effectiveEvidence,lastMatchedAt:times.at(-1),monitoringRecommended:answer.monitoringRecommended===true,directResponsibility:matchedWorklines.length>0&&answer.directResponsibility===true,blockingDecision:matchedWorklines.length>0&&answer.blockingDecision===true,model:answer.model,promptVersion:answer.promptVersion};
   if(refs.length&&matchedWorklines.length)o.complete=true;
   o.hash=digest({...o,...(!refs.length?{quietDay:dayOf(now)}:{})});observations.push(o);
  }catch(e){observations.push({id:r.id,status:'FAILED',stage:'judge',reason:e.code||e.name});}
 }
 const updated=await updateAttention(policyPath,store=>{
  store.sources=store.sources.map(s=>{const o=observations.find(o=>o.id===s.id);const result=o?decideSource(s,o,now,p):s;if(selected.some(r=>r.id===s.id)&&result.status!=='excluded')result.lastPreviewAttemptAt=now;const activity=rows.find(r=>r.id===s.id)?.lastActiveAt;if(result.status!=='excluded'&&validTime(activity,now)&&(!result.lastActiveAt||activity>result.lastActiveAt))result.lastActiveAt=activity;return result;});store.updatedAt=now;store.refresh={at:now,trigger:'user_request',policy:p,discovered:rows.length,evaluated:observations.filter(o=>o.status==='VERIFIED').length};return store;
 });
 const mapping=new Map([...config.sources.map(s=>[s.source_key,{id:s.source_key,chatId:String(s.chat_id),name:s.verified_name,kind:s.conversation_kind}]),...rows.map(r=>[r.id,r])]);
 const receipts=[],evidence=[];
 for(const entry of readPlan(updated,Date.parse(now))){const r=mapping.get(entry.sourceKey);if(!r)continue;
  const fresh=await loadAttention(policyPath);if(!readPlan(fresh,Date.parse(now)).some(s=>s.sourceKey===r.id))continue;
  const source=fresh.sources.find(s=>s.id===r.id),old=config.sources.find(s=>s.source_key===r.id);
  const startAt=source.lastReadThrough||old?.next_increment_start_at|| (old?config.fixed_cutoff:null)||new Date(Date.parse(now)-(r.kind==='direct'?1:p.previewDays)*DAY).toISOString();
  const result=await adapter.messages(r,{startAt,endAt:now,maxPages:p.maxReadPages,pageSize:p.pageSize,order:'asc',allowed:async()=>readPlan(await loadAttention(policyPath),Date.parse(now)).some(s=>s.sourceKey===r.id)});
  const allowed=readPlan(await loadAttention(policyPath),Date.parse(now)).some(s=>s.sourceKey===r.id);
  receipts.push({id:r.id,startAt,endAt:now,status:allowed?result.status:'SUPPRESSED',count:allowed?result.items.length:0,complete:result.complete});
  if(!allowed)continue;const validItems=result.items.filter(m=>m.id&&validTime(m.occurredAt,now)&&Date.parse(m.occurredAt)>=Date.parse(startAt));if(validItems.length!==result.items.length){receipts.at(-1).complete=false;receipts.at(-1).status='PARTIAL';receipts.at(-1).count=validItems.length;}evidence.push(...validItems.map(m=>({...m,sourceKey:r.id,sourceName:r.name,kind:r.kind})));
  // Advance successful cursors only after all evidence and handoff files are durable below.
 }
 const finalPolicy=await loadAttention(policyPath);const excluded=new Set(finalPolicy.sources.filter(s=>s.status==='excluded').map(s=>s.id));
 const visibleEvidence=evidence.filter(e=>!excluded.has(e.sourceKey));
 const worklineStatus=worklineDiscovery.receipt?.status||worklineDiscovery.status;
 const receipt={status:recent.complete&&metadataGate.status==='VERIFIED'&&!['FAILED','PARTIAL'].includes(keywordDiscovery.status)&&!['FAILED','PARTIAL'].includes(worklineStatus)&&observations.every(o=>o.status==='VERIFIED')&&receipts.every(r=>r.status==='VERIFIED')?'VERIFIED':'PARTIAL',at:now,policy:p,keywordDiscovery:{...keywordDiscovery,hits:keywordDiscovery.hits.map(({text,...hit})=>hit)},recentComplete:recent.complete,metadataGate,metadataCount:rows.length,selectedCount:selected.length,deferredCount:candidates.length-selected.length,observations,sourceReceipts:receipts,evidenceCount:visibleEvidence.length,formalMemoryUpdated:false,nextStep:'Codex联合核查 refresh-evidence.json 与现有IM/OCR后发布候选看板；未经核查不改业务卡',previousCutoff:config.fixed_cutoff};
 await save('workline-discovery.json',worklineDiscovery);await save('discovery-metadata.json',rows);await save('preview-evidence.json',previews.filter(p=>!excluded.has(p.source.id)));await save('refresh-evidence.json',visibleEvidence);await save('refresh-receipt.json',receipt);await save('joint-review-handoff.json',{status:'PENDING_CODEX_REVIEW',evidenceFile:join(output,'refresh-evidence.json'),receiptFile:join(output,'refresh-receipt.json'),worklineDiscoveryFile:join(output,'workline-discovery.json'),pendingHandoffs:config.pendingHandoffs||[],previousCorpus:config.previousCorpus,previousDashboard:config.previousDashboard,...(config.historyIndexPath?{historyIndexPath:config.historyIndexPath}:{}),policyPath,modelRoute:config.modelRoute||'deepseek-v4-pro + Codex verification',instructions:['读取原始新增证据，图片沿已批准OCR路径理解，保留来源与时间','核对历史时间线后发布候选进展，不写正式记忆','失败/截断/未读取不能推断无进展']});
 await accumulateRefreshHistory({config:{...config,policyPath},evidence:visibleEvidence,output,now});
 await updateAttention(policyPath,s=>{for(const r of receipts){const row=s.sources.find(x=>x.id===r.id);const latest=visibleEvidence.filter(e=>e.sourceKey===r.id).map(e=>e.occurredAt).sort().at(-1);if(row&&row.status!=='excluded'&&latest&&(!row.lastActiveAt||latest>row.lastActiveAt))row.lastActiveAt=latest;if(row&&row.status!=='excluded'&&r.complete&&r.status==='VERIFIED'&&(!row.lastReadThrough||row.lastReadThrough<now))row.lastReadThrough=now;}return s;});return receipt;
}
