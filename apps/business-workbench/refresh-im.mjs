// Explicit invocation only. Credentials come from environment, never from config/output.
import {readFile,stat,writeFile} from 'node:fs/promises';
import {createWpsAdapter} from './wps-im-adapter.mjs';
import {refreshSources} from './source-refresh.mjs';
import {createJsonModelCall,createSourceJudge,createMetadataJudge} from './refresh-judges.mjs';
import {DEFAULT_TEXT_MODEL,DEFAULT_VISION_MODEL} from './model-route.mjs';
import {createWorklineDiscoverer} from './workline-discovery.mjs';
import {dirname,join} from 'node:path';
import{refreshAllContext}from'./refresh-all-context.mjs';
const [configPath,output]=process.argv.slice(2);if(!configPath||!output)throw Error('Usage: configure credentials in environment; node refresh-im.mjs private-config.json private-output-dir');
try{await stat(output);throw Error('OUTPUT_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
const config=JSON.parse(await readFile(configPath,'utf8'));if(!process.env.WPS_SID)throw Error('NAMED_CREDENTIALS_REQUIRED');
const adapter=createWpsAdapter({sid:process.env.WPS_SID});
const transport=process.env.DEEPSEEK_API_KEY?createJsonModelCall({apiKey:process.env.DEEPSEEK_API_KEY,model:config.textModel||DEFAULT_TEXT_MODEL}):null;
const metadataJudge=transport?createMetadataJudge({modelCall:transport?.call,model:config.textModel||DEFAULT_TEXT_MODEL}):undefined;
const judge=transport?createSourceJudge({modelCall:transport?.call,ownerId:config.ownerId,model:config.textModel||DEFAULT_TEXT_MODEL}):undefined;
const worklineStorePath=config.worklineStorePath||join(dirname(config.policyPath),'workline-discovery.json');
let worklineContext=config.worklineContext||[];
if(!worklineContext.length&&config.previousDashboard){
 const data=JSON.parse(await readFile(join(config.previousDashboard,'answer-cards.json'),'utf8'));
 worklineContext=(data.cases||[]).map(c=>({title:c.title,summary:c.runs?.find(r=>r.answer)?.answer.summary,summaryAsOf:c.as_of,scope:c.scope}));
}
const discover=createWorklineDiscoverer({storePath:worklineStorePath,model:config.textModel||DEFAULT_TEXT_MODEL,modelCall:input=>transport.call({...input,max_tokens:6000,stage:'workline_discovery'})});
const discoverWorklines=async input=>{
 const result=await discover({...input,worklineContext,context:{ownerId:config.ownerId,...(config.ownerName?{ownerName:config.ownerName}:{})}});
 // The evidence store stays private; the run handoff needs decisions, not duplicate raw history.
 return {status:result.receipt.status,expandedWorklines:result.expandedWorklines,anchors:result.anchors,candidates:result.candidates,receipt:result.receipt,storePath:worklineStorePath};
};
config.modelRoute=`${config.textModel||DEFAULT_TEXT_MODEL} text + ${DEFAULT_VISION_MODEL} vision + Codex verification`;
try{
 const result=await refreshSources({policyPath:config.policyPath,config,output,adapter,judge,metadataJudge,discoverWorklines:transport?discoverWorklines:undefined,limits:config.limits});
 if(config.contextRefresh?.enabled){const contextReceipt=await refreshAllContext(configPath);await writeFile(join(output,'context-refresh-receipt.json'),JSON.stringify(contextReceipt,null,2),{mode:0o600});}
 console.log(JSON.stringify({status:result.status,metadata:result.metadataCount,previews:result.selectedCount,evidence:result.evidenceCount,calls:transport?.usage.calls||0,output,worklineStorePath}));
}finally{
 await writeFile(join(output,'model-usage.json'),JSON.stringify({...(transport?.usage||{calls:0,successfulCalls:0,requests:[]}),requestedModel:config.textModel||DEFAULT_TEXT_MODEL,visionModel:DEFAULT_VISION_MODEL},null,2),{mode:0o600});
}
