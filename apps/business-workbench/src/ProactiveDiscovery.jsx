import React, { useEffect, useId, useRef, useState } from 'react';
import Button from '@douyinfe/semi-ui/lib/es/button/index.js';
import Select from '@douyinfe/semi-ui/lib/es/select/index.js';
import Table from '@douyinfe/semi-ui/lib/es/table/index.js';
import Tag from '@douyinfe/semi-ui/lib/es/tag/index.js';
import TextArea from '@douyinfe/semi-ui/lib/es/input/textarea.js';
import Steps from '@douyinfe/semi-ui/lib/es/steps/index.js';
import { cleanMentions } from './presentation.mjs';
import { IconRefresh } from '@douyinfe/semi-icons';
import { discoveryStatusLabels, discoveryActiveStatuses, discoveryDecisionLabels, discoveryTable, discoveryText, discoveryChart } from './discovery-presentation.mjs';

import { agentRunProgress, agentRoundChecks, agentRuleSnapshot, knowledgeBytes, shouldPollAgent } from './agent-run-presentation.mjs';
import HistoricalTickets from './HistoricalTickets.jsx';
import BoardPreview from './BoardPreview.jsx';
import AgentLoopGuide from './AgentLoopGuide.jsx';
import { RunMemory } from './DiagnosticMemory.jsx';
import { boardSubmissionContext, selectedBoardSnapshot } from './memory-review-presentation.mjs';

const labelFor = status => discoveryStatusLabels[status] || '状态待核实';
const dateFor = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '时间未知';
const hiddenStatuses = new Set(['SUPPRESSED', 'SOURCE_REVOKED']);
const continuationStatuses = new Set(['NEEDS_HUMAN', 'NEEDS_DEFINITION', 'PAUSED_LIMIT', 'CANCELLED']);

function Lines({ title, values }) {
  if (!Array.isArray(values) || !values.length) return null;
  return <section className="answer-section"><h3>{title}</h3><ul>{values.map((value, index) => <li className="answer-line" key={index}>{discoveryText(value)}</li>)}</ul></section>;
}

const receiptAnchor = id => `discovery-receipt-${encodeURIComponent(id)}`;
function openReceipt(event, id) {
  const target = document.getElementById(receiptAnchor(id));
  if (!target) return;
  event.preventDefault();
  for (let parent = target; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
  target.scrollIntoView({ block: 'center' });
  target.querySelector('summary')?.focus({ preventScroll: true });
}
function Findings({ findings, receipts = [] }) {
  return Array.isArray(findings) && findings.length > 0 && <section className="answer-section"><h3>依据与发现</h3>{findings.map((finding, index) => <p className="answer-line" key={index}>{discoveryText(finding.text)} <small className="muted">依据：{(finding.evidenceIds || []).length ? finding.evidenceIds.map((id, offset) => <React.Fragment key={id}>{offset > 0 && '、'}{receipts.includes(id) ? <a href={`#${encodeURIComponent(receiptAnchor(id))}`} onClick={event => openReceipt(event, id)}>查询依据 {receipts.indexOf(id) + 1}</a> : '待核对'}</React.Fragment>) : '待补充'}</small></p>)}</section>;
}

function QueryResult({ result, receiptNumber }) {
  if (!result) return null;
  const { columns, records } = discoveryTable(result);
  return <><ResultChart result={result} /><details id={receiptAnchor(result.receiptId || 'unverified')} className="answer-section"><summary>查询依据 {receiptNumber || '待核对'} · 原始结果 {records.length} 条</summary>
    <p className="muted">回执：{discoveryText(result.receiptId)} · {result.status === 'VERIFIED' ? '已取得查数回执' : '回执待核实'}</p>
    {result.coverage && <p className="answer-line">数据范围：{discoveryText(result.coverage)}</p>}
    {columns.length > 0 ? <Table size="small" pagination={{ pageSize: 50, showSizeChanger: false }} scroll={{ x: 'max-content' }} dataSource={records} columns={columns.map((column, index) => ({ title: column.name, key: column.key, width: 160, render: (_value, record) => record.cells[index] }))} /> : <p>没有可展示的结构化结果。</p>}
  </details></>;
}

function ResultChart({ result }) {
  const [bucket, setBucket] = useState(undefined);
  const titleId = useId();
  const chart = discoveryChart(result, bucket);
  if (!chart) return null;
  const { points, fields } = chart;
  const maximum = Math.max(1, ...points.flatMap(point => point.values));
  const start = points.length ? Date.parse(points[0].date) : 0;
  const duration = points.length > 1 ? Date.parse(points.at(-1).date) - start : 1;
  const x = point => 65 + (Date.parse(point.date) - start) / duration * 650;
  const y = value => 238 - value / maximum * 190;
  const colors = ['#3370ff', '#249b82'];
  return <section className="answer-section"><h3>原始数据趋势</h3>
    {chart.bucketed && <div className="attention-filters"><label>数据分组 <Select aria-label="趋势图数据分组" value={chart.bucket || undefined} placeholder="选择一个分组，分别查看" optionList={chart.buckets.map(value => ({ value, label: value }))} onChange={setBucket} style={{ minWidth: 220 }} /></label></div>}
    {chart.omittedRows > 0 && <p className="muted">{chart.omittedRows} 条记录的日期或数值格式不符合绘图要求，保留在原始表格中。</p>}
    {chart.bucketed && !chart.bucket ? <p className="muted">当前结果包含多个分组，请选择一个查看；不同分组的 UV 不直接相加。</p> : chart.duplicateDates ? <p className="muted">同一日期有多条记录，请先核对数据粒度；暂不合并绘图。</p> : points.length < 2 ? <p className="muted">当前分组不足两个有效日期，暂不绘制趋势。</p> : <>
      <svg viewBox="0 0 780 320" role="img" aria-labelledby={titleId} style={{ width: '100%', maxWidth: 900 }}>
        <title id={titleId}>{fields.join(' 与 ')} 原始绝对量趋势{chart.bucket ? `，分组 ${chart.bucket}` : ''}</title>
        {[0, .5, 1].map(ratio => <g key={ratio}><line x1="65" x2="715" y1={y(maximum * ratio)} y2={y(maximum * ratio)} stroke="#e2e5eb" /><text x="58" y={y(maximum * ratio) + 4} textAnchor="end" fontSize="11" fill="#646a73">{Math.round(maximum * ratio).toLocaleString('zh-CN')}</text></g>)}
        <line x1="65" x2="65" y1="48" y2="238" stroke="#8a919d" />
        {fields.map((field, index) => <g key={field}><polyline fill="none" stroke={colors[index]} strokeWidth="2" points={points.map(point => `${x(point)},${y(point.values[index])}`).join(' ')} />{points.map(point => <circle key={point.date} cx={x(point)} cy={y(point.values[index])} r="3" fill={colors[index]}><title>{point.date} · {field}：{point.values[index]} · 回执 {point.receiptId}</title></circle>)}<line x1={65 + index * 325} x2={85 + index * 325} y1="302" y2="302" stroke={colors[index]} strokeWidth="2" /><text x={91 + index * 325} y="306" fontSize="11" fill="#42474f">{field}</text></g>)}
        {points.filter((_point, index) => index === 0 || index === points.length - 1 || index % Math.max(1, Math.ceil(points.length / 5)) === 0).map(point => <text key={point.date} x={x(point)} y="258" textAnchor="middle" fontSize="10" fill="#646a73">{point.date}</text>)}
        <text x="65" y="27" fontSize="11" fill="#646a73">绝对量（UV）</text>
      </svg>
      <p className="muted">日期、数值均来自回执 {chart.receiptId}；仅绘制所选分组，不跨分组累计 UV。百分比指标未混入本图。</p>
    </>}
  </section>;
}


function AgentProgress({ run }) {
  const progress = agentRunProgress(run), snapshot = agentRuleSnapshot(run);
  return <section className="answer-section" aria-label="Agent 运行进度"><h3>当前步骤：{progress.title}</h3>
    <Steps type="basic" direction="vertical" size="small">{progress.stages.map(stage => <Steps.Step key={stage.id} title={stage.title} description={stage.status} status={stage.status === '进行中' ? 'process' : stage.status === '结果待确认' ? 'error' : ['完成', '已取得回执', '已形成判断', '待人工评阅'].includes(stage.status) ? 'finish' : 'wait'} />)}</Steps>
    {progress.round > 0 && <p className="muted">当前第 {progress.round} 轮 · 最多 {run.limits?.maxRounds ?? '未记录'} 轮</p>}
    {progress.reason && <p className="guide-boundary">{progress.reason}</p>}
    <details><summary>本任务分析规则</summary>{snapshot.recorded ? <><p className="answer-line">{snapshot.text} · {snapshot.version || '版本未记录'}</p><p className="muted">规范版本：{snapshot.skill.version || '未记录'} · 校验值：{snapshot.skill.sha256 || '未记录'}</p>{snapshot.skill.markdown && <p className="answer-line" style={{ whiteSpace: 'pre-wrap' }}>{snapshot.skill.markdown}</p>}</> : <p className="muted">{snapshot.text}</p>}</details>
  </section>;
}

function RoundEvaluation({ round }) {
  const checks = agentRoundChecks(round);
  return <section className="answer-section"><h3>程序检查</h3>{round.checksValidation?.basis === 'READ_TIME_VALIDATION' && <p className="muted">依据当前保存记录校验 · {dateFor(round.checksValidation.checkedAt)}，不代表历史执行时的检查记录。</p>}{checks.length ? checks.map((check, index) => <p className="answer-line" key={check.id || index}>{check.title || check.id} <Tag>{check.label}</Tag>{check.message && <> · {discoveryText(check.message)}</>}</p>) : <p className="muted">本轮没有保留逐项程序检查记录；不等同于全部通过。</p>}
    <h3>模型判断</h3>{round.review ? <><AnswerCoverage value={round.review.answerCoverage} /><p className="answer-line"><Tag>{discoveryDecisionLabels[round.review.decision] || '判断待核实'}</Tag> {discoveryText(round.review.summary)}</p><p className="muted">此判断来自分析模型，不代表独立的业务因果验证。</p></> : <p className="muted">尚未记录本轮判断。</p>}
  </section>;
}

function AnswerCoverage({ value }) {
  if (!value) return <p className="muted">原问题覆盖情况：本任务未记录，需结合报告核对。</p>;
  return <><p className="answer-line">原问题覆盖：<Tag>{({answered:'已覆盖 · 待审',partial:'部分覆盖',unanswered:'尚未覆盖'})[value.status] || '待核对'}</Tag></p><Lines title="已覆盖" values={value.covered} /><Lines title="未覆盖" values={value.missing} /></>;
}

function RunDetail({ run, sourceTitle, recipes = [], busy, pollStopped, onRefresh, onAction }) {
  const [facts, setFacts] = useState('');
  const factsId = useId();
  const blocked = hiddenStatuses.has(run.status);
  const active = discoveryActiveStatuses.has(run.status);
  const report = run.report;
  const receipts = (run.rounds || []).map(round => round.result?.receiptId).filter(Boolean);
  return <article className="attention-card" aria-label="分析任务详情">
    <header><h2>分析详情</h2><Tag>{labelFor(run.status)}</Tag></header>
    {!blocked && <><h3>{cleanMentions(run.question)}</h3><p className="muted">看板：{sourceTitle || '来源名称待核对'} · 取数版本：{run.sourceVersion || '待核对'}</p><p className="muted">发起于 {dateFor(run.createdAt)} · 更新于 {dateFor(run.updatedAt)}</p>
      {run.facts && <details><summary>补充事实</summary><p className="answer-line">{discoveryText(run.facts)}</p></details>}
    </>}
    <div className="attention-actions"><Button icon={<IconRefresh aria-hidden="true" />} loading={busy} onClick={onRefresh}>刷新进度</Button>{active && <Button type="danger" disabled={busy} onClick={() => onAction('cancel')}>取消分析</Button>}</div>
    {active && <p className="muted">{pollStopped ? '自动刷新已停止，可手动刷新查看进度。' : '进度自动更新；离开页面不会取消任务。'}</p>}
    {blocked ? <p>来源设置已变更，此任务内容暂不展示。请核对信息源权限与关注设置。</p> : <>
      <AgentProgress run={run} />
      {run.route && <p className="muted">问题类型：{({simple:'简单查询',complex:'复杂分析',needs_context:'待补充条件',lookup:'查数',trend:'趋势',attribution:'归因',uncertain:'待明确'})[run.route.kind || run.route.type] || '待明确'} · {run.route.reason || ''}</p>}
      <RunMemory run={run} />
      {run.questionContext && <details className="answer-section"><summary>提问与看板对齐</summary><h3>原始问题</h3><p className="answer-line">{cleanMentions(run.questionContext.originalQuery || run.question)}</p><p className="muted">关联状态：{({BOUND:'已关联',VERIFIED:'已核验',AMBIGUOUS:'待确认',UNBOUND:'未关联',UNRESOLVED:'待对齐'})[run.questionContext.binding?.status] || run.questionContext.binding?.status || '未记录'} · 看板 {run.questionContext.binding?.boardId || '未取得'} · 推送记录 {run.questionContext.binding?.snapshotId || '未取得'}</p><h3>看板与 OCR 补充上下文</h3><p className="answer-line" style={{whiteSpace:'pre-wrap'}}>{run.questionContext.enrichedQuery || '尚未取得识别后的补充上下文'}</p>{(run.questionContext.evidence || []).map((item,index)=><p className="muted" key={index}>{discoveryText(item)}</p>)}<Lines title="仍缺少的条件" values={run.questionContext.missing} /></details>}
      {run.routing && <details className="answer-section"><summary>模型分流判断</summary><p className="answer-line">{discoveryText(run.routing)}</p></details>}
      {run.humanInput && <p className="guide-boundary">待补充：{({business_fact:'业务事实',metric_definition:'指标口径',source_access:'来源权限',query_capability:'查询能力'})[run.humanInput.missingCategory] || '具体条件待核对'}{run.humanInput.capabilityCheck === 'EXISTING_CAPABILITIES_REQUIRE_REVIEW' && '；已有未使用的查数方案，需核对是否适用。'}</p>}
      {run.knowledge?.markdown && <details className="answer-section"><summary>本次业务知识</summary><p className="answer-line" style={{ whiteSpace: 'pre-wrap' }}>{run.knowledge.markdown}</p><p className="muted">资料校验值：{run.knowledge.sha256 || '未记录'} · 作为业务资料参与分析</p></details>}
      {report && <section className="answer-section"><h3>{run.status === 'REVIEW_READY' ? '报告草稿 · 待审' : '阶段报告 · 尚未完成'}</h3><p className="answer-summary">{discoveryText(report.summary)}</p><AnswerCoverage value={report.answerCoverage} /><Lines title="下一步" values={report.questions?.length ? report.questions : report.remaining} /><details><summary>完整报告与依据</summary><Findings findings={report.findings} receipts={receipts} /><Lines title="业务假设 · 待验证" values={report.hypotheses} /><Lines title="仍需核对" values={report.remaining} /><Lines title="需要补充" values={report.questions} /></details><p className="answer-footnote">结论供人工核对；数据回执与业务因果判断分别保留。</p></section>}
      {!report && !active && <p>尚未形成可评阅的报告。</p>}
      {!report?.questions?.length && <Lines title="需要补充" values={run.questions} />}
      {(run.rounds || []).map((round, index) => <details className="answer-section" key={round.id || index} open={index === (run.rounds || []).length - 1}>
        <summary>第 {index + 1} 轮 · {round.review ? discoveryDecisionLabels[round.review.decision] || '结果待核实' : round.result ? '已取得数据' : '查数准备'}</summary>
        {round.plan?.delperQuery && <section className="answer-section"><h3>标准查数 Query</h3><p className="answer-line" style={{whiteSpace:'pre-wrap'}}>{discoveryText(round.plan.delperQuery)}</p><p className="muted">是否已发送以本轮工具回执为准；生成 Query 不等于取得数据。</p></section>}
        {(round.result?.request || round.result?.dispatch) && <details className="answer-section"><summary>实际发送与工具回执</summary><p className="answer-line" style={{whiteSpace:'pre-wrap'}}>{discoveryText(round.result.request || round.result.dispatch)}</p></details>}
        {round.plan?.reason && <p className="answer-line"><strong>本轮问题：</strong>{round.plan.reason}</p>}
        {round.plan?.recipeId && <p className="answer-line"><strong>查数方案：</strong>{recipes.find(recipe => recipe.id === round.plan.recipeId)?.title || round.plan.recipeId}</p>}
        {round.plan?.callReceipt && <p className="muted">方案已取得模型调用回执 · {round.plan.callReceipt.model || '模型未记录'}</p>}
        {round.plan?.hypothesis && <p className="answer-line"><strong>待验证假设：</strong>{round.plan.hypothesis}</p>}
        <p className="answer-line"><strong>已获得结果：</strong>{round.result?.status === 'VERIFIED' ? `已取得查数回执，共 ${round.result.records?.length ?? 0} 条记录` : run.inflight?.round === round.index ? '查数结果尚未确认' : '尚未取得有效查数回执'}</p>
        <RoundEvaluation round={round} />
        <QueryResult result={round.result} receiptNumber={receipts.indexOf(round.result?.receiptId) + 1} />
        {round.review && <><Findings findings={round.review.findings} receipts={receipts} /><Lines title="仍需核对" values={round.review.remaining} /><Lines title="需要补充" values={round.review.questions} /></>}
      </details>)}
      {run.status === 'UNKNOWN_EXECUTION' && <p className="guide-boundary">上一次查数是否执行完成尚未确认。请先核对回执，暂不重复提交。</p>}
      {run.status === 'PAUSED_LIMIT' && <p className="guide-boundary">已达到本次次数或预算范围。补充事实不会自动增加预算或查询次数。</p>}
      {run.usage && <details className="answer-section"><summary>本次用量</summary><p>查数 {run.usage.queries ?? '待核对'} 次 · 模型调用 {run.usage.modelCalls ?? '待核对'} 次</p>{(run.usage.receipts || []).map((receipt, index) => <p className="muted" key={index}>第 {receipt.round ?? '—'} 轮 · {receipt.model || '模型待核对'} · 输入 {receipt.promptTokens ?? '待核对'} / 输出 {receipt.completionTokens ?? '待核对'} token · 费用估算上限 {Number.isFinite(receipt.estimatedPeakCny) ? `¥${receipt.estimatedPeakCny.toFixed(4)}` : '待核对'}</p>)}<p className="muted">费用按调用回执与当前价格估算，不代表实际结算账单。</p></details>}
      {(continuationStatuses.has(run.status) || run.canResume) && !run.inflight && <section className="answer-section"><label htmlFor={factsId}>补充业务事实</label><TextArea id={factsId} value={facts} maxLength={8000} rows={3} onChange={setFacts} placeholder="例如：已确认的发版日期、平台迁移或指标口径；请注明时间与来源。" /><div className="attention-actions"><Button theme="solid" disabled={busy || !facts.trim()} onClick={async () => { if (await onAction('resume', facts.trim())) setFacts(''); }}>补充事实继续</Button></div></section>}
    </>}
  </article>;
}

export default function ProactiveDiscovery({ masked }) {
  const [historyQuestion,setHistoryQuestion]=useState(null);
  const [boardData,setBoardData]=useState(null), [boardError,setBoardError]=useState(''), [snapshotId,setSnapshotId]=useState('');
  const [data, setData] = useState(null), [run, setRun] = useState(null), [selectedId, setSelectedId] = useState('');
  const [sourceId, setSourceId] = useState(''), [question, setQuestion] = useState(''), [facts, setFacts] = useState(''), [knowledge, setKnowledge] = useState('');
  const [pollStopped, setPollStopped] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== 'hidden');
  const pollWindow = useRef({ id: '', startedAt: 0, requests: 0 }), pendingRequests = useRef(0), requestQueue = useRef(Promise.resolve());
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const formId = useId(), generation = useRef(0), controller = useRef(null), detailRequest = useRef(0), currentId = useRef('');
  const maskedRef = useRef(masked);
  maskedRef.current = masked;
  useEffect(() => {
    const updateVisibility = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  async function request(url, options = {}) {
    pendingRequests.current++;
    const signal = options.signal || controller.current?.signal;
    const execute = async () => {
      const response = await fetch(url, { cache: 'no-store', ...options, signal });
      const body = await response.json();
      if (!response.ok) throw new Error('DISCOVERY_REQUEST_FAILED');
      return body;
    };
    const pending = requestQueue.current.then(execute, execute);
    requestQueue.current = pending.catch(() => {});
    try { return await pending; } finally { pendingRequests.current--; }
  }
  async function refresh(id = currentId.current) {
    const version = generation.current, detailVersion = ++detailRequest.current;
    setBusy(true); setError(''); setPollStopped(false);
    if (id) pollWindow.current = { id, startedAt: Date.now(), requests: 0 };
    try {
      const next = await request('/api/discovery');
      if (version !== generation.current || maskedRef.current) return;
      setData(next);
      try {
        const boards=await request('/api/discovery-boards');
        if(version!==generation.current || maskedRef.current)return;
        setBoardData(boards);setBoardError('');
      } catch(cause) {
        if(version!==generation.current || maskedRef.current)return;
        setBoardData(null);setBoardError('看板原图暂时无法读取，请重新刷新。');
      }
      setRun(null);
      const target = id || next.runs?.[0]?.id;
      if (target) {
        const detail = await request(`/api/discovery?id=${encodeURIComponent(target)}`);
        if (version !== generation.current || maskedRef.current || detailVersion !== detailRequest.current) return;
        currentId.current = target; setSelectedId(target); setRun(detail.run || null);
      } else { currentId.current = ''; setSelectedId(''); setRun(null); }
    } catch (cause) {
      if (cause.name !== 'AbortError' && version === generation.current && !maskedRef.current) setError('分析任务暂时无法读取，请重新刷新。');
    } finally { if (version === generation.current) setBusy(false); }
  }
  useEffect(() => {
    generation.current++; controller.current?.abort(); controller.current = new AbortController();
    setData(null); setBoardData(null);setBoardError('');setRun(null); currentId.current = ''; setSelectedId(''); setError(''); setBusy(false);
    if (masked) { setQuestion(''); setFacts(''); setKnowledge(''); setSourceId(''); setSnapshotId(''); } else refresh('');
    return () => { generation.current++; controller.current?.abort(); };
  }, [masked]);

  useEffect(() => {
    if (masked || !pageVisible || !run?.id || !discoveryActiveStatuses.has(run.status) || error) return;
    if (pollWindow.current.id !== run.id) pollWindow.current = { id: run.id, startedAt: Date.now(), requests: 0 };
    const version = generation.current, id = run.id;
    const abort = new AbortController();
    let timer, stopped = false;
    const schedule = () => { timer = setTimeout(update, 3000); };
    const update = async () => {
      if (stopped || version !== generation.current || currentId.current !== id || maskedRef.current) return;
      if (!shouldPollAgent(run, { ...pollWindow.current, masked: maskedRef.current, pageVisible })) { setPollStopped(true); return; }
      if (pendingRequests.current || busy) { schedule(); return; }
      const detailVersion = detailRequest.current;
      try {
        pollWindow.current.requests++;
        const detail = await request(`/api/discovery?id=${encodeURIComponent(id)}`, { signal: abort.signal });
        if (stopped || version !== generation.current || currentId.current !== id || detailVersion !== detailRequest.current || maskedRef.current) return;
        setRun(detail.run || null);
        setData(previous => previous ? { ...previous, runs: (previous.runs || []).map(item => item.id === id ? { ...item, status: detail.run?.status || item.status, updatedAt: detail.run?.updatedAt || item.updatedAt } : item) } : previous);
        if (!detail.run || !discoveryActiveStatuses.has(detail.run.status)) return;
        schedule();
      } catch (cause) {
        if (cause.name !== 'AbortError' && !stopped && version === generation.current && !maskedRef.current) { setRun(null); setPollStopped(true); setError('进度自动刷新失败，请手动刷新核对任务。'); }
      }
    };
    schedule();
    return () => { stopped = true; clearTimeout(timer); abort.abort(); };
  }, [masked, pageVisible, run?.id, run?.status, busy, error]);

  async function mutate(url, payload) {
    const version = generation.current;
    setBusy(true); setError('');
    try {
      const result = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (version !== generation.current || maskedRef.current) return false;
      const created = result.run;
      if (created?.id) { currentId.current = created.id; setSelectedId(created.id); setRun(created); }
      await refresh(created?.id || payload.id);
      return true;
    } catch (cause) {
      if (cause.name !== 'AbortError' && version === generation.current && !maskedRef.current) setError('请求未确认成功，请先刷新任务列表核对，避免重复发起。');
      return false;
    } finally { if (version === generation.current) setBusy(false); }
  }

  if (masked) return <div className="attention-page"><div className="page-heading"><div><h1>主动发现</h1><p>数据分析与待审报告</p></div></div><div className="attention-notice">匿名展示已开启。关闭匿名展示后可查看看板来源、分析任务与报告。</div></div>;
  const analysisSources = Array.isArray(data?.sources) ? data.sources : [];
  const boards = Array.isArray(boardData?.boards) ? boardData.boards : [];
  const sources = [...analysisSources,...boards.filter(board=>!analysisSources.some(source=>source.id===board.analysisSourceId)).map(board=>({
    id:`board-${board.id}`,title:board.title,ready:false,version:'推送原图',definition:board.relationNote || '已关联推送原图，当前取数口径尚未核验。',recipes:[],unavailableReason:'推送原图可查看；查数口径尚未核验，暂不能开始自动分析。'
  }))];
  const selectedSource = sources.find(source => source.id === sourceId);
  const selectedBoard = boards.find(board=>board.analysisSourceId===sourceId || `board-${board.id}`===sourceId);
  const knowledgeSize = knowledgeBytes(knowledge), knowledgeValid = knowledgeSize <= 6144;
  const snapshotAvailable = !selectedBoard || Boolean(selectedBoardSnapshot(selectedBoard, snapshotId));
  const canStart = snapshotAvailable && data?.configured && data?.capabilities?.modelReady && data?.capabilities?.executorReady && selectedSource?.ready;
  return <div className="attention-page"><div className="page-heading"><div><h1>主动发现</h1><p>数据分析与待审报告</p></div><Button disabled={busy} icon={<IconRefresh aria-hidden="true" />} onClick={() => refresh()}>刷新任务</Button></div>
    {error && <p role="alert">{error}</p>}
    {!data ? <p role="status">正在读取分析任务…</p> : <>
      <AgentLoopGuide agent={data.agent} />
      <HistoricalTickets masked={masked} onUseForAnalysis={ticket=>{setQuestion(ticket.question);setHistoryQuestion({id:ticket.id,title:ticket.title});requestAnimationFrame(()=>document.getElementById(`${formId}-question`)?.focus());}} />
      <p className="muted"><a href="?view=memory">查看项目记忆与历史注入记录 →</a></p>
      <section className="attention-card" aria-label="发起数据分析"><header><h2>发起分析</h2><Tag>人工发起</Tag></header>
        {!data.configured && <p className="guide-boundary">分析服务尚未配置。</p>}
        {data.configured && (!data.capabilities?.modelReady || !data.capabilities?.executorReady) && <p className="guide-boundary">{!data.capabilities?.modelReady ? '分析模型尚未就绪。' : ''}{!data.capabilities?.executorReady ? '查数服务尚未就绪。' : ''}暂不能发起分析。</p>}
        {historyQuestion && <p className="guide-boundary">已关联历史问题：{historyQuestion.title}。将核对原消息及引用看板。 <Button size="small" onClick={()=>setHistoryQuestion(null)}>取消关联</Button></p>}
        <form onSubmit={async event => { event.preventDefault(); if (canStart && question.trim() && knowledgeValid && !busy) await mutate('/api/discovery', { question: question.trim(), sourceId, ...(historyQuestion?{historyTicketId:historyQuestion.id}:boardSubmissionContext(selectedBoard,snapshotId)), trigger: 'manual', ...(facts.trim() ? { facts: facts.trim() } : {}), ...(knowledge.trim() ? { knowledgeMarkdown: knowledge.trim() } : {}) }); }}>
          <div className="answer-section"><label htmlFor={`${formId}-source`}>看板来源</label><Select id={`${formId}-source`} aria-label="看板来源" value={sourceId || undefined} placeholder="选择看板" style={{ width: '100%' }} disabled={busy} optionList={sources.map(source => ({ value: source.id, label: `${source.title}${source.ready ? '' : ' · 待就绪'}` }))} onChange={value => { setSourceId(value); setSnapshotId(''); }} /></div>
          {boardError && <p role="alert">{boardError}</p>}
          {selectedSource && <BoardPreview key={sourceId} board={selectedBoard} snapshotId={snapshotId} onSnapshotChange={setSnapshotId} />}
          {selectedSource && <details className="answer-section"><summary>指标口径与版本</summary><p className="answer-line">{selectedSource.title} · {discoveryText(selectedSource.version)}</p><p className="answer-line">{discoveryText(selectedSource.definition)}</p>{selectedSource.recipes?.length > 0 && <><h3>可用查数方案</h3>{selectedSource.recipes.map(recipe => <p className="answer-line" key={recipe.id}>{recipe.title || recipe.id} · {recipe.purpose || '用途待核对'}</p>)}</>}{!selectedSource.ready && <p>{discoveryText(selectedSource.unavailableReason || '当前来源暂不可查询。')}</p>}</details>}
          <div className="answer-section"><label htmlFor={`${formId}-question`}>原始问题</label><TextArea id={`${formId}-question`} rows={3} maxLength={3000} value={question} onChange={setQuestion} disabled={busy} placeholder="输入需要解释的数据变化或原始提问，并注明日期、指标与比较周期。" /></div>
          <div className="answer-section"><label htmlFor={`${formId}-facts`}>补充事实（可选）</label><TextArea id={`${formId}-facts`} rows={3} maxLength={8000} value={facts} onChange={setFacts} disabled={busy} placeholder="已确认的发版、流量调整或业务背景；请注明时间与来源。" /></div>
          <details className="answer-section"><summary>业务知识（可选，Markdown）</summary><label htmlFor={`${formId}-knowledge`}>指标口径与业务背景</label><TextArea id={`${formId}-knowledge`} rows={5} value={knowledge} onChange={setKnowledge} disabled={busy} placeholder="补充指标定义、版本发布记录或业务分析约定。此内容作为资料，不会改写分析规则。" /><p className="muted">{knowledgeSize} / 6144 字节 · 只保留在本次任务中</p>{!knowledgeValid && <p role="alert">业务知识超过 6KB，请精简后发起分析。</p>}</details>
          <p className="muted">本次最多 {data.budget?.maxRounds ?? 3} 轮分析、{data.budget?.maxQueries ?? 3} 次查数；预计模型费用上限 ¥{data.budget?.estimatedMaxCny ?? '待核对'}。</p>
          {data.budget?.dailyLimitCny !== undefined && <p className="muted">今日预算 ¥{data.budget.dailyLimitCny} · 剩余 ¥{Number(data.budget.remainingCny || 0).toFixed(2)} · 已预留 ¥{Number(data.budget.reservedCny || 0).toFixed(2)}。费用按用量估算，非服务商账单。</p>}
          <div className="attention-actions"><Button htmlType="submit" theme="solid" loading={busy} disabled={!canStart || !question.trim() || !knowledgeValid}>开始分析</Button></div>
        </form>
        <p className="answer-footnote">生成结果进入待审草稿。当前由你发起分析，不自动监测或发送消息。</p>
      </section>
      {run && <RunDetail key={run.id} run={run} sourceTitle={sources.find(source => source.id === run.sourceId)?.title} recipes={sources.find(source => source.id === run.sourceId)?.recipes || []} busy={busy} pollStopped={pollStopped} onRefresh={() => refresh(run.id)} onAction={(action, addedFacts) => mutate('/api/discovery-action', { id: run.id, action, ...(addedFacts ? { facts: addedFacts } : {}) })} />}
      <section className="answer-section" aria-label="分析任务"><h2>分析任务</h2>{!data.runs?.length ? <p className="attention-empty">暂无分析任务。</p> : <div className="attention-list">{data.runs.map(item => <article className="attention-card" key={item.id}><header><h3>{hiddenStatuses.has(item.status) ? '来源已停用的任务' : cleanMentions(item.question)}</h3><Tag>{labelFor(item.status)}</Tag></header><p className="muted">更新于 {dateFor(item.updatedAt)}</p><Button theme={selectedId === item.id ? 'light' : 'borderless'} disabled={busy} onClick={() => { setRun(null); currentId.current = item.id; setSelectedId(item.id); refresh(item.id); }}>查看分析</Button></article>)}</div>}</section>
    </>}
  </div>;
}
