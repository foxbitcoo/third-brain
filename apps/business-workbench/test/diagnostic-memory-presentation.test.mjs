import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryInjectionView } from '../src/diagnostic-memory-presentation.mjs';

test('prepared memory and historic tasks are never displayed as actual injection', () => {
  assert.equal(memoryInjectionView({}).label, '历史任务未记录');
  assert.equal(memoryInjectionView({ memorySnapshot: { selected: [] } }).label, '未匹配适用记忆');
  const run = { memorySnapshot: { selected: [{ id: 'm1' }] }, usage: { receipts: [{ memoryInjection: { status: 'DISPATCHED', memoryIds: ['m1'] } }] } };
  assert.equal(memoryInjectionView(run).label, '已准备，尚无注入响应回执');
  run.usage.receipts[0].memoryInjection.status = 'PROVIDER_RESPONDED';
  assert.equal(memoryInjectionView(run).label, '已注入 · 1 次响应');
  run.usage.receipts[0].memoryInjection.memoryIds = [];
  assert.equal(memoryInjectionView(run).label, '已准备，尚无注入响应回执');
});
