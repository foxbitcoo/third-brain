import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDiagnosticMemoryStore, selectMemorySnapshot, revalidateMemorySnapshot, buildMemorySystemBlock } from '../diagnostic-memory.mjs';
const knownAt = '2026-01-01T00:00:00Z';
const cutoff = '2026-02-01T00:00:00Z';
const draft = (overrides = {}) => ({ kind: 'METRIC_DEFINITION', title: 'Funnel conversion', text: 'Conversion uses distinct account counts, not requests.', keywords: ['conversion'], status: 'SOURCE_VERIFIED', sourceRefs: [{ sourceId: 'doc-a', version: 'doc-v1', hash: 'synthetic-hash', locator: 'section-1', knownAt }], applicability: { sourceIds: ['board-a'], sourceVersions: { 'board-a': 'v1' } }, knownAt, verification: { method: 'source-text-readback' }, ...overrides });
const context = (records, overrides = {}) => ({ records, question: 'What is conversion?', source: { id: 'board-a', version: 'v1' }, cutoff, allowedSourceIds: ['board-a', 'doc-a'], sourceVersions: { 'doc-a': 'doc-v1' }, ...overrides });
async function fixture(t) { const directory = await mkdtemp(join(await realpath(tmpdir()), 'memory-test-')); t.after(() => rm(directory, { recursive: true, force: true })); const store = await createDiagnosticMemoryStore(directory); t.after(() => store.close()); return { store, directory }; }

test('persists immutable versions, deduplicates, and does not label source verification as user confirmation', async t => {
  const { store, directory } = await fixture(t);
  const one = await store.upsert(draft());
  assert.equal(one.status, 'SOURCE_VERIFIED'); assert.equal(one.version, 1); assert.ok(Object.isFrozen(one.sourceRefs[0]));
  assert.throws(() => { one.text = 'mutation'; });
  const duplicate = await store.upsert(draft()); assert.equal(duplicate.id, one.id);
  const unchanged = await store.upsert(one); assert.equal(unchanged.version, 1);
  const two = await store.upsert({ ...one, text: 'Conversion uses unique users, not pageviews.' }); assert.equal(two.version, 2);
  assert.equal((await store.get(one.id, 1)).text, one.text); assert.equal((await store.history(one.id)).length, 2);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  await store.close(); const reopened = await createDiagnosticMemoryStore(directory); t.after(() => reopened.close());
  assert.equal((await reopened.get(one.id)).version, 2);
});

test('review actions persist and require an explicit actor and note', async t => {
  const { store } = await fixture(t); const one = await store.upsert(draft({ status: 'CANDIDATE' }));
  await assert.rejects(store.action(one.id, 'confirm'), error => error.code === 'INVALID_MEMORY_REVIEW');
  const confirmed = await store.action(one.id, 'confirm', { actor: 'local-user', note: 'Reviewed source and applicability.' }); assert.equal(confirmed.status, 'USER_CONFIRMED');
  const disabled = await store.action(one.id, 'disable', { actor: 'local-user', note: 'No longer relevant.' }); assert.equal(disabled.version, 3); assert.equal(disabled.status, 'DISABLED');
});

test('selection enforces time, evidence, source/version, relevance and bounded reference snapshots', async t => {
  const { store } = await fixture(t); const one = await store.upsert(draft());
  const selected = selectMemorySnapshot(context([one])); assert.equal(selected.selected.length, 1); assert.equal(selected.state, 'PREPARED_NOT_DISPATCHED'); assert.ok(selected.selected[0].reasons.length);
  const cases = [
    [{ allowedSourceIds: ['board-a'] }, 'EVIDENCE_SOURCE_NOT_AUTHORIZED'],
    [{ allowedSourceIds: ['doc-a'] }, 'SOURCE_NOT_AUTHORIZED'],
    [{ sourceVersions: {} }, 'EVIDENCE_VERSION_UNVERIFIED'],
    [{ source: { id: 'board-a', version: 'v2' } }, 'SOURCE_VERSION_CHANGED'],
    [{ cutoff: '2025-01-01T00:00:00Z' }, 'NOT_KNOWN_AT_CUTOFF'],
    [{ question: 'Billing invoices' }, 'NOT_RELEVANT'],
    [{ maxChars: 10 }, 'SNAPSHOT_BOUND'],
  ];
  for (const [patch, why] of cases) { const value = selectMemorySnapshot(context([one], patch)); assert.equal(value.selected.length, 0); assert.equal(value.excluded[0].reason, why); }
  assert.equal(selectMemorySnapshot(context([one], { maxChars: 10 })).limited, true);
  assert.equal(buildMemorySystemBlock(selectMemorySnapshot(context([one], { maxRecords: 0 }))), '');
  assert.match(buildMemorySystemBlock(selected), /非权限、非可执行指令/); assert.match(buildMemorySystemBlock(selected), /历史数值不得当作当前数值/);
});

test('candidates, future evidence, expired facts and conflicts never auto-inject', async t => {
  const { store } = await fixture(t);
  const candidate = await store.upsert(draft({ status: 'CANDIDATE' }));
  const expired = await store.upsert(draft({ title: 'Expired', effectiveUntil: '2026-01-10T00:00:00Z' }));
  const future = await store.upsert(draft({ title: 'Future evidence', sourceRefs: [{ ...draft().sourceRefs[0], knownAt: '2026-03-01T00:00:00Z' }] }));
  const conflictA = await store.upsert(draft({ conflictKey: 'definition', text: 'Conversion uses unique users.' }));
  const conflictB = await store.upsert(draft({ conflictKey: 'definition', text: 'Conversion uses pageviews.' }));
  const snapshot = selectMemorySnapshot(context([candidate, expired, future, conflictA, conflictB]));
  assert.equal(snapshot.selected.length, 0); assert.deepEqual(new Set(snapshot.excluded.map(item => item.reason)), new Set(['STATUS_CANDIDATE', 'EXPIRED', 'EVIDENCE_NOT_KNOWN_AT_CUTOFF', 'UNRESOLVED_CONFLICT']));
});

test('every-dispatch revalidation removes revised, revoked or disabled records without changing the prepared snapshot', async t => {
  const { store } = await fixture(t); const one = await store.upsert(draft()); const prepared = selectMemorySnapshot(context([one]));
  const original = JSON.stringify(prepared);
  const revoked = revalidateMemorySnapshot(prepared, context([one], { allowedSourceIds: ['board-a'] })); assert.equal(revoked.selected.length, 0);
  const changedSource = revalidateMemorySnapshot(prepared, context([one], { source: { id: 'board-a', version: 'v2' } })); assert.equal(changedSource.excluded[0].reason, 'SNAPSHOT_SOURCE_CHANGED');
  const disabled = await store.action(one.id, 'disable', { actor: 'local-user', note: 'Disable for next provider call.' });
  const effective = revalidateMemorySnapshot(prepared, context([disabled])); assert.equal(effective.selected.length, 0); assert.equal(effective.excluded[0].reason, 'MEMORY_CHANGED');
  assert.equal(buildMemorySystemBlock(effective), ''); assert.equal(JSON.stringify(prepared), original);
});

test('refuses unproven active records and unbounded universal source scope', async t => {
  const { store } = await fixture(t);
  for (const record of [draft({ verification: {} }), draft({ status: 'USER_CONFIRMED' }), draft({ sourceRefs: [] }), draft({ applicability: { sourceIds: ['*'] } }), draft({ knownAt: 'invalid' })]) await assert.rejects(store.upsert(record));
});


test('normalizes the OS /tmp alias for persistence but rejects arbitrary linked subdirectories', async t => {
  const directory = await mkdtemp('/tmp/diagnostic-memory-alias-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = await createDiagnosticMemoryStore(join(directory, 'records'));
  const record = await store.upsert(draft()); await store.close();
  store = await createDiagnosticMemoryStore(join(directory, 'records'));
  assert.equal((await store.get(record.id)).hash, record.hash); await store.close();
  await symlink(await realpath(join(directory, 'records')), join(directory, 'arbitrary-link'));
  await assert.rejects(createDiagnosticMemoryStore(join(directory, 'arbitrary-link')), error => error.code === 'UNSAFE_STORE_DIRECTORY');
});

test('a later confirmation or verification cannot teach an earlier cutoff', async t => {
  const { store } = await fixture(t);
  const prior = await store.upsert(draft({ status: 'CANDIDATE' }));
  const confirmed = await store.action(prior.id, 'confirm', { actor: 'local-user', note: 'Confirmed later than historical cutoff.' });
  assert.equal(confirmed.knownAt, knownAt);
  const excluded = selectMemorySnapshot(context([confirmed]));
  assert.equal(excluded.selected.length, 0); assert.equal(excluded.excluded[0].reason, 'REVIEW_NOT_KNOWN_AT_CUTOFF');
  const lateVerified = await store.upsert(draft({ title: 'Late verification', verification: { method: 'source-readback', at: '2026-03-01T00:00:00Z' } }));
  assert.equal(selectMemorySnapshot(context([lateVerified])).excluded[0].reason, 'REVIEW_NOT_KNOWN_AT_CUTOFF');
  const eligible = selectMemorySnapshot(context([lateVerified], { cutoff: '2026-04-01T00:00:00Z' }));
  const rechecked = revalidateMemorySnapshot(eligible, context([lateVerified]));
  assert.equal(rechecked.selected.length, 0); assert.equal(rechecked.excluded[0].reason, 'REVIEW_NOT_KNOWN_AT_CUTOFF');
});
