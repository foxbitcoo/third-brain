import test from 'node:test';
import assert from 'node:assert/strict';
import { agentRunProgress, agentRoundChecks, agentRuleSnapshot, knowledgeBytes, shouldPollAgent } from '../src/agent-run-presentation.mjs';
test('progress is based on actual plan, query receipt and review rather than a simulated sequence', () => {
  const run = { status: 'RUNNING_REVIEW', rounds: [{ index: 1, plan: {}, result: { status: 'VERIFIED' } }] };
  const value = agentRunProgress(run);
  assert.equal(value.current, 'review');
  assert.deepEqual(value.stages.map(stage => stage.status), ['完成', '已取得回执', '进行中', '未形成']);
  assert.equal(agentRunProgress({ status: 'QUEUED', rounds: [] }).stages[1].status, '未执行');
});
test('unknown query outcome is not shown as completed or polled for automatic retry', () => {
  const run = { id: 'x', status: 'UNKNOWN_EXECUTION', inflight: {}, rounds: [{ plan: {} }] };
  assert.equal(agentRunProgress(run).stages[1].status, '结果待确认');
  assert.equal(shouldPollAgent(run, { startedAt: 0, now: 1 }), false);
});
test('program checks preserve failure, not-run and absent evidence distinctly from model decisions', () => {
  const checks = agentRoundChecks({ checks: [{ id: 'a', status: 'FAIL' }, { id: 'b', status: 'NOT_RUN' }, { id: 'c', status: 'VERIFIED' }], review: { decision: 'ready' } });
  assert.deepEqual(checks.map(check => check.label), ['未通过', '未执行', '未记录']);
  assert.deepEqual(agentRoundChecks({ review: { decision: 'ready' } }), []);
  assert.equal(agentRuleSnapshot({}).recorded, false);
});
test('automatic readback is bounded and respects masking, failure, end state and maximum count', () => {
  const run = { id: 'x', status: 'PLANNING' }, base = { startedAt: 10, now: 100 };
  assert.equal(shouldPollAgent(run, base), true);
  for (const extra of [{ masked: true }, { error: true }, { pageVisible: false }, { requests: 180 }, { now: 600011 }]) assert.equal(shouldPollAgent(run, { ...base, ...extra }), false);
  assert.equal(shouldPollAgent({ ...run, status: 'REVIEW_READY' }, base), false);
  assert.equal(knowledgeBytes('你好'), 6);
});

test('a new planning round never borrows completion from the previous reviewed round', () => {
  const previous = { index: 1, status: 'REVIEWED', plan: {}, result: { status: 'VERIFIED' }, review: { decision: 'continue' } };
  for (const status of ['PLANNING', 'CONTINUE']) {
    const value = agentRunProgress({ status, rounds: [previous], report: { summary: 'Earlier stage' } });
    assert.equal(value.round, 2);
    assert.deepEqual(value.stages.slice(0, 3).map(stage => stage.status), ['进行中', '未执行', '未执行']);
  }
  const value = agentRunProgress({ status: 'FAILED', rounds: [{ ...previous, status: 'QUERYING', result: undefined }], report: {} });
  assert.equal(value.current, 'query');
  assert.equal(value.title, '查数状态待核实');
});
