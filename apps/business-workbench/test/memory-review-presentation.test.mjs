import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryLineage, memoryRunReceipts, memoryReviewRows, memoryEvidenceUrl, boardSubmissionContext } from '../src/memory-review-presentation.mjs';

test('lineage keeps unknown history unknown and receipt acknowledgements do not prove correctness', () => {
  assert.equal(memoryLineage({}).question, '');
  const view = memoryLineage({ lineage: { ticketId: 'ticket-1', question: 'Compare numerator and denominator', acknowledgements: [{ text: 'OK', meaning: 'RECEIVED' }] } });
  assert.equal(view.acknowledgements[0].text, 'OK');
  assert.match(view.acknowledgementMeaning, /不代表/);
});
test('all statuses including disabled and candidate stay inspectable, filtered history and queries are explicit', () => {
  const records = [{ id: 'a', title: 'Active', status: 'SOURCE_VERIFIED' }, { id: 'c', title: 'Candidate', status: 'CANDIDATE', lineage: { ticketId: 't', question: 'denominator' } }, { id: 'd', title: 'Disabled', status: 'DISABLED' }];
  assert.equal(memoryReviewRows(records).length, 3);
  assert.deepEqual(memoryReviewRows(records, [], { origin: 'HISTORY', search: 'denominator' }).map(row => row.id), ['c']);
});
test('actual injection is receipt backed and matching alone remains prepared', () => {
  const record = { id: 'm' };
  const run = { id: 'r', memorySnapshot: { selected: [{ id: 'm', version: 2 }] } };
  assert.match(memoryRunReceipts(record, [run])[0].state, /尚未收到/);
  run.usage = { receipts: [{ stage: 'rewrite', round: 1, memoryInjection: { status: 'PROVIDER_RESPONDED', memoryIds: ['m'], block: 'actual block' } }] };
  assert.equal(memoryRunReceipts(record, [run])[0].state, '已用于回答');
  assert.equal(memoryRunReceipts({ id: 'other' }, [run]).length, 0);
});
test('board selection persists exact snapshot rather than substituting latest or push date', () => {
  const board = { id: 'b', snapshots: [{ id: 'old', statisticsDate: '2026-09-19' }, { id: 'new', statisticsDate: '2026-10-11' }] };
  assert.deepEqual(boardSubmissionContext(board, 'new'), { boardId: 'b', snapshotId: 'new' });
  assert.deepEqual(boardSubmissionContext(null, 'new'), {});
  assert.deepEqual(boardSubmissionContext(board, 'removed'), {});
});
test('unsafe evidence links remain inert text', () => {
  for (const value of ['javascript:alert(1)', 'file:///private/example', 'http://example.test', 'https://user:secret@example.test']) assert.equal(memoryEvidenceUrl(value), null);
  assert.equal(memoryEvidenceUrl('https://example.test/report'), 'https://example.test/report');
});
