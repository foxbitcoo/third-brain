import test from 'node:test';
import assert from 'node:assert/strict';
import { runDiagnostic, DiagnosticError } from '../proactive-discovery.mjs';

const source = { id: 'activity', title: 'Activity', version: 'v1', definitionVerified: true, definition: 'Same metric population and comparison dates', recipes: [{ id: 'overview', title: 'Numerator and denominator' }, { id: 'version', title: 'Version breakdown' }] };
const initial = () => ({ id: 'run-1', question: 'Why did conversion decline?', trigger: { kind: 'manual_question' }, sourceId: source.id,
  status: 'QUEUED', rounds: [], businessContext: [], limits: { maxRounds: 3, maxQueries: 3, maxModelCalls: 7 }, usage: { modelCalls: 0, queries: 0 }, createdAt: '2026-10-17T00:00:00Z' });
function harness(overrides = {}) {
  const saved = [], calls = { plan: 0, query: 0, review: 0, authorize: 0 };
  return { saved, calls, deps: {
    checkpoint: async run => { saved.push(structuredClone(run)); }, authorize: async () => { calls.authorize++; return true; },
    plan: async ({ run }) => { calls.plan++; return { decision: 'query', recipeId: run.rounds.length ? 'version' : 'overview', reason: 'Separate the competing hypotheses', hypothesis: 'Population or within-version decline' }; },
    query: async () => { calls.query++; return { receiptId: `q${calls.query}`, status: 'VERIFIED', columns: ['cohort', 'value'], records: [['example', 12]], queryHash: `hash${calls.query}` }; },
    review: async ({ round }) => { calls.review++; return { decision: 'ready', summary: 'A bounded finding is available.', findings: [{ text: 'The numerator changed.', evidenceIds: [round.result.receiptId] }], hypotheses: [], remaining: [] }; }, ...overrides,
  } };
}

test('real result enters the next plan and review, then the grounded draft becomes ready', async () => {
  const h = harness();
  const plan = h.deps.plan, review = h.deps.review;
  h.deps.plan = async input => {
    if (input.run.rounds.length) assert.deepEqual(input.run.rounds[0].result.records, [['example', 12]]);
    return plan(input);
  };
  h.deps.review = async input => {
    assert.deepEqual(input.round.result.columns, ['cohort', 'value']);
    const result = await review(input);
    return { ...result, decision: input.round.index === 1 ? 'continue' : 'ready' };
  };
  const base = initial();
  const result = await runDiagnostic({ run: base, source, dependencies: h.deps });
  assert.equal(result.status, 'REVIEW_READY');
  assert.equal(result.rounds.length, 2);
  assert.deepEqual(result.usage, { modelCalls: 4, queries: 2 });
  assert.deepEqual(result.report.receiptIds, ['q1', 'q2']);
  assert.equal(result.report.causalStatus, 'NOT_INDEPENDENTLY_VERIFIED');
  assert.equal(base.rounds.length, 0);
  assert.ok(h.calls.authorize >= 12);
  assert.ok(h.saved.find(row => row.status === 'RUNNING_QUERY' && row.inflight && row.rounds[0].status === 'QUERYING'));
  assert.equal(h.saved.at(-1).status, 'REVIEW_READY');
});

test('a true business question goes to human without inventing a query', async () => {
  const h = harness({ plan: async () => ({ decision: 'needs_human', reason: 'Two different approved definitions remain possible', questions: ['Which population is intended?'] }) });
  const result = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
  assert.equal(result.status, 'NEEDS_HUMAN');
  assert.deepEqual(result.questions, ['Which population is intended?']);
  assert.equal(result.usage.modelCalls, 1);
  assert.equal(result.usage.queries, 0);
});

test('a report with unresolved business questions stays human-blocked after approved cuts are exhausted',async()=>{
 const h=harness({review:async({round})=>({decision:'ready',summary:'A report exists',findings:[{text:'Verified count',evidenceIds:[round.result.receiptId]}],questions:['Which release actually happened?']})});
 const result=await runDiagnostic({run:initial(),source:{...source,recipes:source.recipes.slice(0,1)},dependencies:h.deps});
 assert.equal(result.status,'NEEDS_HUMAN');assert.equal(result.report.status,'NEEDS_HUMAN');assert.equal(result.usage.queries,1);
});

test('missing definitions and unapproved recipes cannot execute', async () => {
  for (const invalid of [{ ...source, definitionVerified: false }, { ...source, definition: '' }, { ...source, recipes: [] }, { ...source, id: 'wrong-source' }]) {
    const h = harness();
    assert.equal((await runDiagnostic({ run: initial(), source: invalid, dependencies: h.deps })).status, 'NEEDS_DEFINITION');
    assert.equal(h.calls.plan + h.calls.query, 0);
  }
  const h = harness({ plan: async () => ({ decision: 'query', recipeId: 'DROP_TABLE', reason: 'Untrusted suggestion' }) });
  const result = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
  assert.equal(result.status, 'NEEDS_DEFINITION');
  assert.equal(h.calls.query, 0);
});

test('model limit after a query preserves rows and resumes at review without another query', async () => {
  const h = harness();
  const run = initial(); run.limits.maxModelCalls = 1;
  const paused = await runDiagnostic({ run, source, dependencies: h.deps });
  assert.equal(paused.status, 'PAUSED_LIMIT');
  assert.equal(paused.rounds[0].status, 'QUERIED');
  assert.deepEqual(paused.rounds[0].result.records, [['example', 12]]);
  paused.limits.maxModelCalls = 2;
  const result = await runDiagnostic({ run: paused, source, dependencies: h.deps });
  assert.equal(result.status, 'REVIEW_READY');
  assert.equal(h.calls.query, 1);
  assert.equal(h.calls.plan, 1);
});

test('round/query boundaries preserve partial findings and do not ask humans for artificial limits', async () => {
  for (const limit of ['maxRounds', 'maxQueries']) {
    const h = harness();
    const review = h.deps.review;
    h.deps.review = async input => ({ ...await review(input), decision: 'continue' });
    const run = initial(); run.limits[limit] = 1;
    const result = await runDiagnostic({ run, source, dependencies: h.deps });
    assert.equal(result.status, 'PAUSED_LIMIT');
    assert.equal(result.report.findings.length, 1);
    assert.equal(result.usage.queries, 1);
    assert.equal(result.usage.modelCalls, 2);
    assert.equal(result.questions, undefined);
  }
});

test('empty or fabricated receipts fail instead of becoming a report', async () => {
  for (const value of [null, {}, { receiptId: '', status: 'VERIFIED', columns: [], records: [] }, { receiptId: 'q', queryHash: 'h', status: 'FAILED', columns: ['a'], records: [] }]) {
    const h = harness({ query: async () => value });
    const result = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.error.code, 'INVALID_QUERY_RESULT');
    assert.equal(h.calls.review, 0);
  }
});

test('zero rows are retained as an empty verified result rather than manufactured zeros', async () => {
  const h = harness({ query: async () => ({ receiptId: 'empty', queryHash: 'hash', status: 'VERIFIED', columns: ['count'], records: [], coverage: { complete: false } }) });
  const result = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
  assert.deepEqual(result.rounds[0].result.records, []);
  assert.equal(result.rounds[0].result.coverage.complete, false);
});

test('ready requires findings backed by actual query receipts; charts require them too', async () => {
  for (const bad of [
    { decision: 'ready', summary: 'Claim', findings: [] },
    { decision: 'ready', summary: 'Claim', findings: [{ text: 'Claim', evidenceIds: [] }] },
    { decision: 'ready', summary: 'Claim', findings: [{ text: 'Claim', evidenceIds: ['invented'] }] },
    { decision: 'ready', summary: 'Claim', findings: [{ text: 'Claim', evidenceIds: ['q1'] }], charts: [{ evidenceIds: ['invented'] }] },
    { decision: 'needs_human', summary: 'Unclear', findings: [], questions: [] },
  ]) {
    const h = harness({ review: async () => bad });
    const result = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.error.code, 'INVALID_GROUNDED_REVIEW');
  }
});

test('restarting an inflight query never executes it twice', async () => {
  const h = harness(); const run = initial();
  run.status = 'RUNNING_QUERY'; run.inflight = { round: 1, recipeId: 'overview' }; run.usage.queries = 1;
  run.rounds.push({ index: 1, status: 'QUERYING', plan: { recipeId: 'overview' } });
  const result = await runDiagnostic({ run, source, dependencies: h.deps });
  assert.equal(result.status, 'UNKNOWN_EXECUTION');
  assert.equal(h.calls.query + h.calls.plan + h.calls.review, 0);
  assert.ok(result.inflight);
});

test('uncertain query errors are sanitized and never automatically retried', async () => {
  const h = harness({ query: async () => { throw new Error('PRIVATE credential body timeout'); } });
  const result = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
  assert.equal(result.status, 'UNKNOWN_EXECUTION');
  assert.equal(result.usage.queries, 1);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  const again = await runDiagnostic({ run: result, source, dependencies: h.deps });
  assert.equal(again.usage.queries, 1);
});

test('source revocation before execution suppresses without spending', async () => {
  const h = harness({ authorize: async () => false });
  const result = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
  assert.equal(result.status, 'SUPPRESSED');
  assert.equal(result.report, null);
  assert.deepEqual(result.usage, { modelCalls: 0, queries: 0 });
});

test('source revocation during a paid response suppresses but retains the spent usage', async () => {
  let revoked = false;
  const h = harness({ authorize: async () => !revoked, review: async ({ round }) => { revoked = true; return { decision: 'ready', summary: 'Claim', findings: [{ text: 'Claim', evidenceIds: [round.result.receiptId] }] }; } });
  const result = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
  assert.equal(result.status, 'SUPPRESSED');
  assert.deepEqual(result.usage, { modelCalls: 2, queries: 1 });
  assert.equal(result.report, null);
});

test('a permission denial returned by the transport is suppressed', async () => {
  for (const denial of [{ status: 403 }, { code: 'FORBIDDEN' }]) {
    const h = harness({ query: async () => denial });
    const result = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
    assert.equal(result.status, 'SUPPRESSED');
    assert.equal(h.calls.review, 0);
  }
});

test('cancel before start costs nothing; cancel after query retains receipt and spending', async () => {
  const controller = new AbortController(); controller.abort();
  const h = harness();
  const cancelled = await runDiagnostic({ run: initial(), source, dependencies: h.deps, signal: controller.signal });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.deepEqual(cancelled.usage, { modelCalls: 0, queries: 0 });
  const mid = new AbortController(); const second = harness(); const query = second.deps.query;
  second.deps.query = async input => { const rows = await query(input); mid.abort(); return rows; };
  const result = await runDiagnostic({ run: initial(), source, dependencies: second.deps, signal: mid.signal });
  assert.equal(result.status, 'CANCELLED');
  assert.equal(result.rounds[0].result.receiptId, 'q1');
  assert.equal(result.usage.queries, 1);
  assert.equal(second.calls.review, 0);
});

test('persistence failure stops before sending any external query', async () => {
  const h = harness({ checkpoint: async run => { if (run.status === 'RUNNING_QUERY') throw new Error('PRIVATE disk error'); } });
  await assert.rejects(runDiagnostic({ run: initial(), source, dependencies: h.deps }), error => error instanceof DiagnosticError && error.code === 'CHECKPOINT_FAILED');
  assert.equal(h.calls.query, 0);
});

test('dependency responses cannot mutate prior persisted receipts or input run', async () => {
  const h = harness(); const plan = h.deps.plan;
  h.deps.plan = async input => { const answer = await plan(input); input.run.rounds.push({ result: { receiptId: 'forged' } }); return answer; };
  const result = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
  assert.deepEqual(result.report.receiptIds, ['q1']);
});

test('transport-known rejections clear inflight without replay or raw error exposure', async () => {
  for (const code of ['RATE_LIMITED', 'QUERY_FAILED', 'TOOL_FAILED', 'QUERY_COVERAGE_LIMIT']) {
    const h = harness({ query: async () => { const error = new Error('PRIVATE payload'); error.code = code; throw error; } });
    const result = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.error.code, code);
    assert.equal(result.inflight, undefined);
    assert.equal(result.usage.queries, 1);
    assert.equal(h.calls.review, 0);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('duplicate recipes cannot spend another warehouse query', async () => {
  const h = harness({ plan: async () => ({ decision: 'query', recipeId: 'overview', reason: 'Repeat' }) });
  const review = h.deps.review;
  h.deps.review = async input => ({ ...await review(input), decision: 'continue' });
  const result = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
  assert.equal(result.status, 'PAUSED_LIMIT');
  assert.equal(result.error.code, 'DUPLICATE_QUERY_PLAN');
  assert.equal(result.usage.queries, 1);
});

test('adapter-owned model receipts persist at stage and usage level, including spent rejected work', async () => {
  const callReceipt = { model: 'deepseek-v4-pro', promptTokens: 300, completionTokens: 50, estimatedPeakCny: 0.00405, priceBasis: 'dated-price', secret: 'MUST_NOT_COPY' };
  const h = harness(); const plan = h.deps.plan, review = h.deps.review;
  h.deps.plan = async input => ({ ...await plan(input), callReceipt });
  h.deps.review = async input => ({ ...await review(input), callReceipt });
  const result = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
  assert.equal(result.usage.receipts.length, 2);
  assert.equal(result.rounds[0].plan.callReceipt.stage, 'plan');
  assert.equal(result.rounds[0].review.callReceipt.stage, 'review');
  assert.equal(result.usage.receipts[0].promptTokens, 300);
  assert.ok(!JSON.stringify(result).includes('MUST_NOT_COPY'));
  const failed = harness({ plan: async () => { const e = new Error('PRIVATE'); e.callReceipt = callReceipt; throw e; } });
  const rejection = await runDiagnostic({ run: initial(), source, dependencies: failed.deps });
  assert.equal(rejection.status, 'FAILED');
  assert.equal(rejection.usage.receipts.length, 1);
});

test('source definition version changes invalidate a previous ready draft', async () => {
  const h = harness();
  const ready = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
  const invalid = await runDiagnostic({ run: ready, source: { ...source, version: 'v2' }, dependencies: h.deps });
  assert.equal(invalid.status, 'NEEDS_DEFINITION');
  assert.equal(invalid.error.code, 'SOURCE_DEFINITION_CHANGED');
  assert.equal(invalid.report, null);
  assert.equal(h.calls.query, 1);
});

test('currency denial pauses before a model dispatch without incrementing call counts', async () => {
  const h = harness({ reserveModel: async () => ({ allowed: false, reason: 'DAILY_BUDGET_LIMIT', budget: { remainingCny: 0 } }) });
  const result = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
  assert.equal(result.status, 'PAUSED_LIMIT');
  assert.equal(result.error.code, 'DAILY_BUDGET_LIMIT');
  assert.equal(result.usage.modelCalls, 0);
  assert.equal(h.calls.plan + h.calls.query, 0);
});
test('budget-paused review resumes existing query results and keeps full call limits', async () => {
  let available = false;
  const h = harness({ reserveModel: async ({ stage }) => ({ allowed: stage === 'plan' || available, reservation: { id: 'r' }, budget: { remainingCny: 0 } }), settleModel: async () => ({ budget: { remainingCny: 0 } }) });
  const paused = await runDiagnostic({ run: initial(), source, dependencies: h.deps });
  assert.equal(paused.status, 'PAUSED_LIMIT'); assert.equal(paused.rounds[0].status, 'QUERIED');
  available = true;
  const resumed = await runDiagnostic({ run: paused, source, dependencies: h.deps });
  assert.equal(resumed.status, 'REVIEW_READY');
  assert.equal(h.calls.query, 1); assert.equal(resumed.usage.modelCalls, 2);
});
test('uncertain model transport retains reservation while proven local preflight is releasable', async () => {
  for (const code of ['MODEL_CONTEXT_LIMIT','UPSTREAM_FAILED']) {
    const settlements = [];
    const h = harness({ reserveModel: async () => ({ allowed: true, reservation: { id: 'reserve' }, budget: {} }), settleModel: async input => { settlements.push(input); return { budget: {} }; }, plan: async () => { throw Object.assign(new Error(code), { code }); } });
    await runDiagnostic({ run: initial(), source, dependencies: h.deps });
    assert.equal(settlements[0].notDispatched, code === 'MODEL_CONTEXT_LIMIT');
  }
});
test('choosing a non-shortcut recipe restores attribution capacity rather than silently truncating', async () => {
  const base = initial();
  base.route = { fastPath: true, compatibleRecipeIds: ['overview'], fullLimits: { ...base.limits } };
  base.limits = { ...base.limits, maxRounds: 1, maxQueries: 1 };
  const h = harness({ plan: async () => ({ decision: 'query', recipeId: 'version', reason: 'A different query is necessary' }) });
  const result = await runDiagnostic({ run: base, source, dependencies: h.deps });
  assert.equal(result.route.fastPath, false);
  assert.equal(result.limits.maxRounds, 3);
});

test('short route expands when the actual review requests further investigation', async () => {
  const base = initial();
  base.route = { fastPath: true, compatibleRecipeIds: ['overview'], fullLimits: { ...base.limits } };
  base.limits = { ...base.limits, maxRounds: 1, maxQueries: 1 };
  const h = harness();
  const review = h.deps.review;
  h.deps.review = async input => ({ ...await review(input), decision: input.round.index === 1 ? 'continue' : 'ready' });
  const result = await runDiagnostic({ run: base, source, dependencies: h.deps });
  assert.equal(result.status, 'REVIEW_READY');
  assert.equal(result.route.fastPath, false);
  assert.equal(result.rounds.length, 2);
});
