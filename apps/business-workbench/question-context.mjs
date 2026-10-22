import { createHash } from 'node:crypto';
import { sanitizeText } from './live-qa.mjs';
import { PERMANENT_BLOCKED_LOCATOR_HASHES } from './history-index.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const id = value => typeof value === 'string' && /^[\w.:-]{1,180}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clean = (value, max=12000, secrets=[]) => sanitizeText(typeof value === 'string' ? value : '', secrets).replace(/https?:\/\/[^\s<>]+/g,'[链接引用]').slice(0,max);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
const same = (a,b) => a.sourceId===b.sourceId && a.sourceRef===b.sourceRef;
const locatorHash = message => hash(['wps',message.sourceRef,message.messageId]);

// This parser extracts reference identities only. It never follows URLs, reads
// files, downloads images, or grants source access from message contents.
export function extractMessageContext(raw, { sourceId }={}) {
  const message = raw?.data && !Array.isArray(raw.data) ? raw.data : raw;
  if (!message || !id(sourceId || message.sourceId) || !id(String(message.id ?? message.messageId ?? ''))) throw new Error('INVALID_QUESTION_MESSAGE');
  const result={version:'question-message/v1', sourceId:sourceId || message.sourceId, sourceRef:String(message.chat_id ?? message.sourceRef ?? ''),
    messageId:String(message.id ?? message.messageId), text:'', quoteMessageId:null, replyMessageId:null, pushedAt:null, images:[], links:[]};
  if (!id(result.sourceRef)) throw new Error('INVALID_QUESTION_MESSAGE_SOURCE');
  for (const [field, keys] of [['quoteMessageId',['quote_msg_id','quoteMessageId']],['replyMessageId',['reply_msg_id','reply_to_message_id','parent_id','replyMessageId']]]) {
    for (const key of keys) if (id(String(message[key] ?? '')) && String(message[key])!=='0') {result[field]=String(message[key]);break;}
  }
  const timestamp=message.occurredAt ?? message.pushedAt ?? message.ctime;
  const time = typeof timestamp==='number' ? timestamp*(timestamp<1e12?1000:1) : timestamp;
  if (Number.isFinite(Date.parse(typeof time==='number' ? new Date(time).toISOString() : time))) result.pushedAt=new Date(time).toISOString();
  const texts=[], imageRefs=new Set(), linkRefs=new Set(); let nodes=0;
  const image = (reference, kind, caption='') => {if(typeof reference!=='string' || !reference || reference.length>12000)return;const refHash=hash(reference);if(imageRefs.has(refHash))return;imageRefs.add(refHash);if(result.images.length<32)result.images.push({refHash,kind,caption:clean(caption,500)});};
  const link = (reference,title='') => {try{const url=new URL(reference);if(!['https:','http:'].includes(url.protocol))return;const refHash=hash(reference);if(linkRefs.has(refHash))return;linkRefs.add(refHash);if(result.links.length<32)result.links.push({refHash,title:clean(title,500),protocol:url.protocol.slice(0,-1)});}catch{}};
  const text = value => {
    if(typeof value!=='string')return;
    value=value.slice(0,30000);
    for(const match of value.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g))image(match[2],'markdown',match[1]);
    for(const match of value.matchAll(/(?<!!)\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g))link(match[2],match[1]);
    texts.push(value.replace(/!\[([^\]]*)\]\([^)]*\)/g,'[图片：$1]').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/https?:\/\/[^\s<>]+/g,'[链接引用]').replace(/<at\b[^>]*>(.*?)<\/at>/g,'@$1'));
  };
  function walk(value,depth=0) {
    if(depth>16 || ++nodes>2000)return;
    if(typeof value==='string') { text(value);return; }
    if(Array.isArray(value)){for(const child of value.slice(0,200))walk(child,depth+1);return;}
    if(!value || typeof value!=='object')return;
    if(value.image_content) {const img=value.image_content;image(img.storage_key ?? img.url ?? img.download_url,'rich_text',img.name);}
    if(value.type==='image' || value.type==='img')image(value.storage_key ?? value.url ?? value.src,'image',value.alt_text ?? value.alt);
    if(value.link_content)link(value.link_content.url ?? value.link_content.href,value.link_content.text ?? value.link_content.title);
    if(value.type==='link' || value.type==='a')link(value.url ?? value.href,value.title ?? value.text_content?.content ?? value.text);
    for(const key of ['text','markdown','content','rich_text','text_content','elements','children','body'])if(value[key]!==undefined)walk(value[key],depth+1);
  }
  let content=message.content ?? message.text ?? '';
  if(typeof content==='string' && /^[\[{]/.test(content.trim()))try{content=JSON.parse(content);}catch{}
  walk(content);
  result.text=clean(texts.join('\n'),30000);
  result.contentHash=hash({text:result.text,images:result.images,links:result.links,quoteMessageId:result.quoteMessageId,replyMessageId:result.replyMessageId});
  return result;
}

function authorized(message, policy) {
  const blocked=new Set([...PERMANENT_BLOCKED_LOCATOR_HASHES,...(policy.blockedLocatorHashes || [])]);
  const window=policy.referenceWindows?.get(message.sourceId);
  return policy.allowedSourceIds?.has(message.sourceId) && !policy.excludedSourceIds?.has(message.sourceId)
    && policy.sourceRefs?.get(message.sourceId)===message.sourceRef && !blocked.has(locatorHash(message))
    && (!window || instant(message.pushedAt) && instant(window.startAt) && instant(window.endAt) && Date.parse(message.pushedAt)>=Date.parse(window.startAt) && Date.parse(message.pushedAt)<=Date.parse(window.endAt));
}

export function buildQuestionContext({question,messages=[],board=null,snapshot=null,ocr=null,nearbyWindowMs=30*60*1000,...policy}={}) {
  if(question?.version!=='question-message/v1') {
    if(policy.selectionBasis!=='USER_SELECTED' || !id(question?.messageId) || !id(question?.sourceId) || !id(question?.sourceRef) || typeof question.text!=='string' || !question.text.trim())throw new Error('INVALID_QUESTION_CONTEXT');
    question={...question,version:'question-message/v1',text:clean(question.text,30000),images:[],links:[],quoteMessageId:null,replyMessageId:null,pushedAt:question.pushedAt || snapshot?.pushedAt || null};
    question.contentHash=hash({text:question.text,messageId:question.messageId});
  }
  if(!authorized(question,policy))throw new Error('QUESTION_CONTEXT_NOT_AUTHORIZED');
  if(messages.length>5000)throw new Error('QUESTION_CONTEXT_TOO_LARGE');
  const available=messages.filter(message=>message?.version==='question-message/v1' && authorized(message,policy));
  const parents=[],missing=[],seen=new Set([`${question.sourceId}:${question.messageId}`]);let current=question;
  for(let depth=0;depth<8;depth++) {
    const parentId=current.quoteMessageId || current.replyMessageId;if(!parentId)break;
    const key=`${current.sourceId}:${parentId}`;if(seen.has(key)){missing.push('REFERENCE_CYCLE');break;}seen.add(key);
    const parent=available.find(message=>same(current,message) && message.messageId===parentId);
    if(!parent){missing.push('REFERENCED_MESSAGE_NOT_AVAILABLE');break;}
    parents.push({message:parent,kind:current.quoteMessageId?'EXPLICIT_QUOTE':'EXPLICIT_REPLY'});current=parent;
  }
  const evidence=[{message:question,kind:'ORIGINAL_QUESTION'},...parents];
  const explicitIds=new Set(evidence.map(row=>row.message.messageId));
  const nearby=available.filter(message=>same(message,question) && !explicitIds.has(message.messageId) && (message.images.length || message.links.length)
    && instant(message.pushedAt) && instant(question.pushedAt) && Date.parse(message.pushedAt)<=Date.parse(question.pushedAt)
    && Date.parse(question.pushedAt)-Date.parse(message.pushedAt)<=Math.min(Math.max(nearbyWindowMs,0),24*60*60*1000)).slice(-8);
  let binding={status:'UNRESOLVED',kind:parents.length?'EXPLICIT_REFERENCE':'NONE',boardId:null,snapshotId:null};
  if(snapshot || board) {
    if(!id(board?.id) || !id(snapshot?.id) || !digest(snapshot.sha256) || !day(snapshot.statisticsDate) || !instant(snapshot.pushedAt))throw new Error('INVALID_QUESTION_SNAPSHOT');
    const shotMessage={sourceId:snapshot.sourceId,sourceRef:snapshot.sourceRef,messageId:String(snapshot.messageId),pushedAt:snapshot.pushedAt};
    if(!authorized(shotMessage,policy))throw new Error('QUESTION_SNAPSHOT_NOT_AUTHORIZED');
    // A selected snapshot is an explicit user selection; automatic resolution
    // must additionally prove a parent-message match and never use recency alone.
    const matched=evidence.find(row=>same(row.message,shotMessage) && row.message.messageId===shotMessage.messageId);
    const selected=policy.selectionBasis==='USER_SELECTED';
    if(matched || selected)binding={status:'BOUND',kind:selected?'USER_SELECTED_SNAPSHOT':matched.kind,boardId:board.id,snapshotId:snapshot.id,
      sourceId:snapshot.sourceId,sourceRef:snapshot.sourceRef,messageId:String(snapshot.messageId),sourceVersion:clean(snapshot.sourceVersion || board.sourceVersion,180) || null,imageSha256:snapshot.sha256,statisticsDate:snapshot.statisticsDate,comparisonDate:day(snapshot.comparisonDate)?snapshot.comparisonDate:null,pushedAt:new Date(snapshot.pushedAt).toISOString(),title:clean(snapshot.title || board.title,500)};
    else missing.push('SNAPSHOT_NOT_LINKED_TO_QUESTION');
  }
  let ocrEvidence=null;
  if(ocr) {
    if(binding.status!=='BOUND' || !digest(ocr.imageSha256) || ocr.imageSha256!==binding.imageSha256 || !id(ocr.version) || !instant(ocr.createdAt)
      || !['COMPLETED','VERIFIED'].includes(ocr.status) || typeof ocr.text!=='string' || !ocr.text.trim())missing.push('OCR_NOT_VERIFIED_FOR_SNAPSHOT');
    else ocrEvidence={version:ocr.version,imageSha256:ocr.imageSha256,createdAt:new Date(ocr.createdAt).toISOString(),status:ocr.status,text:clean(ocr.text,16000),textSha256:hash(ocr.text),evidenceType:'SCREENSHOT_OCR_NOT_RAW_TABLE'};
  }
  if(binding.status!=='BOUND')missing.push(nearby.length?'NEARBY_BOARD_REQUIRES_ALIGNMENT':'BOARD_ALIGNMENT_MISSING');
  else if(!ocrEvidence)missing.push('IMAGE_OCR_NOT_AVAILABLE');
  const originalQuery=question.text;
  const parts=[originalQuery];
  if(binding.status==='BOUND')parts.push(`\n已对齐看板：${binding.title}\n统计日：${binding.statisticsDate}；推送时间：${binding.pushedAt}${binding.comparisonDate?`；对比日：${binding.comparisonDate}`:''}`);
  if(ocrEvidence)parts.push(`\n引用原图 OCR（截图识别，非查询底表；数字和口径须查数核验）：\n${ocrEvidence.text}`);
  return {version:'question-context/v1',originalQuery,enrichedQuery:parts.join('\n'),binding,ocr:ocrEvidence,
    evidence:evidence.map(({message,kind})=>({kind,sourceId:message.sourceId,messageId:message.messageId,pushedAt:message.pushedAt,text:message.text,images:message.images,links:message.links,quoteMessageId:message.quoteMessageId,replyMessageId:message.replyMessageId,contentHash:message.contentHash})),
    nearbyCandidates:nearby.map(message=>({sourceId:message.sourceId,messageId:message.messageId,pushedAt:message.pushedAt,images:message.images,links:message.links,status:'UNCONFIRMED_NEARBY'})),missing:[...new Set(missing)]};
}

export function projectQuestionContext(context,{secrets=[]}={}) {
  if(context?.version!=='question-context/v1')return null;
  // Rebuild explicit fields; never return native source references, URLs or paths.
  const evidence=(context.evidence || []).slice(0,9).map(row=>({kind:row.kind,sourceId:row.sourceId,messageId:row.messageId,pushedAt:row.pushedAt,text:clean(row.text,30000,secrets),
    quoteMessageId:row.quoteMessageId,replyMessageId:row.replyMessageId,images:(row.images || []).map(image=>({refHash:image.refHash,kind:image.kind,caption:clean(image.caption,500,secrets)})),
    links:(row.links || []).map(link=>({refHash:link.refHash,title:clean(link.title,500,secrets)})),contentHash:row.contentHash}));
  const b=context.binding;
  return {version:context.version,originalQuery:clean(context.originalQuery,30000,secrets),enrichedQuery:clean(context.enrichedQuery,50000,secrets),
    binding:{status:b.status,kind:b.kind,boardId:b.boardId,snapshotId:b.snapshotId,...(b.status==='BOUND'?{sourceId:b.sourceId,sourceVersion:b.sourceVersion,imageSha256:b.imageSha256,statisticsDate:b.statisticsDate,comparisonDate:b.comparisonDate,pushedAt:b.pushedAt,title:clean(b.title,500,secrets)}:{})},
    ocr:context.ocr?{version:context.ocr.version,imageSha256:context.ocr.imageSha256,createdAt:context.ocr.createdAt,status:context.ocr.status,text:clean(context.ocr.text,16000,secrets),textSha256:context.ocr.textSha256,evidenceType:context.ocr.evidenceType}:null,
    evidence,nearbyCandidates:(context.nearbyCandidates || []).slice(0,8).map(row=>({sourceId:row.sourceId,messageId:row.messageId,pushedAt:row.pushedAt,status:'UNCONFIRMED_NEARBY'})),missing:context.missing};
}
