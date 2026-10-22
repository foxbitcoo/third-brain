import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { loadDocumentPolicy, readDocumentIntake } from './document-intake.mjs';
import { updateHistoryIndex } from './history-index.mjs';
import { loadAttention, isTrustedListeningSource } from './source-attention.mjs';

// A rolling discovery window is never the durable history boundary. Collection
// calls this before advancing source cursors; failed writes leave them unchanged.
export async function accumulateRefreshHistory({ config, evidence, output, now }) {
  if (!config.historyIndexPath) return { status: 'NOT_CONFIGURED' };
  if (!isAbsolute(config.historyIndexPath)) throw Error('HISTORY_PATH_MUST_BE_ABSOLUTE');
  let cases = [], sourceMap;
  if (config.previousDashboard) {
    const dataset = JSON.parse(await readFile(join(config.previousDashboard, 'answer-cards.json'), 'utf8'));
    if (!Array.isArray(dataset.cases)) throw Error('INVALID_HISTORY_CASES');
    cases = dataset.cases;
    try { sourceMap = JSON.parse(await readFile(join(config.previousDashboard, 'private-source-map.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const policy = await loadAttention(config.policyPath);
  const documentPolicy = await loadDocumentPolicy(config.documentPolicyPath);
  const intake = config.documentManifestPath ? await readDocumentIntake(config.documentManifestPath, { documentPolicy, allowedSourceIds: policy.sources.filter(isTrustedListeningSource).map(s => s.id), excludedSourceIds: policy.sources.filter(s => s.status !== 'active').map(s => s.id) }) : null;
  const result = await updateHistoryIndex(config.historyIndexPath, {
    corpusRecords: [...evidence, ...(intake?.records || [])], cases, sourceMap, documentPolicy,
    allowedSourceIds: policy.sources.filter(isTrustedListeningSource).map(s => s.id),
    excludedSourceIds: policy.sources.filter(s => s.status === 'excluded').map(s => s.id), now,
  });
  const index = result.index || result;
  const receipt = {
    status: 'VERIFIED', ...(intake ? { document_intake: intake.receipt } : {}), indexPath: config.historyIndexPath,
    retained_record_count: index.records.length, scope: index.scope, at: now,
    formalMemoryUpdated: false,
    boundary: '累计原始证据；主线关联待核验，未据此自动更新正式记忆',
  };
  await writeFile(join(output, 'history-accumulation.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  return receipt;
}
