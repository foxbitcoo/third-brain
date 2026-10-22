import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEvaluation, runMemoryEvaluation, eligibleMemoryRecords, createEvaluationTransport, writePrivateEvaluation, assertFreshEvaluation } from '../diagnostic-memory-evaluation.mjs';
import { renderEvaluationReview } from '../diagnostic-memory-evaluation-report.mjs';
const cutoff = '2026-10-18T10:00:00Z';
const memory = (extra = {}) => ({ id: 'm1', version: 1, hash: 'hash', text: 'Confirmed metric definition.', title: 'Definition', status: 'USER_CONFIRMED', knownAt: '2026-10-10T00:00:00Z', applicability: { sourceIds: ['source'], sourceVersions: { source: 'v1' } }, sourceRefs: [{ sourceId: 'doc', locator: 'section-1', hash: 'doc-hash', version: 1, knownAt: '2026-10-10T00:00:00Z' }], ...extra });
const input = (cases = 1) => ({ schemaVersion: 1, runId: 'synthetic-evaluation', governedSystem: 'Answer faithfully.', cutoff, cases: Array.from({ length: cases }, (_, i) => ({ id: `case${i}`, question: 'What changed?', sourceId: 'source', sourceVersion: 'v1', evidence: [{ id: 'e1', text: 'Metric dropped.', availableAt: '2026-10-11T00:00:00Z' }, { id: 'future', text: 'Future answer', availableAt: '2026-11-01T00:00:00Z' }], memorySnapshot: { records: [memory()] } })) });
const budget = () => ({ reservations: [], settlements: [], async reserve(value) { this.reservations.push(value); return { allowed: true }; }, async settle(value) { this.settlements.push(value); } });
const result = arm => ({ responseId: 'synthetic-response', model: arm.payload.model, answer: 'Supported answer [e1].', finishReason: 'stop', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 }, dispatched: true });

test('evaluation excludes later confirmations and unresolved conflicting memories',()=>{
  const current=input().cases[0],at=Date.parse(cutoff);
  const records=[memory({id:'later',review:{at:'2026-10-19T00:00:00Z'}}),memory({id:'verification-later',verification:{at:'2026-10-19T00:00:00Z'}}),memory({id:'conflict-a',conflictKey:'metric',text:'A'}),memory({id:'conflict-b',conflictKey:'metric',text:'B'})];
  assert.deepEqual(eligibleMemoryRecords({records},current,at),[]);
});

test('four-arm parity and no-memory isolation with exact system content and future omission', () => {
  const plan = prepareEvaluation(input());
  assert.equal(plan.callCount, 4); assert.equal(new Set(plan.arms.map(x => x.parityHash)).size, 1);
  assert.equal(new Set(plan.arms.map(x => x.evidenceHash)).size, 1);
  for (const arm of plan.arms) {
    assert(!arm.payload.messages[1].content.includes('Future answer'));
    assert.equal(arm.excludedEvidenceCount, 1);
    assert.equal(arm.payload.messages[0].content.includes('Confirmed metric definition.'), arm.withMemory);
    if (!arm.withMemory) { assert.equal(arm.memorySnapshot, null); assert.equal(arm.memoryHash, null); }
  }
  assert.equal(new Set(plan.arms.filter(x => x.withMemory).map(x => x.systemHash)).size, 1);
});

test('memory filtering blocks future, expired, unconfirmed, source mismatch and self-answer', () => {
  const current = input().cases[0]; current.excludeCaseSourceIds = ['own-answer']; current.excludeMemoryLocators = ['own-section'];
  const records = [memory(), memory({ id: 'future', knownAt: '2027-01-01' }), memory({ id: 'expired', effectiveUntil: '2026-10-17' }), memory({ id: 'candidate', status: 'CANDIDATE' }), memory({ id: 'changed', applicability: { sourceIds: ['source'], sourceVersions: { source: 'v2' } } }), memory({ id: 'own', sourceRefs: [{ sourceId: 'own-answer', knownAt: '2026-10-10' }] }), memory({ id: 'own-locator', sourceRefs: [{ sourceId: 'doc', locator: 'own-section', knownAt: '2026-10-10' }] }), memory({ id: 'undated', knownAt: null })];
  assert.deepEqual(eligibleMemoryRecords({ selected: records }, current, Date.parse(cutoff)).map(x => x.id), ['m1']);
});

test('production memory formatter receives compatible selected records', () => {
  const plan = prepareEvaluation(input(), { memoryBlockBuilder: snapshot => snapshot.selected.map(x => x.text).join('\n') });
  assert(plan.arms[1].payload.messages[0].content.includes('Confirmed metric definition.'));
});

test('dry run performs no transport or budget actions', async () => {
  let calls = 0; const answer = await runMemoryEvaluation(prepareEvaluation(input()), { transport: () => { calls++; } });
  assert.equal(answer.status, 'DRY_RUN'); assert.equal(calls, 0);
});

test('four-case max and context cap fail before any calls', () => {
  assert.throws(() => prepareEvaluation(input(5)), /INVALID_CASE_COUNT/);
  const large = input(); large.governedSystem = 'x'.repeat(25000);
  assert.throws(() => prepareEvaluation(large), /EVALUATION_CONTEXT_LIMIT/);
});

test('cases sequential, four arms concurrent, one arm failure retained without retry', async () => {
  const plan = prepareEvaluation(input(2)), ledger = budget(); let active = 0, max = 0, calls = 0, case0Finished = 0;
  const receipt = await runMemoryEvaluation(plan, { execute: true, beforeDispatch: async () => ({ allowed: true }), budget: ledger, transport: async arm => {
    if (arm.caseId === 'case1') assert.equal(case0Finished, 4);
    calls++; active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 5)); active--;
    if (arm.caseId === 'case0') case0Finished++;
    if (arm.id === 'case0:mimo:memory') throw Object.assign(new Error('opaque secret'), { code: 'RATE_LIMITED', dispatched: true });
    return result(arm);
  } });
  assert.equal(max, 4); assert.equal(calls, 8); assert.equal(receipt.status, 'PARTIAL_OR_QUEUED');
  assert.equal(receipt.results.filter(x => x.status === 'FAILED').length, 1);
  assert(!JSON.stringify(receipt).includes('opaque secret')); assert.equal(ledger.settlements.length, 8);
});

test('whole-case budget admission avoids incomplete model matrix', async () => {
  const ledger = budget(); ledger.reserve = async value => { ledger.reservations.push(value); return { allowed: ledger.reservations.length < 3 }; };
  let calls = 0;
  const receipt = await runMemoryEvaluation(prepareEvaluation(input()), { execute: true, beforeDispatch: async () => ({ allowed: true }), budget: ledger, transport: () => { calls++; } });
  assert.equal(calls, 0); assert.equal(receipt.results.length, 4); assert(receipt.results.every(x => x.status === 'QUEUED_BUDGET'));
  assert.equal(ledger.settlements.length, 2); assert(ledger.settlements.every(x => x.notDispatched));
});

test('full pilot estimate must fit budget before any reserve or transport', async () => {
  const ledger = budget();
  await assert.rejects(runMemoryEvaluation(prepareEvaluation(input()), { execute: true, beforeDispatch: async () => ({ allowed: true }), budget: ledger, transport: () => {}, pilotLimitCny: 0.00001 }), /PILOT_BUDGET_PREFLIGHT_FAILED/);
  assert.equal(ledger.reservations.length, 0);
});

test('unknown dispatch failures retain charges, definite credential failures release reservation', async () => {
  const ledger = budget();
  await runMemoryEvaluation(prepareEvaluation(input()), { execute: true, beforeDispatch: async () => ({ allowed: true }), budget: ledger, transport: async arm => { throw Object.assign(new Error('no'), arm.providerId === 'mimo' ? { code: 'CREDENTIAL_UNAVAILABLE', dispatched: false } : {}); } });
  assert.equal(ledger.settlements.filter(x => x.notDispatched).length, 2);
});

test('official transport is single-dispatch and records response identity and usage', async () => {
  let count = 0, request;
  const transport = createEvaluationTransport({ credential: async (platform, field) => { assert.equal(platform, '小米开放平台'); assert.equal(field, 'api_key'); return 'synthetic-key'; }, fetchImpl: async (url, options) => { count++; request = { url, options }; return new Response(JSON.stringify({ id: 'real-shaped-id', model: 'mimo-v2.6-pro', choices: [{ finish_reason: 'stop', message: { content: 'Answer' } }], usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 } })); } });
  const arm = prepareEvaluation(input()).arms.find(x => x.providerId === 'mimo');
  const answer = await transport(arm); assert.equal(count, 1); assert.equal(answer.responseId, 'real-shaped-id'); assert.equal(answer.usage.promptTokens, 100);
  assert.equal(request.url, 'https://api.xiaomimimo.com/v1/chat/completions'); assert.equal(JSON.parse(request.options.body).thinking.type, 'disabled');
});

test('mismatched model fails and still retains actual response and billable usage', async () => {
  const transport = createEvaluationTransport({ credential: async () => 'synthetic', fetchImpl: async () => new Response(JSON.stringify({ id: 'id', model: 'wrong', choices: [{ finish_reason: 'stop', message: { content: 'full answer' } }], usage: { prompt_tokens: 5, completion_tokens: 7 } })) });
  await assert.rejects(transport(prepareEvaluation(input()).arms[0]), error => error.code === 'MODEL_MISMATCH' && error.result.answer === 'full answer' && error.result.usage.completionTokens === 7);
});

test('private receipts preserve full actual systems, refuse duplicate run and restrict mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-eval-')); const plan = prepareEvaluation(input());
  await assertFreshEvaluation(directory, plan.runId); const path = await writePrivateEvaluation(directory, plan);
  assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal(JSON.parse(await readFile(path)).arms[0].systemHash, plan.arms[0].systemHash);
  await assert.rejects(assertFreshEvaluation(directory, plan.runId), /EVALUATION_RUN_ALREADY_EXISTS/);
});

test('review HTML escapes answers and exposes actual injection and pending evaluation', () => {
  const plan = prepareEvaluation(input()); const html = renderEvaluationReview({ ...plan, status: 'PARTIAL', results: [{ armId: plan.arms[0].id, answer: '<script>private</script>', usage: {}, status: 'COMPLETED_PENDING_REVIEW' }] });
  assert(html.includes('&lt;script&gt;private&lt;/script&gt;')); assert(html.includes('非完整查数 Loop')); assert(html.includes('尚未由评阅者确认差异')); assert(html.includes(plan.arms[0].systemHash));
});

test('prepare rejects stale reference versions and currently unauthorized memory sources', () => {
  const fixture = input(); fixture.sourceVersions = { doc: 1 }; fixture.allowedSourceIds = ['source', 'doc'];
  assert.equal(prepareEvaluation(fixture).arms[1].memoryInjection.selectedCount, 1);
  fixture.sourceVersions.doc = 2;
  assert.equal(prepareEvaluation(fixture).arms[1].memoryInjection.selectedCount, 0);
  fixture.sourceVersions.doc = 1; fixture.allowedSourceIds = ['source'];
  assert.equal(prepareEvaluation(fixture).arms[1].memoryInjection.selectedCount, 0);
});

test('execution requires a live authority callback before reserving or dispatching', async () => {
  const ledger = budget(); let calls = 0;
  await assert.rejects(runMemoryEvaluation(prepareEvaluation(input()), { execute: true, budget: ledger, transport: async () => { calls++; } }), /EXECUTION_AUTHORITY_REQUIRED/);
  assert.equal(calls, 0); assert.equal(ledger.reservations.length, 0);
});

test('dispatch rechecks fresh authority per arm and blocks disabled memory without silently removing it', async () => {
  const plan = prepareEvaluation(input()), ledger = budget(); let calls = 0, checks = 0;
  const originalSystem = plan.arms[1].payload.messages[0].content;
  const receipt = await runMemoryEvaluation(plan, { execute: true, budget: ledger,
    beforeDispatch: async arm => { checks++; if (arm.withMemory) throw Object.assign(new Error('now disabled'), { code: 'MEMORY_DISABLED' }); return { allowed: true, receipt: { policyHash: 'current' } }; },
    transport: async arm => { calls++; return result(arm); } });
  assert.equal(checks, 4); assert.equal(calls, 2);
  const failures = receipt.results.filter(row => row.withMemory);
  assert(failures.every(row => row.status === 'FAILED' && row.error === 'MEMORY_DISABLED' && row.dispatched === false));
  assert.equal(ledger.settlements.filter(row => row.notDispatched).length, 2);
  assert.equal(plan.arms[1].payload.messages[0].content, originalSystem);
  assert(receipt.results.filter(row => !row.withMemory).every(row => row.authorization.status === 'LIVE_AUTHORIZED'));
});

test('authority refusal cannot mutate an arm and is recorded as not dispatched', async () => {
  const plan = prepareEvaluation(input()), ledger = budget(); let calls = 0;
  const original = plan.arms[0].payload.messages[0].content;
  const receipt = await runMemoryEvaluation(plan, { execute: true, budget: ledger, beforeDispatch: async arm => { arm.payload.messages[0].content = 'changed'; return { allowed: false }; }, transport: () => { calls++; } });
  assert.equal(calls, 0); assert.equal(plan.arms[0].payload.messages[0].content, original);
  assert(receipt.results.every(row => row.error === 'NOT_LIVE_AUTHORIZED' && row.dispatched === false));
  assert(ledger.settlements.every(row => row.notDispatched));
});
