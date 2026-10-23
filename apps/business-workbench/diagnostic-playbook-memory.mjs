import {memoryDirection} from './memory-pattern.mjs';
import { playbookHash } from './memory-playbook.mjs';

/** Input records must already have passed the current ticket/source/image admission gates. */
export function playbookReferenceMemory(records, policy, source) {
  const context = { allowedSourceIds: [source.id], sourceVersions: {[source.id]:source.version}, sourceHashes:{} };
  const result = [];
  if (!['playbook-reuse-v1','playbook-reuse-v2'].includes(policy?.version) || !Number.isFinite(Date.parse(policy.enabledAt))) return {records:result,context};
  for (const record of records) {
    if(policy.disabledIds?.includes(record.id))continue;
    const existing=policy.records?.find(entry=>entry.id===record.id);
    const automatic=policy.version==='playbook-reuse-v2'&&policy.autoActivate===true&&record.status==='SOURCE_VERIFIED'&&record.activation?.status==='AUTO_ENABLED'&&policy.sourceIds?.includes(source.id);
    const enabledAt=existing?policy.enabledAt:record.activation?.enabledAt;
    if(!Number.isFinite(Date.parse(enabledAt)))continue;
    const approved=existing||(automatic?{id:record.id,hash:playbookHash(record),enabled:true,sourceIds:policy.sourceIds,matchAny:memoryDirection(record).terms.length?memoryDirection(record).terms:[record.question]}:null);
    if (!approved || approved.enabled !== true || approved.hash !== playbookHash(record)
      || !approved.sourceIds?.includes(source.id) || !approved.matchAny?.length
      || !record.queryPattern || !record.steps?.length || !record.sourceRefs?.length) continue;
    if(!Number.isFinite(Date.parse(record.knownAt))||[record.effectiveFrom,record.effectiveUntil].some(value=>value!==undefined&&!Number.isFinite(Date.parse(value)))||record.effectiveFrom&&record.effectiveUntil&&Date.parse(record.effectiveFrom)>=Date.parse(record.effectiveUntil))continue;
    const evidenceId = `playbook:${record.id}`, evidenceHash = playbookHash(record);
    // Only reusable methods enter the prompt. The dated facts and raw replies stay in the source viewer.
    const text = [record.question, '输入：'+record.inputs.join('；'),
      ...record.steps.map((step,index)=>`${index+1}. ${step.action}`),
      '输出：'+record.outputs.join('；'), '边界：'+record.boundaries.join('；'),
      '参考模式：\n'+record.queryPattern,
      ...(record.validationIssues?.length ? ['来源警示：'+record.validationIssues.join('；')] : [])].join('\n');
    const canonical = {id:record.id,kind:'ANALYSIS_RULE',title:record.title,text,status:'SOURCE_VERIFIED',
      knownAt:record.knownAt,...(record.effectiveFrom?{effectiveFrom:record.effectiveFrom}:{}),...(record.effectiveUntil?{effectiveUntil:record.effectiveUntil}:{}),version:1,hash:playbookHash({text,evidenceHash,approved,enabledAt}),
      sourceRefs:[{sourceId:evidenceId,version:evidenceHash,hash:evidenceHash,knownAt:record.knownAt,locator:record.sourceTicketId}],
      applicability:{sourceIds:approved.sourceIds,matchAny:approved.matchAny},keywords:approved.matchAny,
      verification:{method:'SOURCE_BOUND_PLAYBOOK_REFERENCE',at:enabledAt},
      lineage:{ticketId:record.sourceTicketId},activation:{status:'REFERENCE_ENABLED',enabledAt,
        meaning:'已允许作为分析方法参考；历史答案与因果结论未获验证。'}};
    result.push(canonical);context.allowedSourceIds.push(evidenceId);
    context.sourceVersions[evidenceId]=evidenceHash;context.sourceHashes[evidenceId]=evidenceHash;
  }
  return {records:result,context};
}

export function mergeMemoryContext(base, extra = {}) {
  return {allowedSourceIds:[...new Set([...(base.allowedSourceIds||[]),...(extra.allowedSourceIds||[])])],
    sourceVersions:{...base.sourceVersions,...extra.sourceVersions},sourceHashes:{...base.sourceHashes,...extra.sourceHashes}};
}
