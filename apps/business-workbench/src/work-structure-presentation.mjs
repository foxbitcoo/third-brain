// This view only applies an evidence-backed ordering supplied by the dataset.
// It never derives importance, inactivity or completion from dates or keywords.
const states = new Set(['active', 'background', 'archived', 'candidate']);
const priorities = new Set(['urgent', 'high', 'normal', 'low']);
const allowedTags = new Set(['OKR相关', '紧急', '有卡点', '待决策', '待本人行动']);
const changeNames = { add: '新增', keep: '保留', rename: '更名', merge: '合并', split: '拆分', background: '退后展示', archive: '归档', restore: '恢复' };
export const workStateNames = { active: '进行中', background: '后续关注', archived: '已归档', candidate: '待确认' };
export const priorityNames = { urgent: '紧急', high: '优先跟进', normal: '常规', low: '低优先' };

export function workStructureCitations(dataset, change) {
  // The same evidence ID can mean different records in different cases. Retain
  // its owning case rather than opening the first global ID match.
  const ids = new Set([...(change.from_case_ids || []), ...(change.to_case_ids || [])]);
  return dataset.cases.filter(item => ids.has(item.id)).flatMap(item =>
    (change.evidence_ids || []).filter(id => item.evidence.some(e => e.id === id)).map(id => ({ item, id })));
}

export function buildWorkStructureView(dataset, { present = value => String(value || ''), search = '', match = item => `${item.title} ${item.question}` } = {}) {
  const cases = dataset.cases || [];
  const caseById = new Map(cases.map(item => [item.id, item]));
  const structure = dataset.work_structure;
  const metadataById = new Map();
  const fallback = () => {
    const filtered = cases.filter(item => present(match(item)).toLowerCase().includes(present(search).toLowerCase()));
    const navigationCases=filtered.slice(0,10);
    return { enabled: false, orderedCases: cases, activeCases: filtered, deferredCases: [], visibleCases: search.trim()?filtered:navigationCases, navigationCases, secondaryCases: filtered.slice(10), hiddenActiveCount: search.trim()?0:Math.max(0,filtered.length-10), urgentOverflow: 0, metadataById: new Map(), changes: [], notes: [] };
  };
  if (structure?.version !== 'work-structure-v1' || !Array.isArray(structure.items) || !structure.items.length || !Number.isInteger(structure.display_limit) || structure.display_limit < 1) return fallback();
  for (const row of structure.items) {
    if (!row || typeof row !== 'object') return fallback();
    const item = caseById.get(row.case_id);
    if (!item || metadataById.has(row.case_id) || !states.has(row.state) || !priorities.has(row.priority) || !Number.isInteger(row.rank) || row.rank < 1 || typeof row.reason !== 'string' || !row.reason.trim() || !Array.isArray(row.evidence_ids) || !row.evidence_ids.length || row.evidence_ids.some(id => !item.evidence.some(e => e.id === id))) return fallback();
    metadataById.set(row.case_id, { ...row, reason: present(row.reason), goal: row.goal ? present(row.goal) : '', tags: (Array.isArray(row.tags) ? row.tags : []).filter(tag => allowedTags.has(tag)) });
  }
  const order = item => metadataById.get(item.id)?.rank ?? Number.MAX_SAFE_INTEGER;
  const priorityOrder = item => ({urgent:0, high:1, normal:2, low:3})[metadataById.get(item.id)?.priority] ?? 4;
  const deferred = item => metadataById.get(item.id)?.priority !== 'urgent'
    && ['background', 'archived', 'candidate'].includes(metadataById.get(item.id)?.state);
  const orderedCases = [...cases].sort((a, b) => Number(deferred(a)) - Number(deferred(b)) || priorityOrder(a) - priorityOrder(b) || order(a) - order(b));
  const filtered = orderedCases.filter(item => present(match(item)).toLowerCase().includes(present(search).toLowerCase()));
  const activeCases = filtered.filter(item => !deferred(item));
  const deferredCases = filtered.filter(deferred);
  const limit = Math.min(10, structure.display_limit);
  // Search can reach all retained work. The focus panel has a hard ten-item ceiling.
  const visibleCases = search.trim() ? activeCases : activeCases.slice(0, limit);
  const changes = (Array.isArray(structure.changes) ? structure.changes : []).filter(change => {
    if (!change || !Array.isArray(change.from_case_ids) || !Array.isArray(change.to_case_ids) || !Array.isArray(change.evidence_ids)) return false;
    const ids = [...change.from_case_ids, ...change.to_case_ids];
    return changeNames[change.kind] && change.kind !== 'keep' && typeof change.reason === 'string' && ids.length && ids.every(id => caseById.has(id));
  }).map(change => ({ ...change, label: changeNames[change.kind], reason: present(change.reason), references: workStructureCitations(dataset, change) }));
  const navigationCases=activeCases.slice(0,10);
  const secondaryCases=[...activeCases.slice(10),...deferredCases];
  return { enabled: true, orderedCases, activeCases, deferredCases, visibleCases, navigationCases, secondaryCases, hiddenActiveCount: activeCases.length - visibleCases.length, urgentOverflow: search.trim() ? 0 : Math.max(0, visibleCases.length - Math.min(limit, activeCases.length)), metadataById, changes, notes: (Array.isArray(structure.coverage?.notes) ? structure.coverage.notes : []).filter(note => typeof note === 'string').map(present) };
}
