import frozenFixture from './frozen-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, unlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkbenchServer } from '../server.mjs';
import { providerConfiguration, locatorHash } from '../live-qa.mjs';
import { buildHistoryIndex } from '../history-index.mjs';
import { sourceId } from '../wps-im-adapter.mjs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-live-qa-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataset = structuredClone(frozenFixture);
  const evidence = dataset.cases[0].evidence[0];
  evidence.locator = JSON.stringify({ platform: 'wps', sourceType: 'chat', sourceRef: 'synthetic-chat', itemRef: 'synthetic-message' });
  dataset.cases = [{ ...dataset.cases[0], evidence: [evidence], runs: [] }];
  const dataPath = join(directory, 'dataset.json');
  const attentionPath = join(directory, 'attention.json');
  const policy = status => ({ version: 1, sources: [{ id: sourceId('synthetic-chat'), status, manualOverride: true, tier: 'normal', matchedWorklines: [] }] });
  await writeFile(dataPath, JSON.stringify(dataset));
  await writeFile(attentionPath, JSON.stringify(policy('active')));
  const server = await startWorkbenchServer({ port: 0, dataPath, attentionPath, ...options });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const ask = (body, headers = {}) => fetch(`${url}/api/ask`, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { url, ask, attentionPath, policy, dataPath, dataset };
}

test('POST ask keeps origin, host, method, content type and bounded body gates', async t => {
  let calls = 0;
  const { url, ask } = await setup(t, { liveQaFetch: async () => { calls++; throw new Error('no network expected'); }, liveQaProviders: providerConfiguration({}) });
  const get = await fetch(`${url}/api/ask`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  for (const headers of [{ Origin: 'https://foreign.invalid' }, { 'Content-Type': 'text/plain' }, { Origin: '' }]) {
    const response = await ask({ question: '当前进展' }, headers);
    assert.ok([403, 405].includes(response.status), JSON.stringify({headers,status:response.status}));
  }
  const badHost = await new Promise((resolve, reject) => {
    const req = request(`${url}/api/ask`, { method: 'POST', headers: { Host: 'foreign.invalid', Origin: url, 'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end(JSON.stringify({ question: '当前进展' }));
  });
  assert.equal(badHost, 403);
  assert.equal((await ask('{broken')).status, 400);
  assert.equal((await ask({ question: '当前进展', endpoint: 'https://attacker.invalid' })).status, 400);
  assert.equal((await ask({ question: 'x'.repeat(70_000) })).status, 400);
  const valid = await ask({ question: '当前进展' });
  assert.equal(valid.status, 200);
  const result = await valid.json();
  assert.equal(result.sources.length, 1);
  assert.equal(result.answers.length, 1);
  assert.equal(result.answers[0].provider, 'doubao');
  assert.ok(result.answers.every(answer => answer.status === 'unconfigured'));
  assert.equal(result.policy_sources, undefined);
  assert.equal(calls, 0);
});

test('attention exclusion is loaded afresh and prevents model egress of excluded evidence', async t => {
  let calls = 0;
  const providers = providerConfiguration({ LIVE_QA_DOUBAO_API_KEY: 'synthetic-test-key' });
  const { ask, attentionPath, policy } = await setup(t, { liveQaProviders: providers,
    liveQaFetch: async () => { calls++; throw new Error('must not call'); } });
  await writeFile(attentionPath, JSON.stringify(policy('excluded')));
  const result = await (await ask({ question: '当前进展' })).json();
  assert.deepEqual(result.sources, []);
  assert.equal(result.answers[0].status, 'insufficient_evidence');
  assert.equal(calls, 0);
});

test('one active question rejects duplicate spending and an exclusion during generation suppresses delivery', async t => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const providers = providerConfiguration({ LIVE_QA_DOUBAO_API_KEY: 'synthetic-test-key' });
  const { ask, attentionPath, policy } = await setup(t, { liveQaProviders: providers,
    liveQaFetch: async (url, options) => {
      entered(); await gate;
      return new Response(JSON.stringify({ model: JSON.parse(options.body).model, choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ summary: '需确认安排。', claims: [{ text: '需确认安排。', source_ids: ['S001'] }], uncertainties: [] }) } }] }));
    } });
  const first = ask({ question: '当前进展' });
  await started;
  assert.equal((await ask({ question: '重复提交' })).status, 429);
  await writeFile(attentionPath, JSON.stringify(policy('excluded')));
  release();
  const result = await (await first).json();
  assert.deepEqual(result.sources, []);
  assert.ok(result.answers.every(answer => answer.answer === null && answer.error.code === 'SOURCE_POLICY_CHANGED'));
});


test('scope metadata matches eligible ask evidence across current/all, dedup, exclusion and blocked locators without model calls', async t => {
  let calls = 0;
  const { url, ask, attentionPath, policy, dataPath, dataset } = await setup(t, {
    liveQaProviders: providerConfiguration({}), liveQaFetch: async () => { calls++; throw new Error('must not call'); },
  });
  const first = dataset.cases[0];
  const additional = { ...first.evidence[0], id: 'scope-additional', source_title: '另一资料来源', text: 'scope-private-body-sentinel',
    occurred_at: '2026-10-14T09:00:00+08:00', locator: JSON.stringify({ platform: 'wps', sourceType: 'chat', sourceRef: 'other-chat', itemRef: 'other-message' }) };
  dataset.cases.push({ ...first, id: 'scope-second-case', evidence: [{ ...first.evidence[0], id: 'scope-duplicate' }, additional] });
  await writeFile(dataPath, JSON.stringify(dataset));
  const readScope = async caseId => {
    const response = await fetch(`${url}/api/ask-scope${caseId ? `?case_id=${encodeURIComponent(caseId)}` : ''}`);
    assert.equal(response.status, 200);
    const summary = await response.json();
    const answer = await (await ask({ question: '当前进展', ...(caseId ? { case_id: caseId } : {}) })).json();
    assert.equal(summary.record_count, answer.sources.length);
    assert.deepEqual(summary.source_titles, [...new Set(answer.sources.map(source => source.source_title))]);
    assert.equal(summary.mode, 'card_fallback');
    assert.ok(summary.coverage_gaps.includes('HISTORY_NOT_CONFIGURED_CARD_FALLBACK'));
    assert.equal(summary.returned_record_count, answer.sources.length);
    const serialized = JSON.stringify(summary);
    for (const value of ['scope-private-body-sentinel', 'other-chat', 'other-message', 'locator', 'speaker', 'policy_sources', 'apiKey']) assert.equal(serialized.includes(value), false, value);
    return summary;
  };
  const all = await readScope();
  assert.equal(all.record_count, 2);
  assert.equal(all.case_count, 2);
  assert.equal(all.latest, additional.occurred_at);
  const current = await readScope(first.id);
  assert.equal(current.record_count, 1);
  assert.equal(current.case_count, 1);
  assert.equal(current.earliest, first.evidence[0].occurred_at);
  assert.equal((await readScope('scope-second-case')).record_count, 2);
  await writeFile(attentionPath, JSON.stringify(policy('excluded')));
  assert.equal((await readScope()).record_count, 1);
  assert.deepEqual((await readScope(first.id)).source_titles, []);
  const originalHashes = process.env.LIVE_QA_BLOCKED_LOCATOR_HASHES;
  t.after(() => { if (originalHashes === undefined) delete process.env.LIVE_QA_BLOCKED_LOCATOR_HASHES; else process.env.LIVE_QA_BLOCKED_LOCATOR_HASHES = originalHashes; });
  process.env.LIVE_QA_BLOCKED_LOCATOR_HASHES = locatorHash(additional);
  const blocked = await readScope();
  assert.equal(blocked.record_count, 0);
  assert.equal(blocked.earliest, null);
  assert.equal(blocked.latest, null);
  assert.equal(calls, 0);
});

test('scope GET sanitizes titles and rejects unknown cases, invalid query and foreign origin safely', async t => {
  let calls = 0;
  const { url, dataPath, dataset } = await setup(t, {
    liveQaProviders: providerConfiguration({ LIVE_QA_DOUBAO_API_KEY: 'synthetic-exact-secret' }),
    liveQaFetch: async () => { calls++; throw new Error('must not call'); },
  });
  dataset.cases[0].evidence[0].source_title = '来源 synthetic-exact-secret';
  await writeFile(dataPath, JSON.stringify(dataset));
  const summary = await (await fetch(`${url}/api/ask-scope`)).json();
  assert.equal(summary.source_titles[0].includes('synthetic-exact-secret'), false);
  assert.equal(summary.record_count, 1);
  const unknown = await fetch(`${url}/api/ask-scope?case_id=unknown-private-id`);
  assert.equal(unknown.status, 400);
  const error = await unknown.json();
  assert.equal(error.error.code, 'UNKNOWN_CASE');
  assert.equal(JSON.stringify(error).includes('unknown-private-id'), false);
  for (const query of ['case_id=', 'case_id=one&case_id=two', 'model=override']) assert.equal((await fetch(`${url}/api/ask-scope?${query}`)).status, 400);
  assert.equal((await fetch(`${url}/api/ask-scope`, { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal((await fetch(`${url}/api/ask-scope`, { method: 'POST' })).status, 405);
  assert.equal(calls, 0);
});


test('history Q&A retrieves older linked evidence instead of only recent card excerpts and reports honest counts', async t => {
  let payload;
  const { dataset, dataPath } = await setup(t);
  const old = { ...dataset.cases[0].evidence[0], id: 'old-budget', text: '历史批准预算：三万元已获批准。 synthetic-test-key password=short-secret', occurred_at: '2025-01-03T09:00:00+08:00',
    locator: JSON.stringify({ platform: 'wps', sourceType: 'chat', sourceRef: 'synthetic-chat', itemRef: 'old-budget-message' }) };
  const variant = { ...old, text: '历史批准预算：五万元存在冲突。' };
  const index = buildHistoryIndex({ cases: [{ ...dataset.cases[0], evidence: [old, variant, ...dataset.cases[0].evidence] }] });
  index.coverage_gaps = ['7月摘要已定位，原始消息身份待核实；未纳入事实检索'];
  const historyPath = join(dataPath, '..', 'history.json');
  await writeFile(historyPath, JSON.stringify(index));
  // A second server uses the same immutable current cards and separate private history.
  const server = await startWorkbenchServer({ port: 0, dataPath, historyPath, attentionPath: join(dataPath, '..', 'attention.json'),
    liveQaProviders: providerConfiguration({ LIVE_QA_DOUBAO_API_KEY: 'synthetic-test-key' }), liveQaFetch: async (url, options) => {
      payload = JSON.parse(options.body);
      const source = JSON.parse(payload.messages[1].content).sources.find(source => source.text.includes('三万元'));
      assert.ok(source, 'older evidence must reach Seed');
      assert.equal(JSON.stringify(payload).includes('synthetic-test-key'), false);
      assert.equal(JSON.stringify(payload).includes('short-secret'), false);
      assert.match(payload.messages[0].content, /子集/);
      assert.match(payload.messages[0].content, /不能据此断言没有进展/);
      return new Response(JSON.stringify({ model: payload.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: '历史预算已经批准。', claims: [{ text: '历史预算已经批准。', source_ids: [source.id] }], uncertainties: ['后续执行仍待核实。'] }) } }] }));
    } });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const historyUrl = `http://127.0.0.1:${server.address().port}`;
  const before = await (await fetch(`${historyUrl}/api/ask-scope?case_id=${dataset.cases[0].id}`)).json();
  assert.equal(before.mode, 'cumulative_history');
  assert.equal(before.retained_record_count, 3);
  assert.deepEqual(before.coverage_notes, index.coverage_gaps);
  assert.equal(before.linked_record_count, 3);
  assert.equal(before.retained_unique_message_count, 2);
  assert.equal(before.retained_version_count, 3);
  assert.equal(before.revision_count, 1);
  assert.equal(before.returned_record_count, 0);
  assert.equal(Date.parse(before.earliest), Date.parse(old.occurred_at));
  assert.equal(JSON.stringify(before).includes('三万元'), false);
  const response = await fetch(`${historyUrl}/api/ask`, { method: 'POST', headers: { Origin: historyUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '历史批准预算', case_id: dataset.cases[0].id }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.answers[0].status, 'ok');
  assert.ok(result.sources.some(source => source.text.includes('三万元')));
  assert.equal(result.scope.answer_citation_count, 1);
  assert.equal(result.scope.returned_record_count, result.sources.length);
  assert.equal(result.scope.retained_record_count, 3);
  assert.equal(result.scope.retained_unique_message_count, 2);
  assert.equal(result.scope.retained_version_count, 3);
  assert.ok(result.scope.coverage_gaps.includes('LATEST_PROGRESS_NOT_PROVEN'));
  assert.equal(result.boundary.curated_only, false);
  const queryScope = await (await fetch(`${historyUrl}/api/ask-scope?question=${encodeURIComponent('历史批准预算')}`)).json();
  assert.equal(queryScope.returned_record_count, result.sources.length);
});

test('malformed configured history fails closed and never falls back to card evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'history-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const historyPath = join(directory, 'history.json');
  await writeFile(historyPath, '{broken-private-sentinel');
  let calls = 0;
  const { url, ask } = await setup(t, { historyPath, liveQaProviders: providerConfiguration({ LIVE_QA_DOUBAO_API_KEY: 'synthetic-test-key' }), liveQaFetch: async () => { calls++; throw Error(); } });
  for (const response of [await ask({ question: '进展' }), await fetch(`${url}/api/ask-scope`)]) {
    assert.equal(response.status, 422);
    const result = await response.json();
    assert.equal(result.error.code, 'HISTORY_INVALID');
    assert.equal(JSON.stringify(result).includes('private-sentinel'), false);
  }
  await writeFile(historyPath, JSON.stringify({ version: 'invalid', records: [] }));
  assert.equal((await ask({ question: '进展' })).status, 422);
  assert.equal(calls, 0);
});

test('history current allowlist rejects candidates and unknown rows, and rechecks newly inactive sources after generation', async t => {
  let release, enter;
  const started = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const directory = await mkdtemp(join(tmpdir(), 'history-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const historyPath = join(directory, 'history.json');
  // Start with a valid empty index; replace it after setup exposes the neutral fixture.
  await writeFile(historyPath, JSON.stringify(buildHistoryIndex({ cases: [] })));
  const { ask, attentionPath, policy, dataset } = await setup(t, { historyPath, liveQaProviders: providerConfiguration({ LIVE_QA_DOUBAO_API_KEY: 'synthetic-test-key' }), liveQaFetch: async (url, options) => {
    enter(); await gate;
    return new Response(JSON.stringify({ model: JSON.parse(options.body).model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: '仍待确认。', claims: [{ text: '仍待确认。', source_ids: ['S001'] }], uncertainties: [] }) } }] }));
  } });
  const known = dataset.cases[0].evidence[0];
  const unknown = { ...known, text: 'unknown-private-sentinel', locator: JSON.stringify({ platform: 'wps', sourceType: 'chat', sourceRef: 'unknown-source', itemRef: 'unknown-message' }) };
  await writeFile(historyPath, JSON.stringify(buildHistoryIndex({ cases: [{ ...dataset.cases[0], evidence: [known, unknown] }] })));
  await writeFile(attentionPath, JSON.stringify(policy('candidate')));
  const denied = await (await ask({ question: '确认', case_id: dataset.cases[0].id })).json();
  assert.equal(denied.sources.length, 0);
  assert.equal(denied.answers[0].status, 'insufficient_evidence');
  assert.equal(denied.scope.stored_unique_message_count, 2);
  assert.equal(denied.scope.retained_unique_message_count, 0);
  await writeFile(attentionPath, JSON.stringify({ version: 1, sources: [{ ...policy('active').sources[0], manualOverride: false, decisionOrigin: 'keyword' }] }));
  const keywordOnly = await (await ask({ question: '确认', case_id: dataset.cases[0].id })).json();
  assert.equal(keywordOnly.sources.length, 0);
  assert.equal(keywordOnly.answers[0].status, 'insufficient_evidence');
  await writeFile(attentionPath, JSON.stringify(policy('active')));
  const pending = ask({ question: '确认', case_id: dataset.cases[0].id });
  await started;
  await writeFile(attentionPath, JSON.stringify(policy('candidate')));
  release();
  const hidden = await (await pending).json();
  assert.equal(hidden.sources.length, 0);
  assert.equal(hidden.scope.answer_citation_count, 0);
  assert.equal(hidden.answers[0].error.code, 'SOURCE_POLICY_CHANGED');
  assert.equal(JSON.stringify(hidden).includes('unknown-private-sentinel'), false);
});


test('history inputs enforce absolute outside-checkout paths at startup and on each read', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'history-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkoutFile = fileURLToPath(new URL('./frozen-fixture.mjs', import.meta.url));
  await assert.rejects(startWorkbenchServer({ port: 0, historyPath: checkoutFile }), { code: 'DATA_PATH_NOT_ALLOWED' });
  const original = join(directory, 'original.json');
  const historyPath = join(directory, 'selected.json');
  await writeFile(original, JSON.stringify(buildHistoryIndex({ cases: [] })));
  await symlink(original, historyPath);
  const { url, ask } = await setup(t, { historyPath });
  assert.equal((await fetch(`${url}/api/ask-scope`)).status, 200);
  await unlink(historyPath);
  await symlink(checkoutFile, historyPath);
  for (const response of [await fetch(`${url}/api/ask-scope`), await ask({ question: '预算' })]) {
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'DATA_PATH_NOT_ALLOWED');
  }
});


test('history has an independent 128 MiB limit and fails explicitly above it without model egress', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'history-capacity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const historyPath = join(directory, 'history.json');
  // Valid JSON above the dataset's 20 MiB limit exercises only the history reader.
  await writeFile(historyPath, JSON.stringify(buildHistoryIndex({ cases: [] })) + ' '.repeat(21 * 1024 * 1024));
  let calls = 0;
  const { url, ask } = await setup(t, { historyPath, liveQaProviders: providerConfiguration({ LIVE_QA_DOUBAO_API_KEY: 'synthetic-test-key' }), liveQaFetch: async () => { calls++; throw Error('must not call'); } });
  const accepted = await fetch(`${url}/api/ask-scope`);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).mode, 'cumulative_history');
  // A sparse extension tests the bound without writing a large body or truncating evidence.
  await truncate(historyPath, 128 * 1024 * 1024 + 1);
  for (const response of [await ask({ question: '进展' }), await fetch(`${url}/api/ask-scope`)]) {
    assert.equal(response.status, 413);
    const result = await response.json();
    assert.equal(result.error.code, 'HISTORY_TOO_LARGE');
    assert.equal(result.sources, undefined);
    assert.equal(JSON.stringify(result).includes(historyPath), false);
  }
  assert.equal(calls, 0);
});
