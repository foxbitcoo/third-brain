import test from 'node:test';
import assert from 'node:assert/strict';
import {createJsonModelCall,createSourceJudge} from '../refresh-judges.mjs';

test('source judge uses Pro and separates business association from personal responsibility',async()=>{
 let sent;
 const judge=createSourceJudge({ownerId:'owner',modelCall:async input=>{sent=input;return{reason:'测试支撑交付',matchedWorklines:['工作'],evidenceRefs:['m1'],directResponsibility:false,model:input.model};}});
 const answer=await judge({source:{name:'协作',kind:'group'},worklines:['工作','新议题'],messages:[{id:'m1',occurredAt:'2026-10-14T08:00:00Z',sender:{id:'other'},text:'我下午完成测试'}]});
 assert.equal(sent.model,'deepseek-v4-pro');assert.match(sent.messages[0].content,/他人承诺/);assert.equal(answer.directResponsibility,false);assert.equal(answer.model,'deepseek-v4-pro');
});

test('model transport records attempted/actual models and rejects truncated JSON',async()=>{
 const responses=[{model:'deepseek-v4-pro',usage:{prompt_tokens:10,completion_tokens:2},choices:[{finish_reason:'stop',message:{content:'{"decisions":[]}'}}]},{model:'deepseek-v4-pro',usage:{prompt_tokens:9,completion_tokens:4},choices:[{finish_reason:'length',message:{content:'{"decisions":['}}]}];
 const transport=createJsonModelCall({apiKey:'test-only',fetchImpl:async(_url,o)=>{assert.equal(JSON.parse(o.body).model,'deepseek-v4-pro');return{ok:true,status:200,json:async()=>responses.shift()};}});
 await transport.call({stage:'workline_discovery',messages:[{role:'user',content:'有限测试'}]});
 await assert.rejects(transport.call({messages:[{role:'user',content:'有限测试'}]}),/MODEL_TRUNCATED/);
 assert.equal(transport.usage.calls,2);assert.equal(transport.usage.successfulCalls,1);assert.equal(transport.usage.prompt_tokens,19);assert.equal(transport.usage.requests[1].status,'FAILED');
 assert.equal(JSON.stringify(transport.usage).includes('test-only'),false);
});
