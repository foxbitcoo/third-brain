import {readFile,realpath,stat}from'node:fs/promises';
import{dirname,relative,isAbsolute,sep}from'node:path';
import{createHash}from'node:crypto';
async function read(path){
 if(!path)return null;
 const file=await realpath(path),size=(await stat(file)).size;
 if(size>5*1024*1024)throw Error('Context receipt exceeds local limit');
 const data=JSON.parse(await readFile(file,'utf8'));
 if(data.schema!=='context-refresh/v1')throw Error('Invalid context receipt');
 return data;
}
export async function readContextSummary(path){
 const data=await read(path);if(!data)return{configured:false};
 return{configured:true,status:data.status,updatedAt:data.finishedAt,coverage:data.coverage,
  events:data.events.map(e=>({eventId:e.eventId,title:e.title,start:e.start,end:e.end,state:e.state,
   attendees:e.attendees.map(a=>({name:a.name,responseStatus:a.response_status}))})),
  candidates:data.candidates.map(c=>({name:c.name,listening:false,status:'candidate',identityVerified:c.chatResolution==='VERIFIED_PEER_ID'})),
  documents:data.documents.map(d=>({id:d.id,title:d.title,version:d.sourceVersion,change:d.change,checkedAt:d.checkedAt,
   imageCount:d.imageCount||0,imagesRead:(d.images||[]).filter(i=>i.state==='READ').length,
   images:(d.images||[]).filter(i=>i.hash&&i.path).map(i=>({heading:i.heading,url:`/api/context-image?document=${encodeURIComponent(d.id)}&hash=${i.hash}`}))})),
  meetingChecks:data.meetingChecks.map(m=>({eventId:m.eventId,state:m.state,complete:m.complete}))};
}
export async function readContextImage(path,document,hash){
 if(!/^[a-f0-9]{64}$/.test(hash||''))throw Error('Invalid image');
 const data=await read(path),image=data?.documents.find(d=>d.id===document)?.images?.find(i=>i.hash===hash&&i.path);
 if(!image)throw Error('Image unavailable');
 const root=await realpath(dirname(path)),file=await realpath(image.path),rel=relative(root,file);
 if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep)||(await stat(file)).size>8*1024*1024)throw Error('Image unavailable');
 if(!['image/png','image/jpeg','image/webp'].includes(image.mime))throw Error('Unsupported image');
 const body=await readFile(file);if(createHash('sha256').update(body).digest('hex')!==hash)throw Error('Image changed');
 return{body,mime:image.mime};
}
