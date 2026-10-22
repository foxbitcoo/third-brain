// Unified follow-up for the existing source refresh. All configuration and output are private.
import{readFile,writeFile,mkdir,rename}from'node:fs/promises';
import{spawn}from'node:child_process';
import{dirname,resolve}from'node:path';import{fileURLToPath,pathToFileURL}from'node:url';
import{loadAttention,readPlan}from'./source-attention.mjs';
import{namedCredential}from'./diagnostic-adapters.mjs';
import{ingestContext}from'./ingest-context.mjs';
import{documentEvidenceAllowed}from'./document-intake.mjs';
import{createDiagnosticBudget}from'./diagnostic-budget.mjs';
import{randomUUID}from'node:crypto';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
export async function refreshAllContext(configPath){
 const config=await read(configPath),settings=config.contextRefresh;
 if(!settings?.enabled)throw Error('CONTEXT_REFRESH_NOT_CONFIGURED');
 const attention=await loadAttention(config.policyPath),plan=new Set(readPlan(attention).map(s=>s.sourceKey));
 const mapping=new Map(config.sources.map(s=>[s.source_key,s.chat_id]));
 const [policy,manifest]=await Promise.all([read(config.documentPolicyPath),read(config.documentManifestPath)]);
 const output=resolve(settings.outputPath);await mkdir(output,{recursive:true,mode:0o700});
 const active=new Set(policy.documents.filter(d=>documentEvidenceAllowed({source_type:'document',document_id:d.documentId},policy,{parentAllowedSourceIds:[...plan],excludedSourceIds:attention.sources.filter(s=>s.status==='excluded').map(s=>s.id)})).map(d=>d.documentId));
 const documents=manifest.filter(d=>active.has(d.documentId)).map(d=>({id:d.documentId,title:d.title,allowed:true,
  kind:/日会|会议|纪要/.test(d.title)?'meeting':/周报|日报/.test(d.title)?'report':'document'}));
 documents.sort((a,b)=>Number(b.kind==='report')-Number(a.kind==='report'));
 const baselineDocuments=manifest.map(d=>({id:d.documentId,title:d.title,sourceVersion:d.sourceVersion,sourceModifiedAt:d.sourceModifiedAt,
  contentHash:d.contentHash,mediaChecked:false,mediaDeferred:!(/周报|日报|日会/.test(d.title)&&!(/存档|[1-9]月/.test(d.title)))}));
 const now=new Date(),start=new Date(now.getTime()-7*86400000),end=new Date(now.getTime()+7*86400000);
 const input={calendarId:settings.calendarId,ownerId:config.ownerId,start:start.toISOString(),end:end.toISOString(),
  attentionPath:config.policyPath,documentPolicyPath:config.documentPolicyPath,documents,baselineDocuments,
  maxImages:settings.maxImages??12,maxImagesPerDocument:4,maxPeerResolutions:8,vision:settings.vision||{enabled:false},
  imSources:attention.sources.filter(s=>plan.has(s.id)).map(s=>({sourceId:s.id,chatId:s.chatId||mapping.get(s.id),title:s.name,
   start:s.lastReadThrough||config.lastIMCollectionCutoff||config.lastPublishedInputCutoff})).filter(s=>s.chatId)};
 let previous={};try{previous=await read(resolve(output,'data/context.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const oldResponses=new Set((previous.documents||[]).flatMap(d=>(d.images||[]).map(i=>i.extraction?.responseId)).filter(Boolean));
 let budget,reservation;
 if(input.vision.enabled){
  if(settings.sharedBudgetDirectory){
   budget=await createDiagnosticBudget({directory:settings.sharedBudgetDirectory,dailyLimitCny:10});
   reservation=await budget.reserve({runId:'context-'+randomUUID(),stage:'context-images',upperBoundCny:Math.min(2,input.vision.maxCny??2)});
  }
  if(!reservation?.allowed)input.vision={...input.vision,enabled:false};
 }
 const selectedConfig=resolve(output,'config.private.json');await writeFile(selectedConfig,JSON.stringify(input,null,2),{mode:0o600});
 const env={...process.env,WPS_SID:process.env.WPS_SID||await namedCredential('金山Sid','sid')};
 if(input.vision.enabled)env[settings.vision.keyEnv]=process.env[settings.vision.keyEnv]||await namedCredential(settings.visionCredentialPlatform,settings.visionCredentialField||'api_key');
 const script=resolve(dirname(fileURLToPath(import.meta.url)),'../../scripts/refresh-context.py');
 const code=await new Promise((accept,reject)=>{const child=spawn('python3',[script,'--config',selectedConfig,'--output',resolve(output,'data')],{env,stdio:'ignore'});child.once('error',reject);child.once('exit',accept);});
 if(code!==0){if(reservation?.allowed)await budget.settle({reservationId:reservation.reservation.id});throw Error('CONTEXT_COLLECTION_FAILED');}
 const collected=await read(resolve(output,'data/context.json'));
 if(reservation?.allowed){
  const responses=new Map(collected.documents.flatMap(d=>d.images||[]).map(i=>i.extraction).filter(e=>e?.responseId&&!oldResponses.has(e.responseId)).map(e=>[e.responseId,e]));
  const calls=collected.modelCost.day===previous.modelCost?.day?collected.modelCost.calls-(previous.modelCost?.calls||0):collected.modelCost.calls;
  const known=[...responses.values()].every(e=>Number.isInteger(e.usage?.prompt_tokens)&&Number.isInteger(e.usage?.completion_tokens));
  await budget.settle({reservationId:reservation.reservation.id,notDispatched:calls===0,
   ...(calls===responses.size&&known?{promptTokens:[...responses.values()].reduce((s,e)=>s+e.usage.prompt_tokens,0),completionTokens:[...responses.values()].reduce((s,e)=>s+e.usage.completion_tokens,0)}:{}),
   rates:{inputCnyPerMillion:input.vision.inputCnyPerMillion,outputCnyPerMillion:input.vision.outputCnyPerMillion}});
 }
 const integrationConfig=resolve(output,'integration.private.json');
 await writeFile(integrationConfig,JSON.stringify({policyPath:config.policyPath,documentPolicyPath:config.documentPolicyPath,historyIndexPath:config.historyIndexPath,
  datasetPath:resolve(config.previousDashboard,'answer-cards.json')},null,2),{mode:0o600});
 const receipt=await ingestContext(integrationConfig,resolve(output,'data/context.json'));
 await writeFile(resolve(output,'integration-receipt.private.json'),JSON.stringify(receipt,null,2),{mode:0o600});
 return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await refreshAllContext(process.argv[2])));
