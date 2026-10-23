import Button from '@douyinfe/semi-ui/lib/es/button/index.js';
import React, {useEffect,useRef,useState} from 'react';
import {memoryInjectionView,memoryStageLabel} from './diagnostic-memory-presentation.mjs';
import SourceRichText from './SourceRichText.jsx';

import {memoryPattern,readableMemoryText} from '../memory-pattern.mjs';
const dateLabel=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'日期未记录';
const bullets=(items,empty)=>items?.length?<ul>{items.map((item,i)=><li key={i}>{readableMemoryText(item)}</li>)}</ul>:<p className="muted">{empty}</p>;
export function MemoryPlaybookCard({record}){
 const view=memoryPattern(record);
 return <article className="memory-playbook">
  <div className="memory-playbook-meta">{view.direction.label} · {record.status==='DISABLED'?'已停用':'自动生效'}</div>
  <h3>{readableMemoryText(record.title)}</h3>
  <details className="memory-original"><summary>原文 · 提问、答复与原图</summary>
   <SourceRichText value={record.originalQuestion||''}/>
   {record.originalEvidence?.map(item=><section className="memory-evidence" key={item.id}><p className="muted">{item.speaker||'来源资料'} · {dateLabel(item.at)}</p><SourceRichText value={item.text||''}/></section>)}
   {record.attachments?.map(image=><figure key={image.id}><figcaption>{image.relation==='NEARBY_CANDIDATE'?'临近图片，关联待确认':'对应消息原图'} · {dateLabel(image.at)}</figcaption>{image.imagePath&&<a href={image.imagePath} target="_blank" rel="noreferrer"><img src={image.imagePath} alt={image.caption||'历史消息原图'} loading="lazy"/></a>}</figure>)}
  </details>
  <section><h4>问题模式</h4><p className="memory-question">{readableMemoryText(view.question)}</p></section>
  <section><h4>下次如何回答</h4><ol className="memory-method">{view.steps.map((step,i)=><li key={i}>{readableMemoryText(step.action)}</li>)}</ol></section>
  <section><h4>交付清单</h4>{bullets(view.outputs,'本条未单独记录交付要求。')}</section>
  <div className="memory-conditions">
   <section><h4>适用条件</h4>{bullets(view.useWhen,'按本次问题核对适用范围。')}</section>
   <section><h4>不能直接套用</h4>{bullets(view.doNotUseWhen,'旧结论和旧数值不能直接作为本期答案。')}</section>
  </div>
  <section className="memory-current"><h4>仍需当前资料</h4>{bullets(view.currentMaterials.slice(0,4),'按本期问题重新取得数据与口径。')}{view.currentMaterials.length>4&&<details><summary>另有 {view.currentMaterials.length-4} 项需要补齐</summary>{bullets(view.currentMaterials.slice(4),'')}</details>}</section>
 </article>;
}

export default function TicketMemory({ticketId}){
 const [data,setData]=useState(null),[error,setError]=useState(''),[building,setBuilding]=useState(false),[buildMessage,setBuildMessage]=useState('');
 const epoch=useRef(0);
 useEffect(()=>{
  const controller=new AbortController();let current=true;epoch.current++;setData(null);setError('');setBuilding(false);setBuildMessage('');
  fetch('/api/ticket-memory?ticket='+encodeURIComponent(ticketId),{cache:'no-store',signal:controller.signal}).then(async response=>{if(!response.ok)throw Error();return response.json();}).then(value=>{if(current)setData(value);}).catch(error=>{if(current&&error.name!=='AbortError')setError('工单记忆暂不可读取，请核对来源授权后重新打开。');});
  return()=>{current=false;epoch.current++;controller.abort();};
 },[ticketId]);
 async function build(){
  if(building)return;const version=epoch.current;setBuilding(true);setBuildMessage('');
  try{
   const response=await fetch('/api/ticket-memory-build',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticketId})});
   if(!response.ok)throw Error();const receipt=await response.json();
   if(epoch.current!==version)return;
   setBuildMessage(receipt.status==='DEFERRED_BUDGET'?'今日额度不足，已留待处理。':receipt.reused?'本次输入没有变化，复用已保存结果，未新增调用。':receipt.status==='COMPLETE'?'记忆已更新。':receipt.status==='NO_REUSABLE_MEMORY'?'本会话暂未提炼出可复用方法。':'这次提取尚未完成，暂未生成可用记忆。');
   const refresh=await fetch('/api/ticket-memory?ticket='+encodeURIComponent(ticketId),{cache:'no-store'});if(!refresh.ok)throw Error();const value=await refresh.json();if(epoch.current===version)setData(value);
  }catch{if(epoch.current===version)setBuildMessage('这次提取没有完成，请刷新查看结果。');}
  finally{if(epoch.current===version)setBuilding(false);}
 }
 if(error)return <p role="alert">{error}</p>;
 if(!data)return <p role="status">正在读取工单记忆…</p>;
 return <section aria-label="工单记忆">{data.builder?.configured&&<section className="answer-section"><h3>从这份工单提取记忆</h3><p className="muted">从提问、答复和引用原图中整理分析方法。提取成功后自动用于相关问题。</p><Button theme="solid" loading={building} disabled={building} onClick={build}>{building?'正在读取会话并提取…':'提取／更新 Memory'}</Button>{buildMessage&&<p role="status">{buildMessage}</p>}{data.builder.lastBuild&&<><p>{({COMPLETE:'记忆已更新并自动生效',NO_REUSABLE_MEMORY:'本会话暂未提炼出可复用方法',NEEDS_REVIEW:'这次输出不完整，暂未生成记忆',UNKNOWN_EXECUTION:'请求状态待核实',NOT_DISPATCHED:'尚未发出请求',DEFERRED_BUDGET:'额度不足，留待处理'})[data.builder.lastBuild.status]||'状态待核对'}</p><details><summary>查看本次读取范围</summary><p className="muted">已读 {data.builder.lastBuild.coverage?.includedMessages??'—'} / {data.builder.lastBuild.coverage?.sessionMessages??'—'} 条会话 · 实际输入原图 {data.builder.lastBuild.imageCount??0} 张 · 原附件清单待取回 {data.builder.lastBuild.coverage?.unavailableImageReferences??0} 条</p><p className="muted">可用原图 {data.builder.lastBuild.coverage?.availableImages??0} 张 · 本轮未输入 {Math.max(0,(data.builder.lastBuild.coverage?.availableImages??0)-(data.builder.lastBuild.imageCount??0))} 张 · 读取失败 {data.builder.lastBuild.coverage?.imageReadFailures??0} 张 · 排除临近图片 {data.builder.lastBuild.coverage?.nearbyImagesExcluded??0} 张 · 父消息缺口 {data.builder.lastBuild.coverage?.missingParents?.length??0} 条 · 省略消息 {data.builder.lastBuild.coverage?.omittedMessages??0} 条</p><details><summary>查看原图与引用覆盖明细</summary>{data.builder.lastBuild.imageCoverage?.map((item,i)=><p className="muted" key={i}>原图 · {({NEARBY_NOT_CONFIRMED:'临近图片，关联未核实，已排除',IMAGE_READ_FAILED:'本地原图读取失败',PER_TICKET_IMAGE_LIMIT:'超过每单 2 张，本轮未输入'})[item.reason]||'本次暂未读取'}</p>)}{data.builder.lastBuild.coverage?.missingParents?.map((item,i)=><p className="muted" key={'parent-'+i}>一条引用原文暂不可读取</p>)}{!data.builder.lastBuild.imageCoverage?.length&&!data.builder.lastBuild.coverage?.missingParents?.length&&<p className="muted">本会话没有额外的原图或父消息缺口记录。</p>}</details></details></>}</section>}<h3>本单产出的记忆 · {data.generated.length}</h3>{data.generated.length?data.generated.map(record=>record.queryPattern?<MemoryPlaybookCard key={record.id} record={record}/>:<article key={record.id}><h4>{record.title}</h4><p>{record.text}</p></article>):<p className="muted">尚无本单的已保存提取结果。</p>}
  <h3>找到的相关记忆 · {data.matched.length}</h3>{data.matched.length?data.matched.map((item,i)=><p key={i}>{item.record.title}</p>):<p className="muted">还没有在这份工单中找到相关记忆。</p>}
  <h3>分析时用了哪些记忆</h3>{data.runs.map(run=>{const view=memoryInjectionView(run);return <details key={run.id}><summary>{run.question} · {view.label}</summary>{view.receipts.map((receipt,i)=><section key={i}><p>{memoryStageLabel(receipt.stage)} · 第 {receipt.round} 轮 · {receipt.responded?'已带入并收到回答':'尚未收到回答'}</p><details><summary>查看实际带入内容</summary><pre className="memory-pattern">{receipt.block||'本次没有带入记忆'}</pre></details></section>)}</details>})}{!data.runs.length&&<p className="muted">这份工单还没有使用记忆进行分析。</p>}
 </section>;
}
