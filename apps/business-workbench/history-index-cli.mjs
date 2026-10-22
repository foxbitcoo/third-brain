#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDocumentPolicy, readDocumentIntake } from './document-intake.mjs';
import { isTrustedListeningSource } from './source-listening-policy.mjs';
import { buildHistoryIndex, loadHistoryIndex, saveHistoryIndex, updateHistoryIndex, retrieveHistory } from './history-index.mjs';

async function readRows(path) {
 if (!path) return [];
 const content = await readFile(path, 'utf8');
 let data; try { data = JSON.parse(content); } catch { data = content.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
 return Array.isArray(data) ? data : data.records || data.items || data.cases || (data.id || data.text ? [data] : []);
}
/** Explicit files only. This command never opens or writes the old formal database. */
export async function runHistoryCli(argv) {
 const args = {}; const flags = new Set(['documents','document-policy','source-map','corpus','legacy','cases','previous','out','output','policy','attention','query','case','limit']);
 for (let i = 0; i < argv.length; i += 2) { const key = argv[i]?.replace(/^--/, ''); if (!argv[i]?.startsWith('--') || !flags.has(key) || argv[i + 1] === undefined) throw new Error('INVALID_HISTORY_CLI_ARGUMENT'); args[key] = argv[i + 1]; }
 const out = args.out || args.output;
 if (!out && !args.previous) throw new Error('HISTORY_INDEX_PATH_REQUIRED');
 const policyPath = args.policy || args.attention;
 const attention = policyPath ? JSON.parse(await readFile(policyPath, 'utf8')) : null;
 const excludedSourceIds = attention ? attention.sources.filter(s => s.status === 'excluded').map(s => s.id) : [];
 const allowedSourceIds = attention ? attention.sources.filter(isTrustedListeningSource).map(s => s.id) : undefined;
 const blockedLocatorHashes = (process.env.LIVE_QA_BLOCKED_LOCATOR_HASHES || '').split(',').filter(Boolean);
 const [corpusRecords, legacyRecords, cases] = await Promise.all([readRows(args.corpus), readRows(args.legacy), readRows(args.cases)]);
 const documentPolicy = await loadDocumentPolicy(args['document-policy']);
 const intake = args.documents ? await readDocumentIntake(args.documents, { documentPolicy, allowedSourceIds, excludedSourceIds }) : null;
 if (intake) corpusRecords.push(...intake.records);
 const sourceMap = args['source-map'] ? JSON.parse(await readFile(args['source-map'], 'utf8')) : undefined;
 const options = { documentPolicy, sourceMap, corpusRecords, legacyRecords, cases, excludedSourceIds, allowedSourceIds, blockedLocatorHashes };
 let index;
 if (out && (!args.previous || resolve(out) === resolve(args.previous))) index = await updateHistoryIndex(out, options);
 else { const previousIndex = await loadHistoryIndex(args.previous); if (!previousIndex) throw new Error('HISTORY_INDEX_NOT_FOUND'); index = out ? buildHistoryIndex({ ...options, previousIndex }) : previousIndex; if (out) await saveHistoryIndex(out, index); }
 return args.query !== undefined ? retrieveHistory(index, { question: args.query, case_id: args.case, limit: args.limit === undefined ? 32 : Number(args.limit), excludedSourceIds, allowedSourceIds, blockedLocatorHashes, documentPolicy }) : { ...(intake ? { document_intake: intake.receipt } : {}), status: 'VERIFIED', version: index.version, scope: index.scope, ingestion: index.ingestion };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try { process.stdout.write(`${JSON.stringify(await runHistoryCli(process.argv.slice(2)), null, 2)}\n`); }
 catch (error) { process.stderr.write(`${/^[A-Z_]+$/.test(error.message) ? error.message : 'HISTORY_INDEX_FAILED'}\n`); process.exitCode = 1; }
}
