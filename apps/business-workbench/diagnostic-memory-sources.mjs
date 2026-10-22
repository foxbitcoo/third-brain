import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const outside = (root, target) => { const value = relative(resolve(root), resolve(target)); return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value); };
async function readPrivate(path, checkoutRoot, maximum) {
  if (!isAbsolute(path) || !outside(checkoutRoot, path)) throw Error('MEMORY_PATH_NOT_ALLOWED');
  const canonical = await realpath(path);
  if (!outside(checkoutRoot, canonical)) throw Error('MEMORY_PATH_NOT_ALLOWED');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw Error('MEMORY_SOURCE_INVALID');
    const bytes = Buffer.alloc(stat.size + 1); let used = 0;
    while (used < bytes.length) { const part = await file.read(bytes, used, bytes.length - used, used); if (!part.bytesRead) break; used += part.bytesRead; }
    if (used !== stat.size) throw Error('MEMORY_SOURCE_CHANGED');
    return bytes.subarray(0, used);
  } finally { await file.close(); }
}

/** Only named, policy-authorized files are checked; there is no filesystem discovery. */
export async function diagnosticMemorySourceContext({ path, checkoutRoot, source, authorizeSource = async () => false }) {
  if (!path) return { allowedSourceIds: [source.id], sourceVersions: { [source.id]: source.version } };
  let manifest;
  try { manifest = JSON.parse((await readPrivate(path, checkoutRoot, 256 * 1024)).toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { allowedSourceIds: [source.id], sourceVersions: { [source.id]: source.version } }; throw error; }
  if (!Array.isArray(manifest.sources) || manifest.sources.length > 100) throw Error('MEMORY_MANIFEST_INVALID');
  if(new Set(manifest.sources.map(entry=>entry?.sourceId)).size!==manifest.sources.length)throw Error('MEMORY_MANIFEST_INVALID');
  const allowedSourceIds = [source.id], sourceVersions = { [source.id]: source.version }, sourceHashes = {}, excluded = [];
  for (const entry of manifest.sources) {
    if (!entry || typeof entry.sourceId !== 'string' || !entry.sourceId || typeof entry.version !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash || '') || !entry.path) throw Error('MEMORY_MANIFEST_INVALID');
    if (!await authorizeSource(entry)) { excluded.push({ sourceId: entry.sourceId, reason: 'SOURCE_NOT_AUTHORIZED' }); continue; }
    try {
      const body = await readPrivate(entry.path, checkoutRoot, 2 * 1024 * 1024);
      if (createHash('sha256').update(body).digest('hex') !== entry.hash) { excluded.push({ sourceId: entry.sourceId, reason: 'SOURCE_CONTENT_CHANGED' }); continue; }
      allowedSourceIds.push(entry.sourceId); sourceVersions[entry.sourceId] = entry.version; sourceHashes[entry.sourceId] = entry.hash;
    } catch { excluded.push({ sourceId: entry.sourceId, reason: 'SOURCE_UNAVAILABLE' }); }
  }
  return { allowedSourceIds, sourceVersions, sourceHashes, excluded };
}
