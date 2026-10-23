import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {startWorkbenchServer} from '../server.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('ticket Memory API applies current exclusion, native binding, dates, and image hashes at every read',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memory-api-'));let server;
 try{
  const history={version:'historical-question-tickets/v1',generatedAt:'2026-10-18T04:00:00Z',window:{startAt:'2026-07-17T16:00:00Z',endAt:'2026-10-18T04:00:00Z'},tickets:[{id:'t',title:'问题',question:'为什么',status:'UNKNOWN',statusReason:'待核对',historical:true,autoExecute:false,sourceIds:['s'],events:[{sourceId:'s',messageId:'m',kind:'question',occurredAt:'2026-08-01T01:00:00Z',quote:'为什么'}]}]};
  const scope={version:'historical-ticket-scope/v1',basis:'USER_REQUEST',...history.window,sourceIds:['s'],sourceRefs:{s:'native-chat'}};
  const path=join(dir,'image.png'),bytes=Buffer.from('89504e470d0a1a0a0000','hex');await writeFile(path,bytes);
  const row={id:'memory',sourceTicketId:'t',requiredSourceIds:['s'],sourceRefs:[{sourceId:'s',sourceRef:'native-chat',messageId:'m',at:'2026-08-01T01:00:00Z'}],attachments:[{id:'image',sourceId:'s',sourceRef:'native-chat',messageId:'m',at:'2026-08-01T01:00:00Z',path,sha256:sha(bytes)}]};
  const attentionPath=join(dir,'attention.json');const attention={version:1,sources:[{id:'s',name:'样例',chatId:'native-chat',kind:'group',tier:'normal',status:'active',manualOverride:false,matchedWorklines:[],evidenceRefs:[],history:[]}]};await writeFile(attentionPath,JSON.stringify(attention));
  const files={attentionPath,historicalTicketsPath:join(dir,'history.json'),historicalTicketScopePath:join(dir,'scope.json'),memoryPlaybooksPath:join(dir,'memory.json')};
  await writeFile(files.historicalTicketsPath,JSON.stringify(history));await writeFile(files.historicalTicketScopePath,JSON.stringify(scope));
  const save=()=>writeFile(files.memoryPlaybooksPath,JSON.stringify({schemaVersion:'memory-playbooks-v1',records:[row]}));await save();
  server=await startWorkbenchServer({port:0,...files});const base='http://127.0.0.1:'+server.address().port;
  let response=await fetch(base+'/api/ticket-memory?ticket=t');assert.equal(response.status,200);let body=await response.json();assert.equal(body.generated.length,1);assert.equal(body.injections.length,0);assert.ok(!JSON.stringify(body).includes(dir));
  assert.equal((await fetch(base+'/api/ticket-memory?ticket=other')).status,404);assert.equal((await fetch(base+'/api/ticket-memory?ticket=t&ticket=other')).status,400);
  assert.equal((await fetch(base+'/api/memory-playbook-image?memory=memory&image=image')).status,200);
  await writeFile(path,Buffer.from('changed'));assert.equal((await fetch(base+'/api/memory-playbook-image?memory=memory&image=image')).status,404);
  attention.sources[0].status='excluded';await writeFile(attentionPath,JSON.stringify(attention));assert.equal((await fetch(base+'/api/ticket-memory?ticket=t')).status,404);assert.equal((await fetch(base+'/api/memory-playbook-image?memory=memory&image=image')).status,404);
  attention.sources[0].status='active';attention.sources[0].chatId='rebound';await writeFile(attentionPath,JSON.stringify(attention));assert.equal((await fetch(base+'/api/ticket-memory?ticket=t')).status,404);
  attention.sources[0].chatId='native-chat';await writeFile(attentionPath,JSON.stringify(attention));
  row.sourceRefs[0].at='2026-06-01T00:00:00Z';await save();body=await(await fetch(base+'/api/ticket-memory?ticket=t')).json();assert.equal(body.generated.length,0);
  row.sourceRefs[0].at='2026-08-01T01:00:00Z';row.sourceRefs[0].messageId='unbound';await save();body=await(await fetch(base+'/api/ticket-memory?ticket=t')).json();assert.equal(body.generated.length,0);
  scope.sourceRefs.s='different-chat';await writeFile(files.historicalTicketScopePath,JSON.stringify(scope));
  // Changing only the grant cannot make an unrelated message become a memory.
  assert.equal((await fetch(base+'/api/ticket-memory?ticket=t')).status,404);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
