import {createHash} from 'node:crypto';
import {PERMANENT_BLOCKED_LOCATOR_HASHES} from './history-index.mjs';
import {cleanMentions} from './src/presentation.mjs';
import {authorizedHistoricalMedia} from './historical-ticket-media.mjs';
const key=m=>`${m.sourceId}:${m.messageId}`;
const stamp=m=>Date.parse(m.pushedAt??m.at??m.occurredAt);

// Follow explicit quote/reply edges only. A nearby board is never a parent.
export function ticketSessionMessages(ticket,messages,policy,window){
 const graph=new Map(),blocked=new Set([...PERMANENT_BLOCKED_LOCATOR_HASHES,...(policy.blockedLocatorHashes||[])]);
 for(const m of messages){if(graph.has(key(m)))throw Error('MEMORY_SESSION_AMBIGUOUS');graph.set(key(m),m);}
 const start=Date.parse(window.startAt??window.start),end=Date.parse(window.endAt??window.end);
 if(!Number.isFinite(start)||!Number.isFinite(end)||start>end)throw Error('MEMORY_SESSION_WINDOW');
 const allowed=m=>m&&policy.allowedSourceIds.has(m.sourceId)&&!policy.excludedSourceIds.has(m.sourceId)&&policy.sourceRefs.get(m.sourceId)===m.sourceRef&&stamp(m)>=start&&stamp(m)<=end&&!blocked.has(createHash('sha256').update(JSON.stringify(['wps',m.sourceRef,String(m.messageId)])).digest('hex'));
 const selected=new Map(),missingParents=[];
 for(const event of ticket.events){
  let current=graph.get(key(event));
  if(!allowed(current)||stamp(current)!==stamp(event))throw Error('MEMORY_SESSION_NOT_AUTHORIZED');
  const visited=new Set(),pending=[{message:current,depth:0}];
  while(pending.length){
   const {message:current,depth}=pending.shift();
   if(visited.has(key(current)))continue;
   if(!allowed(current)){missingParents.push({sourceId:current.sourceId,messageId:current.messageId,reason:'PARENT_NOT_AUTHORIZED'});continue;}
   visited.add(key(current));selected.set(key(current),current);
   for(const parent of new Set([current.quoteMessageId,current.replyMessageId].filter(Boolean).map(String))){
    const next=graph.get(`${current.sourceId}:${parent}`);
    if(!next){missingParents.push({sourceId:current.sourceId,messageId:parent,reason:'PARENT_NOT_RETAINED'});continue;}
    if(depth>=7){missingParents.push({sourceId:current.sourceId,messageId:parent,reason:'REFERENCE_DEPTH_LIMIT'});continue;}
    pending.push({message:next,depth:depth+1});
   }
  }
 }
 return {messages:[...selected.values()].sort((a,b)=>stamp(a)-stamp(b)),missingParents};
}

export function prepareTicketSession({ticket,messages,originals=[],media,seedRecords=[],policy,window,maxContextBytes=32768}){
 const selected=ticketSessionMessages(ticket,messages,policy,window),originalMap=new Map(originals.map(m=>[key(m),m])),events=new Map(ticket.events.map(e=>[key(e),e]));
 const bindings=[],evidence=[];let bytes=0;
 const ordered=[...selected.messages].sort((a,b)=>{
  const priority=m=>events.get(key(m))?.kind==='question'?0:['answer','reply'].includes(events.get(key(m))?.kind)?1:2;
  return priority(a)-priority(b)||stamp(a)-stamp(b);
 });
 for(const m of ordered){
  const event=events.get(key(m)),original=originalMap.get(key(m));
  const speaker=event?.speaker||(original?.sourceRef===m.sourceRef&&stamp(original)===stamp(m)?original.speaker:null)||'身份未记录';
  const item={id:'E-'+createHash('sha256').update(key(m)).digest('hex').slice(0,16),text:cleanMentions(m.text||event?.quote||''),at:m.pushedAt,speaker,role:event?.kind||'EXPLICIT_REFERENCE',quoteMessageId:m.quoteMessageId||m.replyMessageId||null,...(m.quoteMessageId&&m.replyMessageId&&m.quoteMessageId!==m.replyMessageId?{replyMessageId:m.replyMessageId}:{})};
  const size=Buffer.byteLength(JSON.stringify(item));if(size>maxContextBytes-bytes)continue;
  evidence.push(item);bindings.push({evidenceId:item.id,sourceId:m.sourceId,sourceRef:m.sourceRef,messageId:String(m.messageId),at:m.pushedAt});bytes+=size;
 }
 evidence.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const rows=media?authorizedHistoricalMedia(media,ticket,selected.messages,policy,window):[];
 const images=rows.filter(r=>r.status==='VERIFIED'&&r.relation!=='NEARBY_CANDIDATE').map(r=>({...r,path:`${media.imageRoot}/${r.imageFile}`}));
 for(const seed of seedRecords.filter(r=>r.sourceTicketId===ticket.id))for(const image of seed.attachments||[]){
  if(!selected.messages.some(m=>m.sourceId===image.sourceId&&m.sourceRef===image.sourceRef&&String(m.messageId)===String(image.messageId)&&stamp(m)===Date.parse(image.at))||!['EVENT_ATTACHMENT','EXPLICIT_REFERENCE'].includes(image.relation))continue;
  if(!images.some(i=>i.sha256===image.sha256))images.push({...image});
 }
 const attachments=images.filter(i=>bindings.some(b=>b.sourceId===i.sourceId&&b.sourceRef===i.sourceRef&&b.messageId===String(i.messageId)&&Date.parse(b.at)===Date.parse(i.at)));
 const coverage={sessionMessages:selected.messages.length,includedMessages:evidence.length,omittedMessages:selected.messages.length-evidence.length,missingParents:selected.missingParents,unavailableImageReferences:rows.filter(r=>r.status!=='VERIFIED').length,nearbyImagesExcluded:rows.filter(r=>r.relation==='NEARBY_CANDIDATE').length,availableImages:attachments.length};
 const imageCoverage=rows.filter(r=>r.status!=='VERIFIED'||r.relation==='NEARBY_CANDIDATE').map(({id,messageId,at,status,relation})=>({id,messageId,at,reason:relation==='NEARBY_CANDIDATE'?'NEARBY_NOT_CONFIRMED':status}));
 return {packet:{ticketId:ticket.id,title:ticket.title,originalQuestion:ticket.question,evidence,coverage},bindings,attachments,coverage,imageCoverage};
}
