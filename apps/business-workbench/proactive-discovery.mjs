import { diagnosticCapabilities, humanInputBoundary, modelDiagnosticRoute } from './diagnostic-routing.mjs';
/** Bounded diagnostic loop. Transports, credentials and persistence are injected. */
const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const terminal = new Set(['REVIEW_READY', 'NEEDS_HUMAN', 'NEEDS_DEFINITION', 'FAILED', 'CANCELLED', 'SUPPRESSED', 'UNKNOWN_EXECUTION']);
const now = () => new Date().toISOString();

export class DiagnosticError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function positive(value) { return Number.isInteger(value) && value > 0; }
function denied(error) { return [401, 403, 'FORBIDDEN', 'UNAUTHORIZED'].includes(error?.status) || ['ACCESS_DENIED', 'PERMISSION_DENIED', 'SOURCE_REVOKED', 'SOURCE_POLICY_CHANGED', 'UNAUTHORIZED', 'FORBIDDEN'].includes(error?.code); }
const knownQueryFailures = new Set(['RATE_LIMITED', 'QUERY_FAILED', 'TOOL_FAILED', 'QUERY_COVERAGE_LIMIT','NORMALIZED_QUERY_REQUIRED','REQUEST_RECIPE_MISMATCH','TRACE_UNAVAILABLE','RECIPE_NOT_ALLOWED','RECIPE_NOT_READONLY','SEMANTIC_ROUTE_REQUIRED']);
function invalidDefinition(source) {
  return !object(source) || !text(source.id) || !text(source.version) || source.definitionVerified !== true
    || !(text(source.definition) || object(source.definition) && Object.keys(source.definition).length)
    || !Array.isArray(source.recipes) || !source.recipes.length
    || source.recipes.some(recipe => !object(recipe) || !text(recipe.id))
    || new Set(source.recipes.map(recipe => recipe.id)).size !== source.recipes.length;
}
function verifiedResult(value, maximumRows) {
  return object(value) && value.status === 'VERIFIED' && text(value.receiptId) && text(value.queryHash)
    && Array.isArray(value.columns) && value.columns.length > 0 && value.columns.length <= 200
    && value.columns.every(column => text(column) || object(column) && text(column.name ?? column.field ?? column.key))
    && Array.isArray(value.records) && value.records.length <= maximumRows
    && value.records.every(row => object(row) || Array.isArray(row));
}
/** Answer completeness is independent from whether a draft can be displayed. */
export function answerCoverageResult(value) {
  if(!object(value)||!['answered','partial','unanswered'].includes(value.status)
    ||!['covered','missing'].every(key=>Array.isArray(value[key])&&value[key].length<=100&&value[key].every(row=>text(row)&&row.length<=3000)))return null;
  if(value.status==='answered'&&(!value.covered.length||value.missing.length)||value.status!=='answered'&&!value.missing.length)return null;
  return {status:value.status,covered:copy(value.covered),missing:copy(value.missing)};
}
export function enforceAnswerCoverage(answer,source,rounds) {
  if(!object(answer))return answer;
  const coverage=answerCoverageResult(answer.answerCoverage);
  if(!coverage)return answer;
  answer.answerCoverage=coverage;
  if(coverage.status!=='answered'&&['ready','continue'].includes(answer.decision)){
    const used=new Set(rounds.filter(round=>round.result?.status==='VERIFIED').map(round=>round.plan?.recipeId));
    const canContinue=source.recipes.some(recipe=>recipe.id===answer.nextRecipeId&&!used.has(recipe.id))&&text(answer.nextQueryReason);
    answer.decision=canContinue?'continue':'needs_human';
    answer.summary=canContinue?'已形成部分发现；仍有明确方案可以继续核查。':'已形成部分发现，尚未完整回答原问题。';
    if(!canContinue){answer.questions=copy(coverage.missing);answer.missingCategory=answer.missingCategory||'business_fact';}
  }
  return answer;
}

function reviewResult(value, receiptIds) {
  if (!object(value) || !['continue', 'ready', 'needs_human'].includes(value.decision) || !text(value.summary)
    || !Array.isArray(value.findings) || value.findings.length > 100
    || value.findings.some(finding => !object(finding) || !text(finding.text) || !Array.isArray(finding.evidenceIds)
      || !finding.evidenceIds.length || finding.evidenceIds.some(id => !receiptIds.has(id)))
    || (value.decision === 'ready' && value.findings.length === 0)
    || (value.decision === 'needs_human' && (!Array.isArray(value.questions) || !value.questions.some(text)))) return null;
  if(value.answerCoverage!==undefined&&!answerCoverageResult(value.answerCoverage))return null;
  // Charts are optional display proposals; only accept series that cite a real receipt.
  if (value.charts !== undefined && (!Array.isArray(value.charts) || value.charts.some(chart => !object(chart)
    || !Array.isArray(chart.evidenceIds) || !chart.evidenceIds.length || chart.evidenceIds.some(id => !receiptIds.has(id))))) return null;
  return { decision: value.decision, summary: value.summary,
    ...(value.answerCoverage?{answerCoverage:answerCoverageResult(value.answerCoverage)}:{}),
    ...(text(value.nextRecipeId)?{nextRecipeId:value.nextRecipeId,nextQueryReason:value.nextQueryReason}:{}),
    findings: value.findings.map(finding => ({ text: finding.text, evidenceIds: [...new Set(finding.evidenceIds)] })),
    hypotheses: Array.isArray(value.hypotheses) ? copy(value.hypotheses) : [],
    remaining: Array.isArray(value.remaining) ? copy(value.remaining) : [],
    questions: Array.isArray(value.questions) ? value.questions.filter(text) : [],
    missingCategory: ['business_fact','metric_definition','source_access','query_capability'].includes(value.missingCategory) ? value.missingCategory : 'unspecified',
    ...(value.charts ? { charts: copy(value.charts) } : {}),
    // A model decision and existing citations alone never certify business causality.
    causalStatus: 'NOT_INDEPENDENTLY_VERIFIED' };
}

/**
 * Every verified query's columns/records remain in run.rounds for the next plan
 * and review. Returned run is separate from the supplied snapshot. Ready means
 * a grounded draft is reviewable, not that an independently verified cause exists.
 */
export async function runDiagnostic({ run: initial, source, dependencies = {}, signal } = {}) {
  if (!object(initial) || !text(initial.id) || !text(initial.question) || !Array.isArray(initial.rounds)
    || !object(initial.limits) || !['maxRounds', 'maxQueries', 'maxModelCalls'].every(key => positive(initial.limits[key]))
    || !object(initial.usage) || !['modelCalls', 'queries'].every(key => Number.isInteger(initial.usage[key]) && initial.usage[key] >= 0)
    || !['plan', 'query', 'review', 'checkpoint', 'authorize'].every(key => typeof dependencies[key] === 'function')) throw new DiagnosticError('INVALID_DIAGNOSTIC_CONFIG');
  const run = copy(initial);
  const definition = copy(source);
  const checkpoint = async () => {
    run.updatedAt = now();
    try { await dependencies.checkpoint(copy(run)); }
    catch { throw new DiagnosticError('CHECKPOINT_FAILED'); }
  };
  const stopped = async (status, code, extra = {}) => {
    run.status = status;
    run.error = { code };
    Object.assign(run, extra);
    if (status === 'SUPPRESSED') run.report = null;
    await checkpoint();
    return run;
  };
  const allowed = async () => {
    if (signal?.aborted) throw new DiagnosticError('CANCELLED');
    let result;
    try { result = await dependencies.authorize(copy(run), copy(definition)); }
    catch { throw new DiagnosticError('SOURCE_POLICY_CHANGED'); }
    if (result === false || result?.allowed === false) throw new DiagnosticError('SOURCE_POLICY_CHANGED');
    if (signal?.aborted) throw new DiagnosticError('CANCELLED');
  };
  const latestReview = () => [...run.rounds].reverse().find(round => round.review)?.review;
  const captureCall = (value, stage, index) => {
    const receipt = value?.callReceipt;
    if (!object(receipt)) return null;
    const count = value => Number.isInteger(value) && value >= 0 ? value : null;
    const saved = { stage, round: index, model: text(receipt.model) ? receipt.model.slice(0, 120) : null,
      promptTokens: count(receipt.promptTokens), completionTokens: count(receipt.completionTokens),
      estimatedPeakCny: Number.isFinite(receipt.estimatedPeakCny) && receipt.estimatedPeakCny >= 0 ? receipt.estimatedPeakCny : null,
      priceBasis: typeof receipt.priceBasis === 'string' ? receipt.priceBasis.slice(0, 500) : null,
      ...(object(receipt.normalizedQuery)?{normalizedQuery:copy(receipt.normalizedQuery)}:{}),
      ...(object(receipt.requestAudit)?{requestAudit:copy(receipt.requestAudit)}:{}),
      ...(object(receipt.memoryInjection)?{memoryInjection:copy(receipt.memoryInjection)}:{}) };
    if (!Array.isArray(run.usage.receipts)) run.usage.receipts = [];
    run.usage.receipts.push(saved);
    return saved;
  };
  const reserveModel = async (stage, index) => {
    run.capabilityContext = diagnosticCapabilities(definition, run.rounds);
    if (!dependencies.reserveModel) return true;
    const result = await dependencies.reserveModel({ run: copy(run), stage, round: index });
    run.budget = copy(result.budget);
    if (!result.allowed) { run.pendingReason = result.reason || 'DAILY_BUDGET_LIMIT'; return false; }
    delete run.pendingReason;
    run.modelReservation = { id: result.reservation.id, stage, round: index };
    return true;
  };
  const modelCall = async (stage, index, invoke) => {
    const settle = async (value, notDispatched = false) => {
      if (!dependencies.settleModel || !run.modelReservation) return;
      const result = await dependencies.settleModel({ reservationId: run.modelReservation.id, receipt: value?.callReceipt, notDispatched });
      run.budget = copy(result.budget);
      delete run.modelReservation;
    };
    let answer;
    try { answer = await invoke(); }
    catch (error) {
      captureCall(error, stage, index);
      // Only these known local preflight failures prove that no request was sent.
      await settle(error, ['MODEL_CONTEXT_LIMIT','EVIDENCE_COMPACT_FAILED','CREDENTIAL_UNAVAILABLE'].includes(error?.code));
      throw error;
    }
    const callReceipt = captureCall(answer, stage, index);
    await settle(answer);
    return { answer, callReceipt };
  };
  const report = (status, code) => ({ status, summary: latestReview()?.summary ?? '分析尚未完成。',
    findings: copy(latestReview()?.findings ?? []), hypotheses: copy(latestReview()?.hypotheses ?? []),
    answerCoverage:copy(latestReview()?.answerCoverage??null),
    remaining: copy(latestReview()?.remaining ?? []), questions: copy(latestReview()?.questions ?? []),
    causalStatus: 'NOT_INDEPENDENTLY_VERIFIED', ...(latestReview()?.charts ? { charts: copy(latestReview().charts) } : {}),
    ...(code ? { boundary: code } : {}), receiptIds: run.rounds.filter(round => round.result?.status === 'VERIFIED').map(round => round.result.receiptId) });
  const pause = async code => {
    await allowed();
    return stopped('PAUSED_LIMIT', code, { report: report('PARTIAL', code) });
  };
  try {
    await allowed();
    // An interrupted external query may already have executed. Never silently replay.
    if (run.inflight || run.status === 'RUNNING_QUERY' || run.rounds.some(round => round.status === 'QUERYING')) {
      return stopped('UNKNOWN_EXECUTION', 'QUERY_EXECUTION_UNCONFIRMED', { report: report('PARTIAL', 'QUERY_EXECUTION_UNCONFIRMED') });
    }
    if (invalidDefinition(definition) || run.sourceId !== definition.id) return stopped('NEEDS_DEFINITION', 'SOURCE_DEFINITION_REQUIRED', { questions: ['请补充或核对指标口径、数据来源和可执行查询方案。'] });
    if (run.sourceVersion !== undefined && run.sourceVersion !== definition.version) return stopped('NEEDS_DEFINITION', 'SOURCE_DEFINITION_CHANGED', { report: null, questions: ['取数口径版本已变化，请重新核对后启动新分析。'] });
    run.sourceVersion = definition.version;
    if (terminal.has(run.status)) return run;
    if (run.rounds.some(round => ['PLANNING', 'REVIEWING'].includes(round.status)) || ['PLANNING', 'RUNNING_REVIEW'].includes(run.status)) return pause('MODEL_EXECUTION_UNCONFIRMED');
    delete run.error;
    while (true) {
      await allowed();
      let round = run.rounds.find(item => ['PLANNED', 'QUERIED'].includes(item.status));
      if (round && round.index > run.limits.maxRounds) return pause('ROUND_LIMIT');
      if (!round) {
        if (run.rounds.length >= run.limits.maxRounds) return pause('ROUND_LIMIT');
        if (run.usage.queries >= run.limits.maxQueries) return pause('QUERY_LIMIT');
        if (run.usage.modelCalls >= run.limits.maxModelCalls) return pause('MODEL_CALL_LIMIT');
        if (!await reserveModel('plan', run.rounds.length + 1)) return pause('DAILY_BUDGET_LIMIT');
        run.status = 'PLANNING';
        run.usage.modelCalls++;
        await checkpoint();
        const planned = await modelCall('plan', run.rounds.length + 1, () => dependencies.plan({ run: copy(run), source: copy(definition) }));
        const plan = planned.answer;
        run.planningHistory=[...(run.planningHistory||[]),{round:run.rounds.length+1,at:now(),plan:copy(Object.fromEntries(['decision','route','completeness','delperQuery','queryScope','recipeId','recipeFit','reason','hypothesis','questions','missingCategory','decisionOverride'].filter(key=>plan?.[key]!==undefined).map(key=>[key,plan[key]]))),...(planned.callReceipt?{callReceipt:planned.callReceipt}:{})}];
        await allowed();
        if (!object(plan) || !['query', 'needs_human'].includes(plan.decision) || !text(plan.reason)) return stopped('FAILED', 'INVALID_QUERY_PLAN');
        if (plan.route) {
          const routed=modelDiagnosticRoute(plan,definition,run.questionContext);
          if(!routed)return stopped('FAILED','MODEL_INVALID_ROUTE');
          const fullLimits=run.route?.fullLimits||copy(run.limits);
          run.route={...routed,fullLimits};
          run.limits=routed.fastPath?{...fullLimits,maxRounds:Math.max(1,run.rounds.length+1),maxQueries:Math.max(1,run.usage.queries+1)}:copy(fullLimits);
        }
        if (plan.decision === 'query' && run.route?.kind==='needs_context')return stopped('NEEDS_HUMAN','BUSINESS_INPUT_REQUIRED',{questions:plan.questions||run.route.missing});
        if (plan.decision === 'needs_human') {
          if (!Array.isArray(plan.questions) || !plan.questions.some(text)) return stopped('FAILED', 'INVALID_HUMAN_QUESTION');
          run.questions = plan.questions.filter(text);
          run.humanInput = humanInputBoundary(run.questions, plan.missingCategory, run.capabilityContext);
          if(run.humanInput.capabilityCheck==='EXISTING_CAPABILITIES_REQUIRE_REVIEW'&&!run.capabilityRecheckUsed){
            run.capabilityRecheckUsed=true;run.status='CONTINUE';await checkpoint();continue;
          }
          return stopped('NEEDS_HUMAN', 'BUSINESS_INPUT_REQUIRED', { report: { ...report('NEEDS_HUMAN'), questions: run.questions } });
        }
        const recipe = definition.recipes.find(item => item.id === plan.recipeId);
        if (recipe && run.route?.fastPath && !run.route.compatibleRecipeIds.includes(recipe.id) && run.route.fullLimits) {
          run.limits = copy(run.route.fullLimits); run.route.fastPath = false; run.route.reason = '模型选择了非短流程方案，恢复完整分析轮次。';
        }
        if (!recipe) return stopped('NEEDS_DEFINITION', 'UNAPPROVED_RECIPE', { questions: ['当前问题尚未匹配已核验的取数口径，请补充或核对查询定义。'] });
        if (run.rounds.some(item => item.result?.status === 'VERIFIED' && item.plan?.recipeId === recipe.id)) return pause('DUPLICATE_QUERY_PLAN');
        round = { index: run.rounds.length + 1, status: 'PLANNED',
          plan: { decision: 'query', recipeId: recipe.id, reason: plan.reason,
            ...(typeof plan.delperQuery==='string'?{delperQuery:plan.delperQuery}:{}),
            ...(object(plan.queryScope)?{queryScope:copy(plan.queryScope)}:{}),
            ...(object(plan.recipeFit)?{recipeFit:copy(plan.recipeFit)}:{}),
            ...(object(plan.completeness)?{completeness:copy(plan.completeness)}:{}),
            ...(object(plan.route)?{route:copy(plan.route)}:{}), hypothesis: typeof plan.hypothesis === 'string' ? plan.hypothesis : '', ...(planned.callReceipt ? { callReceipt: planned.callReceipt } : {}) }, startedAt: now() };
        run.rounds.push(round);
        run.status = 'PLANNED';
        await checkpoint();
      }
      if (round.status === 'PLANNED') {
        if (!definition.recipes.some(recipe => recipe.id === round.plan.recipeId)) return stopped('NEEDS_DEFINITION', 'UNAPPROVED_RECIPE');
        if (run.usage.queries >= run.limits.maxQueries) return pause('QUERY_LIMIT');
        await allowed();
        if(dependencies.queryPreflight){try{await dependencies.queryPreflight({run:copy(run),source:copy(definition),recipeId:round.plan.recipeId});}catch(error){
          if(['REQUEST_RECIPE_MISMATCH','NORMALIZED_QUERY_REQUIRED','QUERY_SCOPE_REQUIRED'].includes(error?.code)){round.status='BLOCKED';return stopped('NEEDS_DEFINITION',error.code,{questions:['当前问题的日期、维度或口径与已核验方案不一致，请核对来源或补充匹配方案。'],report:report('PARTIAL',error.code)});}throw error;
        }}
        run.usage.queries++;
        run.status = 'RUNNING_QUERY';
        round.status = 'QUERYING';
        run.inflight = { round: round.index, recipeId: round.plan.recipeId, startedAt: now() };
        await checkpoint();
        let result;
        try { result = await dependencies.query({ run: copy(run), source: copy(definition), recipeId: round.plan.recipeId, signal }); }
        catch (error) {
          if (signal?.aborted) return stopped('CANCELLED', 'CANCELLED');
          if (denied(error)) return stopped('SUPPRESSED', 'SOURCE_POLICY_CHANGED');
          if (knownQueryFailures.has(error?.code) || error?.status === 429) {
            delete run.inflight;
            round.status = 'FAILED';
            return stopped('FAILED', error.status === 429 ? 'RATE_LIMITED' : error.code, { report: report('PARTIAL', error.status === 429 ? 'RATE_LIMITED' : error.code) });
          }
          return stopped('UNKNOWN_EXECUTION', 'QUERY_EXECUTION_UNCONFIRMED', { report: report('PARTIAL', 'QUERY_EXECUTION_UNCONFIRMED') });
        }
        // Receipt is transport-owned; plan/review return values cannot forge it.
        if (!verifiedResult(result, positive(run.limits.maxRows) ? run.limits.maxRows : 1000)
          || run.rounds.some(item => item !== round && item.result?.receiptId === result.receiptId)) {
          delete run.inflight;
          round.status = 'FAILED';
          return stopped(denied(result) ? 'SUPPRESSED' : 'FAILED', denied(result) ? 'SOURCE_POLICY_CHANGED' : 'INVALID_QUERY_RESULT');
        }
        round.result = { receiptId: result.receiptId, status: result.status, columns: copy(result.columns), records: copy(result.records), queryHash: result.queryHash,
          ...(object(result.request)?{request:copy(result.request)}:{}),sourceVersion:result.sourceVersion||definition.version,
          ...(result.coverage !== undefined ? { coverage: copy(result.coverage) } : {}) };
        round.status = 'QUERIED';
        delete run.inflight;
        run.status = 'QUERIED';
        await checkpoint();
        await allowed();
      }
      if (run.usage.modelCalls >= run.limits.maxModelCalls) return pause('MODEL_CALL_LIMIT');
      await allowed();
      if (!await reserveModel('review', round.index)) return pause('DAILY_BUDGET_LIMIT');
      run.usage.modelCalls++;
      round.status = 'REVIEWING';
      run.status = 'RUNNING_REVIEW';
      await checkpoint();
      const reviewed = await modelCall('review', round.index, () => dependencies.review({ run: copy(run), source: copy(definition), round: copy(round) }));
      const proposed = reviewed.answer;
      await allowed();
      const receiptIds = new Set(run.rounds.filter(item => item.result?.status === 'VERIFIED').map(item => item.result.receiptId));
      const review = reviewResult(enforceAnswerCoverage(proposed,definition,run.rounds), receiptIds);
      if (!review) { round.status = 'FAILED'; return stopped('FAILED', 'INVALID_GROUNDED_REVIEW'); }
      if(review.decision==='ready'&&review.questions.length&&definition.recipes.every(recipe=>run.rounds.some(item=>item.result?.status==='VERIFIED'&&item.plan?.recipeId===recipe.id))){
        review.decision='needs_human';
        review.summary='已形成阶段报告；继续解释原问题需要补充业务信息或取数能力。';
      }
      if(review.decision==='needs_human'&&!review.answerCoverage&&review.missingCategory==='query_capability'&&run.capabilityContext.recipes.some(recipe=>!recipe.queried)&&!run.capabilityRecheckUsed){
        run.capabilityRecheckUsed=true;review.decision='continue';review.remaining=[...review.remaining,'请求人工前重新核对已有未查询能力；未授权来源仍不可访问。'];
      }
      if (review.decision === 'continue' && run.route?.fastPath && run.route.fullLimits) {
        run.limits = copy(run.route.fullLimits); run.route.fastPath = false; run.route.reason = '复核发现问题仍需继续核查，恢复完整分析轮次。';
      }
      round.review = review;
      if (reviewed.callReceipt) round.review.callReceipt = reviewed.callReceipt;
      round.status = 'REVIEWED';
      round.completedAt = now();
      run.report = report(review.decision === 'ready' ? 'REVIEW_READY' : review.decision === 'needs_human' ? 'NEEDS_HUMAN' : 'PARTIAL');
      run.status = review.decision === 'ready' ? 'REVIEW_READY' : review.decision === 'needs_human' ? 'NEEDS_HUMAN' : 'CONTINUE';
      if (review.decision === 'needs_human') {
        run.questions = review.questions;
        run.humanInput = humanInputBoundary(review.questions, review.missingCategory, run.capabilityContext);
      }
      await allowed();
      await checkpoint();
      if (review.decision !== 'continue') return run;
    }
  } catch (error) {
    if (error?.code === 'CHECKPOINT_FAILED') throw error;
    if (signal?.aborted || error?.code === 'CANCELLED') return stopped('CANCELLED', 'CANCELLED');
    if (['BUDGET_BUSY','BUDGET_INVALID_LEDGER','BUDGET_LEDGER_LIMIT'].includes(error?.code)) return pause(error.code);
    if (denied(error) || error?.code === 'SOURCE_POLICY_CHANGED') return stopped('SUPPRESSED', 'SOURCE_POLICY_CHANGED');
    const safeStageCodes=new Set(['MODEL_CONTEXT_LIMIT','EVIDENCE_COMPACT_FAILED','UNVERIFIED_FACT_REFERENCE','UNVERIFIED_SUMMARY_NUMBER','MODEL_INCOMPLETE','MODEL_MISMATCH','MODEL_INVALID','CREDENTIAL_UNAVAILABLE','UPSTREAM_FAILED','RATE_LIMITED','MODEL_INVALID_QUERY_REWRITE','MODEL_INVALID_QUERY_SCOPE','MODEL_INVALID_ANSWER_COVERAGE','REQUEST_RECIPE_MISMATCH']);
    return stopped('FAILED', safeStageCodes.has(error?.code)?error.code:'DIAGNOSTIC_STAGE_FAILED');
  }
}
