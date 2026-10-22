import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkStructureView, workStructureCitations } from '../src/work-structure-presentation.mjs';
import { createPresenter } from '../src/presentation.mjs';

function fixture(count = 12) {
  const cases = Array.from({ length: count }, (_, index) => ({ id: `case-${index}`, title: `工作 ${index}`, question: '进展', evidence: [{ id: 'E1', speaker: 'P01', text: `原文 ${index}` }], runs: [] }));
  return { cases, work_structure: { version: 'work-structure-v1', display_limit: 8, items: cases.map((item, index) => ({ case_id: item.id, state: 'active', priority: 'normal', rank: count - index, tags: [], reason: '目标已明确，等待交付确认', evidence_ids: ['E1'], last_activity_at: null })), changes: [] } };
}

test('uses supplied rank rather than dataset index; the eight-row cap never deletes work', () => {
  const dataset = fixture();
  const view = buildWorkStructureView(dataset);
  assert.deepEqual(view.visibleCases.map(item => item.id), ['case-11', 'case-10', 'case-9', 'case-8', 'case-7', 'case-6', 'case-5', 'case-4']);
  assert.equal(view.hiddenActiveCount, 4);
  assert.equal(view.orderedCases.length, 12);
});

test('urgency precedes supplied rank while focus never expands beyond its limit', () => {
  const dataset = fixture(15);
  dataset.work_structure.display_limit = 10;
  dataset.work_structure.items[0].priority = 'urgent';
  dataset.work_structure.items[1].priority = 'high';
  const view = buildWorkStructureView(dataset);
  assert.equal(view.visibleCases.length, 10);
  assert.deepEqual(view.visibleCases.slice(0,2).map(item=>item.id), ['case-0','case-1']);
  assert.equal(view.orderedCases.length,15);
  assert.equal(view.urgentOverflow,0);
});

test('even an oversized saved limit cannot put more than ten worklines in focus', () => {
  const dataset = fixture(20);
  dataset.work_structure.display_limit = 50;
  dataset.work_structure.items.forEach(item=>item.priority='urgent');
  const view=buildWorkStructureView(dataset);
  assert.equal(view.visibleCases.length,10);
  assert.equal(view.hiddenActiveCount,10);
});

test('background and archived work retain original cases and rank after active work; no age inference', () => {
  const dataset = fixture(3);
  dataset.work_structure.items[2].state = 'archived';
  dataset.work_structure.items[1].state = 'background';
  dataset.work_structure.items[0].last_activity_at = '2000-01-01T00:00:00Z';
  const view = buildWorkStructureView(dataset);
  assert.deepEqual(view.activeCases.map(item => item.id), ['case-0']);
  assert.deepEqual(view.deferredCases.map(item => item.id), ['case-2', 'case-1']);
  assert.equal(view.orderedCases[1], dataset.cases[2]);
});

test('urgent work is visible even when its lifecycle display state is background or candidate', () => {
  const dataset = fixture(12);
  dataset.work_structure.items[0].state = 'background';
  dataset.work_structure.items[0].priority = 'urgent';
  dataset.work_structure.items[1].state = 'candidate';
  dataset.work_structure.items[1].priority = 'urgent';
  const view = buildWorkStructureView(dataset);
  assert.ok(view.visibleCases.some(item => item.id === 'case-0'));
  assert.ok(view.visibleCases.some(item => item.id === 'case-1'));
  assert.equal(view.deferredCases.length, 0);
  assert.equal(view.urgentOverflow, 0);
});

test('missing or invalid structure falls back to the entire legacy list without invented priorities', () => {
  const dataset = fixture();
  for (const bad of [undefined, { ...dataset.work_structure, items: [null] }, { ...dataset.work_structure, items: [{ ...dataset.work_structure.items[0], evidence_ids: ['foreign'] }] }]) {
    const view = buildWorkStructureView({ ...dataset, work_structure: bad });
    assert.equal(view.enabled, false);
    assert.equal(view.visibleCases.length, 10);
    assert.equal(view.secondaryCases.length, 2);
    assert.equal(view.metadataById.size, 0);
    assert.deepEqual(view.orderedCases, dataset.cases);
  }
});

test('search reaches lower-ranked active work and retained history without an eight-row cap', () => {
  const dataset = fixture(20);
  dataset.work_structure.items[0].state = 'archived';
  const view = buildWorkStructureView(dataset, { search: '工作' });
  assert.equal(view.visibleCases.length, 19);
  assert.equal(view.deferredCases.length, 1);
  assert.equal(view.hiddenActiveCount, 0);
});

test('change panel drops unavailable case IDs; evidence resolves only inside from/to cases', () => {
  const dataset = fixture(3);
  const valid = { kind: 'split', from_case_ids: ['case-0'], to_case_ids: ['case-1'], reason: '目标与交付范围不同', evidence_ids: ['E1'] };
  dataset.work_structure.changes = [valid, { ...valid, from_case_ids: ['private-hidden'] }];
  const view = buildWorkStructureView(dataset);
  assert.equal(view.changes.length, 1);
  const citations = workStructureCitations(dataset, valid);
  assert.deepEqual(citations.map(reference => reference.item.id), ['case-0', 'case-1']);
  assert.notEqual(citations[0].item.evidence[0].text, citations[1].item.evidence[0].text);
});

test('new prose respects existing anonymous mode, including names, aliases, emails and links', () => {
  const dataset = fixture(1);
  const prose = '张三请P01确认，邮件 a@example.com 资料 https://example.com/private';
  dataset.work_structure.items[0].reason = prose;
  dataset.work_structure.items[0].goal = prose;
  dataset.work_structure.items[0].tags = ['OKR相关', '张三的内部备注'];
  dataset.work_structure.changes = [{ kind: 'add', from_case_ids: [], to_case_ids: ['case-0'], reason: prose, evidence_ids: ['E1'] }];
  dataset.work_structure.coverage = { notes: [prose] };
  const present = createPresenter(dataset, true, { participants: [{ alias: 'P01', display_name: '张三' }] });
  const view = buildWorkStructureView(dataset, { present });
  const output = JSON.stringify([view.metadataById.get('case-0').reason, view.metadataById.get('case-0').goal, view.changes[0].reason, view.notes]);
  assert.doesNotMatch(output, /张三|P01|a@example.com|https:\/\/example.com/);
  assert.match(output, /成员 01/);
  assert.deepEqual(view.metadataById.get('case-0').tags, ['OKR相关']);
});

test('partial structure metadata retains unclassified overflow and never dereferences its state',()=>{
 const dataset=fixture(15);dataset.work_structure.display_limit=10;
 dataset.work_structure.items=dataset.work_structure.items.slice(0,1);
 const view=buildWorkStructureView(dataset);
 assert.equal(view.enabled,true);assert.equal(view.navigationCases.length,10);
 assert.equal(view.secondaryCases.length,5);
 for(const item of view.secondaryCases)assert.doesNotThrow(()=>view.metadataById.get(item.id)?.state);
});
