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
    ticketId: string(lineage.ticketId || record?.historicalTicketId),
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
    const selected = list(run.memorySnapshot?.selected).find(item => item.id === record.id);
    const receipts = memoryInjectionView(run).receipts.filter(receipt => receipt.memoryIds.includes(record.id));
    if (!selected && !receipts.length) continue;
    rows.push({ runId: run.id, question: string(run.question), selectedVersion: selected?.version ?? null, receipts,
      state: receipts.some(receipt => receipt.responded) ? '已注入并取得响应' : '已匹配，未取得注入响应回执' });
  }
  return rows;
}

export function memoryReviewRows(records = [], runs = [], { status = 'ALL', origin = 'ALL', search = '' } = {}) {
  const query = search.trim().toLocaleLowerCase();
  return list(records).map(record => ({ ...record, lineageView: memoryLineage(record), runReceipts: memoryRunReceipts(record, runs) }))
    .filter(record => (status === 'ALL' || record.status === status) && (origin !== 'HISTORY' || record.lineageView.ticketId) &&
      (!query || `${record.title} ${record.text} ${record.lineageView.question} ${record.lineageView.ticketId}`.toLocaleLowerCase().includes(query)));
}

export function selectedBoardSnapshot(board, snapshotId) {
  const snapshots = list(board?.snapshots);
  return snapshotId ? snapshots.find(snapshot => snapshot.id === snapshotId) || null : snapshots[0] || null;
}

export function boardSubmissionContext(board, snapshotId) {
  const snapshot = selectedBoardSnapshot(board, snapshotId);
  return board && snapshot ? { boardId: board.id, snapshotId: snapshot.id } : {};
}
