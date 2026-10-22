import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { askQuestion, providerConfiguration, blockedLocatorConfiguration, sanitizeText, buildEvidenceContext,
  validateAskInput, applySourcePolicyFence, locatorHash } from '../live-qa.mjs';
import { sourceId } from '../wps-im-adapter.mjs';
import { buildHistoryIndex } from '../history-index.mjs';

const locator = (sourceRef = 'synthetic-chat', itemRef = 'synthetic-message') => JSON.stringify({ platform: 'wps', sourceType: 'chat', sourceRef, itemRef });
function fixture() {
  const evidence = { id: 'old-id', text: '当前仍需确认时间。', source_type: 'im', source_title: '样例工作群', speaker: '同事',
    occurred_at: '2026-10-10T09:00:00+08:00', locator: locator() };
  return { as_of: '2026-10-11T12:00:00+08:00', cases: [{ id: 'one', evidence: [evidence] },
    { id: 'two', evidence: [{ ...evidence, id: 'different-case-id' }] }] };
}
const configured = () => providerConfiguration({ LIVE_QA_DEEPSEEK_API_KEY: 'synthetic-deepseek-credential', LIVE_QA_MIMO_API_KEY: 'synthetic-mimo-credential', LIVE_QA_DOUBAO_API_KEY: 'synthetic-doubao-credential' });
const validAnswer = () => ({ summary: '时间仍待确认。', claims: [{ text: '当前仍需确认时间。', source_ids: ['S001'] }], uncertainties: ['未见正式排期。'] });
const reply = (model, answer = validAnswer()) => new Response(JSON.stringify({ model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] }));

test('post-generation exclusion hides metadata of unselected historical sources too', async () => {
  const data = fixture();
  const historyIndex = buildHistoryIndex({ corpusRecords: [
    { ...data.cases[0].evidence[0], text: 'HTML上线', locator: locator('alpha', 'one') },
    { ...data.cases[0].evidence[0], text: '预算审批', source_title: '另一个资料来源', locator: locator('beta', 'two') },
  ] });
  const allowedSourceIds = new Set([sourceId('alpha'), sourceId('beta')]);
  const result = await askQuestion({ dataset: data, historyIndex, allowedSourceIds,
    input: { question: 'HTML', facts: [] }, providers: configured(),
    fetchImpl: async () => reply(configured()[0].model) });
  assert.equal(result.sources.length, 1);
  assert.equal(result.scope.source_titles.includes('另一个资料来源'), true);
  const safe = applySourcePolicyFence(result, new Set([sourceId('beta')]), new Set([sourceId('alpha')]));
  assert.equal(safe.sources.length, 0);
  assert.equal(safe.scope.source_titles, undefined);
  assert.equal(safe.scope.retained_record_count, undefined);
  assert.equal(JSON.stringify(safe).includes('policy_sources'), false);
});

test('live Q&A pins the sole official Seed model despite environment overrides', () => {
  const configs = providerConfiguration({ LIVE_QA_DEEPSEEK_API_KEY: 'synthetic-ignored-key', LIVE_QA_MIMO_API_KEY: 'synthetic-ignored-key',
    LIVE_QA_DOUBAO_BASE_URL: 'https://attacker.invalid', LIVE_QA_DOUBAO_MODEL: 'another-model' });
  assert.equal(configs.length, 1);
  assert.equal(configs[0].provider, 'doubao');
  assert.equal(configs[0].endpoint, 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
  assert.equal(configs[0].model, 'doubao-seed-2-1-pro-260915');
  assert.equal(configs[0].apiKey, '');
  for (const value of [{ question: '问题', api_key: 'not-allowed' }, { question: '问题', model: 'override' },
    { question: '问题', endpoint: 'https://attacker.invalid' }, { question: '' }, { question: 'x'.repeat(4001) },
    { question: '问题', facts: [{ text: 'object' }] }, { question: '问题', facts: Array(21).fill('事实') }]) assert.throws(() => validateAskInput(value));
  assert.deepEqual(validateAskInput({ question: ' 问题 ', facts: [' 事实 '] }), { question: '问题', facts: ['事实'] });
});

test('sanitizer covers stored exact secrets and credential formats before any egress', () => {
  const values = ['synthetic-runtime-secret', 'sk-SyntheticKey1234567890123', 'ghp_' + 'SyntheticToken1234567890123',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SyntheticSignature', 'password=short-secret', '密钥是short-secret',
    'api_key: short-secret', 'wps_sid=synthetic-short-secret', 'Bearer short-token', 'https://name:pass@example.invalid/',
    'https://example.invalid/?token=short-secret', '-----BEGIN ' + 'PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
    'AbCdEfGhIjKlMnOpQrStUvWxYzabcdef'];
  const cleaned = sanitizeText(values.join('\n'), [values[0]]);
  for (const secret of ['synthetic-runtime-secret', 'SyntheticKey', 'SyntheticToken', 'SyntheticSignature', 'synthetic-short-secret', 'short-token', 'name:pass', 'PRIVATE KEY', values.at(-1)]) assert.equal(cleaned.includes(secret), false, secret);
  assert.equal(sanitizeText('上线时间仍待确认，先按两阶段推进。'), '上线时间仍待确认，先按两阶段推进。');
});

test('source identities deduplicate locators across cases and respect current hashed attention IDs', () => {
  const data = fixture();
  const input = validateAskInput({ question: '进展？', facts: ['用户确认次日讨论。'] });
  const context = buildEvidenceContext(data, input);
  assert.equal(context.sources.length, 2);
  assert.equal(context.duplicateCount, 1);
  assert.deepEqual(context.sources.map(source => source.id), ['S001', 'U001']);
  assert.equal(context.sources[1].source_type, 'user_fact');
  assert.equal(context.sources[1].occurred_at, null);
  const denied = buildEvidenceContext(data, input, { excludedSourceIds: new Set([sourceId('synthetic-chat')]) });
  assert.equal(denied.sources.length, 1);
  assert.equal(denied.sources[0].source_type, 'user_fact');
  assert.throws(() => buildEvidenceContext(data, { ...input, case_id: 'missing' }), /UNKNOWN_CASE/);
});

test('human-readable locators do not merge different documents; native content variants stay citable', () => {
  const data = fixture();
  const original = data.cases[0].evidence[0];
  data.cases[0].evidence = [
    { ...original, source_type: 'document', document_id: 'doc-a', source_title: '方案甲', locator: '第 1 节' },
    { ...original, source_type: 'document', document_id: 'doc-b', source_title: '方案乙', locator: '第 1 节' },
  ];
  data.cases[1].evidence = [];
  assert.equal(buildEvidenceContext(data, { question: '问题', facts: [] }).sources.length, 0);
  const docs = buildEvidenceContext(data, { question: '问题', facts: [] }, { documentPolicy: { version: 'document-source-policy-v1', documents: [{ documentId: 'doc-a', status: 'allowed' }, { documentId: 'doc-b', status: 'allowed' }] } });
  assert.equal(docs.sources.length, 2);
  assert.deepEqual(docs.sources.map(source => source.source_title), ['方案甲', '方案乙']);

  data.cases[0].evidence = [original];
  data.cases[1].evidence = [
    { ...original, id: 'duplicate' },
    { ...original, id: 'changed-text', text: '时间已确认。' },
    { ...original, id: 'changed-speaker', speaker: '另一位同事' },
    { ...original, id: 'changed-time', occurred_at: '2026-10-10T10:00:00+08:00' },
  ];
  const variants = buildEvidenceContext(data, { question: '问题', facts: [] });
  assert.equal(variants.sources.length, 4);
  assert.equal(variants.duplicateCount, 1);
  assert.equal(new Set(variants.sources.map(source => source.id)).size, 4);
  assert.ok(variants.sources.some(source => source.text === '时间已确认。'));
});

test('original source_ids survive normalization and deduplication for post-answer exclusion fences', async () => {
  const data = fixture();
  data.cases[0].evidence[0].source_ids = ['  original-policy-id  ', 123, null, {}];
  data.cases[1].evidence[0].source_ids = ['second-policy-id'];
  const context = buildEvidenceContext(data, { question: '问题', facts: [] });
  assert.ok(context.sources[0].source_ids.includes('original-policy-id'));
  assert.ok(context.sources[0].source_ids.includes('123'));
  assert.ok(context.sources[0].source_ids.includes('second-policy-id'));
  const result = await askQuestion({ dataset: data, input: { question: '当前进展' }, providers: configured(),
    fetchImpl: async (url, options) => reply(JSON.parse(options.body).model) });
  for (const id of ['original-policy-id', 'second-policy-id', '123']) {
    const hidden = applySourcePolicyFence(result, new Set([id]));
    assert.equal(hidden.sources.length, 0);
    assert.ok(hidden.answers.every(answer => answer.error.code === 'SOURCE_POLICY_CHANGED'));
  }
  const blocked = buildEvidenceContext({ ...data, cases: [data.cases[0]] }, { question: '问题', facts: [] }, { excludedSourceIds: new Set(['original-policy-id']) });
  assert.equal(blocked.sources.length, 0);
});

test('private denylist drops a record by canonical locator hash without storing private IDs in code', () => {
  const data = fixture();
  const hash = createHash('sha256').update(JSON.stringify(['wps', 'synthetic-chat', 'synthetic-message'])).digest('hex');
  assert.equal(locatorHash(data.cases[0].evidence[0]), hash);
  const hashes = blockedLocatorConfiguration({ LIVE_QA_BLOCKED_LOCATOR_HASHES: hash });
  assert.equal(buildEvidenceContext(data, { question: '问题', facts: [] }, { blockedLocatorHashes: hashes }).sources.length, 0);
  assert.throws(() => blockedLocatorConfiguration({ LIVE_QA_BLOCKED_LOCATOR_HASHES: 'invalid' }));
});

test('only Seed receives sanitized facts and exposes the exact requested and returned model', async () => {
  const calls = [];
  const providers = configured();
  const data = fixture();
  data.cases[0].evidence[0].text += ' api_key=synthetic-short-secret';
  const promise = askQuestion({ dataset: data, input: { question: `进展 ${providers[0].apiKey}`, facts: ['password=short-secret 用户补充'] }, providers,
    fetchImpl: async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return reply(JSON.parse(options.body).model); } });
  const result = await promise;
  assert.equal(calls.length, 1);
  assert.equal(result.answers.length, 1);
  assert.equal(result.answers[0].provider, 'doubao');
  assert.equal(new Set(calls.map(call => call.body.messages[1].content)).size, 1);
  const egress = calls[0].body.messages[1].content;
  assert.equal(egress.includes('synthetic-short-secret'), false);
  assert.equal(egress.includes(providers[0].apiKey), false);
  assert.equal(egress.includes('user_fact'), true);
  assert.equal(calls[0].body.max_tokens, 4096);
  assert.equal(calls[0].body.max_completion_tokens, undefined);
  for (const call of calls) { assert.deepEqual(call.body.thinking, { type: 'disabled' }); assert.equal(call.body.stream, false); assert.equal(call.options.redirect, 'error'); assert.equal(call.body.tools, undefined); }
  for (const [index, answer] of result.answers.entries()) {
    assert.equal(answer.status, 'ok');
    assert.equal(answer.requested_model, providers[index].model);
    assert.equal(answer.returned_model, providers[index].model);
  }
  const publicResult = applySourcePolicyFence(result, new Set());
  assert.equal('policy_sources' in publicResult, false);
  assert.equal(JSON.stringify(publicResult).includes('source_ids'), true, 'claim citation IDs are public');
  assert.equal('source_ids' in publicResult.sources[0], false, 'private policy join IDs are not public');
  const hidden = applySourcePolicyFence(result, new Set([sourceId('synthetic-chat')]));
  assert.equal(hidden.sources.length, 0);
  assert.ok(hidden.answers.every(answer => answer.answer === null && answer.error.code === 'SOURCE_POLICY_CHANGED'));
});

test('Seed failure or timeout never triggers another provider or exposes upstream bodies', async () => {
  for (const failure of ['error', 'timeout']) {
    const calls = [];
    const result = await askQuestion({ dataset: fixture(), input: { question: '进展？' }, providers: configured(), timeoutMs: 25,
      fetchImpl: async (url, options) => {
        calls.push({ url, model: JSON.parse(options.body).model });
        return failure === 'error' ? new Response('upstream-private-sentinel', { status: 401 }) : new Promise(() => {});
      } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'doubao-seed-2-1-pro-260915');
    assert.deepEqual(result.answers.map(answer => answer.status), [failure]);
    assert.equal(JSON.stringify(result).includes('upstream-private-sentinel'), false);
  }
});

test('hallucinated citations, missing model and truncated response fail closed', async () => {
  for (const kind of ['unknown-citation', 'missing-model', 'truncated', 'invalid-json']) {
    const result = await askQuestion({ dataset: fixture(), input: { question: '进展？' }, providers: configured().slice(0, 1),
      fetchImpl: async (url, options) => {
        const answer = validAnswer();
        if (kind === 'unknown-citation') answer.claims[0].source_ids = ['MADE-UP'];
        return new Response(JSON.stringify({ ...(kind === 'missing-model' ? {} : { model: JSON.parse(options.body).model }),
          choices: [{ finish_reason: kind === 'truncated' ? 'length' : 'stop', message: { content: kind === 'invalid-json' ? 'bad' : JSON.stringify(answer) } }] }));
      } });
    assert.equal(result.answers[0].status, 'invalid_response', kind);
    assert.equal(result.answers[0].answer, null);
  }
});

test('a returned model different from the requested model is never accepted as success', async () => {
  const result = await askQuestion({ dataset: fixture(), input: { question: '进展？' }, providers: configured().slice(0, 1),
    fetchImpl: async () => reply('different-model') });
  assert.equal(result.answers[0].status, 'invalid_response');
  assert.equal(result.answers[0].error.code, 'RETURNED_MODEL_MISMATCH');
  assert.equal(result.answers[0].requested_model, 'doubao-seed-2-1-pro-260915');
  assert.equal(result.answers[0].returned_model, 'different-model');
  assert.equal(result.answers[0].answer, null);
});

test('no credentials, no evidence, and unofficial destination cause zero network calls', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not call'); };
  const noKeys = await askQuestion({ dataset: fixture(), input: { question: '问题' }, providers: providerConfiguration({}), fetchImpl });
  assert.ok(noKeys.answers.every(answer => answer.status === 'unconfigured'));
  const noEvidence = await askQuestion({ dataset: fixture(), input: { question: '问题' }, providers: configured(), excludedSourceIds: new Set([sourceId('synthetic-chat')]), fetchImpl });
  assert.ok(noEvidence.answers.every(answer => answer.status === 'insufficient_evidence'));
  const unofficial = await askQuestion({ dataset: fixture(), input: { question: '问题' }, providers: [{ ...configured()[0], endpoint: 'https://attacker.invalid' }], fetchImpl });
  assert.equal(unofficial.answers[0].status, 'unconfigured');
  const wrongModel = await askQuestion({ dataset: fixture(), input: { question: '问题' }, providers: [{ ...configured()[0], model: 'different-model' }], fetchImpl });
  assert.equal(wrongModel.answers[0].status, 'unconfigured');
  const retiredProvider = await askQuestion({ dataset: fixture(), input: { question: '问题' }, providers: [{ ...configured()[0], provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-pro' }], fetchImpl });
  assert.equal(retiredProvider.answers[0].status, 'unconfigured');
  assert.equal(calls, 0);
});

test('only projected evidence is sent; generated output credentials are sanitized too', async () => {
  const data = fixture();
  const providers = configured().slice(0, 1);
  data.cases[0].runs = [{ answer: 'historical-answer-sentinel', private_metadata: 'private-metadata-sentinel' }];
  data.cases[0].evidence[0].private_metadata = 'private-metadata-sentinel';
  const result = await askQuestion({ dataset: data, input: { question: '当前进展', case_id: 'one' }, providers,
    fetchImpl: async (url, options) => {
      assert.equal(options.body.includes('historical-answer-sentinel'), false);
      assert.equal(options.body.includes('private-metadata-sentinel'), false);
      const answer = validAnswer();
      answer.summary += providers[0].apiKey;
      answer.claims[0].text += ' password=short-secret';
      answer.uncertainties.push('api_key=synthetic-short-secret');
      return reply(JSON.parse(options.body).model, answer);
    } });
  assert.equal(result.answers[0].status, 'ok');
  assert.equal(JSON.stringify(result).includes(providers[0].apiKey), false);
  assert.equal(JSON.stringify(result).includes('synthetic-short-secret'), false);
});
