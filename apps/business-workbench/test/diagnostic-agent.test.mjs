import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createKnowledgeSnapshot, diagnosticRunView } from '../diagnostic-agent.mjs';

test('knowledge has a UTF-8 byte limit and hashes the actual sanitized Markdown', () => {
  const knowledge = createKnowledgeSnapshot('  # 口径\nBearer synthetic-secret\n  ');
  assert.ok(!knowledge.markdown.includes('synthetic-secret'));
  assert.equal(knowledge.sha256, createHash('sha256').update(knowledge.markdown).digest('hex'));
  assert.equal(createKnowledgeSnapshot('  '), null);
  for (const value of [{}, null, 'x\0y', '中'.repeat(2049)]) assert.throws(() => createKnowledgeSnapshot(value), e => e.code === 'INVALID_DISCOVERY_REQUEST');
  assert.equal(createKnowledgeSnapshot('中'.repeat(2048)).markdown.length, 2048);
});

test('display validation states its read-time basis and does not invent a numeric or legacy Skill verdict', () => {
  const original = { id: 'legacy', rounds: [
    { status: 'REVIEWED', result: { status: 'VERIFIED', receiptId: 'real', queryHash: 'query-hash', columns: ['count'], records: [[1]] }, review: { findings: [null, { evidenceIds: ['forged'] }] } },
    { status: 'PLANNED' },
  ] };
  const view = diagnosticRunView(original);
  assert.equal(view.agentSnapshot, undefined);
  assert.equal(view.rounds[0].checks[0].status, 'PASS');
  assert.equal(view.rounds[0].checks.find(c => c.id === 'source').status, 'NOT_RECORDED');
  assert.equal(view.rounds[0].checks.find(c => c.id === 'citations').status, 'FAIL');
  assert.equal(view.rounds[0].checks.find(c => c.id === 'numbers').status, 'NOT_RECORDED');
  assert.equal(view.rounds[0].checks[0].basis, 'READ_TIME_VALIDATION');
  assert.ok(view.rounds[0].checks[0].checkedAt);
  assert.equal(view.rounds[1].checks[0].status, 'NOT_RUN');
  assert.equal(original.rounds[0].checks, undefined);
});

test('execution validation rejects incomplete or over-limit rows and checks recorded source bindings', () => {
  const source = { id: 'activity', version: 'v2', recipes: [{ id: 'overview' }] };
  const run = { sourceId: 'activity', sourceVersion: 'v2', limits: { maxRows: 1 }, rounds: [
    { plan: { recipeId: 'overview' }, result: { status: 'VERIFIED', receiptId: 'real', queryHash: 'hash', columns: ['count'], records: [[1]] } },
  ] };
  const checks = value => diagnosticRunView(value, source).rounds[0].checks;
  assert.equal(checks(run).find(c => c.id === 'source').status, 'PASS');
  assert.equal(checks(run).find(c => c.id === 'execution').status, 'PASS');
  for (const patch of [{ receiptId: '' }, { queryHash: undefined }, { columns: [] }, { records: [[1], [2]] }, { records: [null] }]) {
    assert.equal(checks({ ...run, rounds: [{ ...run.rounds[0], result: { ...run.rounds[0].result, ...patch } }] }).find(c => c.id === 'execution').status, 'FAIL');
  }
  assert.equal(checks({ ...run, sourceVersion: 'v1' }).find(c => c.id === 'source').status, 'FAIL');
});
