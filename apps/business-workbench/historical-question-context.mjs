import { createHash } from 'node:crypto';
import { buildQuestionContext } from './question-context.mjs';
import { PERMANENT_BLOCKED_LOCATOR_HASHES } from './history-index.mjs';

const id=value=>typeof value==='string' && /^[\w.:-]{1,180}$/.test(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const at=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const key=row=>JSON.stringify([row.sourceId,row.sourceRef,String(row.messageId)]);
function allowed(row,policy) {
  if(!id(row.sourceId) || !id(row.sourceRef) || !id(String(row.messageId ?? '')) || !policy.allowedSourceIds?.has(row.sourceId)
    || policy.excludedSourceIds?.has(row.sourceId) || policy.sourceRefs?.get(row.sourceId)!==row.sourceRef)return false;
  const blocked=new Set([...PERMANENT_BLOCKED_LOCATOR_HASHES,...(policy.blockedLocatorHashes || [])]);
  if(blocked.has(hash(['wps',row.sourceRef,String(row.messageId)])))return false;
  const window=policy.referenceWindows?.get(row.sourceId);
  return !window || at(row.pushedAt) && at(window.startAt) && at(window.endAt) && Date.parse(window.startAt)<=Date.parse(window.endAt)
    && Date.parse(row.pushedAt)>=Date.parse(window.startAt) && Date.parse(row.pushedAt)<=Date.parse(window.endAt);
}
const missing=(context,...reasons)=>({...context,missing:[...new Set([...context.missing,...reasons])]});

/**
 * Resolve a historical ticket only from locally supplied, currently authorized
 * messages. It does not fetch parents, download images, OCR or infer a match from
 * proximity. Parent snapshots outside current source/window controls are ignored.
 */
export function resolveHistoricalQuestionContext({question,ticket,normalizedMessages=[],boards=[],policy={},ocrByHash=new Map()}={}) {
  if(typeof question!=='string' || !question.trim() || question.length>30000 || !id(ticket?.id)
    || !Array.isArray(ticket.sourceIds) || !ticket.sourceIds.length || !Array.isArray(ticket.events) || !ticket.events.length
    || !Array.isArray(normalizedMessages) || normalizedMessages.length>20000)throw new Error('INVALID_HISTORY_QUESTION_CONTEXT');
  const sourceIds=new Set(ticket.sourceIds);
  if(ticket.sourceIds.some(sourceId=>!id(sourceId) || !policy.allowedSourceIds?.has(sourceId) || policy.excludedSourceIds?.has(sourceId) || !id(policy.sourceRefs?.get(sourceId))))throw new Error('HISTORY_QUESTION_CONTEXT_NOT_AUTHORIZED');
  // A mixed-source ticket may already summarize all of its events. Do not release
  // a partial context if one event is excluded, revoked or outside its scope.
  for(const event of ticket.events) {
    if(!at(event.occurredAt ?? event.at) || !sourceIds.has(event.sourceId) || !allowed({sourceId:event.sourceId,sourceRef:policy.sourceRefs.get(event.sourceId),messageId:String(event.messageId),pushedAt:event.occurredAt ?? event.at},policy))throw new Error('HISTORY_QUESTION_CONTEXT_NOT_AUTHORIZED');
  }
  const questions=ticket.events.filter(row=>row.kind==='question').sort((a,b)=>Date.parse(a.occurredAt ?? a.at)-Date.parse(b.occurredAt ?? b.at));
  const event=ticket.questionMessageId ? questions.find(row=>String(row.messageId)===String(ticket.questionMessageId)) : questions[0];
  if(!event)throw new Error('HISTORY_QUESTION_EVENT_MISSING');
  const wanted={sourceId:event.sourceId,sourceRef:policy.sourceRefs.get(event.sourceId),messageId:String(event.messageId)};
  const available=normalizedMessages.filter(row=>row?.version==='question-message/v1' && allowed(row,policy));
  const matches=available.filter(row=>key(row)===key(wanted));
  const unique=new Map(matches.map(row=>[row.contentHash || hash(row),row]));
  const fallback={version:'question-message/v1',...wanted,pushedAt:event.occurredAt ?? event.at,text:event.quote ?? event.text ?? ticket.question ?? question,
    images:[],links:[],quoteMessageId:null,replyMessageId:null};
  const native=unique.size===1?[...unique.values()][0]:fallback;
  // buildQuestionContext checks current permissions again and follows at most
  // eight same-source quote/reply hops. Deduplicate identical exports first.
  const deduped=new Map();for(const message of available) {
    const k=key(message),previous=deduped.get(k);
    if(previous && previous.contentHash!==message.contentHash)deduped.set(k,null);
    else if(!deduped.has(k))deduped.set(k,message);
  }
  const {selectionBasis:ignored,...automaticPolicy}=policy;
  // Large private repair exports may contain many unrelated conversations. Keep
  // every explicit parent before bounding optional nearby context.
  const chain=[],chainKeys=new Set();let cursor=native;
  for(let depth=0;depth<8;depth++) {
    const parentId=cursor.quoteMessageId || cursor.replyMessageId;if(!parentId)break;
    const parent=deduped.get(key({...cursor,messageId:String(parentId)}));if(!parent || chainKeys.has(key(parent)))break;
    chain.push(parent);chainKeys.add(key(parent));cursor=parent;
  }
  const optional=[...deduped.values()].filter(row=>row && row.sourceId===native.sourceId && row.sourceRef===native.sourceRef && !chainKeys.has(key(row)))
    .sort((a,b)=>Date.parse(b.pushedAt)-Date.parse(a.pushedAt)).slice(0,5000-chain.length);
  const boundedMessages=[...chain,...optional];
  let context=buildQuestionContext({question:native,messages:boundedMessages,...automaticPolicy});
  const preserveInput=ctx=>({...ctx,historicalTicketId:ticket.id,originalQuery:question,enrichedQuery:question+ctx.enrichedQuery.slice(native.text.length)});
  if(unique.size!==1)return preserveInput(missing(context,unique.size?'AMBIGUOUS_NORMALIZED_QUESTION_MESSAGE':'NORMALIZED_QUESTION_MESSAGE_MISSING'));
  const evidenceKeys=new Set(context.evidence.map(row=>key({...row,sourceRef:policy.sourceRefs.get(row.sourceId)})));
  const list=Array.isArray(boards)?boards:boards?.boards;
  if(!Array.isArray(list) || list.length>100)throw new Error('INVALID_HISTORY_BOARDS');
  const candidates=new Map();
  for(const board of list) {
    if(!Array.isArray(board.snapshots) || board.snapshots.length>1000)throw new Error('INVALID_HISTORY_BOARDS');
    for(const snapshot of board.snapshots)if(allowed({...snapshot,messageId:String(snapshot.messageId)},policy) && evidenceKeys.has(key(snapshot)))candidates.set(JSON.stringify([board.id,snapshot.id]),{board,snapshot});
  }
  if(candidates.size>1)return preserveInput(missing(context,'MULTIPLE_EXPLICIT_BOARD_SNAPSHOTS'));
  if(!candidates.size)return preserveInput(missing(context,'EXPLICIT_BOARD_SNAPSHOT_MISSING'));
  const {board,snapshot}=candidates.values().next().value;
  const ocr=ocrByHash instanceof Map?ocrByHash.get(snapshot.sha256):ocrByHash?.[snapshot.sha256];
  context=buildQuestionContext({question:native,messages:boundedMessages,board,snapshot,ocr:ocr || snapshot.ocr || null,...automaticPolicy});
  return preserveInput(context);
}
