import frozenFixture from './frozen-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDocumentIntake, documentSourceId, DOCUMENT_POLICY_VERSION } from '../document-intake.mjs';
import { buildHistoryIndex, retrieveHistory, linkHistoryDocuments, historySourceId } from '../history-index.mjs';
import { buildEvidenceContext, applySourcePolicyFence, providerConfiguration } from '../live-qa.mjs';
import { runHistoryCli } from '../history-index-cli.mjs';
import { accumulateRefreshHistory } from '../history-refresh.mjs';
import { startWorkbenchServer, parseArgs } from '../server.mjs';

const policy = (status = 'allowed') => ({ version: DOCUMENT_POLICY_VERSION, documents: [{ documentId: 'file-one', status, url: 'https://docs.example/doc-one' }] });
async function fixture(t, body = '# HTML 方案\nHTML 移动端七月决策。\n\n## 八月上线\nHTML 移动端八月验收通过。\n') {
 const dir = await mkdtemp(join(tmpdir(), 'document-intake-'));
 t.after(() => rm(dir, { recursive: true, force: true }));
 const manifest = join(dir, 'admitted.json'), bodyPath = join(dir, 'body.md');
 const doc = { documentId: 'file-one', title: 'HTML 移动端方案', url: policy().documents[0].url, bodyPath: 'body.md',
  contentHash: createHash('sha256').update(body).digest('hex'), decision: 'admit', sourceModifiedAt: '2026-10-15T10:00:00Z',
  businessDateOrRange: '七月至八月，年份不明', role: 'decision', limits: ['日期不完整'], sections: [] };
 await writeFile(bodyPath, body); await writeFile(manifest, JSON.stringify([doc]));
 const intake = await readDocumentIntake(manifest, { documentPolicy: policy() });
 return { dir, manifest, doc, body, bodyPath, intake };
}

test('full body survives chunking and repeated index normalization with version and date provenance', async t => {
 const body = `# HTML 方案\n${'HTML 移动端设计说明。'.repeat(1400)}\n## 最后决定\n上线日期待确认。\n`;
 const { intake, doc } = await fixture(t, body);
 assert.equal(intake.records.map(r => r.text).join(''), body);
 assert.ok(intake.records.every(r => r.text.length <= 6000));
 const index = buildHistoryIndex({ corpusRecords: intake.records, documentPolicy: policy() });
 const rerun = buildHistoryIndex({ previousIndex: index, corpusRecords: intake.records, documentPolicy: policy() });
 assert.equal(rerun.records.length, index.records.length);
 const found = retrieveHistory(rerun, { question: '上线日期', allowedSourceIds: [], documentPolicy: policy() });
 assert.equal(found.evidence.length, 1);
 const row = found.evidence[0];
 assert.equal(row.occurred_at, null);
 assert.equal(row.source_modified_at, new Date(doc.sourceModifiedAt).toISOString());
 assert.equal(row.content_hash, doc.contentHash);
 assert.equal(row.document_id, doc.documentId);
 assert.equal(row.business_date_or_range, doc.businessDateOrRange);
 assert.equal(JSON.parse(row.locator).contentHash, doc.contentHash);
 const linked = linkHistoryDocuments(rerun, [{ documentId: 'file-one', caseIds: ['html'] }], { documentPolicy: policy() });
 assert.equal(linked.case_links.filter(l => l.case_id === 'html').length, index.records.length);
 const context = buildEvidenceContext({ cases: [{ id: 'html', evidence: [] }] }, { question: '上线日期', facts: [], case_id: 'html' }, { historyIndex: linked, allowedSourceIds: new Set(), documentPolicy: policy() });
 assert.equal(context.sources[0].content_hash, doc.contentHash);
 assert.equal(JSON.parse(context.sources[0].locator).contentHash, doc.contentHash);
});

test('missing document consent never inherits IM allowlist, and document consent never opens IM', async t => {
 const { intake } = await fixture(t);
 const im = { source_type: 'im', text: 'HTML 群聊验收', source_title: '群聊', locator: JSON.stringify({ platform: 'wps', sourceType: 'chat', sourceRef: 'group-one', itemRef: 'im-one' }) };
 const index = buildHistoryIndex({ corpusRecords: [...intake.records, im], documentPolicy: policy() });
 const query = { question: 'HTML', allowedSourceIds: [historySourceId('group-one')] };
 assert.ok(retrieveHistory(index, query).evidence.every(r => r.source_type === 'im'));
 const docOnly = retrieveHistory(index, { question: 'HTML', allowedSourceIds: [], documentPolicy: policy() });
 assert.equal(docOnly.evidence.length, intake.records.length);
 for (const status of ['excluded', 'revoked', 'paused']) assert.equal(retrieveHistory(index, { question: 'HTML', allowedSourceIds: [], documentPolicy: policy(status) }).evidence.length, 0);
 assert.equal((await readDocumentIntake((await fixture(t)).manifest)).records.length, 0);
});

test('hash mismatch aborts before index write and new versions stay citable without false conflict', async t => {
 const { dir, manifest, bodyPath, doc, intake } = await fixture(t);
 const old = buildHistoryIndex({ corpusRecords: intake.records, documentPolicy: policy() });
 const nextBody = '# HTML 方案\nHTML 移动端验收结论修订。\n';
 await writeFile(bodyPath, nextBody);
 const out = join(dir, 'index.json');
 await assert.rejects(runHistoryCli(['--documents', manifest, '--out', out, '--document-policy', await (async () => { const p = join(dir, 'policy.json'); await writeFile(p, JSON.stringify(policy())); return p; })()]), /DOCUMENT_CONTENT_HASH_MISMATCH/);
 await assert.rejects(readFile(out), { code: 'ENOENT' });
 doc.contentHash = createHash('sha256').update(nextBody).digest('hex'); await writeFile(manifest, JSON.stringify([doc]));
 const next = await readDocumentIntake(manifest, { documentPolicy: policy() });
 const merged = buildHistoryIndex({ previousIndex: old, corpusRecords: next.records, documentPolicy: policy() });
 assert.equal(merged.scope.document_count, 1);
 assert.equal(merged.scope.document_version_count, 2);
 assert.ok(merged.records.every(r => !r.conflict));
 assert.ok(retrieveHistory(merged, { question: 'HTML', documentPolicy: policy() }).evidence.some(r => r.content_hash === doc.contentHash));
});

test('canonical document dependency fences IM forwards and a joint answer when document is revoked', async t => {
 const { intake } = await fixture(t);
 const im = { source_type: 'im', text: `HTML 方案请看 ${policy().documents[0].url}`, source_title: '群聊', locator: JSON.stringify({ platform: 'wps', sourceType: 'chat', sourceRef: 'group-one', itemRef: 'im-forward' }) };
 const index = buildHistoryIndex({ corpusRecords: [...intake.records, im], documentPolicy: policy() });
 const options = { allowedSourceIds: new Set([historySourceId('group-one')]), documentPolicy: policy() };
 const forward = index.records.find(r => r.source_type === 'im');
 assert.equal(forward.canonical_document_id, 'file-one');
 assert.ok(forward.source_ids.includes(documentSourceId('file-one')));
 assert.equal(retrieveHistory(index, { question: 'HTML', ...options, documentPolicy: policy('revoked') }).evidence.length, 0);
 const context = buildEvidenceContext({ cases: [{ id: 'html', evidence: [] }] }, { question: 'HTML', facts: [] }, { ...options, historyIndex: index });
 const result = applySourcePolicyFence({ sources: context.sources, scope: {}, answers: [{ status: 'ok', answer: { summary: '联合结论' } }], policy_sources: [...context.sources, ...context.policyScopeSources] }, new Set(), options.allowedSourceIds, policy('revoked'));
 assert.deepEqual(result.sources, []);
 assert.equal(result.answers[0].answer, null);
 assert.equal(result.answers[0].error.code, 'SOURCE_POLICY_CHANGED');
});

test('explicit CLI import and subsequent user-triggered refresh reuse the same independent consent', async t => {
 const { dir, manifest, intake } = await fixture(t);
 const documentPolicyPath = join(dir, 'document-policy.json'), policyPath = join(dir, 'attention.json'), historyIndexPath = join(dir, 'index.json');
 await writeFile(documentPolicyPath, JSON.stringify(policy())); await writeFile(policyPath, JSON.stringify({ version: 1, sources: [] }));
 const args = ['--documents', manifest, '--document-policy', documentPolicyPath, '--policy', policyPath, '--out', historyIndexPath];
 const first = await runHistoryCli(args), again = await runHistoryCli(args);
 assert.equal(first.document_intake.document_count, 1);
 assert.equal(first.scope.retained_record_count, again.scope.retained_record_count);
 const receipt = await accumulateRefreshHistory({ config: { documentManifestPath: manifest, documentPolicyPath, policyPath, historyIndexPath }, evidence: [], output: dir, now: '2026-10-15T00:00:00Z' });
 assert.equal(receipt.retained_record_count, intake.records.length);
 await writeFile(documentPolicyPath, JSON.stringify(policy('revoked')));
 const blocked = await runHistoryCli([...args, '--query', 'HTML']);
 assert.equal(blocked.evidence.length, 0);
 assert.equal(JSON.parse(await readFile(historyIndexPath, 'utf8')).records.length, intake.records.length);
});

test('server rereads document consent for scope, card derivatives and in-flight answer delivery', { timeout: 5000 }, async t => {
 const { dir, intake } = await fixture(t);
 const dataset = structuredClone(frozenFixture);
 dataset.cases = [{ ...dataset.cases[0], evidence: intake.records.map((r, i) => ({ ...r, id: `doc-${i}` })), runs: [] }];
 const dataPath = join(dir, 'dataset.json'), historyPath = join(dir, 'index.json'), documentPolicyPath = join(dir, 'policy.json');
 await writeFile(dataPath, JSON.stringify(dataset)); await writeFile(historyPath, JSON.stringify(buildHistoryIndex({ corpusRecords: intake.records, cases: dataset.cases, documentPolicy: policy() }))); await writeFile(documentPolicyPath, JSON.stringify(policy()));
 assert.equal(parseArgs(['--document-policy', documentPolicyPath]).documentPolicyPath, documentPolicyPath);
 let entered, release; const start = new Promise(r => entered = r), gate = new Promise(r => release = r);
 const server = await startWorkbenchServer({ port: 0, dataPath, historyPath, documentPolicyPath, liveQaProviders: providerConfiguration({ LIVE_QA_DOUBAO_API_KEY: 'synthetic-fixture-key' }), liveQaFetch: async () => {
  entered(); await gate; return new Response(JSON.stringify({ model: providerConfiguration({})[0].model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: '验收通过', claims: [{ text: '验收通过', source_ids: ['S001'] }], uncertainties: [] }) } }] }));
 } });
 t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
 const url = `http://127.0.0.1:${server.address().port}`;
 const scope = await (await fetch(`${url}/api/ask-scope`)).json(); assert.equal(scope.document_count, 1, JSON.stringify(scope));
 const pending = fetch(`${url}/api/ask`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'HTML' }) });
 await start; await writeFile(documentPolicyPath, JSON.stringify(policy('revoked'))); release();
 const answer = await (await pending).json();
 assert.deepEqual(answer.sources, []);
 assert.equal(answer.answers[0].error.code, 'SOURCE_POLICY_CHANGED');
 assert.deepEqual((await (await fetch(`${url}/api/dataset`)).json()).dataset.cases, []);
});

test('day-only dates stay uncertain and excluded sections never displace historical or draft evidence', async t => {
 const { manifest, doc } = await fixture(t, '# 旧方案\nHTML 历史目标。\n## 模板\nHTML 模板待填写。\n## 决定\nHTML 小步验收。\n');
 doc.businessDateOrRange = '2026-07-03';
 doc.sections = [{ id: 'old', title: '旧方案', status: 'HISTORICAL', dateHint: '2026-07-03' }, { id: 'template', title: '模板', status: 'TEMPLATE' }, { id: 'decision', title: '决定', status: 'DRAFT' }];
 await writeFile(manifest, JSON.stringify([doc]));
 const intake = await readDocumentIntake(manifest, { documentPolicy: policy() });
 assert.equal(intake.records.length, 2);
 assert.deepEqual(intake.records.map(r => r.section_status), ['HISTORICAL', 'DRAFT']);
 assert.ok(intake.records.every(r => r.occurred_at === null && r.date_precision === 'day'));
 assert.ok(intake.records.every(r => r.business_date_or_range === '2026-07-03'));
 assert.ok(intake.records.every(r => !r.text.includes('模板')));
});


test('manifest cannot read outside its local intake directory or open non-regular body inputs', async t => {
 const { manifest, dir, doc } = await fixture(t);
 const outside = await mkdtemp(join(tmpdir(), 'document-outside-'));
 t.after(() => rm(outside, { recursive: true, force: true }));
 await writeFile(join(outside, 'private.txt'), 'must-not-read');
 doc.bodyPath = join(outside, 'private.txt'); await writeFile(manifest, JSON.stringify([doc]));
 await assert.rejects(readDocumentIntake(manifest, { documentPolicy: policy() }), /DOCUMENT_PATH_NOT_ALLOWED/);
 await symlink(join(outside, 'private.txt'), join(dir, 'escaped.md'));
 doc.bodyPath = 'escaped.md'; await writeFile(manifest, JSON.stringify([doc]));
 await assert.rejects(readDocumentIntake(manifest, { documentPolicy: policy() }), /DOCUMENT_PATH_NOT_ALLOWED/);
 await mkdir(join(dir, 'directory')); doc.bodyPath = 'directory'; await writeFile(manifest, JSON.stringify([doc]));
 await assert.rejects(readDocumentIntake(manifest, { documentPolicy: policy() }), /DOCUMENT_FILE_REQUIRED/);
});

const legacyPolicy = () => ({ version: DOCUMENT_POLICY_VERSION, documents: [{ documentId: 'file-one', status: 'allowed', kind: 'legacy_report', requiresParentSourceId: historySourceId('report-parent') }] });

test('legacy reports and future revisions inherit their configured parent even when source rows omit it', async t => {
 const { intake } = await fixture(t);
 const parent = historySourceId('report-parent');
 const row = { ...intake.records[0], source_ids: [documentSourceId('file-one')] };
 const future = { ...row, text: 'HTML 次日新报告验收。', locator: JSON.stringify({ platform: 'wps', sourceType: 'document', sourceRef: 'file-one', itemRef: 'next-revision' }) };
 const documentPolicy = legacyPolicy();
 const options = { documentPolicy, allowedSourceIds: [parent] };
 const index = buildHistoryIndex({ corpusRecords: [row, future], ...options });
 assert.ok(index.records.every(r => r.source_ids.includes(parent)));
 assert.equal(retrieveHistory(index, { question: 'HTML', ...options }).evidence.length, 2);
 assert.equal(retrieveHistory(index, { question: 'HTML', documentPolicy }).evidence.length, 0);
 assert.equal(retrieveHistory(index, { question: 'HTML', documentPolicy, allowedSourceIds: ['other-parent'] }).evidence.length, 0);
 const missingParent = { ...index, records: index.records.map(r => ({ ...r, source_ids: [documentSourceId('file-one')] })) };
 assert.equal(retrieveHistory(missingParent, { question: 'HTML', ...options }).evidence.length, 2);
 assert.equal(retrieveHistory(missingParent, { question: 'HTML', ...options, excludedSourceIds: [parent] }).evidence.length, 0);
 const context = buildEvidenceContext({ cases: [{ id: 'html', evidence: [] }] }, { question: 'HTML', facts: [] }, { ...options, allowedSourceIds: new Set([parent]), historyIndex: missingParent });
 assert.ok(context.sources.every(r => r.source_ids.includes(parent)));
 const response = { sources: context.sources, scope: {}, policy_sources: [...context.sources, ...context.policyScopeSources], answers: [{ status: 'ok', answer: { summary: '联合报告结论' } }] };
 assert.deepEqual(applySourcePolicyFence(response, new Set(), new Set(), documentPolicy).sources, []);
 assert.deepEqual(applySourcePolicyFence(response, new Set([parent]), new Set([parent]), documentPolicy).sources, []);
});

test('legacy parent consent is reread for cards, scope and an answer already in flight', { timeout: 5000 }, async t => {
 const { dir, intake } = await fixture(t);
 const documentPolicy = legacyPolicy(), parent = historySourceId('report-parent');
 const dataset = structuredClone(frozenFixture);
 dataset.cases = [{ ...dataset.cases[0], evidence: intake.records.map((r, i) => ({ ...r, id: `legacy-${i}`, source_ids: [documentSourceId('file-one')] })), runs: [] }];
 const dataPath = join(dir, 'dataset.json'), historyPath = join(dir, 'index.json'), documentPolicyPath = join(dir, 'document-policy.json'), attentionPath = join(dir, 'attention.json');
 const attention = status => ({ version: 1, sources: [{ id: parent, status, tier: 'normal', manualOverride: true, matchedWorklines: [] }] });
 await writeFile(dataPath, JSON.stringify(dataset)); await writeFile(historyPath, JSON.stringify(buildHistoryIndex({ corpusRecords: dataset.cases[0].evidence, documentPolicy, allowedSourceIds: [parent] })));
 await writeFile(documentPolicyPath, JSON.stringify(documentPolicy)); await writeFile(attentionPath, JSON.stringify(attention('active')));
 let entered, release; const start = new Promise(r => entered = r), gate = new Promise(r => release = r);
 const server = await startWorkbenchServer({ port: 0, dataPath, historyPath, attentionPath, documentPolicyPath, liveQaProviders: providerConfiguration({ LIVE_QA_DOUBAO_API_KEY: 'synthetic-fixture-key' }), liveQaFetch: async () => {
  entered(); await gate; return new Response(JSON.stringify({ model: providerConfiguration({})[0].model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: 'HTML报告联合结论', claims: [{ text: 'HTML报告联合结论', source_ids: ['S001'] }], uncertainties: [] }) } }] }));
 } });
 t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
 const url = `http://127.0.0.1:${server.address().port}`;
 assert.equal((await (await fetch(`${url}/api/dataset`)).json()).dataset.cases.length, 1);
 assert.equal((await (await fetch(`${url}/api/ask-scope`)).json()).document_count, 1);
 const pending = fetch(`${url}/api/ask`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'HTML' }) });
 await start; await writeFile(attentionPath, JSON.stringify(attention('excluded'))); release();
 const answer = await (await pending).json();
 assert.deepEqual(answer.sources, []);
 assert.equal(answer.answers[0].error.code, 'SOURCE_POLICY_CHANGED');
 for (const status of ['excluded', 'candidate']) {
  await writeFile(attentionPath, JSON.stringify(attention(status)));
  assert.deepEqual((await (await fetch(`${url}/api/dataset`)).json()).dataset.cases, []);
 }
 await writeFile(attentionPath, JSON.stringify({ version: 1, sources: [] }));
 assert.deepEqual((await (await fetch(`${url}/api/dataset`)).json()).dataset.cases, []);
 // Invalid paused/revoked IM-policy states also fail closed; this store currently defines active/candidate/excluded.
 for (const status of ['paused', 'revoked']) {
  await writeFile(attentionPath, JSON.stringify(attention(status)));
  const response = await fetch(`${url}/api/dataset`);
  assert.ok(response.status >= 400);
  assert.equal((await response.json()).dataset, undefined);
 }
});


test('the explicit manifest accepts this batch beyond 5 MiB and rejects files over its 32 MiB bound', async t => {
 const { manifest, doc } = await fixture(t);
 await writeFile(manifest, JSON.stringify([doc]) + ' '.repeat(5 * 1024 * 1024));
 assert.equal((await readDocumentIntake(manifest, { documentPolicy: policy() })).receipt.document_count, 1);
 await truncate(manifest, 32 * 1024 * 1024 + 1);
 await assert.rejects(readDocumentIntake(manifest, { documentPolicy: policy() }), /DOCUMENT_FILE_TOO_LARGE/);
});
