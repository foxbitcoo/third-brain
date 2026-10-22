const STATES = new Set(['active', 'background', 'archived', 'candidate']);
const PRIORITIES = new Set(['urgent', 'high', 'normal', 'low']);
const TAGS = new Set(['OKR相关', '紧急', '有卡点', '待决策', '待本人行动']);
const KINDS = new Set(['add', 'keep', 'rename', 'merge', 'split', 'background', 'archive', 'restore']);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

/** Validate cited candidate work structure; optional so existing snapshots remain loadable. */
export function validateWorkStructure(dataset) {
  const structure = dataset?.work_structure;
  if (structure == null) return [];
  const errors = [];
  const fail = (code, path) => errors.push({ code, severity: 'error', path, message: '工作主线结构或引用不符合契约。' });
  if (!structure || typeof structure !== 'object' || Array.isArray(structure)) {
    fail('INVALID_WORK_STRUCTURE', '$.work_structure'); return errors;
  }
  const cases = new Map((dataset.cases || []).map(row => [row.id, row]));
  const refsValid = (ids, allowed) => Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length && ids.every(id => nonempty(id) && allowed.has(id));
  if (structure.version !== 'work-structure-v1') fail('INVALID_WORK_STRUCTURE_VERSION', '$.work_structure.version');
  if (!nonempty(structure.as_of) || !Number.isFinite(Date.parse(structure.as_of))) fail('INVALID_WORK_STRUCTURE_DATE', '$.work_structure.as_of');
  if (!Number.isInteger(structure.display_limit) || structure.display_limit < 1) fail('INVALID_WORK_DISPLAY_LIMIT', '$.work_structure.display_limit');
  if (!Array.isArray(structure.items)) fail('INVALID_WORK_ITEMS', '$.work_structure.items');
  const ids = new Set(), ranks = new Set();
  for (const [i, item] of (Array.isArray(structure.items) ? structure.items : []).entries()) {
    const path = `$.work_structure.items[${i}]`;
    if (!item || typeof item !== 'object') { fail('INVALID_WORK_ITEM', path); continue; }
    if (!cases.has(item.case_id) || ids.has(item.case_id)) fail('INVALID_WORK_CASE', `${path}.case_id`);
    ids.add(item.case_id);
    if (!STATES.has(item.state)) fail('INVALID_WORK_STATE', `${path}.state`);
    if (!PRIORITIES.has(item.priority)) fail('INVALID_WORK_PRIORITY', `${path}.priority`);
    if (!Number.isInteger(item.rank) || item.rank < 1 || ranks.has(item.rank)) fail('INVALID_WORK_RANK', `${path}.rank`);
    ranks.add(item.rank);
    if (!Array.isArray(item.tags) || item.tags.some(tag => !TAGS.has(tag)) || new Set(item.tags).size !== item.tags.length) fail('INVALID_WORK_TAG', `${path}.tags`);
    if (!nonempty(item.reason)) fail('INVALID_WORK_REASON', `${path}.reason`);
    const local = new Set((cases.get(item.case_id)?.evidence || []).map(row => row.id));
    if (!refsValid(item.evidence_ids, local)) fail('INVALID_WORK_EVIDENCE', `${path}.evidence_ids`);
    if (item.last_activity_at !== null && (!nonempty(item.last_activity_at) || !Number.isFinite(Date.parse(item.last_activity_at)))) fail('INVALID_WORK_ACTIVITY_DATE', `${path}.last_activity_at`);
    if (item.goal !== undefined && !nonempty(item.goal)) fail('INVALID_WORK_GOAL', `${path}.goal`);
  }
  if (!Array.isArray(structure.changes)) fail('INVALID_WORK_CHANGES', '$.work_structure.changes');
  for (const [i, change] of (Array.isArray(structure.changes) ? structure.changes : []).entries()) {
    const path = `$.work_structure.changes[${i}]`;
    if (!change || typeof change !== 'object') { fail('INVALID_WORK_CHANGE', path); continue; }
    if (!KINDS.has(change.kind)) fail('INVALID_WORK_CHANGE_KIND', `${path}.kind`);
    if (!nonempty(change.reason)) fail('INVALID_WORK_CHANGE_REASON', `${path}.reason`);
    for (const key of ['from_case_ids', 'to_case_ids']) if (!Array.isArray(change[key]) || change[key].some(id => !cases.has(id))) fail('INVALID_WORK_CHANGE_CASE', `${path}.${key}`);
    const involvedEvidence = new Set([...(change.from_case_ids || []), ...(change.to_case_ids || [])]
      .flatMap(id => (cases.get(id)?.evidence || []).map(row => row.id)));
    if (!refsValid(change.evidence_ids, involvedEvidence)) fail('INVALID_WORK_CHANGE_EVIDENCE', `${path}.evidence_ids`);
  }
  if (!structure.coverage || !Array.isArray(structure.coverage.notes) || structure.coverage.notes.some(note => !nonempty(note))) fail('INVALID_WORK_COVERAGE', '$.work_structure.coverage');
  return errors;
}

/** Fail closed on missing dependencies. Input cases must already be permission-filtered. */
export function projectWorkStructure(dataset) {
  const structure = dataset?.work_structure;
  if (!structure || !Array.isArray(structure.items)) return undefined;
  const cases = new Map((dataset.cases || []).map(row => [row.id, new Set((row.evidence || []).map(item => item.id))]));
  const complete = (ids, allowed) => Array.isArray(ids) && ids.length > 0 && ids.every(id => allowed.has(id));
  const items = structure.items.filter(item => cases.has(item.case_id) && complete(item.evidence_ids, cases.get(item.case_id))).map(item => Object.fromEntries(['case_id', 'state', 'rank', 'priority', 'tags', 'reason', 'evidence_ids', 'last_activity_at', 'goal'].filter(key => Object.hasOwn(item, key)).map(key => [key, structuredClone(item[key])])));
  const visibleCases = new Set(items.map(item => item.case_id));
  const changes = (structure.changes || []).filter(change =>
    [...(change.from_case_ids || []), ...(change.to_case_ids || [])].every(id => visibleCases.has(id))
      && complete(change.evidence_ids, new Set([...(change.from_case_ids || []), ...(change.to_case_ids || [])]
        .flatMap(id => [...(cases.get(id) || [])])))
  ).map(change => Object.fromEntries(['kind', 'from_case_ids', 'to_case_ids', 'reason', 'evidence_ids'].map(key => [key, structuredClone(change[key])])));
  // Coverage notes can also mention private sources, so only expose this fixed safe boundary.
  return { version: structure.version, as_of: structure.as_of, display_limit: structure.display_limit, items, changes,
    coverage: { notes: ['仅展示当前允许访问且依据完整的工作主线；资料缺失不代表事项没有进展。'] } };
}
