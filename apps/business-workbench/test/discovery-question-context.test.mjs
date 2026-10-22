import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {resolveBoardQuestion,questionBindingStillAllowed} from '../discovery-question-context.mjs';

test('server resolves identifiers against authorized immutable image/OCR and fences date or content changes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'question-binding-'));
 try{
  const data=Buffer.from([137,80,78,71,13,10,26,10]);await writeFile(join(dir,'board.png'),data);
  const sha256=createHash('sha256').update(data).digest('hex');
  const shot={id:'snapshot-a',sourceId:'group-a',sourceRef:'chat-a',messageId:'msg-a',statisticsDate:'2026-01-02',comparisonDate:'2025-12-26',pushedAt:'2026-01-03T00:00:00Z',imageFile:'board.png',sha256,ocr:{status:'VERIFIED',version:'ocr-v1',imageSha256:sha256,createdAt:'2026-01-03T00:00:00Z',text:'Conversion 50%'}};
  const store={version:'discovery-boards/v1',generatedAt:'2026-01-03T00:00:00Z',imageRoot:dir,allowedLinkHosts:[],boards:[{id:'board-a',title:'Board',analysisSourceId:'source-a',snapshots:[shot]}]};
  const policy={allowedSourceIds:new Set(['group-a']),excludedSourceIds:new Set(),sourceRefs:new Map([['group-a','chat-a']])};
  const input={question:'What changed?',sourceId:'source-a',boardId:'board-a',snapshotId:'snapshot-a'};
  const context=await resolveBoardQuestion({input,store,policy,checkoutRoot:join(dir,'checkout'),sourceVersion:'v1'});
  assert.equal(context.binding.status,'BOUND');assert.equal(context.binding.statisticsDate,'2026-01-02');assert.match(context.enrichedQuery,/Conversion/);
  assert.equal(await questionBindingStillAllowed({context,sourceId:'source-a',store,policy,checkoutRoot:join(dir,'checkout')}),true);
  const check=()=>questionBindingStillAllowed({context,sourceId:'source-a',store,policy,checkoutRoot:join(dir,'checkout')});
  shot.comparisonDate='2025-12-25';assert.equal(await check(),false);shot.comparisonDate='2025-12-26';
  shot.ocr.text='Corrected OCR';assert.equal(await check(),false);shot.ocr.text='Conversion 50%';
  shot.messageId='another-message';assert.equal(await check(),false);shot.messageId='msg-a';
  await assert.rejects(()=>resolveBoardQuestion({input:{...input,sourceId:'wrong'},store,policy,checkoutRoot:dir}));
  await writeFile(join(dir,'board.png'),Buffer.from('changed'));
  assert.equal(await questionBindingStillAllowed({context,sourceId:'source-a',store,policy,checkoutRoot:join(dir,'checkout')}),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
