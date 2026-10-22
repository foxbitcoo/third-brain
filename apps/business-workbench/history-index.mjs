import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { documentEvidenceAllowed, documentCountKey, documentDependencies, documentParentSourceIds, isDocumentEvidence, documentSourceId } from './document-intake.mjs';

export const HISTORY_INDEX_VERSION = 'historical-evidence-v1';
export const MAX_HISTORY_INDEX_BYTES = 128 * 1024 * 1024;
// Permanent private-record fence. Only its digest is retained in application code.
export const PERMANENT_BLOCKED_LOCATOR_HASHES = Object.freeze(['6bfe120ef1d60a9d23ed70e7be15a84b1f12b3fe9ee234d3e5e26774e80e7e37']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const str = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const arr = value => Array.isArray(value) ? value : [];
const unique = values => [...new Set(values.filter(Boolean))].sort();
const norm = value => str(value).normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const set = value => value instanceof Set ? value : new Set(arr(value).map(String));
export const historySourceId = sourceRef => `monitor:wps-${createHash('sha256').update(`chat:${sourceRef}`).digest('hex').slice(0, 24)}`;

/** Keep raw provider envelopes and credentials out of the normalized store. */
export function sanitizeHistoryText(value, secrets = []) {
 let text = str(value);
 for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 6) text = text.split(secret).join('[已移除凭据]');
 return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[已移除私钥]')
  .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '[已移除认证信息]')
  .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g, '[已移除凭据]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[已移除凭据]')
  .replace(/((?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|authorization|secret[ _-]?key|client[ _-]?secret|password|wps_sid|csrf|cookie|密码|密钥|令牌)\s*["']?\s*(?:[:=：]|为|是)\s*)["']?(?!\[已移除[^\]]*\])[^\s,;，；"'<>}]+["']?/gi, '$1[已移除凭据]')
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已移除认证信息]@')
  .replace(/([?&](?:token|key|api_key|apikey|access_token|secret|password|signature|sig)=)[^\s&#"']+/gi, '$1[已移除凭据]')
  .replace(/\b(?=[A-Za-z0-9_+/=-]{32,}\b)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{32,}\b/g, '[已移除疑似凭据]');
}
function identifier(value, secrets = []) {
 const v = str(value);
 return v && v.length <= 250 && /^[\w.:/-]+$/.test(v) && !secrets.some(s => typeof s === 'string' && s.length >= 6 && v.includes(s)) ? v : '';
}
function parseLocator(value) { if (object(value)) return value; try { const p = JSON.parse(value); return object(p) ? p : {}; } catch { return {}; } }
function time(value) {
 if (value === null || value === undefined || value === '') return null;
 const n = typeof value === 'number' || /^\d{10,13}$/.test(String(value)) ? Number(value) : NaN;
 const date = new Date(Number.isFinite(n) ? n < 1e12 ? n * 1000 : n : value);
 return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function url(value, secrets) {
 const clean = sanitizeHistoryText(value, secrets);
 if (clean !== str(value)) return null;
 try { const p = new URL(clean); return p.protocol === 'https:' && !p.username && !p.password ? clean : null; } catch { return null; }
}
function policy(options = {}) { return { excluded: set(options.excludedSourceIds), allowed: options.allowedSourceIds === undefined ? null : set(options.allowedSourceIds), documentPolicy: options.documentPolicy, parentAllowedSourceIds: options.parentAllowedSourceIds === undefined ? options.allowedSourceIds : options.parentAllowedSourceIds, blocked: new Set([...PERMANENT_BLOCKED_LOCATOR_HASHES, ...set(options.blockedLocatorHashes)]) }; }
function denied(row, p, checkAllowed = true) {
 return p.blocked.has(row.locator_hash) || row.source_ids.some(id => p.excluded.has(id)) || !documentEvidenceAllowed(row, p.documentPolicy, { parentAllowedSourceIds: p.parentAllowedSourceIds, excludedSourceIds: p.excluded }) || checkAllowed && !isDocumentEvidence(row) && p.allowed && !row.source_ids.some(id => p.allowed.has(id));
}
function normalized(row, options) {
 if (!object(row)) return null;
 const secrets = options.secrets || [];
 const loc = parseLocator(row.locator ?? row.source_locator ?? row.sourceLocator);
 const raw = object(row.raw) ? row.raw : {};
 const referencedDocuments = arr(options.documentPolicy?.documents).filter(d => typeof d.url === 'string' && d.url.length > 15 && (row.url === d.url || str(row.text ?? row.content ?? row.body ?? raw.content).includes(d.url))).map(d => String(d.documentId));
 row = { ...row, ...(row.canonical_document_id ? { canonical_document_id: identifier(row.canonical_document_id, secrets) } : {}),
  document_dependencies: unique([...arr(row.document_dependencies), ...referencedDocuments]), ...(referencedDocuments.length === 1 && !row.canonical_document_id ? { canonical_document_id: referencedDocuments[0] } : {}) };
 const participantMapping = arr(options.sourceMap?.participant_mapping);
 const sourceMapping = arr(options.sourceMap?.source_mapping);
 const sourceKey = str(row.sourceKey ?? row.source_id ?? row.sourceId);
 const nativeRef = identifier(loc.sourceRef ?? row.source_ref ?? row.sourceRef ?? raw.chat_id ?? row.chat_id ?? (sourceKey.startsWith('wps:') ? sourceKey.split(':').at(-1) : ''), secrets);
 const itemRef = identifier(loc.itemRef ?? row.message_id ?? row.messageId ?? raw.id ?? row.itemRef ?? row.id, secrets);
 const platform = identifier(loc.platform ?? row.platform ?? (raw.chat_id || sourceKey.startsWith('wps:') ? 'wps' : ''), secrets);
 const sourceType = platform === 'wps' && !['document', 'transcript', 'calendar'].includes(row.source_type) ? 'chat' : identifier(loc.sourceType ?? row.sourceKind ?? row.kind ?? 'chat', secrets);
 let source_ids = unique([nativeRef, identifier(sourceKey, secrets), ...arr(row.source_ids).map(v => identifier(v, secrets)), ...(platform === 'wps' && nativeRef ? [sourceType === 'calendar' ? `calendar:wps-${nativeRef}` : sourceType === 'document' ? documentSourceId(nativeRef) : historySourceId(nativeRef)] : []), ...documentDependencies(row), ...documentParentSourceIds(row, options.documentPolicy)]);
 const content = sanitizeHistoryText(row.text ?? row.content ?? row.body ?? raw.content, secrets);
 // Non-text activities remain in the corpus and coverage, but are never factual query evidence.
 const has_searchable_text = !!content;
 if (!source_ids.length) source_ids = [`source:${digest([row.source_title ?? row.sourceTitle ?? row.sourceName ?? '', loc.sourceRef ?? row.locator ?? row.source_locator ?? row.sourceLocator ?? row.id ?? '']).slice(0, 24)}`];
 // A provider-native locator is canonical across collectors, cards and formal exports.
 const canonical = nativeRef && itemRef ? { platform, sourceType, sourceRef: nativeRef, itemRef, ...(sourceType === 'document' ? { revision: str(row.revision ?? loc.revision), contentHash: str(row.content_hash ?? loc.contentHash), sectionId: str(row.section_id ?? loc.sectionId) } : {}) } : null;
 const locator = canonical ? JSON.stringify(canonical) : sanitizeHistoryText(row.locator ?? row.source_locator ?? row.sourceLocator ?? '', secrets);
 if (!locator) return null;
 const locator_hash = digest([canonical?.platform || '', canonical?.sourceRef || '', canonical?.itemRef || '']);
 const mappedSource = sourceMapping.find(m => nativeRef && str(m.platform_chat_id) === nativeRef)
  || (!nativeRef ? sourceMapping.find(m => str(m.source_key) === sourceKey || str(m.alias) === str(row.source_title ?? row.sourceName)) : null);
 if (mappedSource) source_ids = unique([...source_ids, identifier(mappedSource.source_key, secrets)]);
 const source_title = sanitizeHistoryText(mappedSource?.verified_display_name || row.source_title || row.sourceTitle || row.sourceName || row.title || '历史来源', secrets);
 const sender = object(row.sender) ? row.sender : object(raw.sender) ? raw.sender : {};
 let speaker_id = identifier(row.speaker_id ?? sender.id ?? row.senderId ?? raw.sender_id, secrets);
 const speakerLabel = str(row.speaker || sender.name || (typeof row.sender === 'string' ? row.sender : '') || row.senderName || raw.sender_name);
 const mappedSpeaker = participantMapping.find(m => speaker_id ? str(m.platform_user_id) === speaker_id : str(m.alias) === speakerLabel);
 if (!speaker_id && mappedSpeaker) speaker_id = identifier(mappedSpeaker.platform_user_id, secrets);
 const mappedName = mappedSpeaker && !/unverified|unknown|conflict|unresolved/i.test(str(mappedSpeaker.name_binding_status)) ? mappedSpeaker.verified_display_name : '';
 const speaker = sanitizeHistoryText(mappedName || speakerLabel, secrets) || '发言人未核实';
 const occurred_at = time(row.occurred_at ?? row.occurredAt ?? row.timestamp ?? row.time ?? raw.ctime);
 const native_id = canonical ? digest([platform, nativeRef, itemRef]) : digest([source_ids, source_title, locator]);
 const id = `history-${digest([native_id, norm(content), speaker_id || norm(speaker), occurred_at]).slice(0, 32)}`;
 return { id, native_id, locator_hash, source_ids, source_id: platform === 'wps' && nativeRef ? sourceType === 'calendar' ? `calendar:wps-${nativeRef}` : sourceType === 'document' ? documentSourceId(nativeRef) : historySourceId(nativeRef) : source_ids.find(v => v.startsWith('monitor:')) || source_ids[0],
  source_type: ['document', 'transcript', 'calendar'].includes(row.source_type) ? row.source_type : sourceType === 'document' ? 'document' : 'im',
  source_title, speaker, speaker_id: speaker_id || null, occurred_at, text: content, has_searchable_text, locator, source_locator: locator, url: url(row.url, secrets),
  ...(row.canonical_document_id ? { canonical_document_id: identifier(row.canonical_document_id, secrets) } : {}),
  document_dependencies: unique([...arr(row.document_dependencies).map(v => identifier(v, secrets)), ...arr(row.derived_document_ids).map(v => identifier(v, secrets)), identifier(row.canonical_document_id, secrets)]),
  ...(sourceType === 'document' || row.source_type === 'document' ? { document_id: identifier(row.document_id ?? nativeRef, secrets), canonical_document_id: identifier(row.canonical_document_id ?? nativeRef, secrets), revision: identifier(row.revision ?? loc.revision, secrets), content_hash: /^[a-f0-9]{64}$/.test(row.content_hash ?? loc.contentHash) ? row.content_hash ?? loc.contentHash : null, section_id: identifier(row.section_id ?? loc.sectionId, secrets), section_title: sanitizeHistoryText(row.section_title, secrets), section_status: sanitizeHistoryText(row.section_status, secrets), date_precision: ['timestamp', 'day', 'unknown_or_range'].includes(row.date_precision) ? row.date_precision : 'unknown_or_range', source_modified_at: time(row.source_modified_at), business_date_or_range: sanitizeHistoryText(typeof row.business_date_or_range === 'object' ? JSON.stringify(row.business_date_or_range) : row.business_date_or_range, secrets) || null, document_role: sanitizeHistoryText(row.document_role, secrets), document_limits: sanitizeHistoryText(typeof row.document_limits === 'object' ? JSON.stringify(row.document_limits) : row.document_limits, secrets) } : {}),
  origins: unique([...arr(row.origins).map(v => identifier(v, secrets)), identifier(options.origin, secrets)]),
  explicit_case_ids: unique(arr(row.explicit_case_ids).map(v => identifier(v, secrets))),
  inferred_case_ids: unique(arr(row.inferred_case_ids).map(v => identifier(v, secrets))) };
}
export function normalizeHistory(records = [], options = {}) {
 const p = policy(options), byId = new Map();
 for (const input of arr(records)) {
  if (p.blocked.has(input?.locator_hash)) continue;
  const row = normalized(input, options); if (!row || p.blocked.has(row.locator_hash)) continue;
  const old = byId.get(row.id);
  if (!old) byId.set(row.id, row);
  else for (const key of ['source_ids', 'origins', 'explicit_case_ids', 'inferred_case_ids']) old[key] = unique([...old[key], ...row[key]]);
 }
 // User source policy quarantines retained local history at retrieval; it never erases it.
 // The permanent/private-record locator fence remains an ingestion and output ban.
 const rows = [...byId.values()];
 const revisions = Map.groupBy(rows, row => row.native_id);
 for (const row of rows) { const variants = revisions.get(row.native_id); row.revision_count = variants.length; row.conflict = variants.length > 1; }
 return rows.sort((a, b) => (a.occurred_at || '').localeCompare(b.occurred_at || '') || a.id.localeCompare(b.id));
}
export function mergeHistory(previous = [], incoming = [], options = {}) { return normalizeHistory([...arr(previous), ...arr(incoming)], options); }

const monthNames = new Map([['一',1],['二',2],['三',3],['四',4],['五',5],['六',6],['七',7],['八',8],['九',9],['十',10],['十一',11],['十二',12]]);
const searchNorm = value => norm(value).replace(/(十二|十一|十|[一二三四五六七八九])月/g, (_, month) => `${monthNames.get(month)}月`);
const generic = new Set(['工作','主线','项目','情况','进展','目前','当前','最新','历史','之前','现在','怎样','如何','什么','是否','哪些','哪里','一下','相关','问题','确认','内容','需要','我们','这个','那个','以及','还有','怎么','今天','昨天','介绍','背景','总结','状态','已经','时间','安排','负责','跟进','查询']);
function terms(value) {
 const text = searchNorm(value); const out = new Set();
 for (const token of text.match(/\d+(?:\.\d+)*(?:%|月|日|号|年)?/g) || []) out.add(token);
 for (const token of text.match(/[a-z][a-z0-9._-]{2,}/g) || []) if (!['the','and','for','with','what','how','status','history','latest'].includes(token)) out.add(token);
 for (const chunk of text.match(/[\p{Script=Han}]+/gu) || []) for (let n = 2; n <= Math.min(4, chunk.length); n++) for (let i = 0; i <= chunk.length - n; i++) {
  const token = chunk.slice(i, i + n); if (![...generic].some(g => token.includes(g))) out.add(token);
 }
 return [...out].slice(0, 400);
}
const overlap = (text, tokens) => { const normalizedText = searchNorm(text); return tokens.filter(t => normalizedText.includes(t)); };
const distinctive = tokens => tokens.filter(t => /[a-z]/.test(t) || t.length >= 3);

// Answer length/citation requirements are not business search terms. Keep all
// substantive question clauses, stopping only at a subsequent formatting clause.
function businessQuery(value) {
 const kept = [];
 const outputInstruction = /^(?:(?:请|并且|并|再|同时|然后)\s*)?(?:每个(?:月|季度|阶段|部分)(?:各|都)?(?:用|写|给|列|附|引|概括|总结)|各(?:用|写|给|列|附|引)|分别(?:用|写|给|列)|总计|合计|字数|控制在|不超过|限于|最多\s*\d+\s*字|引用.{0,12}(?:条|原文|出处)|附上.{0,12}(?:引用|出处)|没有依据|如无依据|输出格式|按.{0,8}(?:概括|总结|格式|列出)|(?:please\s+)?(?:answer|respond|format|cite|limit|keep).{0,25}(?:words|sentences|citations|format|brief))/i;
 for (const clause of str(value).split(/[？?！!。；;\n，,]+/)) {
  const part = clause.trim(); if (!part) continue;
  if (kept.length && outputInstruction.test(part)) break;
  kept.push(part);
 }
 return kept.join('，');
}
function searchEvidenceText(value) {
 return str(value).split(/\r?\n/).filter(line => !/^\s*[【\[]\s*图片正文\s*[·|].*\bOCR\b.*[】\]]\s*$/i.test(line)
  && !/^\s*(?:OCR\s*(?:model|模型)|(?:图片)?(?:识别|提取)模型)\s*[:：=]/i.test(line)).join('\n');
}

function metadata(records) {
 const dates = records.map(r => r.occurred_at).filter(Boolean).sort();
 const gaps = dates.slice(1).map((d, i) => Date.parse(d) - Date.parse(dates[i]));
 const uniqueMessageCount = new Set(records.map(r => r.native_id)).size;
 return { record_count: records.length, unique_message_count: uniqueMessageCount, retained_version_count: records.length, revision_count: records.length - uniqueMessageCount,
  linked_unique_message_count: new Set(records.filter(r => r.explicit_case_ids.length || r.inferred_case_ids.length).map(r => r.native_id)).size, nontext_record_count: records.filter(r => !r.has_searchable_text).length, source_count: new Set(records.map(r => r.source_id)).size,
  document_count: new Set(records.filter(isDocumentEvidence).map(documentCountKey)).size, document_chunk_count: records.filter(isDocumentEvidence).length, document_version_count: new Set(records.filter(isDocumentEvidence).map(r => JSON.stringify([documentCountKey(r), r.content_hash || r.revision || null]))).size,
  source_titles: unique(records.map(r => r.source_title)),
  undated_record_count: records.length - dates.length, largest_chronology_gap_days: gaps.length ? gaps.reduce((largest, gap) => Math.max(largest, gap), 0) / 86_400_000 : null,
  earliest_at: dates[0] || null, latest_at: dates.at(-1) || null,
  linked_record_count: records.filter(r => r.explicit_case_ids.length || r.inferred_case_ids.length).length,
  explicit_linked_record_count: records.filter(r => r.explicit_case_ids.length).length,
  inferred_linked_record_count: records.filter(r => r.inferred_case_ids.length).length,
  revision_record_count: records.filter(r => r.conflict).length,
  coverage: 'retained_local_evidence_only', complete: false };
}
export function buildHistoryIndex({ corpusRecords = [], legacyRecords = [], cases = [], previousIndex = null, now = new Date().toISOString(), ...options } = {}) {
 if (previousIndex !== null && !validateHistoryIndex(previousIndex)) throw new Error('INVALID_HISTORY_INDEX');
 const caseRows = arr(cases).flatMap(c => arr(c.evidence).map(row => ({ ...row, explicit_case_ids: unique([...arr(row.explicit_case_ids), c.id]) })));
 const records = normalizeHistory([
  ...arr(previousIndex?.records),
  ...normalizeHistory(corpusRecords, { ...options, origin: 'corpus' }),
  ...normalizeHistory(legacyRecords, { ...options, origin: 'formal_history' }),
  ...normalizeHistory(caseRows, { ...options, origin: 'case_evidence' }),
 ], options);
 const p = policy(options);
 // Group membership alone never establishes that a message belongs to a workline.
 for (const c of arr(cases)) {
  if (!identifier(c.id, options.secrets)) continue;
  const own = records.filter(r => r.explicit_case_ids.includes(c.id) && !denied(r, p));
  const ownSources = new Set(own.flatMap(r => r.source_ids));
  const anchorTerms = terms([c.title, c.question, c.scope].filter(Boolean).join(' '));
  for (const row of records) {
   if (denied(row, p) || row.explicit_case_ids.includes(c.id)) continue;
   const hits = overlap(row.text, anchorTerms), strong = distinctive(hits);
   const sameSource = row.source_ids.some(id => ownSources.has(id));
   if (strong.length && (sameSource || new Set(strong.map(t => t.slice(0, 3))).size >= 2)) row.inferred_case_ids = unique([...row.inferred_case_ids, c.id]);
  }
 }
 const case_links = records.flatMap(r => [...r.explicit_case_ids.map(case_id => ({ case_id, record_id: r.id, basis: 'explicit_evidence' })), ...r.inferred_case_ids.filter(id => !r.explicit_case_ids.includes(id)).map(case_id => ({ case_id, record_id: r.id, basis: 'inferred_related' }))]);
 const coverage_gaps = unique([...arr(previousIndex?.coverage_gaps), ...arr(options.coverage_gaps)].map(v => sanitizeHistoryText(v, options.secrets)));
 return { version: HISTORY_INDEX_VERSION, updated_at: time(now), records, case_links, coverage_gaps, scope: { ...metadata(records), retained_record_count: records.length },
  ingestion: { corpus_input_count: corpusRecords.length, legacy_input_count: legacyRecords.length, case_evidence_input_count: caseRows.length,
   previous_record_count: previousIndex?.records.length || 0, retained_record_count: records.length,
   duplicate_or_rejected_count: (previousIndex?.records.length || 0) + corpusRecords.length + legacyRecords.length + caseRows.length - records.length } };
}
/** Candidate associations only; this never writes formal WorkThread/Current State. */
export function linkHistoryDocuments(index, associations = [], options = {}) {
 if (!validateHistoryIndex(index)) throw Error('INVALID_HISTORY_INDEX');
 if (!Array.isArray(associations) || associations.some(a => !object(a) || !a.documentId || !Array.isArray(a.caseIds))) throw Error('INVALID_DOCUMENT_ASSOCIATIONS');
 const records = index.records.map(row => {
  if (!isDocumentEvidence(row)) return row;
  const matches = associations.filter(a => String(a.documentId) === row.document_id && (!Array.isArray(a.sectionIds) || a.sectionIds.includes(row.section_id)));
  return { ...row, inferred_case_ids: unique([...row.inferred_case_ids, ...matches.flatMap(a => a.caseIds).map(id => identifier(id, options.secrets))]) };
 });
 return buildHistoryIndex({ previousIndex: index, corpusRecords: records, ...options });
}
export function validateHistoryIndex(index) {
 return !!(object(index) && index.version === HISTORY_INDEX_VERSION && Array.isArray(index.records) && Array.isArray(index.case_links)
  && index.records.every(r => object(r) && /^history-[a-f0-9]{32}$/.test(r.id) && /^[a-f0-9]{64}$/.test(r.native_id) && /^[a-f0-9]{64}$/.test(r.locator_hash)
   && Array.isArray(r.source_ids) && r.source_ids.length && r.source_ids.every(v => typeof v === 'string')
   && ['source_id','source_type','source_title','speaker','text','locator'].every(k => typeof r[k] === 'string')
   && (r.occurred_at === null || typeof r.occurred_at === 'string' && time(r.occurred_at) !== null)
   && Array.isArray(r.explicit_case_ids) && r.explicit_case_ids.every(v => typeof v === 'string') && Array.isArray(r.inferred_case_ids) && r.inferred_case_ids.every(v => typeof v === 'string')));
}

/** Deterministic lexical retrieval; old evidence remains searchable outside the recent window. */
export function retrieveHistory(index, { question = '', case_id, limit = 32, maxChars = 60_000, ...options } = {}) {
 if (!validateHistoryIndex(index)) throw new Error('INVALID_HISTORY_INDEX');
 if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 160_000) throw new Error('INVALID_HISTORY_QUERY_LIMIT');
 // Normalize again at the output boundary: externally supplied indexes cannot bypass sanitization or the locator fence.
 const normalizedRows = normalizeHistory(index.records, options), p = policy(options);
 const eligible = normalizedRows.filter(r => !denied(r, p));
 const scoped = case_id ? eligible.filter(r => r.explicit_case_ids.includes(case_id) || r.inferred_case_ids.includes(case_id)) : eligible;
 const originalQuery = sanitizeHistoryText(question, options.secrets), query = businessQuery(originalQuery), tokens = terms(query);
 const entityTokens = tokens.filter(t => /^[a-z][a-z0-9._-]{2,}$/.test(t));
 const numericAnchors = tokens.filter(t => /^\d+(?:\.\d+)+$/.test(t));
 let requestedMonths = unique([...searchNorm(query).matchAll(/(?:^|[^\d])(1[0-2]|0?[1-9])月/g)].map(m => String(Number(m[1]))));
 const monthRange = /(?:^|[^\d])(1[0-2]|0?[1-9])月?\s*(?:到|至|-|~|—|–|through|to)\s*(1[0-2]|0?[1-9])月/i.exec(searchNorm(query));
 if (monthRange) { const from = Number(monthRange[1]), to = Number(monthRange[2]); if (from <= to) requestedMonths = Array.from({ length: to - from + 1 }, (_, i) => String(from + i)); }
 const laterContext = requestedMonths.length > 0 && /后来|后续|之后|如今|现在|完成|替代|变化|演变|later|follow|compare|current|evol/i.test(query);
 const topicQuery = searchNorm(query).replace(/(?:1[0-2]|0?[1-9])月?\s*(?:到|至|-|~|—|–|through|to)\s*(?:1[0-2]|0?[1-9])月/gi, '').replace(/(?:1[0-2]|0?[1-9])月/g, '');
 const genericQuery = !!query && !topicQuery.replace(/最近|近期|当前|目前|现在|最新|历史|工作|主线|进展|情况|状态|背景|总结|主要|忙|概况|发生|变化|项目|事项|帮我|告诉|说说|讲讲|看看|介绍|一下|这个|这条|是|请|到|至|我|们|在|做|啥|干|有|什|么|哪|些|的|了|呢|吗|怎样|如何|[？?，,。!！\s]/g, '');
 const candidates = !query ? [] : scoped.map(row => {
  const semanticTokens = tokens.filter(t => !/^\d{1,2}月$/.test(t));
  const searchText = searchEvidenceText(row.text);
  const hits = overlap(searchText, semanticTokens), entityHits = overlap(searchText, entityTokens).length, titleHits = overlap(row.source_title, tokens);
  const monthMatch = !requestedMonths.length || laterContext && Number(row.occurred_at?.slice(5, 7)) >= Math.min(...requestedMonths.map(Number)) || requestedMonths.includes(String(Number(row.occurred_at?.slice(5, 7)))) || requestedMonths.some(m => new RegExp(`(?:^|[^\\d])${m}月`).test(searchNorm(searchText)));
  const numericMatch = !numericAnchors.length || numericAnchors.some(t => (searchNorm(searchText).match(/\d+(?:\.\d+)+/g) || []).includes(t));
  const matches = row.has_searchable_text && monthMatch && numericMatch && (genericQuery ? !!case_id || row.explicit_case_ids.length > 0 || row.inferred_case_ids.length > 0 : semanticTokens.length ? hits.length > 0 : !!case_id || !!requestedMonths.length && (row.explicit_case_ids.length > 0 || row.inferred_case_ids.length > 0));
  return { row, entityHits, score: (genericQuery ? 0 : hits.reduce((n, t) => n + (t.length >= 3 ? 3 : 1), 0)) + (genericQuery ? 0 : titleHits.length * .2) + (case_id && row.explicit_case_ids.includes(case_id) ? .1 : 0), matches };
 }).filter(v => v.matches).sort((a, b) => b.entityHits - a.entityHits || b.score - a.score || (b.row.occurred_at || '').localeCompare(a.row.occurred_at || '') || a.row.id.localeCompare(b.row.id));
 const selected = [], chosen = new Set(); let chars = 0;
 const add = entry => { if (!entry || chosen.has(entry.row.id) || selected.length >= limit) return; const length = JSON.stringify(entry.row).length; if (chars + length > maxChars) return; selected.push(entry); chosen.add(entry.row.id); chars += length; };
 // A relevant historical anchor and latest revision prevent recency-only answers.
 add(candidates[0]);
 if (limit >= 3) { const strongest = candidates[0]?.entityHits ? candidates.filter(c => c.entityHits === candidates[0].entityHits) : candidates; const chronological = [...strongest].sort((a, b) => (a.row.occurred_at || '').localeCompare(b.row.occurred_at || '') || a.row.id.localeCompare(b.row.id)); add(chronological[0]); add(chronological.at(-1)); }
 if (genericQuery && !case_id) {
  const groups = new Set();
  for (const entry of candidates) { const group = entry.row.explicit_case_ids[0] || entry.row.inferred_case_ids[0] || entry.row.source_id; if (!groups.has(group)) { groups.add(group); add(entry); } }
 }
 for (const entry of candidates) add(entry);
 const evidence = selected.map(({ row }) => ({ ...row, historical_id: row.id, link_basis: case_id ? row.explicit_case_ids.includes(case_id) ? 'explicit_evidence' : 'inferred_related' : 'query_match' }));
 const scope = { ...metadata(scoped), stored_unique_message_count: new Set(normalizedRows.map(r => r.native_id)).size, stored_version_count: normalizedRows.length, retained_record_count: eligible.length, retained_unique_message_count: new Set(eligible.map(r => r.native_id)).size, retained_version_count: eligible.length, linked_record_count: scoped.filter(r => case_id ? r.explicit_case_ids.includes(case_id) || r.inferred_case_ids.includes(case_id) : r.explicit_case_ids.length || r.inferred_case_ids.length).length,
  searched_record_count: scoped.length, matched_record_count: candidates.length, returned_record_count: evidence.length,
  excluded_record_count: index.records.length - eligible.length, truncated: candidates.length > evidence.length,
  requested_months: requestedMonths.map(Number), temporal_context: laterContext ? 'requested_months_and_later' : requestedMonths.length ? 'requested_months' : null, case_id: case_id || null, query_applied: !!query, generic_query: genericQuery, retrieval_subset: true,
  coverage_gaps: arr(index.coverage_gaps).map(v => sanitizeHistoryText(v, options.secrets)), limit, max_chars: maxChars };
 const sourcePolicies = new Map();
 for (const row of eligible) {
  const key = JSON.stringify([row.source_id, isDocumentEvidence(row), row.document_dependencies]);
  const previous = sourcePolicies.get(key);
  const source_ids = unique([...(previous?.source_ids || []), ...row.source_ids]);
  sourcePolicies.set(key, isDocumentEvidence(row) || documentDependencies(row).length ? { source_ids, source_type: row.source_type, document_dependencies: row.document_dependencies, ...(row.document_id ? { document_id: row.document_id } : {}) } : { source_ids });
 }
 const policySources = [...sourcePolicies.values()];
 return { evidence, scope, policySources, duplicateCount: Math.max(0, index.records.length - normalizedRows.length), excludedCount: Math.max(0, index.records.length - eligible.length) };
}

export async function loadHistoryIndex(path) {
 try { const index = JSON.parse(await readFile(path, 'utf8')); if (!validateHistoryIndex(index)) throw new Error('INVALID_HISTORY_INDEX'); return index; }
 catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function saveHistoryIndex(path, index) {
 if (!validateHistoryIndex(index)) throw new Error('INVALID_HISTORY_INDEX');
 await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temp = `${path}.${randomUUID()}.tmp`;
 try { await writeFile(temp, `${JSON.stringify(index)}\n`, { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
 finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}

/** One lock protects the complete read/merge/write transaction against lost updates. */
export async function updateHistoryIndex(path, options = {}) {
 await mkdir(dirname(path), { recursive: true, mode: 0o700 });
 const lockPath = `${path}.lock`; let lock;
 try { lock = await open(lockPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw new Error('HISTORY_INDEX_BUSY'); throw error; }
 try { const previousIndex = await loadHistoryIndex(path); const index = buildHistoryIndex({ ...options, previousIndex }); await saveHistoryIndex(path, index); return index; }
 finally { await lock.close(); await unlink(lockPath); }
}
