export const discoveryStatusLabels = {
  QUEUED: '等待分析', PLANNING: '分析问题中', PLANNED: '准备查数', RUNNING_QUERY: '正在查数',
  REVIEWING: '核对结果中', RUNNING_REVIEW: '核对结果中', QUERIED: '数据已返回', CONTINUE: '继续下钻中',
  REVIEW_READY: '报告待审', NEEDS_HUMAN: '待补充业务信息', NEEDS_DEFINITION: '待核对取数口径',
  PAUSED_LIMIT: '已达本次分析范围', FAILED: '本次分析未完成', CANCELLED: '已取消',
  SOURCE_REVOKED: '来源已停用', SUPPRESSED: '来源不可用，结果已隐藏', UNKNOWN_EXECUTION: '查数状态待核实',
};
export const discoveryActiveStatuses = new Set(['QUEUED', 'PLANNING', 'PLANNED', 'RUNNING_QUERY', 'REVIEWING', 'RUNNING_REVIEW', 'QUERIED', 'CONTINUE']);
export const discoveryDecisionLabels = { continue: '仍需下钻', ready: '可供人工评阅', needs_human: '需要补充业务信息' };
export function discoveryText(value) {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}
export function discoveryTable(result) {
  const columns = (Array.isArray(result?.columns) ? result.columns : []).map((column, index) => ({
    key: String(index), name: typeof column === 'string' ? column : column?.name ?? column?.field ?? column?.key ?? `字段 ${index + 1}`,
  }));
  const records = (Array.isArray(result?.records) ? result.records : []).map((record, index) => ({
    key: String(index), cells: columns.map((column, offset) => discoveryText(Array.isArray(record) ? record[offset] : record?.[column.name])),
  }));
  return { columns, records };
}

/** Only plot original, same-receipt rows. Never sum UV across path buckets. */
export function discoveryChart(result, requestedBucket) {
  const { columns } = discoveryTable(result);
  const names = columns.map(column => column.name);
  const dateField = ['dt', 'date'].find(name => names.includes(name));
  const fields = [['adopt_uv', 'user_adopt_uv'], ['open_uv', 'open_online_doc_uv']].map(candidates => candidates.find(name => names.includes(name)));
  if (!dateField || fields.some(field => !field) || !result?.receiptId || result.status !== 'VERIFIED') return null;
  const rows = (result.records || []).map(row => Array.isArray(row) ? Object.fromEntries(names.map((name, index) => [name, row[index]])) : row);
  const bucketed = names.includes('path_bucket');
  const buckets = bucketed ? [...new Set(rows.map(row => row?.path_bucket).filter(value => typeof value === 'string' && value.trim()))].sort() : [];
  const preferred = buckets.includes('all_dedup') ? 'all_dedup' : buckets.includes('ALL') ? 'ALL' : buckets.length === 1 ? buckets[0] : '';
  const bucket = requestedBucket === undefined ? preferred : buckets.includes(requestedBucket) ? requestedBucket : '';
  const selected = bucketed ? rows.filter(row => bucket && row?.path_bucket === bucket) : rows;
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const points = selected.filter(row => validDate(row?.[dateField]) && fields.every(field => typeof row[field] === 'number' && Number.isFinite(row[field]) && row[field] >= 0))
    .map(row => ({ date: row[dateField], values: fields.map(field => row[field]), receiptId: result.receiptId })).sort((a, b) => a.date.localeCompare(b.date));
  const duplicateDates = new Set(points.map(point => point.date)).size !== points.length;
  return { fields, buckets, bucket, bucketed, points: duplicateDates ? [] : points, duplicateDates, omittedRows: selected.length - points.length, receiptId: result.receiptId };
}
