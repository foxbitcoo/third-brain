import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticModel,createQueryExecutor,hash } from '../diagnostic-adapters.mjs';
import { modelDiagnosticRoute } from '../diagnostic-routing.mjs';
import { runDiagnostic } from '../proactive-discovery.mjs';
const source={id:'source',version:'v1',userAuthorized:true,definitionVerified:true,definition:'Synthetic counts',recipes:[{id:'counts',title:'Counters',tool:'execute_raw_sql',complexSqlVerified:true,modelView:{currentStart:'2026-01-01',currentEnd:'2026-01-07'},arguments:{sql:'SELECT 1 AS n'}}]};
const plan=()=>({decision:'query',route:{kind:'simple',reason:'One approved count answers the request'},completeness:{object:'complete',metric:'complete',period:'complete',comparison:'not_required',goal:'complete',hypothesis:'not_required'},delperQuery:'Read the approved source counters for its verified period. Return counts and coverage.',queryScope:{sourceId:'source',sourceVersion:'v1',currentStart:'2026-01-02',currentEnd:'2026-01-02'},recipeFit:{status:'compatible',reason:'Exact approved counters'},recipeId:'counts',reason:'Count lookup'});
const base=()=>({id:'run',sourceId:'source',question:'What about the chart above?',rounds:[],route:{version:'diagnostic-route-v2'},usage:{modelCalls:0,queries:0},limits:{maxRounds:3,maxQueries:3,maxModelCalls:7},status:'QUEUED'});
test('simple does not require a hypothesis, missing required scope cannot become simple',()=>{
 assert.equal(modelDiagnosticRoute(plan(),source).fastPath,true);
 const p=plan();p.completeness.period='missing';assert.equal(modelDiagnosticRoute(p,source).kind,'needs_context');
 assert.equal(modelDiagnosticRoute({route:{kind:'simple'}},source),null);
});
test('model plan receives source-bound enriched original/OCR context, Memory and explicit provider',async()=>{
 const run=base();run.questionContext={originalQuery:run.question,enrichedQuery:'Original question plus approved chart OCR',binding:{status:'BOUND',boardId:'board',snapshotId:'snap'},evidence:[{kind:'ocr',text:'Metric A'}]};
 let sent,url;
 const answer=plan();
 const model=createDiagnosticModel({provider:'mimo',credential:async()=>'synthetic',memoryFor:async()=>({hash:'mem',selected:[{id:'m',text:'Use the verified denominator.',version:1,sourceRefs:[]}]}),fetchImpl:async(u,opt)=>{url=u;sent=JSON.parse(opt.body);return new Response(JSON.stringify({model:'mimo-v2.6-pro',usage:{prompt_tokens:100,completion_tokens:100},choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]}));}});
 const result=await model.plan({run,source});
 assert.match(url,/xiaomimimo/);assert.equal(sent.model,'mimo-v2.6-pro');assert.match(sent.messages[0].content,/verified denominator/);
 assert.equal(JSON.parse(sent.messages[1].content).originalQuery,run.question);assert.match(JSON.parse(sent.messages[1].content).question,/chart OCR/);
 assert.equal(result.callReceipt.normalizedQuery.hash,hash(answer.delperQuery));assert.equal(result.callReceipt.requestAudit.provider,'mimo');assert.equal(result.callReceipt.estimatedPeakCny,0.0009);
});
test('each round dispatches exactly its normalized Query, binds source and retains real raw return',async()=>{
 const run=base();run.rounds=[{plan:plan()}];run.questionContext={binding:{boardId:'board',snapshotId:'snap'}};
 const calls=[];const execute=createQueryExecutor({client:{call:async(name,args)=>{calls.push({name,args});return name==='prompt_analysis'?{received:true,promptTraceId:'trace'}:{columns:['n'],rows:[[1]]};}}});
 const receipt=await execute({run,source,recipeId:'counts'});
 assert.equal(calls[0].args.prompt,plan().delperQuery);assert.notEqual(calls[0].args.prompt,run.question);assert.equal(calls[1].args.sql,'SELECT 1 AS n');assert.deepEqual(receipt.records,[[1]]);
 assert.equal(receipt.request.snapshotId,'snap');assert.equal(receipt.request.hash,hash(plan().delperQuery));assert.equal(receipt.request.executionMode,'APPROVED_FIXED_RECIPE');
 run.rounds[0].plan.delperQuery='A different approved normalized request';await execute({run,source,recipeId:'counts'});assert.equal(calls[2].args.prompt,run.rounds[0].plan.delperQuery);
});
test('date snapshot mismatch and missing rewrite stop before any tool dispatch',async()=>{
 let calls=0;const execute=createQueryExecutor({client:{call:async()=>{calls++;}}});
 const run=base();run.rounds=[{plan:plan()}];run.questionContext={binding:{statisticsDate:'2026-02-02'}};
 const dated={...source,recipes:[{...source.recipes[0],modelView:{currentStart:'2026-01-01',currentEnd:'2026-01-07'}}]};
 await assert.rejects(execute({run,source:dated,recipeId:'counts'}),e=>e.code==='REQUEST_RECIPE_MISMATCH');assert.equal(calls,0);
 delete run.rounds[0].plan.delperQuery;await assert.rejects(execute({run,source,recipeId:'counts'}),e=>e.code==='NORMALIZED_QUERY_REQUIRED');assert.equal(calls,0);
});
test('one simple model plan queries once and persists rewrite, raw results, decision and report',async()=>{
 const snapshots=[];let queries=0;
 const result=await runDiagnostic({run:base(),source,dependencies:{authorize:async()=>true,checkpoint:async r=>snapshots.push(r),plan:async()=>({...plan(),callReceipt:{model:'synthetic',normalizedQuery:{text:plan().delperQuery,hash:hash(plan().delperQuery)}}}),query:async()=>{queries++;return {status:'VERIFIED',receiptId:'q',queryHash:'fixed-query',columns:['n'],records:[[1]],request:{text:plan().delperQuery,hash:hash(plan().delperQuery)}};},review:async()=>({decision:'ready',summary:'Count ready',findings:[{text:'One result',evidenceIds:['q']}]})}});
 assert.equal(result.status,'REVIEW_READY');assert.equal(queries,1);assert.equal(result.route.kind,'simple');assert.equal(result.rounds[0].plan.delperQuery,plan().delperQuery);assert.equal(result.rounds[0].result.request.text,plan().delperQuery);assert.equal(result.usage.receipts[0].normalizedQuery.text,plan().delperQuery);assert.deepEqual(result.report.receiptIds,['q']);assert.ok(snapshots.some(r=>r.status==='QUERIED'));
});
test('a genuine missing-context answer needs no fabricated executable rewrite',async()=>{
 const run=base();const answer={decision:'needs_human',route:{kind:'needs_context',reason:'Ambiguous metric'},completeness:{object:'complete',metric:'missing',period:'complete',comparison:'not_required',goal:'complete',hypothesis:'not_required'},reason:'Which metric?',questions:['Which metric?']};
 const model=createDiagnosticModel({credential:async()=>'synthetic',fetchImpl:async()=>new Response(JSON.stringify({model:'deepseek-v4-pro',choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]}))});
 assert.equal((await model.plan({run,source})).decision,'needs_human');
});
test('Memory-off really removes injected references and records the condition',async()=>{
 let called=false,body;const model=createDiagnosticModel({withMemory:false,credential:async()=>'synthetic',memoryFor:async()=>{called=true;throw new Error('Must not access memory');},fetchImpl:async(_u,o)=>{body=JSON.parse(o.body);return new Response(JSON.stringify({model:'deepseek-v4-pro',choices:[{finish_reason:'stop',message:{content:JSON.stringify(plan())}}]}));}});
 const output=await model.plan({run:base(),source});assert.equal(called,false);assert.equal(output.callReceipt.requestAudit.withMemory,false);assert.deepEqual(output.callReceipt.memoryInjection.memoryIds,[]);assert.ok(!body.messages[0].content.includes('<confirmed_memory_reference>'));
});
test('fixed recipe date incompatibility becomes definition stop before query budget or tool dispatch',async()=>{
 const run=base();run.questionContext={binding:{status:'BOUND',statisticsDate:'2026-02-02'}};
 const dated={...source,recipes:[{...source.recipes[0],modelView:{currentStart:'2026-01-01',currentEnd:'2026-01-07'}}]};
 const execute=createQueryExecutor({client:{call:async()=>{throw new Error('Must not dispatch');}}});
 const result=await runDiagnostic({run,source:dated,dependencies:{authorize:async()=>true,checkpoint:async()=>{},plan:async()=>plan(),queryPreflight:execute.preflight,query:execute,review:async()=>{throw new Error('Must not review');}}});
 assert.equal(result.status,'NEEDS_DEFINITION');assert.equal(result.error.code,'REQUEST_RECIPE_MISMATCH');assert.equal(result.usage.queries,0);assert.equal(result.rounds[0].status,'BLOCKED');
});
test('unbound chart cannot become a simple executable request just because the model says so',()=>{
 const result=modelDiagnosticRoute(plan(),source,{binding:{status:'UNRESOLVED'},missing:['BOARD_ALIGNMENT_MISSING']});assert.equal(result.kind,'needs_context');assert.equal(result.fastPath,false);assert.ok(result.missing.includes('boardAlignment'));
});
test('both chart-bound and chart-free requests outside fixed query scope are blocked without tools',async()=>{
 for(const withChart of [true,false]){
  const run=base();const p=plan();p.queryScope.currentStart='2026-02-01';p.queryScope.currentEnd='2026-02-02';run.question='Read counters for 2026-02-01 to 2026-02-02';p.delperQuery=run.question;run.rounds=[{plan:p}];
  if(withChart)run.questionContext={binding:{status:'BOUND',statisticsDate:'2026-02-02'}};
  let calls=0;const execute=createQueryExecutor({client:{call:async()=>{calls++;}}});
  await assert.rejects(execute({run,source,recipeId:'counts'}),error=>error.code==='REQUEST_RECIPE_MISMATCH');assert.equal(calls,0);
 }
});
test('new model plan cannot omit query scope, invent invalid dates or skip required comparison dates',async()=>{
 for(const scope of [undefined,{sourceId:'source',sourceVersion:'v1',currentStart:'2026-02-30',currentEnd:'2026-02-30'},{sourceId:'other',sourceVersion:'v1',currentStart:'2026-01-02',currentEnd:'2026-01-02'}]){
  const answer=plan();answer.queryScope=scope;
  const model=createDiagnosticModel({credential:async()=>'synthetic',fetchImpl:async()=>new Response(JSON.stringify({model:'deepseek-v4-pro',usage:{prompt_tokens:5,completion_tokens:5},choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]}))});
  await assert.rejects(model.plan({run:base(),source}),error=>error.code==='MODEL_INVALID_QUERY_SCOPE'&&error.callReceipt.promptTokens===5);
 }
 const answer=plan();answer.completeness.comparison='complete';
 const model=createDiagnosticModel({credential:async()=>'synthetic',fetchImpl:async()=>new Response(JSON.stringify({model:'deepseek-v4-pro',choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]}))});
 await assert.rejects(model.plan({run:base(),source}),error=>error.code==='MODEL_INVALID_QUERY_SCOPE');
});
test('baseline date overrun and unknown fixed scope never become compatible from model assertion',async()=>{
 const run=base(),p=plan();p.completeness.comparison='complete';p.queryScope.baselineStart='2025-12-23';p.queryScope.baselineEnd='2025-12-24';run.rounds=[{plan:p}];
 const scoped={...source,recipes:[{...source.recipes[0],modelView:{...source.recipes[0].modelView,baselineStart:'2025-12-25',baselineEnd:'2025-12-31'}}]};
 const execute=createQueryExecutor({client:{call:async()=>{throw new Error('Must not dispatch');}}});
 await assert.rejects(execute({run,source:scoped,recipeId:'counts'}),error=>error.code==='REQUEST_RECIPE_MISMATCH');
 delete p.queryScope;await assert.rejects(execute({run,source,recipeId:'counts'}),error=>error.code==='QUERY_SCOPE_REQUIRED');
});
