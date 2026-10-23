import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createLocalConfig } from './config.mjs';
import { createEncryptedLocalStore } from './encrypted-store.mjs';
import { readEnvFile } from './env-file.mjs';
import { createOpenAiCompatibleAnalyzer } from './openai-compatible.mjs';
import { createLocalTrialRuntime } from './local-runtime.mjs';
import { createLocalHttpServer } from './http-server.mjs';
import { createLocalSetupServer } from './setup-server.mjs';
import { startWorkbenchServer } from '../apps/business-workbench/server.mjs';
import { changeSource, loadAttention, updateAttention } from '../apps/business-workbench/source-attention.mjs';

const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
export function projectInstalledDataset(workspace, config, attention, now = new Date().toISOString()) {
  const blocked = new Set(attention.sources.filter(s => s.status === 'excluded').flatMap(s => [s.id,s.chatId].filter(Boolean)));
  const messages = new Map((workspace?.messages || []).map(m => [m.id, m]));
  const asOf = workspace?.analysis?.generatedAt || workspace?.importedAt || now;
  const dependenciesAllowed = !(workspace?.messages || []).some(m => blocked.has(m.chatId));
  const cases = (dependenciesAllowed ? workspace?.analysis?.candidates || [] : []).flatMap((candidate, index) => {
    const originals = (candidate.evidence || []).map(e => messages.get(e.messageId));
    // All dependencies must still exist and be allowed. Do not retain a derived
    // summary after one of its source records is removed or excluded.
    if (!originals.length || originals.some(m => !m || blocked.has(m.chatId))) return [];
    const id = `work-${digest(originals.map(m => m.id).join('|') + candidate.title)}`;
    const evidence = originals.map(m => ({ id: `message-${digest(m.id)}`, source_type: 'im', source_id: m.chatId,
      source_title: m.chatName, speaker: m.senderName || '姓名待确认', occurred_at: m.occurredAt,
      text: m.text, locator: JSON.stringify({ platform: 'wps', sourceRef: m.chatId, itemRef: m.id }) }));
    const refs = evidence.map(e => e.id);
    return [{ id, title: candidate.title, question: candidate.nextQuestion || `当前进展、依据和下一步是什么？`, scope: '本人选择并完整导入的消息', as_of: asOf, evidence,
      runs: [{ id: `analysis-${index}`, route: 'A', model: workspace.analysis.model || 'not-recorded', provider: workspace.analysis.provider || 'not-recorded', status: 'VERIFIED',
        answer: { summary: candidate.reason, developments: [{text:candidate.reason,evidence_ids:refs}], viewpoints: [], decisions: [], open_questions: candidate.nextQuestion ? [{text:candidate.nextQuestion,evidence_ids:refs}] : [], next_steps: [] },
        metrics: {latency_ms:null,input_tokens:null,output_tokens:null,cost_cny:null},
        audit: {citations:'valid',review_status:'PENDING_USER'} }] }];
  });
  return { schema_version: 'business-qa-v1', dataset_id: 'installed-private-workspace', as_of: asOf, cases };
}

const CONFIG_PATH_FIELDS = new Set(['dataPath','attentionPath','historyPath','readingGuidePath','sourceMapPath','displayTitlesPath','documentPolicyPath','discoveryPath','historicalTicketsPath','historicalTicketScopePath','discoveryBoardsPath','questionContextsPath','historicalMediaPath','contextSourcesPath','worklinesPath','memoryReusePath','memoryEvaluationPath','memoryBuilderPath','memoryPlaybooksPath','memoryPeriodicTestPath']);
async function externalPath(file, root) {
  if (!path.isAbsolute(file)) throw Error('INVALID_WORKBENCH_CONFIG');
  const target=await realpath(file), directory=await realpath(root), relative=path.relative(directory,target);
  if (!relative || !relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative)) throw Error('INVALID_WORKBENCH_CONFIG');
  return target;
}
async function installedIntegrations(file, root) {
  if (!file) return {};
  const actual=await externalPath(file,root), info=await stat(actual);
  if (!info.isFile() || info.size>64*1024) throw Error('INVALID_WORKBENCH_CONFIG');
  const chosen=JSON.parse(await readFile(actual,'utf8'));
  if (!chosen || Array.isArray(chosen) || typeof chosen!=='object') throw Error('INVALID_WORKBENCH_CONFIG');
  for (const [key,value] of Object.entries(chosen)) if (!CONFIG_PATH_FIELDS.has(key) || typeof value!=='string' || !path.isAbsolute(value)) throw Error('INVALID_WORKBENCH_CONFIG');
  return chosen;
}
async function jsonInput(request) {
  let body='';
  for await(const chunk of request){body+=chunk;if(Buffer.byteLength(body)>65536)throw Error('REQUEST_TOO_LARGE');}
  return JSON.parse(body||'{}');
}

export async function createInstalledOptions({ root=process.cwd(), env=process.env, config, store, runtime }={}) {
  env={...await readEnvFile(path.join(root,'.env.local')),...env};
  config ||= createLocalConfig(env);
  const integrations=await installedIntegrations(env.THIRD_BRAIN_WORKBENCH_CONFIG,root);
  const port=Number.isInteger(config.port)&&config.port>=1024&&config.port<=65535?config.port:4310;
  store ||= await createEncryptedLocalStore({root:env.THIRD_BRAIN_DATA_DIRECTORY||path.join(root,'.runtime','user-data')});
  runtime ||= createLocalTrialRuntime({config,store,inference:createOpenAiCompatibleAnalyzer(config.model),contextPath:env.THIRD_BRAIN_CONTEXT_PATH});
  const attention=async()=>integrations.attentionPath
    ? loadAttention(await externalPath(integrations.attentionPath,root))
    : await store.read('attention')||{version:1,sources:[]};
  let updatingAttention=false;
  async function mutateAttention(mutate) {
    if(updatingAttention)throw Error('ATTENTION_BUSY');
    updatingAttention=true;
    try {
      if(integrations.attentionPath)return await updateAttention(await externalPath(integrations.attentionPath,root),mutate);
      const next=await mutate(await attention());await store.write('attention',next);return next;
    } finally {updatingAttention=false;}
  }
  const legacy=createLocalHttpServer({runtime,indexFile:new URL('../public/index.html',import.meta.url)}).listeners('request')[0];
  const setup=createLocalSetupServer({setupFile:new URL('../public/setup.html',import.meta.url),envFile:path.join(root,'.env.local'),port}).listeners('request')[0];
  let activeMutation=false;
  const blocked=async messages=>{
    const current=await attention(), denied=new Set(current.sources.filter(s=>s.status==='excluded').flatMap(s=>[s.id,s.chatId].filter(Boolean)));
    return (messages||[]).some(m=>denied.has(m.chatId));
  };
  async function importSelected(input) {
    if(!Array.isArray(input.chatIds)||await blocked(input.chatIds.map(chatId=>({chatId}))))throw Error('SOURCE_EXCLUDED');
    const result=await runtime.importMessages(input);
    await mutateAttention(current=>{
      for(const source of result.sources)if(!current.sources.some(s=>s.id===source.chatId||s.chatId===source.chatId))current.sources.push({id:source.chatId,chatId:source.chatId,name:source.chatName,kind:'group',status:'active',tier:'normal',manualOverride:true,decisionOrigin:'manual',reason:'本人选择导入',matchedWorklines:[],history:[]});
      return current;
    });
    if(await blocked(result.sources.map(s=>({chatId:s.chatId}))))throw Error('SOURCE_POLICY_CHANGED');
    return result;
  }
  const options={appRoot:path.resolve(root,'apps/business-workbench'),checkoutRoot:root,port,...integrations,
    diagnosticEnvironment:env,
    datasetProvider:async()=>projectInstalledDataset(await store.read('workspace'),config,await attention()),
    attentionProvider:async change=>change?mutateAttention(current=>changeSource(current,change.id,change.action,change.tier)):attention(),
    extensionHandler:async(request,response,route)=>{
      const reply=(status,value)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));};
      if(route==='/api/installation'&&request.method==='GET'){reply(200,{...await runtime.status(),configured:config.ready,missing:config.missing,provider:config.model.provider,model:config.model.model});return true;}
      if(route==='/setup'&&request.method==='GET'){request.url='/';await setup(request,response);return true;}
      if(route.startsWith('/api/setup/')){await setup(request,response);return true;}
      // Old unfiltered workspace reads are intentionally not mounted in this UI.
      const routes=['/api/status','/api/chats','/api/import','/api/analyze','/api/judgments','/oauth/wps/start','/oauth/wps/callback'];
      if(!routes.includes(route))return false;
      if(!config.ready){reply(409,{error:'SETUP_REQUIRED',message:'请先完成自己的应用与模型配置，并重启服务。'});return true;}
      if(request.method==='POST'&&['/api/import','/api/analyze','/api/judgments'].includes(route)){
        if(activeMutation){reply(409,{error:'BUSY',message:'已有导入或分析正在执行。'});return true;}
        activeMutation=true;
        try {
          const input=await jsonInput(request);
          if(route==='/api/import')reply(200,await importSelected(input));
          else {
            if(await blocked((await store.read('workspace'))?.messages))throw Error('SOURCE_POLICY_CHANGED');
            const result=route==='/api/analyze'?await runtime.analyzeImportedMessages():await runtime.saveJudgment(input);
            if(await blocked((await store.read('workspace'))?.messages))throw Error('SOURCE_POLICY_CHANGED');
            reply(200,result);
          }
        } catch {reply(400,{error:'IMPORT_OR_ANALYSIS_FAILED',message:'导入或分析未完成；请核对授权、来源范围与模型配置。'});}
        finally {activeMutation=false;}
        return true;
      }
      await legacy(request,response);return true;
    }};
  if(integrations.dataPath)delete options.datasetProvider;
  if(config.ready)options.liveQaProviders=[{provider:'installed',model:config.model.model,endpoint:config.model.baseUrl,apiKey:config.model.apiKey}];
  return options;
}
export async function startInstalledWorkbench(options={}){return startWorkbenchServer(await createInstalledOptions(options));}
