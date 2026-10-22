// Explicit local integration. No remote writes, no automatic Memory promotion.
import {readFile,writeFile,open,unlink,link,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {buildHistoryIndex,saveHistoryIndex,validateHistoryIndex,MAX_HISTORY_INDEX_BYTES} from './history-index.mjs';
import {documentSourceId,documentEvidenceAllowed} from './document-intake.mjs';
import {updateAttention,isTrustedListeningSource,loadAttention} from './source-attention.mjs';
const load=async p=>JSON.parse(await readFile(p,'utf8'));
export function contextRecords(context){
 const records=[];
 for(const e of context.events||[]){
  if(e.state==='CANCELED'||!e.start)continue;
  records.push({source_type:'calendar',source_title:e.title,speaker:'日历会邀',occurred_at:context.finishedAt,
   source_ids:[`calendar:wps-${e.calendarId}`],locator:JSON.stringify({platform:'wps',sourceType:'calendar',sourceRef:e.calendarId,itemRef:`${e.eventId}:${e.start}`}),
   text:`会邀：${e.title}\n计划开始：${e.start}\n计划结束：${e.end}\n参会人：${e.attendees.map(a=>`${a.name||a.user_id}（${a.response_status||'未回复'}）`).join('、')}\n状态：${e.state}。会邀不代表会议已举行、行动已完成或已有结论。`});
 }
 for(const row of context.im?.rows||[]){const m=row.message?.message||row.message;
  records.push({id:String(m.id),source_type:'im',sourceKey:row.sourceId,source_title:row.sourceTitle,sender:m.sender,
   occurred_at:m.ctime,raw:m,text:typeof m.content==='string'?m.content:JSON.stringify(m.content||{}),
   locator:JSON.stringify({platform:'wps',sourceType:'chat',sourceRef:row.chatId,itemRef:String(m.id)})});
 }
 return records;
}
export async function ingestContext(configPath,contextPath){
 const config=await load(configPath),context=await load(contextPath),policy=await load(config.documentPolicyPath);
 if(context.schema!=='context-refresh/v1')throw Error('INVALID_CONTEXT');
 const rows=contextRecords(context);
 for(const d of context.documents||[]){
  if(d.change==='CHECK_FAILED'||!d.bodyPath||!policy.documents.some(p=>p.documentId===d.id&&p.status==='allowed'))continue;
  const body=await readFile(d.bodyPath,'utf8');
  const sections=body.split(/(?=^#{1,6}\s)/m);let index=0;
  for(const section of sections){
   const title=/^#{1,6}\s+(.+)/.exec(section)?.[1]||d.title;
   const linked=(d.eventRefs||[]).map(id=>(context.events||[]).find(e=>e.eventId===id)).filter(Boolean);
   const relationship=linked.length?'\n会邀显式附件关联：'+linked.map(e=>`${e.title}（${e.start}；会邀ID ${e.eventId}）`).join('；')+'\n关联只说明此文档是会邀附件，不代表已经发生的会议结论。\n':'';
   const clean=relationship+section.replace(/!\[[^\]]*\]\([^)]*\)/g,'[文档图片：识别结果与本地原图另存]');
   for(let offset=0;offset<clean.length;offset+=6000){const sectionId=`section-${index++}`;
    rows.push({source_type:'document',document_id:d.id,source_title:d.title,speaker:'文档原文',occurred_at:null,
     revision:String(d.sourceVersion??d.contentHash),content_hash:d.contentHash,section_id:sectionId,section_title:title,
     text:clean.slice(offset,offset+6000),locator:JSON.stringify({platform:'wps',sourceType:'document',sourceRef:d.id,itemRef:sectionId,revision:String(d.sourceVersion??d.contentHash),contentHash:d.contentHash}),
     source_ids:[documentSourceId(d.id)],document_role:d.kind,document_limits:['源修改时间不作为业务日期','图片提取不等于底表核验']});
   }
  }
  for(const image of d.images||[])if(image.extraction?.text)rows.push({source_type:'document',document_id:d.id,source_title:d.title,speaker:'图片文字提取（待核验）',occurred_at:null,
   revision:String(d.sourceVersion??d.contentHash),content_hash:d.contentHash,section_id:`image-${image.hash}`,section_title:image.heading,
   text:`原图 SHA256：${image.hash}\n所在章节：${image.heading}\n${image.extraction.text}\n边界：仅提取截图文字，不代表底表验证或根因成立。`,
   locator:JSON.stringify({platform:'wps',sourceType:'document',sourceRef:d.id,itemRef:`image-${image.hash}`,contentHash:d.contentHash,revision:String(d.sourceVersion??d.contentHash)}),source_ids:[documentSourceId(d.id)]});
 }
 const attention=await updateAttention(config.policyPath,store=>{
  for(const candidate of context.candidates||[]){
   if(candidate.chatResolution!=='VERIFIED_PEER_ID'||candidate.candidateChatIds?.length!==1)continue;
   const chatId=candidate.candidateChatIds[0];
   // Match the same canonical source key used by the established IM read plan.
   const sourceId=`monitor:wps-${(hash('chat:'+chatId)).slice(0,24)}`;
   const old=store.sources.find(s=>s.id===sourceId||String(s.chatId||'')===chatId);
   if(old){if(old.status!=='excluded')old.meetingEventRefs=[...new Set([...(old.meetingEventRefs||[]),...candidate.eventRefs])];continue;}
   store.sources.push({id:sourceId,chatId,name:candidate.name,kind:'direct',tier:'on_match',status:'candidate',manualOverride:false,decisionOrigin:'candidate',
    reason:'参会人会邀线索，私聊尚未纳入关注；需手动授权或有效正文语义审核。',matchedWorklines:[],evidenceRefs:candidate.eventRefs,meetingEventRefs:candidate.eventRefs,history:[]});
  }
  return store;
 });
 const allowed=[...attention.sources.filter(isTrustedListeningSource).map(s=>s.id),...new Set((context.events||[]).map(e=>`calendar:wps-${e.calendarId}`))];
 const excluded=attention.sources.filter(s=>s.status==='excluded').map(s=>s.id);
 const lock=await open(config.historyIndexPath+'.lock','wx',0o600);
 try{
  const attentionBytes=await readFile(config.policyPath,'utf8'),policyBytes=await readFile(config.documentPolicyPath,'utf8');
  const currentAttention=JSON.parse(attentionBytes),currentPolicy=JSON.parse(policyBytes);
  const trusted=new Set(currentAttention.sources.filter(isTrustedListeningSource).map(s=>s.id)),banned=currentAttention.sources.filter(s=>s.status==='excluded').map(s=>s.id);
  const incoming=rows.filter(r=>r.source_type==='im'?trusted.has(r.sourceKey):r.source_type==='document'?documentEvidenceAllowed(r,currentPolicy,{parentAllowedSourceIds:[...trusted],excludedSourceIds:banned}):true);
  const before=await load(config.historyIndexPath),cases=(await load(config.datasetPath)).cases;
  const after=buildHistoryIndex({previousIndex:before,corpusRecords:incoming,cases,documentPolicy:currentPolicy,allowedSourceIds:[...trusted,...allowed.filter(id=>id.startsWith('calendar:'))],excludedSourceIds:banned,
   now:context.finishedAt,coverage_gaps:[`会邀/文档刷新 ${context.finishedAt}：${context.status}；会邀不是已完成；图片未读项以资料回执为准。`]});
  after.record_id_aliases=before.record_id_aliases||[];
  if(!validateHistoryIndex(after)||Buffer.byteLength(JSON.stringify(after))>=MAX_HISTORY_INDEX_BYTES)throw Error('CONTEXT_HISTORY_INVALID_OR_TOO_LARGE');
  const byId=new Map(after.records.map(r=>[r.id,r]));if(before.records.some(r=>byId.get(r.id)?.text!==r.text))throw Error('OLD_RECORD_CHANGED');
  if(await readFile(config.policyPath,'utf8')!==attentionBytes||await readFile(config.documentPolicyPath,'utf8')!==policyBytes)throw Error('SOURCE_POLICY_CHANGED_BEFORE_COMMIT');
  await link(config.historyIndexPath,config.historyIndexPath+'.before-context-'+randomUUID());
  await saveHistoryIndex(config.historyIndexPath,after);
  const readback=await load(config.historyIndexPath);if(readback.records.length!==after.records.length)throw Error('READBACK_FAILED');
  const staged=contextPath+'.'+randomUUID()+'.tmp';await writeFile(staged,JSON.stringify({...context,integrationStatus:'INGESTED'},null,2),{mode:0o600});await rename(staged,contextPath);
  return{status:'INGESTED',addedRecords:after.records.length-before.records.length,calendarRecords:rows.filter(r=>r.source_type==='calendar').length,documents:context.documents.length,allOldRecordsPreserved:true};
 }finally{await lock.close();await unlink(config.historyIndexPath+'.lock');}
}
import{createHash}from'node:crypto';
function hash(value){return createHash('sha256').update(value).digest('hex');}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await ingestContext(...process.argv.slice(2))));
