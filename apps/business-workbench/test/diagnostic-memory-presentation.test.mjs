import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryInjectionView } from '../src/diagnostic-memory-presentation.mjs';

test('prepared memory and historic tasks are never displayed as actual injection', () => {
  assert.equal(memoryInjectionView({}).label, '未留下记忆使用记录');
  assert.equal(memoryInjectionView({ memorySnapshot: { selected: [] } }).label, '没有找到适用记忆');
  const run = { memorySnapshot: { selected: [{ id: 'm1' }] }, usage: { receipts: [{ memoryInjection: { status: 'DISPATCHED', memoryIds: ['m1'] } }] } };
  assert.equal(memoryInjectionView(run).label, '已找到，尚未收到回答');
  run.usage.receipts[0].memoryInjection.status = 'PROVIDER_RESPONDED';
  assert.equal(memoryInjectionView(run).label, '已用于回答 · 1 次');
  run.usage.receipts[0].memoryInjection.memoryIds = [];
  assert.equal(memoryInjectionView(run).label, '已找到，尚未收到回答');
});
