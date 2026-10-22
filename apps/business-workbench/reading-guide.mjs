// Optional reading cards. Validation checks bindings and safe display limits;
// content_kind identifies their declared origin, not business accuracy or acceptance.
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const boundedText = (value, maximum) => typeof value === 'string' && value.trim().length > 0
  && [...value].length <= maximum && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);

function validLink(value) {
  if (!boundedText(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

export function validReadingGuide(guide, dataset) {
  const guideKeys = ['schema_version', 'dataset_id', 'cases'];
  if (isRecord(guide) && Object.hasOwn(guide, 'content_kind')) guideKeys.push('content_kind');
  if (!exactKeys(guide, guideKeys)
    || (Object.hasOwn(guide, 'content_kind') && !['assistant_reading_guide', 'model_generated_short_card'].includes(guide.content_kind))
    || guide.schema_version !== 'business-reading-guide-v1' || guide.dataset_id !== dataset.dataset_id
    || !Array.isArray(guide.cases) || !guide.cases.length || guide.cases.length > dataset.cases.length) return false;
  const seen = new Set();
  for (const row of guide.cases) {
    if (!exactKeys(row, ['case_id', 'run_id', 'comparison_run_id', 'title', 'current', 'follow_up', 'confirm', 'boundary', 'answer_url'])
      || seen.has(row.case_id) || !boundedText(row.title, 80)
      || (row.answer_url !== null && !validLink(row.answer_url))) return false;
    seen.add(row.case_id);
    const item = dataset.cases.find(item => item.id === row.case_id);
    if (!item || row.run_id === row.comparison_run_id) return false;
    const candidateIds = row.comparison_run_id === null ? [row.run_id] : [row.run_id, row.comparison_run_id];
    for (const id of candidateIds) {
      if (!item.runs.some(run => run.id === id && run.status === 'VERIFIED' && run.answer)) return false;
    }
    const evidence = new Set(item.evidence.map(row => row.id));
    for (const key of ['current', 'follow_up', 'confirm', 'boundary']) {
      const line = row[key];
      const keys = key === 'follow_up' ? ['person', 'text', 'evidence_ids'] : ['text', 'evidence_ids'];
      if (!exactKeys(line, keys) || !boundedText(line.text, 240)
        || (key === 'follow_up' && !boundedText(line.person, 80))
        || !Array.isArray(line.evidence_ids) || line.evidence_ids.length < 1 || line.evidence_ids.length > 12
        || new Set(line.evidence_ids).size !== line.evidence_ids.length
        || line.evidence_ids.some(id => !evidence.has(id))) return false;
    }
  }
  return true;
}
