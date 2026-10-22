import { createHash } from 'node:crypto';
import { readFile, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, sep } from 'node:path';

export const DOCUMENT_POLICY_VERSION = 'document-source-policy-v1';
export const documentSourceId = id => `document:wps-${createHash('sha256').update(String(id)).digest('hex').slice(0, 24)}`;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
const list = v => Array.isArray(v) ? v : [];
const sourceId = v => /^document:wps-[a-f0-9]{24}$/.test(v);
const CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const within = (root, target) => { const path = relative(root, target); return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep); };
async function readIntakeFile(path, { root, maxBytes = 32 * 1024 * 1024 } = {}) {
 const canonical = await realpath(path);
 if (within(CHECKOUT_ROOT, canonical) || root && !within(root, canonical)) throw Error('DOCUMENT_PATH_NOT_ALLOWED');
 const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const stat = await handle.stat();
  if (!stat.isFile()) throw Error('DOCUMENT_FILE_REQUIRED');
  if (stat.size > maxBytes) throw Error('DOCUMENT_FILE_TOO_LARGE');
  const body = await handle.readFile('utf8');
  if (Buffer.byteLength(body) > maxBytes) throw Error('DOCUMENT_FILE_TOO_LARGE');
  return { body, canonical };
 } finally { await handle.close(); }
}
const parentSourceId = v => typeof v === 'string' && /^[\w.:-]{1,250}$/.test(v) && !v.startsWith('document:');
const documentId = v => /^[\w.-]{1,200}$/.test(v);

/** Visibility does not imply consent. Missing policy, missing entry and any non-allowed status deny. */
export function parseDocumentPolicy(value) {
 if (!object(value) || value.version !== DOCUMENT_POLICY_VERSION || !Array.isArray(value.documents)
  || value.documents.some(d => !object(d) || !documentId(text(d.documentId)) || !['allowed', 'excluded', 'revoked', 'paused'].includes(d.status) || d.legacyParentSourceIds !== undefined || (d.kind === 'legacy_report' ? !parentSourceId(d.requiresParentSourceId) : d.requiresParentSourceId !== undefined))
  || new Set(value.documents.map(d => String(d.documentId))).size !== value.documents.length) throw Error('INVALID_DOCUMENT_POLICY');
 return value;
}
export async function loadDocumentPolicy(path) {
 return path ? parseDocumentPolicy(JSON.parse(await readFile(path, 'utf8'))) : { version: DOCUMENT_POLICY_VERSION, documents: [] };
}
export function documentDependencies(row) {
 let locator = {}; try { locator = typeof row.locator === 'string' ? JSON.parse(row.locator) : row.locator || {}; } catch {}
 const ids = [...list(row.document_dependencies), ...list(row.derived_document_ids), row.canonical_document_id, row.document_id];
 if (row.source_type === 'document' || locator.sourceType === 'document') ids.push(locator.sourceRef);
 return [...new Set([...ids.filter(v => documentId(text(v))).map(v => documentSourceId(String(v))),
  ...ids.filter(v => typeof v === 'string' && sourceId(v)), ...ids.filter(v => v != null && v !== '' && !documentId(text(v)) && !sourceId(v)).map(() => 'document:invalid'), ...list(row.source_ids).filter(v => typeof v === 'string' && v.startsWith('document:')), ...(typeof row.source_id === 'string' && row.source_id.startsWith('document:') ? [row.source_id] : [])])];
}
/** Metric identity only: do not change canonical source IDs or source policy. */
export function documentCountKey(row) {
 const explicit = text(row.document_id) || text(row.canonical_document_id);
 if (explicit) return explicit;
 let locator = {}; try { locator = typeof row.locator === 'string' ? JSON.parse(row.locator) : row.locator || {}; } catch {}
 return text(locator.sourceRef) || text(row.source_id) || text(row.sourceId);
}
export function isDocumentEvidence(row) {
 let locator = {}; try { locator = JSON.parse(row.locator); } catch {}
 return row.source_type === 'document' || locator?.sourceType === 'document';
}
export function documentParentSourceIds(row, documentPolicy) {
 if (documentPolicy === undefined) return [];
 const dependencies = new Set(documentDependencies(row));
 return [...new Set(parseDocumentPolicy(documentPolicy).documents.filter(d => d.kind === 'legacy_report' && dependencies.has(documentSourceId(d.documentId))).map(d => d.requiresParentSourceId))];
}
export function documentEvidenceAllowed(row, documentPolicy, { allowedSourceIds, parentAllowedSourceIds = allowedSourceIds, excludedSourceIds } = {}) {
 const deps = documentDependencies(row);
 if (!deps.length) return !isDocumentEvidence(row);
 const policy = documentPolicy === undefined ? { documents: [] } : parseDocumentPolicy(documentPolicy);
 const allowed = new Set(policy.documents.filter(d => d.status === 'allowed').map(d => documentSourceId(d.documentId)));
 const parents = documentParentSourceIds(row, documentPolicy);
 const parentAllowed = parentAllowedSourceIds instanceof Set ? parentAllowedSourceIds : new Set(list(parentAllowedSourceIds));
 const excluded = excludedSourceIds instanceof Set ? excludedSourceIds : new Set(list(excludedSourceIds));
 return deps.every(id => allowed.has(id)) && parents.every(id => parentAllowed.has(id) && !excluded.has(id));
}

function chunks(body, maxChars) {
 const out = []; let section = { title: '', text: '' };
 for (const line of body.split(/(?<=\n)/)) {
  const heading = /^#{1,6}\s+(.+?)(?:\r?\n)?$/.exec(line);
  if (heading && section.text) { out.push(section); section = { title: heading[1].trim(), text: '' }; }
  if (heading) section.title = heading[1].trim();
  section.text += line;
 }
 if (section.text) out.push(section);
 return out.flatMap((s, sectionIndex) => {
  const parts = [];
  for (let offset = 0; offset < s.text.length; offset += maxChars) parts.push({ title: s.title, text: s.text.slice(offset, offset + maxChars), sectionIndex, chunkIndex: parts.length });
  return parts;
 });
}
const excludedStatus = /^(?:excluded|revoked|paused|obsolete|outdated|expired|template|blank|empty|过期|模板|空白|已废弃|image_only|image-only|图-only)$/i;
const exactDate = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text(value)) && Number.isFinite(Date.parse(value)) ? value : null;

/** Reads only the explicit manifest and named body files. Never discovers sources or calls providers. */
export async function readDocumentIntake(manifestPath, { documentPolicy, maxChunkChars = 6000, allowedSourceIds, parentAllowedSourceIds = allowedSourceIds, excludedSourceIds } = {}) {
 if (!Number.isInteger(maxChunkChars) || maxChunkChars < 200 || maxChunkChars > 12000) throw Error('INVALID_DOCUMENT_CHUNK_LIMIT');
 const manifestFile = await readIntakeFile(manifestPath);
 const manifest = JSON.parse(manifestFile.body);
 const documents = Array.isArray(manifest) ? manifest : manifest.documents;
 if (!Array.isArray(documents)) throw Error('INVALID_DOCUMENT_MANIFEST');
 const policy = documentPolicy === undefined ? { version: DOCUMENT_POLICY_VERSION, documents: [] } : parseDocumentPolicy(documentPolicy);
 const records = [], accepted = [], rejected = [];
 for (const doc of documents) {
  if (!documentId(text(doc?.documentId))) throw Error('INVALID_DOCUMENT_ID');
  const id = String(doc.documentId);
  const reject = reason => rejected.push({ documentId: id, reason });
  if (doc.decision !== 'admit' || excludedStatus.test(text(doc.status))) { reject('NOT_ADMITTED'); continue; }
  if (!documentEvidenceAllowed({ source_type: 'document', document_id: id }, policy, { parentAllowedSourceIds, excludedSourceIds })) { reject('DOCUMENT_NOT_ALLOWED'); continue; }
  let parsedUrl; try { parsedUrl = new URL(doc.url); } catch { throw Error('INVALID_DOCUMENT_URL'); }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || [...parsedUrl.searchParams.keys()].some(key => /^(?:token|key|api_key|apikey|access_token|secret|password|signature|sig|x-amz-signature)$/i.test(key))) throw Error('INVALID_DOCUMENT_URL');
  if (!text(doc.bodyPath)) throw Error('DOCUMENT_BODY_PATH_REQUIRED');
  const { body } = await readIntakeFile(resolve(dirname(manifestFile.canonical), doc.bodyPath), { root: dirname(manifestFile.canonical), maxBytes: 16 * 1024 * 1024 });
  const hash = createHash('sha256').update(body).digest('hex');
  if (doc.contentHash !== hash) throw Error('DOCUMENT_CONTENT_HASH_MISMATCH');
  if (!body.trim()) { reject('EMPTY_BODY'); continue; }
  // Keep a complete body, using the supplied sections only for provenance/date/status.
  const sections = list(doc.sections);
  const revision = text(doc.revision ?? doc.sourceVersion) || hash;
  const source = documentSourceId(id); let count = 0;
  for (const chunk of chunks(body, maxChunkChars)) {
   if (!chunk.text.trim()) continue;
   const section = sections.find(s => text(s.title) && text(s.title) === chunk.title)
    || sections.find(s => text(s.text) && s.text.includes(chunk.text.trim()));
   if (section && excludedStatus.test(text(section.status))) continue;
   const sectionId = text(section?.id) || `section-${chunk.sectionIndex + 1}`;
   const itemRef = `${hash}:section-${chunk.sectionIndex + 1}:chunk-${chunk.chunkIndex + 1}`;
   records.push({ source_type: 'document', source_id: source, source_ids: [source, ...documentParentSourceIds({ source_type: 'document', document_id: id }, policy)], source_title: text(doc.title),
    speaker: '文档正文', occurred_at: exactDate(section?.dateHint) || exactDate(doc.businessDateOrRange), text: chunk.text,
    locator: JSON.stringify({ platform: 'wps', sourceType: 'document', sourceRef: id, itemRef, revision, contentHash: hash, sectionId }),
    url: doc.url, document_id: id, canonical_document_id: id, revision, content_hash: hash,
    section_id: sectionId, section_title: chunk.title, section_status: text(section?.status),
    date_precision: exactDate(section?.dateHint) || exactDate(doc.businessDateOrRange) ? 'timestamp' : /^\d{4}-\d{2}-\d{2}$/.test(text(section?.dateHint || doc.businessDateOrRange)) ? 'day' : 'unknown_or_range',
    source_modified_at: doc.sourceModifiedAt || null, business_date_or_range: section?.dateHint || doc.businessDateOrRange || null,
    document_role: text(doc.role), document_limits: doc.limits, explicit_case_ids: list(doc.caseIds), origins: ['document_intake'] });
   count++;
  }
  accepted.push({ documentId: id, source_id: source, content_hash: hash, revision, chunk_count: count, body_char_count: body.length });
 }
 return { records, receipt: { status: 'VERIFIED', documents: accepted, rejected, document_count: accepted.length, chunk_count: records.length, formalMemoryUpdated: false } };
}
