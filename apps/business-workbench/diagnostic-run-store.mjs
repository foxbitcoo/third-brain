import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';

const MAX_RUNS = 100;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function identifier(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw failure('INVALID_RUN_ID', 'A diagnostic run ID must be a UUID.');
  return id;
}
async function regularFile(path, { optional = false } = {}) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw failure('UNSAFE_STORE_FILE', 'Diagnostic store files must be regular files without links.');
    return stat;
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
async function directoryWithoutLinks(directory) {
  let current = parse(directory).root;
  for (const part of directory.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('UNSAFE_STORE_DIRECTORY', 'Diagnostic store directories must not contain symbolic links.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function readJson(path, limit = MAX_BYTES) {
  await regularFile(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw failure('UNSAFE_STORE_FILE', 'Diagnostic store files must be regular files without links.');
    if (stat.size > limit) throw failure('RUN_TOO_LARGE', 'Diagnostic run exceeds its storage limit.');
    // Read a bounded buffer even if another process grows the file after stat().
    const buffer = Buffer.alloc(stat.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > stat.size || bytesRead > limit) throw failure('RUN_TOO_LARGE', 'Diagnostic file changed while reading.');
    await handle.chmod(0o600);
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

/** Private, single-process run journal. Query execution belongs to the engine. */
export async function createDiagnosticStore(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw failure('INVALID_STORE_DIRECTORY', 'A private diagnostic directory is required.');
  const root = resolve(directory);
  if (root === parse(root).root) throw failure('INVALID_STORE_DIRECTORY', 'The filesystem root cannot be a diagnostic store.');
  await directoryWithoutLinks(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await directoryWithoutLinks(root);
  await chmod(root, 0o700);
  const lockPath = join(root, '.lock');
  const lockToken = randomUUID();
  let lock;
  try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (['EEXIST', 'ELOOP'].includes(error.code)) throw failure('STORE_LOCKED', 'Diagnostic store is locked; the existing lock was not removed.');
    throw error;
  }
  const lockStat = await lock.stat();
  try {
    await lock.writeFile(JSON.stringify({ token: lockToken, pid: process.pid, createdAt: new Date().toISOString() }));
    await lock.sync();
  } catch (error) {
    await lock.close();
    const own = await regularFile(lockPath, { optional: true });
    if (own?.ino === lockStat.ino && own?.dev === lockStat.dev) await unlink(lockPath);
    throw error;
  }
  const runs = new Map();
  let queue = Promise.resolve();
  let closed = false;
  let closing = false;
  let closePromise;
  const ensureOpen = () => { if (closed || closing) throw failure('STORE_CLOSED', 'Diagnostic store is closed.'); };
  const serial = work => {
    ensureOpen();
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  async function releaseLock() {
    try {
      await directoryWithoutLinks(root);
      const stat = await regularFile(lockPath, { optional: true });
      if (stat && stat.ino === lockStat.ino && stat.dev === lockStat.dev) {
        const owner = await readJson(lockPath, 4096);
        if (owner.token === lockToken) await unlink(lockPath);
      }
    } catch (error) {
      // Unknown or replaced locks are deliberately left for an operator to inspect.
      if (!['ENOENT', 'UNSAFE_STORE_FILE', 'UNSAFE_STORE_DIRECTORY', 'RUN_TOO_LARGE'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
    } finally { await lock.close(); }
  }
  async function persist(run) {
    const text = JSON.stringify(run, null, 2);
    if (Buffer.byteLength(text) > MAX_BYTES) throw failure('RUN_TOO_LARGE', 'Diagnostic run exceeds 8 MiB.');
    await directoryWithoutLinks(root);
    const path = join(root, `${identifier(run.id)}.json`);
    await regularFile(path, { optional: true });
    const temporary = join(root, `.${run.id}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(text);
      await handle.sync();
      await handle.close(); handle = null;
      await regularFile(path, { optional: true });
      await rename(temporary, path);
    } finally {
      if (handle) await handle.close();
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  try {
    const entries = await opendir(root);
    let scanned = 0;
    for await (const entry of entries) {
      if (++scanned > MAX_DIRECTORY_ENTRIES) throw failure('STORE_DIRECTORY_LIMIT', 'Diagnostic directory contains too many entries.');
      if (!entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      identifier(id);
      if (runs.size >= MAX_RUNS) throw failure('STORE_CAPACITY', 'Diagnostic store supports at most 100 runs.');
      const path = join(root, entry.name);
      const run = await readJson(path);
      if (!object(run) || run.id !== id) throw failure('RUN_ID_MISMATCH', 'Diagnostic run content must match its filename.');
      // Pending query outcomes cannot be inferred after a crash. Never replay here.
      if (run.status !== 'UNKNOWN_EXECUTION' && (run.status === 'RUNNING_QUERY' || run.inflight || run.inFlight)) {
        const priorStatus = run.status;
        run.status = 'UNKNOWN_EXECUTION';
        run.updatedAt = new Date().toISOString();
        run.recovery = { reason: 'Interrupted execution; outcome unknown and not replayed.', previousStatus: priorStatus, recoveredAt: run.updatedAt };
        await persist(run);
      }
      runs.set(id, run);
    }
  } catch (error) { await releaseLock(); throw error; }
  return {
    async list() {
      ensureOpen(); await queue; ensureOpen();
      return [...runs.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id)).slice(0, MAX_RUNS).map(clone);
    },
    async get(id) {
      ensureOpen(); identifier(id); await queue; ensureOpen();
      return runs.has(id) ? clone(runs.get(id)) : null;
    },
    async create(input = {}) {
      if (!object(input)) throw failure('INVALID_RUN', 'Diagnostic run input must be an object.');
      // Snapshot caller data before joining the write queue.
      const value = clone(input);
      return serial(async () => {
        if (runs.size >= MAX_RUNS) throw failure('STORE_CAPACITY', 'Diagnostic store supports at most 100 runs.');
        const now = new Date().toISOString();
        const run = { status: 'QUEUED', rounds: [], usage: { modelCalls: 0, queries: 0 }, createdAt: now, ...value, id: randomUUID(), updatedAt: now };
        await persist(run); runs.set(run.id, run); return clone(run);
      });
    },
    async save(input) {
      if (!object(input)) throw failure('INVALID_RUN', 'Diagnostic run must be an object.');
      const value = clone(input); identifier(value.id);
      return serial(async () => {
        const previous = runs.get(value.id);
        if (!previous) throw failure('UNKNOWN_RUN', 'Only an existing diagnostic run can be saved.');
        const run = { ...value, id: previous.id, createdAt: previous.createdAt, updatedAt: new Date().toISOString() };
        await persist(run); runs.set(run.id, run); return clone(run);
      });
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = queue.then(async () => { try { await releaseLock(); } finally { closed = true; } });
      return closePromise;
    },
  };
}
