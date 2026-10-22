#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareEvaluation } from './diagnostic-memory-evaluation.mjs';

const args = process.argv.slice(2);
function option(flag) { const index = args.indexOf(flag); return index === -1 ? null : args[index + 1]; }
const inputPath = option('--input');
if (!inputPath) { console.error('Usage: node diagnostic-memory-evaluation-cli.mjs --input PRIVATE_INPUT.json (dry-run only; live execution requires a programmatic authority wrapper)'); process.exit(2); }
try {
  // A standalone file cannot establish fresh source policy, hashes and memory status.
  // Use runMemoryEvaluation with a beforeDispatch guard that reads current authority.
  if (args.includes('--execute')) throw Object.assign(new Error('NOT_LIVE_AUTHORIZED'), { code: 'NOT_LIVE_AUTHORIZED' });
  const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  let memoryBlockBuilder;
  try { ({ buildMemorySystemBlock: memoryBlockBuilder } = await import('./diagnostic-memory.mjs')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  const plan = prepareEvaluation(input, { memoryBlockBuilder });
  console.log(JSON.stringify({ status: 'DRY_RUN', liveAuthorization: 'NOT_LIVE_AUTHORIZED', mode: plan.mode, runId: plan.runId, cases: plan.caseCount, calls: plan.callCount, estimatedUpperBoundCny: plan.estimatedUpperBoundCny, assumptions: plan.assumptions, arms: plan.arms.map(({ id, requestBytes, upperBoundCny, parityHash, systemHash, memoryHash, memoryInjection }) => ({ id, requestBytes, upperBoundCny, parityHash, systemHash, memoryHash, memoryInjection })) }, null, 2));
} catch (error) { console.error(JSON.stringify({ status: 'FAILED', error: /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code || '') ? error.code : 'EVALUATION_FAILED' })); process.exitCode = 1; }
