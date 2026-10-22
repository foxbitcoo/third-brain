import SourceRichText from './SourceRichText.jsx';
import SourceAttention from './SourceAttention.jsx';
import ProactiveDiscovery from './ProactiveDiscovery.jsx';
import DiagnosticMemory from './DiagnosticMemory.jsx';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@douyinfe/semi-ui/lib/es/_base/base.css';
import Avatar from '@douyinfe/semi-ui/lib/es/avatar/index.js';
import Banner from '@douyinfe/semi-ui/lib/es/banner/index.js';
import Button from '@douyinfe/semi-ui/lib/es/button/index.js';
import Empty from '@douyinfe/semi-ui/lib/es/empty/index.js';
import Input from '@douyinfe/semi-ui/lib/es/input/index.js';
import Modal from '@douyinfe/semi-ui/lib/es/modal/index.js';
import Popover from '@douyinfe/semi-ui/lib/es/popover/index.js';
import Nav from '@douyinfe/semi-ui/lib/es/navigation/index.js';
import Select from '@douyinfe/semi-ui/lib/es/select/index.js';
import SideSheet from '@douyinfe/semi-ui/lib/es/sideSheet/index.js';
import Skeleton from '@douyinfe/semi-ui/lib/es/skeleton/index.js';
import Switch from '@douyinfe/semi-ui/lib/es/switch/index.js';
import Tag from '@douyinfe/semi-ui/lib/es/tag/index.js';
import TextArea from '@douyinfe/semi-ui/lib/es/input/textarea.js';
import Toast from '@douyinfe/semi-ui/lib/es/toast/index.js';
import Tooltip from '@douyinfe/semi-ui/lib/es/tooltip/index.js';
import { IconAlertCircle, IconArrowRight, IconChevronRight, IconClose, IconComment, IconEyeClosed, IconEyeOpened, IconFile, IconGridRectangle, IconHome, IconMenu, IconRefresh, IconSearch, IconSetting, IconTick } from '@douyinfe/semi-icons';
import { createPresenter, datasetEvidence, datasetFingerprint, dateLabel, latestEvidenceTime, compareEvidenceRecency, initialAnswerPair, readIdentityMode, readReviews, recordModelExposure, runLabel, safeSourceUrl, saveIdentityMode, saveReview, scopeLabel } from './presentation.mjs';
import packageInfo from '../package.json';
import { evidenceDisplayText } from './attachment-presentation.mjs';
import { buildWorkStructureView, priorityNames, workStateNames } from './work-structure-presentation.mjs';
import { worklineTruthUrl } from './workline-truth.mjs';
import './styles.css';

const sectionNames = { overview: '工作概览', qa: '业务问答', sources: '信息源管理', discovery: '主动发现', memory: '项目记忆' };
const sourceNames = { im: 'IM 消息', document: '文档', transcript: '会议记录', calendar: '会邀', user_fact: '用户补充事实' };
const qualityOptions = [
  { value: 'usable', label: '可用' }, { value: 'needs_correction', label: '需要修正' },
  { value: 'untrustworthy', label: '不可信' }, { value: 'both_bad', label: '都不好' },
];
const savedKeyPrefix = 'third-brain:business-review:v1:';
const statusNames = { FAILED: '生成失败', BLOCKED: '暂不可用', NOT_RUN: '尚未生成' };
const workBadgeColors = { '紧急': 'red', '待决策': 'orange', '待本人行动': 'blue', '有卡点': 'purple', '优先跟进': 'amber', 'OKR相关': 'cyan', '常规': 'grey', '低优先': 'grey' };

function LabeledSelect({ 'aria-label': label, ...props }) {
  const id = useId();
  return <span className="select-field"><span className="sr-only" id={id}>{label}</span><Select {...props} aria-labelledby={id} /></span>;
}

function Logo({ small = false }) {
  return <span className={`brain-logo ${small ? 'small' : ''}`} aria-hidden="true"><i /><i /><i /><i /></span>;
}

function PersonMention({ part, item, present, showCitation, interactive = true }) {
  const [visible, setVisible] = useState(false);
  const trigger = useRef(null);
  const cardRef = useRef(null);
  const suppressFocus = useRef(false);
  const cardId = useId();
  const related = useMemo(() => visible ? present.relatedRecords(part, item) : { spoken: [], mentioned: [] }, [visible, present, item, part.key]);
  const label = <><span className="mention-at" aria-hidden="true">@</span>{part.label}</>;
  const className = `person-mention mention-${part.status}`;
  if (!interactive || !item || !showCitation) return <span className={className}>{label}</span>;
  const closeCard = (restoreFocus = false) => {
    if (restoreFocus && document.activeElement !== trigger.current) {
      suppressFocus.current = true;
      trigger.current?.focus({ preventScroll: true });
      suppressFocus.current = false;
    }
    setVisible(false);
  };
  const escapeCard = event => { event.preventDefault(); event.stopPropagation(); closeCard(true); };
  const openRecord = evidence => { suppressFocus.current = true; setVisible(false); showCitation(item, evidence.id, { currentTarget: trigger.current }); };
  const status = { verified: '姓名已核实', source: '资料中的姓名', unknown: '原文尚未提供可核实姓名', ambiguous: '原文中的同名身份尚未确定', anonymous: '匿名展示已开启' }[part.status];
  const card = <section ref={cardRef} id={cardId} className="person-card" aria-label={`${part.label}的相关记录`} onKeyDown={event => { if (event.key === 'Escape') escapeCard(event); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) closeCard(); }}>
    <header><div><strong>{part.label}</strong><p>{status}</p></div><Button size="small" type="tertiary" theme="borderless" icon={<IconClose aria-hidden="true" />} aria-label="关闭人物信息" onClick={() => closeCard(true)} /></header>
    <h3>相关记录 <span>{related.spoken.length + related.mentioned.length}</span></h3>
    {[['spoken', part.status === 'unknown' ? '标注该身份' : '本人发言'], ['mentioned', '被提及']].map(([key, name]) => related[key].length > 0 && <div className="person-record-group" key={key}><div className="person-record-label">{name} · {related[key].length}</div>{related[key].slice(0, 3).map(evidence => <button className="person-record" key={evidence.id} onClick={() => openRecord(evidence)}><span>{dateLabel(evidence.occurred_at, true)} · {present(evidence.source_title)}</span><p><RichText value={evidence.text} present={present} limit={66} interactive={false} /></p><span className="person-record-link">查看原始记录 <IconChevronRight aria-hidden="true" size="small" /></span></button>)}</div>)}
    {!related.spoken.length && !related.mentioned.length && <p className="person-record-empty">当前问题没有可关联的记录，可从正文引用继续核对。</p>}
  </section>;
  return <Popover trigger="custom" visible={visible} content={card} position="bottomLeft" showArrow={false} spacing={6} margin={12} motion={false} zIndex={1100} closeOnEsc={true} onEscKeyDown={escapeCard} onClickOutSide={() => closeCard()} onVisibleChange={setVisible} returnFocusOnClose={false}>
    <button ref={trigger} type="button" className={className} aria-label={`查看${part.label}的相关记录`} aria-expanded={visible} aria-controls={visible ? cardId : undefined} onClick={() => setVisible(true)} onFocus={event => { if (suppressFocus.current) { suppressFocus.current = false; return; } if (event.currentTarget.matches(':focus-visible')) setVisible(true); }} onBlur={event => { if (!cardRef.current?.contains(event.relatedTarget)) closeCard(); }} onKeyDown={event => {
      if (event.key === 'Escape') escapeCard(event);
      else if (visible && (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey))) { event.preventDefault(); event.stopPropagation(); cardRef.current?.querySelector('button')?.focus({ preventScroll: true }); }
    }}>{label}</button>
  </Popover>;
}

function RichText({ value, present, item, showCitation, limit, person = false, interactive = true }) {
  const parts = person ? present.person(value) : present.parts(value, limit);
  return <>{parts.map((part, index) => part.type === 'person'
    ? <PersonMention key={`${index}:${part.key || part.label}`} part={part} item={item} present={present} showCitation={showCitation} interactive={interactive} />
    : <React.Fragment key={index}>{part.text}</React.Fragment>)}</>;
}

function App() {
  const [load, setLoad] = useState({ state: 'loading' });
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(() => ['discovery', 'memory', 'sources'].includes(new URLSearchParams(window.location.search).get('view')) ? new URLSearchParams(window.location.search).get('view') : 'overview');
  const [caseId, setCaseId] = useState(null);
  const [masked, setMasked] = useState(() => { try { return readIdentityMode(localStorage) === 'anonymous'; } catch { return false; } });
  const [revealed, setRevealed] = useState(true);
  const [everRevealed, setEverRevealed] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [source, setSource] = useState(null);
  const [search, setSearch] = useState('');
  const [fingerprint, setFingerprint] = useState(null);
  const [reviewCount, setReviewCount] = useState(0);
  const mainRef = useRef(null);
  const changeIdentityMode = value => {
    setMasked(value);
    try { saveIdentityMode(value ? 'anonymous' : 'identified', localStorage); }
    catch { Toast.warning('本次已切换，浏览器未能保存此偏好。'); }
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ state: 'loading' }); setSource(null); setFingerprint(null); setRevealed(true); setEverRevealed(true);
    fetch('/api/dataset', { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const result = await response.json();
      if (!response.ok) { const error = new Error('Dataset unavailable'); error.code = result.error?.code; throw error; }
      if (result.dataset?.schema_version !== 'business-qa-v1' || !Array.isArray(result.dataset.cases)) throw new Error('Invalid data');
      if (controller.signal.aborted) return;
      setLoad({ state: 'ready', ...result });
      setCaseId(result.reading_guide?.cases[0]?.case_id || result.dataset.cases[0]?.id || null);
      if (result.reading_guide && !['discovery', 'memory', 'sources'].includes(new URLSearchParams(window.location.search).get('view'))) setPage('qa');
      const digest = await datasetFingerprint(result.dataset);
      if (!controller.signal.aborted) {
        setFingerprint(digest);
        try { setReviewCount(readReviews(savedKeyPrefix + digest, localStorage).length); }
        catch { setReviewCount(0); }
      }
    }).catch(error => {
      if (error.name !== 'AbortError') setLoad({ state: 'error', guideError: error.code?.startsWith('READING_GUIDE_') });
    });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    if (!fingerprint || !everRevealed) return;
    // Default-visible labels count as exposure. Old saved review rows stay intact.
    try { recordModelExposure(savedKeyPrefix + fingerprint, localStorage); }
    catch { /* Saving an evaluation reports storage failures separately. */ }
  }, [fingerprint, everRevealed]);

  const dataset = load.dataset || { cases: [] };
  const present = useMemo(() => createPresenter(dataset, masked, load.display), [dataset, masked, load.display]);
  const caseTitle = item => present(load.display?.case_titles?.[item.id] || item.title);
  const workStructure = useMemo(() => buildWorkStructureView(dataset, { present }), [dataset, present]);
  const selected = dataset.cases.find(item => item.id === caseId) || dataset.cases[0];
  const openCase = (item, destination = 'qa') => {
    setCaseId(item.id); setPage(destination === 'compare' ? 'qa' : destination); setSource(null); setMobileNav(false);
    mainRef.current?.scrollTo({ top: 0 });
  };
  const navigate = destination => { setPage(destination === 'compare' ? 'qa' : destination); setSource(null); setMobileNav(false); mainRef.current?.scrollTo({ top: 0 }); };
  const showCitation = (item, id, event) => setSource(previous => ({ item, id, trigger: previous?.trigger || event?.currentTarget }));
  const closeSources = () => { const trigger = source?.trigger; setSource(null); setTimeout(() => trigger?.focus(), 0); };
  const toggleModelVisibility = value => {
    const next = typeof value === 'function' ? value(revealed) : value;
    setRevealed(next);
    if (next) {
      setEverRevealed(true);
      try { if (fingerprint) recordModelExposure(savedKeyPrefix + fingerprint, localStorage); } catch { /* Save reports storage failure separately. */ }
    }
  };
  const controls = { present, caseTitle, showCitation, demo: load.mode === 'demo' };
  const panelPresent = useMemo(() => source?.item.live ? createPresenter({ ...dataset, cases: [...dataset.cases, source.item] }, masked, load.display) : present, [dataset, source?.item, masked, load.display, present]);

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">跳到正文</a>
    {mobileNav && <button className="nav-shade" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'is-open' : ''}`} aria-label="工作导航" inert={source ? '' : undefined} aria-hidden={source ? true : undefined}>
      <div className="brand"><Logo /><strong>第三大脑</strong><span className="brand-label">工作助理</span></div>
      <div className="workspace-name"><Avatar size="extra-small" color="blue">我</Avatar><span>我的工作空间</span><span className="local-dot" /></div>
      <Nav style={{ flexShrink: 0 }} selectedKeys={[page]} items={[
        { itemKey: 'overview', text: '工作概览', icon: <IconHome aria-hidden="true" /> },
        { itemKey: 'qa', text: '业务问答', icon: <IconComment aria-hidden="true" /> },
        { itemKey: 'sources', text: '信息源管理', icon: <IconGridRectangle aria-hidden="true" /> },
        { itemKey: 'discovery', text: '主动发现', icon: <IconSearch aria-hidden="true" /> },
        { itemKey: 'memory', text: '项目记忆', icon: <IconFile aria-hidden="true" /> },
      ]} onSelect={({ itemKey }) => navigate(itemKey)} />
      <div className="sidebar-section-label">{workStructure.enabled ? '当前工作' : '工作主线'} <span>{workStructure.navigationCases.length || '—'}</span></div>
      <div className="case-navigation">{workStructure.navigationCases.map((item, index) => <button key={item.id} onClick={() => openCase(item)} className={page !== 'overview' && selected?.id === item.id ? 'selected' : ''}>
        <span className={`work-dot dot-${index % 3}`} /><span>{caseTitle(item)}</span>
      </button>)}{workStructure.secondaryCases.length > 0 && <details className="work-nav-history"><summary>其他主线与历史</summary>{workStructure.secondaryCases.map(item => <button key={item.id} onClick={() => openCase(item)} className={page !== 'overview' && selected?.id === item.id ? 'selected' : ''}><span>{caseTitle(item)}</span><small>{workStateNames[workStructure.metadataById.get(item.id)?.state] || '状态待核对'}</small></button>)}</details>}</div>
      <div className="sidebar-bottom">
        <div className="saved-count"><IconTick aria-hidden="true" /> <span>本地评价</span><span>{reviewCount}</span></div>
        <Button theme="borderless" type="tertiary" icon={<IconSetting aria-hidden="true" />} onClick={() => setDiagnosticsOpen(true)}>数据与展示设置</Button>
        <div className="sidebar-caption">只在这台电脑上展示</div>
      </div>
    </aside>
    <div className="workspace" inert={source ? '' : undefined} aria-hidden={source ? true : undefined}>
      <header className="topbar">
        <Button className="mobile-menu" theme="borderless" type="tertiary" icon={<IconMenu aria-hidden="true" />} aria-label="打开导航" onClick={() => setMobileNav(true)} />
        <div className="breadcrumb"><span>我的工作空间</span><IconChevronRight aria-hidden="true" size="small" /><strong>{sectionNames[page]}</strong></div>
        <div className="topbar-actions"><Tag className="local-tag" color="grey">本地展示</Tag>
          <Tooltip content="需要匿名展示时开启，隐藏已标注的人物、邮箱和来源链接。">
            <label className="mask-switch"><IconEyeClosed aria-hidden="true" /><span>匿名展示</span><Switch size="small" aria-label="匿名展示" checked={masked} onChange={changeIdentityMode} /></label>
          </Tooltip>
        </div>
      </header>
      <main id="main-content" className="main-content" ref={mainRef} tabIndex={-1}>
        {load.state === 'loading' ? <LoadingState /> : load.state === 'error' ? <div className="center-state" role="alert"><IconAlertCircle aria-hidden="true" size="extra-large" /><h1>暂时无法读取资料</h1><p>{load.guideError ? '进展摘要与当前资料不匹配，暂时无法展示。请更新资料后重试。' : '本地资料暂时不可用，请更新资料后重试。'}</p><Button icon={<IconRefresh aria-hidden="true" />} onClick={() => setRetry(value => value + 1)}>重新读取</Button></div> : !dataset.cases.length && !['sources','discovery','memory'].includes(page) ? <div className="center-state"><Empty title="还没有可展示的工作" description="请先在信息源管理中完成自己的授权、导入消息并生成工作候选。" /><Button theme="light" icon={<IconRefresh aria-hidden="true" />} onClick={() => setRetry(value => value + 1)}>重新读取</Button><Button onClick={() => navigate('sources')}>配置并导入信息源</Button></div> : <>
          <div className="dataset-note"><span className="note-dot" />{load.mode === 'demo' ? '演示资料 · 非真实业务记录' : '本地私有资料 · 回答待人工核实'}<span className="note-separator">/</span><span>{masked ? '匿名模式 · 姓名与链接已隐藏' : '姓名模式'}</span></div>
          {load.diagnostics?.length > 0 && <Banner className="data-warning" type="warning" closeIcon={null} description="部分资料的引用或时间范围有误，相关结论待核实。" />}
          {page === 'memory' ? <DiagnosticMemory masked={masked} fullPage /> : page === 'discovery' ? <ProactiveDiscovery masked={masked} /> : page === 'sources' ? <SourceAttention masked={masked} /> : page === 'overview' ? <Overview dataset={dataset} search={search} setSearch={setSearch} openCase={openCase} revealed={revealed} readingGuide={load.reading_guide} masked={masked} {...controls} /> : <div className={`qa-page ${page === 'compare' ? 'comparison-page' : ''}`}>
            <div className="page-heading compact"><div><h1>{page === 'compare' ? '答案比较' : '业务问答'}</h1><p>{page === 'compare' ? '模型与路线直接列出，可按需隐藏模型信息信息。' : '进展、待办与来源依据'}</p></div>
              <LabeledSelect aria-label="选择业务问题" className="case-select" value={selected.id} optionList={workStructure.orderedCases.map(item => ({ value: item.id, label: `${caseTitle(item)}${['background', 'archived', 'candidate'].includes(workStructure.metadataById.get(item.id)?.state) ? ` · ${workStateNames[workStructure.metadataById.get(item.id)?.state] || '状态待核对'}` : ''}` }))} onChange={id => openCase(dataset.cases.find(item => item.id === id), page)} />
            </div>
            <CaseAnswers key={`${selected.id}:${page}`} item={selected} guide={load.reading_guide?.cases.find(row => row.case_id === selected.id)} guideKind={load.reading_guide?.content_kind} compare={page === 'compare'} masked={masked} revealed={revealed} everRevealed={everRevealed} setRevealed={toggleModelVisibility} openCase={openCase} fingerprint={fingerprint} onSaved={setReviewCount} {...controls} />
            {page === 'qa' && <LiveQuestion key={selected.id} item={selected} dataset={dataset} display={load.display} showCitation={showCitation} masked={masked} />}
          </div>}
        </>}
      </main>
    </div>
    <EvidencePanel source={source} onClose={closeSources} masked={masked} present={panelPresent} caseTitle={caseTitle} showCitation={showCitation} readingGuide={load.reading_guide} demo={load.mode === 'demo'} />
    <Modal title="数据与展示设置" visible={diagnosticsOpen} onCancel={() => setDiagnosticsOpen(false)} footer={null} className="settings-modal">
      <div className="settings-group"><h3>当前展示</h3><p>{load.mode === 'private' ? '本地私有资料' : '演示资料'}</p><p>展示模式仅隐藏资料中已标注的人物、邮箱与链接，不代表业务正文可以公开发布。</p><p>本地评价只保存在当前浏览器，按整份资料内容隔离；清理浏览器数据会删除评价。</p><Button icon={<IconRefresh aria-hidden="true" />} onClick={() => { setDiagnosticsOpen(false); setRetry(value => value + 1); }}>重新读取本地资料</Button></div>
      <div className="settings-group"><h3>姓名显示</h3><p>{load.display?.participants?.length ? `已加载 ${load.display.participants.length} 位成员，其中 ${load.display.participants.filter(person => person.display_name).length} 个姓名已核验。默认显示已核实姓名；未确认者显示“姓名待确认”。` : '尚无已核实的姓名。'}</p><p>匿名展示需要手动开启，并记住你的选择。点击正文中的姓名，可查看本人发言和被提及的相关记录。</p></div>
      <details className="settings-group"><summary>技术诊断</summary><dl className="details-list"><dt>Semi UI</dt><dd>{packageInfo.dependencies['@douyinfe/semi-ui']}</dd><dt>飞书 Universe Design</dt><dd>{packageInfo.dependencies['@semi-bot/semi-theme-feishu']}</dd><dt>数据契约</dt><dd>business-qa-v1</dd><dt>数据检查</dt><dd>{load.state !== 'ready' ? '资料未就绪' : load.diagnostics?.length ? `${load.diagnostics.length} 项待核对` : '结构已读取；业务事实待人工核实'}</dd></dl></details>
      <p className="muted">本页评价不会更新正式工作记录。阅读已有资料不会产生模型费用。</p>
    </Modal>
  </div>;
}

const liveProviders = [
  { provider: 'doubao', label: '豆包 Seed 2.1 Pro' },
];
const liveStatusNames = { pending: '正在生成', ok: '生成完成 · 待核实', unconfigured: '尚未配置', error: '生成失败', timeout: '调用超时', invalid_response: '回答格式或引用无效', insufficient_evidence: '证据不足' };

const liveErrorMessages = {
  ASK_CONTEXT_TOO_LARGE: '资料过多，请切换“当前工作主线”后重试。',
  ASK_BUSY: '已有提问生成中，请等待完成后再提交。',
  INVALID_ASK_REQUEST: '问题或补充事实格式无效，请检查字数和事实条数后重试。',
  INVALID_REQUEST: '请求格式无效，请刷新页面后重试。',
  UNKNOWN_CASE: '当前工作主线已不可用，请重新读取资料后再提问。',
  INVALID_QA_PRIVACY_CONFIG: '问答配置暂不可用，请检查本地服务配置。',
  SOURCE_POLICY_CHANGED: '资料范围已变更，本次回答已隐藏，请重新提问。',
  PROVIDER_NOT_CONFIGURED: '此模型尚未配置可用的调用凭据或模型。',
  NO_ELIGIBLE_SOURCES: '当前范围没有可用证据，请选择其他范围或补充事实。',
  INVALID_GROUNDED_ANSWER: '模型返回的回答或引用不符合要求，请重新提问。',
  MISSING_PROVIDER_RESULT: '未收到此模型的结果，请重新提问。',
  PROVIDER_TIMEOUT: '此模型回答超时，请稍后重试。',
  REQUEST_TIMEOUT: '等待回答超时，请稍后重试。',
  PROVIDER_REQUEST_FAILED: '此模型本次请求失败，请稍后重试。',
};
function liveErrorMessage(run, status) {
  const code = run?.error?.code;
  if (Object.hasOwn(liveErrorMessages, code)) return liveErrorMessages[code];
  return status === 'unconfigured' ? '此模型尚未配置可用的调用凭据。' : status === 'insufficient_evidence' ? '当前资料不足以支持此问题，暂不形成事实结论。' : '本次未获得可用回答，可以重新提问重试。';
}

function LiveQuestion({ item, dataset, display, showCitation, masked }) {
  const [question, setQuestion] = useState('');
  const [facts, setFacts] = useState('');
  const [scope, setScope] = useState('all');
  const [request, setRequest] = useState(null);
  const controllerRef = useRef(null);
  const factLines = facts.split('\n').map(line => line.trim()).filter(Boolean);
  const factsInvalid = factLines.length > 20 || factLines.some(line => line.length > 2000);
  const busy = request?.status === 'pending';
  const scopeKey = scope === 'current' ? `current:${item.id}` : 'all';
  const [scopeSummary, setScopeSummary] = useState(null);
  const activeScopeSummary = scopeSummary?.key === scopeKey ? scopeSummary : null;
  const currentScopeTitle = display?.case_titles?.[item.id] || item.title;
  useEffect(() => {
    const controller = new AbortController();
    setScopeSummary({ key: scopeKey, status: 'loading' });
    const query = scope === 'current' ? `?case_id=${encodeURIComponent(item.id)}` : '';
    (async () => {
      try {
        const response = await fetch(`/api/ask-scope${query}`, { signal: controller.signal });
        const summary = await response.json();
        if (!response.ok || !Number.isInteger(summary.record_count) || !Number.isInteger(summary.case_count)
          || !Array.isArray(summary.source_titles) || summary.source_titles.some(title => typeof title !== 'string')) throw new Error('Scope unavailable');
        if (!controller.signal.aborted) setScopeSummary({ key: scopeKey, status: 'ready', ...summary });
      } catch {
        if (!controller.signal.aborted) setScopeSummary({ key: scopeKey, status: 'error' });
      }
    })();
    return () => controller.abort();
  }, [scope, item.id, dataset, request?.request_id]);
  useEffect(() => () => controllerRef.current?.abort(), []);
  const liveItem = useMemo(() => ({
    id: `live:${request?.request_id || item.id}`, live: true, title: '本次实时问答', question: request?.question || '', runs: [],
    as_of: request?.as_of, evidence: request?.sources || [],
  }), [item.id, request]);
  const livePresent = useMemo(() => createPresenter({ ...dataset, cases: [...dataset.cases, liveItem] }, masked, display), [dataset, liveItem, masked, display]);
  const ask = async event => {
    event.preventDefault();
    if (!question.trim() || question.trim().length > 4000 || factsInvalid || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const submitted = { question: question.trim(), facts: factLines, selectedScope: scope };
    const initial = { ...submitted, status: 'pending', sources: [], answers: liveProviders.map(provider => ({ ...provider, status: 'pending' })) };
    setRequest(initial);
    const timeout = setTimeout(() => controller.abort('timeout'), 180000);
    try {
      const response = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: submitted.question, facts: submitted.facts, ...(scope === 'current' ? { case_id: item.id } : {}) }), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) {
        const error = new Error('Ask unavailable');
        error.code = result.error?.code;
        throw error;
      }
      if (!Array.isArray(result.sources) || !Array.isArray(result.answers)) throw new Error('Invalid ask response');
      // Never substitute another provider's answer for the pinned Seed result.
      const answers = liveProviders.map(provider => result.answers.find(answer => answer.provider === provider.provider) || { ...provider, status: 'invalid_response', error: { code: 'MISSING_PROVIDER_RESULT' } });
      setRequest({ ...submitted, ...result, sources: result.sources, answers, status: 'complete' });
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason !== 'timeout') return;
      const status = controller.signal.reason === 'timeout' ? 'timeout' : 'error';
      setRequest({ ...initial, status: 'complete', answers: initial.answers.map(answer => ({ ...answer, status, error: { code: error.code || (status === 'timeout' ? 'REQUEST_TIMEOUT' : 'ASK_UNAVAILABLE') } })) });
    } finally {
      clearTimeout(timeout);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };
  return <section className="answer-section" aria-label="实时业务问答">
    <form className="question-composer" onSubmit={ask} aria-busy={busy}>
      <div className="answer-toolbar"><div className="answer-toolbar-left"><span>提问范围</span></div><LabeledSelect aria-label="实时提问资料范围" value={scope} disabled={busy} onChange={setScope} optionList={[{ value: 'all', label: '全部累计历史' }, { value: 'current', label: '当前工作主线关联历史' }]} /></div>
      <p>{scope === 'current' ? <>当前工作主线：“<RichText value={currentScopeTitle} present={livePresent} interactive={false} />”。</> : '检索全部可用累计历史。'}{activeScopeSummary?.status === 'ready' ? <>{activeScopeSummary.mode === 'cumulative_history' ? <>累计可用 {activeScopeSummary.retained_unique_message_count} 条原文记录（含文档片段，{activeScopeSummary.retained_version_count} 个留存版本）；其中 {activeScopeSummary.document_count ?? 0} 份文档、{activeScopeSummary.document_chunk_count ?? 0} 个文档片段，{scope === 'current' ? '关联当前主线' : '已关联主线'} {activeScopeSummary.linked_unique_message_count} 条原文记录；本范围可检索 {activeScopeSummary.searched_record_count} 个版本</> : <>累计历史尚未配置，当前仅使用卡片附带资料 {activeScopeSummary.record_count} 条</>}{activeScopeSummary.earliest && <>；记录时间 {dateLabel(activeScopeSummary.earliest, true)} 至 {dateLabel(activeScopeSummary.latest, true)}</>}。</> : activeScopeSummary?.status === 'error' ? '资料范围暂时无法读取，请稍后重试。' : '正在读取可用资料范围…'}每次提问选取相关原文，不会发送全部历史。仅覆盖已留存且当前允许的记录；缺少最新证据不代表没有进展。</p>
      {activeScopeSummary?.status === 'ready' && activeScopeSummary.coverage_notes?.length > 0 && <div className="reading-policy">{activeScopeSummary.coverage_notes.map((note, index) => <p key={index}><RichText value={note} present={livePresent} interactive={false} /></p>)}</div>}
      {activeScopeSummary?.status === 'ready' && (activeScopeSummary.undated_record_count > 0 || activeScopeSummary.largest_chronology_gap_days > 1) && <p className="reading-policy">覆盖缺口：{activeScopeSummary.undated_record_count > 0 && <>有 {activeScopeSummary.undated_record_count} 条记录未提供时间；</>}{activeScopeSummary.largest_chronology_gap_days > 1 && <>相邻留存记录的最大间隔约 {Math.floor(activeScopeSummary.largest_chronology_gap_days)} 天；</>}记录间隔不能证明期间没有工作变化。</p>}
      {activeScopeSummary?.status === 'ready' && activeScopeSummary.source_titles.length > 0 && <details className="model-details"><summary>可用资料来源 · {activeScopeSummary.source_titles.length} 个</summary>{activeScopeSummary.source_titles.map((title, index) => <p key={index}><RichText value={title} present={livePresent} interactive={false} /></p>)}</details>}
      <div className="composer-input"><IconComment aria-hidden="true" /><Input aria-label="实时业务问题" value={question} onChange={setQuestion} placeholder="提出问题，基于当前资料实时回答…" maxLength={4000} disabled={busy} showClear /><Button htmlType="submit" theme="solid" disabled={!question.trim() || question.trim().length > 4000 || factsInvalid || busy} loading={busy}>实时提问 <IconArrowRight aria-hidden="true" /></Button></div>
      <details className="model-details"><summary>补充事实（选填）</summary><TextArea aria-label="本次用户补充事实" value={facts} onChange={setFacts} placeholder="每行一条，最多 20 条；这些信息会标为用户补充事实。" disabled={busy} autosize={{ minRows: 2, maxRows: 6 }} /><p>仅作为本次用户提供的信息，与历史来源分别标注。</p>{factsInvalid && <p role="alert">最多补充 20 条事实，每条不超过 2000 字。</p>}</details>
      {masked && <p>匿名展示已开启：编辑框保留输入原文，提交后的展示沿用匿名设置。</p>}
      <p>豆包 Seed 2.1 Pro 实时回答，可查看原文依据。提问及相关资料将发送给此模型；阅读已有回答不会发起调用。</p>
    </form>
    {request && <div aria-label="实时模型回答">
      <div className="question-header"><div className="question-avatar"><IconComment aria-hidden="true" /></div><div><span className="question-work">本次实时提问</span><h2><RichText value={request.question} present={livePresent} interactive={false} /></h2><div className="question-meta"><span>{request.selectedScope === 'current' ? '当前工作主线关联历史' : '全部累计历史'}</span><span>{request.as_of ? `资料截至 ${dateLabel(request.as_of, true)}` : '依据本次读取的资料'}</span><span>{request.sources.length} 条本次选取资料</span><span>{request.scope?.answer_citation_count ?? request.answers.reduce((count, answer) => count + new Set(answer.answer?.claims?.flatMap(claim => claim.source_ids) || []).size, 0)} 条回答引用</span></div></div></div>
      {request.scope?.coverage_gaps?.includes('SOURCE_POLICY_CHANGED') ? <p className="reading-policy">资料权限已变化，本次选取与回答均已隐藏，请重新提问。</p> : request.scope && <p className="reading-policy">{request.scope.mode === 'cumulative_history' ? <>累计可用 {request.scope.retained_unique_message_count} 条原文记录（含文档片段，{request.scope.retained_version_count} 个留存版本）；其中 {request.scope.document_count ?? 0} 份文档、{request.scope.document_chunk_count ?? 0} 个文档片段；本范围检索 {request.scope.searched_record_count} 个版本，匹配 {request.scope.matched_record_count} 个版本，本次选取 {request.scope.returned_record_count} 条原文</> : '本次使用卡片附带资料，累计历史尚未配置'}{request.scope.user_fact_count > 0 && <>；另有用户补充 {request.scope.user_fact_count} 条</>}。{request.scope.truncated && '相关资料超过本次容量，部分匹配记录未发送。'}未检索到的记录不能视为不存在。</p>}
      {request.facts?.length > 0 && <details className="model-details"><summary>本次用户补充事实 · {request.facts.length} 条</summary>{request.facts.map((fact, index) => <p key={index}><RichText value={fact} present={livePresent} interactive={false} /></p>)}</details>}
      <div className="single-answer">
        {liveProviders.map(provider => <LiveAnswer key={provider.provider} provider={provider} run={request.answers.find(answer => answer.provider === provider.provider)} item={liveItem} present={livePresent} showCitation={showCitation} />)}
      </div>
      {request.sources.length > 0 && <div className="all-sources"><IconFile aria-hidden="true" /><span>{request.sources.length} 条本次参考资料</span><button type="button" className="text-link" onClick={event => showCitation(liveItem, liveItem.evidence[0]?.id, event)}>展开本次来源 <IconChevronRight aria-hidden="true" size="small" /></button></div>}
    </div>}
  </section>;
}

function LiveAnswer({ provider, run, item, present, showCitation }) {
  const answer = run?.answer;
  const readable = run?.status === 'ok' && answer && typeof answer.summary === 'string' && Array.isArray(answer.claims) && Array.isArray(answer.uncertainties);
  const status = run?.status === 'ok' && !readable ? 'invalid_response' : run?.status;
  return <article className="answer-card" aria-label={`${provider.label}实时回答`}>
    <div className="answer-card-header"><div className="assistant-name"><Logo small /><strong>{provider.label}</strong></div><Tag color={status === 'ok' ? 'blue' : 'grey'} size="small" role="status">{liveStatusNames[status] || '回答不可用'}</Tag></div>
    {run?.requested_model && <details className="model-details"><summary>本次调用信息</summary><p>请求模型：{run.requested_model}</p><p>返回模型：{run.returned_model || '服务未提供'}</p><p>耗时：{Number.isFinite(run.latency_ms) ? `${run.latency_ms} ms` : '未提供'}</p></details>}
    {status === 'pending' ? <div className="run-unavailable"><p>正在依据本次资料生成回答…</p></div> : !readable ? <div className="run-unavailable"><IconAlertCircle aria-hidden="true" /><h3>{liveStatusNames[status] || '回答不可用'}</h3><p>{liveErrorMessage(run, status)}</p></div> : <div className="answer-body">
      <p className="answer-summary"><RichText value={answer.summary} present={present} item={item} showCitation={showCitation} /></p>
      <section className="answer-section"><h3>依据与结论</h3><div className="answer-lines">{answer.claims.map((claim, index) => <div className="answer-line" key={index}><p><Sentence line={{ text: claim.text, evidence_ids: Array.isArray(claim.source_ids) ? claim.source_ids : [] }} item={item} present={present} showCitation={showCitation} /></p></div>)}</div></section>
      {answer.uncertainties.length > 0 && <section className="answer-section section-open_questions"><h3>尚待确认</h3>{answer.uncertainties.map((text, index) => <p key={index}><RichText value={text} present={present} item={item} showCitation={showCitation} /></p>)}</section>}
      <p className="answer-footnote">模型生成完成；业务事实仍需结合引用原文核实。</p>
    </div>}
  </article>;
}

function LoadingState() {
  return <div className="loading-state" role="status" aria-label="正在读取本地资料"><p>正在读取本地资料…</p><Skeleton active placeholder={<><Skeleton.Title style={{ width: 240, marginBottom: 28 }} /><Skeleton.Paragraph rows={5} /><Skeleton.Paragraph rows={5} style={{ marginTop: 40 }} /></>} loading /></div>;
}

function primaryRun(item, demo, guide) {
  const { runs, leftId } = initialAnswerPair(item, demo, guide);
  return runs.find(run => run.id === leftId && run.answer && (demo || run.status === 'VERIFIED'));
}

function Citation({ item, id, showCitation }) {
  const index = item.evidence.findIndex(evidence => evidence.id === id);
  return <button className={`citation ${index < 0 ? 'citation-missing' : ''}`} aria-label={index < 0 ? '查看缺失的引用' : `查看引用 ${index + 1}`} onClick={event => showCitation(item, id, event)}>{index < 0 ? '?' : index + 1}</button>;
}

function Sentence({ line, item, present, showCitation }) {
  return <><span className="sentence-text"><RichText value={line.text} present={present} item={item} showCitation={showCitation} /></span><span className="citations">{line.evidence_ids.map(id => <Citation key={id} item={item} id={id} showCitation={showCitation} />)}</span></>;
}

function WorkPriority({ metadata, item, present, showCitation }) {
  if (!metadata) return null;
  const order = Object.keys(workBadgeColors);
  const badges = [...new Set([priorityNames[metadata.priority], ...metadata.tags])]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return <div className="work-priority">
    <div className="work-priority-tags">{badges.map(label => <Tag key={label} size="small" color={workBadgeColors[label]} type="light">{label}</Tag>)}{metadata.state !== 'active' && <Tag size="small" color="grey">{workStateNames[metadata.state]}</Tag>}</div>
    <p className="work-priority-reason"><RichText value={metadata.reason} present={present} item={item} showCitation={showCitation} limit={100} /></p>
    <details className="work-priority-details"><summary>排序依据</summary><p><RichText value={metadata.reason} present={present} item={item} showCitation={showCitation} /></p>{metadata.goal && <p>关联目标：<RichText value={metadata.goal} present={present} item={item} showCitation={showCitation} /></p>}<span className="citations">{metadata.evidence_ids.map(id => <Citation key={id} item={item} id={id} showCitation={showCitation} />)}</span>{metadata.last_activity_at && <p className="work-meta">最近业务记录：{dateLabel(metadata.last_activity_at, true)}</p>}</details>
  </div>;
}

function WorkStructureChanges({ structure, dataset, present, caseTitle, showCitation, openCase }) {
  const caseMap = new Map(dataset.cases.map(item => [item.id, item]));
  return <details className="work-structure-changes"><summary>主线变化 <span>{structure.changes.length}</span></summary><p className="scope-note">本次工作分类与排序待确认；历史记录保留。</p>{!structure.changes.length && <p className="scope-note">本轮未记录主线增减或调整。</p>}{structure.changes.map((change, index) => <div className="work-structure-change" key={`${change.kind}:${index}`}><Tag size="small" color="grey">{change.label}</Tag><div className="work-change-titles">{[...new Set([...change.from_case_ids, ...change.to_case_ids])].map(id => <button className="text-link" key={id} onClick={() => openCase(caseMap.get(id))}>{caseTitle(caseMap.get(id))}</button>)}</div><p><RichText value={change.reason} present={present} interactive={false} /></p><span className="citations">{change.references.map(({ item, id }) => <span key={`${item.id}:${id}`}><span className="sr-only">{caseTitle(item)}：</span><Citation item={item} id={id} showCitation={showCitation} /></span>)}</span></div>)}{structure.notes.map((note, index) => <p className="scope-note" key={index}><RichText value={note} present={present} interactive={false} /></p>)}</details>;
}

function WorklineTruthLink({ guides, caseId, masked, demo }) {
  if (masked || demo) return null;
  const url = worklineTruthUrl(guides, caseId);
  return url ? <a className="workline-truth-link" href={url} target="_blank" rel="noopener noreferrer" title="查看该主线的飞书存档及原文证据；资料时间以文档内标注为准。">飞书主线与证据（存档）<IconArrowRight aria-hidden="true" size="small" /></a> : <span className="workline-truth-pending">飞书入口待补充</span>;
}

function Overview({ dataset, search, setSearch, openCase, present, caseTitle, showCitation, demo, revealed, readingGuide, masked }) {
  const [historyScope, setHistoryScope] = useState({ status: 'loading' });
  const [expanded, setExpanded] = useState(false);
  const structure = buildWorkStructureView(dataset, { present, search, match: item => `${caseTitle(item)} ${item.title} ${item.question}` });
  const displayedCases = expanded ? structure.activeCases : structure.visibleCases;
  useEffect(() => {
    const controller = new AbortController();
    setHistoryScope({ status: 'loading' });
    fetch('/api/ask-scope', { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const summary = await response.json();
      if (!response.ok || !Number.isInteger(summary.retained_record_count)) throw new Error('Scope unavailable');
      if (!controller.signal.aborted) setHistoryScope({ status: 'ready', ...summary });
    }).catch(error => { if (error.name !== 'AbortError') setHistoryScope({ status: 'error' }); });
    return () => controller.abort();
  }, [dataset]);
  const guideFor = item => readingGuide?.cases.find(row => row.case_id === item.id);
  const modelGuide = readingGuide?.content_kind === 'model_generated_short_card';
  const { records, conflictingIds } = datasetEvidence(dataset);
  const includedSources = new Set(records.map(({ evidence }) => evidence.source_type));
  const recent = [...records].sort((a, b) => compareEvidenceRecency(a.evidence, b.evidence)).slice(0, 5);
  const renderWorkRow = (item, index) => { const guide = guideFor(item); const run = primaryRun(item, demo, guide); const body = run?.answer; const unavailable = [...new Set(item.runs.map(entry => statusNames[entry.status]).filter(Boolean))]; const unavailableLabel = unavailable.length === 1 ? unavailable[0] : '暂无可阅读回答'; return <article className="work-row" key={item.id}>
          <div className={`work-symbol symbol-${index % 3}`}><IconFile aria-hidden="true" /></div><div className="work-description"><button className="work-title" onClick={() => openCase(item)}>{caseTitle(item)}<IconChevronRight aria-hidden="true" size="small" /></button><WorkPriority metadata={structure.metadataById.get(item.id)} item={item} present={present} showCitation={showCitation} /><p className="work-excerpt">{body ? <RichText value={guide?.current.text || body.summary} present={present} item={item} showCitation={showCitation} limit={88} /> : '还没有可阅读的回答，等待问答资料更新。'}</p>{body && <button className="text-link read-full" onClick={() => openCase(item)}>查看完整回答 <IconArrowRight aria-hidden="true" size="small" /></button>}<div className="work-meta">{run && <span>{guide ? '进展摘要' : '回答摘要'}</span>}<span>{item.evidence.length} 条卡片附带原文</span><span>更新于 {dateLabel(latestEvidenceTime(item.evidence))}</span><WorklineTruthLink guides={readingGuide?.cases} caseId={item.id} masked={masked} demo={demo} /></div></div>
          <div className="work-followup"><Tag color={body?.open_questions.length ? 'amber' : 'grey'} size="small">{body ? (body.open_questions.length ? '有未决事项' : '待核实') : unavailableLabel}</Tag><p>{guide ? <><span className="guide-advice">{modelGuide ? '模型建议' : '助理建议'}</span><RichText value={guide.follow_up.person} person present={present} item={item} showCitation={showCitation} /> · <RichText value={guide.follow_up.text} present={present} item={item} showCitation={showCitation} limit={46} /></> : body?.next_steps[0] ? <RichText value={body.next_steps[0].text} present={present} item={item} showCitation={showCitation} limit={46} /> : '等待问答资料更新'}</p><Button size="small" theme="borderless" onClick={() => openCase(item)}>查看进展 <IconArrowRight aria-hidden="true" size="small" /></Button></div>
        </article>; };
  return <div className="overview-page">
    <div className="page-heading"><div><h1>工作概览</h1><p>工作进展与待办</p></div><div className="cutoff"><span className="clock-dot" />资料截至 {dateLabel(dataset.as_of, true)}</div></div>
    <div className="overview-columns"><div className="overview-primary">
      <section className="work-section"><div className="section-toolbar"><h2>{structure.enabled ? '当前工作' : '工作主线'} <span>{displayedCases.length}</span></h2><Input prefix={<IconSearch aria-hidden="true" />} aria-label="筛选工作主线" placeholder="查找工作" value={present(search)} onChange={setSearch} showClear className="work-search" /></div>
        <div className="work-table-head"><span>当前变化</span><span>待跟进</span></div>
        {!structure.activeCases.length && !structure.deferredCases.length && <Empty className="filtered-empty" title="没有匹配的工作" description="换一个关键词试试。" />}
        <div className="work-list">{displayedCases.map(renderWorkRow)}</div>
        {structure.enabled && structure.urgentOverflow > 0 && !expanded && <p className="scope-note" role="status">紧急事项已全部展示，本次显示 {displayedCases.length} 条。</p>}
        {structure.enabled && structure.activeCases.length > structure.visibleCases.length && <Button theme="borderless" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? '收起主线' : `展开其余 ${structure.hiddenActiveCount} 条主线`}</Button>}
        {structure.enabled && structure.deferredCases.length > 0 && <details className="work-structure-history"><summary>后续关注、待确认与历史 <span>{structure.deferredCases.length}</span></summary><div className="work-list">{structure.deferredCases.map(renderWorkRow)}</div></details>}
        {structure.enabled && <WorkStructureChanges structure={structure} dataset={dataset} present={present} caseTitle={caseTitle} showCitation={showCitation} openCase={openCase} />}

      </section>
      <div className="overview-footer"><IconEyeOpened aria-hidden="true" /><span>{readingGuide ? (modelGuide ? '摘要与完整回答均待人工核实，可查看引用来源。' : '摘要与完整回答均待人工核实，可查看引用来源。') : '展示当前可用回答，结论待人工核实。'}{demo ? '样例未调用模型。' : ''}</span></div>
    </div><aside className="overview-context"><section><h2>资料范围</h2><div className="scope-count"><strong>{historyScope.status === 'ready' ? historyScope.mode === 'cumulative_history' ? historyScope.stored_unique_message_count : records.length : '—'}</strong><span>{historyScope.mode === 'cumulative_history' ? '条累计留存记录' : historyScope.status === 'ready' ? '条卡片附带原文' : '正在核对累计范围'}</span></div><p className="scope-note">{historyScope.status === 'ready' ? historyScope.mode === 'cumulative_history' ? <>{historyScope.earliest && <>可用记录时间：{dateLabel(historyScope.earliest)} 至 {dateLabel(historyScope.latest)}。<br /></>}留存 {historyScope.stored_version_count} 个原文版本，含 {historyScope.stored_version_count - historyScope.stored_unique_message_count} 个差异版本。<br />当前可用于问答 {historyScope.retained_unique_message_count} 条原文记录（含文档片段）；已关联主线 {historyScope.linked_unique_message_count} 条原文记录；其中 {historyScope.document_count ?? 0} 份文档、{historyScope.document_chunk_count ?? 0} 个文档片段；卡片当前展示 {records.length} 条原文。<br />时间范围仅涵盖有明确时间的记录；无日期文档仍可检索。实时问答从累计历史中选取相关资料。</> : <>累计历史尚未配置。<br />当前仅展示 {records.length} 条卡片附带原文。</> : historyScope.status === 'error' ? '累计资料范围暂时无法读取。' : '正在读取累计资料范围…'}</p><div className="source-types">{Object.entries(sourceNames).filter(([type]) => includedSources.has(type)).map(([type, name]) => <span key={type}><i className={`source-type-dot ${type}`} />{name}</span>)}</div><p className="scope-note">当前卡片覆盖 {dataset.cases.length} 个业务问题。<br />跨问题的相同记录仅计一次。<br />仅覆盖已留存且当前允许的记录，缺少最新证据不代表没有进展。</p>{historyScope.coverage_notes?.map((note, index) => <p className="scope-note" key={index}><RichText value={note} present={present} interactive={false} /></p>)}{conflictingIds > 0 && <p className="scope-warning" role="status">有证据编号对应不同内容，已分别保留，请核对资料。</p>}</section><section className="recent-section"><h2>最近的依据</h2><div className="recent-timeline">{recent.map(({ item, evidence }) => <button key={`${item.id}/${evidence.id}`} className="recent-item" onClick={event => showCitation(item, evidence.id, event)}><span className="timeline-point" /><time>{dateLabel(evidence.occurred_at, true)}</time><strong title={present(evidence.source_title)}>{present(evidence.speaker || evidence.source_title)}</strong><span><RichText value={evidence.text} present={present} interactive={false} /></span></button>)}</div></section></aside></div>
  </div>;
}

function CaseAnswers({ item, guide, guideKind, compare, demo, present, caseTitle, showCitation, masked, revealed, everRevealed, setRevealed, openCase, fingerprint, onSaved }) {
  const initial = useMemo(() => initialAnswerPair(item, demo, guide), [item, demo, guide]);
  const runs = initial.runs;
  const modelGuide = guideKind === 'model_generated_short_card';
  const [leftId, setLeftId] = useState(initial.leftId);
  const [rightId, setRightId] = useState(initial.rightId);
  const [fullAnswerOpen, setFullAnswerOpen] = useState(!guide);
  const originalId = useId();
  const left = runs.find(run => run.id === leftId);
  const right = runs.find(run => run.id === rightId);
  const options = runs.map(run => ({ value: run.id, label: `${runLabel(run, revealed)}${!demo && statusNames[run.status] ? ` · ${statusNames[run.status]}` : ''}` }));
  const chooseLeft = id => { if (id === rightId) setRightId(leftId); setLeftId(id); };
  const chooseRight = id => { if (id === leftId) setLeftId(rightId); setRightId(id); };
  return <>
    <section className="question-header"><div className="question-avatar"><IconComment aria-hidden="true" /></div><div><span className="question-work">{caseTitle(item)}</span><h2>{present(item.question)}</h2><div className="question-meta"><span>资料截至 {dateLabel(item.as_of, true)}</span><span>{present(scopeLabel(item.scope))}</span></div></div></section>
    {!compare && guide && <ReadingGuide guide={guide} modelGuide={modelGuide} canCompare={initial.canCompare} run={runs.find(run => run.id === guide.run_id)} item={item} present={present} showCitation={showCitation} revealed={revealed} masked={masked} openCase={openCase} />}
    {!compare && guide && <Button className="full-answer-toggle" theme="borderless" aria-expanded={fullAnswerOpen} aria-controls={originalId} onClick={() => setFullAnswerOpen(value => !value)}>{fullAnswerOpen ? '收起完整回答' : modelGuide ? '展开完整回答与模型信息' : '展开完整回答'}<IconChevronRight aria-hidden="true" size="small" /></Button>}
    <div id={originalId} hidden={!compare && guide && !fullAnswerOpen}>
    <div className="answer-toolbar"><div className="answer-toolbar-left"><span>{compare ? '双答案阅读' : '当前回答'}</span></div><div className="answer-toolbar-actions"><Button size="small" theme="borderless" type="tertiary" icon={revealed ? <IconEyeClosed aria-hidden="true" /> : <IconEyeOpened aria-hidden="true" />} onClick={() => setRevealed(value => !value)}>{revealed ? '隐藏模型信息' : '显示模型信息'}</Button></div></div>
    <p className="reading-policy">{guide ? (modelGuide ? '完整回答 · 结论待核实' : '完整回答 · 结论待核实') : '当前可用回答 · 结论待核实'}</p>
    {!runs.length ? <Empty className="question-empty" title="这个问题还没有回答" description="原始记录可阅读，回答等待下一次资料更新。" /> : compare && !initial.canCompare ? <Empty className="question-empty" title="还需要另一份回答" description="同一问题载入两份或更多可阅读的回答后，即可比较。" /> : <>
      <div className={compare ? 'answer-pair' : 'single-answer'}>
        {(compare ? [left, right] : [left]).map((run, index) => <article className="answer-card" key={index} data-testid={`answer-${index}`}>
          <div className="answer-card-header"><div className="assistant-name"><Logo small /><strong>{compare ? (index === 0 ? '左侧回答' : '右侧回答') : '第三大脑'}</strong><Tag color="grey" size="small">{demo ? '示例回答' : statusNames[run?.status] || '待评阅'}</Tag></div>{!compare && run && <span className="answer-identity">{runLabel(run, revealed)}</span>}{compare && <LabeledSelect className="run-select" dropdownClassName="run-options" aria-label={index === 0 ? '选择左侧答案' : '选择右侧答案'} value={run?.id} optionList={options} onChange={index === 0 ? chooseLeft : chooseRight} />}</div>
          {run && <AnswerBody run={run} item={item} demo={demo} revealed={revealed} present={present} showCitation={showCitation} />}
        </article>)}
      </div>
      <Evaluation guidePresent={Boolean(guide)} modelGuide={modelGuide} key={JSON.stringify([item.id, leftId, compare ? rightId : null, fingerprint])} item={item} runs={compare ? [left, right].filter(Boolean) : [left].filter(Boolean)} fingerprint={fingerprint} onSaved={onSaved} revealed={revealed} everRevealed={everRevealed} masked={masked} demo={demo} present={present} />
    </>}
    </div>
    <div className="all-sources"><IconFile aria-hidden="true" /><span>{item.evidence.length} 条卡片附带原文</span><WorklineTruthLink guides={guide ? [guide] : []} caseId={item.id} masked={masked} demo={demo} /><button className="text-link" onClick={event => showCitation(item, item.evidence[0]?.id, event)}>展开全部来源 <IconChevronRight aria-hidden="true" size="small" /></button></div>
  </>;
}

function ReadingGuide({ guide, modelGuide, canCompare, run, item, present, showCitation, revealed, masked, openCase }) {
  return <section className="reading-guide" aria-label={modelGuide ? '进展摘要' : '进展摘要'}>
    <header><span className="guide-caption">{modelGuide ? '进展摘要 · 待核实' : '进展摘要 · 待核实'}</span><details className="guide-model"><summary>回答信息</summary>{runLabel(run, revealed)}</details></header>
    <h3>{present(guide.title)}</h3>
    <dl>{[['current', '当前进展'], ['follow_up', '跟进对象'], ['confirm', '待确认事项']].map(([key, label]) => <div className="guide-row" key={key}><dt>{label}</dt><dd>{key === 'follow_up' && <span className="guide-advice">{modelGuide ? '模型建议' : '助理建议'}</span>}{key === 'follow_up' && !present.hasPerson(guide[key].text, guide[key].person) && <><RichText value={guide[key].person} person present={present} item={item} showCitation={showCitation} /> · </>}<Sentence line={guide[key]} item={item} present={present} showCitation={showCitation} /></dd></div>)}</dl>
    <div className="guide-boundary"><span>尚待核实：</span><Sentence line={guide.boundary} item={item} present={present} showCitation={showCitation} /></div>
  </section>;
}

function AnswerBody({ run, item, demo, revealed, present, showCitation }) {
  if (!run.answer || (!demo && run.status !== 'VERIFIED')) return <div className="run-unavailable" role="status"><IconAlertCircle aria-hidden="true" /><h3>{statusNames[run.status] || '暂无可阅读的回答'}</h3><p>回答尚未完成，原始记录仍可查看。</p></div>;
  const body = run.answer;
  const cumulativeMetrics = Number.isInteger(run.metrics.generation_attempts) && run.metrics.generation_attempts > 1;
  const sections = [
    ['developments', '关键变化'], ['viewpoints', '各方观点'], ['decisions', '已记录的决定'],
    ['open_questions', '待确认事项'], ['next_steps', '下一步'],
  ];
  return <div className="answer-body">
    {revealed && <details className="model-details" data-testid="model-details"><summary>调用详情</summary><p>{run.provider} · {run.model}</p><p>{demo ? '人工编写样例 · 无模型调用' : `运行状态 ${run.status} · 引用检查 ${run.audit.citations}`}</p><p>{cumulativeMetrics ? '累计耗时' : '耗时'} {run.metrics.latency_ms === null ? '未提供' : `${run.metrics.latency_ms} ms`} · 成本 {run.metrics.cost_cny === null ? '未提供' : `¥ ${run.metrics.cost_cny}`}</p>{cumulativeMetrics && <p>本题累计 {run.metrics.generation_attempts} 次调用，含失败与修订；不含连通性检查。</p>}{run.route === 'B' && <p>B 路线的首问成本包含建档。</p>}<p>输入 / 输出 Token：{run.metrics.input_tokens ?? '未提供'} / {run.metrics.output_tokens ?? '未提供'}</p></details>}
    {run.audit.citations === 'invalid' && <Banner type="danger" closeIcon={null} description="此回答存在无效引用，不能据此确认事实。" />}
    <p className="answer-summary"><RichText value={body.summary} present={present} item={item} showCitation={showCitation} /></p>
    {sections.filter(([key]) => body[key].length > 0).map(([key, label]) => <section className={`answer-section section-${key}`} key={key}><h3>{label}</h3><div className="answer-lines">{body[key].map((line, index) => <div className="answer-line" key={index}>
      {key === 'viewpoints' && !present.hasPerson(line.text, line.person) && <span className="speaker-name"><RichText value={line.person} person present={present} item={item} showCitation={showCitation} /></span>}
      {key === 'next_steps' && <Tag size="small" color={line.kind === 'assistant_suggestion' ? 'grey' : 'blue'}>{line.kind === 'assistant_suggestion' ? '助理建议' : '资料中的待办'}</Tag>}
      <p><Sentence line={line} item={item} present={present} showCitation={showCitation} /></p>
    </div>)}</div></section>)}
    <p className="answer-footnote">依据以上资料整理，尚不能证明截止时间之后的进展。</p>
  </div>;
}

function Evaluation({ item, runs, guidePresent, modelGuide, fingerprint, onSaved, revealed, everRevealed, masked, demo, present }) {
  const pair = runs.length > 1;
  const key = fingerprint ? savedKeyPrefix + fingerprint : null;
  const [quality, setQuality] = useState(null);
  const [preferred, setPreferred] = useState(null);
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const canReview = runs.length && runs.every(run => run.answer && (demo || run.status === 'VERIFIED'));
  useEffect(() => {
    if (!key) return;
    try {
      const record = readReviews(key, localStorage).find(row => row.case_id === item.id && JSON.stringify(row.run_ids) === JSON.stringify(runs.map(run => run.id)));
      if (record) { setQuality(record.judgment); setPreferred(record.preferred_run_id); setNote(record.note); setSaved(true); }
    } catch { setStorageError(true); }
  }, [key]);
  const save = () => {
    try {
      const records = saveReview(key, { schema_version: 'business-review-v1', dataset_fingerprint: fingerprint, case_id: item.id, run_ids: runs.map(run => run.id), judgment: quality, preferred_run_id: quality === 'both_bad' ? null : preferred, note, models_revealed: revealed || everRevealed || localStorage.getItem(key + 'exposed') === 'true', models_visible_at_save: revealed, identities_masked: masked, saved_at: new Date().toISOString(), sample: demo }, localStorage);
      setSaved(true); setStorageError(false); onSaved(records.length); Toast.success('评价已保存在本地浏览器');
    } catch { setSaved(false); setStorageError(true); }
  };
  return <section className="evaluation" aria-label="本地评价"><div className="evaluation-heading"><h3>{pair ? '哪份完整原答更有帮助？' : modelGuide ? '回答评价' : guidePresent ? '回答评价' : '回答评价'}</h3>{saved && <span className="saved-badge" role="status"><IconTick aria-hidden="true" size="small" />已保存在本地</span>}</div>
    {!canReview ? <p className="muted">回答尚未完成，暂不能评价。</p> : <><div className="evaluation-options">{pair && <LabeledSelect className="run-select" dropdownClassName="run-options" aria-label="偏好的答案" placeholder="选择偏好的回答" value={preferred} onChange={value => { setPreferred(value); setSaved(false); }} optionList={[{ value: runs[0].id, label: `左侧 · ${runLabel(runs[0], revealed)}` }, { value: runs[1].id, label: `右侧 · ${runLabel(runs[1], revealed)}` }, { value: 'equal', label: '两份相近' }]} />}{qualityOptions.filter(option => pair || option.value !== 'both_bad').map(option => <Button size="small" key={option.value} theme={quality === option.value ? 'light' : 'borderless'} type={quality === option.value ? 'primary' : 'tertiary'} aria-pressed={quality === option.value} onClick={() => { setQuality(option.value); setSaved(false); }}>{option.label}</Button>)}</div>
      {quality && <div className="evaluation-editor"><TextArea aria-label="评价补充说明" placeholder="补充评价或需要修正的内容（选填）" value={masked ? present(note) : note} maxCount={2000} autosize={{ minRows: 2, maxRows: 5 }} onChange={value => { setNote(value); setSaved(false); }} /><div className="evaluation-save"><p>评价对象为完整回答，保存于当前浏览器。</p>{everRevealed && <details><summary>评价记录详情</summary><p>本次评价会记录模型信息曾经可见。</p></details>}<Button size="small" theme="solid" disabled={!key || (pair && quality !== 'both_bad' && !preferred)} onClick={save}>保存本地评价</Button></div></div>}
    </>}{storageError && <p className="storage-error" role="alert">本地存储不可用或已有记录损坏，评价尚未保存。请检查浏览器存储权限。</p>}
  </section>;
}

function EvidencePanel({ source, onClose, masked, present, caseTitle, showCitation, readingGuide, demo }) {
  const scrollRef = useRef(null);
  useEffect(() => {
    if (!source) return;
    const timer = setTimeout(() => {
      const panel = scrollRef.current?.closest('.semi-sidesheet-inner');
      panel?.querySelector('.semi-sidesheet-close')?.focus();
      scrollRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'start', behavior: 'auto' });
    }, 100);
    const trapFocus = event => {
      if (event.key !== 'Tab') return;
      const panel = scrollRef.current?.closest('.semi-sidesheet-inner');
      const nodes = [...(panel?.querySelectorAll('button:not([disabled]), a[href], [tabindex="0"]') || [])];
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trapFocus);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', trapFocus); };
  }, [source?.id, source?.item.id]);
  const found = source?.item.evidence.some(evidence => evidence.id === source.id);
  return <SideSheet title={<div className="source-panel-heading"><div className="source-panel-title"><IconFile aria-hidden="true" />依据原文<span>{source?.item.evidence.length || 0} 条</span></div>{source && <WorklineTruthLink guides={readingGuide?.cases} caseId={source.item.id} masked={masked} demo={demo || source.item.live} />}</div>} visible={Boolean(source)} onCancel={onClose} width={448} placement="right" className="evidence-sheet" aria-label="依据原文" closeOnEsc={true} maskClosable={true} closeIcon={<span aria-label="关闭原文"><IconClose aria-hidden="true" /></span>}>
    {source && <div className="evidence-content" ref={scrollRef} onKeyDownCapture={event => {
      // Semi consumes Escape on a popover trigger even after its card closes.
      if (event.key === 'Escape' && event.target.closest('button.person-mention')?.getAttribute('aria-expanded') === 'false') { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}><div className="source-context"><strong>{caseTitle(source.item)}</strong><p>{masked ? '人物、邮箱与链接已隐藏 · 正文仍可能包含业务信息' : '原始记录片段 · 已核实的人物显示姓名'}</p></div>
      {!found && <Banner type="danger" closeIcon={null} description="未找到此引用对应的原文。请将该结论标记为需要修正。" />}
      {source.item.evidence.map((evidence, index) => { const url = !masked && safeSourceUrl(evidence.url); return <article key={evidence.id} className={`evidence-piece ${evidence.id === source.id ? 'is-selected' : ''}`} data-selected={evidence.id === source.id} data-testid={`evidence-${index + 1}`}><div className="evidence-piece-head"><span className="reference-number">{index + 1}</span><Tag size="small" color="grey">{sourceNames[evidence.source_type]}</Tag>{evidence.id === source.id && <span className="located-label">已定位</span>}</div><h3>{present(evidence.source_title)}</h3><div className="evidence-byline"><Avatar size="extra-extra-small" color="grey">{present.person(evidence.speaker)[0]?.status === 'unknown' ? '?' : present(evidence.speaker).slice(0, 1)}</Avatar><strong><RichText value={evidence.speaker} person present={present} item={source.item} showCitation={showCitation} /></strong><time>{evidence.occurred_at ? dateLabel(evidence.occurred_at, true) : evidence.source_type === 'user_fact' ? '本次补充' : '时间未提供'}</time></div>{evidence.link_basis === 'inferred_related' && <p className="reading-policy">此记录由内容相关性关联到当前主线，关联关系待核实。</p>}{evidence.conflict && <p className="reading-policy">同一原始记录保留了多个内容版本，请核对时间与差异。</p>}<blockquote>{masked ? <RichText value={evidenceDisplayText(evidence)} present={present} item={source.item} showCitation={showCitation} /> : <SourceRichText value={evidenceDisplayText(evidence)} renderText={value => <RichText value={value} present={present} item={source.item} showCitation={showCitation} />} />}</blockquote><div className="evidence-locator"><details><summary>来源定位详情</summary><span>{present(evidence.locator)}</span></details>{url && <a href={url} target="_blank" rel="noopener noreferrer">打开来源 <IconArrowRight aria-hidden="true" size="small" /></a>}</div></article>; })}
      {!source.item.evidence.length && <Empty title="没有原始记录" description="当前资料不足以回看这份回答的依据。" />}
    </div>}
  </SideSheet>;
}

createRoot(document.getElementById('root')).render(<App />);
