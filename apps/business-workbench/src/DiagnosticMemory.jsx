import React,{useEffect,useRef,useState} from 'react';
import Button from '@douyinfe/semi-ui/lib/es/button/index.js';
import Input from '@douyinfe/semi-ui/lib/es/input/index.js';
import {MemoryPlaybookCard} from './TicketMemory.jsx';
import {mergeMemoryRecords,memoryReviewRows,memoryRunReceipts} from './memory-review-presentation.mjs';
import {memoryInjectionView,memoryStageLabel} from './diagnostic-memory-presentation.mjs';
import {memoryDirectionCounts,memoryDirection,readableMemoryText} from '../memory-pattern.mjs';
import {cleanMentions} from './presentation.mjs';

function MemoryHowItWorks(){
 return <details className="memory-explainer"><summary>记忆怎样帮你回答下一个问题？</summary>
  <p>可以把它想成一本按方向分隔的经验笔记：每完成一次讨论，就把有依据的分析方法写成一张卡。</p>
  <ol className="memory-flow" aria-label="记忆工作流程">{[
   ['读工单','连同提问、答复和引用原图一起读'],['写经验卡','按你选定的七段整理，成功后自动生效'],['放进分类夹','成本、指标汇报、异常口径分开存'],['找相关卡','新问题先找同方向、周期或上下游经验'],['交给分析助手','带上适用方法，再查本期数据、写报告'],
  ].map(([title,text],i)=><li key={title}><span>{i+1}</span><strong>{title}</strong><p>{text}</p></li>)}</ol>
  <p className="memory-example">例如：上期账单核实留下“服务端与网关逐项核对”的方法 → 本期核查时找出这张卡 → 重新取得本期数据。上期的金额和匹配率不会变成本期答案。</p>
  <p>Mem0 像“图书管理员”。现在由第三大脑自己整理、查找经验；Mem0 尚未接入实际使用。</p>
 </details>;
}
export default function DiagnosticMemory({masked,fullPage=false}){
 const [data,setData]=useState(null),[error,setError]=useState(''),[search,setSearch]=useState(''),[direction,setDirection]=useState('ALL'),[selectedId,setSelectedId]=useState(''),[archive,setArchive]=useState(false);
 const generation=useRef(0),detailRef=useRef(null);
 function chooseMemory(id){setSelectedId(id);if(window.matchMedia('(max-width: 900px)').matches)requestAnimationFrame(()=>detailRef.current?.scrollIntoView({block:'start',behavior:'smooth'}));}
 async function load(signal){const current=generation.current;try{const r=await fetch('/api/discovery-memory',{cache:'no-store',signal});if(!r.ok)throw Error();const value=await r.json();if(current===generation.current){setData(value);setError('');}}catch(e){if(e.name!=='AbortError'&&current===generation.current)setError('记忆暂时无法读取，请刷新重试。');}}
 useEffect(()=>{generation.current++;setData(null);setError('');if(masked)return;const controller=new AbortController();load(controller.signal);return()=>{generation.current++;controller.abort();};},[masked]);
 if(masked)return fullPage?<div className="attention-page"><h1>项目记忆</h1><p>关闭匿名展示后可查看自己的记忆。</p></div>:null;
 const all=mergeMemoryRecords(data?.records||[],data?.candidatePlaybooks||[]),methods=all.filter(r=>r.queryPattern),counts=memoryDirectionCounts(methods);
 const rows=memoryReviewRows(all,data?.runs,{origin:archive?'REFERENCE':'METHOD',search,direction});
 const selected=rows.find(r=>r.id===selectedId)||rows[0];
 const uses=selected?memoryRunReceipts(selected,data?.runs):[];
 const body=<>
  <section className="attention-card memory-library" aria-label="项目记忆"><header><div><p className="muted">提取成功后自动生效。先看怎么回答，再按需展开原文。</p></div><Button onClick={()=>load()}>刷新记忆</Button></header>
  <MemoryHowItWorks/>
  <nav className="memory-directions" aria-label="记忆方向"><button type="button" aria-pressed={direction==='ALL'} onClick={()=>{setDirection('ALL');setSelectedId('');}}>全部方向 <span>{methods.length}</span></button>{counts.map(d=><button type="button" key={d.id} aria-pressed={direction===d.id} onClick={()=>{setDirection(d.id);setSelectedId('');setArchive(false);}}>{d.label} <span>{d.count}</span></button>)}</nav>
  <div className="memory-tools"><Input aria-label="搜索记忆" value={search} onChange={setSearch} placeholder="搜索问题或分析方法" showClear style={{maxWidth:360}}/><span className="muted">{rows.length} 条记忆</span></div>
  {error&&<p role="alert">{error}</p>}{!data&&!error&&<p role="status">正在读取记忆…</p>}
  {data&&<div className="memory-reader"><nav className="memory-list" aria-label="记忆列表">{rows.map(r=><button type="button" key={r.id} aria-pressed={selected?.id===r.id} onClick={()=>chooseMemory(r.id)}><span>{memoryDirection(r).label}</span><strong>{readableMemoryText(r.title)}</strong><small>{r.sourceTicketTitle||cleanMentions(r.originalQuestion)||'查看原工单提问'}</small></button>)}</nav><div className="memory-detail" ref={detailRef} tabIndex={-1}>{selected?<>
   {selected.queryPattern?<MemoryPlaybookCard record={selected}/>:<article><h3>{selected.title}</h3><p>{cleanMentions(selected.text)}</p></article>}
   {selected.sourceTicketId&&<a className="memory-source-link" href={'/?view=discovery&ticket='+encodeURIComponent(selected.sourceTicketId)}>回到原工单 ↗</a>}
   <details className="memory-uses"><summary>后来的问题用了这条记忆吗？ · {uses.filter(u=>u.receipts.some(r=>r.responded)).length} 个问题</summary>{uses.length?uses.map(u=><details key={u.runId}><summary>{cleanMentions(u.question)} · {u.state}</summary>{u.receipts.map((r,i)=><section key={i}><p>{memoryStageLabel(r.stage)} · 第 {r.round} 轮 · {r.responded?'已带入并收到回答':'尚未收到回答'}</p><details><summary>查看当时带入的记忆原文</summary><pre className="memory-pattern">{r.block}</pre></details></section>)}</details>):<p className="muted">还没有后续问题使用这条记忆的记录。</p>}</details>
  </>:<p className="attention-empty">这个方向下还没有匹配的记忆。</p>}</div></div>}
  <details className="memory-more"><summary>更多查看方式</summary><Button theme="borderless" onClick={()=>{setArchive(!archive);setDirection('ALL');setSelectedId('');}}>{archive?'返回分析经验':'查看早期摘录'}</Button>{data?.evaluationAvailable&&<p><a href="/api/memory-evaluation" target="_blank" rel="noreferrer">查看已有的有／无记忆报告对照 ↗</a></p>}{data?.periodicTestAvailable&&<p><a href="/api/memory-periodic-test" target="_blank" rel="noreferrer">查看7月账单 → 本期核查试验 ↗</a></p>}</details>
  </section>
 </>;
 return fullPage?<div className="attention-page memory-page"><div className="page-heading compact"><div><h1>项目记忆</h1><p>从工单里留下方法，帮助回答下一次问题</p></div></div>{body}</div>:body;
}
export function RunMemory({run}){
 const view=memoryInjectionView(run);
 return <details className="answer-section"><summary>本次参考的记忆 · {view.label}</summary>{(run.memorySnapshot?.selected||[]).map(r=><section key={r.id}><h4>{r.title}</h4><p>{r.text}</p></section>)}{view.receipts.map((r,i)=><details key={i}><summary>{memoryStageLabel(r.stage)} · 第 {r.round} 轮 · {r.responded?'已带入并收到回答':'尚未收到回答'}</summary><pre className="memory-pattern">{r.block}</pre></details>)}</details>;
}
