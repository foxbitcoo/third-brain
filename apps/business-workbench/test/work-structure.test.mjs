import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkStructure, projectWorkStructure } from '../work-structure.mjs';
const fixture = () => ({ cases: [{ id: 'old', evidence: [{ id: 'a' }] }, { id: 'new', evidence: [{ id: 'b' }, { id: 'c' }] }], work_structure: { version: 'work-structure-v1', as_of: '2026-10-15T07:57:08Z', display_limit: 8,
  items: [{ case_id: 'new', state: 'active', priority: 'high', rank: 1, tags: ['有卡点'], reason: '受交付阻塞', evidence_ids: ['b', 'c'], last_activity_at: null }, { case_id: 'old', state: 'background', priority: 'low', rank: 2, tags: [], reason: '历史背景', evidence_ids: ['a'], last_activity_at: null }],
  changes: [{ kind: 'split', from_case_ids: ['old'], to_case_ids: ['new'], reason: '独立交付', evidence_ids: ['a', 'b'] }], coverage: { notes: ['私有源说明'] } } });
test('optional structure preserves old snapshots and validates cited dynamic cases', () => { assert.deepEqual(validateWorkStructure({}), []); assert.deepEqual(validateWorkStructure(fixture()), []); });
test('unknown local citations and duplicate rank fail contract', () => { const d = fixture(); d.work_structure.items[0].evidence_ids = ['a']; d.work_structure.items[1].rank = 1; const codes = validateWorkStructure(d).map(e => e.code); assert.ok(codes.includes('INVALID_WORK_EVIDENCE')); assert.ok(codes.includes('INVALID_WORK_RANK')); });
test('permission loss removes entire derived reason and dependent change, never just citations', () => { const d = fixture(); d.cases[1].evidence = [{ id: 'b' }]; const view = projectWorkStructure(d); assert.deepEqual(view.items.map(x => x.case_id), ['old']); assert.deepEqual(view.changes, []); assert.ok(!JSON.stringify(view).includes('受交付阻塞')); assert.ok(!JSON.stringify(view).includes('私有源说明')); assert.equal(d.work_structure.items.length, 2); });
test('hidden case with remaining shared citation is still removed', () => { const d = fixture(); d.cases = d.cases.filter(c => c.id !== 'old'); const view = projectWorkStructure(d); assert.deepEqual(view.items.map(x => x.case_id), ['new']); assert.deepEqual(view.changes, []); });

test('projection only exposes contract fields, never raw private annotations', () => { const d = fixture(); d.work_structure.items[0].raw_source = 'hidden source'; d.work_structure.changes[0].internal = 'hidden rationale'; assert.ok(!JSON.stringify(projectWorkStructure(d)).includes('hidden')); });
test('change citations belong to the involved worklines, not any globally visible case', () => {
  const d = fixture();
  d.cases.push({ id: 'unrelated', evidence: [{ id: 'foreign' }] });
  d.work_structure.items.push({ case_id: 'unrelated', state: 'active', priority: 'normal', rank: 3, tags: [], reason: '不同事项', evidence_ids: ['foreign'], last_activity_at: null });
  d.work_structure.changes[0].evidence_ids = ['foreign'];
  d.work_structure.changes[0].reason = 'FOREIGN_CHANGE_REASON';
  assert.ok(validateWorkStructure(d).some(e => e.code === 'INVALID_WORK_CHANGE_EVIDENCE'));
  const result = projectWorkStructure(d);
  assert.deepEqual(result.changes, []);
  assert.ok(!JSON.stringify(result).includes('FOREIGN_CHANGE_REASON'));
});
