import {memoryDirection} from '../memory-pattern.mjs';
import { memoryInjectionView } from './diagnostic-memory-presentation.mjs';

const string = value => typeof value === 'string' ? value : '';
const list = value => Array.isArray(value) ? value : [];

// Links are optional evidence. Never turn private filesystem paths or opaque labels into URLs.
export function memoryEvidenceUrl(value) {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? value : null; } catch { return null; }
}

export function memoryLineage(record) {
  const lineage = record?.lineage || {};
  return {
    ticketId: string(lineage.ticketId || record?.historicalTicketId || record?.sourceTicketId),
    question: string(lineage.question || record?.originalQuestion),
    deliverables: list(lineage.deliverables || record?.deliverables).map(item => typeof item === 'string' ? { title: item } : item),
    acknowledgements: list(lineage.acknowledgements || record?.acknowledgements),
    extraction: string(lineage.extraction || record?.extractionNote),
    acknowledgementMeaning: '收到、OK 只表示接收或认可；未单独核验时，不代表数据和因果结论正确。',
  };
}

export function memoryRunReceipts(record, runs = []) {
  const rows = [];
  for (const run of list(runs)) {
    const selected = list(run.memorySnapshot?.selected).find(item => item.id === record.id) || list(run.memorySnapshot?.selected).find(item => (item.sourceTicketId||item.lineage?.ticketId)&&(item.sourceTicketId||item.lineage?.ticketId)===(record.sourceTicketId||record.lineage?.ticketId));
    const receipts = memoryInjectionView(run).receipts.filter(receipt => receipt.memoryIds.includes(selected?.id||record.id));
    if (!selected && !receipts.length) continue;
    rows.push({ runId: run.id, question: string(run.question), selectedVersion: selected?.version ?? null, receipts,
      state: receipts.some(receipt => receipt.responded) ? (selected?.id&&selected.id!==record.id?'使用了当时的版本':'已用于回答') : '已找到，尚未收到回答' });
  }
  return rows;
}

export function mergeMemoryRecords(records = [], playbooks = []) {
  const rows=new Map(records.map(record=>[record.id,record]));
  for(const playbook of playbooks){const runtime=rows.get(playbook.id);rows.set(playbook.id,{...playbook,...runtime,queryPattern:playbook.queryPattern});}
  return [...rows.values()];
}

export function memoryReviewRows(records = [], runs = [], { status = 'ALL', origin = 'ALL', search = '', direction='ALL' } = {}) {
  const query = search.trim().toLocaleLowerCase();
  return list(records).map(record => ({ ...record, lineageView: memoryLineage(record), runReceipts: memoryRunReceipts(record, runs) }))
    .filter(record => (direction==='ALL'||memoryDirection(record).id===direction) && (status === 'ALL' || record.status === status) && (origin !== 'HISTORY' || record.lineageView.ticketId) && (origin !== 'METHOD' || record.queryPattern) && (origin !== 'REFERENCE' || !record.queryPattern) &&
      (!query || `${record.title} ${record.question} ${memoryDirection(record).label} ${record.text} ${record.lineageView.question} ${record.lineageView.ticketId}`.toLocaleLowerCase().includes(query)));
}

export function selectedBoardSnapshot(board, snapshotId) {
  const snapshots = list(board?.snapshots);
  return snapshotId ? snapshots.find(snapshot => snapshot.id === snapshotId) || null : snapshots[0] || null;
}

export function boardSubmissionContext(board, snapshotId) {
  const snapshot = selectedBoardSnapshot(board, snapshotId);
  return board && snapshot ? { boardId: board.id, snapshotId: snapshot.id } : {};
}
