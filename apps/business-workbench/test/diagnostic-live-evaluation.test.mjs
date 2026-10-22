import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareLiveEvaluation,runLiveEvaluation,renderLiveEvaluation} from '../diagnostic-live-evaluation.mjs';

const plan=()=>prepareLiveEvaluation({runId:'live-pilot',cases:[{id:'question-a',question:'What changed?',sourceId:'approved',cutoff:'2026-01-01T00:00:00Z'}]});
test('live matrix preserves common input and retains actual tool outcomes and bounded human stops',async()=>{
  const calls=[];
  const receipt=await runLiveEvaluation(plan(),{executeArm:async arm=>{
    calls.push([arm.providerId,arm.withMemory,arm.parityHash]);
    return{id:arm.id,question:arm.case.question,status:'NEEDS_HUMAN',rounds:[{index:1,plan:{delperQuery:'Verified source and period'},result:{status:'VERIFIED',receiptId:'query-1',columns:['value'],records:[[4]]}}],usage:{queries:1,modelCalls:2,receipts:[]},report:{questions:['Confirm the release date.']}};
  }});
  assert.equal(calls.length,4);assert.equal(new Set(calls.map(c=>c[2])).size,1);
  assert.ok(receipt.results.every(r=>r.toolExecuted&&r.runStatus==='NEEDS_HUMAN'&&r.independentAnswerJudgment==='PENDING_HUMAN_REVIEW'));
  const html=renderLiveEvaluation(receipt);assert.ok(html.includes('Verified source and period'));assert.ok(html.includes('Confirm the release date.'));
});
test('frozen answers and no-memory contamination cannot masquerade as live success',async()=>{
  const receipt=await runLiveEvaluation(plan(),{executeArm:async arm=>({id:arm.id,status:'REVIEW_READY',rounds:[],usage:{queries:0,modelCalls:1,receipts:[{memoryInjection:{memoryIds:['wrong']}}]}})});
  assert.equal(receipt.results.filter(r=>r.error==='INVALID_LIVE_RUN').length,4);
  const contaminated=await runLiveEvaluation(plan(),{executeArm:async arm=>({id:arm.id,status:'NEEDS_HUMAN',rounds:[],usage:{queries:0,modelCalls:1,receipts:[{memoryInjection:{memoryIds:['wrong']}}]}})});
  assert.equal(contaminated.results.filter(r=>r.error==='NO_MEMORY_ISOLATION_FAILED').length,2);
  await assert.rejects(()=>runLiveEvaluation({...plan(),mode:'FROZEN'},{}),/INVALID_LIVE_EVALUATION_EXECUTION/);
});
test('planned, queried and reviewing tasks remain incomplete',async()=>{
 for(const status of ['PLANNED','QUERIED','RUNNING_REVIEW']){
  const receipt=await runLiveEvaluation(plan(),{executeArm:async arm=>({id:arm.id,status,rounds:[],usage:{queries:0,modelCalls:0,receipts:[]}})});
  assert.ok(receipt.results.every(r=>r.status==='INCOMPLETE'));assert.equal(receipt.status,'PARTIAL_OR_FAILED');
 }
});
