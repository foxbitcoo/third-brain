import { discoveryActiveStatuses } from './discovery-presentation.mjs';

const stoppedReasons = {
  BUSINESS_INPUT_REQUIRED: '继续分析需要补充业务事实。', SOURCE_DEFINITION_REQUIRED: '指标口径或数据来源尚待确认。',
  SOURCE_DEFINITION_CHANGED: '取数口径版本已变化，需要核对后重新分析。', UNAPPROVED_RECIPE: '当前问题没有匹配已核验的查数方案。',
  QUERY_EXECUTION_UNCONFIRMED: '上次查数是否完成尚未确认，暂不重复提交。', MODEL_EXECUTION_UNCONFIRMED: '上次分析调用是否完成尚未确认。',
  ROUND_LIMIT: '已达到本次分析轮数。', QUERY_LIMIT: '已达到本次查数次数。', MODEL_CALL_LIMIT: '已达到本次模型调用次数。',
  DUPLICATE_QUERY_PLAN: '后续方案与已完成的查数重复，需要补充其他分析方向。', SOURCE_POLICY_CHANGED: '来源权限或关注设置已变化。',
  RATE_LIMITED: '查数或分析服务限流，本次任务已停止。', CANCELLED: '任务已取消。',
};
const stageLabels = { plan: '制定查数方案', query: '德普查数', review: '评估结果', report: '报告待审' };
export function agentRunProgress(run) {
  const rounds = Array.isArray(run?.rounds) ? run.rounds : [];
  const last = rounds.at(-1);
  const betweenRounds = ['PLANNING', 'CONTINUE', 'QUEUED'].includes(run?.status) && (!last || last.status === 'REVIEWED');
  const currentRound = betweenRounds ? null : last;
  const active = discoveryActiveStatuses.has(run?.status);
  const unknownQuery = run?.status === 'UNKNOWN_EXECUTION' || !active && (Boolean(run?.inflight) || rounds.some(round => round.status === 'QUERYING'));
  let current = 'plan';
  if (unknownQuery || ['PLANNED', 'RUNNING_QUERY', 'UNKNOWN_EXECUTION'].includes(run?.status)) current = 'query';
  else if (['QUERIED', 'RUNNING_REVIEW', 'REVIEWING'].includes(run?.status)) current = 'review';
  else if (!active && run?.report) current = 'report';
  const states = {
    plan: currentRound?.plan ? '完成' : current === 'plan' && active ? '进行中' : '未记录',
    query: unknownQuery ? '结果待确认' : currentRound?.result?.status === 'VERIFIED' ? '已取得回执' : current === 'query' && active ? '进行中' : '未执行',
    review: currentRound?.review ? '已形成判断' : current === 'review' && active ? '进行中' : '未执行',
    report: run?.status === 'REVIEW_READY' ? '待人工评阅' : run?.report ? '阶段报告' : '未形成',
  };
  return { active, current, round: betweenRounds ? rounds.length + 1 : last?.index || rounds.length,
    title: unknownQuery ? '查数状态待核实' : active ? stageLabels[current] : run?.status === 'REVIEW_READY' ? '报告待审' : '分析已停止',
    reason: stoppedReasons[run?.error?.code] || (run?.status === 'REVIEW_READY' ? '已形成可评阅草稿，业务因果仍需核对。' : !active ? '请核对阶段结果与待补充事项。' : ''),
    stages: Object.entries(stageLabels).map(([id, title]) => ({ id, title, status: states[id] })) };
}
export function agentRoundChecks(round) {
  const supplied = Array.isArray(round?.checks) ? round.checks : Array.isArray(round?.evaluation?.checks) ? round.evaluation.checks : [];
  return supplied.map(check => ({ ...check, status: ['PASS', 'FAIL', 'NOT_RUN'].includes(check.status) ? check.status : 'NOT_RECORDED',
    label: ({ PASS: '通过', FAIL: '未通过', NOT_RUN: '未执行' })[check.status] || '未记录' }));
}
export function agentRuleSnapshot(run) {
  const snapshot = run?.agentSnapshot;
  if (!snapshot) return { recorded: false, text: '历史任务未记录 Agent 规范版本。' };
  return { recorded: true, version: snapshot.version, skill: snapshot.skill || {}, text: snapshot.title || '分析 Agent' };
}
export function knowledgeBytes(value) { return new TextEncoder().encode(value || '').length; }
export function shouldPollAgent(run, { masked = false, error = false, pageVisible = true, startedAt, now = Date.now(), requests = 0 } = {}) {
  return !masked && !error && pageVisible && Boolean(run?.id) && discoveryActiveStatuses.has(run.status) && requests < 180 && Number.isFinite(startedAt) && now - startedAt < 10 * 60 * 1000;
}
