import React,{useEffect,useState}from'react';
const states={NOT_DUE:'会议尚未结束',RECORD_CHECK_DUE:'会后待查记录',CANCELED:'已取消',TIME_UNAVAILABLE:'时间待核对'};
export default function ContextSources({masked}){
 const[data,setData]=useState(null),[failed,setFailed]=useState(false);
 useEffect(()=>{fetch('/api/context-sources').then(r=>{if(!r.ok)throw Error();return r.json();}).then(setData).catch(()=>setFailed(true));},[]);
 if(failed)return <p role="alert">会邀与文档更新记录暂时无法读取。</p>;
 if(!data?.configured)return null;
 const date=v=>v?new Date(v).toLocaleString('zh-CN'):'待核对';
 const eventCard=(e,i)=><article className="attention-card" key={`${e.calendarId}:${e.eventId}:${e.start}`}><header><h3>{masked?`会邀 ${i+1}`:e.title}</h3><span>{states[e.state]||e.state}</span></header><p>{date(e.start)} — {date(e.end)}</p><p>参会人：{masked?'已隐藏':e.attendees.map(a=>a.name||'身份待核对').join('、')}</p><p className="muted">会邀用于补充工作安排；会议结论以会后原文为准。</p></article>;
 return <section aria-label="会邀、会议记录与文档"><h2>会邀、会议记录与文档</h2><p className="muted">最近检查 {date(data.updatedAt)} · {data.status==='COMPLETE'?'本轮检查完成':'本轮部分完成，待补读项保留'}</p>
 {data.calendarGapCount>0&&<p className="muted">{data.calendarGapCount} 条返回记录在查询窗口之外，未当作本周的具体会邀；周期日程实例仍需核对。</p>}
 <div className="attention-list">{data.events.slice(0,6).map(eventCard)}</div>{data.events.length>6&&<details><summary>其余会邀与会后检查（{data.events.length-6}）</summary><div className="attention-list">{data.events.slice(6).map((e,i)=>eventCard(e,i+6))}</div></details>}
 <details><summary>参会人监控候选（{data.candidates.length}）</summary>{data.candidates.map((c,i)=><p key={c.userId}>{masked?`候选联系人 ${i+1}`:c.name} · {c.eventCount} 个会邀 · {c.chatResolution==='VERIFIED_PEER_ID'?'已匹配私聊身份':'私聊身份待匹配'} · 仅候选，未自动关注</p>)}</details>
 <details><summary>文档版本与图片（{data.documents.length}）</summary><div className="attention-list">{data.documents.map((d,i)=><article className="attention-card" key={d.id}><h3>{masked?`文档 ${i+1}`:d.title}</h3><p>版本 {d.sourceVersion??'未提供'} · {date(d.checkedAt)} · {d.change==='CHECK_FAILED'?'读取失败，保留上一版本':d.change==='UNCHANGED_VERSION'?'版本未变化':'已核对正文'}</p><p>图片 {d.imageCount} 张 · 已缓存 {d.imagesDownloaded} · 已识别 {d.imagesRead}{!d.mediaChecked?' · 其余待补读':''}</p>{!masked&&d.images.length>0&&<details><summary>查看本地原图</summary>{d.images.map(image=><figure key={`${image.hash}:${image.heading}`}><img loading="lazy" src={image.url} alt={image.heading||'文档原图'} style={{maxWidth:'100%',maxHeight:480,objectFit:'contain'}}/><figcaption>{image.heading} · {image.state==='READ'?'已提取图中文字，待核验':'已缓存，待识别'}</figcaption></figure>)}</details>}</article>)}</div></details>
 <details><summary>会后记录检查（{data.meetingChecks.length}）</summary>{data.meetingChecks.map((m,i)=><p key={m.eventId}>{masked?`会邀 ${i+1}`:data.events.find(e=>e.eventId===m.eventId)?.title} · {states[m.state]||({NOT_FOUND_IN_SEARCH:'本次搜索未找到记录，后续继续检查',CANDIDATES_REQUIRE_EVENT_MATCH:'找到候选记录，需核对会议关联',CHECK_FAILED:'检查失败，待重试'})[m.state]||m.state}{m.complete?'':' · 覆盖不完整'}</p>)}</details>
 </section>;
}
