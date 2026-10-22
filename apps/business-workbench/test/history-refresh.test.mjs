import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accumulateRefreshHistory } from '../history-refresh.mjs';
import { refreshSources } from '../source-refresh.mjs';

test('every refresh accumulates durable history without replay inflation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'history-refresh-'));
  try {
    const policyPath = join(dir, 'policy.json');
    await writeFile(policyPath, JSON.stringify({ version: 1, sources: [{ id: 's', status: 'active', tier: 'normal', kind: 'group', manualOverride: true, matchedWorklines: [] }] }));
    const config = { policyPath, historyIndexPath: join(dir, 'history.json') };
    const old = { id: 'm1', sourceKey: 's', sourceName: '测试工作群', occurredAt: '2026-08-13T08:00:00Z', text: '八月启动工作', sourceLocator: { platform: 'wps', sourceType: 'chat', sourceRef: 'fixture', itemRef: 'm1' } };
    const newer = { ...old, id: 'm2', occurredAt: '2026-10-15T08:00:00Z', text: '十月仍在推进', sourceLocator: { ...old.sourceLocator, itemRef: 'm2' } };
    await accumulateRefreshHistory({ config, evidence: [old], output: dir, now: '2026-10-15T09:00:00Z' });
    await accumulateRefreshHistory({ config, evidence: [newer, old], output: dir, now: '2026-10-15T10:00:00Z' });
    await accumulateRefreshHistory({ config, evidence: [newer], output: dir, now: '2026-10-15T11:00:00Z' });
    const index = JSON.parse(await readFile(config.historyIndexPath, 'utf8'));
    assert.equal(index.records.length, 2);
    assert.ok(index.records.some(r => JSON.stringify(r).includes('八月启动工作')));
    assert.equal(JSON.parse(await readFile(join(dir, 'history-accumulation.json'), 'utf8')).formalMemoryUpdated, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('history failure prevents a successful collection cursor from advancing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'history-cursor-'));
  try {
    const source = { id: 's', name: '测试工作群', status: 'active', tier: 'normal', kind: 'group', manualOverride: true, matchedWorklines: ['测试工作'], evidenceRefs: [], history: [], lastReadThrough: '2026-10-14T00:00:00Z' };
    const policyPath = join(dir, 'policy.json');
    await writeFile(policyPath, JSON.stringify({ version: 1, sources: [source] }));
    const badIndex = join(dir, 'bad-index.json');
    await mkdir(badIndex);
    await assert.rejects(refreshSources({
      config: { historyIndexPath: badIndex, sources: [{ source_key: 's', chat_id: 'fixture', conversation_kind: 'group', verified_name: '测试工作群' }], worklines: ['测试工作'] },
      policyPath, output: join(dir, 'output'), now: '2026-10-15T08:00:00Z',
      limits: { maxPreviews: 0 },
      adapter: { recent: async () => ({ complete: true, items: [] }), messages: async () => ({ status: 'VERIFIED', complete: true, items: [{ id: 'new', occurredAt: '2026-10-15T07:00:00Z', text: '新增业务事实' }] }) },
    }));
    const after = JSON.parse(await readFile(policyPath, 'utf8'));
    assert.equal(after.sources[0].lastReadThrough, source.lastReadThrough);
    assert.equal(JSON.parse(await readFile(join(dir, 'output/refresh-evidence.json'), 'utf8')).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
