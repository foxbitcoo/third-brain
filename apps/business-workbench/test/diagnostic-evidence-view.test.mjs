import test from 'node:test';
import assert from 'node:assert/strict';
import { compactDiagnosticEvidence, dailyDiagnosticComparisons } from '../diagnostic-evidence-view.mjs';

const fields = ['dt', 'slice_type', 'slice_value', 'open_uv', 'adopt_uv'];
const spec = { dateKey: 'dt', groupKeys: ['slice_type', 'slice_value'], numerator: 'open_uv', denominator: 'adopt_uv',
  currentStart: '2026-09-14', currentEnd: '2026-09-15', baselineStart: '2026-09-07', baselineEnd: '2026-09-08', topPerDimension: 10, mutuallyExclusiveWithinDimension: true };
const input = rows => ({ receiptId: 'receipt', status: 'VERIFIED', queryHash: 'hash', columns: fields, records: rows, coverage: 'Source partition completeness unconfirmed.' });
const rows = result => result.records.map(record => Object.fromEntries(result.columns.map((key, i) => [key, record[i]])));
function fixture() { return input([
  ['2026-09-07', 'version', 'v1', 2, 4], ['2026-09-08', 'version', 'v1', 8, 16],
  ['2026-09-14', 'version', 'v1', 3, 10], ['2026-09-15', 'version', 'v1', 7, 10],
  ['2026-09-07', 'entry', 'main', 10, 20], ['2026-09-08', 'entry', 'main', 10, 20],
  ['2026-09-14', 'entry', 'main', 10, 20], ['2026-09-15', 'entry', 'main', 10, 20],
  ['2026-09-19', 'version', 'v1', 1, 2],
]); }

test('no spec leaves the original result unchanged without truncation', () => {
  const raw = input(Array.from({ length: 500 }, () => []));
  assert.equal(compactDiagnosticEvidence(raw), raw);
  assert.equal(compactDiagnosticEvidence(raw, null), raw);
});

test('ratio of daily count sums is computed per dimension, never across slices', () => {
  const raw = fixture(), before = JSON.stringify(raw);
  const compact = compactDiagnosticEvidence(raw, spec);
  const version = rows(compact).find(row => row.dimension === 'version');
  assert.equal(version.currentNumerator, 10); assert.equal(version.currentDenominator, 20);
  assert.equal(version.baselineNumerator, 10); assert.equal(version.baselineDenominator, 20);
  assert.equal(version.currentRate, 50); assert.equal(version.baselineRate, 50); assert.equal(version.wowPP, 0);
  assert.equal(version.unit, 'user-day counts; not distinct multi-day users');
  assert.equal(rows(compact).length, 2);
  assert.equal(compact.sourceRowCount, 9); assert.equal(compact.includedRowCount, 8);
  assert.deepEqual(compact.excludedDates, ['2026-09-19']);
  assert.equal(compact.receiptId, raw.receiptId); assert.equal(compact.queryHash, raw.queryHash);
  assert.equal(JSON.stringify(raw), before);
});

test('UNKNOWN and MULTI remain explicit even outside top groups', () => {
  const raw = input([]);
  for (const day of ['2026-09-07', '2026-09-08', '2026-09-14', '2026-09-15']) {
    for (const [value, n] of [['v1', 100], ['v2', 50], ['__UNKNOWN__', 2], ['__MULTI__', 1]]) raw.records.push([day, 'version', value, n, n * 2]);
  }
  const compact = compactDiagnosticEvidence(raw, { ...spec, topPerDimension: 1 });
  assert.deepEqual(new Set(rows(compact).map(row => row.value)), new Set(['v1', '__UNKNOWN__', '__MULTI__', '__OTHER_COMPACT__']));
  assert.equal(rows(compact).find(row => row.isOther).memberCount, 1);
});

test('only mutually exclusive dimensions may aggregate OTHER; totals reconcile within each dimension', () => {
  const raw = input([]);
  for (const day of ['2026-09-07', '2026-09-08', '2026-09-14', '2026-09-15']) for (let i = 1; i <= 20; i++) raw.records.push([day, 'version', 'v' + i, i, i * 2]);
  const compact = compactDiagnosticEvidence(raw, { ...spec, topPerDimension: 2 });
  assert.equal(rows(compact).length, 3);
  assert.equal(rows(compact).reduce((sum, row) => sum + row.currentNumerator, 0), 420);
  assert.equal(rows(compact).reduce((sum, row) => sum + row.currentDenominator, 0), 840);
  const truncated = compactDiagnosticEvidence(raw, { ...spec, topPerDimension: 2, mutuallyExclusiveWithinDimension: false });
  assert.equal(rows(truncated).length, 2); assert.equal(truncated.coverage.truncated, true);
  assert.equal(truncated.coverage.status, 'PARTIAL');
  assert.equal(truncated.coverage.dimensions[0].omittedGroupCount, 18);
});

test('invalid fields, nonnumbers, negative/fraction counts, duplicate dates and overflow fail closed', () => {
  for (const changes of [{ numerator: 'missing' }, { groupKeys: ['slice_type'] }, { topPerDimension: 13 }, { currentStart: '2026-09-15' }]) {
    assert.equal(compactDiagnosticEvidence(fixture(), { ...spec, ...changes }).status, 'NEEDS_RAW_TABLE');
  }
  for (const invalid of ['10', NaN, -1, 0.5, undefined]) {
    const raw = fixture(); raw.records[0][3] = invalid;
    const result = compactDiagnosticEvidence(raw, spec);
    assert.equal(result.status, 'NEEDS_RAW_TABLE'); assert.equal(result.records, undefined);
  }
  const duplicate = fixture(); duplicate.records.push([...duplicate.records[0]]);
  assert.equal(compactDiagnosticEvidence(duplicate, spec).reason, 'DUPLICATE_DAILY_GROUP');
  const overflow = fixture(); overflow.records[0][3] = Number.MAX_SAFE_INTEGER; overflow.records[0][4] = Number.MAX_SAFE_INTEGER;
  assert.equal(compactDiagnosticEvidence(overflow, spec).reason, 'COUNT_OVERFLOW');
});

test('missing source dates cannot produce a same-weekday comparison claim', () => {
  const raw = fixture(); raw.records = raw.records.filter(row => !(row[0] === '2026-09-07' && row[1] === 'version'));
  const compact = compactDiagnosticEvidence(raw, spec);
  assert.equal(compact.coverage.status, 'PARTIAL');
  assert.equal(rows(compact).find(row => row.dimension === 'version').wowPP, null);
  assert.deepEqual(compact.coverage.dimensions.find(d => d.dimension === 'version').missingBaselineDates, ['2026-09-07']);
});

test('zero denominators remain unknown rates, not a manufactured zero conversion', () => {
  const raw = fixture(); raw.records = raw.records.map(row => row[1] === 'version' ? [...row.slice(0, 3), 0, 0] : row);
  const compact = compactDiagnosticEvidence(raw, spec);
  const version = rows(compact).find(row => row.dimension === 'version');
  assert.equal(version.currentRate, null); assert.equal(version.baselineRate, null); assert.equal(version.wowPP, null);
});

test('object rows are supported, output is bounded, and raw rows are never rewritten', () => {
  const raw = fixture(); raw.records = raw.records.map(row => Object.fromEntries(fields.map((key, i) => [key, row[i]])));
  const result = compactDiagnosticEvidence(raw, spec);
  assert.equal(result.status, 'VERIFIED'); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 25_000);
  assert.ok(result.rawResultRetained); assert.equal(raw.records.length, 9);
});

test('daily facts distinguish growing counts from declining conversion using exact weekly pairs', () => {
  const raw = { receiptId: 'r', status: 'VERIFIED', queryHash: 'h', columns: ['dt', 'path_bucket', 'open_uv', 'adopt_uv'], records: [
    ['2026-09-12', 'synthetic_path', 50, 100], ['2026-09-19', 'synthetic_path', 80, 200],
  ] };
  const daily = dailyDiagnosticComparisons(raw, { ...spec, groupKeys: ['path_bucket'], currentStart: '2026-09-19', currentEnd: '2026-09-19', baselineStart: '2026-09-12', baselineEnd: '2026-09-12' });
  const row = rows(daily)[0];
  assert.equal(row.currentRate, 40);
  assert.equal(row.baselineRate, 50);
  assert.equal(row.wowPP, -10);
  assert.ok(row.numRelativePct > 0); assert.ok(row.denRelativePct > 0);
  assert.equal(row.comparisonStatus, 'PAIRED');
});

test('daily facts preserve absent dates/groups as null and never sum dimensions', () => {
  const raw = fixture(); raw.records = raw.records.filter(row => !(row[0] === '2026-09-07' && row[1] === 'version'));
  const daily = dailyDiagnosticComparisons(raw, spec);
  assert.equal(daily.records.length, 4);
  const missing = rows(daily).find(row => row.currentDate === '2026-09-14' && row.slice_type === 'version');
  assert.equal(missing.baselineNumerator, null); assert.equal(missing.wowPP, null); assert.equal(missing.numRelativePct, null);
  assert.equal(missing.comparisonStatus, 'MISSING_BASELINE'); assert.equal(daily.coverage.status, 'PARTIAL');
  assert.equal(rows(daily).find(row => row.slice_type === 'entry').currentDenominator, 20);
});

test('daily facts reject duplicate/nonnumber inputs and refuse silent 60-row truncation', () => {
  const raw = fixture(); raw.records.push([...raw.records[0]]);
  assert.equal(dailyDiagnosticComparisons(raw, spec).reason, 'DUPLICATE_DAILY_GROUP');
  const bad = fixture(); bad.records[0][3] = '2';
  assert.equal(dailyDiagnosticComparisons(bad, spec).reason, 'INVALID_DAILY_VALUE');
  const large = input(Array.from({ length: 31 }, (_, i) => ['2026-09-14', 'dimension', 'value' + i, 1, 2]));
  const result = dailyDiagnosticComparisons(large, spec);
  assert.equal(result.status, 'NEEDS_RAW_TABLE'); assert.equal(result.reason, 'DAILY_COMPARISON_LIMIT'); assert.equal(result.records, undefined);
});

test('daily zero baselines give null relative percent and no-spec never truncates', () => {
  const raw = fixture(); raw.records = raw.records.map(row => row[0] === '2026-09-07' ? [...row.slice(0, 3), 0, 0] : row);
  const daily = dailyDiagnosticComparisons(raw, spec);
  const row = rows(daily)[0];
  assert.equal(row.baselineRate, null); assert.equal(row.numRelativePct, null); assert.equal(row.denRelativePct, null); assert.equal(row.wowPP, null);
  assert.equal(dailyDiagnosticComparisons(raw), raw);
});

test('overall daily UV requires an exhaustive disjoint partition bound to the actual query', () => {
 const raw={receiptId:'r',status:'VERIFIED',queryHash:'partition-query',columns:['dt','bucket','n','d'],records:[['2026-01-07','a',2,4],['2026-01-07','b',3,6],['2026-01-14','a',3,5],['2026-01-14','b',3,7]]};
 const view={dateKey:'dt',groupKeys:['bucket'],numerator:'n',denominator:'d',currentStart:'2026-01-14',currentEnd:'2026-01-14',baselineStart:'2026-01-07',baselineEnd:'2026-01-07',mutuallyExclusiveWithinDimension:true};
 const proof={exhaustive:true,queryHash:'partition-query',unit:'daily_distinct_accounts',overallValue:'__ALL__',members:['a','b']};
 const before=JSON.stringify(raw);
 assert.equal(rows(dailyDiagnosticComparisons(raw,view)).length,2);
 const calculated=dailyDiagnosticComparisons(raw,{...view,partition:proof});
 const overall=rows(calculated).find(r=>r.bucket==='__ALL__');
 assert.equal(overall.currentNumerator,6);assert.equal(overall.currentDenominator,12);assert.equal(overall.baselineNumerator,5);assert.equal(overall.baselineDenominator,10);assert.equal(overall.wowPP,0);
 assert.equal(calculated.coverage.derivedOverall.queryHash,raw.queryHash);assert.equal(JSON.stringify(raw),before);
 for(const change of [{exhaustive:false},{queryHash:'other-query'},{unit:'sessions'},{members:['a','a']},{members:['a','c']}])assert.equal(dailyDiagnosticComparisons(raw,{...view,partition:{...proof,...change}}).status,'NEEDS_RAW_TABLE');
 const missing={...raw,records:raw.records.slice(1)};
 assert.equal(dailyDiagnosticComparisons(missing,{...view,partition:proof}).reason,'INCOMPLETE_PARTITION');
 assert.equal(dailyDiagnosticComparisons(raw,{...view,mutuallyExclusiveWithinDimension:false,partition:proof}).reason,'INVALID_PARTITION_PROOF');
});
