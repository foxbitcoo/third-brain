import React, { useEffect, useRef, useState } from 'react';
import Button from '@douyinfe/semi-ui/lib/es/button/index.js';
import Tag from '@douyinfe/semi-ui/lib/es/tag/index.js';
import SideSheet from '@douyinfe/semi-ui/lib/es/sideSheet/index.js';
import { IconClose, IconFile, IconAlertCircle, IconArrowRight } from '@douyinfe/semi-icons';
import AgentLoopDiagram from './AgentLoopDiagram.jsx';
import { diagnosticGuideDocument, loopNodeDocument, fullDocumentFocus } from './agent-loop-documents.mjs';
import './agent-loop-guide.css';

export default function AgentLoopGuide({agent}) {
  const [selected,setSelected]=useState('review'),[full,setFull]=useState(false);
  const opener=useRef(null),fullContent=useRef(null),panel=useRef(null);
  function selectNode(id){setSelected(id);if(panel.current)panel.current.scrollTop=0;if(window.matchMedia('(max-width: 900px)').matches)requestAnimationFrame(()=>panel.current?.scrollIntoView({block:'start',behavior:'smooth'}));}
  const document=loopNodeDocument(agent,selected),complete=diagnosticGuideDocument(agent);
  useEffect(()=>setFull(false),[agent?.skill?.sha256]);
  useEffect(()=>{
    if(!full)return;
    const trapFocus=event=>{
      if(event.key!=='Tab')return;
      const sheet=fullContent.current?.closest('.semi-sidesheet-inner');
      const nodes=[...(sheet?.querySelectorAll('button:not([disabled]), a[href], select, textarea, input, summary, [tabindex="0"]') || [])].filter(node=>node.getClientRects().length);
      const first=nodes[0],last=nodes.at(-1);
      if(!first)return;
      const active=window.document.activeElement;
      if(!sheet.contains(active)){event.preventDefault();first.focus();}
      else if(event.shiftKey && active===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey && active===last){event.preventDefault();first.focus();}
    };
    window.document.addEventListener('keydown',trapFocus);
    return ()=>window.document.removeEventListener('keydown',trapFocus);
  },[full]);
  if(!agent)return null;
  return <section className="attention-card agent-loop-guide" aria-label="分析 Agent 流程与文档">
    <header className="agent-loop-guide-header"><div><h2>{agent.title || '业务数据诊断 Agent'} <span className="agent-loop-guide-label">流程与文档</span></h2><p>核对原图与问题 → 模型分流与改写 → 单次查数或循环分析 → 待审报告</p></div><Tag>{agent.version || '版本待核对'}</Tag></header>
    <div className="agent-loop-guide-layout">
      <div className="agent-loop-guide-diagram"><AgentLoopDiagram selected={selected} onSelect={selectNode} limits={agent.loop} /></div>
      <aside ref={panel} className="agent-loop-guide-panel" aria-label="节点对应文档" aria-live="polite">
        {document ? <>
          <div className="agent-loop-guide-panel-title"><div><h3>{document.title}</h3><p>v{document.version}</p></div><Button type="tertiary" theme="borderless" icon={<IconClose />} aria-label="关闭节点文档" onClick={()=>setSelected(null)} /></div>
          {document.groups.map(group=>group.lines.length>0 && <section key={group.title}><h4><IconFile aria-hidden="true" />{group.title}</h4><ol>{group.lines.map((line,index)=><li key={index}>{line.replace(/^- /,'')}</li>)}</ol></section>)}
          {document.caveat && <p className="agent-loop-guide-source">{document.caveat}</p>}
          <p className="agent-loop-guide-boundary"><IconAlertCircle aria-hidden="true" />报告待审不等于根因已证实。</p>
          <Button theme="borderless" type="primary" className="agent-loop-guide-open" onClick={event=>{opener.current=event.currentTarget;setFull(true);}}>打开对应文档 <IconArrowRight aria-hidden="true" /></Button>
          <p className="agent-loop-guide-source">来源：{document.documentTitle} · {document.source}</p>
        </> : <p className="agent-loop-guide-empty">{complete ? '选择流程节点查看对应规范。' : '分析规范尚未加载。'}</p>}
      </aside>
    </div>
    <SideSheet title={complete ? `${complete.title} · v${complete.version}` : '分析规范'} visible={full} placement="right" width="min(760px, 100vw)" className="agent-loop-document-sheet" onCancel={()=>setFull(false)} closeOnEsc maskClosable afterVisibleChange={visible=>{
      if(visible){
        const sheet=fullContent.current?.closest('.semi-sidesheet-inner');
        sheet?.setAttribute('aria-label','业务数据诊断规范全文');
        sheet?.setAttribute('aria-modal','true');
        sheet?.querySelector('.semi-sidesheet-close')?.focus();
        const target=fullContent.current?.querySelector('[data-current-node="true"]');target?.scrollIntoView({block:'center'});}
      else if(opener.current?.isConnected)opener.current.focus();
    }}>
      <div className="agent-loop-guide-full" ref={fullContent}>
        <p className="agent-loop-guide-source">{document?.title ? `当前节点：${document.title}` : '业务数据诊断规范'} · 以下为实际规范全文</p>
        {complete?.sections.map(section=><section key={section.title}><h3>{section.title}</h3>{section.lines.map((line,index)=><p key={index} data-current-node={fullDocumentFocus(selected,section.title,line) || undefined}>{line.replace(/^- /,'')}</p>)}</section>)}
      </div>
    </SideSheet>
  </section>;
}
