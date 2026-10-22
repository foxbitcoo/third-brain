import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extractMessageContext, buildQuestionContext, projectQuestionContext } from '../question-context.mjs';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const raw=(id,content,extra={})=>({data:{id,chat_id:'chat-a',ctime:1792285200,content,...extra}});
const parse=(value)=>extractMessageContext(value,{sourceId:'source-a'});
const policy=()=>({allowedSourceIds:new Set(['source-a']),sourceRefs:new Map([['source-a','chat-a']])});
const parent=()=>parse(raw('parent-a',{rich_text:{elements:[{type:'nl',elements:[{type:'image',image_content:{storage_key:'private-image-storage-key',name:'日报'}}]},{type:'nl',elements:[{type:'text',text_content:{content:'样例日报'}}]}]}}));
const question=()=>parse(raw('question-a',{text:{content:'上面这个指标为什么变化？'}},{quote_msg_id:'parent-a'}));
const snapshot=()=>({id:'shot-a',sourceId:'source-a',sourceRef:'chat-a',messageId:'parent-a',statisticsDate:'2026-10-11',comparisonDate:'2026-10-04',pushedAt:'2026-10-18T01:00:00Z',sha256:'a'.repeat(64)});
const board={id:'board-a',title:'日报'};
const ocr=()=>({status:'COMPLETED',version:'ocr-v1',createdAt:'2026-10-18T02:00:00Z',imageSha256:'a'.repeat(64),text:'统计日10-11；样例指标下降。'});

test('nested rich text retains quote, image reference and Markdown title without remote URL',()=>{
  const p=parent();assert.equal(p.images.length,1);assert.equal(p.images[0].refHash,hash('private-image-storage-key'));assert.equal(p.text,'样例日报');
  const q=question();assert.equal(q.quoteMessageId,'parent-a');
  const m=parse(raw('push',{text:{type:'markdown',content:'**[日报](https://example.invalid/dashboard?id=fixture)**\n![趋势](http://example.invalid/image.png?Signature=private-signature)'}}));
  assert.equal(m.images.length,1);assert.equal(m.links[0].title,'日报');assert.equal(m.images[0].caption,'趋势');
  assert.doesNotMatch(JSON.stringify(m),/https?:|private-signature|image.png/);
});

test('explicit quote binds snapshot dates and hash; OCR enriches without overwriting original',()=>{
  const q=question(), result=buildQuestionContext({question:q,messages:[parent()],board,snapshot:snapshot(),ocr:ocr(),...policy()});
  assert.equal(result.originalQuery,q.text);assert.equal(result.binding.kind,'EXPLICIT_QUOTE');assert.equal(result.binding.statisticsDate,'2026-10-11');assert.match(result.binding.pushedAt,/2026-10-18/);
  assert.match(result.enrichedQuery,/统计日：2026-10-11/);assert.match(result.enrichedQuery,/对比日：2026-10-04/);assert.match(result.enrichedQuery,/非查询底表/);
  assert.equal(result.ocr.version,'ocr-v1');assert.equal(result.ocr.textSha256,hash(ocr().text));assert.deepEqual(result.missing,[]);
});

test('nearby image never silently binds a board and missing parent remains a gap',()=>{
  const q=question(), p=parent();p.messageId='other';
  const result=buildQuestionContext({question:q,messages:[p],board,snapshot:{...snapshot(),messageId:'other'},ocr:ocr(),...policy()});
  assert.equal(result.binding.status,'UNRESOLVED');assert.equal(result.nearbyCandidates[0].status,'UNCONFIRMED_NEARBY');
  assert.ok(result.missing.includes('REFERENCED_MESSAGE_NOT_AVAILABLE'));assert.ok(result.missing.includes('OCR_NOT_VERIFIED_FOR_SNAPSHOT'));assert.doesNotMatch(result.enrichedQuery,/下降/);
});

test('user-selected snapshot is bound independently but source controls remain required',()=>{
  const result=buildQuestionContext({question:question(),messages:[],board,snapshot:snapshot(),selectionBasis:'USER_SELECTED',ocr:ocr(),...policy()});
  assert.equal(result.binding.kind,'USER_SELECTED_SNAPSHOT');
  assert.throws(()=>buildQuestionContext({question:question(),board,snapshot:{...snapshot(),sourceRef:'other-chat'},selectionBasis:'USER_SELECTED',...policy()}),/NOT_AUTHORIZED/);
});

test('stale OCR hash or failed status never enters rewritten query',()=>{
  for(const change of [{imageSha256:'b'.repeat(64)},{status:'FAILED'},{version:''},{createdAt:'not-a-date'}]) {
    const result=buildQuestionContext({question:question(),messages:[parent()],board,snapshot:snapshot(),ocr:{...ocr(),...change},...policy()});
    assert.equal(result.ocr,null);assert.doesNotMatch(result.enrichedQuery,/样例指标下降/);
  }
});

test('cross-chat same message id, blocked locators and revoked sources fail closed',()=>{
  const p=parent();p.sourceRef='other-chat';
  assert.equal(buildQuestionContext({question:question(),messages:[p],...policy()}).evidence.length,1);
  assert.throws(()=>buildQuestionContext({question:question(),messages:[parent()],...policy(),excludedSourceIds:new Set(['source-a'])}),/NOT_AUTHORIZED/);
  const blocked=hash(['wps','chat-a','parent-a']);
  const result=buildQuestionContext({question:question(),messages:[parent()],...policy(),blockedLocatorHashes:new Set([blocked])});assert.equal(result.evidence.length,1);
});

test('references are cycle bounded and source scope limits apply to parents',()=>{
  const q=question(),p=parent();p.quoteMessageId=q.messageId;
  assert.ok(buildQuestionContext({question:q,messages:[p,q],...policy()}).missing.includes('REFERENCE_CYCLE'));
  q.pushedAt='2026-10-17T12:00:00Z';
  const window=new Map([['source-a',{startAt:'2026-10-17T00:00:00Z',endAt:'2026-10-17T23:59:59Z'}]]);p.pushedAt='2026-10-16T00:00:00Z';
  assert.equal(buildQuestionContext({question:q,messages:[p],...policy(),referenceWindows:window}).evidence.length,1);
});

test('projection allowlists OCR, relationship and IDs while dropping native paths and URLs',()=>{
  const context=buildQuestionContext({question:question(),messages:[parent()],board,snapshot:snapshot(),ocr:ocr(),...policy()});
  context.rawUrl='https://private.invalid';context.binding.imageFile='/private/image.png';context.evidence[0].sourceRef='chat-a';context.ocr.privatePath='/private/ocr.json';
  const out=projectQuestionContext(context);assert.doesNotMatch(JSON.stringify(out),/chat-a|private.invalid|privatePath|imageFile/);assert.equal(out.evidence[0].quoteMessageId,'parent-a');
});

 test('manual question binding supports a current user-selected snapshot with source metadata',()=>{
   const s={...snapshot(),sourceVersion:'source-v2'};
   const result=buildQuestionContext({question:{text:'请核对这个指标',messageId:'manual-question',sourceId:s.sourceId,sourceRef:s.sourceRef},board,snapshot:s,ocr:ocr(),selectionBasis:'USER_SELECTED',...policy()});
   assert.equal(result.originalQuery,'请核对这个指标');assert.equal(result.binding.sourceId,'source-a');assert.equal(result.binding.sourceVersion,'source-v2');
 });
