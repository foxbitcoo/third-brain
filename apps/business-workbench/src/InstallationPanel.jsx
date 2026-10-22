import React,{useEffect,useState} from 'react';
import Button from '@douyinfe/semi-ui/lib/es/button/index.js';
export default function InstallationPanel(){
 const [status,setStatus]=useState(null),[chats,setChats]=useState([]),[selected,setSelected]=useState([]),[days,setDays]=useState(7),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 async function request(url,value){const r=await fetch(url,value===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});const data=await r.json();if(!r.ok)throw Error(data.message||'操作未完成，请检查配置和授权。');return data;}
 async function refresh(){try{setStatus(await request('/api/installation'));}catch{setStatus(null);}}
 useEffect(()=>{refresh();},[]);
 async function run(action){setBusy(true);setNotice('');try{await action();await refresh();}catch(e){setNotice(e.message);}finally{setBusy(false);}}
 if(!status)return null;
 return <section className="installation-panel"><h2>连接自己的工作资料</h2>{!status.configured?<><p>先设置自己的 WPS 应用和模型，再授权读取选择的会话。</p><Button onClick={()=>location.assign('/setup')}>开始设置</Button></>:<>
 <p>模型：{status.provider} · {status.model}。导入只读取已选择的群；点击生成后才调用模型。</p>
 <div className="installation-actions"><Button disabled={busy} onClick={()=>run(async()=>{const result=await request('/oauth/wps/start',{});location.assign(result.url);})}>{status.wpsAuthorized?'重新授权 WPS':'授权 WPS'}</Button><Button disabled={busy||!status.wpsAuthorized} onClick={()=>run(async()=>setChats((await request('/api/chats')).chats))}>选择群聊</Button></div>
 {chats.length>0&&<fieldset><legend>本次读取范围（最多10个群）</legend>{chats.map(c=><label key={c.id}><input type="checkbox" checked={selected.includes(c.id)} onChange={e=>setSelected(s=>e.target.checked?[...s,c.id]:s.filter(id=>id!==c.id))}/>{c.name}</label>)}<label>最近天数 <input type="number" min="1" max="30" value={days} onChange={e=>setDays(Number(e.target.value))}/></label><Button disabled={busy||!selected.length||selected.length>10} onClick={()=>run(async()=>{const result=await request('/api/import',{chatIds:selected,days});setNotice(`导入 ${result.messageCount} 条；${result.complete?'范围完整':'存在覆盖缺口，请缩小范围重试'}`);})}>导入所选消息</Button></fieldset>}
 <p>已导入 {status.importedMessages} 条 · {status.importComplete?'本次分页完整':'尚未完成完整导入'}{status.analyzedAt?` · 最近生成 ${new Date(status.analyzedAt).toLocaleString('zh-CN')}`:''}</p>
 <Button theme="solid" disabled={busy||!status.importedMessages||!status.importComplete} onClick={()=>run(async()=>{await request('/api/analyze',{});location.assign('/');})}>生成工作候选</Button>
 </>}{busy&&<p role="status">正在处理…</p>}{notice&&<p role="status">{notice}</p>}</section>;
}
