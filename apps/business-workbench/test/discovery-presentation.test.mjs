import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryTable, discoveryStatusLabels, discoveryText, discoveryChart } from '../src/discovery-presentation.mjs';

test('query table preserves zero, false, null and both supported result row shapes', () => {
  const result = discoveryTable({ columns: ['date', { field: 'volume' }, { name: 'valid' }, { key: 'missing' }], records: [
    { date: '2026-10-15', volume: 0, valid: false, missing: null },
    ['2026-10-16', 12, true],
  ] });
  assert.deepEqual(result.columns.map(column => column.name), ['date', 'volume', 'valid', 'missing']);
  assert.deepEqual(result.records.map(row => row.cells), [['2026-10-15', '0', 'false', '—'], ['2026-10-16', '12', 'true', '—']]);
});

test('unavailable query and unknown states do not become completed results', () => {
  assert.deepEqual(discoveryTable(undefined), { columns: [], records: [] });
  assert.notEqual(discoveryStatusLabels.UNKNOWN_EXECUTION, discoveryStatusLabels.REVIEW_READY);
  assert.notEqual(discoveryStatusLabels.SUPPRESSED, discoveryStatusLabels.REVIEW_READY);
  assert.equal(discoveryText({ status: 'NOT_RUN' }), '{\n  "status": "NOT_RUN"\n}');
});

test('trend refuses to sum across path buckets and uses only explicitly selected original rows', () => {
  const result = { receiptId: 'receipt-1', status: 'VERIFIED', columns: ['dt', 'path_bucket', 'user_adopt_uv', 'open_online_doc_uv'], records: [
    ['2026-09-08', 'version2_backend_only', 100, 60], ['2026-09-07', 'version2_backend_only', 90, 50],
    ['2026-09-07', 'both_adopt_paths', 2, 2], ['2026-09-08', 'both_adopt_paths', 3, 3],
  ] };
  assert.deepEqual(discoveryChart(result).points, []);
  const chart = discoveryChart(result, 'version2_backend_only');
  assert.deepEqual(chart.points.map(point => point.values), [[90, 50], [100, 60]]);
  assert.ok(chart.points.every(point => point.receiptId === 'receipt-1'));
  assert.equal(discoveryChart(result, 'made-up-group').points.length, 0);
});

test('explicit all_dedup rows win without adding segment UV', () => {
  const chart = discoveryChart({ receiptId: 'receipt-2', status: 'VERIFIED', columns: ['date', 'path_bucket', 'adopt_uv', 'open_uv'], records: [
    { date: '2026-09-07', path_bucket: 'all_dedup', adopt_uv: 100, open_uv: 60 },
    { date: '2026-09-07', path_bucket: 'segment_a', adopt_uv: 80, open_uv: 50 },
    { date: '2026-09-07', path_bucket: 'segment_b', adopt_uv: 70, open_uv: 40 },
  ] });
  assert.equal(chart.bucket, 'all_dedup');
  assert.deepEqual(chart.points[0].values, [100, 60]);
});

test('invalid dates/numeric strings are not plotted and duplicate dates are not silently merged', () => {
  const result = { receiptId: 'receipt-3', status: 'VERIFIED', columns: ['dt', 'adopt_uv', 'open_uv'], records: [
    ['2026-02-30', 10, 3], ['2026-09-07', '10', 3], ['2026-09-08', 12, 6],
  ] };
  assert.equal(discoveryChart(result).omittedRows, 2);
  assert.equal(discoveryChart(result).points.length, 1);
  result.records.push(['2026-09-08', 11, 5]);
  assert.equal(discoveryChart(result).duplicateDates, true);
  assert.deepEqual(discoveryChart(result).points, []);
  assert.equal(discoveryChart({ ...result, status: 'NOT_RUN' }), null);
});
