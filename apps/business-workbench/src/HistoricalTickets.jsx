import React, { useEffect, useRef, useState } from 'react';
import Button from '@douyinfe/semi-ui/lib/es/button/index.js';
import Select from '@douyinfe/semi-ui/lib/es/select/index.js';
import SideSheet from '@douyinfe/semi-ui/lib/es/sideSheet/index.js';
import SourceRichText from './SourceRichText.jsx';
import { cleanMentions } from './presentation.mjs';
import Table from '@douyinfe/semi-ui/lib/es/table/index.js';
import Tag from '@douyinfe/semi-ui/lib/es/tag/index.js';

const statuses = { ANSWERED: '历史已有答复', PENDING: '可能待处理', UNKNOWN: '状态未确认' };
const kinds = { question: '原始提问', reply: '历史答复', followup: '后续追问', image: '图片依据' };
const text = value => typeof value === 'string' ? value : '';
const prose = value => cleanMentions(text(value));
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '时间未记录';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : '—';

function ConversationPerson({ person, prefix = '', provisional = false }) {
  const name = text(person?.name) || '身份待确认';
  const visualKey = person?.key || person?.candidateKey;
  const tone = visualKey ? parseInt(visualKey.slice(-2), 16) % 4 : 0;
  return <span className={`conversation-person person-tone-${tone}`} data-person-key={person?.key || undefined}>
    <span className="conversation-avatar" aria-hidden="true">{Array.from(name)[0]}</span>
    <span>{prefix}{name}</span>{provisional && <small>身份待核对</small>}
  </span>;
}

function TicketImage({ image }) {
  const [failed, setFailed] = useState(false);
  const labels={EVENT_ATTACHMENT:'工单附件',EXPLICIT_REFERENCE:'引用原图',NEARBY_CANDIDATE:'临近图片 · 待确认关联'};
  return <figure className="answer-section" style={{margin:'16px 0'}}>
    <figcaption><Tag>{labels[image.relation] || '图片依据'}</Tag> {date(image.at)} · 原消息 {image.sourceMessageId}</figcaption>
    {image.relation==='NEARBY_CANDIDATE' && <p className="guide-boundary">同群提问前的图片候选，尚未确认就是本问题所指看板。</p>}
    {image.status==='VERIFIED' && image.imagePath && !failed ? <a href={image.imagePath} target="_blank" rel="noreferrer" aria-label="打开工单原图"><img src={image.imagePath} alt={image.caption || '工单原始图片'} loading="lazy" onError={()=>setFailed(true)} style={{display:'block',maxWidth:'100%',maxHeight:560,objectFit:'contain',marginTop:12}} /></a> : <p className="guide-boundary">{failed?'原图暂时无法读取，请刷新核对来源权限。':image.reason || '尚未取得可核验原图。'}</p>}
  </figure>;
}

export function TicketDetail({ ticket, onUseForAnalysis }) {
  const events = Array.isArray(ticket.events) ? ticket.events : [];
  const eventNodes = useRef(new Map());
  const [focusedEvent, setFocusedEvent] = useState('');
  const focusEvent = id => { setFocusedEvent(id); eventNodes.current.get(id)?.scrollIntoView({block:'start',behavior:'auto'}); };
  const colors = { question: 'blue', reply: 'green', followup: 'orange', image: 'grey' };
  return <article className="history-detail" aria-label="历史工单详情">
    <header className="history-detail-heading"><Tag>{statuses[ticket.status] || statuses.UNKNOWN}</Tag><h2>{text(ticket.title) || '历史数据问题'}</h2>
      <p className="muted">首次提问 {date(ticket.firstAskedAt)}<br />最近活动 {date(ticket.lastActivityAt)}</p>
    </header>
    <p className="history-status-note">{prose(ticket.statusReason) || '历史处理状态尚未核实。'} 历史答复不代表原因已经验证，历史问题也不等同于今日待办。</p>
    {onUseForAnalysis && <Button theme="light" onClick={()=>onUseForAnalysis(ticket)}>以此问题发起分析</Button>}
    {text(ticket.sourceSummary) && <p className="muted">来源：{prose(ticket.sourceSummary)}</p>}
    <section className="history-conversation"><div className="history-section-heading"><h3>提问与答复记录</h3><span>{events.length} 条记录</span></div>
      {events.length ? <ol className="history-timeline">{events.map((event, index) => <li className={`history-event history-event-${Object.hasOwn(kinds, event.kind) ? event.kind : 'other'} ${focusedEvent === event.id ? 'is-reply-target' : ''}`} ref={node => { if (node) eventNodes.current.set(event.id,node); else eventNodes.current.delete(event.id); }} key={event.id || index}>
        <div className="history-event-heading"><Tag color={colors[event.kind] || 'grey'}>{kinds[event.kind] || '历史记录'}</Tag><ConversationPerson person={event.participant || {name:event.speaker}} /></div>
        <p className="history-event-meta"><time>{date(event.at)}</time><span>{text(event.sourceTitle) || '来源未记录'}</span></p>
        {event.mentions?.length > 0 && <div className="conversation-mentions"><span>提及</span>{event.mentions.map((person, i) => <ConversationPerson key={`${person.key || person.name}:${i}`} person={person} prefix="@" provisional={!person.identityVerified} />)}</div>}
        {text(event.text) && <div className="history-event-body"><SourceRichText value={event.text} /></div>}
        {event.replyTo ? <button className="history-reply-person" onClick={() => focusEvent(event.replyTo.eventId)} aria-label={`查看${event.replyTo.participant.name}被引用的原话`}>↳ 回复 <ConversationPerson person={event.replyTo.participant} prefix="@" /><span>查看原话 ↑</span></button> : event.replyAssociation === 'REFERENCE_NOT_IN_TICKET' ? <p className="history-reply-link">引用原消息不在当前工单内，回复对象待核对</p> : event.replyAssociation === 'UNCONFIRMED' ? <p className="history-reply-link">历史答复线索 · 未保留明确引用，回复对象待确认</p> : null}
        {ticket.media?.filter(image=>image.linkedEventId===event.id&&image.status==='VERIFIED').map(image=><TicketImage key={image.id} image={image} />)}
        {!ticket.media?.some(image=>image.linkedEventId===event.id&&image.status==='VERIFIED') && Array.isArray(event.images) && event.images.map((image, imageIndex) => <p className="guide-boundary" key={imageIndex}>{text(image.caption) || '图片依据'} · {image.available === false ? '原图暂不可查看' : '原图未提供可核验预览'}{text(image.reason) && `：${image.reason}`}</p>)}
        {event.kind === 'image' && !event.images?.length && !ticket.media?.some(image=>image.linkedEventId===event.id&&image.status==='VERIFIED') && <p className="guide-boundary">此记录未保留可查看的原图。</p>}
      </li>)}</ol> : <><div className="history-event-body"><SourceRichText value={text(ticket.question)} /></div><p className="muted">尚未取得可定位的历史问答记录。</p></>}
    </section>
    <section className="history-media"><h3>引用原图与附件</h3>{ticket.media?.length ? ticket.media.filter(image=>!events.some(event=>event.id===image.linkedEventId&&image.status==='VERIFIED')).map(image=><TicketImage key={image.id} image={image} />) : <p className="muted">现有记录中尚未取得可核验原图；不代表原会话没有图片。</p>}{ticket.media?.length>0 && <p className="muted">已关联记录的原图随对应发言展示；临近图片仍需核对关联。</p>}</section>
    {Array.isArray(ticket.sourceCandidates) && ticket.sourceCandidates.length > 0 && <details className="answer-section"><summary>相关数据源</summary>{ticket.sourceCandidates.map((source, index) => <p className="answer-line" key={source.id || index}>{text(source.title) || '来源名称未记录'} <Tag>{source.verified === true ? '已核验' : '待核验'}</Tag></p>)}</details>}
    {text(ticket.analysisNotes) && <details className="answer-section"><summary>整理备注</summary><p className="answer-line" style={{ whiteSpace: 'pre-wrap' }}>{prose(ticket.analysisNotes)}</p></details>}
    {Array.isArray(ticket.boundaries) && ticket.boundaries.length > 0 && <details className="answer-section"><summary>资料范围与缺口</summary>{ticket.boundaries.map((item, index) => <p className="answer-line" key={index}>{text(item)}</p>)}</details>}
  </article>;
}

export default function HistoricalTickets({ masked, onUseForAnalysis }) {
  const [data, setData] = useState(null), [ticket, setTicket] = useState(null);
  const [filter, setFilter] = useState('ALL'), [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(false), [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(''), [detailError, setDetailError] = useState('');
  const detailContent = useRef(null), detailOpener = useRef(null);
  const listController = useRef(null), detailController = useRef(null), epoch = useRef(0), detailSequence = useRef(0), maskedRef = useRef(masked);
  maskedRef.current = masked;

  async function load() {
    if (maskedRef.current) return;
    const version = ++epoch.current;
    listController.current?.abort(); detailController.current?.abort(); detailSequence.current++;
    const controller = new AbortController(); listController.current = controller;
    setLoading(true); setData(null); setTicket(null); setSelectedId(''); setError(''); setDetailError(''); setDetailLoading(false);
    try {
      const response = await fetch('/api/discovery-history', { method: 'GET', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('HISTORY_UNAVAILABLE');
      const result = await response.json();
      if (version === epoch.current && !maskedRef.current) setData(result);
    } catch (cause) {
      if (cause.name !== 'AbortError' && version === epoch.current && !maskedRef.current) setError('历史工单暂时无法读取，请稍后刷新。');
    } finally { if (version === epoch.current && !maskedRef.current) setLoading(false); }
  }

  function closeDetail() {
    detailSequence.current++; detailController.current?.abort();
    setTicket(null); setSelectedId(''); setDetailLoading(false); setDetailError('');
  }

  async function select(id, opener) {
    if (maskedRef.current || typeof id !== 'string' || !id) return;
    if (opener) detailOpener.current = opener;
    const version = epoch.current, sequence = ++detailSequence.current;
    detailController.current?.abort(); const controller = new AbortController(); detailController.current = controller;
    setTicket(null); setSelectedId(id); setDetailError(''); setDetailLoading(true);
    try {
      const response = await fetch(`/api/discovery-history?id=${encodeURIComponent(id)}`, { method: 'GET', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('HISTORY_DETAIL_UNAVAILABLE');
      const result = await response.json();
      if (version === epoch.current && sequence === detailSequence.current && !maskedRef.current) {
        if (!result.ticket || result.ticket.id !== id) throw new Error('HISTORY_DETAIL_MISMATCH');
        setTicket(result.ticket);
      }
    } catch (cause) {
      if (cause.name !== 'AbortError' && version === epoch.current && sequence === detailSequence.current && !maskedRef.current) setDetailError('这张工单的原始记录暂时无法读取，请重新选择。');
    } finally { if (version === epoch.current && sequence === detailSequence.current && !maskedRef.current) setDetailLoading(false); }
  }

  useEffect(() => {
    if (!masked) load();
    else { detailOpener.current = null; setData(null); setTicket(null); setSelectedId(''); setError(''); setDetailError(''); setFilter('ALL'); }
    return () => { epoch.current++; detailSequence.current++; listController.current?.abort(); detailController.current?.abort(); };
  }, [masked]);

  useEffect(() => {
    if (!selectedId || masked) return;
    const trapFocus = event => {
      if (event.key !== 'Tab') return;
      const panel = detailContent.current?.closest('.semi-sidesheet-inner');
      const nodes = [...(panel?.querySelectorAll('button:not([disabled]), a[href], select, textarea, input, summary, [tabindex="0"]') || [])].filter(node => node.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (!first) return;
      if (!panel.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [selectedId, masked]);

  if (masked) return null;
  const rows = Array.isArray(data?.tickets) ? data.tickets.filter(item => filter === 'ALL' || item.status === filter) : [];
  return <section className="attention-card" aria-label="历史数据问答工单">
    <header><h2>历史数据问答</h2><Button loading={loading} onClick={load}>刷新历史工单</Button></header>
    <p className="muted">历史提问、答复与后续追问，按同一数据问题汇集。</p>
    {loading && <p role="status">正在读取历史工单…</p>}
    {error && <p role="alert">{error}</p>}
    {data && !data.configured && <p className="guide-boundary">历史工单资料尚未接入。</p>}
    {data?.configured && <>
      <p className="muted">回溯范围：{date(data.window?.start)} 至 {date(data.window?.end)} · 资料更新于 {date(data.window?.asOf)}</p>
      <p className="answer-line">共 {count(data.counts?.total)} 个问题 · 历史已有答复 {count(data.counts?.answered)} · 可能待处理 {count(data.counts?.pending)} · 状态未确认 {count(data.counts?.unknown)}</p>
      <details className="answer-section"><summary>读取范围与缺口 · 已检查 {count(data.coverage?.checkedSources)} / {count(data.coverage?.totalSources)} 个来源</summary><p className="muted">当前列表不代表全部历史问题；历史问题不会自动重新查数。</p>{(Array.isArray(data.coverage?.notes) ? data.coverage.notes : []).map((note, index) => <p className="answer-line" key={index}>{text(note)}</p>)}</details>
      <div className="attention-filters"><label>处理状态 <Select aria-label="历史工单处理状态" value={filter} onChange={value => { setFilter(value); closeDetail(); }} optionList={[{ value: 'ALL', label: '全部状态' }, ...Object.entries(statuses).map(([value, label]) => ({ value, label }))]} /></label></div>
      {rows.length ? <Table size="small" rowKey="id" pagination={{ pageSize: 50, showSizeChanger: false }} dataSource={rows} columns={[
        { title: '数据问题', dataIndex: 'title', render: value => text(value) || '标题未记录' },
        { title: '历史状态', dataIndex: 'status', render: value => <Tag>{statuses[value] || statuses.UNKNOWN}</Tag> },
        { title: '最近活动', dataIndex: 'lastActivityAt', render: date },
        { title: '来源 / 依据', render: (_value, item) => `${count(item.sourceCount)} / ${count(item.evidenceCount)}` },
        { title: '记录', render: (_value, item) => <Button theme={selectedId === item.id ? 'light' : 'borderless'} aria-haspopup="dialog" aria-expanded={selectedId === item.id} onClick={event => select(item.id, event.currentTarget)}>查看原文</Button> },
      ]} /> : <p className="muted">当前范围内暂无此类历史工单。</p>}
    </>}
    <SideSheet title="历史问答原文" visible={Boolean(selectedId)} onCancel={closeDetail} placement="right" width="min(760px, 100vw)" className="evidence-sheet history-sheet" aria-label="历史问答原文" closeOnEsc={true} maskClosable={true} closeIcon={<span aria-label="关闭历史问答">×</span>} afterVisibleChange={visible => {
      if (visible) {
        const panel = detailContent.current?.closest('.semi-sidesheet-inner');
        panel?.setAttribute('aria-label', '历史问答原文');
        panel?.setAttribute('aria-modal', 'true');
        panel?.querySelector('.semi-sidesheet-close')?.focus();
      }
      else if (!maskedRef.current && detailOpener.current?.isConnected) detailOpener.current.focus();
    }}>
      <div ref={detailContent} className="evidence-content" aria-busy={detailLoading}>
        {detailLoading && <p role="status">正在读取原始问答…</p>}
        {detailError && <><p role="alert">{detailError}</p><Button onClick={() => select(selectedId)}>重新读取</Button></>}
        {ticket && <TicketDetail ticket={ticket} onUseForAnalysis={onUseForAnalysis?value=>{onUseForAnalysis(value);closeDetail();}:null} />}
      </div>
    </SideSheet>
  </section>;
}
