import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticModel } from '../diagnostic-adapters.mjs';
import { runDiagnostic } from '../proactive-discovery.mjs';
const source={id:'source',version:'v1',userAuthorized:true,definitionVerified:true,definition:'Synthetic approved metric',recipes:[{id:'counts'},{id:'breakdown'}]};
const initial=()=>({id:'r',sourceId:'source',question:'Give the total and explain its decline.',rounds:[],route:{version:'diagnostic-route-v2'},usage:{modelCalls:0,queries:0},limits:{maxRounds:3,maxQueries:3,maxModelCalls:7},status:'QUEUED'});
const answer=()=>({decision:'ready',summary:'A readable draft',findings:[{text:'One segment has five user-days.',evidenceIds:['Q1']}],answerCoverage:{status:'partial',covered:['Segment counts'],missing:['Confirm the union total and its counting unit.']}});
function modelFor(reply){return createDiagnosticModel({credential:async()=>'synthetic',fetchImpl:async()=>new Response(JSON.stringify({model:'deepseek-v4-pro',usage:{prompt_tokens:5,completion_tokens:8},choices:[{finish_reason:'stop',message:{content:JSON.stringify(reply)}}]}))});}
function reviewInput(){const run=initial();run.rounds=[{plan:{recipeId:'counts'},result:{status:'VERIFIED',receiptId:'actual',columns:['n'],records:[[5]],queryHash:'hash'}}];return{run,source};}
test('production review cannot omit or misstate answer coverage while retaining paid receipt',async()=>{
 for(const value of [undefined,{status:'answered',covered:['Some counts'],missing:['Missing total']},{status:'partial',covered:['Some counts'],missing:[]}]){
  const response=answer();response.answerCoverage=value;await assert.rejects(modelFor(response).review(reviewInput()),error=>error.code==='MODEL_INVALID_ANSWER_COVERAGE'&&error.callReceipt.promptTokens===5);
 }
});
test('readable grounded draft with missing original-question parts becomes human-blocked with exact gap',async()=>{
 const response=await modelFor(answer()).review(reviewInput());assert.equal(response.decision,'needs_human');assert.deepEqual(response.questions,['Confirm the union total and its counting unit.']);assert.equal(response.answerCoverage.status,'partial');assert.deepEqual(response.findings[0].evidenceIds,['actual']);
});
test('incomplete answer continues only for an explicit approved unused next recipe and reason',async()=>{
 const response=answer();response.nextRecipeId='breakdown';response.nextQueryReason='This approved partition can separate the suspected driver';
 assert.equal((await modelFor(response).review(reviewInput())).decision,'continue');
 for(const nextRecipeId of ['counts','unapproved']){response.nextRecipeId=nextRecipeId;assert.equal((await modelFor(response).review(reviewInput())).decision,'needs_human');}
 response.nextRecipeId='breakdown';delete response.nextQueryReason;assert.equal((await modelFor(response).review(reviewInput())).decision,'needs_human');
});
test('fully answered coverage can produce a review-ready draft, independently of causal status',async()=>{
 const response=answer();response.answerCoverage={status:'answered',covered:['Requested total, unit and bounded explanation'],missing:[]};
 assert.equal((await modelFor(response).review(reviewInput())).decision,'ready');
});
test('coverage persists in round and final report; a partial draft cannot silently consume all rounds',async()=>{
 let calls=0;const response=answer();response.findings[0].evidenceIds=['q'];
 const result=await runDiagnostic({run:initial(),source,dependencies:{authorize:async()=>true,checkpoint:async()=>{},plan:async()=>({decision:'query',recipeId:'counts',reason:'Approved counts'}),query:async()=>{calls++;return{status:'VERIFIED',receiptId:'q',queryHash:'h',columns:['n'],records:[[5]]};},review:async()=>response}});
 assert.equal(result.status,'NEEDS_HUMAN');assert.equal(calls,1);assert.equal(result.rounds.length,1);assert.deepEqual(result.rounds[0].review.answerCoverage,response.answerCoverage);assert.deepEqual(result.report.answerCoverage,response.answerCoverage);assert.equal(result.report.causalStatus,'NOT_INDEPENDENTLY_VERIFIED');
});

test('continue without an explicit useful available recipe also stops instead of forcing another round',async()=>{
 const response=answer();response.decision='continue';assert.equal((await modelFor(response).review(reviewInput())).decision,'needs_human');
});
