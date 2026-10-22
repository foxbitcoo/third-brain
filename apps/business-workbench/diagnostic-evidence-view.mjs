/** Deterministic model view. Never replaces the privately retained raw result. */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const DAY = 86_400_000;
const count = value => Number.isSafeInteger(value) && value >= 0;
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const stamp = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp : null;
}
function dates(start, end) {
  const first = date(start), last = date(end);
  if (first === null || last === null || last < first || last - first > 30 * DAY) return null;
  return Array.from({ length: (last - first) / DAY + 1 }, (_, i) => new Date(first + i * DAY).toISOString().slice(0, 10));
}
const rate = (numerator, denominator) => denominator > 0 ? 100 * numerator / denominator : null;
const sum = (a, b) => { const value = a + b; if (!Number.isSafeInteger(value)) throw new Error('COUNT_OVERFLOW'); return value; };
const columns = ['dimension', 'value', 'currentNumerator', 'currentDenominator', 'currentRate', 'baselineNumerator', 'baselineDenominator', 'baselineRate', 'wowPP', 'unit', 'isOther', 'memberCount'];
const unit = 'user-day counts; not distinct multi-day users';

export function compactDiagnosticEvidence(result, spec) {
  if (spec === undefined || spec === null) return result;
  const failure = reason => ({ status: 'NEEDS_RAW_TABLE', reason, compact: false, receiptId: result?.receiptId ?? null,
    queryHash: result?.queryHash ?? null, sourceRowCount: Array.isArray(result?.records) ? result.records.length : null,
    rawResultRetained: true, coverage: { status: 'NOT_COMPACTED', sourceCoverage: result?.coverage ?? null } });
  if (!object(spec) || !object(result) || result.status !== 'VERIFIED' || !text(result.receiptId) || !text(result.queryHash)
    || !Array.isArray(result.columns) || !result.columns.every(text) || new Set(result.columns).size !== result.columns.length
    || !Array.isArray(result.records) || !Array.isArray(spec.groupKeys) || spec.groupKeys.length !== 2
    || ![spec.dateKey, ...spec.groupKeys, spec.numerator, spec.denominator].every(text)
    || new Set([spec.dateKey, ...spec.groupKeys, spec.numerator, spec.denominator]).size !== 5
    || ![spec.dateKey, ...spec.groupKeys, spec.numerator, spec.denominator].every(key => result.columns.includes(key))) return failure('INVALID_COMPACT_FIELDS');
  const currentDates = dates(spec.currentStart, spec.currentEnd), baselineDates = dates(spec.baselineStart, spec.baselineEnd);
  if (!currentDates || !baselineDates || currentDates.length !== baselineDates.length
    || date(spec.currentStart) - date(spec.baselineStart) !== 7 * DAY
    || baselineDates.some(day => currentDates.includes(day))) return failure('INVALID_COMPARISON_WINDOWS');
  const top = spec.topPerDimension ?? 10;
  if (!Number.isInteger(top) || top < 1 || top > 12) return failure('INVALID_COMPACT_LIMIT');
  const current = new Set(currentDates), baseline = new Set(baselineDates);
  const seen = new Set(), excludedDates = new Set(), dimensions = new Map();
  let excludedRowCount = 0;
  try {
    for (const raw of result.records) {
      if (!Array.isArray(raw) && !object(raw) || Array.isArray(raw) && raw.length !== result.columns.length) return failure('INVALID_COMPACT_ROW');
      const row = Array.isArray(raw) ? Object.fromEntries(result.columns.map((key, i) => [key, raw[i]])) : raw;
      const day = row[spec.dateKey], dimension = row[spec.groupKeys[0]], value = row[spec.groupKeys[1]], numerator = row[spec.numerator], denominator = row[spec.denominator];
      if (date(day) === null || !text(dimension) || !text(value) || !count(numerator) || !count(denominator) || numerator > denominator) return failure('INVALID_COMPACT_VALUE');
      const key = JSON.stringify([day, dimension, value]);
      if (seen.has(key)) return failure('DUPLICATE_DAILY_GROUP');
      seen.add(key);
      const window = current.has(day) ? 'current' : baseline.has(day) ? 'baseline' : null;
      if (!window) { excludedDates.add(day); excludedRowCount++; continue; }
      if (!dimensions.has(dimension)) dimensions.set(dimension, { groups: new Map(), currentDates: new Set(), baselineDates: new Set() });
      const dim = dimensions.get(dimension);
      dim[window + 'Dates'].add(day);
      if (!dim.groups.has(value)) dim.groups.set(value, { dimension, value, currentNumerator: 0, currentDenominator: 0, baselineNumerator: 0, baselineDenominator: 0, isOther: false, memberCount: 1 });
      const group = dim.groups.get(value);
      group[window + 'Numerator'] = sum(group[window + 'Numerator'], numerator);
      group[window + 'Denominator'] = sum(group[window + 'Denominator'], denominator);
    }
    const rows = [], dimensionCoverage = [];
    let truncated = false;
    for (const [name, dim] of [...dimensions].sort(([a], [b]) => a.localeCompare(b))) {
      const missingCurrentDates = currentDates.filter(day => !dim.currentDates.has(day));
      const missingBaselineDates = baselineDates.filter(day => !dim.baselineDates.has(day));
      const comparable = missingCurrentDates.length === 0 && missingBaselineDates.length === 0;
      const sorted = [...dim.groups.values()].sort((a, b) => Math.max(b.currentDenominator, b.baselineDenominator) - Math.max(a.currentDenominator, a.baselineDenominator) || a.value.localeCompare(b.value));
      // Unknown/multi-value buckets remain explicit even when outside the leading groups.
      const special = group => /UNKNOWN|MULTI/i.test(group.value);
      const selected = sorted.filter(group => !special(group)).slice(0, top);
      for (const group of sorted.filter(special)) selected.push(group);
      const selectedValues = new Set(selected.map(group => group.value));
      const rest = sorted.filter(group => !selectedValues.has(group.value));
      let otherAggregated = false;
      if (rest.length && spec.mutuallyExclusiveWithinDimension === true) {
        const other = { dimension: name, value: '__OTHER_COMPACT__', currentNumerator: 0, currentDenominator: 0, baselineNumerator: 0, baselineDenominator: 0, isOther: true, memberCount: rest.length };
        for (const group of rest) for (const key of ['currentNumerator', 'currentDenominator', 'baselineNumerator', 'baselineDenominator']) other[key] = sum(other[key], group[key]);
        selected.push(other); otherAggregated = true;
      } else if (rest.length) truncated = true;
      for (const group of selected) {
        group.currentRate = rate(group.currentNumerator, group.currentDenominator);
        group.baselineRate = rate(group.baselineNumerator, group.baselineDenominator);
        group.wowPP = comparable && group.currentRate !== null && group.baselineRate !== null ? group.currentRate - group.baselineRate : null;
        group.unit = unit;
        rows.push(group);
      }
      dimensionCoverage.push({ dimension: name, groupCount: sorted.length, outputGroupCount: selected.length, omittedGroupCount: otherAggregated ? 0 : rest.length,
        otherMemberCount: otherAggregated ? rest.length : 0, otherAggregated, missingCurrentDates, missingBaselineDates, comparable });
    }
    const output = { receiptId: result.receiptId, status: 'VERIFIED', queryHash: result.queryHash,
      ...(result.sourceVersion !== undefined ? { sourceVersion: result.sourceVersion } : {}), compact: true, rawResultRetained: true,
      sourceRowCount: result.records.length, includedRowCount: result.records.length - excludedRowCount, excludedRowCount, excludedDates: [...excludedDates].sort(),
      columns, records: rows.map(row => columns.map(key => row[key])),
      coverage: { status: truncated || !dimensions.size || dimensionCoverage.some(item => !item.comparable) ? 'PARTIAL' : 'WINDOW_ROWS_AGGREGATED',
        sourceCoverage: result.coverage ?? null, currentDates, baselineDates, dimensions: dimensionCoverage, truncated,
        mutuallyExclusiveWithinDimension: spec.mutuallyExclusiveWithinDimension === true, method: 'Sum observed daily counts within each dimension/value and window; ratio of sums; paired same-weekday windows, not average of daily rates.',
        unit, caveat: 'Dimensions are independent populations; do not sum dimensions. Date presence does not verify source partition completeness or a causal explanation. Missing group/window counts are not proof of no usage.' } };
    if (Buffer.byteLength(JSON.stringify(output)) > 25_000) return failure('COMPACT_SIZE_LIMIT');
    return output;
  } catch { return failure('COUNT_OVERFLOW'); }
}

/** Same-day-of-week facts without asking a model to perform the arithmetic. */
export function dailyDiagnosticComparisons(result, spec) {
  if (spec === undefined || spec === null) return result;
  const failure = reason => ({ status: 'NEEDS_RAW_TABLE', reason, compact: false,
    receiptId: result?.receiptId ?? null, queryHash: result?.queryHash ?? null,
    sourceRowCount: Array.isArray(result?.records) ? result.records.length : null, rawResultRetained: true });
  if (!object(spec) || !object(result) || result.status !== 'VERIFIED' || !text(result.receiptId) || !text(result.queryHash)
    || !Array.isArray(result.columns) || !result.columns.every(text) || new Set(result.columns).size !== result.columns.length
    || !Array.isArray(result.records) || !Array.isArray(spec.groupKeys) || ![1, 2].includes(spec.groupKeys.length)) return failure('INVALID_DAILY_FIELDS');
  const required = [spec.dateKey, ...spec.groupKeys, spec.numerator, spec.denominator];
  if (!required.every(text) || new Set(required).size !== required.length || !required.every(key => result.columns.includes(key))) return failure('INVALID_DAILY_FIELDS');
  const currentDates = dates(spec.currentStart, spec.currentEnd), baselineDates = dates(spec.baselineStart, spec.baselineEnd);
  if (!currentDates || !baselineDates || currentDates.length !== baselineDates.length
    || date(spec.currentStart) - date(spec.baselineStart) !== 7 * DAY || baselineDates.some(day => currentDates.includes(day))) return failure('INVALID_COMPARISON_WINDOWS');
  const currentSet = new Set(currentDates), baselineSet = new Set(baselineDates), excludedDates = new Set();
  const daily = new Map(), groups = new Map();
  let excludedRowCount = 0;
  for (const raw of result.records) {
    if (!Array.isArray(raw) && !object(raw) || Array.isArray(raw) && raw.length !== result.columns.length) return failure('INVALID_DAILY_ROW');
    const row = Array.isArray(raw) ? Object.fromEntries(result.columns.map((key, i) => [key, raw[i]])) : raw;
    const day = row[spec.dateKey], values = spec.groupKeys.map(key => row[key]), numerator = row[spec.numerator], denominator = row[spec.denominator];
    if (date(day) === null || !values.every(text) || !count(numerator) || !count(denominator) || numerator > denominator) return failure('INVALID_DAILY_VALUE');
    const key = JSON.stringify([day, ...values]);
    if (daily.has(key)) return failure('DUPLICATE_DAILY_GROUP');
    daily.set(key, { numerator, denominator });
    if (!currentSet.has(day) && !baselineSet.has(day)) { excludedDates.add(day); excludedRowCount++; continue; }
    groups.set(JSON.stringify(values), values);
  }
  // Daily UV is additive only across a verified, exhaustive, disjoint partition.
  // Bind that assertion to this exact query, never infer it from bucket names.
  const partition = spec.partition;
  let derivedOverall = false;
  if (partition !== undefined) {
    if (spec.groupKeys.length !== 1 || spec.mutuallyExclusiveWithinDimension !== true
      || !object(partition) || partition.exhaustive !== true || partition.queryHash !== result.queryHash
      || partition.unit !== 'daily_distinct_accounts' || !text(partition.overallValue)
      || !Array.isArray(partition.members) || partition.members.length < 2 || !partition.members.every(text)
      || new Set(partition.members).size !== partition.members.length || partition.members.includes(partition.overallValue)
      || [...groups.values()].some(values => !partition.members.includes(values[0]))) return failure('INVALID_PARTITION_PROOF');
    try {
      for (const day of [...currentDates, ...baselineDates]) {
        const members = partition.members.map(value => daily.get(JSON.stringify([day, value])));
        // A missing row is unknown, never an implicit zero member.
        if (members.some(member => !member)) return failure('INCOMPLETE_PARTITION');
        daily.set(JSON.stringify([day, partition.overallValue]), members.reduce((total, member) => ({
          numerator: sum(total.numerator, member.numerator), denominator: sum(total.denominator, member.denominator),
        }), { numerator: 0, denominator: 0 }));
      }
      groups.set(JSON.stringify([partition.overallValue]), [partition.overallValue]);
      derivedOverall = true;
    } catch { return failure('COUNT_OVERFLOW'); }
  }
  // Never truncate a partial daily series into a seemingly complete comparison.
  if (groups.size * currentDates.length > 60) return failure('DAILY_COMPARISON_LIMIT');
  const dailyColumns = ['currentDate', 'baselineDate', ...spec.groupKeys, 'currentNumerator', 'currentDenominator', 'currentRate',
    'baselineNumerator', 'baselineDenominator', 'baselineRate', 'numRelativePct', 'denRelativePct', 'wowPP', 'comparisonStatus'];
  const records = [], missing = [];
  let zeroBaselineComparisons = 0;
  for (let i = 0; i < currentDates.length; i++) {
    for (const [, values] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const currentDay = currentDates[i], baseDay = baselineDates[i];
      const c = daily.get(JSON.stringify([currentDay, ...values])), b = daily.get(JSON.stringify([baseDay, ...values]));
      const cr = c ? rate(c.numerator, c.denominator) : null, br = b ? rate(b.numerator, b.denominator) : null;
      const relative = field => c && b && b[field] > 0 ? 100 * (c[field] - b[field]) / b[field] : null;
      const status = !c && !b ? 'MISSING_BOTH' : !c ? 'MISSING_CURRENT' : !b ? 'MISSING_BASELINE' : !c.denominator || !b.denominator ? 'ZERO_DENOMINATOR' : 'PAIRED';
      if (!c || !b) missing.push({ currentDate: currentDay, baselineDate: baseDay, group: Object.fromEntries(spec.groupKeys.map((key, j) => [key, values[j]])), status });
      if (b && (b.numerator === 0 || b.denominator === 0)) zeroBaselineComparisons++;
      records.push([currentDay, baseDay, ...values, c?.numerator ?? null, c?.denominator ?? null, cr,
        b?.numerator ?? null, b?.denominator ?? null, br, relative('numerator'), relative('denominator'),
        cr !== null && br !== null ? cr - br : null, status]);
    }
  }
  const output = { receiptId: result.receiptId, status: 'VERIFIED', queryHash: result.queryHash,
    ...(result.sourceVersion !== undefined ? { sourceVersion: result.sourceVersion } : {}), compact: true, dailyFacts: true, rawResultRetained: true,
    sourceRowCount: result.records.length, includedRowCount: result.records.length - excludedRowCount, excludedRowCount, excludedDates: [...excludedDates].sort(),
    columns: dailyColumns, records,
    coverage: { status: missing.length || !records.length ? 'PARTIAL' : 'DAILY_ROWS_PAIRED', currentDates, baselineDates, missingComparisons: missing,
      zeroBaselineComparisons, sourceCoverage: result.coverage ?? null,
      method: 'Exact group/day versus the same group seven calendar days earlier; no group or date summation. Relative percent uses baseline counts; wowPP is current rate minus baseline rate.',
      unit: 'daily source-defined account counts; not distinct multi-day users',
      ...(derivedOverall ? { derivedOverall: { value: partition.overallValue, members: partition.members, queryHash: partition.queryHash, method: 'Sum the verified exhaustive disjoint account partition within each day only; no cross-day UV summation.' } } : {}),
      caveat: 'Missing rows are null, not zero. Zero baselines have no relative percentage. Pairing does not verify source partition completeness or business causality.' } };
  if (Buffer.byteLength(JSON.stringify(output)) > 25_000) return failure('DAILY_SIZE_LIMIT');
  return output;
}
