import frozenFixture from './frozen-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createDiagnosticService } from '../diagnostic-service.mjs';
import { startWorkbenchServer } from '../server.mjs';

function memoryStore() {
  const rows = new Map();
  return { rows, created: 0, async list() { return structuredClone([...rows.values()]); }, async get(id) { return structuredClone(rows.get(id) || null); },
    async create(value) { this.created++; const run = { id: randomUUID(), rounds: [], usage: { modelCalls: 0, queries: 0 }, status: 'QUEUED', ...structuredClone(value) }; rows.set(run.id, run); return structuredClone(run); },
    async save(run) { rows.set(run.id, structuredClone(run)); return structuredClone(run); }, async close() {} };
}
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'diagnostic-service-test-'));
  const configPath = join(directory, 'config.json');
  const source = { id: 'activity', title: 'Activity', version: 'v1', definition: 'Same population, numerator, denominator', definitionVerified: true, userAuthorized: true,
    recipes: [{ id: 'overview', title: 'Counts', tool: 'execute_raw_sql', complexSqlVerified: true, arguments: { sql: 'WITH x AS (SELECT 1 AS n) SELECT n FROM x' } }] };
  const config = { version: 'diagnostic-config-v1', storeDirectory: join(directory, 'runs'), sources: [source] };
  await writeFile(configPath, JSON.stringify(config));
  const store = memoryStore();
  const service = await createDiagnosticService({ configPath, checkoutRoot: '/synthetic-checkout', store,
    query: async () => { throw Object.assign(new Error('No query expected'), { code: 'QUERY_FAILED' }); },
    model: { plan: async () => ({ decision: 'needs_human', reason: 'Definition question', questions: ['Which population?'] }), review: async () => { throw new Error('No review expected'); } }, ...options });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, store, source, config, configPath };
}

test('provider-specific reservation and settlement use the same rates',async t=>{
  let settled;const view={remainingCny:10};
  const budget={snapshot:async()=>view,reserve:async()=>({allowed:true,reservation:{id:'provider-rate'},budget:view}),settle:async input=>{settled=input;return{budget:view};}};
  const model={provider:{id:'mimo',model:'mimo-v2.6-pro',inputRate:3,outputRate:6},plan:async()=>({decision:'needs_human',reason:'Missing definition',questions:['Which population?'],callReceipt:{promptTokens:100,completionTokens:10}}),review:async()=>{throw Error('Not expected');}};
  const {service,store}=await setup(t,{budget,model});const {run}=await service.create({question:'Which population?',sourceId:'activity',trigger:'manual'});
  for(let n=0;n<100&&!settled;n++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.deepEqual(settled.rates,{inputCnyPerMillion:3,outputCnyPerMillion:6});
});

test('public source list exposes only recipe summaries and a versioned actual Skill', async t => {
  const { service } = await setup(t);
  const result = await service.list();
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].ready, true);
  assert.deepEqual(Object.keys(result.sources[0].recipes[0]).sort(), ['id','purpose','title','tool']);
  assert.equal(result.sources[0].recipes[0].tool, 'execute_raw_sql');
  assert.equal(result.agent.skill.version, '1.1.0');
  assert.match(result.agent.skill.markdown, /分子、分母/);
  assert.equal(result.agent.skill.sha256.length, 64);
  assert.ok(!JSON.stringify(result).includes('WITH x'));
});

test('task creation snapshots sanitized knowledge and Skill; resumes preserve both and old tasks remain unknown', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'diagnostic-agent-spec-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentPath = join(directory, 'SKILL.md');
  const spec = version => `---\nname: data-diagnostic-agent\nversion: ${version}\n---\nOriginal business rules.`;
  await writeFile(agentPath, spec('1.0.0'));
  const { service, store, source } = await setup(t, { agentPath });
  const input = { question: 'Why?', sourceId: 'activity', trigger: 'manual', knowledgeMarkdown: '# Scope\napi_key=sk-syntheticsecret123456789\nUse this context.' };
  const created = await service.create(input);
  const snapshot = structuredClone(created.run.agentSnapshot), knowledge = structuredClone(created.run.knowledge);
  assert.ok(!knowledge.markdown.includes('syntheticsecret'));
  assert.match(knowledge.markdown, /已移除凭据/);
  assert.match(snapshot.skill.markdown, /Original business rules/);
  // Wait only for the deterministic in-memory model to checkpoint its terminal state.
  for (let n = 0; n < 100 && (await store.get(created.run.id)).status === 'QUEUED'; n++) await new Promise(resolve => setTimeout(resolve, 1));
  for (let n = 0; n < 100 && (await store.get(created.run.id)).status !== 'NEEDS_HUMAN'; n++) await new Promise(resolve => setTimeout(resolve, 1));
  await writeFile(agentPath, spec('2.0.0'));
  assert.equal((await service.list()).agent.version, '2.0.0');
  assert.deepEqual((await service.get(created.run.id)).run.agentSnapshot, snapshot);
  await assert.rejects(service.action({ id: created.run.id, action: 'resume', facts: 'New data', knowledgeMarkdown: 'Replace rules' }), e => e.code === 'INVALID_DISCOVERY_REQUEST');
  const resumed = await service.action({ id: created.run.id, action: 'resume', facts: 'Additional business fact' });
  assert.deepEqual(resumed.run.agentSnapshot, snapshot);
  assert.deepEqual(resumed.run.knowledge, knowledge);
  assert.deepEqual(resumed.run.limits, created.run.limits);
  const old = await store.create({ question: 'Legacy', sourceId: source.id, sourceHash: created.run.sourceHash, status: 'REVIEW_READY' });
  const legacy = (await service.get(old.id)).run;
  assert.equal(legacy.agentSnapshot, undefined);
  assert.equal(legacy.knowledge, undefined);
});

test('create rejects browser-controlled limits, models, SQL, or non-manual trigger', async t => {
  const { service, store } = await setup(t);
  const input = { question: 'Why?', sourceId: 'activity', trigger: 'manual' };
  for (const extra of [{ limits: { maxQueries: 999 } }, { model: 'other' }, { sql: 'SELECT 1' }, { trigger: 'metric_change' }]) {
    await assert.rejects(service.create({ ...input, ...extra }), error => error.code === 'INVALID_DISCOVERY_REQUEST');
  }
  assert.equal(store.created, 0);
});

test('revocation suppresses direct run reads and never permits query execution', async t => {
  const { service } = await setup(t, { authorize: async () => false, contextFor: async () => [{ text: 'PRIVATE work source' }] });
  const created = await service.create({ question: 'Private business question', sourceId: 'activity', trigger: 'manual' });
  assert.equal(created.run.status, 'SUPPRESSED');
  const read = await service.get(created.run.id);
  assert.equal(read.run.status, 'SUPPRESSED');
  assert.ok(!JSON.stringify(read).includes('PRIVATE work source'));
  assert.equal(read.run.question, '来源设置已变更，任务内容已隐藏。');
});

test('interrupted query cannot be resumed through the public action endpoint', async t => {
  const { service, store } = await setup(t);
  const existing = await store.create({ question: 'Why?', sourceId: 'activity', status: 'UNKNOWN_EXECUTION', inflight: { recipeId: 'overview' } });
  await assert.rejects(service.action({ id: existing.id, action: 'resume', facts: 'Please repeat' }), error => error.code === 'INVALID_DISCOVERY_REQUEST');
  assert.equal((await store.get(existing.id)).status, 'UNKNOWN_EXECUTION');
});

test('concurrent create reserves the job before context reads and does not leave an orphan queued run', async t => {
  let entered = 0, releaseContext, releasePlan;
  const bothEntered = new Promise(resolve => {
    const wait = setInterval(() => { if (entered === 2) { clearInterval(wait); resolve(); } }, 1);
    setTimeout(() => { clearInterval(wait); resolve(); }, 20);
  });
  const contextGate = new Promise(resolve => { releaseContext = resolve; });
  const planGate = new Promise(resolve => { releasePlan = resolve; });
  const { service, store } = await setup(t, {
    contextFor: async () => { entered++; await contextGate; return []; },
    model: { plan: async () => { await planGate; return { decision: 'needs_human', reason: 'Definition', questions: ['Which population?'] }; }, review: async () => {} },
  });
  const input = { question: 'Why?', sourceId: 'activity', trigger: 'manual' };
  const first = service.create(input), second = service.create(input);
  // Attach handlers immediately: the fixed implementation may reject the second synchronously.
  const settled = Promise.allSettled([first, second]);
  await bothEntered; releaseContext();
  const results = await settled;
  releasePlan();
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(store.created, 1, 'A rejected concurrent request must not create a durable orphan');
});

test('new discovery API preserves same-origin, body-size, method and query-parameter gates', async t => {
  let creates = 0, lastInput;
  const service = { async list() { return { configured: true, sources: [], runs: [] }; }, async get(id) { return { run: { id } }; }, async create(input) { creates++; lastInput = input; return { run: { id: 'synthetic' } }; }, async action() { return {}; } };
  const directory = await mkdtemp(join(tmpdir(), 'discovery-http-test-'));
  const dataPath = join(directory, 'data.json');
  await writeFile(dataPath, JSON.stringify(frozenFixture));
  const server = await startWorkbenchServer({ port: 0, dataPath, discoveryService: service });
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (headers, body = '{}') => fetch(url + '/api/discovery', { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', ...headers }, body });
  for (const headers of [{ Origin: 'https://foreign.invalid' }, { Origin: '' }, { 'Content-Type': 'text/plain' }]) {
    assert.ok([403, 405].includes((await post(headers)).status));
  }
  assert.equal((await post({}, 'x'.repeat(21_000))).status, 400);
  assert.equal((await fetch(url + '/api/discovery?id=a&id=b')).status, 400);
  assert.equal((await fetch(url + '/api/discovery?extra=1')).status, 400);
  assert.equal((await fetch(url + '/api/discovery-action')).status, 405);
  assert.equal(creates, 0);
  assert.equal((await post({})).status, 200);
  assert.equal(creates, 1);
  const payload = Buffer.from(JSON.stringify({ question: '中文问题', sourceId: 'activity', trigger: 'manual' }));
  const cut = payload.indexOf(Buffer.from('中')) + 1;
  const splitStatus = await new Promise((resolve, reject) => {
    const req = request(url + '/api/discovery', { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    req.on('error', reject); req.write(payload.subarray(0, cut));
    setTimeout(() => req.end(payload.subarray(cut)), 5);
  });
  assert.equal(splitStatus, 200);
  assert.equal(lastInput.question, '中文问题', 'Stream chunk boundaries must not corrupt Chinese trigger/source text');
});

test('local review preflight failure resumes saved results without replaying queries or resetting limits',async t=>{
  let reviews=0,queries=0;
  const {service,store}=await setup(t,{query:async()=>{queries++;return{status:'VERIFIED',receiptId:'receipt',queryHash:'hash',columns:['n'],records:[[1]]};},model:{plan:async()=>({decision:'query',recipeId:'overview',reason:'Compare'}),review:async()=>{if(!reviews++)throw Object.assign(new Error('local preflight'),{code:'MODEL_CONTEXT_LIMIT'});return{decision:'ready',summary:'Saved result reviewed',findings:[{text:'n=1',evidenceIds:['receipt']}]};}}});
  const created=await service.create({question:'Why?',sourceId:'activity',trigger:'manual'});
  for(let n=0;n<100&&(await store.get(created.run.id)).status!=='FAILED';n++)await new Promise(r=>setTimeout(r,1));
  const failed=await service.get(created.run.id);assert.equal(failed.run.canResume,true);assert.equal(queries,1);const limits=failed.run.limits;
  await service.action({id:created.run.id,action:'resume',facts:'Use retained verified result.'});
  for(let n=0;n<100&&(await store.get(created.run.id)).status!=='REVIEW_READY';n++)await new Promise(r=>setTimeout(r,1));
  const done=(await service.get(created.run.id)).run;assert.equal(done.status,'REVIEW_READY');assert.equal(queries,1);assert.equal(reviews,2);assert.equal(done.usage.modelCalls,2);assert.deepEqual(done.limits,limits);
  const row=await store.get(created.run.id);row.status='FAILED';row.error={code:'UPSTREAM_FAILED'};await store.save(row);
  await assert.rejects(service.action({id:row.id,action:'resume',facts:'Retry'}),e=>e.code==='INVALID_DISCOVERY_REQUEST');
});

test('service uses shared durable budget before model transport and exposes daily snapshot', async t => {
  let dispatched = 0, reserved = 0;
  const snapshot = { day: '2026-10-18', timeZone: 'Asia/Shanghai', dailyLimitCny: 10, remainingCny: 0, accounting: 'ESTIMATE_NOT_BILL' };
  const { service, store } = await setup(t, { budget: { snapshot: async () => snapshot, reserve: async () => { reserved++; return { allowed: false, reason: 'DAILY_BUDGET_LIMIT', budget: snapshot }; }, settle: async () => { throw new Error('No request was dispatched'); } },
    model: { plan: async () => { dispatched++; }, review: async () => { dispatched++; } } });
  const { run } = await service.create({ question: 'Why did conversion change?', sourceId: 'activity', trigger: 'manual' });
  for (let n = 0; n < 100 && (await store.get(run.id)).status !== 'PAUSED_LIMIT'; n++) await new Promise(resolve => setTimeout(resolve, 1));
  const result = await store.get(run.id);
  assert.equal(result.status, 'PAUSED_LIMIT'); assert.equal(result.pendingReason, 'DAILY_BUDGET_LIMIT');
  assert.equal(result.usage.modelCalls, 0); assert.equal(dispatched, 0); assert.equal(reserved, 1);
  assert.equal((await service.list()).budget.remainingCny, 0);
});
