import {readFile,writeFile,rename,mkdir,rm} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
export const tiers=['priority','normal','on_match'];
import {isTrustedListeningSource} from './source-listening-policy.mjs';
export {isTrustedListeningSource};
export function demoteKeywordOnlySource(s,now=new Date().toISOString()){
 if(s.status!=='active'||s.manualOverride||isTrustedListeningSource(s)||!(s.decisionOrigin==='keyword'||s.keywordEvidence?.length))return s;
 return {...s,status:'candidate',tier:'on_match',decisionOrigin:'candidate',lastTierChangedAt:now,reason:'关键词仅作为召回线索，业务关联与监听资格待模型核验',history:[{at:now,origin:'auto',action:'keyword_candidate_migration',before:{status:s.status,tier:s.tier},after:{status:'candidate',tier:'on_match'},reason:'移除未经业务模型核验的关键词监听资格'},...(s.history||[])].slice(0,100)};
}
export function readPlan(store,now=Date.now()){
 const fresh=time=>Number.isFinite(Date.parse(time))&&now-Date.parse(time)>=0&&now-Date.parse(time)<24*60*60*1000;
 return store.sources.filter(s=>isTrustedListeningSource(s)&&(s.tier!=='on_match'||s.manualOverride||s.matchedWorklines.length>0&&fresh(s.lastMatchedAt))).sort((a,b)=>tiers.indexOf(a.tier)-tiers.indexOf(b.tier)||a.id.localeCompare(b.id)).map(s=>({sourceKey:s.id,tier:s.tier,reason:s.reason}));
}
export function changeSource(store,id,action,tier,now=new Date().toISOString()){
 const next=structuredClone(store),s=next.sources.find(s=>s.id===id);if(!s)throw Error('来源不存在');
 const before={tier:s.tier,status:s.status};const businessReason=s.reason;
 if(action==='set_tier'&&tiers.includes(tier)){s.tier=tier;s.status='active';s.manualOverride=true;s.reason='你手动设定了关注档位，自动规则不会覆盖。';}
 else if(action==='exclude'){s.status='excluded';s.manualOverride=true;s.reason='你已禁止关注；后续读取计划会排除此来源。';}
 else if(action==='auto'&&s.status!=='excluded'){s.manualOverride=false;s.reason='已恢复自动分档，下一次更新时重新判断。';}
 else if(action==='restore'&&s.status==='excluded'){s.status='active';s.tier='normal';s.manualOverride=true;s.reason='你手动恢复为普通监测。';}
 else throw Error('操作无效');
 const actionReason=s.reason;s.reason=businessReason;s.decisionOrigin='manual';s.history=[{at:now,origin:'manual',action,before,after:{tier:s.tier,status:s.status},reason:actionReason},...(s.history||[])].slice(0,100);next.updatedAt=now;return next;
}
export function evaluateSources(store,observations,now=new Date().toISOString()){
 const next=structuredClone(store);for(const s of next.sources){const o=observations.find(o=>o.id===s.id);if(!o||s.manualOverride||s.status==='excluded')continue;
 if(o.status!=='VERIFIED'||o.monitoringRecommended!==true)continue;
 const observationHash=createHash('sha256').update(JSON.stringify(o)).digest('hex');if(s.lastObservationHash===observationHash)continue;
 if(!Array.isArray(o.evidenceRefs)||!o.evidenceRefs.length||!o.reason)continue;
 const before={tier:s.tier,status:s.status};s.matchedWorklines=o.matchedWorklines||[];s.evidenceRefs=o.evidenceRefs;s.lastEvaluatedAt=now;s.lastMatchedAt=o.lastMatchedAt??s.lastMatchedAt;s.lastActiveAt=o.lastActiveAt??s.lastActiveAt;s.lastObservationHash=observationHash;s.ruleVersion='attention-v1';
 s.tier=o.directResponsibility||o.blockingDecision?'priority':o.matchedDays>=3?'normal':'on_match';s.status=s.matchedWorklines.length?'active':'candidate';s.reason=o.reason;s.decisionOrigin='auto';s.history=[{at:now,origin:'auto',action:'evaluate',before,after:{tier:s.tier,status:s.status},reason:s.reason},...(s.history||[])].slice(0,100);
 }next.updatedAt=now;return next;
}
export async function loadAttention(path){const s=JSON.parse(await readFile(path,'utf8'));if(s.version!==1||!Array.isArray(s.sources)||s.sources.some(x=>!x.id||!tiers.includes(x.tier)||!['active','candidate','excluded'].includes(x.status)||!Array.isArray(x.matchedWorklines)))throw Error('来源配置无效');return s;}
// Shared with collectors: reload under a cross-process lock before mutating.
export async function updateAttention(path,mutate){
 path=path instanceof URL?path.pathname:path;
 const lock=path+'.lock';let acquired=false;
 for(let i=0;i<100;i++){try{await mkdir(lock,{mode:0o700});acquired=true;break;}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,25));}}
 if(!acquired)throw Error('ATTENTION_BUSY');
 try{const next=await mutate(await loadAttention(path));const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600});await rename(temp,path);return next;}finally{await rm(lock,{recursive:true,force:true});}
}
export function saveChange(path,id,action,tier){return updateAttention(path,store=>changeSource(store,id,action,tier));}
