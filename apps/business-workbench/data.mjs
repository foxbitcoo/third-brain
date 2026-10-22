import { validateWorkStructure } from './work-structure.mjs';

/**
 * Structural errors stop loading. Evidence/audit diagnostics remain visible so
 * the workbench can expose unreliable answers without silently repairing them.
 * Diagnostic paths contain fixed field names and array indexes, never data.
 */
export function validateDataset(data) {
  const errors = [];
  const diagnostics = [];
  const error = (code, path, message = '字段类型或取值不符合数据契约。') => {
    if (errors.length < 200) errors.push({ code, severity: 'error', path, message });
  };
  const warn = (code, path, message) => {
    if (diagnostics.length < 200) diagnostics.push({ code, severity: 'warning', path, message });
  };
  const object = (value, path) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return true;
    error('EXPECTED_OBJECT', path);
    return false;
  };
  const string = (value, path) => {
    if (typeof value === 'string' && value.trim().length > 0) return true;
    error('EXPECTED_STRING', path);
    return false;
  };
  const list = (value, path) => {
    if (Array.isArray(value)) return value;
    error('EXPECTED_ARRAY', path);
    return [];
  };
  const oneOf = (value, allowed, path) => {
    if (!allowed.includes(value)) error('INVALID_VALUE', path);
  };
  const timestamp = (value, path) => {
    const time = parseTimestamp(value);
    if (time === undefined) error('INVALID_TIMESTAMP', path, '时间需为带时区的有效 ISO8601 日期时间。');
    return time;
  };
  const identified = (items, path, visit) => {
    const seen = new Set();
    list(items, path).forEach((item, index) => {
      const itemPath = `${path}[${index}]`;
      if (!object(item, itemPath)) return;
      if (string(item.id, `${itemPath}.id`)) {
        if (seen.has(item.id)) error('DUPLICATE_ID', `${itemPath}.id`, '同一范围内的标识必须唯一。');
        seen.add(item.id);
      }
      visit(item, itemPath);
    });
    return seen;
  };

  if (!object(data, '$')) return { valid: false, errors, diagnostics };
  if (data.schema_version !== 'business-qa-v1') {
    error('INVALID_SCHEMA', '$.schema_version', '数据需要使用 business-qa-v1 格式。');
  }
  string(data.dataset_id, '$.dataset_id');
  const datasetCutoff = timestamp(data.as_of, '$.as_of');
  identified(data.cases, '$.cases', (item, casePath) => {
    for (const key of ['title', 'question', 'scope']) string(item[key], `${casePath}.${key}`);
    const caseCutoff = timestamp(item.as_of, `${casePath}.as_of`);
    if (caseCutoff > datasetCutoff) warn('CASE_AFTER_DATASET_CUTOFF', `${casePath}.as_of`, '题目的截止时间晚于数据集截止时间。');
    const evidenceIds = identified(item.evidence, `${casePath}.evidence`, (evidence, evidencePath) => {
      for (const key of ['source_title', 'speaker', 'text', 'locator']) string(evidence[key], `${evidencePath}.${key}`);
      oneOf(evidence.source_type, ['im', 'document', 'transcript', 'calendar'], `${evidencePath}.source_type`);
      const occurredAt = evidence.source_type === 'document' && evidence.occurred_at === null ? null : timestamp(evidence.occurred_at, `${evidencePath}.occurred_at`);
      if (occurredAt > caseCutoff) warn('EVIDENCE_AFTER_CASE_CUTOFF', `${evidencePath}.occurred_at`, '这条证据晚于题目截止时间。');
      if (occurredAt > datasetCutoff) warn('EVIDENCE_AFTER_DATASET_CUTOFF', `${evidencePath}.occurred_at`, '这条证据晚于数据集截止时间。');
      if (evidence.url != null && typeof evidence.url !== 'string') error('EXPECTED_STRING', `${evidencePath}.url`);
      if (typeof evidence.url === 'string' && evidence.url.length > 0 && !safeSourceUrl(evidence.url)) {
        warn('UNSAFE_SOURCE_URL', `${evidencePath}.url`, '来源链接格式不安全，界面应禁用外链。');
      }
    });
    identified(item.runs, `${casePath}.runs`, (run, runPath) => {
      for (const key of ['model', 'provider']) string(run[key], `${runPath}.${key}`);
      oneOf(run.route, ['A', 'B', 'C'], `${runPath}.route`);
      oneOf(run.status, ['VERIFIED', 'FAILED', 'BLOCKED', 'NOT_RUN'], `${runPath}.status`);
      if (object(run.metrics, `${runPath}.metrics`)) {
        for (const key of ['latency_ms', 'input_tokens', 'output_tokens', 'cost_cny']) {
          const value = run.metrics[key];
          if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0
            || (key.endsWith('_tokens') && !Number.isInteger(value)))) {
            error('INVALID_METRIC', `${runPath}.metrics.${key}`, '指标需为非负数或 null，Token 数需为整数。');
          }
        }
      }
      if (object(run.audit, `${runPath}.audit`)) {
        oneOf(run.audit.citations, ['valid', 'invalid', 'not_checked'], `${runPath}.audit.citations`);
        oneOf(run.audit.review_status, ['PENDING_ROOT', 'REVIEWED', 'PENDING_USER'], `${runPath}.audit.review_status`);
        if (run.audit.citations === 'invalid') warn('CITATIONS_MARKED_INVALID', `${runPath}.audit.citations`, '这份回答已被标记为引用无效。');
      }
      // A failed or unexecuted route may have no answer. Authored demo answers
      // can also coexist with NOT_RUN; a display must not upgrade that status.
      if (run.answer == null && run.status !== 'VERIFIED') return;
      if (!object(run.answer, `${runPath}.answer`)) return;
      string(run.answer.summary, `${runPath}.answer.summary`);
      for (const section of ['developments', 'viewpoints', 'decisions', 'open_questions', 'next_steps']) {
        const sectionPath = `${runPath}.answer.${section}`;
        list(run.answer[section], sectionPath).forEach((claim, index) => {
          const claimPath = `${sectionPath}[${index}]`;
          if (!object(claim, claimPath)) return;
          string(claim.text, `${claimPath}.text`);
          if (section === 'viewpoints') string(claim.person, `${claimPath}.person`);
          if (section === 'next_steps') oneOf(claim.kind, ['source_task', 'assistant_suggestion'], `${claimPath}.kind`);
          list(claim.evidence_ids, `${claimPath}.evidence_ids`).forEach((id, citationIndex) => {
            const citationPath = `${claimPath}.evidence_ids[${citationIndex}]`;
            if (string(id, citationPath) && !evidenceIds.has(id)) {
              warn('UNKNOWN_EVIDENCE_REFERENCE', citationPath, '引用未匹配到本题目的证据，不能据此核验事实。');
            }
          });
        });
      }
    });
  });
  for (const issue of validateWorkStructure(data)) {
    error(issue.code || 'INVALID_WORK_STRUCTURE', issue.path || '$.work_structure', issue.message);
  }
  return { valid: errors.length === 0, errors, diagnostics };
}

function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseTimestamp(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second = '0'] = match;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}
