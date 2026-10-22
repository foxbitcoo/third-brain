import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalMemoryCandidates } from '../memory-review.mjs';

const context = { sourceRef: { sourceId: 'authorized-history', hash: 'source-hash', version: 'v1', locator: '/tickets', knownAt: '2026-10-18T00:00:00Z' }, sourceIds: ['approved-board'], knownAt: '2026-10-18T00:00:00Z' };
const tickets = [{ id: 't1', question: 'Why did conversion decline?', events: [ { id: 'e1', kind: 'reply', text: 'Compare denominator before drawing a conclusion. https://example.test/report', at: '2026-09-19T00:00:00Z' }, { id: 'e2', kind: 'followup', text: 'OK' } ] }];

test('history produces deterministic candidates with deliverables and acknowledgements, never fact confirmation', () => {
  const [record] = historicalMemoryCandidates({ ...context, tickets });
  assert.equal(record.status, 'CANDIDATE');
  assert.equal(record.lineage.deliverables[0].url, 'https://example.test/report');
  assert.equal(record.lineage.acknowledgements[0].meaning, 'RECEIVED_NOT_FACT_VERIFIED');
  assert.equal(record.lineage.correctness, 'NOT_VERIFIED');
  assert.equal(record.id, historicalMemoryCandidates({ ...context, tickets })[0].id);
  assert.equal(record.verification, undefined);
  assert.equal(historicalMemoryCandidates({ ...context, tickets: [...tickets, ...tickets] }).length, 1);
});
test('no source or time fabrication and no unresolved empty question candidates', () => {
  assert.throws(() => historicalMemoryCandidates({ tickets, sourceIds: ['a'] }));
  assert.deepEqual(historicalMemoryCandidates({ ...context, tickets: [{ id: 'empty', question: '' }] }), []);
  const [record] = historicalMemoryCandidates({ ...context, tickets: [{ id: 'n', question: 'Question only', events: [{ kind: 'reply', text: '收到' }] }] });
  assert.match(record.text, /未取得有实质内容/);
  assert.equal(record.lineage.replyRefs.length, 0);
});
test('native historical answer and quote fields retain report text and acknowledgment evidence',()=>{
  const [record]=historicalMemoryCandidates({...context,tickets:[{id:'native',question:'Which denominator?',events:[{messageId:'m1',kind:'answer',quote:'Use the completion event. https://example.test/report',occurredAt:'2026-01-01T00:00:00Z'},{messageId:'m2',kind:'followup',quote:'OK'}]}]});
  assert.equal(record.lineage.replyRefs[0].id,'m1');assert.equal(record.lineage.acknowledgements[0].id,'m2');assert.equal(record.lineage.deliverables.length,1);
});
