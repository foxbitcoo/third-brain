import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeHistory, mergeHistory, buildHistoryIndex, retrieveHistory, validateHistoryIndex, historySourceId,
 loadHistoryIndex, saveHistoryIndex, updateHistoryIndex, sanitizeHistoryText, PERMANENT_BLOCKED_LOCATOR_HASHES } from '../history-index.mjs';
import { runHistoryCli } from '../history-index-cli.mjs';
import { buildAskScope } from '../live-qa.mjs';

const locator = (sourceRef = 'alpha', itemRef = 'one') => JSON.stringify({ platform: 'wps', sourceType: 'chat', sourceRef, itemRef });
const message = (id, text, source = 'alpha', occurredAt = '2026-07-01T09:00:00+08:00') => ({
 id: `collector-${id}`, sourceKey: `wps:chat:${source}`, sourceName: `${source}工作群`, sender: '测试同事', occurredAt,
 sourceLocator: locator(source, id), text, raw: { id, chat_id: source, ctime: 1782867600, content: text, cookie: 'must-not-copy-raw' },
});
const evidence = (id, text, source = 'alpha') => ({ id: 'card-local-id', source_type: 'im', source_title: `${source}工作群`,
 speaker: '测试同事', occurred_at: '2026-07-01T09:00:00+08:00', locator: locator(source, id), text });
const workline = { id: 'html', title: 'HTML 移动端灰度上线', question: 'HTML 移动端灰度上线进展', scope: '移动端HTML灰度范围', evidence: [evidence('one', 'HTML 移动端灰度预计七月启动')] };

test('native identity merges current corpus, formal historical exports and local card IDs without losing aliases', () => {
 const rows = normalizeHistory([message('one', 'HTML 移动端灰度预计七月启动'),
  { ...evidence('one', 'HTML  移动端灰度预计七月启动'), source_ids: ['legacy-alias'] }]);
 assert.equal(rows.length, 1);
 assert.ok(rows[0].source_ids.includes('alpha'));
 assert.ok(rows[0].source_ids.includes(historySourceId('alpha')));
 assert.ok(rows[0].source_ids.includes('legacy-alias'));
 assert.equal(rows[0].occurred_at, '2026-07-01T01:00:00.000Z');
 assert.equal(JSON.stringify(rows).includes('must-not-copy-raw'), false);
});

test('same native item changed text, speaker or date remains independently citable as conflicts', () => {
 const original = message('one', 'HTML 七月启动');
 const rows = mergeHistory([original], [original, { ...original, text: 'HTML 八月启动' }, { ...original, sender: '另一人' }, { ...original, occurredAt: '2026-08-01T09:00:00+08:00' }]);
 assert.equal(rows.length, 4);
 assert.equal(new Set(rows.map(r => r.native_id)).size, 1);
 assert.equal(new Set(rows.map(r => r.id)).size, 4);
 assert.ok(rows.every(r => r.conflict && r.revision_count === 4));
});

test('identical text from different native messages is retained; document locators cannot merge separate sources', () => {
 const rows = normalizeHistory([message('one', '相同转述'), message('two', '相同转述'),
  { source_type: 'document', source_title: '方案甲', locator: '第1节', text: '内容' },
  { source_type: 'document', source_title: '方案乙', locator: '第1节', text: '内容' }]);
 assert.equal(rows.length, 4);
 assert.equal(new Set(rows.map(r => r.native_id)).size, 4);
});

test('cumulative rebuild retains old corpus, revisions and durable membership when current cards omit historical evidence', () => {
 const old = buildHistoryIndex({ corpusRecords: [message('old', 'HTML 移动端灰度六月已有试点')], cases: [workline] });
 const fresh = buildHistoryIndex({ previousIndex: old, corpusRecords: [message('new', 'HTML 移动端灰度十月验收', 'beta', '2026-10-12T09:00:00+08:00')], cases: [] });
 assert.equal(fresh.records.length, 3);
 assert.ok(fresh.records.find(r => r.text.includes('六月')).inferred_case_ids.includes('html'));
 assert.ok(fresh.records.find(r => r.text.includes('七月')).explicit_case_ids.includes('html'));
 assert.equal(fresh.scope.earliest_at, '2026-07-01T01:00:00.000Z');
 assert.equal(fresh.scope.latest_at, '2026-10-12T01:00:00.000Z');
 assert.equal(fresh.scope.coverage, 'retained_local_evidence_only');
 assert.equal(fresh.scope.complete, false);
});

test('cross-group relevant messages link conservatively; same group alone cannot attribute an unrelated event', () => {
 const index = buildHistoryIndex({ cases: [workline], corpusRecords: [
  message('cross', 'HTML 移动端灰度已经开始扩大范围', 'beta'),
  message('unrelated', 'OpenViking 开源试验仍在准备', 'alpha'),
  message('other', '全员活动合影请确认', 'beta'),
 ] });
 assert.ok(index.records.find(r => r.text.includes('扩大')).inferred_case_ids.includes('html'));
 assert.equal(index.records.find(r => r.text.includes('OpenViking')).inferred_case_ids.length, 0);
 assert.equal(index.records.find(r => r.text.includes('合影')).inferred_case_ids.length, 0);
 assert.equal(index.records.length, 4);
 const result = retrieveHistory(index, { question: 'HTML 移动端灰度上线进展', case_id: 'html' });
 assert.equal(result.evidence.length, 2);
 assert.ok(result.evidence.every(r => !r.text.includes('OpenViking')));
 assert.ok(result.evidence.some(r => r.link_basis === 'explicit_evidence'));
 assert.ok(result.evidence.some(r => r.link_basis === 'inferred_related'));
});

test('bounded relevant retrieval mixes old and latest evidence deterministically and avoids corpus stuffing', () => {
 const corpusRecords = Array.from({ length: 22 }, (_, i) => message(`m${i}`, `HTML 移动端灰度阶段 ${i}`, i % 2 ? 'alpha' : 'beta', `2026-${i < 11 ? '07' : '10'}-${String(i % 11 + 1).padStart(2, '0')}T09:00:00+08:00`));
 corpusRecords.push(message('noise', '午餐有苹果香蕉', 'alpha'));
 const index = buildHistoryIndex({ cases: [workline], corpusRecords });
 const options = { question: 'HTML 移动端灰度', case_id: 'html', limit: 5 };
 const result = retrieveHistory(index, options);
 assert.equal(result.evidence.length, 5);
 assert.equal(result.scope.truncated, true);
 assert.ok(result.evidence.some(r => r.occurred_at.startsWith('2026-07')));
 assert.ok(result.evidence.some(r => r.occurred_at.startsWith('2026-10')));
 assert.ok(result.evidence.every(r => !r.text.includes('午餐')));
 assert.deepEqual(retrieveHistory(index, options), result);
 assert.equal(retrieveHistory(index, { ...options, maxChars: 1 }).evidence.length, 0);
 assert.equal(retrieveHistory(index, { question: '从未提过的火星引擎' }).evidence.length, 0);
});

test('a focused question excludes unrelated messages even when both are explicit card evidence', () => {
 const index = buildHistoryIndex({ cases: [{ ...workline, evidence: [evidence('one', 'HTML 移动端灰度启动'), evidence('two', '计费密度预算仍待商定')] }] });
 const result = retrieveHistory(index, { question: '计费密度预算', case_id: 'html' });
 assert.equal(result.evidence.length, 1);
 assert.ok(result.evidence[0].text.includes('计费'));
});

test('retrieval policy reapplies active-source allowlist and deny aliases, and empty question returns scope only', () => {
 const index = buildHistoryIndex({ cases: [workline], corpusRecords: [message('new', 'HTML 移动端灰度十月验收', 'beta')] });
 const result = retrieveHistory(index, { question: '', case_id: 'html', allowedSourceIds: [historySourceId('alpha')] });
 assert.deepEqual(result.evidence, []);
 assert.equal(result.scope.retained_record_count, 1);
 assert.equal(result.scope.searched_record_count, 1);
 assert.deepEqual(result.scope.source_titles, ['alpha工作群']);
 assert.equal(result.scope.returned_record_count, 0);
 const blocked = retrieveHistory(index, { question: 'HTML', excludedSourceIds: ['alpha'], allowedSourceIds: [historySourceId('alpha')] });
 assert.equal(blocked.evidence.length, 0);
 assert.equal(blocked.scope.retained_record_count, 0);
 assert.equal(retrieveHistory(index, { question: 'HTML', allowedSourceIds: [] }).evidence.length, 0);
});

test('canonical locator denylist and permanent private digest reject records at build and forged index output boundaries', () => {
 const row = message('one', 'HTML 私有条目');
 const hash = createHash('sha256').update(JSON.stringify(['wps','alpha','one'])).digest('hex');
 assert.equal(buildHistoryIndex({ corpusRecords: [row], blockedLocatorHashes: [hash] }).records.length, 0);
 const index = buildHistoryIndex({ corpusRecords: [row] });
 assert.equal(retrieveHistory(index, { question: 'HTML', blockedLocatorHashes: [hash] }).evidence.length, 0);
 const forged = structuredClone(index);
 const permanent = PERMANENT_BLOCKED_LOCATOR_HASHES[0];
 forged.records[0].locator_hash = permanent;
 assert.equal(retrieveHistory(forged, { question: 'HTML' }).evidence.length, 0);
});

test('secrets, URLs and raw envelopes cannot escape store or response', () => {
 const secret = 'synthetic-runtime-credential';
 const index = buildHistoryIndex({ secrets: [secret], corpusRecords: [{ ...message('one', `HTML api_key=short-secret Bearer value ${secret}`), sourceName: `群 ${secret}`, sender: `同事 ${secret}`, url: 'https://example.invalid/?token=short-secret' }] });
 const serialized = JSON.stringify(index);
 for (const privateValue of [secret, 'short-secret', 'Bearer value', 'must-not-copy-raw']) assert.equal(serialized.includes(privateValue), false);
 assert.equal(index.records[0].url, null);
 const result = retrieveHistory(index, { question: 'HTML', secrets: [secret] });
 assert.ok(result.evidence[0].source_ids.includes(historySourceId('alpha')));
});

test('reject malformed stores and limits rather than silently downgrading', () => {
 assert.equal(validateHistoryIndex({ version: 'wrong', records: [] }), false);
 assert.throws(() => retrieveHistory({}, { question: 'HTML' }), /INVALID_HISTORY_INDEX/);
 const index = buildHistoryIndex();
 for (const limit of [0, 101, 1.5]) assert.throws(() => retrieveHistory(index, { limit }), /INVALID_HISTORY_QUERY_LIMIT/);
});

test('atomic persistent update preserves prior records, mode0600 and fails when another writer owns its lock', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'third-brain-history-')); const path = join(dir, 'index.json');
 try {
  await updateHistoryIndex(path, { corpusRecords: [message('one', 'HTML 旧记录')] });
  await updateHistoryIndex(path, { corpusRecords: [message('two', 'HTML 新记录')] });
  assert.equal((await loadHistoryIndex(path)).records.length, 2);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(`${path}.lock`, 'busy');
  await assert.rejects(updateHistoryIndex(path, { corpusRecords: [] }), /HISTORY_INDEX_BUSY/);
  assert.equal((await loadHistoryIndex(path)).records.length, 2);
  await assert.rejects(saveHistoryIndex(path, {}), /INVALID_HISTORY_INDEX/);
 } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI accepts explicit JSONL corpus and exported JSON formal history without touching the inputs', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'third-brain-history-cli-'));
 const corpus = join(dir, 'corpus.jsonl'), legacy = join(dir, 'legacy.json'), out = join(dir, 'index.json');
 try {
  await writeFile(corpus, JSON.stringify(message('one', 'HTML 七月方案')) + '\n');
  await writeFile(legacy, JSON.stringify([message('two', 'HTML 六月历史', 'beta')]));
  const before = await readFile(legacy, 'utf8');
  const receipt = await runHistoryCli(['--corpus',corpus,'--legacy',legacy,'--out',out]);
  assert.equal(receipt.status, 'VERIFIED'); assert.equal(receipt.scope.retained_record_count, 2);
  assert.equal(await readFile(legacy, 'utf8'), before);
  const result = await runHistoryCli(['--previous',out,'--query','HTML','--limit','1']);
  assert.equal(result.evidence.length, 1);
 } finally { await rm(dir, { recursive: true, force: true }); }
});

test('trusted participant map resolves sender objects and card aliases to one native participant identity', () => {
 const sourceMap = { participant_mapping: [{ alias: 'P01', platform_user_id: '123', verified_display_name: '同事甲', name_binding_status: 'PROVIDER_SENDER_OR_MENTION_IDENTITY' }], source_mapping: [{ alias: 'G01', platform_chat_id: 'alpha', verified_display_name: '正式群名', name_binding_status: 'PROVIDER_CHAT_DETAILS' }] };
 const row = message('one', 'HTML 移动端灰度七月启动'); row.sender = { id: '123', name: '', avatar: 'do-not-copy-avatar' };
 const card = { ...evidence('one', row.text), speaker: 'P01', source_title: 'G01' };
 const index = buildHistoryIndex({ corpusRecords: [row], cases: [{ ...workline, evidence: [card] }], sourceMap });
 assert.equal(index.records.length, 1);
 assert.equal(index.records[0].speaker, '同事甲');
 assert.equal(index.records[0].speaker_id, '123');
 assert.equal(index.records[0].source_title, '正式群名');
 const next = buildHistoryIndex({ previousIndex: index });
 assert.equal(next.records[0].id, index.records[0].id);
 assert.equal(JSON.stringify(next).includes('do-not-copy-avatar'), false);
 const unknown = normalizeHistory([{ ...row, sender: { id: 'unknown-id', name: '' } }]);
 assert.equal(unknown[0].speaker, '发言人未核实');
 assert.equal(unknown[0].speaker_id, 'unknown-id');
});

test('generic progress query returns a bounded diversified subset and durable coverage notes', () => {
 const second = { id: 'billing', title: '智点计费', evidence: [evidence('billing-one', '智点计费预算仍待确认', 'billing')] };
 const index = buildHistoryIndex({ cases: [workline, second], corpusRecords: [message('noise', '无关午餐', 'alpha')], coverage_gaps: ['七月摘要缺少原生身份，未纳入事实检索'] });
 const result = retrieveHistory(index, { question: '我最近在做啥', limit: 3 });
 assert.equal(result.evidence.length, 2);
 assert.ok(result.evidence.every(r => !r.text.includes('午餐')));
 assert.equal(result.scope.generic_query, true);
 assert.equal(result.scope.retrieval_subset, true);
 const next = buildHistoryIndex({ previousIndex: index });
 assert.deepEqual(retrieveHistory(next, { question: '' }).scope.coverage_gaps, ['七月摘要缺少原生身份，未纳入事实检索']);
});

test('nontext provider activities remain accounted for but never become factual query evidence', () => {
 const index = buildHistoryIndex({ corpusRecords: [message('empty', ''), message('text', 'HTML 范围确认')] });
 assert.equal(index.records.length, 2);
 assert.equal(index.scope.unique_message_count, 2);
 assert.equal(index.scope.nontext_record_count, 1);
 const result = retrieveHistory(index, { question: 'HTML' });
 assert.equal(result.scope.retained_unique_message_count, 2);
 assert.equal(result.scope.retained_version_count, 2);
 assert.equal(result.evidence.length, 1);
});

test('current native primary source identity retains trusted legacy policy aliases and deny overrides allow', () => {
 const sourceMap = { source_mapping: [{ platform_chat_id: 'alpha', source_key: 'legacy-listening-source', verified_display_name: '工作群' }] };
 const index = buildHistoryIndex({ corpusRecords: [message('one', 'HTML 范围确认')], sourceMap });
 assert.equal(index.records[0].source_id, historySourceId('alpha'));
 assert.ok(index.records[0].source_ids.includes('legacy-listening-source'));
 assert.equal(retrieveHistory(index, { question: 'HTML', allowedSourceIds: ['legacy-listening-source'] }).evidence.length, 1);
 assert.equal(retrieveHistory(index, { question: 'HTML', allowedSourceIds: ['legacy-listening-source'], excludedSourceIds: [historySourceId('alpha')] }).evidence.length, 0);
});

test('the same month question works for Chinese/numeric month forms and numeric version terms', () => {
 const index = buildHistoryIndex({ cases: [workline], corpusRecords: [
  message('aug', 'HTML 版本0.2验收完成', 'alpha', '2026-08-12T09:00:00+08:00'),
  message('sep', 'HTML 版本0.3验收完成', 'alpha', '2026-09-12T09:00:00+08:00'),
 ] });
 for (const month of ['8月', '八月']) {
  const result = retrieveHistory(index, { question: `${month}HTML进展`, case_id: 'html' });
  assert.equal(result.evidence.length, 1); assert.ok(result.evidence[0].text.includes('0.2'));
 }
 assert.ok(retrieveHistory(index, { question: '9月HTML进展', case_id: 'html' }).evidence[0].text.includes('0.3'));
 assert.ok(retrieveHistory(index, { question: '版本0.2', case_id: 'html' }).evidence.every(r => r.text.includes('0.2')));
 const result = retrieveHistory(index, { question: '八月做了什么', case_id: 'html' });
 assert.equal(result.evidence.length, 1); assert.deepEqual(result.scope.requested_months, [8]);
});

test('source exclusion quarantines private historical records without erasing them across refresh and restore', () => {
 const first = buildHistoryIndex({ cases: [workline], corpusRecords: [message('one', 'HTML 移动端灰度预计七月启动')] });
 const banned = buildHistoryIndex({ previousIndex: first, excludedSourceIds: ['alpha'], corpusRecords: [message('new', 'HTML 移动端灰度十月验收')] });
 assert.equal(banned.records.length, 2);
 assert.equal(retrieveHistory(banned, { question: 'HTML', excludedSourceIds: ['alpha'] }).evidence.length, 0);
 assert.equal(retrieveHistory(banned, { question: 'HTML', allowedSourceIds: [historySourceId('alpha')] }).evidence.length, 2);
});

test('native source ref wins over conflicting display aliases when applying the trusted source map', () => {
 const sourceMap = { source_mapping: [{ alias: 'G01', platform_chat_id: 'alpha', source_key: 'trusted-alpha-policy', verified_display_name: '甲群' }] };
 const row = { ...message('one', 'HTML 乙群事实', 'beta'), sourceName: 'G01' };
 const index = buildHistoryIndex({ corpusRecords: [row], sourceMap });
 assert.equal(index.records[0].source_title, 'G01');
 assert.equal(index.records[0].source_ids.includes('trusted-alpha-policy'), false);
 assert.equal(retrieveHistory(index, { question: 'HTML', allowedSourceIds: ['trusted-alpha-policy'] }).evidence.length, 0);
});

test('month follow-up preserves the requested anchor and later completion; explicit intervals include intermediate months', () => {
 const index = buildHistoryIndex({ cases: [workline], corpusRecords: [
  message('aug', 'HTML 八月继续测试', 'alpha', '2026-08-12T09:00:00+08:00'),
  message('sep', 'HTML 九月扩大范围', 'alpha', '2026-09-12T09:00:00+08:00'),
  message('oct', 'HTML 十月正式完成', 'alpha', '2026-10-12T09:00:00+08:00'),
 ] });
 const follow = retrieveHistory(index, { question: '7月HTML上线承诺后来完成了吗', case_id: 'html' });
 assert.ok(follow.evidence.some(r => r.occurred_at.startsWith('2026-07')));
 assert.ok(follow.evidence.some(r => r.occurred_at.startsWith('2026-10')));
 assert.equal(follow.scope.temporal_context, 'requested_months_and_later');
 const range = retrieveHistory(index, { question: '八月到十月HTML进展', case_id: 'html' });
 assert.deepEqual(range.scope.requested_months, [8, 9, 10]);
 assert.ok(range.evidence.some(r => r.occurred_at.startsWith('2026-09')));
 assert.equal(range.evidence.some(r => r.occurred_at.startsWith('2026-07')), false);
 const august = retrieveHistory(index, { question: '8月HTML进展', case_id: 'html' });
 assert.ok(august.evidence.every(r => r.occurred_at.startsWith('2026-08')));
});

test('scope policy dependencies include sources outside the selected case or retrieved sample', () => {
 const index = buildHistoryIndex({ cases: [workline], corpusRecords: [message('other', '无关已登记来源事实', 'beta')] });
 const result = retrieveHistory(index, { question: 'HTML', case_id: 'html' });
 assert.equal(result.evidence.some(r => r.source_ids.includes('beta')), false);
 assert.ok(result.policySources.some(r => r.source_ids.includes('beta')));
 assert.ok(result.policySources.every(r => Object.keys(r).length === 1 && Array.isArray(r.source_ids)));
});

test('CLI requires trusted listening eligibility even when a source is nominally active', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'third-brain-history-trust-'));
 const corpus = join(dir, 'corpus.json'), policy = join(dir, 'policy.json'), out = join(dir, 'index.json');
 try {
  await writeFile(corpus, JSON.stringify([message('one', 'HTML 原始消息')]));
  await writeFile(policy, JSON.stringify({ sources: [{ id: historySourceId('alpha'), status: 'active', decisionOrigin: 'keyword', matchedWorklines: [], evidenceRefs: [] }] }));
  const result = await runHistoryCli(['--corpus',corpus,'--out',out,'--policy',policy,'--query','HTML']);
  assert.equal(result.evidence.length, 0);
  assert.equal((await loadHistoryIndex(out)).records.length, 1);
 } finally { await rm(dir, { recursive: true, force: true }); }
});

test('long output instructions and OCR model headings cannot outrank a short actual business entity mention', () => {
 const noise = Array.from({ length: 45 }, (_, i) => message(`ocr-${i}`,
  `【图片正文 · SYNTH-${i} · AsterCore V4 Flash OCR · clear】\n验收图表：评测讨论变化按每个月各用一句话概括，总计200字以内，各引用一条最直接的原文，没有依据就明确说不知道。\n【识别边界】截图不能证明执行已完成。`,
  'alpha', `2026-${i % 2 ? '08' : '10'}-${String(i % 20 + 1).padStart(2, '0')}T09:00:00+08:00`));
 const direct = message('direct-entity', '先评测 AsterCore', 'beta', '2026-09-03T09:00:00+08:00');
 const index = buildHistoryIndex({ corpusRecords: [...noise, direct] });
 const short = 'AsterCore从8月到10月的评测讨论有什么变化？';
 const long = `${short}每个月各用一句话概括，总计200字以内，各引用一条最直接的原文；没有依据就明确说不知道。`;
 const result = retrieveHistory(index, { question: long, limit: 5 });
 assert.equal(result.evidence[0].text, direct.text);
 assert.deepEqual(result.evidence.map(r => r.id), retrieveHistory(index, { question: short, limit: 5 }).evidence.map(r => r.id));
 assert.deepEqual(result.scope.requested_months, [8, 9, 10]);
 assert.equal(retrieveHistory(index, { question: 'AsterCore' }).evidence.length, 1);
 const body = retrieveHistory(index, { question: '验收图表', limit: 1 }).evidence[0];
 assert.ok(body.text.includes('AsterCore V4 Flash OCR'));
 assert.ok(body.text.includes('验收图表'));
 assert.ok(body.text.includes('截图不能证明执行已完成'));
});


test('six reports sharing one parent remain six documents and keep new revisions separate in history and fallback scope', () => {
 const parent = historySourceId('shared-report-parent');
 const reports = Array.from({ length: 6 }, (_, i) => ({ source_type: 'document', source_id: parent, source_ids: [parent],
  source_title: '同一群内的报告', speaker: '报告正文', occurred_at: null, text: 'HTML 演示日报', content_hash: 'a'.repeat(64), revision: 'r1',
  locator: JSON.stringify({ platform: 'kdocs', sourceType: 'document', sourceRef: `report-${i}`, itemRef: 'body-r1' }) }));
 const next = { ...reports[0], content_hash: 'b'.repeat(64), revision: 'r2', text: 'HTML 演示日报后续版本',
  locator: JSON.stringify({ platform: 'kdocs', sourceType: 'document', sourceRef: 'report-0', itemRef: 'body-r2' }) };
 const documentPolicy = { version: 'document-source-policy-v1', documents: reports.map((_, i) => ({ documentId: `report-${i}`, status: 'allowed' })) };
 const index = buildHistoryIndex({ corpusRecords: [...reports, next], documentPolicy });
 assert.ok(index.records.every(r => r.source_id === parent));
 assert.equal(index.scope.source_count, 1, 'source grouping is unchanged');
 assert.equal(index.scope.document_count, 6);
 assert.equal(index.scope.document_chunk_count, 7);
 assert.equal(index.scope.document_version_count, 7);
 const searched = retrieveHistory(index, { question: '', documentPolicy }).scope;
 assert.equal(searched.document_count, 6);
 assert.equal(searched.document_version_count, 7);
 assert.equal(searched.source_count, 1);
 // Old card evidence can lack explicit document metadata; native locators still identify each report.
 const sources = index.records.map(({ document_id, canonical_document_id, ...row }) => row);
 const fallback = buildAskScope({ cases: [{ id: 'reports' }], as_of: '2026-10-15T00:00:00Z' }, {}, { sources });
 assert.equal(fallback.document_count, 6);
 assert.equal(fallback.document_chunk_count, 7);
 assert.equal(fallback.document_version_count, 7);
});

test('already redacted credential labels preserve following prose across normalize and repeated ingestion', () => {
 const text = 'Cookie是[已移除凭据]的需研发完成设置对接。还请大家标记：完成处理标注已处理， 进行中标注完成时间。';
 const row = { source_type: 'document', source_title: '交付纪要', speaker: '文档正文', text,
  locator: JSON.stringify({ platform: 'wps', sourceType: 'document', sourceRef: 'doc-safety', itemRef: 'section-one', revision: 'v1', sectionId: 's1' }) };
 const first = buildHistoryIndex({ corpusRecords: [row] });
 const second = buildHistoryIndex({ previousIndex: first, corpusRecords: [row] });
 assert.equal(first.records.length, 1);
 assert.equal(second.records.length, 1);
 assert.equal(first.records[0].text, text);
 assert.deepEqual(second.records.map(r => r.id), first.records.map(r => r.id));
 assert.deepEqual(normalizeHistory(first.records).map(r => r.id), first.records.map(r => r.id));
});

test('redaction guard remains idempotent while real assigned secrets stay removed', () => {
 for (const marker of ['[已移除凭据]', '[已移除疑似凭据]', '[已移除认证信息]']) {
  const text = `Cookie是${marker}的需研发对接；api_key=${marker}，需配置权限。`;
  assert.equal(sanitizeHistoryText(text), text);
 }
 const text = 'api_key=actualSensitive123456 Cookie是真实敏感内容12345，后续需确认。';
 const once = sanitizeHistoryText(text);
 assert.ok(!once.includes('actualSensitive123456'));
 assert.ok(!once.includes('真实敏感内容12345'));
 assert.equal(sanitizeHistoryText(once), once);
});
