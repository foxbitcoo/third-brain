import React, { useEffect, useRef, useState } from 'react';
import Button from '@douyinfe/semi-ui/lib/es/button/index.js';
import Select from '@douyinfe/semi-ui/lib/es/select/index.js';
import Input from '@douyinfe/semi-ui/lib/es/input/index.js';
import Table from '@douyinfe/semi-ui/lib/es/table/index.js';
import Tag from '@douyinfe/semi-ui/lib/es/tag/index.js';
import { cleanMentions } from './presentation.mjs';
import { memoryLineage, memoryRunReceipts, memoryReviewRows, memoryEvidenceUrl } from './memory-review-presentation.mjs';
import { memoryStatus, memoryKind, memoryInjectionView } from './diagnostic-memory-presentation.mjs';

const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '未记录';

function EvidenceItem({ item }) {
  const value = typeof item === 'string' ? { title: item } : item || {};
  const label = value.title || value.label || value.artifactId || value.locator || value.url || value.speaker || value.id || (value.text ? '确认回复' : '资料名称未取得');
  const url = memoryEvidenceUrl(value.url || value.href);
  return <p className="answer-line">{url ? <a href={url} target="_blank" rel="noreferrer">{label} ↗</a> : label}{value.kind && ` · ${value.kind}`}{value.status && ` · ${value.status}`}{value.text && <span> · {cleanMentions(value.text)}</span>}{value.at && ` · ${date(value.at)}`}</p>;
}

function MemoryRecord({ record, busy, onAction, runs = [], expanded = false }) {
  const lineage = memoryLineage(record), runReceipts = memoryRunReceipts(record, runs);
  return <details className="answer-section" open={expanded || undefined}><summary>{record.title} · {memoryKind(record.kind)} · {memoryStatus(record.status)}</summary>
    {(lineage.ticketId || lineage.question || lineage.deliverables.length || lineage.acknowledgements.length) ? <section className="answer-section"><h3>历史问题与交付</h3>
      <p className="answer-line">原始问题：{cleanMentions(lineage.question) || '未取得可定位的历史原问'}</p>
      <p className="muted">历史工单：{lineage.ticketId || '未关联历史工单'}</p>
      <h4>交付文档、HTML 或报告</h4>{lineage.deliverables.length ? lineage.deliverables.map((item, i) => <EvidenceItem key={i} item={item} />) : <p className="muted">尚未取得可定位的交付资料。</p>}
      <h4>确认回复</h4>{lineage.acknowledgements.length ? lineage.acknowledgements.map((item, i) => <EvidenceItem key={i} item={item} />) : <p className="muted">尚未取得可定位的确认回复。</p>}
      <p className="guide-boundary">{lineage.acknowledgementMeaning}</p>
    </section> : null}
    <h3>提炼的 Memory</h3>
    <p className="answer-line" style={{ whiteSpace: 'pre-wrap' }}>{cleanMentions(record.text)}</p>
    {!!record.reasons?.length && <p className="answer-line">匹配依据：{record.reasons.join('；')}</p>}
    <p className="muted">版本 {record.version} · 收录时间 {date(record.knownAt)}{record.effectiveFrom && <> · 生效于 {date(record.effectiveFrom)}</>}{record.effectiveUntil && <> · 有效至 {date(record.effectiveUntil)}</>}</p>
    <p className="answer-line">适用来源：{record.applicability?.sourceIds?.join('、') || '未取得'}</p>
    {lineage.extraction && <p className="answer-line">提炼依据：{lineage.extraction}</p>}
    <details className="answer-section"><summary>匹配与实际注入 · {runReceipts.length} 个任务</summary>{runReceipts.length ? runReceipts.map(entry => <section key={entry.runId} className="answer-section"><h4>{cleanMentions(entry.question) || entry.runId}</h4><p>{entry.state} · 匹配版本 {entry.selectedVersion ?? '未记录'}</p>{entry.receipts.map((receipt, index) => <details key={index}><summary>{receipt.stage} · 第 {receipt.round} 轮 · {receipt.responded ? '已取得响应' : '请求状态待核对'}</summary><p className="muted">System Prompt 校验值：{receipt.systemPromptHash || '未记录'}</p><p className="answer-line" style={{ whiteSpace: 'pre-wrap' }}>{receipt.block || '未保存实际注入正文'}</p></details>)}</section>) : <p className="muted">没有此条记忆的匹配或实际模型响应回执。</p>}<p className="muted">已注入不代表模型已正确采用，也不代表业务结论已验证。</p></details>
    {record.verification?.note && <p className="answer-line">核验说明：{record.verification.note === 'Source text supports this statement. This is not user confirmation, current remote authorization or proof of historical causal claims.' ? '已核对来源原文；不代表用户确认、当前来源授权或历史因果结论已验证。' : record.verification.note}</p>}
    <details><summary>来源与版本依据</summary>{(record.sourceRefs || []).map((ref, index) => <div key={index}><p className="answer-line">来源 {ref.sourceId} · 版本 {ref.version} · {date(ref.knownAt)}</p>{ref.locator && <p className="muted">原始位置：{ref.locator}</p>}{ref.quote && <blockquote>{cleanMentions(ref.quote)}</blockquote>}</div>)}<p className="muted">内容校验值：{record.hash}</p></details>
    {onAction && <div className="attention-actions">{!['USER_CONFIRMED', 'DISABLED', 'SUPERSEDED'].includes(record.status) && <Button disabled={busy} onClick={() => onAction(record.id, 'confirm')}>确认记忆</Button>}{record.status !== 'DISABLED' && <Button type="danger" disabled={busy} onClick={() => onAction(record.id, 'disable')}>停用</Button>}</div>}
  </details>;
}

export default function DiagnosticMemory({ masked, fullPage = false }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const [status, setStatus] = useState('ALL'), [origin, setOrigin] = useState('ALL'), [search, setSearch] = useState(''), [selectedId, setSelectedId] = useState('');
  async function load(signal) {
    const version = generation.current;
    try {
      const response = await fetch('/api/discovery-memory', { cache: 'no-store', signal });
      if (!response.ok) throw new Error('MEMORY_UNAVAILABLE');
      const value = await response.json();
      if (version === generation.current) { setData(value); setError(''); }
    } catch (cause) { if (cause.name !== 'AbortError' && version === generation.current) { setData(null); setError('项目记忆暂时无法读取，请刷新重试。'); } }
  }
  useEffect(() => {
    generation.current++; setData(null); setError(''); setBusy(false);
    if (masked) return;
    const controller = new AbortController(); load(controller.signal);
    return () => { generation.current++; controller.abort(); };
  }, [masked]);
  async function action(id, action) {
    if (busy) return;
    const version = generation.current; setBusy(true); setError('');
    try {
      const response = await fetch('/api/discovery-memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action }) });
      if (!response.ok) throw new Error('MEMORY_ACTION_FAILED');
      if (version === generation.current) await load();
    } catch { if (version === generation.current) setError('设置未确认成功，请刷新核对后再操作。'); }
    finally { if (version === generation.current) setBusy(false); }
  }
  if (masked) return fullPage ? <div className="attention-page"><div className="page-heading"><div><h1>项目记忆</h1></div></div><p className="attention-notice">匿名展示已开启。关闭后可查看历史问题、交付资料与记忆。</p></div> : null;
  const rows = memoryReviewRows(data?.records, data?.runs, { status, origin, search });
  const selected = rows.find(record => record.id === selectedId);
  const body = <section className="attention-card" aria-label="项目记忆"><header><h2>{fullPage ? '记忆清单' : '项目记忆 · Memory'}</h2><Button disabled={busy} onClick={() => load()}>刷新记忆</Button></header>
    <p className="muted">历史问题、交付资料、记忆内容及实际调用记录。待核验、停用和已替换的记忆均可查看。</p>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p role="status">正在读取项目记忆…</p>}
    {data && <>
      <div className="attention-filters"><label>状态 <Select aria-label="记忆状态" value={status} onChange={value => { setStatus(value); setSelectedId(''); }} optionList={[{value:'ALL',label:'全部状态'}, ...['CANDIDATE','SOURCE_VERIFIED','USER_CONFIRMED','CONFLICT','DISABLED','SUPERSEDED'].map(value => ({value,label:memoryStatus(value)}))]} /></label>
      <label>来源 <Select aria-label="记忆来源" value={origin} onChange={value => { setOrigin(value); setSelectedId(''); }} optionList={[{value:'ALL',label:'全部来源'},{value:'HISTORY',label:'历史问答工单'}]} /></label><Input aria-label="搜索记忆" value={search} onChange={setSearch} placeholder="搜索问题或记忆" showClear style={{maxWidth:320}} /></div>
      <p className="muted">当前 {rows.length} / {data.records?.length || 0} 条 · {Array.isArray(data.runs) ? `已核对 ${data.runs.length} 个任务的保存记录` : '实际注入任务记录尚未接入清单'}</p>
      {rows.length ? <Table rowKey="id" size="small" pagination={{pageSize:20,showSizeChanger:false}} dataSource={rows} columns={[
        {title:'记忆',dataIndex:'title'}, {title:'类型',dataIndex:'kind',render:memoryKind}, {title:'状态',dataIndex:'status',render:value=><Tag>{memoryStatus(value)}</Tag>},
        {title:'历史工单',render:(_value,row)=>row.lineageView.ticketId || '未关联'},
        {title:'实际注入',render:(_value,row)=>row.runReceipts.filter(entry=>entry.receipts.some(receipt=>receipt.responded)).length+' 个任务'},
        {title:'详情',render:(_value,row)=><Button theme="borderless" aria-expanded={selectedId===row.id} onClick={()=>setSelectedId(selectedId===row.id?'':row.id)}>查看记忆</Button>},
      ]} expandedRowKeys={selected ? [selected.id] : []} expandedRowRender={record=><MemoryRecord record={record} busy={busy} onAction={action} runs={data.runs} expanded />} onExpand={(expanded,record)=>setSelectedId(expanded ? record.id : '')} /> : <p className="attention-empty">当前筛选下暂无项目记忆。</p>}
    </>}
  </section>;
  return fullPage ? <div className="attention-page"><div className="page-heading"><div><h1>项目记忆</h1><p>历史经验与分析依据</p></div></div>{body}</div> : body;
}

export function RunMemory({ run }) {
  const view = memoryInjectionView(run);
  return <details className="answer-section"><summary>本次 Memory · {view.label}</summary>
    <p className="muted">{view.description}</p>
    {(run.memorySnapshot?.selected || []).map(record => <MemoryRecord key={`${record.id}-${record.version}`} record={record} />)}
    {run.memorySnapshot?.hash && <p className="muted">任务记忆快照：{run.memorySnapshot.hash}</p>}
    {view.receipts.map((receipt, index) => <details key={index}><summary>{receipt.stage === 'plan' ? '查询规划' : receipt.stage === 'review' ? '结果核查' : receipt.stage} · 第 {receipt.round} 轮 · {receipt.responded ? '已取得响应' : '请求状态待核对'}</summary>
      <p className="answer-line">注入位置：System Prompt · {receipt.memoryIds.join('、') || '未注入记忆'}</p>
      <p className="muted">System Prompt 校验值：{receipt.systemPromptHash || '未记录'} · Memory 校验值：{receipt.blockHash || '未记录'}</p>
      {receipt.block && <p className="answer-line" style={{ whiteSpace: 'pre-wrap' }}>{receipt.block}</p>}
    </details>)}
    {!!run.memorySnapshot?.excluded?.length && <details><summary>未采用的记忆与原因</summary>{run.memorySnapshot.excluded.map((entry, index) => <p className="muted" key={index}>{entry.id} · {entry.reason}</p>)}</details>}
  </details>;
}
