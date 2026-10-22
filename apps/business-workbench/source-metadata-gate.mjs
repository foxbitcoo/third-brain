import {createHash} from 'node:crypto';
import {loadAttention,updateAttention,isTrustedListeningSource} from './source-attention.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const metadataOf=source=>({id:source.id,name:source.name||'',kind:source.kind,description:source.description||'',keywordRecall:source.keywordMatchedWorklines||[]});
export function canPreviewSource(source){return !!source&&source.status!=='excluded'&&(source.manualOverride===true||isTrustedListeningSource(source)||source.metadataGate?.status==='VERIFIED'&&source.metadataGate.decision==='allow_preview');}
// Only explicitly named metadata fields cross this boundary, never recent-message snippets.
export async function screenSourceMetadata({policyPath,sourceIds,worklines=[],metadataJudge,now}){
 const store=await loadAttention(policyPath),ids=new Set(sourceIds),pending=store.sources.filter(s=>ids.has(s.id)&&s.status!=='excluded'&&!s.manualOverride&&!isTrustedListeningSource(s)&&!(s.metadataGate?.evaluatedAt===now&&s.metadataGate.inputHash===hash({source:metadataOf(s),worklines})));
 const outcomes=[];
 for(let i=0;i<pending.length;i+=50){
  const batch=pending.slice(i,i+50),requests=batch.map(metadataOf);let answer;
  if(metadataJudge){try{answer=await metadataJudge({sources:requests,worklines});}catch{}}
  for(const source of batch){
   const decision=Array.isArray(answer?.decisions)?answer.decisions.filter(d=>d&&typeof d==='object'&&d.sourceId===source.id):[];
   const d=decision?.length===1?decision[0]:null;
   const valid=d&&['allow_preview','irrelevant','insufficient'].includes(d.decision)&&typeof d.reason==='string'&&d.reason.trim()&&Array.isArray(d.matchedWorklines)&&d.matchedWorklines.every(w=>worklines.includes(w))&&(d.decision!=='allow_preview'||d.matchedWorklines.length>0);
   outcomes.push({id:source.id,metadataGate:{status:valid?'VERIFIED':metadataJudge?'FAILED':'NOT_RUN',decision:valid?d.decision:'insufficient',reason:valid?d.reason:metadataJudge?'元数据模型判断失败或不完整，未读取正文':'未配置元数据模型，保留候选且未读取正文',matchedWorklines:valid?d.matchedWorklines:[],...(answer?.model?{model:answer.model}:{}),promptVersion:answer?.promptVersion||'source-metadata-v1',evaluatedAt:now,boundary:'metadata_only',inputHash:hash({source:metadataOf(source),worklines})}});
  }
 }
 await updateAttention(policyPath,s=>{for(const outcome of outcomes){const row=s.sources.find(x=>x.id===outcome.id);const baseline=pending.find(x=>x.id===outcome.id);if(row&&row.status!=='excluded'&&!row.manualOverride&&!isTrustedListeningSource(row)&&JSON.stringify(row.metadataGate)===JSON.stringify(baseline.metadataGate)&&hash({source:metadataOf(row),worklines})===outcome.metadataGate.inputHash&&(!row.metadataGate?.evaluatedAt||Date.parse(row.metadataGate.evaluatedAt)<=Date.parse(now)))row.metadataGate=outcome.metadataGate;}return s;});
 return{status:outcomes.some(o=>o.metadataGate.status!=='VERIFIED')?'PARTIAL':'VERIFIED',boundary:'metadata_only',decisions:outcomes.map(({id,metadataGate})=>({sourceId:id,...metadataGate}))};
}
