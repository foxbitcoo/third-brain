import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createTicketMemoryBuilder,loadMemoryBuildInputs,validateBuiltMemory} from '../ticket-memory-builder.mjs';
import {prepareTicketSession,ticketSessionMessages} from '../memory-session.mjs';
import {createDiagnosticBudget} from '../diagnostic-budget.mjs';
import {startWorkbenchServer} from '../server.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'deepseek-memory-')),checkout=join(root,'checkout'),data=join(root,'private');await mkdir(checkout);await mkdir(data);
 const at='2026-08-01T01:00:00Z',q={sourceId:'s',sourceRef:'native',messageId:'q',pushedAt:at,text:'这个图为什么变化',quoteMessageId:'p',images:[]},p={sourceId:'s',sourceRef:'native',messageId:'p',pushedAt:'2026-08-01T00:00:00Z',text:'原图口径',images:[{refHash:'a'.repeat(64)}]},a={sourceId:'s',sourceRef:'native',messageId:'a',pushedAt:'2026-08-01T02:00:00Z',text:'先核对周期，再拆分分子分母。',images:[]};
 const ticket={id:'t',title:'示例变化',question:q.text,status:'ANSWERED',statusReason:'有答复',historical:true,autoExecute:false,sourceIds:['s'],events:[{...q,at:q.pushedAt,kind:'question',quote:q.text},{...a,at:a.pushedAt,kind:'answer',quote:a.text,speaker:'成员乙'}]};
 const window={startAt:'2026-07-01T00:00:00Z',endAt:'2026-09-01T00:00:00Z'},history={version:'historical-question-tickets/v1',generatedAt:window.endAt,window,tickets:[ticket]},scope={version:'historical-ticket-scope/v1',basis:'USER_REQUEST',...window,sourceIds:['s'],sourceRefs:{s:'native'}},attention={version:1,sources:[{id:'s',chatId:'native',name:'示例',status:'active',kind:'group',tier:'normal',manualOverride:false,matchedWorklines:[],evidenceRefs:[],history:[]}]};
 const bytes=Buffer.from('89504e470d0a1a0a0000','hex'),hash=sha(bytes);await writeFile(join(data,hash+'.png'),bytes);
 const image={id:'image',ticketId:'t',sourceId:'s',sourceRef:'native',messageId:'p',at:p.pushedAt,linkedEventId:'s:q',relation:'EXPLICIT_REFERENCE',status:'VERIFIED',imageRefHash:'a'.repeat(64),sha256:hash,imageFile:hash+'.png'};
 const values={tickets:history,scope,attention,messages:{messages:[q,p,a]},originals:{messages:[{...q,speaker:'成员甲'},{...a,speaker:'成员乙'}]},media:{version:'historical-ticket-media/v1',imageRoot:data,images:[image]},seed:{records:[]}};
 const config={version:'deepseek-ticket-memory/v1',model:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions',workDirectory:data,outputPath:join(data,'output.json'),budgetDirectory:join(data,'budget')};
 for(const [key,value]of Object.entries(values)){config[key==='tickets'?'ticketsPath':key+'Path']=join(data,key+'.json');await writeFile(config[key==='tickets'?'ticketsPath':key+'Path'],JSON.stringify(value));}
 const configPath=join(data,'config.json');await writeFile(configPath,JSON.stringify(config));
 return {root,checkout,data,config,configPath,ticket,window,attention,messages:[q,p,a]};
}
const provider=(onRequest=()=>{})=>async(_url,options)=>{
 const request=JSON.parse(options.body),content=request.messages[1].content;const packet=JSON.parse(typeof content==='string'?content:content[0].text).packet;
 await onRequest(request);const evidence=packet.evidence.find(e=>e.role==='answer').id,images=Array.isArray(content)?JSON.parse(content[0].text).images.map(i=>i.id):[];
 return {ok:true,status:200,json:async()=>({id:'response-fixture',model:'deepseek-flash',usage:{prompt_tokens:100,completion_tokens:100},choices:[{finish_reason:'stop',message:{content:JSON.stringify({patternVersion:'memory-seven-sections/v1',memories:[{directionId:'S3',relation:'SAME_DIRECTION',cadence:'按需',useWhen:['需要解释同口径变化'],title:'变化核对',typicalQuestion:'{{周期}}的数据为什么变化',methodBasis:'REPLY_EVIDENCE',inputs:['统计周期'],steps:[{action:'先拆分子分母',why:'核对规模',evidenceIds:[evidence]}],outputs:['对照表'],boundaries:['口径不同先核对'],imageEvidenceIds:images,datedFacts:[]}],uncertainties:[]})}}]})};
};
test('session follows exact quoted parent and excludes nearby or unauthorized messages',async()=>{
 const f=await fixture();try{const inputs=await loadMemoryBuildInputs(f.configPath,f.checkout);const s=prepareTicketSession({ticket:f.ticket,...inputs,policy:inputs.policy,window:f.window});assert.equal(s.packet.evidence.length,3);assert.equal(s.attachments.length,1);assert.equal(s.attachments[0].messageId,'p');
  const both=ticketSessionMessages({...f.ticket,events:[{...f.ticket.events[0]}]},[...inputs.messages.map(m=>m.messageId==='q'?{...m,replyMessageId:'a'}:m)],inputs.policy,f.window);assert.deepEqual(both.messages.map(m=>m.messageId),['p','q','a']);
  const bad={...inputs.policy,sourceRefs:new Map([['s','rebound']])};assert.throws(()=>ticketSessionMessages(f.ticket,inputs.messages,bad,f.window),/NOT_AUTHORIZED/);
  assert.throws(()=>ticketSessionMessages(f.ticket,inputs.messages,{...inputs.policy,excludedSourceIds:new Set(['s'])},f.window),/NOT_AUTHORIZED/);
  const missing=ticketSessionMessages(f.ticket,inputs.messages.filter(m=>m.messageId!=='p'),inputs.policy,f.window);assert.equal(missing.missingParents[0].reason,'PARENT_NOT_RETAINED');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('DeepSeek builder sends original image bytes, automatically enables a source-backed method and reuses unchanged input without another call',async()=>{
 const f=await fixture();let calls=0;try{
  const builder=createTicketMemoryBuilder({configPath:f.configPath,checkoutRoot:f.checkout,credential:async()=> 'fixture-key',fetchImpl:provider(request=>{calls++;assert.equal(request.model,'deepseek-flash');assert.equal(request.messages[1].content.at(-1).type,'image_url');})});
  const result=await builder.build('t');assert.equal(result.status,'COMPLETE');assert.equal(result.imageCount,1);assert.equal(result.inputMode,'TEXT_AND_ORIGINAL_IMAGES');
  const saved=JSON.parse(await readFile(f.config.outputPath,'utf8'));assert.equal(saved.records[0].status,'SOURCE_VERIFIED');assert.equal(saved.records[0].activation.status,'AUTO_ENABLED');assert.equal(saved.records[0].direction.id,'S3');assert.deepEqual(saved.records[0].useWhen,['需要解释同口径变化']);assert.equal(saved.records[0].arm,'deepseek');assert.equal(saved.records[0].derivation.responseId,'response-fixture');assert.ok(!JSON.stringify(saved).includes('fixture-key'));assert.equal(saved.records[0].sourceRefs.some(r=>r.messageId==='p'),true);

  delete saved.builds.t.imageCoverage;await writeFile(f.config.outputPath,JSON.stringify(saved));assert.equal((await builder.build('t')).reused,true);assert.ok(Array.isArray(JSON.parse(await readFile(f.config.outputPath,'utf8')).builds.t.imageCoverage));assert.equal(calls,1);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('source revoked after response cannot publish; restoring inputs reuses durable receipt',async()=>{
 const f=await fixture();let calls=0;try{const builder=createTicketMemoryBuilder({configPath:f.configPath,checkoutRoot:f.checkout,credential:async()=> 'fixture',fetchImpl:provider(async()=>{calls++;f.attention.sources[0].status='excluded';await writeFile(f.config.attentionPath,JSON.stringify(f.attention));})});await assert.rejects(builder.build('t'),/MEMORY_SOURCE_NOT_ALLOWED/);await assert.rejects(readFile(f.config.outputPath),{code:'ENOENT'});
 f.attention.sources[0].status='active';await writeFile(f.config.attentionPath,JSON.stringify(f.attention));assert.equal((await builder.build('t')).status,'COMPLETE');assert.equal(calls,1);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('source revoked while resolving credentials is never sent to provider',async()=>{
 const f=await fixture();let calls=0;try{const builder=createTicketMemoryBuilder({configPath:f.configPath,checkoutRoot:f.checkout,credential:async()=>{f.attention.sources[0].status='excluded';await writeFile(f.config.attentionPath,JSON.stringify(f.attention));return 'fixture';},fetchImpl:provider(()=>{calls++;})});await assert.rejects(builder.build('t'),/MEMORY_SOURCE_NOT_ALLOWED/);assert.equal(calls,0);}finally{await rm(f.root,{recursive:true,force:true});}
});
test('unknown execution stays fenced after exclusion and restoration',async()=>{
 const f=await fixture();let calls=0;try{const builder=createTicketMemoryBuilder({configPath:f.configPath,checkoutRoot:f.checkout,credential:async()=> 'fixture',fetchImpl:async()=>{calls++;f.attention.sources[0].status='excluded';await writeFile(f.config.attentionPath,JSON.stringify(f.attention));throw Error('unknown');}});await assert.rejects(builder.build('t'),/MEMORY_SOURCE_NOT_ALLOWED/);f.attention.sources[0].status='active';await writeFile(f.config.attentionPath,JSON.stringify(f.attention));await assert.rejects(builder.build('t'),/PREVIOUS_CALL_NEEDS_REVIEW/);assert.equal(calls,1);}finally{await rm(f.root,{recursive:true,force:true});}
});
test('unapproved response model stays needs-review',async()=>{
 const f=await fixture();try{const builder=createTicketMemoryBuilder({configPath:f.configPath,checkoutRoot:f.checkout,credential:async()=> 'fixture',fetchImpl:async(...args)=>{const response=await provider()(...args);const body=await response.json();body.model='unapproved-model';return {...response,json:async()=>body};}});const result=await builder.build('t');assert.equal(result.status,'NEEDS_REVIEW');assert.ok(result.issues.includes('RESPONSE_MODEL_MISMATCH'));}finally{await rm(f.root,{recursive:true,force:true});}
});
test('malformed output is preserved as needs-review and cannot silently retry unchanged input',async()=>{
 const f=await fixture();let calls=0;try{const builder=createTicketMemoryBuilder({configPath:f.configPath,checkoutRoot:f.checkout,credential:async()=> 'fixture',fetchImpl:async()=>{calls++;return {ok:false,status:429,json:async()=>({error:{code:'rate_limited'}})};}});assert.equal((await builder.build('t')).status,'NEEDS_REVIEW');await assert.rejects(builder.build('t'),/PREVIOUS_CALL_NEEDS_REVIEW/);assert.equal(calls,1);}finally{await rm(f.root,{recursive:true,force:true});}
});
test('invented evidence and image IDs fail validation',()=>{
 const issues=validateBuiltMemory({memories:[{title:'方法',typicalQuestion:'问题',methodBasis:'REPLY_EVIDENCE',inputs:['周期'],outputs:['结果'],boundaries:['待核对'],steps:[{action:'核对',why:'原因',evidenceIds:['fake']}],imageEvidenceIds:['fake-image']}]},{packet:{evidence:[{id:'E1'}]}},[]);assert.ok(issues.includes('INVALID_EVIDENCE'));assert.ok(issues.includes('INVALID_IMAGE_EVIDENCE'));
});
test('image-stage ceiling is atomic across document and Memory requests and defers excess',async()=>{
 const root=await mkdtemp(join(tmpdir(),'image-budget-'));try{const budget=await createDiagnosticBudget({directory:join(root,'ledger'),dailyLimitCny:10});const results=await Promise.all([budget.reserve({reservationId:'a',runId:'a',stage:'context-images',upperBoundCny:1.2}),budget.reserve({reservationId:'b',runId:'b',stage:'memory-image-extraction',upperBoundCny:1.2})]);assert.equal(results.filter(r=>r.allowed).length,1);assert.equal(results.find(r=>!r.allowed).reason,'IMAGE_DAILY_BUDGET_LIMIT');}finally{await rm(root,{recursive:true,force:true});}
});
test('local Memory action requires same origin and ticket-only input, then exposes actual parent-image result',async()=>{
 const f=await fixture();let server,calls=0;try{
  await writeFile(f.config.outputPath,JSON.stringify({schemaVersion:'memory-playbooks-v1',records:[],builds:{}}));
  const builder=createTicketMemoryBuilder({configPath:f.configPath,checkoutRoot:f.checkout,credential:async()=> 'fixture',fetchImpl:provider(()=>{calls++;})});
  server=await startWorkbenchServer({port:0,checkoutRoot:f.checkout,historicalTicketsPath:f.config.ticketsPath,historicalTicketScopePath:f.config.scopePath,attentionPath:f.config.attentionPath,questionContextsPath:f.config.messagesPath,memoryPlaybooksPath:f.config.outputPath,memoryBuilderService:builder});
  const base='http://127.0.0.1:'+server.address().port;
  const post=body=>fetch(base+'/api/ticket-memory-build',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)});
  assert.equal((await fetch(base+'/api/ticket-memory-build',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"ticketId":"t"}'})).status,405);
  assert.equal((await post({ticketId:'t',model:'arbitrary'})).status,400);assert.equal(calls,0);
  assert.equal((await post({ticketId:'unrelated'})).status,404);assert.equal(calls,0);
  const response=await post({ticketId:'t'});assert.equal(response.status,200);assert.equal((await response.json()).status,'COMPLETE');
  const detail=await(await fetch(base+'/api/ticket-memory?ticket=t')).json();assert.equal(detail.builder.configured,true);assert.equal(detail.generated.length,1);assert.equal(detail.builder.lastBuild.imageCount,1);
  assert.equal((await fetch(base+detail.generated[0].attachments[0].imagePath)).status,200);
  assert.equal((await(await post({ticketId:'t'})).json()).reused,true);assert.equal(calls,1);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(f.root,{recursive:true,force:true});}
});

test('changed source sessions archive the exact prior memory even when the returned method repeats',async()=>{
 const f=await fixture();try{
  const builder=createTicketMemoryBuilder({configPath:f.configPath,checkoutRoot:f.checkout,credential:async()=> 'fixture',fetchImpl:provider()});
  await builder.build('t');const before=JSON.parse(await readFile(f.config.outputPath,'utf8')).records[0];
  const graph=JSON.parse(await readFile(f.config.messagesPath,'utf8'));graph.messages.find(m=>m.messageId==='a').text+=' 后续补充原文。';await writeFile(f.config.messagesPath,JSON.stringify(graph));
  await builder.build('t');const after=JSON.parse(await readFile(f.config.outputPath,'utf8'));
  assert.notEqual(after.records[0].id,before.id);assert.ok(after.historyRecords.some(record=>JSON.stringify(record)===JSON.stringify(before)));
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('builder uses the installer environment rather than a maintainer credential file',async()=>{
 const f=await fixture();let auth;try{
  const builder=createTicketMemoryBuilder({configPath:f.configPath,checkoutRoot:f.checkout,env:{DEEPSEEK_API_KEY:'synthetic-installer-key'},fetchImpl:async(url,options)=>{auth=options.headers.Authorization;return provider()(url,options);}});
  assert.equal((await builder.build('t')).status,'COMPLETE');assert.equal(auth,'Bearer synthetic-installer-key');
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('budget ledger must remain outside the checkout including future and symlinked directories',async()=>{
 const f=await fixture();try{
  const link=join(f.data,'checkout-link');await symlink(f.checkout,link);
  for(const budgetDirectory of [f.checkout,join(f.checkout,'new-budget'),join(link,'new-budget'),f.root+'/not-created/../checkout/new-budget']){
   await writeFile(f.configPath,JSON.stringify({...f.config,budgetDirectory}));
   await assert.rejects(loadMemoryBuildInputs(f.configPath,f.checkout),/MEMORY_PRIVATE_PATH_INVALID/);
  }
 }finally{await rm(f.root,{recursive:true,force:true});}
});
