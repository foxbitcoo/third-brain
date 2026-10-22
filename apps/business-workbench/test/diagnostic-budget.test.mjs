import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDiagnosticBudget, estimateModelReservation, shanghaiBudgetDay } from '../diagnostic-budget.mjs';
const execute = promisify(execFile);
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'diagnostic-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, ledger: await createDiagnosticBudget({ directory, ...options }) };
}
test('pre-dispatch upper bound uses bounded bytes plus framing and output, and tracks estimated accounting', async t => {
  const { ledger } = await fixture(t);
  assert.equal(estimateModelReservation(), 0.662256);
  const reserved = await ledger.reserve({ runId: 'task', stage: 'plan:1' });
  assert.equal(reserved.allowed, true);
  assert.equal(reserved.budget.reservedCny, 0.662256);
  assert.equal(reserved.budget.accounting, 'ESTIMATE_NOT_BILL');
  const settled = await ledger.settle({ reservationId: reserved.reservation.id, receipt: { promptTokens: 1000, completionTokens: 100 } });
  assert.equal(settled.budget.spentEstimatedCny, 0.0117);
  assert.equal(settled.budget.reservedCny, 0);
  const duplicate = await ledger.reserve({ reservationId: reserved.reservation.id, runId: 'task', stage: 'plan:1' });
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.reason, 'RESERVATION_ALREADY_EXISTS');
});
test('separate processes cannot oversubscribe the shared currency limit', async t => {
  const { directory, ledger } = await fixture(t, { dailyLimitCny: 1 });
  const moduleUrl = new URL('../diagnostic-budget.mjs', import.meta.url).href;
  const program = `import {createDiagnosticBudget} from ${JSON.stringify(moduleUrl)};const b=await createDiagnosticBudget({directory:process.argv[1],dailyLimitCny:1});console.log(JSON.stringify(await b.reserve({runId:process.argv[2],stage:'plan:1',upperBoundCny:.4})));`;
  const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => execute(process.execPath, ['--input-type=module','-e',program,directory,`task-${index}`])));
  assert.equal(responses.map(value => JSON.parse(value.stdout)).filter(value => value.allowed).length, 2);
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.reservedCny, .8);
  assert.equal(snapshot.remainingCny, .2);
});
test('restart and missing usage retain uncertain reservations; only proven non-dispatch releases', async t => {
  const { directory, ledger } = await fixture(t, { dailyLimitCny: 1 });
  const first = await ledger.reserve({ runId: 'task', stage: 'review:1', upperBoundCny: .8 });
  await ledger.settle({ reservationId: first.reservation.id, receipt: { estimatedPeakCny: .001 } });
  const restarted = await createDiagnosticBudget({ directory, dailyLimitCny: 1 });
  assert.equal((await restarted.snapshot()).unknownReservations, 1);
  assert.equal((await restarted.reserve({ runId: 'another', stage: 'plan:1', upperBoundCny: .3 })).allowed, false);
  const recovered = await restarted.settle({ reservationId: first.reservation.id, receipt: { promptTokens: 1000, completionTokens: 100 }, rates: { inputCnyPerMillion: 1, outputCnyPerMillion: 2 } });
  assert.equal(recovered.budget.spentEstimatedCny, .0012);
  const local = await restarted.reserve({ runId: 'task', stage: 'plan:2', upperBoundCny: .1 });
  await restarted.settle({ reservationId: local.reservation.id, notDispatched: true });
  assert.equal((await restarted.snapshot()).reservedCny, 0);
});
test('actual usage exceeding estimate remains accounted and blocks subsequent dispatch', async t => {
  const { ledger } = await fixture(t, { dailyLimitCny: 1 });
  const first = await ledger.reserve({ runId: 'task', stage: 'plan:1', upperBoundCny: .1 });
  const actual = await ledger.settle({ reservationId: first.reservation.id, promptTokens: 200000, completionTokens: 2000 });
  assert.equal(actual.reservation.exceededReservation, true);
  assert.equal(actual.budget.spentEstimatedCny, 1.854);
  assert.equal(actual.budget.remainingCny, 0);
  assert.equal((await ledger.reserve({ runId: 'another', stage: 'plan:1', upperBoundCny: .01 })).allowed, false);
});
test('Shanghai midnight gets a new daily bucket without moving old reservations or spend', async t => {
  let instant = '2026-10-18T15:59:59Z';
  const { directory, ledger } = await fixture(t, { now: () => instant, dailyLimitCny: 1 });
  assert.equal(shanghaiBudgetDay(instant), '2026-10-18');
  const first = await ledger.reserve({ runId: 'before', stage: 'plan:1', upperBoundCny: 1 });
  instant = '2026-10-18T16:00:00Z';
  assert.equal((await ledger.snapshot()).day, '2026-10-19');
  assert.equal((await ledger.snapshot()).remainingCny, 1);
  await ledger.settle({ reservationId: first.reservation.id, promptTokens: 1000, completionTokens: 0 });
  assert.equal((await ledger.snapshot({ day: '2026-10-18' })).spentEstimatedCny, .009);
  assert.equal((await ledger.snapshot()).spentEstimatedCny, 0);
  const restarted = await createDiagnosticBudget({ directory, dailyLimitCny: 5, now: () => instant });
  assert.equal((await restarted.snapshot({ day: '2026-10-18' })).dailyLimitCny, 1);
});
test('unknown owner lock and malformed ledger fail closed without deleting data', async t => {
  const { directory, ledger } = await fixture(t, { lockAttempts: 1 });
  await writeFile(join(directory, '.transaction.lock'), 'another owner');
  await assert.rejects(ledger.snapshot(), { code: 'BUDGET_BUSY' });
  assert.equal(await readFile(join(directory, '.transaction.lock'), 'utf8'), 'another owner');
  await rm(join(directory, '.transaction.lock'));
  await writeFile(join(directory, 'ledger.json'), '{"version":2}');
  await assert.rejects(ledger.reserve({ runId: 'a', stage: 'plan' }), { code: 'BUDGET_INVALID_LEDGER' });
});
