import React, { useEffect, useState } from 'react';
import Select from '@douyinfe/semi-ui/lib/es/select/index.js';
import { selectedBoardSnapshot } from './memory-review-presentation.mjs';

const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone:'Asia/Shanghai' }) : '未记录';
const localPath = (value, kind) => typeof value === 'string' && new RegExp(`^/api/discovery-board-${kind}\\?board=[\\w%.-]+&snapshot=[\\w%.-]+$`).test(value) ? value : null;

export default function BoardPreview({ board, snapshotId, onSnapshotChange }) {
  const [selectedId,setSelectedId]=useState(''), [failed,setFailed]=useState(false);
  const shots=Array.isArray(board?.snapshots) ? board.snapshots : [];
  const shot=selectedBoardSnapshot(board, snapshotId === undefined ? selectedId : snapshotId);
  const selectSnapshot = id => { if (onSnapshotChange) onSnapshotChange(id); else setSelectedId(id); };
  useEffect(()=>{setSelectedId('');setFailed(false);},[board?.id]);
  useEffect(()=>setFailed(false),[shot?.id,shot?.imagePath]);
  if(!board) return <p className="muted">此看板尚未关联可核验的推送原图。</p>;
  const image=localPath(shot?.imagePath,'image'), link=localPath(shot?.linkPath,'link');
  return <section className="answer-section" aria-label="看板推送原图">
    <h3>{link ? <a href={link} target="_blank" rel="noreferrer">{shot?.title || board.title} ↗</a> : (shot?.title || board.title)}</h3>
    {board.relationNote && <p className="guide-boundary">{board.relationNote}</p>}
    {shots.length>1 && <label>推送记录 <Select aria-label="看板推送记录" value={shot?.id} onChange={selectSnapshot} style={{width:'100%'}} optionList={shots.map(item=>({value:item.id,label:`统计日 ${item.statisticsDate} · 推送于 ${date(item.pushedAt)}`}))} /></label>}
    {!shot && <p className="guide-boundary">所选推送记录已不可用，请重新选择；不会自动换用其他日期。</p>}
    {shot && <p className="muted">统计日期 {shot.statisticsDate} · 推送时间 {date(shot.pushedAt)} · 图片日期以原图标注为准</p>}
    {image && !failed ? <a href={image} target="_blank" rel="noreferrer" aria-label="打开看板原图"><img key={image} src={image} alt={`${shot.title || board.title}，统计日期 ${shot.statisticsDate}`} onError={()=>setFailed(true)} style={{display:'block',maxWidth:'100%',maxHeight:640,objectFit:'contain',objectPosition:'left top'}} /></a> : <p role="status" className="guide-boundary">推送原图暂不可读取，请刷新或核对来源权限。</p>}
    {!link && <p className="muted">原看板链接尚未核验，暂不提供跳转。</p>}
  </section>;
}
