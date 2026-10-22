// Refresh collectors must filter their configured identities before requesting messages.
import {readFile} from 'node:fs/promises';
import {loadAttention,readPlan} from './source-attention.mjs';
export async function filterReadConfig(config,path){const store=await loadAttention(path);const ids=new Set(readPlan(store).map(s=>s.sourceKey));return {...config,sources:config.sources.filter(s=>ids.has(s.source_key))};}
if(process.argv[1]?.endsWith('/source-read-plan.mjs')){const [policy,config]=process.argv.slice(2);if(!policy||!config)throw Error('需要来源策略与读取配置文件');console.log(JSON.stringify(await filterReadConfig(JSON.parse(await readFile(config,'utf8')),policy),null,2));}
