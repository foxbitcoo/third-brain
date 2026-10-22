import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

/** Live comparisons retain executions; frozen answers must never enter this receipt. */
export function prepareLiveEvaluation(input) {
  if (!input || !/^[\w-]{1,100}$/.test(input.runId || '') || !Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > 3) fail('INVALID_LIVE_EVALUATION');
  if (new Set(input.cases.map(c => c.id)).size !== input.cases.length) fail('DUPLICATE_EVALUATION_CASE');
  const arms = [];
  for (const testCase of input.cases) {
    if (!/^[\w.-]{1,100}$/.test(testCase.id || '') || typeof testCase.question !== 'string' || !testCase.question.trim() || !testCase.sourceId || !Number.isFinite(Date.parse(testCase.cutoff))) fail('INVALID_EVALUATION_CASE');
    // The caller validates source authorization freshly before every actual stage.
    const common = structuredClone(testCase);
    const parityHash = hash(common);
    for (const providerId of ['deepseek','mimo']) for (const withMemory of [false,true]) {
      arms.push({ id:`${testCase.id}:${providerId}:${withMemory?'memory':'no-memory'}`, caseId:testCase.id, providerId, withMemory, parityHash, case:structuredClone(common) });
    }
  }
  return { version:'diagnostic-live-evaluation/v1', runId:input.runId, mode:'REAL_READONLY_TOOL_LOOP', isLiveToolLoop:true, arms,
    limits:{additionalPaidCny:Math.min(input.additionalPaidLimitCny || 9,9),maxRounds:3,maxQueries:3,noAutomaticRetry:true}, results:[], status:'NOT_RUN' };
}

export async function runLiveEvaluation(plan, {executeArm, beforeArm = async()=>true, persist = async()=>{}, maxConcurrency=2} = {}) {
  if (plan?.mode!=='REAL_READONLY_TOOL_LOOP' || typeof executeArm!=='function' || !Number.isInteger(maxConcurrency) || maxConcurrency<1 || maxConcurrency>2 || plan.results?.length) fail('INVALID_LIVE_EVALUATION_EXECUTION');
  const receipt=structuredClone(plan); receipt.startedAt=new Date().toISOString();receipt.status='RUNNING';await persist(receipt);
  let cursor=0;
  async function worker() {
    while (cursor<receipt.arms.length) {
      const arm=receipt.arms[cursor++], start=Date.now();let entry;
      try {
        if (await beforeArm(arm) !== true) { entry={armId:arm.id,status:'NOT_RUN',reason:'AUTHORITY_OR_BUDGET_BOUNDARY'}; }
        else {
          const run=await executeArm(structuredClone(arm));
          if (!run || !Array.isArray(run.rounds) || !run.usage || typeof run.id!=='string') fail('INVALID_LIVE_RUN');
          const results=run.rounds.filter(r=>r.result?.status==='VERIFIED');
          // A human-input outcome may correctly have no data, but must not appear as retrieval success.
          const toolReceipts=results.map(r=>r.result.receiptId).filter(Boolean);
          const calls=(run.usage.receipts||[]);
          if(run.status==='REVIEW_READY'&&(!toolReceipts.length||!calls.length||!run.report))fail('INVALID_LIVE_RUN');
          entry={armId:arm.id,status:['FAILED','UNKNOWN_EXECUTION','SUPPRESSED','CANCELLED'].includes(run.status)?'FAILED':['REVIEW_READY','NEEDS_HUMAN','NEEDS_DEFINITION'].includes(run.status)?'COMPLETED_WITH_REVIEW_REQUIRED':'INCOMPLETE',
            runStatus:run.status,runId:run.id,run,toolExecuted:toolReceipts.length>0,toolReceipts,queryCount:run.usage.queries,
            modelCalls:run.usage.modelCalls,rounds:run.rounds.length,humanQuestions:run.report?.questions||run.questions||[],
            finalReport:run.report||null,route:run.route||null,
            memoryProviderResponseCount:calls.filter(c=>c.memoryInjection?.status==='PROVIDER_RESPONDED'&&c.memoryInjection?.memoryIds?.length).length,
            promptTokens:calls.every(c=>Number.isInteger(c.promptTokens))?calls.reduce((n,c)=>n+c.promptTokens,0):null,
            completionTokens:calls.every(c=>Number.isInteger(c.completionTokens))?calls.reduce((n,c)=>n+c.completionTokens,0):null,
            estimatedCny:calls.every(c=>Number.isFinite(c.estimatedPeakCny))?calls.reduce((n,c)=>n+c.estimatedPeakCny,0):null,
            answeredByModelOnly:run.status==='REVIEW_READY',independentAnswerJudgment:'PENDING_HUMAN_REVIEW'};
          if (!arm.withMemory && calls.some(c=>c.memoryInjection?.memoryIds?.length)) fail('NO_MEMORY_ISOLATION_FAILED');
        }
      } catch(error) { entry={armId:arm.id,status:'FAILED',error:/^[A-Z][A-Z0-9_]{0,90}$/.test(error.code||'')?error.code:'EVALUATION_EXECUTION_FAILED'}; }
      entry.durationMs=Date.now()-start;receipt.results.push(entry);await persist(structuredClone(receipt));
    }
  }
  await Promise.all(Array.from({length:Math.min(maxConcurrency,receipt.arms.length)},worker));
  receipt.completedAt=new Date().toISOString();receipt.status=receipt.results.every(r=>r.status==='COMPLETED_WITH_REVIEW_REQUIRED')?'COMPLETED_PENDING_HUMAN_REVIEW':'PARTIAL_OR_FAILED';
  await persist(receipt);return receipt;
}

function table(result) {
  if (!result?.records || !result.columns) return '<p>没有取得已验证的数据返回。</p>';
  const cols=result.columns;
  return `<p>原始返回 ${result.records.length} 行；下方最多展示200行，完整数据保存在本轮JSON回执。</p><div class="scroll"><table><thead><tr>${cols.map(c=>`<th>${escape(c)}</th>`).join('')}</tr></thead><tbody>${result.records.slice(0,200).map(row=>`<tr>${cols.map((c,i)=>`<td>${escape(Array.isArray(row)?row[i]:row[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/** Private review artifact. Escaped retained requests, data and full reports are the deliverable. */
export function renderLiveEvaluation(receipt) {
  const sections=[...new Set(receipt.arms.map(a=>a.caseId))].map(caseId=>{
    const arms=receipt.arms.filter(a=>a.caseId===caseId);
    const differences=['deepseek','mimo'].map(provider=>{
      const selected=arms.filter(a=>a.providerId===provider).map(a=>({arm:a,result:receipt.results.find(r=>r.armId===a.id)}));
      const plain=selected.find(x=>!x.arm.withMemory)?.result,memory=selected.find(x=>x.arm.withMemory)?.result;
      const queries=row=>(row?.run?.rounds||[]).filter(r=>r.result?.status==='VERIFIED').map(r=>r.result.queryHash);
      const rewrites=row=>(row?.run?.rounds||[]).map(r=>r.plan?.delperQuery).filter(Boolean);
      return `<tr><td>${provider}</td><td>${escape(plain?.runStatus||plain?.status||'NOT_RUN')} → ${escape(memory?.runStatus||memory?.status||'NOT_RUN')}</td><td>${escape(plain?.queryCount??'—')} → ${escape(memory?.queryCount??'—')}</td><td>${JSON.stringify(queries(plain))===JSON.stringify(queries(memory))?'查询方案相同':'查询方案或轮次不同'}</td><td>${JSON.stringify(rewrites(plain))===JSON.stringify(rewrites(memory))?'改写相同':'改写不同'}</td><td>${escape(plain?.humanQuestions?.length??'—')} → ${escape(memory?.humanQuestions?.length??'—')}</td><td>${escape(plain?.estimatedCny??'未知')} → ${escape(memory?.estimatedCny??'未知')}</td></tr>`;
    }).join('');
    return `<section><h2>${escape(caseId)}</h2><p>${escape(arms[0].case.question)}</p><h3>无 Memory → 有 Memory：可核对差异</h3><div class="scroll"><table><thead><tr><th>模型</th><th>停止状态</th><th>查数次数</th><th>实际查询路径</th><th>Query改写</th><th>人工问题数</th><th>估算费用</th></tr></thead><tbody>${differences}</tbody></table></div><p>路径相同不代表记忆无效；改写不同也不代表更好。正确性和必要追问由原始返回与报告共同评阅。</p><div class="grid">${arms.map(arm=>{
      const row=receipt.results.find(r=>r.armId===arm.id),run=row?.run;
      return `<article><h3>${escape(arm.providerId)} · ${arm.withMemory?'有Memory':'无Memory'}</h3><p>${escape(row?.runStatus||row?.status||'NOT_RUN')} ${escape(row?.error||row?.reason||'')}</p><p>规划/复核 ${escape(row?.modelCalls??'—')} 次 · 查数 ${escape(row?.queryCount??'—')} 次 · ${escape(row?.durationMs??'—')}ms · 估算 ¥${escape(row?.estimatedCny??'未知')}</p><p>共同输入 ${escape(arm.parityHash)}</p><details open><summary>分流与原始资料</summary><pre>${escape(JSON.stringify({route:run?.route,context:run?.questionContext,originalQuestion:run?.question},null,2))}</pre></details>${(run?.rounds||[]).map(round=>`<details><summary>第${escape(round.index)}轮：Query、实际返回与决策</summary><h4>实际请求</h4><pre>${escape(round.plan?.delperQuery||'未记录标准Query')}</pre><pre>${escape(JSON.stringify({plan:round.plan,request:round.result?.request,receiptId:round.result?.receiptId,queryHash:round.result?.queryHash,coverage:round.result?.coverage},null,2))}</pre>${table(round.result)}<h4>本轮判断</h4><pre>${escape(JSON.stringify(round.review,null,2))}</pre></details>`).join('')}<details open><summary>最终报告全文</summary><pre>${escape(JSON.stringify(row?.finalReport||{status:'NOT_AVAILABLE'},null,2))}</pre></details><details><summary>Memory与真实调用回执</summary><pre>${escape(JSON.stringify({memorySnapshot:run?.memorySnapshot,receipts:run?.usage?.receipts},null,2))}</pre></details></article>`;
    }).join('')}</div><p>评阅：口径/对象/日期是否正确；是否回答原问；人工补充是否必要；有无无依据归因；费用与轮次是否值得。不能仅用答案长短或调用次数判优。</p></section>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline'"><title>真实查数流程评测</title><style>body{font:14px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;color:#272c35;margin:28px;background:white}h1{font-size:24px}h2{font-size:20px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}article{border:1px solid #e3e7ed;border-radius:8px;padding:16px;min-width:0}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}details{border-top:1px solid #e3e7ed;margin-top:12px;padding-top:10px}summary{color:#346eff;cursor:pointer}.scroll{overflow:auto;max-height:420px}table{border-collapse:collapse;font-size:12px}td,th{padding:6px;border:1px solid #e3e7ed}section{margin-top:24px}article h3{font-size:16px}@media(max-width:1200px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:650px){.grid{grid-template-columns:1fr}}</style><h1>真实查数流程评测</h1><p>${escape(receipt.runId)} · ${escape(receipt.status)}</p><p>每组独立规划、真实只读执行和复核；结果和报告均保留。未查询、失败、人工补充和待审明确区分。当前回溯试跑，不宣称历史时点已拥有后来获得的记忆。费用为估算，非服务商账单；报告正确性待评阅。</p>${sections}</html>`;
}
