import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const exec=promisify(execFile);
const cli=resolve(import.meta.dirname,'../scripts/reparse-question-context.mjs');

test('explicit private repair restores parent and references without touching source or following remote URLs',async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'question-repair-')));t.after(()=>rm(directory,{recursive:true,force:true}));
  const input=join(directory,'raw.json'),output=join(directory,'out.json');
  const original=JSON.stringify({version:'question-context-repair-input/v1',sourceRefs:{'source-a':'chat-a'},messages:[{sourceId:'source-a',raw:{data:{id:'q-a',chat_id:'chat-a',quote_msg_id:'parent-a',content:{text:{content:'[日报](http://example.invalid/report) ![图](http://example.invalid/image)'}}}}}]});
  await writeFile(input,original);
  const result=await exec(process.execPath,[cli,'--input',input,'--output',output]);
  assert.equal(JSON.parse(result.stdout).networkCalls,0);const repaired=JSON.parse(await readFile(output,'utf8'));
  assert.equal(repaired.messages[0].quoteMessageId,'parent-a');assert.equal(repaired.messages[0].images.length,1);assert.equal(repaired.messages[0].links[0].title,'日报');
  assert.equal(await readFile(input,'utf8'),original);assert.doesNotMatch(JSON.stringify(repaired),/http:\/\//);assert.equal((await stat(output)).mode & 0o777,0o600);
  await assert.rejects(exec(process.execPath,[cli,'--input',input,'--output',output]));
});

test('repair rejects source identity changes and checkout output before any write',async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'question-repair-')));t.after(()=>rm(directory,{recursive:true,force:true}));
  const input=join(directory,'raw.json');await writeFile(input,JSON.stringify({version:'question-context-repair-input/v1',sourceRefs:{'source-a':'other-chat'},messages:[{sourceId:'source-a',raw:{id:'q-a',chat_id:'chat-a',content:'问题'}}]}));
  await assert.rejects(exec(process.execPath,[cli,'--input',input,'--output',join(directory,'out.json')]),error=>/REPAIR_SOURCE_BINDING_MISMATCH/.test(error.stderr));
  await assert.rejects(exec(process.execPath,[cli,'--input',input,'--output',resolve(import.meta.dirname,'do-not-create.private.json')]),error=>/REPAIR_REQUIRES_PRIVATE_OUTPUT/.test(error.stderr));
});

test('JSONL scope repair produces a valid separate historical ticket store and retains original event fields',async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'question-repair-')));t.after(()=>rm(directory,{recursive:true,force:true}));
  const raw=join(directory,'messages.jsonl'),scope=join(directory,'scope.json'),tickets=join(directory,'tickets.json'),out=join(directory,'repair.json'),repaired=join(directory,'tickets-repaired.json');
  await writeFile(scope,JSON.stringify({sourceRefs:{'source-a':'chat-a'}}));
  await writeFile(raw,JSON.stringify({id:'q-a',chat_id:'chat-a',quote_msg_id:'p-a',content:{text:{content:'问题 ![图](http://example.invalid/image) [日报](https://example.invalid/report)'}}})+'\n');
  const sourceStore={version:'historical-question-tickets/v1',generatedAt:'2026-10-18T04:00:00Z',window:{startAt:'2026-10-17T00:00:00Z',endAt:'2026-10-18T04:00:00Z'},tickets:[{id:'ticket-a',status:'UNKNOWN',title:'样例问题',question:'问题',statusReason:'待核验',historical:true,autoExecute:false,sourceIds:['source-a'],events:[{sourceId:'source-a',messageId:'q-a',occurredAt:'2026-10-17T01:00:00Z',kind:'question',quote:'保留原问题',custom:'preserve-me'}]}]};
  await writeFile(tickets,JSON.stringify(sourceStore));
  await exec(process.execPath,[cli,'--input',raw,'--scope',scope,'--tickets',tickets,'--tickets-output',repaired,'--output',out]);
  const patched=JSON.parse(await readFile(repaired,'utf8')),event=patched.tickets[0].events[0];
  assert.equal(event.quote,'保留原问题');assert.equal(event.custom,'preserve-me');assert.equal(event.replyTo.messageId,'p-a');assert.equal(event.images[0].status,'REFERENCE_ONLY');assert.equal(event.links[0].title,'日报');
  assert.deepEqual(JSON.parse(await readFile(tickets,'utf8')),sourceStore);
});
