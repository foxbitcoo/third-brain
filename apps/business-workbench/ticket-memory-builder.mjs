import {MEMORY_PATTERN_VERSION,MEMORY_DIRECTIONS,memoryDirection} from './memory-pattern.mjs';
import {readFile,writeFile,realpath,stat,mkdir,open,unlink,rename} from 'node:fs/promises';
import {dirname,relative,isAbsolute,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {prepareTicketSession} from './memory-session.mjs';
import {historicalScopeIds,projectHistoricalTickets} from './historical-tickets.mjs';
import {isTrustedListeningSource} from './source-attention.mjs';
import {blockedLocatorConfiguration} from './live-qa.mjs';
import {namedCredential} from './diagnostic-adapters.mjs';
import {createDiagnosticBudget,estimateModelReservation} from './diagnostic-budget.mjs';
import {MULTIMODAL_MEMORY_SYSTEM,multimodalMemoryRequest,memoryImageBytes} from './memory-multimodal.mjs';
import {compactMemory,playbookHash} from './memory-playbook.mjs';

const MODEL='deepseek-flash',ENDPOINT='https://api.deepseek.com/chat/completions';
const RATES={inputCnyPerMillion:9,outputCnyPerMillion:30}; // Conservative ceiling, not a quoted account price.
const MEMORY_SCHEMA={patternVersion:MEMORY_PATTERN_VERSION,memories:[{directionId:'S1|S2|S3|OTHER',relation:'PERIODIC|SAME_DIRECTION|UPSTREAM_DOWNSTREAM',cadence:'月度/季度/按需',useWhen:[],title:'',typicalQuestion:'',methodBasis:'DISCUSSION_ONLY',inputs:[],steps:[{action:'',why:'',evidenceIds:[]}],outputs:[],boundaries:[],imageEvidenceIds:[],datedFacts:[{statement:'',evidenceIds:[]}]}],uncertainties:[]};
const SYSTEM=MULTIMODAL_MEMORY_SYSTEM.slice(0,MULTIMODAL_MEMORY_SYSTEM.indexOf('输出JSON：'))+' 严格按七段整理：【原文】由输入证据原样保留，不要重写；【问题模式】typicalQuestion概括成一句；【下次如何回答】steps保留最多4步具体查数/分析顺序；【交付清单】outputs；【适用条件】useWhen；【不能直接套用】boundaries，仅写不适用条件和禁止沿用的历史结论；【仍需当前资料】inputs和uncertainties，明确本期数据、周期、口径和缺失材料。不要把缺失资料混进不适用条件。每个列表尽量2—4条、避免过程说明和工程术语。方向从'+JSON.stringify(MEMORY_DIRECTIONS.map(({id,label})=>({id,label})))+'中选择；同方向的月度/季度及上下游问题可以复用方法，但不复用数值或通过阈值。原始资料只支持讨论建议时明确写成待查步骤，不声称执行过。通过程序检查的记忆自动生效，无需人工逐条确认。最多产出1条方法。没有可复用分析步骤时输出memories=[]并说明原因；不要把单纯提问扩写成已经执行的方法。typicalQuestion必须用变量描述可重复问题，不带当期数值；methodBasis必须为REPLY_EVIDENCE（有历史答复支持）或DISCUSSION_ONLY（仅讨论建议）。每一步必须输出why与evidenceIds。严格输出JSON对象并包含所有以下字段，不得遗漏typicalQuestion、methodBasis：'+JSON.stringify(MEMORY_SCHEMA);
const fail=code=>Object.assign(new Error(code),{code});
const within=(root,path)=>{const r=relative(root,path);return !r||r!=='..'&&!r.startsWith('../')&&!isAbsolute(r);};
async function privateJson(path,checkoutRoot,max=16*1024*1024){
 if(!isAbsolute(path||''))throw fail('MEMORY_CONFIG_INVALID');
 const actual=await realpath(path),root=await realpath(checkoutRoot),info=await stat(actual);
 if(within(root,actual)||!info.isFile()||info.size>max)throw fail('MEMORY_PRIVATE_PATH_INVALID');
 return JSON.parse(await readFile(actual,'utf8'));
}
async function writeAtomic(path,value){const temporary=path+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});try{await rename(temporary,path);}catch(error){await unlink(temporary).catch(()=>{});throw error;}}

export async function loadMemoryBuildInputs(configPath,checkoutRoot){
 const config=await privateJson(configPath,checkoutRoot,65536);
 if(config.version!=='deepseek-ticket-memory/v1'||config.model!==MODEL||config.endpoint!==ENDPOINT||!isAbsolute(config.outputPath||'')||!isAbsolute(config.workDirectory||''))throw fail('MEMORY_CONFIG_INVALID');
 const paths=['ticketsPath','scopePath','attentionPath','messagesPath','originalsPath','mediaPath','seedPath','budgetDirectory'];
 if(paths.some(key=>!isAbsolute(config[key]||''))||paths.some(key=>config[key]===config.outputPath)||within(await realpath(checkoutRoot),await realpath(dirname(config.outputPath)))||dirname(config.outputPath)!==config.workDirectory)throw fail('MEMORY_CONFIG_INVALID');
 const [history,scope,attention,graph,originals,media,seeds]=await Promise.all(paths.slice(0,7).map(key=>privateJson(config[key],checkoutRoot)));
 const scopeIds=historicalScopeIds(scope,{startAt:history.window.startAt??history.window.start,endAt:history.window.endAt??history.window.end});
 const sourceRefs=new Map(Object.entries(scope.sourceRefs)),excludedSourceIds=new Set(attention.sources.filter(s=>s.status==='excluded').map(s=>s.id));
 for(const source of attention.sources)if(sourceRefs.has(source.id)&&sourceRefs.get(source.id)!==String(source.chatId||''))excludedSourceIds.add(source.id);
 const listening=new Set(attention.sources.filter(isTrustedListeningSource).map(s=>s.id));
 const policy={allowedSourceIds:new Set([...scopeIds,...listening]),excludedSourceIds,sourceRefs,blockedLocatorHashes:new Set(blockedLocatorConfiguration())};
 const tickets=projectHistoricalTickets(history,{...policy,scopeIds}).tickets;
 return {config,history,scope,policy,tickets,messages:graph.messages,originals:originals.messages,media,seedRecords:seeds.records};
}

export function validateBuiltMemory(result,session,imageInputs){
 const issues=result?.patternVersion===MEMORY_PATTERN_VERSION?[]:['INVALID_PATTERN_VERSION'],ids=new Set(session.packet.evidence.map(e=>e.id)),imageIds=new Set(imageInputs.map(i=>i.id));
 if(!Array.isArray(result?.memories)||result.memories.length>1)return ['INVALID_MEMORY_ARRAY'];
 for(const memory of result.memories){
  if(result.patternVersion===MEMORY_PATTERN_VERSION&&(!MEMORY_DIRECTIONS.some(d=>d.id===memory.directionId)||!Array.isArray(memory.useWhen)||!memory.useWhen.length||memory.useWhen.some(v=>typeof v!=='string'||!v.trim())||!['PERIODIC','SAME_DIRECTION','UPSTREAM_DOWNSTREAM'].includes(memory.relation)||typeof memory.cadence!=='string'||!memory.cadence.trim()))issues.push('INVALID_PATTERN');
  if(typeof memory.title!=='string'||!memory.title.trim()||typeof memory.typicalQuestion!=='string'||!memory.typicalQuestion.trim()||!['REPLY_EVIDENCE','DISCUSSION_ONLY'].includes(memory.methodBasis))issues.push('INVALID_MEMORY');
  for(const field of ['inputs','outputs','boundaries'])if(!Array.isArray(memory[field])||!memory[field].length||memory[field].some(s=>typeof s!=='string'||!s.trim()))issues.push('INVALID_'+field.toUpperCase());
  if(!Array.isArray(memory.steps)||!memory.steps.length||memory.steps.length>4)issues.push('INVALID_STEPS');
  for(const step of memory.steps||[]){if(typeof step.action!=='string'||!step.action.trim()||typeof step.why!=='string'||!step.why.trim())issues.push('EMPTY_STEP');if(!step.evidenceIds?.length||!step.evidenceIds.every(id=>ids.has(id)||imageIds.has(id)))issues.push('INVALID_EVIDENCE');}
  if(!Array.isArray(memory.imageEvidenceIds)||memory.imageEvidenceIds.some(id=>!imageIds.has(id)))issues.push('INVALID_IMAGE_EVIDENCE');
  for(const fact of memory.datedFacts||[])if(typeof fact.statement!=='string'||!fact.evidenceIds?.length||!fact.evidenceIds.every(id=>ids.has(id)||imageIds.has(id)))issues.push('INVALID_DATED_FACT');
 }
 return [...new Set(issues)];
}

export function createTicketMemoryBuilder({configPath,checkoutRoot,fetchImpl=fetch,env=process.env,credential=()=>namedCredential('DeepSeek','api_key',env)}){
 let active=false;
 async function prepare(ticketId){
  const inputs=await loadMemoryBuildInputs(configPath,checkoutRoot),ticket=inputs.history.tickets.find(t=>t.id===ticketId);
  if(!ticket||!inputs.tickets.some(t=>t.id===ticketId))throw fail('MEMORY_SOURCE_NOT_ALLOWED');
  const session=prepareTicketSession({ticket,messages:inputs.messages,originals:inputs.originals,media:inputs.media,seedRecords:inputs.seedRecords,policy:inputs.policy,window:inputs.scope});
  const images=[],imageFailures=[];
  for(const image of session.attachments){try{await memoryImageBytes(image,checkoutRoot);images.push(image);}catch{imageFailures.push(image.id);session.imageCoverage.push({id:image.id,messageId:image.messageId,at:image.at,reason:'IMAGE_READ_FAILED'});}}
  session.imageCoverage.push(...images.slice(2).map(({id,messageId,at})=>({id,messageId,at,reason:'PER_TICKET_IMAGE_LIMIT'})));
  session.attachments=images;session.coverage.availableImages=images.length;session.coverage.imageReadFailures=imageFailures.length;
  const selected=images.slice(0,2),request=selected.length?await multimodalMemoryRequest({packet:session.packet,images:selected,model:MODEL,checkoutRoot,...inputs.policy,evidenceBindings:session.bindings,window:inputs.scope,visionSupported:true}):{model:MODEL,messages:[{role:'system',content:SYSTEM},{role:'user',content:JSON.stringify({packet:session.packet})}],max_tokens:2400,temperature:0,thinking:{type:'disabled'},response_format:{type:'json_object'}};
  request.messages[0].content=SYSTEM;request.max_tokens=2400;
  const inputHash=playbookHash({request,bindings:session.bindings,coverage:session.coverage});
  return {...inputs,ticket,session,selected,request,inputHash};
 }
 async function readStore(config){try{return await privateJson(config.outputPath,checkoutRoot);}catch(error){if(error.code==='ENOENT')return {schemaVersion:'memory-playbooks-v1',records:[],cases:[],builds:{},defaultModel:MODEL};throw error;}}
 return {
  get active(){return active;},
  async build(ticketId){
   if(active)throw fail('MEMORY_BUILD_BUSY');active=true;let lock,lockPath;
   try{
    const first=await prepare(ticketId),{config,session,selected,request,inputHash}=first;
    await mkdir(config.workDirectory,{recursive:true,mode:0o700});lockPath=join(config.workDirectory,'.build.lock');lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,owner:'ticket-memory-builder',ticketId}));
    const store=await readStore(config),previous=store.builds?.[ticketId];
    if(previous?.inputHash===inputHash&&['COMPLETE','NO_REUSABLE_MEMORY'].includes(previous.status)){Object.assign(previous,{imageCoverage:session.imageCoverage,coverage:session.coverage});await writeAtomic(config.outputPath,store);return {...previous,reused:true};}
    if(previous?.inputHash===inputHash&&['UNKNOWN_EXECUTION','NEEDS_REVIEW'].includes(previous.status))throw fail('MEMORY_PREVIOUS_CALL_NEEDS_REVIEW');
    const attemptFile=join(config.workDirectory,'attempt-'+inputHash+'.private.json');
    let receipt;try{receipt=await privateJson(attemptFile,checkoutRoot);if(receipt.inputHash!==inputHash||receipt.requestHash!==playbookHash(request))throw fail('MEMORY_ATTEMPT_MISMATCH');if(!['COMPLETE','NO_REUSABLE_MEMORY'].includes(receipt.status))throw fail('MEMORY_PREVIOUS_CALL_NEEDS_REVIEW');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!receipt){
    const reservationId='memory-'+randomUUID(),budget=await createDiagnosticBudget({directory:config.budgetDirectory,dailyLimitCny:10});
    const textBytes=Buffer.byteLength(JSON.stringify(request.messages.filter(m=>m.role==='system')))+Buffer.byteLength(JSON.stringify(session.packet));
    const upper=estimateModelReservation({maxContextBytes:textBytes,maxOutputTokens:2400,framingTokens:2048+selected.length*2048,rates:RATES});
    const reservation=await budget.reserve({reservationId,runId:reservationId,stage:selected.length?'memory-image-extraction':'memory-extraction',upperBoundCny:upper});
    if(!reservation.allowed){store.builds||={};store.builds[ticketId]={ticketId,status:'DEFERRED_BUDGET',reason:reservation.reason,model:MODEL,coverage:session.coverage,at:new Date().toISOString()};await writeAtomic(config.outputPath,store);return store.builds[ticketId];}
    const imageInputs=selected.map(({id,sourceId,sourceRef,messageId,at,sha256})=>({id,sourceId,sourceRef,messageId,at,sha256}));
    const file=join(config.workDirectory,reservationId+'.private.json');
    receipt={reservationId,ticketId,status:'DISPATCHING',inputHash,requestHash:playbookHash(request),model:MODEL,inputMode:selected.length?'TEXT_AND_ORIGINAL_IMAGES':'TEXT_ONLY',imageInputs,imageCoverage:session.imageCoverage,coverage:session.coverage,reservedUpperCny:upper,at:new Date().toISOString()};
    await writeAtomic(file,receipt);await writeAtomic(attemptFile,receipt);let dispatched=false;
    try{
     const key=await credential();const authorized=await prepare(ticketId);if(authorized.inputHash!==inputHash)throw fail('MEMORY_INPUT_CHANGED');dispatched=true;
     const response=await fetchImpl(ENDPOINT,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(90000)});
     const body=await response.json(),usage=body.usage||{};await budget.settle({reservationId,promptTokens:usage.prompt_tokens,completionTokens:usage.completion_tokens,rates:RATES});
     let result;try{result=JSON.parse(body.choices?.[0]?.message?.content);}catch{}
     const issues=validateBuiltMemory(result,session,imageInputs);if(body.model!==MODEL)issues.push('RESPONSE_MODEL_MISMATCH');
     Object.assign(receipt,{status:response.ok&&body.choices?.[0]?.finish_reason==='stop'&&!issues.length?(result.memories.length?'COMPLETE':'NO_REUSABLE_MEMORY'):'NEEDS_REVIEW',httpStatus:response.status,responseModel:body.model,responseId:body.id,finishReason:body.choices?.[0]?.finish_reason,errorCode:body.error?.code||null,usage,result,issues,estimatedCny:Number.isInteger(usage.prompt_tokens)&&Number.isInteger(usage.completion_tokens)?(usage.prompt_tokens*RATES.inputCnyPerMillion+usage.completion_tokens*RATES.outputCnyPerMillion)/1e6:null,priceBasis:'Conservative estimate, not provider bill'});
    }catch{await budget.settle({reservationId,notDispatched:!dispatched});receipt.status=dispatched?'UNKNOWN_EXECUTION':'NOT_DISPATCHED';}
    await writeAtomic(file,receipt);await writeAtomic(attemptFile,receipt);
    }
    // Re-read source controls and exact session/image bytes after provider response.
    const current=await prepare(ticketId);if(current.inputHash!==inputHash)throw fail('MEMORY_INPUT_CHANGED');
    const records=[];
    if(receipt.status==='COMPLETE')for(const memory of receipt.result.memories){
     const candidate={title:memory.title,questionPattern:{typicalQuestion:memory.typicalQuestion,relation:memory.relation,cadence:memory.cadence},answerPlaybook:{steps:memory.steps,outputChecklist:memory.outputs},applicability:{requiredInputs:memory.inputs,useWhen:memory.useWhen,doNotUseWhen:memory.boundaries},datedFacts:memory.datedFacts,uncertainties:receipt.result.uncertainties};
     const record=compactMemory(candidate,{packet:{...session.packet,inputHash,direction:MEMORY_DIRECTIONS.find(d=>d.id===memory.directionId)||memoryDirection({...candidate,question:memory.typicalQuestion})},arm:'deepseek',sourceRefs:session.bindings,attachments:session.attachments,issues:memory.methodBasis==='DISCUSSION_ONLY'?['DISCUSSION_ONLY_NOT_EXECUTED']:[]});
     Object.assign(record,{status:'SOURCE_VERIFIED',model:MODEL,originalEvidence:session.packet.evidence,coverage:session.coverage,activation:{status:'AUTO_ENABLED',enabledAt:new Date().toISOString(),reason:'提取成功后自动用于相关问题；保留原文和适用条件。'},derivation:{...record.derivation,stage:'DEEPSEEK_SESSION_EXTRACTION',newModelExtraction:true,requestHash:receipt.requestHash,responseId:receipt.responseId,inputMode:receipt.inputMode,imageInputs:receipt.imageInputs}});
     records.push(record);
    }
    const latest=await readStore(config);latest.builds||={};latest.builds[ticketId]={ticketId,status:receipt.status,inputHash,model:MODEL,inputMode:receipt.inputMode,imageCount:selected.length,imageCoverage:session.imageCoverage,coverage:session.coverage,estimatedCny:receipt.estimatedCny??null,at:receipt.at,recordCount:records.length,httpStatus:receipt.httpStatus??null,errorCode:receipt.errorCode??null,issues:receipt.issues||[]};
    if(['COMPLETE','NO_REUSABLE_MEMORY'].includes(receipt.status)){
     latest.historyRecords||=[];
     for(const prior of latest.records.filter(r=>r.sourceTicketId===ticketId))if(!latest.historyRecords.some(r=>playbookHash(r)===playbookHash(prior))&&!records.some(r=>playbookHash(r)===playbookHash(prior)))latest.historyRecords.push(prior);
     latest.records=[...latest.records.filter(r=>r.sourceTicketId!==ticketId),...records];
    }
    latest.createdAt=new Date().toISOString();latest.defaultModel=MODEL;latest.stage='LOCAL_DEEPSEEK_AUTO_ENABLED';await writeAtomic(config.outputPath,latest);
    return latest.builds[ticketId];
   }finally{if(lock){await lock.close();await unlink(lockPath);}active=false;}
  }
 };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [configPath,checkoutRoot,...ids]=process.argv.slice(2);if(!checkoutRoot)throw fail('MEMORY_CONFIG_REQUIRED');
 const inputs=await loadMemoryBuildInputs(configPath,checkoutRoot),builder=createTicketMemoryBuilder({configPath,checkoutRoot});
 for(const id of ids.length?ids:inputs.tickets.map(t=>t.id)){
  const result=await builder.build(id);console.log(JSON.stringify(result));
  if(['DEFERRED_BUDGET','UNKNOWN_EXECUTION','NOT_DISPATCHED'].includes(result.status)||result.httpStatus>=400)break;
 }
}
