// Daily candidate discovery; metadata screening never grants listening admission.
import {createJsonModelCall,createMetadataJudge} from './refresh-judges.mjs';
import {readFile,stat} from 'node:fs/promises';
import {createWpsAdapter} from './wps-im-adapter.mjs';
import {discoverGroupKeywords,saveGroupDiscovery} from './group-keyword-discovery.mjs';
const [configPath,output,flag,clock]=process.argv.slice(2);if(!configPath||!output||flag&&flag!=='--now')throw Error('Usage: configure credentials in environment; node discover-groups.mjs private-config.json new-output-dir [--now ISO]');
try{await stat(output);throw Error('OUTPUT_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
const config=JSON.parse(await readFile(configPath,'utf8')),now=clock||new Date(Math.floor(Date.now()/1000)*1000).toISOString();if(!Number.isFinite(Date.parse(now)))throw Error('INVALID_NOW');
const transport=process.env.DEEPSEEK_API_KEY?createJsonModelCall({apiKey:process.env.DEEPSEEK_API_KEY,model:config.textModel}):null;
const metadataJudge=transport?createMetadataJudge({modelCall:transport.call,model:config.textModel}):undefined;
const receipt=await discoverGroupKeywords({policyPath:config.policyPath,config,metadataJudge,adapter:createWpsAdapter({sid:process.env.WPS_SID}),now});await saveGroupDiscovery(output,receipt,config.policyPath);console.log(JSON.stringify({status:receipt.status,metadata:receipt.metadataCount,hits:receipt.hits.length,pendingJobs:receipt.pendingJobs,output,modelCalls:transport?.usage.calls||0}));
