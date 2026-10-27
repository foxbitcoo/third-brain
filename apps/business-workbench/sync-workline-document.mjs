// A private, explicitly authorized document mirrors a reviewed card. Collection
// alone never upgrades an old card or a failed document write to "up to date".
import {readFile, writeFile, rename, realpath, open, unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {resolve, relative, dirname, sep, isAbsolute} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {validateDataset} from './data.mjs';
import {validReadingGuide} from './reading-guide.mjs';
import {documentEvidenceAllowed, isDocumentEvidence} from './document-intake.mjs';
import {loadAttention, readPlan} from './source-attention.mjs';
import {isExcludedEvidence, sourceIdentities} from './live-qa.mjs';

const runFile = promisify(execFile);
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = async p => JSON.parse(await readFile(p, 'utf8'));
const digest = text => createHash('sha256').update(text).digest('hex');
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const plain = value => String(value).replace(/<[^>]*>/g, ' ').replace(/&(amp|lt|gt|quot|apos);/g, (_, c) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[c])).replace(/\s+/g, ' ').trim();
const outside = async path => {
 const actual = await realpath(path), rel = relative(checkout, actual);
 if (!(rel==='..' || rel.startsWith('..'+sep) || isAbsolute(rel))) throw Error('PRIVATE_SYNC_PATH_REQUIRED');
 return actual;
};
async function save(path, value) {
 const temporary = `${path}.${process.pid}.tmp`;
 await writeFile(temporary, JSON.stringify(value, null, 2)+'\n', {mode:0o600});
 await rename(temporary, path);
}

export function reviewedWorklineDocument({dataset, guide, caseId, documentPolicy, allowedSources, excludedSources=new Set(), minimumAsOf}) {
 if (!validateDataset(dataset).valid || !validReadingGuide(guide, dataset)) throw Error('INVALID_REVIEWED_CARD');
 const item = dataset.cases.find(c => c.id === caseId), card = guide.cases.find(c => c.case_id === caseId);
 const run = item?.runs.find(r => r.id === card?.run_id);
 if (!run || run.audit?.review_status !== 'REVIEWED' || run.audit?.citations !== 'valid') throw Error('WORKLINE_REVIEW_REQUIRED');
 const cutoff=run.provenance?.input_cutoff;
 if (!Number.isFinite(Date.parse(cutoff)) || Date.parse(cutoff)!==Date.parse(item.as_of) || minimumAsOf && (!Number.isFinite(Date.parse(minimumAsOf)) || Date.parse(cutoff) < Date.parse(minimumAsOf))) throw Error('WORKLINE_REVIEW_REQUIRED');
 const ids = [...new Set(['current','follow_up','confirm','boundary'].flatMap(k => card[k].evidence_ids))];
 const evidence = ids.map(id => item.evidence.find(e => e.id === id));
 const inputIds=run.provenance?.input_evidence_ids;
 if(!Array.isArray(inputIds) || !inputIds.length || new Set(inputIds).size!==inputIds.length || ids.some(id=>!inputIds.includes(id)))throw Error('WORKLINE_REVIEW_INPUTS_REQUIRED');
 const inputs=inputIds.map(id=>item.evidence.find(e=>e.id===id));
 if(inputs.some(e=>!e))throw Error('WORKLINE_REVIEW_INPUTS_REQUIRED');
 const inputSources=new Set(inputs.flatMap(sourceIdentities));
 if(!Array.isArray(run.inputSourceIds) || run.inputSourceIds.some(id=>!inputSources.has(id)))throw Error('WORKLINE_REVIEW_INPUTS_REQUIRED');
 if (inputs.some(e => isExcludedEvidence(e,excludedSources) || !documentEvidenceAllowed(e, documentPolicy, {parentAllowedSourceIds:allowedSources,excludedSourceIds:excludedSources})
  || !isDocumentEvidence(e) && !sourceIdentities(e).some(id => allowedSources.has(id)))) throw Error('WORKLINE_SOURCE_NOT_ALLOWED');
 const heading = `更新至 ${new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(cutoff))}（北京时间）`;
 const fields = [['当前进展',card.current.text], ['后续跟进',card.follow_up.text], ['待确认',card.confirm.text], ['判断边界',card.boundary.text]];
 const content = `<h1>${escape(heading)}</h1>`+fields.map(([title,text]) => `<h2>${escape(title)}</h2><p>${escape(text)}</p>`).join('')
  +'<h2>原文依据</h2>'+evidence.map(e => `<p><b>${escape(e.source_title)}</b></p><blockquote><p>${escape(e.text)}</p></blockquote>`).join('');
 if (Buffer.byteLength(content) > 64000) throw Error('WORKLINE_DOCUMENT_TOO_LARGE');
 return {content, contentHash:digest(content), caseId, asOf:cutoff, evidenceIds:ids};
}

export function larkDocumentAdapter() {
 const call = async args => {
  let stdout;
  try { ({stdout} = await runFile('lark-cli', ['docs',...args,'--as','user'], {timeout:60000,maxBuffer:8*1024*1024})); }
  catch { throw Error('DOCUMENT_PROVIDER_FAILED'); } // Never echo private XML or command arguments.
  const result = JSON.parse(stdout);
  if (result.ok !== true || result.identity !== 'user') throw Error('DOCUMENT_PROVIDER_FAILED');
  return result;
 };
 return {
  fetch: async token => {
   const result = await call(['+fetch','--doc',token,'--detail','full']);
   return result.data.document;
  },
  insert: async (token, content) => {
   const result = await call(['+update','--doc',token,'--command','block_insert_after','--block-id','0','--content',content]);
   if (result.data?.result !== 'success' || result.data?.warnings?.length) throw Error('DOCUMENT_WRITE_NOT_VERIFIED');
  }
 };
}

export async function syncReviewedWorkline(configPath, {adapter=larkDocumentAdapter(), minimumAsOf} = {}) {
 const config = await read(await outside(configPath));
 if (config.enabled !== true || config.userAuthorized !== true || !/^[A-Za-z0-9]{10,100}$/.test(config.documentToken || '')) throw Error('DOCUMENT_SYNC_NOT_AUTHORIZED');
 for (const key of ['datasetPath','readingGuidePath','documentPolicyPath','attentionPath']) await outside(config[key]);
 await outside(dirname(config.receiptPath));
 const lockPath = config.receiptPath+'.lock';
 let lock;
 try { lock = await open(lockPath,'wx',0o600); } catch (e) { if(e.code==='EEXIST')throw Error('DOCUMENT_SYNC_BUSY');throw e; }
 try {
  const [dataset,guide,policy,attention] = await Promise.all([read(config.datasetPath),read(config.readingGuidePath),read(config.documentPolicyPath),loadAttention(config.attentionPath)]);
  const snapshot = reviewedWorklineDocument({dataset,guide,caseId:config.caseId,documentPolicy:policy,allowedSources:new Set(readPlan(attention).map(s=>s.sourceKey)),excludedSources:new Set(attention.sources.filter(s=>s.status==='excluded').map(s=>s.id)),minimumAsOf});
  let previous;
  try { previous = await read(config.receiptPath); } catch(e) { if(e.code!=='ENOENT')throw e; }
  if (previous && (previous.documentToken !== config.documentToken || previous.caseId !== config.caseId)) throw Error('DOCUMENT_BINDING_CHANGED');
  const document = await adapter.fetch(config.documentToken);
  if (document.document_id !== config.documentToken || typeof document.content !== 'string') throw Error('DOCUMENT_READBACK_INVALID');
  const base = {caseId:config.caseId,documentToken:config.documentToken,contentHash:snapshot.contentHash,asOf:snapshot.asOf};
  // Read first even for an unchanged local hash: remote deletion must not be
  // mistaken for successful synchronization. Recover an ambiguous write only
  // when the entire intended section is visible, never by blind retry.
  if (plain(document.content).includes(plain(snapshot.content))) {
   const receipt = {...base,status:'SYNCED',changed:false,revision:document.revision_id,checkedAt:new Date().toISOString()};
   await save(config.receiptPath,receipt);return receipt;
  }
  if (previous?.status === 'WRITE_PENDING') throw Error('DOCUMENT_WRITE_STATUS_UNKNOWN');
  const currentConfig = await read(configPath);
  if(currentConfig.enabled!==true || currentConfig.userAuthorized!==true || currentConfig.documentToken!==config.documentToken || currentConfig.caseId!==config.caseId) throw Error('DOCUMENT_SYNC_NOT_AUTHORIZED');
  const [currentDataset,currentGuide,currentPolicy,currentAttention]=await Promise.all([read(config.datasetPath),read(config.readingGuidePath),read(config.documentPolicyPath),loadAttention(config.attentionPath)]);
  const current=reviewedWorklineDocument({dataset:currentDataset,guide:currentGuide,caseId:config.caseId,documentPolicy:currentPolicy,allowedSources:new Set(readPlan(currentAttention).map(s=>s.sourceKey)),excludedSources:new Set(currentAttention.sources.filter(s=>s.status==='excluded').map(s=>s.id)),minimumAsOf});
  if(current.contentHash!==snapshot.contentHash)throw Error('WORKLINE_CHANGED_DURING_SYNC');
  await save(config.receiptPath,{...base,status:'WRITE_PENDING',checkedAt:new Date().toISOString()});
  await adapter.insert(config.documentToken,snapshot.content);
  const verified = await adapter.fetch(config.documentToken);
  if (verified.document_id !== config.documentToken || !plain(verified.content).includes(plain(snapshot.content))) throw Error('DOCUMENT_WRITE_NOT_VERIFIED');
  const receipt = {...base,status:'SYNCED',changed:true,revision:verified.revision_id,checkedAt:new Date().toISOString()};
  await save(config.receiptPath,receipt);return receipt;
 } finally { await lock.close();await unlink(lockPath); }
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 const result=await syncReviewedWorkline(process.argv[2]);
 console.log(JSON.stringify({status:result.status,changed:result.changed,asOf:result.asOf}));
}
