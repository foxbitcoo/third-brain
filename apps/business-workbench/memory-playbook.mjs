import {memoryDirection, MEMORY_PATTERN_VERSION} from './memory-pattern.mjs';
import {createHash} from 'node:crypto';
const list=v=>Array.isArray(v)?v:[];
export const playbookHash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const text=v=>typeof v==='string'?v:'';
export function displayMemoryNames(value,identities={}) {
 return text(value).replace(/(?:@)?(?:参与者\d+|本人)/g,match=>{
  const alias=match.replace(/^@/,'');
  const name=identities[alias];
  return typeof name==='string'&&name.trim()?(match.startsWith('@')?'@':'')+name:match;
 });
}
export function validateHumanReview(review,comparison) {
 if(review?.schemaVersion!=='memory-v2-human-review'||review.stage!=='BUILD_ONLY')throw Error('MEMORY_REVIEW_INVALID');
 if(!Array.isArray(review.frozenInputs)||review.frozenInputs.length!==comparison.packets.length)throw Error('MEMORY_REVIEW_INPUT_CHANGED');
 const seen=new Set();
 for(const frozen of review.frozenInputs){
  const packet=comparison.packets.find(p=>p.ticketId===frozen.ticketId);
  if(!packet||seen.has(frozen.ticketId)||frozen.inputHash!==packet.inputHash||frozen.packetHash!==playbookHash(packet))throw Error('MEMORY_REVIEW_INPUT_CHANGED');
  seen.add(frozen.ticketId);
  for(const arm of ['doubao','deepseek']){
   const result=comparison.arms[arm].results.find(r=>r.ticketId===packet.ticketId);
   if(result?.requestHash!==frozen.requestHashes?.[arm]||result?.formatAudit?.normalizedHash!==frozen.formatHashes?.[arm]||playbookHash(result.result)!==frozen.formatHashes?.[arm]||playbookHash(result.request)!==frozen.requestHashes?.[arm])throw Error('MEMORY_REVIEW_INPUT_CHANGED');
  }
 }
 return Object.fromEntries(Object.entries(review.reviews||{}).filter(([id,r])=>seen.has(id)&&['doubao','deepseek','tie','neither'].includes(r.choice)));
}
export function delperMemoryPattern(playbook,{question='{{本次原始问题}}',source='{{已核验看板／指标及版本}}',period='{{本期日期、时区和比较日期}}'}={}){
 return ['原始问题：'+question,'查询对象：'+source,'统计周期：'+period,'需要补齐的输入：'+list(playbook.inputs).join('；'),
 '原图与来源：{{引用消息ID、看板快照ID、统计日、推送日；原图供上游模型理解，不冒充已上传德普}}',
 '已知业务口径：{{本次核验的指标定义、分子分母、去重单位和筛选条件}}',
 '参考分析顺序（历史经验，不替代当前指标定义）：',...list(playbook.steps).map((step,i)=>`${i+1}. ${step.action}`),
 '输出：'+list(playbook.outputs).join('；'),'适用条件：'+list(playbook.useWhen).join('；'),'仍需当前资料：'+list(playbook.currentMaterials||playbook.inputs).join('；'),
 '约束：'+list(playbook.boundaries).join('；'),
 '执行适配：保留原始用户问题；delper-olap 先登记 prompt_analysis 并保留 promptTraceId。由适配层选取已授权、已核验的查询方案；指标／维度标识不能从经验中编造，Memory 不授权新 SQL。'].join('\n');
}
export function compactMemory(candidate,{packet,arm,identities={},sourceRefs=[],attachments=[],issues=[]}={}){
 const named=s=>displayMemoryNames(s,identities);
 const namedValue=value=>typeof value==='string'?named(value):Array.isArray(value)?value.map(namedValue):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,namedValue(item)])):value;
 const value={id:'playbook-'+playbookHash({candidate,arm,ticketId:packet.ticketId,inputHash:packet.inputHash,sourceRefs}).slice(0,24),kind:'ANALYSIS_RULE',status:'CANDIDATE',sourceTicketId:packet.ticketId,sourceTicketTitle:packet.title||'',arm,
 title:named(candidate.title),question:named(candidate.questionPattern?.typicalQuestion||packet.originalQuestion),
 inputs:list(candidate.applicability?.requiredInputs).map(named),steps:list(candidate.answerPlaybook?.steps).slice(0,4).map(s=>({action:named(s.action),why:named(s.why),evidenceIds:list(s.evidenceIds)})),
 outputs:list(candidate.answerPlaybook?.outputChecklist).map(named),boundaries:list(candidate.applicability?.doNotUseWhen).map(named),
 originalModelOutput:namedValue(candidate),direction:packet.direction||memoryDirection(candidate),patternVersion:MEMORY_PATTERN_VERSION,
 useWhen:list(candidate.applicability?.useWhen).map(named),doNotUseWhen:list(candidate.applicability?.doNotUseWhen).map(named),currentMaterials:[...new Set([...list(candidate.applicability?.requiredInputs),...list(candidate.uncertainties)])].map(named),relation:candidate.questionPattern?.relation||'SAME_DIRECTION',cadence:candidate.questionPattern?.cadence||'按本次问题确定',sourceRefs,requiredSourceIds:[...new Set(sourceRefs.map(r=>r.sourceId))],attachments,
 originalQuestion:named(packet.originalQuestion),knownAt:sourceRefs.map(r=>r.at).filter(Boolean).sort().at(-1),validationIssues:issues,datedFacts:namedValue(list(candidate.datedFacts)),evidence:list(candidate.evidence),
 derivation:{stage:'REVIEWED_OUTPUT_REFORMATTED',newModelExtraction:false,originalCandidateHash:playbookHash(candidate),inputHash:packet.inputHash}};
 value.queryPattern=delperMemoryPattern(value);
 return value;
}
export function visiblePlaybooks(bundle,{allowedSourceIds=new Set(),excludedSourceIds=new Set(),scopeIds=new Set(),scopeWindow}={}){
 return list(bundle?.records).filter(record=>{
  const ids=list(record.requiredSourceIds),refs=list(record.sourceRefs);
  const allowed=id=>!excludedSourceIds.has(id)&&(allowedSourceIds.has(id)||scopeIds.has(id));
  return ids.length>0&&refs.length>0&&ids.every(id=>allowed(id)&&refs.some(ref=>ref.sourceId===id))&&refs.every(ref=>ids.includes(ref.sourceId)&&allowed(ref.sourceId)&&(allowedSourceIds.has(ref.sourceId)||scopeWindow&&Date.parse(ref.at)>=Date.parse(scopeWindow.startAt)&&Date.parse(ref.at)<=Date.parse(scopeWindow.endAt)));
 });
}
export function ticketMemoryTrace(ticketId,records=[],runtime={records:[],runs:[]}){
 const all=new Map(records.map(r=>[r.id,r]));
 for(const r of list(runtime.records))all.set(r.id,{...all.get(r.id),...r});
 const generated=[...all.values()].filter(r=>(r.sourceTicketId||r.lineage?.ticketId)===ticketId);
 const runs=list(runtime.runs).filter(r=>(r.historicalTicketId||r.questionContext?.historicalTicketId)===ticketId);
 return {ticketId,generated,runs,matched:runs.flatMap(run=>list(run.memorySnapshot?.selected).map(m=>({runId:run.id,record:m}))),
  injections:runs.flatMap(run=>list(run.usage?.receipts).flatMap(receipt=>receipt.memoryInjection?.status==='PROVIDER_RESPONDED'&&receipt.memoryInjection.memoryIds?.length?[{runId:run.id,stage:receipt.stage,round:receipt.round,...receipt.memoryInjection}]:[])),
  boundary:'只有保存的匹配快照和模型响应回执才表示实际命中或注入；评阅偏好不等于已启用。'};
}
