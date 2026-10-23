import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInstalledOptions, projectInstalledDataset} from '../src/installed-workbench.mjs';
import {createWorkbenchServer} from '../apps/business-workbench/server.mjs';
import {validateDataset} from '../apps/business-workbench/data.mjs';
import {createLocalConfig} from '../src/config.mjs';
import {createLocalTrialRuntime} from '../src/local-runtime.mjs';
import {createEncryptedLocalStore} from '../src/encrypted-store.mjs';
const config=createLocalConfig({LOCAL_PORT:'4310',WPS_APP_ID:'synthetic-app',WPS_APP_KEY:'synthetic-app-key',WPS_REDIRECT_URI:'http://127.0.0.1:4310/oauth/wps/callback',WPS_SCOPES:'kso.user_base.read kso.mcp_message.readwrite',LLM_PROVIDER:'synthetic',LLM_BASE_URL:'https://example.invalid/chat/completions',LLM_MODEL:'synthetic-model',LLM_API_KEY:'synthetic-model-key'});
async function harness(t,ready=true,extensions={}){
 const root=await mkdtemp(path.join(tmpdir(),'installed-workbench-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=await createEncryptedLocalStore({root:path.join(root,'data')});
 let modelCalls=0;
 const runtime=createLocalTrialRuntime({config,store,now:()=>new Date('2026-01-09T12:00:00Z'),oauth:{buildAuthorization:()=>({url:'https://example.invalid/authorize',state:'synthetic-state'}),exchange:async()=>({accessToken:'synthetic-access'})},wpsClientFactory:()=>({listChats:async()=>({chats:[{id:'group-a',name:'示例协作组',groupChat:true}],completeness:{complete:true}}),getMessages:async()=>({messages:[{id:'m1',text:'示例资料等待评审',senderName:'提问成员',occurredAt:'2026-01-09T10:00:00Z'}],completeness:{complete:true}})}),inference:{analyze:async()=>{modelCalls++;return{summary:'示例待审',candidates:[{title:'示例评审',reason:'资料等待评审',nextQuestion:'何时评审？',evidenceIds:['m1']}]};}}});
 let integrationEnv={};
 if(extensions.externalAttention){const policy=path.join(root,'attention.json'),settings=path.join(root,'settings.json');await writeFile(policy,JSON.stringify(extensions.externalAttention));await writeFile(settings,JSON.stringify({attentionPath:policy}));integrationEnv.THIRD_BRAIN_WORKBENCH_CONFIG=settings;}
 const options=await createInstalledOptions({root:process.cwd(),env:integrationEnv,config:ready?config:createLocalConfig({}),store,runtime});
 const server=createWorkbenchServer(options);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${server.address().port}`;
 const get=async route=>{const r=await fetch(url+route);assert.equal(r.status,200,route);return r.json();};
 const post=async(route,value)=>fetch(url+route,{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify(value)});
 return {store,runtime,options,server,url,get,post,calls:()=>modelCalls};
}
test('new installer defaults to empty real workspace and exposes five-page client without paid calls',async t=>{
 const h=await harness(t,false);const result=await h.get('/api/dataset');assert.deepEqual(result.dataset.cases,[]);assert.equal(validateDataset(result.dataset).valid,true);
 for(const route of ['/api/attention','/api/discovery','/api/discovery-memory','/api/installation'])await h.get(route);
 const html=await(await fetch(h.url)).text();assert.match(html,/工作助理/);assert.doesNotMatch(html,/本地工作台/);
 const asset=html.match(/src="([^"]+\.js)"/)[1];const js=await(await fetch(h.url+asset)).text();for(const title of ['工作概览','业务问答','信息源管理','主动发现','项目记忆'])assert.ok(js.includes(title),title);
 assert.equal(h.calls(),0);assert.equal((await h.post('/api/analyze',{})).status,409);
});
test('own OAuth import and analysis project into modern evidence; exclusion suppresses all derived output and persists',async t=>{
 const h=await harness(t);await h.post('/oauth/wps/start',{});await h.runtime.finishAuthorization({code:'synthetic-code',state:'synthetic-state'});
 await h.get('/api/chats');assert.equal((await h.post('/api/import',{chatIds:['group-a'],days:7})).status,200);assert.equal(h.calls(),0);
 assert.equal((await h.post('/api/analyze',{})).status,200);assert.equal(h.calls(),1);
 const view=(await h.get('/api/dataset')).dataset;assert.deepEqual(validateDataset(view).errors,[]);assert.equal(view.cases[0].evidence[0].speaker,'提问成员');assert.equal(view.cases[0].evidence[0].text,'示例资料等待评审');
 assert.equal((await h.post('/api/attention',{id:'group-a',action:'exclude'})).status,200);
 assert.deepEqual((await h.get('/api/dataset')).dataset.cases,[]);assert.equal((await fetch(h.url+'/api/workspace')).status,404);assert.equal((await h.post('/api/import',{chatIds:['group-a'],days:7})).status,400);
 const persisted=await h.store.read('workspace');assert.equal(persisted.messages.length,1);assert.equal((await h.store.read('attention')).sources[0].status,'excluded');
});
test('explicit import mutation rejects cross-origin and conflicting or invalid source input',async t=>{
 const h=await harness(t);const r=await fetch(h.url+'/api/import',{method:'POST',headers:{Origin:'https://example.invalid','Content-Type':'application/json'},body:'{}'});assert.equal(r.status,403);assert.equal(h.calls(),0);
});
test('missing an uncited input source hides the whole derived case',()=>{
 const workspace={importedAt:'2026-01-09T10:00:00Z',messages:[{id:'m',chatId:'allowed',chatName:'示例',senderName:'成员',occurredAt:'2026-01-09T10:00:00Z',text:'正文'},{id:'uncited',chatId:'blocked'}],analysis:{generatedAt:'2026-01-09T10:00:00Z',candidates:[{title:'示例',reason:'待核查',evidence:[{messageId:'m'}]}]}};
 assert.deepEqual(projectInstalledDataset(workspace,config,{sources:[{id:'blocked',status:'excluded'}]}).cases,[]);
});

test('external attention policy is the same authority for UI, import, model dispatch and encrypted projection',async t=>{
 const h=await harness(t,true,{externalAttention:{version:1,sources:[{id:'wps:chat-group-a',chatId:'group-a',name:'示例组',kind:'group',tier:'normal',status:'active',matchedWorklines:[],manualOverride:true}]}});
 h.runtime.beginAuthorization();await h.runtime.finishAuthorization({code:'synthetic',state:'synthetic-state'});await h.get('/api/chats');
 assert.equal((await h.post('/api/import',{chatIds:['group-a'],days:7})).status,200);
 assert.equal((await h.post('/api/analyze',{})).status,200);
 assert.equal((await h.get('/api/dataset')).dataset.cases.length,1);
 assert.equal((await h.post('/api/attention',{id:'wps:chat-group-a',action:'exclude'})).status,200);
 assert.equal((await h.post('/api/import',{chatIds:['group-a'],days:7})).status,400);
 assert.equal((await h.post('/api/analyze',{})).status,400);assert.equal(h.calls(),1);
 assert.deepEqual((await h.get('/api/dataset')).dataset.cases,[]);
 assert.equal((await h.get('/api/attention')).sources[0].status,'excluded');
});
test('env-file-only integration and credential settings reach the actual diagnostic adapter',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'installed-env-file-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const root=path.join(directory,'checkout');await mkdir(root);
 const integrations=path.join(directory,'integrations.json');await writeFile(integrations,JSON.stringify({historyPath:path.join(directory,'history.json')}));
 await writeFile(path.join(root,'.env.local'),`THIRD_BRAIN_WORKBENCH_CONFIG=${integrations}\nDEEPSEEK_API_KEY=synthetic-file-credential\nDELPER_MCP_URL=https://example.invalid/mcp\nDELPER_MCP_TOKEN=synthetic-file-token\n`);
 const options=await createInstalledOptions({root,env:{},config});
 assert.equal(options.historyPath,path.join(directory,'history.json'));
 const {namedCredential}=await import('../apps/business-workbench/diagnostic-adapters.mjs');
 assert.equal(await namedCredential('DeepSeek','api_key',options.diagnosticEnvironment),'synthetic-file-credential');
 assert.equal(options.diagnosticEnvironment.DELPER_MCP_URL,'https://example.invalid/mcp');
 assert.equal(options.diagnosticEnvironment.DELPER_MCP_TOKEN,'synthetic-file-token');
});

test('installed configuration accepts external Memory files without requiring an active model',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'installed-memory-config-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const root=path.join(directory,'checkout');await mkdir(root);
 const integrationFile=path.join(directory,'integrations.json'),memoryFile=path.join(directory,'playbooks.json');
 await writeFile(integrationFile,JSON.stringify({memoryPlaybooksPath:memoryFile,memoryBuilderPath:path.join(directory,'builder.json'),memoryReusePath:path.join(directory,'reuse.json'),memoryPeriodicTestPath:path.join(directory,'test.json'),memoryEvaluationPath:path.join(directory,'evaluation.json')}));
 const options=await createInstalledOptions({root,env:{THIRD_BRAIN_WORKBENCH_CONFIG:integrationFile,THIRD_BRAIN_DATA_DIRECTORY:path.join(directory,'user-data')}});
 assert.equal(options.memoryPlaybooksPath,memoryFile);assert.equal(options.memoryBuilderPath,path.join(directory,'builder.json'));
});
