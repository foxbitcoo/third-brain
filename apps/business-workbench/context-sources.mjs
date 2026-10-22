import {readFile,realpath,stat} from 'node:fs/promises';
import {dirname,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {documentEvidenceAllowed} from './document-intake.mjs';
export function projectContextSources(context,documentPolicy){
 if(context?.schema!=='context-refresh/v1')throw Error('INVALID_CONTEXT');
 const documents=(context.documents||[]).filter(d=>documentEvidenceAllowed({source_type:'document',document_id:d.id},documentPolicy)).map(d=>({
  id:d.id,title:d.title,kind:d.kind,checkedAt:d.checkedAt,readAt:d.readAt,change:d.change,sourceVersion:d.sourceVersion,
  contentHash:d.contentHash,imageCount:d.imageCount||0,imagesRead:(d.images||[]).filter(i=>i.state==='READ').length,
  imagesDownloaded:(d.images||[]).filter(i=>i.path).length,mediaChecked:d.mediaChecked===true,
  images:(d.images||[]).filter(i=>i.hash&&i.path).map(i=>({hash:i.hash,heading:i.heading,state:i.state,url:`/api/context-image?document=${encodeURIComponent(d.id)}&hash=${i.hash}`}))
 }));
 return{configured:true,status:context.status,updatedAt:context.finishedAt,coverage:context.coverage,documents,
  calendarGapCount:context.calendarGaps?.length||0,
  events:[...(context.events||[])].sort((a,b)=>Number(b.organizedByMe===true)-Number(a.organizedByMe===true)||Number(b.state==='NOT_DUE')-Number(a.state==='NOT_DUE')||(a.start||'').localeCompare(b.start||'')).map(e=>({calendarId:e.calendarId,eventId:e.eventId,title:e.title,start:e.start,end:e.end,state:e.state,meaning:e.meaning,attendees:e.attendees})),
  candidates:(context.candidates||[]).map(c=>({userId:c.userId,name:c.name,status:c.status,listening:false,chatResolution:c.chatResolution,eventCount:c.eventRefs?.length||0})),
  meetingChecks:context.meetingChecks||[],modelCost:context.modelCost};
}
export async function readContextImage(context,contextPath,documentId,hash,documentPolicy){
 if(!/^[a-f0-9]{64}$/.test(hash))throw Error('INVALID_IMAGE');
 const doc=(context.documents||[]).find(d=>d.id===documentId);
 if(!doc||!documentEvidenceAllowed({source_type:'document',document_id:doc.id},documentPolicy))throw Error('IMAGE_NOT_ALLOWED');
 const image=(doc.images||[]).find(i=>i.hash===hash&&i.path);if(!image)throw Error('IMAGE_NOT_FOUND');
 const root=await realpath(dirname(contextPath)),path=await realpath(image.path),rel=relative(root,path);
 if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw Error('IMAGE_NOT_ALLOWED');
 const info=await stat(path);if(!info.isFile()||info.size>8*1024*1024)throw Error('INVALID_IMAGE');
 const body=await readFile(path);if(createHash('sha256').update(body).digest('hex')!==hash)throw Error('IMAGE_CHANGED');
 return{body,mime:image.mime};
}
