import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, rename, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDataset } from '../data.mjs';
import { parseArgs, startWorkbenchServer } from '../server.mjs';
import { validReadingGuide } from '../reading-guide.mjs';

function fixture() {
  return {
    schema_version: 'business-qa-v1',
    dataset_id: 'neutral-example',
    as_of: '2026-09-05T12:00:00+08:00',
    cases: [{
      id: 'planning', title: '计划讨论', question: '下一步是什么？',
      as_of: '2026-09-05T12:00:00+08:00', scope: '中性样例',
      evidence: [{
        id: 'E001', source_type: 'im', source_title: '样例讨论',
        occurred_at: '2026-09-04T09:00:00+08:00', speaker: '成员甲',
        text: '建议先确认样例的时间安排。', locator: '样例第 1 条',
      }],
      runs: [{
        id: 'authored-example', route: 'A', model: 'authored-example',
        provider: 'neutral-fixture', status: 'NOT_RUN',
        answer: {
          summary: '先确认时间安排。',
          developments: [{ text: '时间安排有待确认。', evidence_ids: ['E001'] }],
          viewpoints: [{ person: '成员甲', text: '先确认时间。', evidence_ids: ['E001'] }],
          decisions: [], open_questions: [],
          next_steps: [{ text: '确认时间安排。', kind: 'source_task', evidence_ids: ['E001'] }],
        },
        metrics: { latency_ms: null, input_tokens: null, output_tokens: null, cost_cny: null },
        audit: { citations: 'not_checked', review_status: 'PENDING_USER' },
      }],
    }],
  };
}

function guidedFixture() {
  const dataset = fixture();
  // Synthetic statuses exercise the display contract, not real provider calls.
  dataset.cases[0].runs[0].status = 'VERIFIED';
  dataset.cases[0].runs.push({ ...structuredClone(dataset.cases[0].runs[0]), id: 'comparison-example', route: 'B' });
  const line = text => ({ text, evidence_ids: ['E001'] });
  const guide = {
    schema_version: 'business-reading-guide-v1', dataset_id: dataset.dataset_id,
    cases: [{ case_id: 'planning', run_id: 'authored-example', comparison_run_id: 'comparison-example',
      title: '先确认时间安排', current: line('时间仍待确认。'),
      follow_up: { person: '成员甲', ...line('建议了解时间安排。') },
      confirm: line('确认可用的日期。'), boundary: line('尚未确认正式排期。'),
      answer_url: 'https://example.invalid/answer',
    }],
  };
  return { dataset, guide };
}

test('new worklines may have an on-page answer without inventing an external document URL', () => {
  const { dataset, guide } = guidedFixture();
  guide.cases[0].answer_url = null;
  assert.equal(validReadingGuide(guide, dataset), true);
  guide.cases[0].answer_url = '';
  assert.equal(validReadingGuide(guide, dataset), false);
});

test('reading guide requires exact dataset, readable run and within-case evidence bindings', () => {
  const { dataset, guide } = guidedFixture();
  const original = structuredClone({ dataset, guide });
  assert.equal(validReadingGuide(guide, dataset), true);
  assert.deepEqual({ dataset, guide }, original);
  const changes = [
    row => { row.schema_version = 'another-contract'; },
    row => { row.dataset_id = 'other-dataset'; },
    row => { row.extra_private_field = 'sentinel'; },
    row => { row.cases = []; },
    row => { row.cases.push(structuredClone(row.cases[0])); },
    row => { row.cases[0].case_id = 'other-case'; },
    row => { row.cases[0].run_id = 'unknown-run'; },
    row => { row.cases[0].comparison_run_id = 'unknown-run'; },
    row => { row.cases[0].comparison_run_id = row.cases[0].run_id; },
    row => { row.cases[0].title = 'x'.repeat(81); },
    row => { row.cases[0].current.text = 'x'.repeat(241); },
    row => { row.cases[0].current.text = 'line\nbreak'; },
    row => { row.cases[0].follow_up.person = ''; },
    row => { row.cases[0].boundary.evidence_ids = []; },
    row => { row.cases[0].confirm.evidence_ids = ['unknown-evidence']; },
    row => { row.cases[0].confirm.evidence_ids = ['E001', 'E001']; },
    row => { row.cases[0].answer_url = 'javascript:alert(1)'; },
    row => { row.cases[0].answer_url = 'http://example.invalid'; },
    row => { row.cases[0].answer_url = 'https://user:pass@example.invalid'; },
    row => { row.cases[0].answer_url = 'https://example.invalid/' + 'a'.repeat(2048); },
  ];
  for (const change of changes) {
    const changed = structuredClone(guide);
    change(changed);
    assert.equal(validReadingGuide(changed, dataset), false, change.toString());
  }
  for (const status of ['FAILED', 'BLOCKED', 'NOT_RUN']) {
    const changed = structuredClone(dataset);
    changed.cases[0].runs[0].status = status;
    assert.equal(validReadingGuide(guide, changed), false);
  }
  const changed = structuredClone(dataset);
  changed.cases[0].runs[1].answer = null;
  assert.equal(validReadingGuide(guide, changed), false);
  changed.cases[0].runs[1].answer = dataset.cases[0].runs[1].answer;
  changed.cases.push({ ...structuredClone(changed.cases[0]), id: 'other-case', evidence: [{ ...changed.cases[0].evidence[0], id: 'E002' }] });
  const crossed = structuredClone(guide);
  crossed.cases[0].current.evidence_ids = ['E002'];
  assert.equal(validReadingGuide(crossed, changed), false);
});

test('reading cards accept the optional origin and a null comparison without weakening run validation', () => {
  const { dataset, guide } = guidedFixture();
  guide.cases[0].comparison_run_id = null;
  dataset.cases[0].runs = dataset.cases[0].runs.slice(0, 1);
  const original = structuredClone({ dataset, guide });
  assert.equal(validReadingGuide(guide, dataset), true, 'legacy origin defaults remain accepted with one answer');
  assert.deepEqual({ dataset, guide }, original);
  for (const content_kind of ['assistant_reading_guide', 'model_generated_short_card']) {
    assert.equal(validReadingGuide({ ...guide, content_kind }, dataset), true);
  }
  for (const content_kind of ['unknown-kind', '', null, undefined, {}]) {
    assert.equal(validReadingGuide({ ...guide, content_kind }, dataset), false);
  }
  for (const comparison of ['', undefined, 'missing-run', guide.cases[0].run_id]) {
    const invalid = structuredClone(guide);
    invalid.cases[0].comparison_run_id = comparison;
    assert.equal(validReadingGuide(invalid, dataset), false);
  }
  const missing = structuredClone(guide);
  delete missing.cases[0].comparison_run_id;
  assert.equal(validReadingGuide(missing, dataset), false);
  for (const status of ['FAILED', 'BLOCKED', 'NOT_RUN']) {
    const invalid = structuredClone(dataset);
    invalid.cases[0].runs[0].status = status;
    assert.equal(validReadingGuide(guide, invalid), false);
  }
  const invalid = structuredClone(dataset);
  invalid.cases[0].runs[0].answer = null;
  assert.equal(validReadingGuide(guide, invalid), false);
});

test('business-qa-v1 accepts complete neutral answers without implying a provider run', () => {
  const data = fixture();
  const original = structuredClone(data);
  assert.deepEqual(validateDataset(data), { valid: true, errors: [], diagnostics: [] });
  assert.deepEqual(data, original);
  data.schema_version = 'another-contract';
  assert.equal(validateDataset(data).valid, false);
});

test('malformed shapes, ambiguous identities and invalid dates cannot enter the workbench', () => {
  const changes = [
    data => { data.dataset_id = ''; },
    data => { data.as_of = '2026-02-30T12:00:00+08:00'; },
    data => { data.as_of = '2026-09-05'; },
    data => { data.cases = {}; },
    data => { data.cases.push(structuredClone(data.cases[0])); },
    data => { data.cases[0].question = null; },
    data => { data.cases[0].evidence = null; },
    data => { data.cases[0].evidence.push(structuredClone(data.cases[0].evidence[0])); },
    data => { data.cases[0].evidence[0].text = ['wrong shape']; },
    data => { data.cases[0].evidence[0].source_type = 'unknown'; },
    data => { data.cases[0].runs.push(structuredClone(data.cases[0].runs[0])); },
    data => { data.cases[0].runs[0].status = 'PASSED'; },
    data => { data.cases[0].runs[0].route = 'D'; },
    data => { data.cases[0].runs[0].metrics.input_tokens = -1; },
    data => { data.cases[0].runs[0].metrics.output_tokens = 1.5; },
    data => { data.cases[0].runs[0].metrics.cost_cny = Infinity; },
    data => { data.cases[0].runs[0].audit = null; },
    data => { data.cases[0].runs[0].answer.developments[0].evidence_ids = 'E001'; },
    data => { data.cases[0].runs[0].answer.next_steps[0].kind = 'automatic_task'; },
    data => { data.cases[0].runs[0].status = 'VERIFIED'; data.cases[0].runs[0].answer = null; },
  ];
  for (const change of changes) {
    const data = fixture();
    change(data);
    const result = validateDataset(data);
    assert.equal(result.valid, false, change.toString());
    assert.ok(result.errors.length > 0);
  }
  for (const data of [null, [], 'string', 7]) assert.equal(validateDataset(data).valid, false);
});

test('empty collections and not-run answers are legitimate states', () => {
  const data = fixture();
  data.cases[0].runs[0].answer = null;
  assert.equal(validateDataset(data).valid, true);
  data.cases[0].runs = [];
  assert.equal(validateDataset(data).valid, true);
  data.cases = [];
  assert.equal(validateDataset(data).valid, true);
});

test('missing references and cutoff violations stay visible as safe positional diagnostics', () => {
  const data = fixture();
  data.cases[0].as_of = '2026-09-06T12:00:00+08:00';
  data.cases[0].evidence[0].occurred_at = '2026-09-07T12:00:00+08:00';
  data.cases[0].evidence[0].url = 'javascript:private-sentinel';
  data.cases[0].runs[0].answer.developments[0].evidence_ids = ['private-sentinel'];
  data.cases[0].runs[0].audit.citations = 'invalid';
  const result = validateDataset(data);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(new Set(result.diagnostics.map(item => item.code)), new Set([
    'CASE_AFTER_DATASET_CUTOFF', 'EVIDENCE_AFTER_CASE_CUTOFF',
    'EVIDENCE_AFTER_DATASET_CUTOFF', 'UNKNOWN_EVIDENCE_REFERENCE',
    'UNSAFE_SOURCE_URL', 'CITATIONS_MARKED_INVALID',
  ]));
  assert.ok(result.diagnostics.every(item => item.severity === 'warning'));
  assert.equal(result.diagnostics.find(item => item.code === 'UNKNOWN_EVIDENCE_REFERENCE').path,
    '$.cases[0].runs[0].answer.developments[0].evidence_ids[0]');
  assert.ok(!JSON.stringify(result).includes('private-sentinel'));
});

test('citations only resolve within their own case and exact cutoff timestamps are admitted', () => {
  const data = fixture();
  data.cases.push({ ...structuredClone(data.cases[0]), id: 'second-case' });
  data.cases[1].evidence[0].id = 'E002';
  data.cases[0].evidence[0].occurred_at = data.cases[0].as_of;
  const result = validateDataset(data);
  assert.equal(result.valid, true);
  assert.equal(result.diagnostics.filter(item => item.code === 'UNKNOWN_EVIDENCE_REFERENCE').length, 3);
  assert.ok(result.diagnostics.every(item => item.path.startsWith('$.cases[1].')));
});

async function environment(t) {
  const root = await mkdtemp(join(tmpdir(), 'business-workbench-test-'));
  const checkoutRoot = join(root, 'checkout');
  const appRoot = join(checkoutRoot, 'apps/business-workbench');
  await mkdir(join(appRoot, 'dist/assets'), { recursive: true, mode: 0o700 });
  await writeFile(join(appRoot, 'demo.json'), JSON.stringify(fixture()), { mode: 0o600 });
  await writeFile(join(appRoot, 'dist/index.html'), '<!doctype html><title>Neutral workbench</title>', { mode: 0o600 });
  await writeFile(join(appRoot, 'dist/assets/app.js'), 'document.title = "Neutral workbench";', { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, checkoutRoot, appRoot };
}

async function launch(t, env, options = {}) {
  const server = await startWorkbenchServer({ appRoot: env.appRoot, checkoutRoot: env.checkoutRoot, port: 0, ...options });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server;
}

function read(server, path = '/api/dataset', { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('CLI accepts only an explicit absolute data path and a numeric local port', () => {
  assert.deepEqual(parseArgs([]), { port: 4595 });
  assert.deepEqual(parseArgs(['--history', '/tmp/history.json']), { port: 4595, historyPath: '/tmp/history.json' });
  assert.throws(() => parseArgs(['--history', 'relative-history.json']), { code: 'INVALID_ARGUMENTS' });
  assert.deepEqual(parseArgs(['--port', '4599', '--data', '/tmp/example.json']), { port: 4599, dataPath: '/tmp/example.json' });
  for (const args of [
    ['--data', 'relative.json'], ['--data', 'https://example.org/input.json'],
    ['--port', '0'], ['--port', '4595x'], ['--port', '70000'],
    ['--port'], ['--port', '4595', '--port', '4596'], ['--host', '0.0.0.0'],
  ]) assert.throws(() => parseArgs(args), { code: 'INVALID_ARGUMENTS' });
});

test('display input flags require explicit absolute paths and reject duplicates', () => {
  assert.deepEqual(parseArgs(['--source-map', '/tmp/source-map.json', '--display-titles', '/tmp/titles.json', '--reading-guide', '/tmp/guide.json']), {
    port: 4595, sourceMapPath: '/tmp/source-map.json', displayTitlesPath: '/tmp/titles.json', readingGuidePath: '/tmp/guide.json',
  });
  for (const flag of ['--source-map', '--display-titles', '--reading-guide']) {
    for (const args of [[flag], [flag, 'relative.json'], [flag, 'https://example.org/map.json'],
      [flag, '/tmp/first.json', flag, '/tmp/second.json']]) {
      assert.throws(() => parseArgs(args), { code: 'INVALID_ARGUMENTS' });
    }
  }
});

test('reading guide is opt-in, reread on every request and never changes original dataset or answer bytes', async t => {
  const env = await environment(t);
  const { dataset, guide } = guidedFixture();
  const dataPath = join(env.root, 'data.json');
  const readingGuidePath = join(env.root, 'guide.json');
  const original = JSON.stringify(dataset);
  await writeFile(dataPath, original);
  await writeFile(readingGuidePath, JSON.stringify(guide));
  const plain = await launch(t, env, { dataPath });
  assert.ok(!Object.hasOwn(JSON.parse((await read(plain)).body), 'reading_guide'));
  const server = await launch(t, env, { dataPath, readingGuidePath });
  const first = JSON.parse((await read(server)).body);
  assert.deepEqual(first.reading_guide, guide);
  assert.equal(JSON.stringify(first.dataset), original);
  guide.cases[0].current.text = '更新后的中性导读。';
  await writeFile(readingGuidePath, JSON.stringify(guide));
  const second = JSON.parse((await read(server)).body);
  assert.equal(second.reading_guide.cases[0].current.text, '更新后的中性导读。');
  assert.equal(JSON.stringify(second.dataset), original);
  assert.equal(await readFile(dataPath, 'utf8'), original);
});

test('invalid or missing reading guides return explicit safe errors without a silent recommendation fallback', async t => {
  const env = await environment(t);
  const { dataset, guide } = guidedFixture();
  const dataPath = join(env.root, 'data.json');
  const readingGuidePath = join(env.root, 'private-sentinel-guide.json');
  await writeFile(dataPath, JSON.stringify(dataset));
  const server = await launch(t, env, { dataPath, readingGuidePath });
  const missing = await read(server);
  assert.equal(missing.status, 503);
  assert.equal(JSON.parse(missing.body).error.code, 'READING_GUIDE_UNAVAILABLE');
  for (const value of ['{"private-sentinel":', JSON.stringify({ ...guide, dataset_id: 'private-sentinel' })]) {
    await writeFile(readingGuidePath, value);
    const response = await read(server);
    assert.equal(response.status, 422);
    assert.equal(JSON.parse(response.body).error.code, 'READING_GUIDE_INVALID');
    assert.ok(!Object.hasOwn(JSON.parse(response.body), 'dataset'));
    assert.ok(!response.body.includes('private-sentinel'));
    assert.ok(!response.body.includes(env.root));
  }
});

test('reading guide paths preserve checkout boundaries, symlink rereads and file size limits', async t => {
  const env = await environment(t);
  const { dataset, guide } = guidedFixture();
  const dataPath = join(env.root, 'data.json');
  const guideFile = join(env.root, 'guide.json');
  const readingGuidePath = join(env.root, 'selected.json');
  await writeFile(dataPath, JSON.stringify(dataset));
  await writeFile(guideFile, JSON.stringify(guide));
  await symlink(guideFile, readingGuidePath);
  await assert.rejects(startWorkbenchServer({ ...env, dataPath, readingGuidePath: join(env.appRoot, 'demo.json'), port: 0 }), { code: 'DATA_PATH_NOT_ALLOWED' });
  const server = await launch(t, env, { dataPath, readingGuidePath });
  assert.equal((await read(server)).status, 200);
  await rm(readingGuidePath);
  await symlink(join(env.appRoot, 'demo.json'), readingGuidePath);
  assert.equal(JSON.parse((await read(server)).body).error.code, 'DATA_PATH_NOT_ALLOWED');
  const directory = await launch(t, env, { dataPath, readingGuidePath: env.root });
  assert.equal(JSON.parse((await read(directory)).body).error.code, 'READING_GUIDE_UNAVAILABLE');
  await truncate(guideFile, 1024 * 1024 + 1);
  const large = await launch(t, env, { dataPath, readingGuidePath: guideFile });
  assert.equal(JSON.parse((await read(large)).body).error.code, 'READING_GUIDE_TOO_LARGE');
});

test('explicit display inputs project only verified participants and current case titles without changing the dataset', async t => {
  const env = await environment(t);
  const sourceMapPath = join(env.root, 'source-map.json');
  const displayTitlesPath = join(env.root, 'titles.json');
  const sourceMap = {
    participant_mapping: [
      { alias: 'P1', verified_display_name: '示例成员甲', name_binding_status: 'PROVIDER_MENTION_IDENTITY', name_source_evidence_ids: { 示例成员甲: ['NAME-E001'] }, platform_id: 'platform-id-sentinel' },
      { alias: 'P2', verified_display_name: '未核验候选名', name_binding_status: 'UNRESOLVED', name_source_evidence_ids: { 未核验候选名: ['NAME-E002'] } },
      { alias: 'P3', verified_display_name: '缺少证据候选名', name_binding_status: 'PROVIDER_MENTION_IDENTITY', name_source_evidence_ids: {} },
      { alias: 'P4', verified_display_name: '证据不对应候选名', name_binding_status: 'PROVIDER_MENTION_IDENTITY', name_source_evidence_ids: { 另一个姓名: ['NAME-E003'] } },
      { alias: 'P5', verified_display_name: '空证据候选名', name_binding_status: 'PROVIDER_MENTION_IDENTITY', name_source_evidence_ids: { 空证据候选名: [] } },
      { alias: 'P6', verified_display_name: null, name_binding_status: 'UNRESOLVED', name_source_evidence_ids: {} },
      { alias: 'P7', verified_display_name: '其他状态候选名', name_binding_status: 'MODEL_GUESS', name_source_evidence_ids: { 其他状态候选名: ['NAME-E004'] } },
      { alias: 'P8', verified_display_name: ' ', name_binding_status: 'PROVIDER_MENTION_IDENTITY', name_source_evidence_ids: { ' ': ['NAME-E005'] } },
    ],
    source_mapping: { hidden: 'source-map-sentinel' }, evidence_mapping: { hidden: 'evidence-map-sentinel' },
  };
  await writeFile(sourceMapPath, JSON.stringify(sourceMap), { mode: 0o600 });
  await writeFile(displayTitlesPath, JSON.stringify({ case_titles: { planning: '  计划安排  ', unrelated: 'unrelated-title-sentinel' }, other: 'extra-title-sentinel' }), { mode: 0o600 });
  const server = await launch(t, env, { sourceMapPath, displayTitlesPath });
  const response = await read(server);
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  assert.deepEqual(body.dataset, fixture());
  assert.equal(await readFile(join(env.appRoot, 'demo.json'), 'utf8'), JSON.stringify(fixture()));
  assert.deepEqual(body.display, {
    participants: sourceMap.participant_mapping.map((row, index) => ({ alias: row.alias, display_name: index === 0 ? '示例成员甲' : null })),
    case_titles: { planning: '计划安排' },
  });
  for (const excluded of ['platform-id-sentinel', 'source-map-sentinel', 'evidence-map-sentinel', 'NAME-E001',
    'name_source_evidence_ids', 'name_binding_status', 'unrelated-title-sentinel', 'extra-title-sentinel',
    '未核验候选名', '缺少证据候选名', '证据不对应候选名', '空证据候选名', '其他状态候选名']) {
    assert.ok(!response.body.includes(excluded));
  }
});

test('display inputs are separately opt-in and are read again without changing raw data', async t => {
  const env = await environment(t);
  const sourceMapPath = join(env.root, 'participants.json');
  const displayTitlesPath = join(env.root, 'titles.json');
  const row = { alias: 'P1', verified_display_name: '示例成员甲', name_binding_status: 'PROVIDER_MENTION_IDENTITY', name_source_evidence_ids: { 示例成员甲: ['NAME-E001'] } };
  await writeFile(sourceMapPath, JSON.stringify({ participant_mapping: [row] }), { mode: 0o600 });
  await writeFile(displayTitlesPath, JSON.stringify({ case_titles: { planning: '计划安排' } }), { mode: 0o600 });
  const participants = await launch(t, env, { sourceMapPath });
  const titles = await launch(t, env, { displayTitlesPath });
  assert.deepEqual(JSON.parse((await read(participants)).body).display, {
    participants: [{ alias: 'P1', display_name: '示例成员甲' }], case_titles: {},
  });
  assert.deepEqual(JSON.parse((await read(titles)).body).display, { participants: [], case_titles: { planning: '计划安排' } });
  row.name_binding_status = 'UNRESOLVED';
  await writeFile(sourceMapPath, JSON.stringify({ participant_mapping: [row] }));
  await writeFile(displayTitlesPath, JSON.stringify({ case_titles: { planning: '新的计划标题' } }));
  const rereadParticipants = JSON.parse((await read(participants)).body);
  const rereadTitles = JSON.parse((await read(titles)).body);
  assert.equal(rereadParticipants.display.participants[0].display_name, null);
  assert.equal(rereadTitles.display.case_titles.planning, '新的计划标题');
  assert.deepEqual(rereadParticipants.dataset, fixture());
  assert.deepEqual(rereadTitles.dataset, fixture());
});

test('sender-or-mention identity requires supported evidence kinds and a matching nonempty name reference', async t => {
  const env = await environment(t);
  const sourceMapPath = join(env.root, 'participants.json');
  const base = {
    verified_display_name: '中性身份示例', name_binding_status: 'PROVIDER_SENDER_OR_MENTION_IDENTITY',
    name_source_evidence_ids: { 中性身份示例: ['NAME-E001'] },
    identity_evidence_kinds: ['provider_sender'], platform_id: 'private-provider-id',
  };
  const cases = [
    [{}, true],
    [{ identity_evidence_kinds: ['provider_mention'] }, true],
    [{ identity_evidence_kinds: ['provider_sender', 'provider_mention'] }, true],
    [{ name_binding_status: 'PROVIDER_MENTION_IDENTITY', identity_evidence_kinds: undefined }, true],
    ...[undefined, null, [], 'provider_sender', {}, [null], ['model_guess'], ['provider_sender', 'model_guess']]
      .map(identity_evidence_kinds => [{ identity_evidence_kinds }, false]),
    [{ name_source_evidence_ids: {} }, false],
    [{ name_source_evidence_ids: { 其他身份: ['NAME-E001'] } }, false],
    [{ name_source_evidence_ids: { 中性身份示例: [] } }, false],
    [{ verified_display_name: null }, false],
    [{ verified_display_name: ' ' }, false],
    [{ name_binding_status: 'UNRESOLVED' }, false],
    [{ name_binding_status: 'MODEL_GUESS' }, false],
  ];
  const source = { participant_mapping: cases.map(([change], index) => ({ ...base, ...change, alias: `P${index + 1}` })) };
  const input = JSON.stringify(source);
  await writeFile(sourceMapPath, input, { mode: 0o600 });
  const server = await launch(t, env, { sourceMapPath });
  const response = await read(server);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body).display.participants, cases.map(([, expected], index) => ({
    alias: `P${index + 1}`, display_name: expected ? base.verified_display_name : null,
  })));
  assert.equal(await readFile(sourceMapPath, 'utf8'), input);
  assert.deepEqual(JSON.parse(response.body).dataset, fixture());
  for (const privateValue of ['identity_evidence_kinds', 'provider_sender', 'provider_mention', 'private-provider-id',
    'NAME-E001', 'name_binding_status', 'name_source_evidence_ids']) assert.ok(!response.body.includes(privateValue));
});

test('case title display accepts only current case IDs and nonempty single-line titles up to 80 characters', async t => {
  const env = await environment(t);
  const displayTitlesPath = join(env.root, 'titles.json');
  const server = await launch(t, env, { displayTitlesPath });
  for (const title of ['', ' ', '行一\n行二', '制表\t标题', '控制\u0000字符', '分隔\u2028字符', '题'.repeat(81), 42, null, {}, []]) {
    await writeFile(displayTitlesPath, JSON.stringify({ case_titles: { planning: title, another: '无关题目' } }), { mode: 0o600 });
    const response = await read(server);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body).display, { participants: [], case_titles: {} });
  }
  await writeFile(displayTitlesPath, JSON.stringify({ case_titles: { planning: '题'.repeat(80) } }));
  assert.equal(JSON.parse((await read(server)).body).display.case_titles.planning.length, 80);
});

test('both display paths enforce checkout boundaries before startup and after symlink changes', async t => {
  const env = await environment(t);
  for (const key of ['sourceMapPath', 'displayTitlesPath']) {
    const inside = join(env.appRoot, 'demo.json');
    const selected = join(env.root, `${key}.json`);
    await symlink(inside, selected);
    for (const path of [inside, selected, 'relative.json']) {
      await assert.rejects(async () => {
        const unexpected = await startWorkbenchServer({ ...env, [key]: path, port: 0 });
        await new Promise(resolve => unexpected.close(resolve));
      }, { code: 'DATA_PATH_NOT_ALLOWED' });
    }
    const external = join(env.root, `${key}-outside.json`);
    await writeFile(external, JSON.stringify({ participant_mapping: [], case_titles: {} }), { mode: 0o600 });
    await rm(selected);
    await symlink(external, selected);
    const server = await launch(t, env, { [key]: selected });
    assert.equal((await read(server)).status, 200);
    await rm(selected);
    await symlink(inside, selected);
    const response = await read(server);
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.body).error.code, 'DATA_PATH_NOT_ALLOWED');
    assert.ok(!response.body.includes(env.root));
    assert.ok(!Object.hasOwn(JSON.parse(response.body), 'dataset'));
  }
});

test('invalid or missing display mappings return explicit safe errors instead of silently dropping display data', async t => {
  const env = await environment(t);
  const validRow = { alias: 'P1', verified_display_name: '示例成员甲', name_binding_status: 'PROVIDER_MENTION_IDENTITY', name_source_evidence_ids: { 示例成员甲: ['NAME-E001'] } };
  const invalidSources = [
    null, [], {}, { participant_mapping: 'private-sentinel' }, { participant_mapping: [null] },
    { participant_mapping: [{ ...validRow, alias: '' }] },
    { participant_mapping: [validRow, validRow] },
    { participant_mapping: [{ ...validRow, verified_display_name: 7 }] },
    { participant_mapping: [{ ...validRow, name_source_evidence_ids: [] }] },
    { participant_mapping: [{ ...validRow, name_source_evidence_ids: { 示例成员甲: 'private-sentinel' } }] },
    { participant_mapping: [{ ...validRow, name_source_evidence_ids: { 示例成员甲: [1] } }] },
    ...['not-an-array', [1], [' ']].map(evidenceIds => ({ participant_mapping: [{
      ...validRow, name_binding_status: 'PROVIDER_SENDER_OR_MENTION_IDENTITY', identity_evidence_kinds: ['provider_sender'],
      name_source_evidence_ids: { 示例成员甲: evidenceIds },
    }] })),
  ];
  const invalidTitles = [null, [], {}, { case_titles: 'private-sentinel' }, { case_titles: null }, { case_titles: [] }];
  for (const [key, invalidInputs] of [['sourceMapPath', invalidSources], ['displayTitlesPath', invalidTitles]]) {
    const selected = join(env.root, `${key}-private-sentinel.json`);
    const server = await launch(t, env, { [key]: selected });
    const missing = await read(server);
    assert.equal(missing.status, 503);
    assert.equal(JSON.parse(missing.body).error.code, 'DISPLAY_MAPPING_UNAVAILABLE');
    await writeFile(selected, '{"private-sentinel":', { mode: 0o600 });
    const malformed = await read(server);
    assert.equal(malformed.status, 422);
    assert.equal(JSON.parse(malformed.body).error.code, 'DISPLAY_MAPPING_INVALID');
    const responses = [missing, malformed];
    for (const input of invalidInputs) {
      await writeFile(selected, JSON.stringify(input));
      const response = await read(server);
      assert.equal(response.status, 422);
      assert.equal(JSON.parse(response.body).error.code, 'DISPLAY_MAPPING_INVALID');
      responses.push(response);
    }
    for (const response of responses) {
      assert.ok(!response.body.includes('private-sentinel'));
      assert.ok(!response.body.includes('示例成员甲'));
      assert.ok(!response.body.includes(env.root));
      assert.ok(!Object.hasOwn(JSON.parse(response.body), 'dataset'));
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  }
});

test('display mappings reject directories and files above the 5 MiB limit', async t => {
  const env = await environment(t);
  for (const key of ['sourceMapPath', 'displayTitlesPath']) {
    const directory = await launch(t, env, { [key]: env.root });
    assert.equal(JSON.parse((await read(directory)).body).error.code, 'DISPLAY_MAPPING_UNAVAILABLE');
    const selected = join(env.root, `${key}-large.json`);
    await writeFile(selected, '', { mode: 0o600 });
    await truncate(selected, 5 * 1024 * 1024 + 1);
    const server = await launch(t, env, { [key]: selected });
    const response = await read(server);
    assert.equal(response.status, 413);
    assert.equal(JSON.parse(response.body).error.code, 'DISPLAY_MAPPING_TOO_LARGE');
    assert.ok(!response.body.includes(env.root));
  }
});

test('fixed API serves the neutral fixture and built assets on loopback only', async t => {
  const env = await environment(t);
  const server = await launch(t, env);
  assert.equal(server.address().address, '127.0.0.1');
  const result = await read(server);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { dataset: fixture(), mode: 'demo', diagnostics: [] });
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal((await read(server, '/')).status, 200);
  assert.match((await read(server, '/assets/app.js')).headers['content-type'], /javascript/);
  assert.equal((await read(server, '/api/dataset', { method: 'HEAD' })).body, '');
  const requestedPath = await read(server, '/api/dataset?data=/tmp/not-an-input.json&url=https://example.org&source-map=/tmp/source-map.json&display-titles=/tmp/titles.json');
  assert.equal(requestedPath.body, result.body);
});

test('explicit private input outside checkout remains a read-only API source', async t => {
  const env = await environment(t);
  const data = fixture();
  data.dataset_id = 'private-neutral-fixture';
  const dataPath = join(env.root, 'private.json');
  await writeFile(dataPath, JSON.stringify(data), { mode: 0o600 });
  const server = await launch(t, env, { dataPath });
  const result = await read(server);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { dataset: data, mode: 'private', diagnostics: [] });
  assert.equal((await read(server, '/private.json')).status, 404);
  assert.equal((await read(server, '/demo.json')).status, 404);
});

test('checkout data and symlinks into checkout are refused before the server starts', async t => {
  const env = await environment(t);
  const inside = join(env.appRoot, 'demo.json');
  const externalLink = join(env.root, 'external-link.json');
  await symlink(inside, externalLink);
  for (const dataPath of [inside, externalLink, 'relative.json']) {
    await assert.rejects(startWorkbenchServer({ ...env, dataPath, port: 0 }), { code: 'DATA_PATH_NOT_ALLOWED' });
  }
});

test('an input symlink cannot be redirected into checkout after startup', async t => {
  const env = await environment(t);
  const external = join(env.root, 'external.json');
  const dataPath = join(env.root, 'selected.json');
  await writeFile(external, JSON.stringify(fixture()), { mode: 0o600 });
  await symlink(external, dataPath);
  const server = await launch(t, env, { dataPath });
  assert.equal((await read(server)).status, 200);
  await rm(dataPath);
  await symlink(join(env.appRoot, 'demo.json'), dataPath);
  const response = await read(server);
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(response.body).error.code, 'DATA_PATH_NOT_ALLOWED');
  assert.ok(!response.body.includes(env.root));
});

test('failed datasets give safe load errors with no filename, IDs, or source content', async t => {
  const env = await environment(t);
  const dataPath = join(env.root, 'private-sentinel.json');
  const server = await launch(t, env, { dataPath });
  const missing = await read(server);
  assert.equal(missing.status, 503);
  assert.equal(JSON.parse(missing.body).error.code, 'DATASET_UNAVAILABLE');
  await writeFile(dataPath, '{ "source": "private-sentinel"', { mode: 0o600 });
  const malformed = await read(server);
  assert.equal(malformed.status, 422);
  assert.equal(JSON.parse(malformed.body).error.code, 'DATASET_INVALID');
  await writeFile(dataPath, JSON.stringify({ schema_version: 'private-sentinel', cases: 'private-sentinel' }));
  const invalid = await read(server);
  assert.equal(invalid.status, 422);
  assert.ok(JSON.parse(invalid.body).diagnostics.length > 0);
  for (const result of [missing, malformed, invalid]) {
    assert.ok(!result.body.includes('private-sentinel'));
    assert.ok(!result.body.includes(env.root));
    assert.ok(!result.body.includes('SyntaxError'));
    assert.equal(result.headers['cache-control'], 'no-store');
  }
});

test('non-file input and oversized JSON fail without exposing content', async t => {
  const env = await environment(t);
  const server = await launch(t, env, { dataPath: env.root });
  assert.equal((await read(server)).status, 503);
  const largePath = join(env.root, 'large.json');
  await writeFile(largePath, '', { mode: 0o600 });
  await truncate(largePath, 20 * 1024 * 1024 + 1);
  const large = await launch(t, env, { dataPath: largePath });
  const response = await read(large);
  assert.equal(response.status, 413);
  assert.equal(JSON.parse(response.body).error.code, 'DATASET_TOO_LARGE');
});

test('Host, Origin, cross-site requests, and write methods cannot access local data', async t => {
  const env = await environment(t);
  const server = await launch(t, env);
  const port = server.address().port;
  for (const headers of [
    { Host: `attacker.invalid:${port}` }, { Host: `127.0.0.1:${port + 1}` },
    { Host: `127.0.0.1:${port}`, Origin: 'https://attacker.invalid' },
    { Host: `localhost:${port}`, Origin: `http://127.0.0.1:${port}` },
    { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const response = await read(server, '/api/dataset', { headers });
    assert.equal(response.status, 403);
    assert.ok(!response.body.includes('neutral-example'));
  }
  const sameOrigin = await read(server, '/api/dataset', { headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.headers['access-control-allow-origin'], undefined);
  assert.equal(sameOrigin.headers['cross-origin-resource-policy'], 'same-origin');
  const post = await read(server, '/api/dataset', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('traversal and static symlinks cannot escape built assets', async t => {
  const env = await environment(t);
  const privatePath = join(env.root, 'private-sentinel.js');
  await writeFile(privatePath, 'private-sentinel', { mode: 0o600 });
  await symlink(privatePath, join(env.appRoot, 'dist/assets/linked.js'));
  await writeFile(join(env.appRoot, 'dist/data.json'), 'private-sentinel', { mode: 0o600 });
  const server = await launch(t, env);
  for (const path of [
    '/../demo.json', '/%2e%2e/demo.json', '/assets/%2E%2E/%2E%2E/demo.json',
    '/%2f%2fprivate-sentinel.js', '/assets%5cprivate-sentinel.js', '/%00.js', '/%zz',
  ]) {
    const response = await read(server, path);
    assert.equal(response.status, 400, path);
    assert.ok(!response.body.includes('private-sentinel'));
  }
  for (const path of ['/assets/linked.js', '/data.json', '/.env', '/server.mjs', '/assets/', '/api/unknown']) {
    assert.equal((await read(server, path)).status, 404, path);
  }
  assert.match((await read(server, '/')).headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('default demo and the dist root cannot use symlinks to expose outside files', async t => {
  const env = await environment(t);
  const external = join(env.root, 'external.json');
  await writeFile(external, JSON.stringify(fixture()), { mode: 0o600 });
  await rm(join(env.appRoot, 'demo.json'));
  await symlink(external, join(env.appRoot, 'demo.json'));
  await assert.rejects(async () => {
    const unexpectedServer = await startWorkbenchServer({ ...env, port: 0 });
    await new Promise(resolve => unexpectedServer.close(resolve));
  }, { code: 'DATA_PATH_NOT_ALLOWED' });
  await rm(join(env.appRoot, 'demo.json'));
  await writeFile(join(env.appRoot, 'demo.json'), JSON.stringify(fixture()), { mode: 0o600 });
  const outsideDist = join(env.root, 'outside-dist');
  await rename(join(env.appRoot, 'dist'), outsideDist);
  await symlink(outsideDist, join(env.appRoot, 'dist'));
  const server = await launch(t, env);
  assert.equal((await read(server, '/')).status, 404);
});

test('undated document evidence is admitted without inventing an event timestamp; IM still requires a date', () => {
  const dataset = fixture();
  dataset.cases[0].evidence[0].source_type = 'document';
  dataset.cases[0].evidence[0].occurred_at = null;
  assert.equal(validateDataset(dataset).valid, true);
  dataset.cases[0].evidence[0].source_type = 'im';
  assert.equal(validateDataset(dataset).valid, false);
});
