import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorklineDiscoverer,createWorklineJudge,normalizeWorklines} from '../workline-discovery.mjs';
const now='2026-10-14T09:00:00Z';
const msg=(id,text,occurredAt='2026-10-14T08:00:00Z')=>({id,text,occurredAt});
const preview=(id,messages,extra={})=>({source:{id,kind:'group'},messages,status:'VERIFIED',complete:true,...extra});
const ref=(sourceId,messageId)=>({sourceId,messageId});
const candidate=(refs,extra={})=>({kind:'candidate',title:'权限交接',objective:'完成权限交接并建立持续支持',scope:'新的产品职责',deliverables:['权限清单'],signalStrength:'weak',reason:'同一业务目标跨来源推进',evidenceRefs:refs,...extra});
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'workline-discovery-'));try{await fn(join(dir,'worklines.json'));}finally{await rm(dir,{recursive:true,force:true});}}

test('one independent batch combines sources; existing goal, subtask and new work remain distinct',()=>fixture(async storePath=>{
 let calls=0;const worklines=['移动版上线'];const target=normalizeWorklines(worklines)[0].id;
 const discover=createWorklineDiscoverer({storePath,judge:async input=>{calls++;assert.deepEqual(new Set(input.evidence.map(e=>e.sourceId)),new Set(['g1','g2']));return {decisions:[{kind:'subtask',worklineId:target,title:'回归测试',reason:'测试服务同一上线目标',evidenceRefs:[ref('g1','m1')]},candidate([ref('g1','m2'),ref('g2','m3')]),{kind:'insufficient',title:'临时帮忙',reason:'未见持续目标',evidenceRefs:[ref('g2','m4')]}]};}});
 const result=await discover({worklines,now,previews:[preview('g1',[msg('m1','版本回归明天完成'),msg('m2','本周接手权限交接')]),preview('g2',[msg('m3','权限清单已补充，后续请继续支持'),msg('m4','帮我看一眼')])]});
 assert.equal(calls,1);assert.equal(result.candidates.length,1);assert.equal(result.receipt.associations[0].kind,'subtask');assert.equal(result.receipt.insufficient.length,1);assert.equal(result.candidates[0].status,'candidate');assert.equal(result.expandedWorklines.length,2);assert.deepEqual(worklines,['移动版上线']);assert.equal(result.receipt.formalMemoryUpdated,false);
}));

test('stable candidate ID and evidence de-duplication across reruns and renamed proposals',()=>fixture(async storePath=>{
 let title='权限交接';let captured;
 const discover=createWorklineDiscoverer({storePath,judge:async input=>{captured=input;return {decisions:[candidate([ref('g1','m1')],{title,signalStrength:'strong'})]};}});
 const input={now,previews:[preview('g1',[msg('m1','你来负责权限交接')])]};
 const first=await discover(input);title='交接与持续支持';const second=await discover(input);
 assert.equal(first.candidates[0].id,second.candidates[0].id);assert.equal(second.candidates[0].evidenceRefs.length,1);assert.equal(captured.previousCandidates.length,1);assert.equal(second.store.evidence.length,1);
}));

test('cross-run history supports weak evidence on another date; forwarded same fact does not count twice',()=>fixture(async storePath=>{
 let turn=0;
 const discover=createWorklineDiscoverer({storePath,judge:async input=>{turn++;return {decisions:[candidate(turn===1?[ref('g1','m1')]:[ref('g1','m1'),ref('g2','m2')])]};}});
 const first=await discover({now,previews:[preview('g1',[msg('m1','交接的范围先看看','2026-10-13T08:00:00Z')])]});assert.equal(first.candidates.length,0);
 const second=await discover({now,previews:[preview('g2',[msg('m2','已补范围与后续清单')])]});assert.equal(second.candidates.length,1);
 const forwarded=createWorklineDiscoverer({storePath:storePath+'.other',judge:async()=>({decisions:[candidate([ref('g3','a'),ref('g4','b')])]})});
 const r=await forwarded({now,previews:[preview('g3',[{...msg('a','同一转发'),originEvidenceId:'original'}]),preview('g4',[{...msg('b','同一转发'),originEvidenceId:'original'}])]});assert.equal(r.candidates.length,0);
}));

test('excluded source removed before call and when user excludes during model call',()=>fixture(async storePath=>{
 let blocked=false;let seen;
 const discover=createWorklineDiscoverer({storePath,sourceAllowed:async id=>id!=='blocked'&&!(blocked&&id==='g1'),judge:async input=>{seen=input;blocked=true;return {decisions:[candidate([ref('g1','m1')],{signalStrength:'strong'})]};}});
 const result=await discover({now,previews:[preview('blocked',[msg('private','forbidden')]),preview('g1',[msg('m1','负责交接')])]});
 assert.equal(seen.evidence.length,1);assert.equal(seen.evidence[0].sourceId,'g1');assert.equal(result.candidates.length,0);assert.equal(result.store.evidence.length,0);assert.equal(result.receipt.error,'SOURCE_EXCLUDED_DURING_JUDGMENT');
}));

test('invalid references fail closed and single weak or meeting-only proposal does not create workline',()=>fixture(async storePath=>{
 const discover=createWorklineDiscoverer({storePath,judge:async()=>({decisions:[candidate([ref('g1','made-up')],{signalStrength:'strong'}),candidate([ref('g1','m1')]),candidate([ref('meeting','m2')],{signalStrength:'strong'})]})});
 const r=await discover({now,previews:[preview('g1',[msg('m1','也许后面要做')]),preview('meeting',[msg('m2','会议上说交接')],{source:{id:'meeting',kind:'meeting'}})]});
 assert.equal(r.candidates.length,0);assert.equal(r.receipt.rejected.length,1);assert.equal(r.receipt.insufficient.length,2);assert.equal(r.receipt.status,'PARTIAL');
}));

test('bounded input fairly includes sources and reports truncation, never negative certainty',()=>fixture(async storePath=>{
 let captured;const discover=createWorklineDiscoverer({storePath,limits:{maxEvidence:2,maxTextChars:5},judge:async input=>{captured=input;return {decisions:[]};}});
 const r=await discover({now,previews:[preview('a',[msg('1','very long source message'),msg('2','next')],{complete:false}),preview('b',[msg('3','other')])]});
 assert.equal(captured.evidence.length,2);assert.equal(new Set(captured.evidence.map(e=>e.sourceId)).size,2);assert.equal(r.receipt.boundary.truncated,true);assert.equal(r.receipt.boundary.historyOmitted,1);assert.equal(r.receipt.boundary.textsTruncated,1);
}));

test('model failure preserves previous candidates',()=>fixture(async storePath=>{
 let fail=false;const discover=createWorklineDiscoverer({storePath,judge:async()=>{if(fail)throw new Error('provider down');return {decisions:[candidate([ref('g1','m1')],{signalStrength:'strong'})]};}});
 const args={now,previews:[preview('g1',[msg('m1','你负责交接')])]};const one=await discover(args);fail=true;const two=await discover(args);
 assert.equal(two.receipt.status,'FAILED');assert.equal(two.candidates[0].id,one.candidates[0].id);assert.equal(JSON.parse(await readFile(storePath,'utf8')).candidates.length,1);
}));

test('actual call adapter sends independent explicit model and parses OpenAI output',async()=>{
 let request;const judge=createWorklineJudge({modelCall:async input=>{request=input;return {model:'deepseek-v4-pro',choices:[{message:{content:'{"decisions":[]}'}}],usage:{prompt_tokens:20}};}});
 const result=await judge({limits:{maxDecisions:5},worklines:[],previousCandidates:[],evidence:[]});assert.equal(request.model,'deepseek-v4-pro');assert.equal(request.messages.length,2);assert.deepEqual(result.decisions,[]);assert.equal(result.usage.prompt_tokens,20);
});

 test('rich current workline context reaches model; repeated title is not the only boundary',()=>fixture(async storePath=>{
 let seen;const discover=createWorklineDiscoverer({storePath,judge:async input=>{seen=input;return {decisions:[]};}});
 await discover({now,worklines:['移动上线'],worklineContext:[{title:'移动上线',objective:'让手机端支持指定文档输出',scope:'移动客户端',summary:'接口与灰度推进中'}],previews:[preview('g',[msg('m','回归测试')])]});
 assert.equal(seen.worklines[0].summary,'接口与灰度推进中');assert.equal(seen.worklines[0].scope,'移动客户端');
}));


test('mixed-source old candidate and its rationale are entirely suppressed before model and API store',()=>fixture(async storePath=>{
 const old={version:'workline-discovery-v2',candidates:[{id:'old',title:'PRIVATE_B',objective:'joint PRIVATE_B',scope:'joint',reason:'PRIVATE_B detail',deliverables:[],status:'candidate',evidenceRefs:[{...ref('a','a1'),occurredAt:now},{...ref('b','b1'),occurredAt:now}],history:[{reason:'PRIVATE_B',evidenceRefs:[ref('a','a1'),ref('b','b1')]}]}],evidence:[{sourceId:'a',messageId:'a1',occurredAt:now,text:'clean A'},{sourceId:'b',messageId:'b1',occurredAt:now,text:'PRIVATE_B'}]};
 await writeFile(storePath,JSON.stringify(old));let captured;
 const run=createWorklineDiscoverer({storePath,judge:async input=>{captured=input;return{decisions:[]};}});
 const result=await run({now,excludedSourceIds:['b']});assert.equal(captured.previousCandidates.length,0);assert.equal(result.candidates.length,0);assert.equal(JSON.stringify(captured).includes('PRIVATE_B'),false);assert.equal((await readFile(storePath,'utf8')).includes('PRIVATE_B'),false);
}));

test('mid-call exclusion suppresses whole batch rationale even when model cites only allowed source',()=>fixture(async storePath=>{
 let forbidden=false;
 const run=createWorklineDiscoverer({storePath,sourceAllowed:async id=>!(forbidden&&id==='b'),judge:async()=>{forbidden=true;return{decisions:[candidate([ref('a','a1')],{title:'PRIVATE_B',objective:'PRIVATE_B',signalStrength:'strong'})]};}});
 const result=await run({now,previews:[preview('a',[msg('a1','clean')]),preview('b',[msg('b1','PRIVATE_B')])]});assert.equal(result.candidates.length,0);assert.equal(result.receipt.status,'PARTIAL');assert.equal(result.receipt.error,'SOURCE_EXCLUDED_DURING_JUDGMENT');assert.equal(JSON.stringify(result).includes('PRIVATE_B'),false);
}));

test('unknown candidate ID still fails closed and prompt requires owner linkage and no invented IDs',()=>fixture(async storePath=>{
 const run=createWorklineDiscoverer({storePath,judge:async()=>({decisions:[candidate([ref('a','a1')],{signalStrength:'strong',candidateId:'invented'})]})});
 const r=await run({now,context:{ownerId:'self'},previews:[preview('a',[msg('a1','明确承接')])]});assert.equal(r.candidates.length,0);assert.equal(r.receipt.rejected[0].reason,'UNKNOWN_CANDIDATE_ID');
 let request;const judge=createWorklineJudge({modelCall:async input=>{request=input;return{decisions:[]};}});await judge({limits:{maxDecisions:2},context:{ownerId:'self'}});assert.match(request.messages[0].content,/全新候选必须省略/);assert.match(request.messages[0].content,/context.ownerId/);assert.match(request.messages[0].content,/必须改为 insufficient/);
}));
