import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startWorkbenchServer,parseArgs} from '../server.mjs';

test('workline display omits raw evidence and hides candidates affected by a current prohibition',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'workline-api-'));
 let server;
 try{
  const worklinesPath=join(dir,'worklines.json'),attentionPath=join(dir,'attention.json');
  const candidate=(id,sourceId)=>({id,title:'新工作',objective:'持续业务目标',reason:'明确交付',evidenceRefs:[{sourceId,messageId:'m1',occurredAt:'2026-10-14T08:00:00Z'}]});
  await writeFile(worklinesPath,JSON.stringify({version:'workline-discovery-v2',candidates:[candidate('allowed','a'),candidate('blocked','b'),{...candidate('context-blocked','a'),inputSourceIds:['a','b']},{...candidate('history-blocked','a'),history:[{evidenceRefs:[{sourceId:'b'}]}]}],evidence:[{text:'private raw payload'}],lastReceipt:{associations:[]}}));
  await writeFile(attentionPath,JSON.stringify({version:1,sources:[{id:'b',status:'excluded',tier:'on_match',matchedWorklines:[]}]}));
  server=await startWorkbenchServer({port:0,worklinesPath,attentionPath});
  const url=`http://127.0.0.1:${server.address().port}/api/worklines`;
  const body=await(await fetch(url)).json();
  assert.deepEqual(body.candidates.map(c=>c.id),['allowed']);assert.equal(body.candidates[0].sourceCount,1);assert.equal(JSON.stringify(body).includes('private raw payload'),false);
  assert.equal((await fetch(url,{method:'POST'})).status,405);
  assert.deepEqual(parseArgs(['--worklines',worklinesPath]),{port:4595,worklinesPath});
 }finally{if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true});}
});
