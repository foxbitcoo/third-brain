import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sanitizeText } from './live-qa.mjs';

export const DIAGNOSTIC_SKILL_PATH = new URL('../../skills/data-diagnostic-agent/SKILL.md', import.meta.url);
export const KNOWLEDGE_MAX_BYTES = 6 * 1024;
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const invalid = code => { throw Object.assign(new Error(code), { code }); };

export async function loadDiagnosticAgent(path = DIAGNOSTIC_SKILL_PATH) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 24_000) invalid('AGENT_SPEC_INVALID');
  const markdown = await readFile(path, 'utf8');
  const version = markdown.match(/^version: ([\d]+\.[\d]+\.[\d]+)\s*$/m)?.[1];
  if (!version || !markdown.startsWith('---\n')) invalid('AGENT_SPEC_INVALID');
  return { id: 'data-diagnostic-agent', title: '业务数据诊断 Agent', version,
    skill: { id: 'data-diagnostic-agent', title: '业务数据诊断', version, markdown, sha256: digest(markdown) },
    tools: [
      { id: 'plan', title: '问题与查询规划', kind: 'internal', description: '模型核对原问题与口径，选择来源中已授权的固定查询方案。' },
      { id: 'prompt_analysis', title: 'Delper 问题登记', kind: 'external', description: '登记问题与本轮查询上下文；不代表已经取回数据。' },
      { id: 'execute_raw_sql', title: 'Delper 只读 SQL', kind: 'external', description: '仅执行来源绑定、已核验的固定只读方案。' },
      { id: 'execute_event_analytics', title: 'Delper 事件分析', kind: 'external', description: '仅执行来源已配置的结构化事件查询；可用性以当前方案与连接为准。' },
      { id: 'review', title: '结果核查与报告', kind: 'internal', description: '模型解释已查回的结果，形成草稿并判断继续、待审或需要补充。' },
    ],
    loop: { stages: [
      { id: 'resolve', title: '原问题与口径' }, { id: 'plan', title: '规划查询' },
      { id: 'query', title: '只读取数' }, { id: 'review', title: '核查与报告' },
      { id: 'decision', title: '继续或结束' },
    ], mode: 'manual', bounded: true, maxRounds: 3, maxQueries: 3, maxModelCalls: 7,
      continuation: '仅在有明确价值的已授权下一查询、且未达到限制时继续。',
      stopping: ['待审草稿', '需要补充口径或业务事实', '达到轮次或调用限制', '执行失败或结果未知', '取消或来源权限变化'] },
    evaluation: [
      { id: 'execution', title: '执行与结果范围', kind: 'programmatic', description: '工具回执、成功状态、行数与覆盖范围校验。' },
      { id: 'citations', title: '依据引用', kind: 'programmatic', description: '报告发现只能引用真实查询回执。' },
      { id: 'numbers', title: '数值护栏', kind: 'programmatic', description: '支持的日对照或维度视图使用程序计算事实，模型不能改写数值。' },
      { id: 'answer', title: '原问题与继续判断', kind: 'model', description: '同一模型在复核阶段判断解释是否充分；不是独立模型效果评分或因果认证。' },
    ],
  };
}

/** Knowledge is user data, not executable policy or source authorization. */
export function createKnowledgeSnapshot(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > KNOWLEDGE_MAX_BYTES || value.includes('\0')) invalid('INVALID_DISCOVERY_REQUEST');
  const markdown = sanitizeText(value.trim());
  return markdown ? { markdown, sha256: digest(markdown) } : null;
}

/** Derive display checks from retained receipts; never manufacture historical executions. */
export function diagnosticRunView(run, source) {
  const view = structuredClone(run);
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const validResult = result => result?.status === 'VERIFIED' && text(result.receiptId) && text(result.queryHash)
    && Array.isArray(result.columns) && result.columns.length > 0 && result.columns.length <= 200 && result.columns.every(text)
    && Array.isArray(result.records) && result.records.length <= Math.min(2000, view.limits?.maxRows || 2000)
    && result.records.every(row => row !== null && typeof row === 'object');
  const receipts = new Set((view.rounds || []).filter(r => validResult(r.result)).map(r => r.result.receiptId));
  for (const round of view.rounds || []) {
    round.checksValidation = { basis: 'READ_TIME_VALIDATION', checkedAt: new Date().toISOString() };
    const result = round.result;
    const findings = round.review?.findings;
    const citations = Array.isArray(findings) && findings.length > 0;
    const citationsValid = citations && findings.every(f => f && Array.isArray(f.evidenceIds) && f.evidenceIds.length && f.evidenceIds.every(id => receipts.has(id)));
    const bindingRecorded = text(view.sourceVersion) && text(round.plan?.recipeId) && source;
    const bindingValid = bindingRecorded && source.version === view.sourceVersion && source.id === view.sourceId && source.recipes?.some(r => r.id === round.plan.recipeId);
    round.checks = [
      { id: 'execution', title: '查询回执', status: result ? validResult(result) ? 'PASS' : 'FAIL' : round.status === 'FAILED' ? 'FAIL' : 'NOT_RUN', message: result ? '按当前保存记录核对成功状态、回执、查询标识、列与行范围；不据此证明全天到数完整。' : '尚无已验证的查询结果。' },
      { id: 'source', title: '来源与查询方案', status: bindingRecorded ? bindingValid ? 'PASS' : 'FAIL' : 'NOT_RECORDED', message: bindingRecorded ? '将记录的来源版本和查询方案与当前获准来源核对。' : '来源版本或查询方案记录不足，仍需核对。' },
      { id: 'citations', title: '报告引用', status: citations ? citationsValid ? 'PASS' : 'FAIL' : 'NOT_RUN', message: citations ? '逐项核对发现引用是否来自本任务的真实回执。' : '尚无可核对的报告发现。' },
      { id: 'numbers', title: '独立数值核验', status: 'NOT_RECORDED', message: '任务未单独保存数值校验回执；可回查原始结果，不将模型复核视为独立数值验收。' },
    ];
    round.checks = round.checks.map(check => ({ ...check, ...round.checksValidation }));
  }
  return view;
}
