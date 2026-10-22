import { join } from 'node:path';
import { createDiagnosticBudget, estimateModelReservation } from './diagnostic-budget.mjs';
import { classifyDiagnosticQuestion } from './diagnostic-routing.mjs';
import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute, resolve, relative } from 'node:path';
import { createDiagnosticStore } from './diagnostic-run-store.mjs';
import { runDiagnostic } from './proactive-discovery.mjs';
import { ReadonlyDelperClient, createQueryExecutor, createDiagnosticModel, validateRecipe, hash } from './diagnostic-adapters.mjs';
import { loadDiagnosticAgent, createKnowledgeSnapshot, diagnosticRunView } from './diagnostic-agent.mjs';
import { createDiagnosticMemoryStore, selectMemorySnapshot, revalidateMemorySnapshot } from './diagnostic-memory.mjs';
import { diagnosticMemorySourceContext } from './diagnostic-memory-sources.mjs';

const error = code => Object.assign(new Error(code), { code });
const activeStates = new Set(['QUEUED','PLANNING','PLANNED','RUNNING_QUERY','RUNNING_REVIEW','REVIEWING','CONTINUE']);
const resumable = new Set(['NEEDS_HUMAN','NEEDS_DEFINITION','PAUSED_LIMIT','CANCELLED']);
function reviewBlockedBeforeDispatch(run) {
  const last=run.rounds?.at(-1);
  return run.status==='FAILED' && run.error?.code==='MODEL_CONTEXT_LIMIT' && !run.inflight
    && last?.status==='REVIEWING' && last.result?.status==='VERIFIED'
    && run.usage?.modelCalls>0 && !(run.usage.receipts||[]).some(r=>r.stage==='review'&&r.round===last.index);
}
const publicSource = s => ({ id:s.id,title:s.title,version:s.version,definition:s.definition,ready:s.definitionVerified===true&&s.recipes.length>0,unavailableReason:s.unavailableReason||(!s.definitionVerified?'指标口径或执行来源尚待核验。':null),recipes:s.recipes.map(({id,title,purpose,tool})=>({id,title,purpose,tool})) });
const summary = r => ({id:r.id,question:r.question,sourceId:r.sourceId,status:r.status,createdAt:r.createdAt,updatedAt:r.updatedAt});

export async function loadDiagnosticConfig(path, checkoutRoot) {
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>1_000_000)throw error('DISCOVERY_CONFIG_INVALID');
  const cfg=JSON.parse(await readFile(path,'utf8'));
  const rel=relative(resolve(checkoutRoot),resolve(cfg.storeDirectory||'.'));
  if(cfg.version!=='diagnostic-config-v1'||!isAbsolute(cfg.storeDirectory||'')||!rel||(!rel.startsWith('..')&&!isAbsolute(rel))||!Array.isArray(cfg.sources)||cfg.sources.length>10)throw error('DISCOVERY_CONFIG_INVALID');
  const ids=new Set();
  for(const source of cfg.sources){
    if(!/^[\w-]{1,100}$/.test(source.id)||ids.has(source.id)||typeof source.title!=='string'||typeof source.version!=='string'||typeof source.definition!=='string'||!Array.isArray(source.recipes)||source.recipes.length>12||source.userAuthorized!==true)throw error('DISCOVERY_CONFIG_INVALID');
    ids.add(source.id);
    const recipes=new Set();
    for(const r of source.recipes){validateRecipe(r);if(!/^[\w-]{1,100}$/.test(r.id)||recipes.has(r.id))throw error('DISCOVERY_CONFIG_INVALID');recipes.add(r.id);}
  }
  return cfg;
}

export async function createDiagnosticService({configPath,checkoutRoot,contextFor=async()=>[],resolveQuestionContext=async()=>null,modelProvider='deepseek',withMemory=true,authorize=async()=>true,authorizeMemorySource=async()=>false,model,query,client,env=process.env,store:injectedStore,agentPath,budget:injectedBudget,memoryStore:injectedMemoryStore}) {
  const config=await loadDiagnosticConfig(configPath,checkoutRoot);
  client ||= new ReadonlyDelperClient({endpoint:env.DELPER_MCP_URL,credential:async()=>env.DELPER_MCP_TOKEN});
  const store=injectedStore||await createDiagnosticStore(config.storeDirectory);
  const budget=injectedBudget||await createDiagnosticBudget({directory:join(config.storeDirectory,'budget')});
  const memoryDirectory=config.memoryDirectory||join(config.storeDirectory,'memory');
  const memorySourcesPath=config.memorySourcesPath||join(memoryDirectory,'sources.private.json');
  const outsideCheckout=path=>{const rel=relative(resolve(checkoutRoot),resolve(path));return isAbsolute(path)&&(rel==='..'||rel.startsWith('../')||isAbsolute(rel));};
  let memoryStore;
  try {
    if(!outsideCheckout(memoryDirectory)||!outsideCheckout(memorySourcesPath))throw error('DISCOVERY_CONFIG_INVALID');
    memoryStore=injectedMemoryStore||await createDiagnosticMemoryStore(join(memoryDirectory,'records'));
  } catch(cause) { if(!injectedStore)await store.close();throw cause; }
  const jobs=new Map();
  const memoryContext=source=>diagnosticMemorySourceContext({path:memorySourcesPath,checkoutRoot,source,authorizeSource:authorizeMemorySource});
  const currentMemory=async({run,source})=>!withMemory?null:revalidateMemorySnapshot(run.memorySnapshot,{records:await memoryStore.list(),source,cutoff:run.memorySnapshot?.cutoff||run.createdAt,...await memoryContext(source)});
  const planner=model||createDiagnosticModel({memoryFor:currentMemory,provider:modelProvider,withMemory,env});
  const execute=query||createQueryExecutor({client});
  let closing=false;
  let mutating=false;
  async function mutation(invoke){
    if(mutating)throw error('DISCOVERY_BUSY');
    mutating=true;try{return await invoke();}finally{mutating=false;}
  }
  let executorReady=Boolean(query);
  if(!query){try{const t=await client.initialize();executorReady=['prompt_analysis','execute_raw_sql'].every(n=>t.some(x=>x.name===n));}catch{executorReady=false;}}
  const currentConfig=()=>loadDiagnosticConfig(configPath,checkoutRoot);
  async function memoryEvidenceAllowed(run,source){
    if(!run.memorySnapshot?.selected?.length)return true;
    const context=await memoryContext(source);
    return run.memorySnapshot.selected.every(record=>record.sourceRefs.every(ref=>context.allowedSourceIds.includes(ref.sourceId)&&context.sourceVersions[ref.sourceId]===ref.version&&context.sourceHashes?.[ref.sourceId]===ref.hash));
  }
  async function permitted(run,source){
    const cfg=await currentConfig();
    if(cfg.storeDirectory!==config.storeDirectory)throw error('SOURCE_POLICY_CHANGED');
    const fresh=cfg.sources.find(s=>s.id===run.sourceId);
    return Boolean(fresh&&hash(fresh)===run.sourceHash&&hash(source)===run.sourceHash&&await authorize(run,fresh)&&await memoryEvidenceAllowed(run,fresh));
  }
  const hidden=run=>({id:run.id,status:'SUPPRESSED',createdAt:run.createdAt,updatedAt:run.updatedAt,question:'来源设置已变更，任务内容已隐藏。',rounds:[],report:null});
  async function visible(run){
    const s=(await currentConfig()).sources.find(s=>s.id===run.sourceId);
    try{
      if(!s||!await permitted(run,s))return hidden(run);
      return {...diagnosticRunView(run,s),canResume:reviewBlockedBeforeDispatch(run)};
    }catch{return hidden(run);}
  }
  const checkpoint=run=>store.save(run);
  async function start(run){
    if(closing||jobs.size)throw error('DISCOVERY_BUSY');
    const controller=new AbortController();
    const item={controller,promise:null}; jobs.set(run.id,item);
    item.promise=(async()=>{
      const source=(await currentConfig()).sources.find(s=>s.id===run.sourceId);
      if(!source)throw error('SOURCE_POLICY_CHANGED');
      await runDiagnostic({run,source,signal:controller.signal,dependencies:{plan:a=>planner.plan({...a,signal:controller.signal}),review:a=>planner.review({...a,signal:controller.signal}),queryPreflight:execute.preflight,query:executorReady?execute:async()=>{throw error('EXECUTOR_UNAVAILABLE');},checkpoint,authorize:permitted,
        reserveModel:({run,stage,round})=>budget.reserve({runId:run.id,stage:`${stage}:${round}`,upperBoundCny:estimateModelReservation({rates:planner.provider?{inputCnyPerMillion:planner.provider.inputRate,outputCnyPerMillion:planner.provider.outputRate}:undefined})}),
        settleModel:input=>budget.settle({...input,rates:planner.provider?{inputCnyPerMillion:planner.provider.inputRate,outputCnyPerMillion:planner.provider.outputRate}:undefined})}});
    })().catch(async e=>{
      const latest=await store.get(run.id);
      if(!latest)return;
      // An interrupted query may have executed. No automatic retry on restart.
      latest.status=latest.inflight?'UNKNOWN_EXECUTION':e.code==='SOURCE_POLICY_CHANGED'?'SUPPRESSED':'FAILED';
      latest.error={code:e.code==='CHECKPOINT_FAILED'?'CHECKPOINT_FAILED':'DISCOVERY_FAILED'};
      await store.save(latest);
    }).finally(()=>jobs.delete(run.id));
  }
  const inputText=(v,max)=>typeof v==='string'&&v.trim().length&&v.length<=max?v.trim():null;
  return {
    async list(){
      const cfg=await currentConfig();const rows=[];
      for(const run of await store.list())rows.push(summary(await visible(run)));
      return {configured:true,agent:await loadDiagnosticAgent(agentPath),sources:cfg.sources.map(publicSource),runs:rows,budget:{estimatedMaxCny:8,maxRounds:3,maxQueries:3,...await budget.snapshot()},capabilities:{modelReady:Boolean(model||env.DEEPSEEK_API_KEY),modelConnection:model||env.DEEPSEEK_API_KEY?'CONFIGURED_NOT_VERIFIED':'NOT_CONFIGURED',executorReady}};
    },
    async get(id){const run=await store.get(id);if(!run)throw error('DISCOVERY_NOT_FOUND');return {run:await visible(run)};},
    async memoryList(){
      const cfg=await currentConfig();const contexts=await Promise.all(cfg.sources.map(memoryContext));
      const authorized=new Set(contexts.flatMap(context=>context.allowedSourceIds));
      const versions=Object.assign({},...contexts.map(context=>context.sourceVersions));
      const hashes=Object.assign({},...contexts.map(context=>context.sourceHashes));
      const records=(await memoryStore.list()).filter(record=>record.sourceRefs.every(ref=>authorized.has(ref.sourceId)&&versions[ref.sourceId]===ref.version&&hashes[ref.sourceId]===ref.hash));
      const runs=[];
      for(const item of await store.list()){const run=await visible(item);if(run.status!=='SUPPRESSED')runs.push({id:run.id,question:run.question,status:run.status,memorySnapshot:run.memorySnapshot,usage:{receipts:run.usage?.receipts||[]}});}
      return {records,runs,scope:'PRIVATE_DIAGNOSTIC_REFERENCE_MEMORY',globalCodexMemoryChanged:false};
    },
    async memoryAction(input){return mutation(async()=>{
      if(!input||Object.keys(input).some(key=>!['id','action'].includes(key))||!['confirm','disable'].includes(input.action))throw error('INVALID_DISCOVERY_REQUEST');
      if(!(await this.memoryList()).records.some(record=>record.id===input.id))throw error('SOURCE_POLICY_CHANGED');
      const record=await memoryStore.action(input.id,input.action,{actor:'local-user',note:input.action==='confirm'?'用户在项目记忆面板确认。':'用户在项目记忆面板停用。'});
      return {record};
    });},
    async create(input){return mutation(async()=>{
      if(closing||jobs.size)throw error('DISCOVERY_BUSY');
      if(!input||Object.keys(input).some(k=>!['question','sourceId','trigger','facts','knowledgeMarkdown','boardId','snapshotId','historyTicketId'].includes(k)))throw error('INVALID_DISCOVERY_REQUEST');
      const question=inputText(input.question,3000),facts=input.facts===undefined||input.facts===''?'':inputText(input.facts,8000);
      if(!question||facts===null||input.trigger!=='manual')throw error('INVALID_DISCOVERY_REQUEST');
      const knowledge=createKnowledgeSnapshot(input.knowledgeMarkdown);
      const source=(await currentConfig()).sources.find(s=>s.id===input.sourceId);
      if(!source)throw error('INVALID_DISCOVERY_REQUEST');
      for(const key of ['boardId','snapshotId','historyTicketId'])if(input[key]!==undefined&&!inputText(input[key],200))throw error('INVALID_DISCOVERY_REQUEST');
      const questionContext=await resolveQuestionContext({question,sourceId:source.id,boardId:input.boardId,snapshotId:input.snapshotId,historyTicketId:input.historyTicketId});
      if(['boardId','snapshotId','historyTicketId'].some(key=>input[key]!==undefined)&&!questionContext)throw error('QUESTION_CONTEXT_UNRESOLVED');
      const businessContext=await contextFor(questionContext?.enrichedQuery||question);
      const agentSnapshot=await loadDiagnosticAgent(agentPath);
      const route=classifyDiagnosticQuestion(question,source);
      const memorySnapshot=selectMemorySnapshot({records:withMemory?await memoryStore.list():[],question:questionContext?.enrichedQuery||question,source,cutoff:new Date().toISOString(),...await memoryContext(source)});
      const fullLimits={maxRounds:3,maxQueries:3,maxModelCalls:7,maxRows:2000};
      route.fullLimits=fullLimits;
      const run=await store.create({question,facts,questionContext,modelProvider:planner.provider?{id:planner.provider.id,model:planner.provider.model}:null,memoryEnabled:withMemory,trigger:'manual',sourceId:source.id,sourceHash:hash(source),sourceVersion:source.version,businessContext,agentSnapshot,knowledge,memorySnapshot,route,limits:fullLimits,turnIndex:0});
      if(!await permitted(run,source)){run.status='SUPPRESSED';await store.save(run);return {run:hidden(run)};}
      // Dispatch is local and durable. Do not keep the HTTP request open for SQL.
      try{await start(run);}catch(e){run.status='FAILED';run.error={code:'DISPATCH_FAILED'};await store.save(run);throw e;}return {run};
    });},
    async action(input){return mutation(async()=>{
      if(!input||Object.keys(input).some(k=>!['id','action','facts'].includes(k)))throw error('INVALID_DISCOVERY_REQUEST');
      let run=await store.get(input.id);if(!run)throw error('DISCOVERY_NOT_FOUND');
      if(input.action==='cancel'){
        const job=jobs.get(input.id);if(job){job.controller.abort();await job.promise;}
        run=await store.get(input.id);
        // Preserve uncertainty if cancellation occurred during an external call.
        run.status=run.inflight?'UNKNOWN_EXECUTION':'CANCELLED';await store.save(run);return {run:await visible(run)};
      }
      const preflightRecovery=reviewBlockedBeforeDispatch(run);
      if(input.action!=='resume'||jobs.size||(!resumable.has(run.status)&&!preflightRecovery)||run.inflight||!inputText(input.facts,8000))throw error('INVALID_DISCOVERY_REQUEST');
      const source=(await currentConfig()).sources.find(s=>s.id===run.sourceId);
      if(!source||!await permitted(run,source))throw error('SOURCE_POLICY_CHANGED');
      // Adding facts cannot reset paid-call/query limits or broaden source scope.
      run.facts=(run.facts+'\n'+input.facts).trim();if(run.facts.length>12000)throw error('INVALID_DISCOVERY_REQUEST');
      if(preflightRecovery){
        // This error is raised locally before fetch. Release only that unused
        // reservation, retain all receipts and reuse the verified query result.
        run.usage.modelCalls--;run.rounds.at(-1).status='QUERIED';
        run.recovery={reason:'MODEL_CONTEXT_LIMIT_BEFORE_DISPATCH',recoveredAt:new Date().toISOString()};
      }
      if(['NEEDS_HUMAN','NEEDS_DEFINITION','PAUSED_LIMIT'].includes(run.status)){
        const last=run.rounds?.at(-1);
        if(last?.result?.status==='VERIFIED'&&last.status==='REVIEWED'){
          last.reviewHistory=[...(last.reviewHistory||[]),last.review];delete last.review;last.status='QUERIED';
        }
      }
      run.turnIndex=(run.turnIndex||0)+1;run.status='QUEUED';delete run.error;
      await store.save(run);await start(run);return {run};
    });},
    async close(){closing=true;for(const j of jobs.values())j.controller.abort();await Promise.allSettled([...jobs.values()].map(j=>j.promise));await memoryStore.close();await store.close();},
  };
}
