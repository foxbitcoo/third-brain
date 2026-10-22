import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extractMessageContext } from '../question-context.mjs';
import { resolveHistoricalQuestionContext } from '../historical-question-context.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse=(id,text,quote,extra={})=>extractMessageContext({id,chat_id:'native-a',ctime:1792285200,content:{text:{content:text}},quote_msg_id:quote,...extra},{sourceId:'source-a'});
const policy=()=>({allowedSourceIds:new Set(['source-a']),sourceRefs:new Map([['source-a','native-a']]),referenceWindows:new Map([['source-a',{startAt:'2026-10-17T00:00:00Z',endAt:'2026-10-18T23:59:59Z'}]])});
function fixture() {
  const question=parse('question-a','这个变化为什么？','parent-a');
  const parent=parse('parent-a','![日报](https://example.invalid/image)');
  const ticket={id:'ticket-a',sourceIds:['source-a'],question:'这个变化为什么？',events:[{kind:'question',sourceId:'source-a',messageId:'question-a',occurredAt:question.pushedAt,quote:question.text}]};
  const snapshot={id:'shot-a',sourceId:'source-a',sourceRef:'native-a',messageId:'parent-a',statisticsDate:'2026-10-11',comparisonDate:'2026-10-04',pushedAt:parent.pushedAt,sha256:'a'.repeat(64)};
  const ocr={status:'COMPLETED',version:'ocr-v1',createdAt:'2026-10-18T03:00:00Z',imageSha256:snapshot.sha256,text:'日报指标为样例值。'};
  return {question:'请结合原问核对变化',ticket,normalizedMessages:[question,parent],boards:[{id:'board-a',title:'样例日报',snapshots:[snapshot]}],policy:policy(),ocrByHash:new Map([[snapshot.sha256,ocr]])};
}

test('ticket source/message locator follows explicit parent to board and verified OCR without replacing query',()=>{
  const input=fixture(),result=resolveHistoricalQuestionContext(input);
  assert.equal(result.binding.status,'BOUND');assert.equal(result.binding.kind,'EXPLICIT_QUOTE');assert.equal(result.binding.snapshotId,'shot-a');
  assert.equal(result.originalQuery,input.question);assert.match(result.enrichedQuery,/请结合原问核对变化/);assert.match(result.enrichedQuery,/日报指标为样例值/);
  assert.equal(result.evidence[0].text,'这个变化为什么？');assert.equal(result.binding.statisticsDate,'2026-10-11');assert.equal(result.historicalTicketId,'ticket-a');
});

test('a recent wrong picture is only a candidate and cannot replace a missing explicit parent',()=>{
  const input=fixture();input.normalizedMessages[1]={...input.normalizedMessages[1],messageId:'unrelated-recent'};input.boards[0].snapshots[0].messageId='unrelated-recent';
  const result=resolveHistoricalQuestionContext(input);assert.equal(result.binding.status,'UNRESOLVED');assert.equal(result.nearbyCandidates.length,1);
  assert.ok(result.missing.includes('REFERENCED_MESSAGE_NOT_AVAILABLE'));assert.equal(result.ocr,null);assert.equal(result.enrichedQuery,input.question);
});

test('multiple explicit board snapshots require selection instead of picking newest',()=>{
  const input=fixture();input.boards[0].snapshots.push({...input.boards[0].snapshots[0],id:'shot-b',sha256:'b'.repeat(64)});
  const result=resolveHistoricalQuestionContext(input);assert.equal(result.binding.status,'UNRESOLVED');assert.ok(result.missing.includes('MULTIPLE_EXPLICIT_BOARD_SNAPSHOTS'));
});

test('all ticket sources and event windows are checked before any context is exposed',()=>{
  const input=fixture();input.ticket.sourceIds.push('unapproved');assert.throws(()=>resolveHistoricalQuestionContext(input),/NOT_AUTHORIZED/);
  const expired=fixture();expired.ticket.events.push({...expired.ticket.events[0],messageId:'old-event',kind:'reply',occurredAt:'2026-10-16T00:00:00Z'});assert.throws(()=>resolveHistoricalQuestionContext(expired),/NOT_AUTHORIZED/);
});

test('blocked parents and cross-source same-ID parents do not bind',()=>{
  const input=fixture();input.policy.blockedLocatorHashes=new Set([digest(['wps','native-a','parent-a'])]);
  assert.equal(resolveHistoricalQuestionContext(input).binding.status,'UNRESOLVED');
  const other=fixture();other.normalizedMessages[1].sourceRef='different-chat';assert.equal(resolveHistoricalQuestionContext(other).binding.status,'UNRESOLVED');
});

test('missing normalized question is surfaced and stale OCR cannot enrich the query',()=>{
  const missing=fixture();missing.normalizedMessages.shift();const result=resolveHistoricalQuestionContext(missing);
  assert.ok(result.missing.includes('NORMALIZED_QUESTION_MESSAGE_MISSING'));assert.equal(result.originalQuery,missing.question);
  const stale=fixture();stale.ocrByHash.values().next().value.imageSha256='b'.repeat(64);const invalid=resolveHistoricalQuestionContext(stale);
  assert.equal(invalid.binding.status,'BOUND');assert.equal(invalid.ocr,null);assert.ok(invalid.missing.includes('OCR_NOT_VERIFIED_FOR_SNAPSHOT'));
});

test('policy user-selected flag cannot cause implicit automatic historical binding',()=>{
  const input=fixture();input.policy.selectionBasis='USER_SELECTED';input.boards[0].snapshots[0].messageId='unrelated';
  assert.equal(resolveHistoricalQuestionContext(input).binding.status,'UNRESOLVED');
});
