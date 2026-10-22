import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDataset } from '../data.mjs';
import { loadDataset } from '../server.mjs';

const at = '2026-10-16T01:00:00+08:00';
function fixture() {
  const makeCase = (id, evidence) => ({ id, title: id, question: '进展如何？', scope: '合成测试', as_of: at, evidence: [evidence], runs: [] });
  return { schema_version: 'business-qa-v1', dataset_id: 'work-structure-api-test', as_of: at, cases: [
    makeCase('visible', { id: 'e-visible', source_type: 'im', source_title: '公开样例', speaker: '成员甲', text: '请确认交付时间。', locator: 'neutral:1', occurred_at: at }),
    makeCase('restricted', { id: 'e-restricted', source_type: 'document', source_title: '受限合成材料', speaker: '成员乙', text: 'PRIVATE_DERIVED_SENTINEL', locator: JSON.stringify({ platform: 'wps', sourceType: 'document', sourceRef: 'doc-restricted', itemRef: 'section1' }), document_id: 'doc-restricted', occurred_at: null })
  ], work_structure: { version: 'work-structure-v1', as_of: at, display_limit: 8,
    items: [
      { case_id: 'visible', rank: 1, state: 'active', priority: 'high', tags: ['待决策'], reason: '请确认交付时间', evidence_ids: ['e-visible'], last_activity_at: at },
      { case_id: 'restricted', rank: 2, state: 'background', priority: 'low', tags: [], reason: 'PRIVATE_DERIVED_SENTINEL', evidence_ids: ['e-restricted'], last_activity_at: null }
    ], changes: [{ kind: 'split', from_case_ids: ['visible'], to_case_ids: ['restricted'], reason: 'PRIVATE_DERIVED_SENTINEL', evidence_ids: ['e-visible', 'e-restricted'] }], coverage: { notes: ['PRIVATE_COVERAGE_SENTINEL'] }
  } };
}
test('dataset contract rejects work priorities citing another case', () => {
  const data = fixture();
  assert.equal(validateDataset(data).valid, true);
  data.work_structure.items[0].evidence_ids = ['e-restricted'];
  const result = validateDataset(data);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'INVALID_WORK_EVIDENCE'));
});
test('dataset loading removes the whole derived priority and change when a document is revoked', async t => {
  const root = await mkdtemp(join(tmpdir(), 'third-brain-structure-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataPath = join(root, 'data.json'), documentPolicyPath = join(root, 'policy.json');
  const data = fixture();
  await writeFile(dataPath, JSON.stringify(data));
  await writeFile(documentPolicyPath, JSON.stringify({ version: 'document-source-policy-v1', documents: [{ documentId: 'doc-restricted', status: 'revoked' }] }));
  const result = await loadDataset({ dataPath, documentPolicyPath });
  assert.deepEqual(result.dataset.cases.map(c => c.id), ['visible']);
  assert.deepEqual(result.dataset.work_structure.items.map(c => c.case_id), ['visible']);
  assert.deepEqual(result.dataset.work_structure.changes, []);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_DERIVED_SENTINEL'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_COVERAGE_SENTINEL'));
});
test('legacy dataset loading does not invent a work structure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'third-brain-structure-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataPath = join(root, 'data.json');
  const data = fixture();delete data.work_structure;data.cases = [data.cases[0]];
  await writeFile(dataPath, JSON.stringify(data));
  const result = await loadDataset({ dataPath });
  assert.equal(Object.hasOwn(result.dataset, 'work_structure'), false);
});
