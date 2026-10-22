import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startWorkbenchServer} from '../server.mjs';

test('diagnostic request accommodates bounded Chinese facts plus Markdown but rejects oversized bytes before dispatch', async t => {
  const inputs=[];
  const service={async create(input){inputs.push(input);return {run:{id:'synthetic'}};}};
  const server=await startWorkbenchServer({port:0,discoveryService:service});
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const post=body=>fetch(`${origin}/api/discovery`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body});
  const payload={question:'问'.repeat(3000),facts:'事'.repeat(8000),knowledgeMarkdown:'# 业务口径\n'+'径'.repeat(1900),sourceId:'synthetic',trigger:'manual'};
  const body=JSON.stringify(payload);
  assert.ok(Buffer.byteLength(body)>20_000&&Buffer.byteLength(body)<64_000);
  assert.equal((await post(body)).status,200);
  assert.deepEqual(inputs,[payload]);
  const oversized=JSON.stringify({...payload,knowledgeMarkdown:'额'.repeat(24_000)});
  assert.ok(Buffer.byteLength(oversized)>64_000);
  assert.equal((await post(oversized)).status,400);
  assert.equal(inputs.length,1,'oversized request must never reach task creation');
});
