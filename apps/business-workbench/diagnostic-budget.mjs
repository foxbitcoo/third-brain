import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink, realpath } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';

export const DIAGNOSTIC_PRICE_BASIS = '2026-10-17峰值估计，非服务商账单';
export const DEEPSEEK_PEAK_RATES = Object.freeze({ inputCnyPerMillion: 9, outputCnyPerMillion: 27 });
const fail = code => Object.assign(new Error(code), { code });
const validAmount = value => Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.ceil(value * 1e6));
const micros = value => Math.ceil(value * 1e6);
const cny = value => value / 1e6;
const validId = value => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value);
const tokenCount = value => Number.isSafeInteger(value) && value >= 0;
export function shanghaiBudgetDay(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw fail('BUDGET_INVALID_DATE');
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function estimateModelReservation({ maxContextBytes = 65536, maxOutputTokens = 2000, framingTokens = 2048, rates = DEEPSEEK_PEAK_RATES } = {}) {
  if (![maxContextBytes, maxOutputTokens, framingTokens].every(tokenCount) || !validAmount(rates.inputCnyPerMillion) || !validAmount(rates.outputCnyPerMillion)) throw fail('BUDGET_INVALID_ESTIMATE');
  // UTF-8 bytes bound text tokens conservatively; framing is additional margin.
  return cny(micros(((maxContextBytes + framingTokens) * rates.inputCnyPerMillion + maxOutputTokens * rates.outputCnyPerMillion) / 1e6));
}
async function safeDirectories(root) {
  let current = parse(root).root;
  for (const part of root.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('BUDGET_UNSAFE_PATH'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** Small cross-process, private ledger. An abandoned transaction lock is never stolen. */
export async function createDiagnosticBudget({ directory, dailyLimitCny = 10, now = () => new Date(), lockAttempts = 50 } = {}) {
  if (typeof directory !== 'string' || !directory.trim() || !validAmount(dailyLimitCny) || !Number.isInteger(lockAttempts) || lockAttempts < 1 || lockAttempts > 100) throw fail('BUDGET_INVALID_CONFIG');
  let root = resolve(directory);
  // macOS exposes its standard temporary roots through OS-owned aliases.
  for (const alias of ['/var','/tmp']) if (root.startsWith(alias + '/')) root = join(await realpath(alias), root.slice(alias.length + 1));
  if (root === parse(root).root) throw fail('BUDGET_INVALID_CONFIG');
  await safeDirectories(root); await mkdir(root, { recursive: true, mode: 0o700 }); await safeDirectories(root);
  const file = join(root, 'ledger.json'), lockFile = join(root, '.transaction.lock');
  const configuredLimit = micros(dailyLimitCny);
  async function read() {
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw fail('BUDGET_INVALID_LEDGER');
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) { const chunk = await handle.read(buffer, offset, buffer.length - offset, offset); if (!chunk.bytesRead) break; offset += chunk.bytesRead; }
      if (offset > stat.size) throw fail('BUDGET_INVALID_LEDGER');
      const data = JSON.parse(buffer.subarray(0, offset).toString());
      if (data.version !== 1 || !data.days || typeof data.days !== 'object' || Array.isArray(data.days) || Object.keys(data.days).length > 3660) throw fail('BUDGET_INVALID_LEDGER');
      const allIds = new Set();
      for (const [day, value] of Object.entries(data.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isSafeInteger(value.limitMicros) || value.limitMicros < 0 || !Array.isArray(value.entries) || value.entries.length > 2000) throw fail('BUDGET_INVALID_LEDGER');
        for (const row of value.entries) {
          if (!validId(row.id) || allIds.has(row.id) || !['RESERVED','UNKNOWN_RESERVED','SETTLED','NOT_DISPATCHED'].includes(row.status) || !Number.isSafeInteger(row.reservedMicros) || row.reservedMicros < 0 || !Number.isSafeInteger(row.spentMicros) || row.spentMicros < 0) throw fail('BUDGET_INVALID_LEDGER');
          allIds.add(row.id);
        }
      }
      return data;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, days: {} }; throw error; }
    finally { await handle?.close(); }
  }
  async function write(data) {
    const temporary = join(root, `.ledger-${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); }
    catch (error) { await handle.close(); await unlink(temporary).catch(() => {}); throw error; }
    await handle.close();
    try { await rename(temporary, file); const dir = await open(root, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); } }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  async function transaction(invoke) {
    let lock;
    for (let attempt = 0; attempt < lockAttempts; attempt++) {
      try { lock = await open(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; if (attempt === lockAttempts - 1) throw fail('BUDGET_BUSY'); await new Promise(resolve => setTimeout(resolve, 5 + attempt)); }
    }
    const identity = await lock.stat();
    try { await safeDirectories(root); const data = await read(); const result = await invoke(data); if (result.changed) await write(data); return result.value; }
    finally { await lock.close(); const current = await lstat(lockFile).catch(() => null); if (current?.ino === identity.ino && current?.dev === identity.dev) await unlink(lockFile); }
  }
  const dayValue = (data, day) => data.days[day] || { limitMicros: configuredLimit, entries: [] };
  function view(data, day) {
    const value = dayValue(data, day), limit = Math.min(configuredLimit, value.limitMicros);
    const spent = value.entries.reduce((sum, row) => sum + row.spentMicros, 0);
    const reserved = value.entries.filter(row => ['RESERVED','UNKNOWN_RESERVED'].includes(row.status)).reduce((sum, row) => sum + row.reservedMicros, 0);
    return { day, timeZone: 'Asia/Shanghai', dailyLimitCny: cny(limit), spentEstimatedCny: cny(spent), reservedCny: cny(reserved), remainingCny: cny(Math.max(0, limit - spent - reserved)),
      unknownReservations: value.entries.filter(row => row.status === 'UNKNOWN_RESERVED').length, reservations: value.entries.filter(row => ['RESERVED','UNKNOWN_RESERVED'].includes(row.status)).length,
      accounting: 'ESTIMATE_NOT_BILL', priceBasis: DIAGNOSTIC_PRICE_BASIS };
  }
  return {
    async snapshot({ day = shanghaiBudgetDay(now()) } = {}) { if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw fail('BUDGET_INVALID_DATE'); return transaction(async data => ({ changed: false, value: view(data, day) })); },
    async reserve({ reservationId = randomUUID(), runId, stage, upperBoundCny = estimateModelReservation() } = {}) {
      if (!validId(reservationId) || !validId(runId) || !validId(stage) || !validAmount(upperBoundCny) || upperBoundCny <= 0) throw fail('BUDGET_INVALID_RESERVATION');
      return transaction(async data => {
        const day = shanghaiBudgetDay(now()), reservedMicros = micros(upperBoundCny);
        const previous = Object.values(data.days).flatMap(value => value.entries).find(row => row.id === reservationId);
        if (previous) {
          if (previous.runId !== runId || previous.stage !== stage || previous.reservedMicros !== reservedMicros) throw fail('BUDGET_RESERVATION_CONFLICT');
          // A repeated reservation never authorizes a second external dispatch.
          return { changed: false, value: { allowed: false, reason: 'RESERVATION_ALREADY_EXISTS', reservation: structuredClone(previous), budget: view(data, day) } };
        }
        const budget = view(data, day);
        if (reservedMicros > Math.round(budget.remainingCny * 1e6)) return { changed: false, value: { allowed: false, reason: 'DAILY_BUDGET_LIMIT', budget } };
        data.days[day] ||= { limitMicros: configuredLimit, entries: [] };
        if (data.days[day].entries.length >= 2000) throw fail('BUDGET_LEDGER_LIMIT');
        const entry = { id: reservationId, runId, stage, day, status: 'RESERVED', reservedMicros, spentMicros: 0, createdAt: new Date(now()).toISOString() };
        data.days[day].entries.push(entry);
        return { changed: true, value: { allowed: true, reservation: structuredClone(entry), budget: view(data, day) } };
      });
    },
    async settle({ reservationId, receipt, promptTokens = receipt?.promptTokens, completionTokens = receipt?.completionTokens, notDispatched = false, rates = DEEPSEEK_PEAK_RATES } = {}) {
      if (!validId(reservationId) || !validAmount(rates.inputCnyPerMillion) || !validAmount(rates.outputCnyPerMillion)) throw fail('BUDGET_INVALID_SETTLEMENT');
      return transaction(async data => {
        const entry = Object.values(data.days).flatMap(value => value.entries).find(row => row.id === reservationId);
        if (!entry) throw fail('BUDGET_RESERVATION_NOT_FOUND');
        if (['SETTLED','NOT_DISPATCHED'].includes(entry.status)) return { changed: false, value: { reservation: structuredClone(entry), budget: view(data, entry.day) } };
        if (notDispatched) { entry.status = 'NOT_DISPATCHED'; entry.spentMicros = 0; }
        else if (tokenCount(promptTokens) && tokenCount(completionTokens)) {
          entry.status = 'SETTLED'; entry.promptTokens = promptTokens; entry.completionTokens = completionTokens;
          const amount = (promptTokens * rates.inputCnyPerMillion + completionTokens * rates.outputCnyPerMillion) / 1e6;
          if (!validAmount(amount)) throw fail('BUDGET_INVALID_SETTLEMENT');
          entry.spentMicros = micros(amount);
          entry.rates = { ...rates }; entry.priceBasis = receipt?.priceBasis || DIAGNOSTIC_PRICE_BASIS;
          entry.exceededReservation = entry.spentMicros > entry.reservedMicros;
        } else entry.status = 'UNKNOWN_RESERVED';
        entry.updatedAt = new Date(now()).toISOString();
        return { changed: true, value: { reservation: structuredClone(entry), budget: view(data, entry.day) } };
      });
    },
  };
}
