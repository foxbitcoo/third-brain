import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalScopeIds, projectHistoricalTickets as projectRaw, validHistoricalTickets } from '../historical-tickets.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkbenchServer } from '../server.mjs';
import { createHash } from 'node:crypto';

const projectHistoricalTickets = (store, options = {}) => projectRaw(store, { sourceRefs: new Map([['source-a', 'chat-fixture'], ['source-b', 'chat-fixture-b']]), ...options });

const fixture = () => ({ version: 'historical-question-tickets/v1', generatedAt: '2026-10-18T04:00:00Z', window: { startAt: '2026-07-17T16:00:00Z', endAt: '2026-10-18T04:00:00Z' },
  coverage: { status: 'PARTIAL', notes: ['部分来源尚未补读。'] }, tickets: [{ id: 'q-1', title: '样例指标为什么下降？', question: '请核对样例变化。', status: 'ANSWERED', statusReason: '存在回复，根因尚未证实。', historical: true, autoExecute: false, sourceIds: ['source-a'],
    events: [{ sourceId: 'source-a', messageId: 'm-1', kind: 'question', speaker: '成员甲', occurredAt: '2026-08-01T01:00:00Z', quote: '样例指标为什么下降？' }, { sourceId: 'source-a', messageId: 'm-2', kind: 'answer', speaker: '成员乙', occurredAt: '2026-08-01T02:00:00Z', quote: '需要核对分子分母。', image: { status: 'NOT_READ', url: 'https://private.invalid/asset', local_path: '/private/asset.png' } }] }] });

test('historical answer evidence remains separate from resolution and current work', () => {
  const store = fixture(); assert.equal(validHistoricalTickets(store), true);
  const result = projectHistoricalTickets(store, { allowedSourceIds: new Set(['source-a']), ticketId: 'q-1' });
  assert.equal(result.ticket.status, 'ANSWERED'); assert.match(result.ticket.boundaries.join(' '), /不等同于问题已解决/);
  assert.equal(result.ticket.events[1].kind, 'reply'); assert.equal(result.ticket.events[1].images[0].available, false);
  assert.doesNotMatch(JSON.stringify(result), /private.invalid|local_path|speakerId|rawPayload/);
});

test('source removal hides entire mixed-source ticket, including title and merge summary', () => {
  const store = fixture(); store.tickets[0].sourceIds.push('source-b');
  assert.equal(projectHistoricalTickets(store, { allowedSourceIds: new Set(['source-a']) }).counts.total, 0);
  assert.equal(projectHistoricalTickets(store, { allowedSourceIds: new Set(['source-a']), scopeIds: new Set(['source-b']), excludedSourceIds: new Set(['source-b']), ticketId: 'q-1' }), null);
});

test('unknown sources are denied by default and evidence cannot grant its own scope', () => {
  const store = fixture(); store.authorizedSourceIds = ['source-a'];
  assert.equal(projectHistoricalTickets(store).counts.total, 0);
  const scope = { version: 'historical-ticket-scope/v1', basis: 'USER_REQUEST', ...store.window, sourceIds: ['source-a'], sourceRefs: { 'source-a': 'chat-fixture' } };
  assert.equal(projectHistoricalTickets(store, { scopeIds: historicalScopeIds(scope, store.window) }).counts.total, 1);
  assert.throws(() => historicalScopeIds({ ...scope, endAt: '2026-10-19T00:00:00Z' }, store.window));
});

test('rejects out-of-window quotes, missing question, duplicate events and executable backfill', () => {
  for (const change of [store => { store.tickets[0].events[0].occurredAt = '2026-06-01T00:00:00Z'; }, store => { store.tickets[0].events[0].kind = 'context'; }, store => { store.tickets[0].events.push(store.tickets[0].events[0]); }, store => { store.tickets[0].autoExecute = true; }]) {
    const store = fixture(); change(store); assert.equal(validHistoricalTickets(store), false);
  }
});

test('output is allowlisted and applies credential scrubbing without changing original evidence', () => {
  const store = fixture(); store.tickets[0].events[0].quote = 'secret-sentinel-value'; store.tickets[0].rawPayload = { privateValue: 'not-projected' };
  const result = projectHistoricalTickets(store, { allowedSourceIds: new Set(['source-a']), ticketId: 'q-1', secrets: ['secret-sentinel-value'] });
  assert.doesNotMatch(JSON.stringify(result), /secret-sentinel-value|not-projected/); assert.equal(store.tickets[0].events[0].quote, 'secret-sentinel-value');
});

test('date and coverage metadata cannot smuggle arbitrary strings or objects into output', () => {
  const store = fixture();
  store.coverage.checkedSources = { apiKey: 'secret-sentinel-value', local_path: '/private/example' };
  store.coverage.totalSources = -1;
  const result = projectHistoricalTickets(store, { allowedSourceIds: new Set(['source-a']) });
  assert.equal(result.coverage.checkedSources, null); assert.equal(result.coverage.totalSources, null);
  assert.doesNotMatch(JSON.stringify(result), /secret-sentinel-value|local_path|private\/example/);
  store.generatedAt = 'Oct 18 2026 04:00:00 GMT (secret-sentinel-value)';
  assert.equal(validHistoricalTickets(store), false);
});

test('answered status requires an actual reply after the historical question', () => {
  const store = fixture(); store.tickets[0].events.pop();
  assert.equal(validHistoricalTickets(store), false);
  const before = fixture(); before.tickets[0].events[1].occurredAt = '2026-07-31T02:00:00Z';
  assert.equal(validHistoricalTickets(before), false);
});

test('permanent message exclusions and missing native bindings hide the complete ticket', () => {
  const store = fixture();
  const blocked = createHash('sha256').update(JSON.stringify(['wps', 'chat-fixture', 'm-1'])).digest('hex');
  assert.equal(projectHistoricalTickets(store, { allowedSourceIds: new Set(['source-a']), blockedLocatorHashes: new Set([blocked]) }).counts.total, 0);
  assert.equal(projectRaw(store, { allowedSourceIds: new Set(['source-a']) }).counts.total, 0);
});

test('HTTP history route is read-only, requires separate scope and rejects a drifted scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'historical-tickets-'));
  let server;
  try {
    const store = fixture(), file = join(directory, 'tickets.json'), scope = join(directory, 'scope.json');
    await writeFile(file, JSON.stringify(store));
    await writeFile(scope, JSON.stringify({ version: 'historical-ticket-scope/v1', basis: 'USER_REQUEST', ...store.window, sourceIds: ['source-a'], sourceRefs: { 'source-a': 'chat-fixture' } }));
    server = await startWorkbenchServer({ port: 0, historicalTicketsPath: file, historicalTicketScopePath: scope });
    const base = `http://127.0.0.1:${server.address().port}`;
    let response = await fetch(`${base}/api/discovery-history`);
    assert.equal(response.status, 200); assert.equal((await response.json()).counts.total, 1);
    response = await fetch(`${base}/api/discovery-history?id=q-1`);
    assert.equal(response.status, 200); assert.equal((await response.json()).ticket.id, 'q-1');
    response = await fetch(`${base}/api/discovery-history`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 405);
    await writeFile(scope, JSON.stringify({ version: 'historical-ticket-scope/v1', basis: 'USER_REQUEST', ...store.window, endAt: '2026-10-19T00:00:00Z', sourceIds: ['source-a'], sourceRefs: { 'source-a': 'chat-fixture' } }));
    response = await fetch(`${base}/api/discovery-history`);
    assert.equal(response.status, 422); assert.doesNotMatch(await response.text(), /样例指标|source-a|m-1/);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('historical projection preserves explicit parent IDs without leaking raw payload',()=>{
  const store=fixture();store.tickets[0].events[0].quote_msg_id='quoted-parent';store.tickets[0].events[1].replyMessageId='m-1';
  store.tickets[0].events[0].rawPayload={token:'private-sentinel'};
  const result=projectHistoricalTickets(store,{allowedSourceIds:new Set(['source-a']),ticketId:'q-1'});
  assert.equal(result.ticket.events[0].quoteMessageId,'quoted-parent');assert.equal(result.ticket.events[1].replyMessageId,'m-1');assert.doesNotMatch(JSON.stringify(result),/private-sentinel|rawPayload/);
});
