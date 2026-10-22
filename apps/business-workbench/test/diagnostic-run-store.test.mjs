import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { createDiagnosticStore } from '../diagnostic-run-store.mjs';

async function fixture(t) {
  // macOS /var is a system symlink; the store intentionally rejects linked paths.
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'diagnostic-store-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return join(parent, 'runs');
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('creates private atomic snapshots, overrides input id, and isolates returned data', async t => {
  const directory = await fixture(t);
  const store = await createDiagnosticStore(directory); t.after(() => store.close());
  const inputId = randomUUID();
  const run = await store.create({ id: inputId, question: 'Synthetic question' });
  assert.notEqual(run.id, inputId);
  assert.equal(run.status, 'QUEUED'); assert.deepEqual(run.rounds, []);
  assert.deepEqual(run.usage, { modelCalls: 0, queries: 0 });
  assert.ok(run.createdAt); assert.ok(run.updatedAt);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, `${run.id}.json`))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, '.lock'))).mode & 0o777, 0o600);
  run.rounds.push({ fake: true }); assert.deepEqual((await store.get(run.id)).rounds, []);
  const saved = await store.save({ ...await store.get(run.id), status: 'COMPLETE', createdAt: 'changed' });
  assert.equal(saved.createdAt, run.createdAt);
  assert.equal(JSON.parse(await readFile(join(directory, `${run.id}.json`))).status, 'COMPLETE');
  assert.deepEqual((await readdir(directory)).sort(), ['.lock', `${run.id}.json`].sort());
});

test('serializes overlapping saves and refuses unknown IDs, traversal and oversize', async t => {
  const directory = await fixture(t); const store = await createDiagnosticStore(directory); t.after(() => store.close());
  const run = await store.create();
  await Promise.all(Array.from({ length: 12 }, (_, n) => store.save({ ...run, question: String(n) })));
  assert.equal((await store.get(run.id)).question, '11');
  await rejectsCode(store.get('../outside'), 'INVALID_RUN_ID');
  await rejectsCode(store.save({ id: randomUUID() }), 'UNKNOWN_RUN');
  await rejectsCode(store.save({ ...run, question: 'x'.repeat(8 * 1024 * 1024) }), 'RUN_TOO_LARGE');
  assert.equal((await store.get(run.id)).question, '11');
  assert.equal(JSON.parse(await readFile(join(directory, `${run.id}.json`))).question, '11');
});

test('unknown existing locks are never reclaimed and close only removes its own lock', async t => {
  const directory = await fixture(t); const store = await createDiagnosticStore(directory);
  await rejectsCode(createDiagnosticStore(directory), 'STORE_LOCKED');
  const lockPath = join(directory, '.lock');
  await writeFile(lockPath, JSON.stringify({ token: 'foreign-owner' }));
  await store.close(); await store.close();
  assert.equal(JSON.parse(await readFile(lockPath)).token, 'foreign-owner');
  await rejectsCode(createDiagnosticStore(directory), 'STORE_LOCKED');
  await rejectsCode(store.list(), 'STORE_CLOSED');
});

test('reopening marks query and inflight outcomes unknown without replay and keeps other states', async t => {
  const directory = await fixture(t); let store = await createDiagnosticStore(directory);
  const query = await store.create({ status: 'RUNNING_QUERY', rounds: [{ query: 'synthetic' }], usage: { queries: 1, modelCalls: 1 } });
  const inflight = await store.create({ status: 'ANALYZING', inflight: { kind: 'query', requestId: 'synthetic' } });
  const queued = await store.create({ status: 'QUEUED' });
  const paused = await store.create({ status: 'NEEDS_HUMAN' });
  const complete = await store.create({ status: 'COMPLETE' });
  await store.close(); store = await createDiagnosticStore(directory); t.after(() => store.close());
  for (const id of [query.id, inflight.id]) {
    const restored = await store.get(id); assert.equal(restored.status, 'UNKNOWN_EXECUTION'); assert.ok(restored.recovery);
  }
  assert.deepEqual((await store.get(query.id)).usage, query.usage);
  assert.deepEqual((await store.get(query.id)).rounds, query.rounds);
  assert.equal((await store.get(queued.id)).status, 'QUEUED');
  assert.equal((await store.get(paused.id)).status, 'NEEDS_HUMAN');
  assert.equal((await store.get(complete.id)).status, 'COMPLETE');
  assert.equal((await store.list()).length, 5);
});

test('a crashed owner leaves an unclaimed lock until explicitly resolved by an operator', async t => {
  const directory = await fixture(t);
  const source = `import {createDiagnosticStore} from ${JSON.stringify(new URL('../diagnostic-run-store.mjs', import.meta.url).href)}; const s=await createDiagnosticStore(${JSON.stringify(directory)}); await s.create({status:'RUNNING_QUERY'}); process.stdout.write('ready\\n'); setInterval(()=>{},10000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(child.stdout, 'data'); child.kill('SIGKILL'); await once(child, 'exit');
  await rejectsCode(createDiagnosticStore(directory), 'STORE_LOCKED');
  // The test acts as the operator after it has joined and verified the child exit.
  await unlink(join(directory, '.lock'));
  const store = await createDiagnosticStore(directory); t.after(() => store.close());
  assert.equal((await store.list())[0].status, 'UNKNOWN_EXECUTION');
});

test('rejects linked directories, linked run files and linked locks without reading outside', async t => {
  const directory = await fixture(t); const store = await createDiagnosticStore(directory);
  const run = await store.create(); await store.close();
  const outside = join(directory, '..', 'outside.json'); await writeFile(outside, JSON.stringify({ id: run.id }));
  await unlink(join(directory, `${run.id}.json`)); await symlink(outside, join(directory, `${run.id}.json`));
  await rejectsCode(createDiagnosticStore(directory), 'UNSAFE_STORE_FILE');
  assert.deepEqual(JSON.parse(await readFile(outside)), { id: run.id });
  const link = `${directory}-link`; await symlink(directory, link);
  await rejectsCode(createDiagnosticStore(link), 'UNSAFE_STORE_DIRECTORY');
  await unlink(join(directory, `${run.id}.json`)); await symlink(outside, join(directory, '.lock'));
  await rejectsCode(createDiagnosticStore(directory), 'STORE_LOCKED');
});

test('rejects oversized or mismatched snapshots and releases only the failed opener lock', async t => {
  const directory = await fixture(t); let store = await createDiagnosticStore(directory); const run = await store.create(); await store.close();
  const file = join(directory, `${run.id}.json`); await truncate(file, 8 * 1024 * 1024 + 1);
  await rejectsCode(createDiagnosticStore(directory), 'RUN_TOO_LARGE');
  assert.ok(!(await readdir(directory)).includes('.lock'));
  await writeFile(file, JSON.stringify({ ...run, id: randomUUID() }));
  await rejectsCode(createDiagnosticStore(directory), 'RUN_ID_MISMATCH');
  await writeFile(file, JSON.stringify(run)); store = await createDiagnosticStore(directory); await store.close();
});

test('caps list and journal at 100 instead of silently discarding historical runs', async t => {
  const directory = await fixture(t); let store = await createDiagnosticStore(directory);
  for (let n = 0; n < 100; n++) await store.create({ question: String(n) });
  assert.equal((await store.list()).length, 100);
  await rejectsCode(store.create(), 'STORE_CAPACITY'); await store.close();
  store = await createDiagnosticStore(directory); t.after(() => store.close()); assert.equal((await store.list()).length, 100);
});
