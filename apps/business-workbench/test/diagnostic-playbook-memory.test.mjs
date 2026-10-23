import test from 'node:test';
import assert from 'node:assert/strict';
import {playbookHash,ticketMemoryTrace} from '../memory-playbook.mjs';
import {playbookReferenceMemory,mergeMemoryContext} from '../diagnostic-playbook-memory.mjs';
import {selectMemorySnapshot,revalidateMemorySnapshot,buildMemorySystemBlock} from '../diagnostic-memory.mjs';
import {mergeMemoryRecords,memoryReviewRows} from '../src/memory-review-presentation.mjs';
const source={id:'approved',version:'v1'};
const original={id:'playbook-1',sourceTicketId:'ticket-1',kind:'ANALYSIS_RULE',title:'成本核对方法',question:'如何核对成本？',inputs:['月份'],steps:[{action:'先核对分母，再分模型。'}],outputs:['核对表'],boundaries:['不能沿用旧金额'],queryPattern:'原始问题：{{问题}}\n先核对分母',sourceRefs:[{sourceId:'im-1',messageId:'m1',at:'2026-01-01T00:00:00Z'}],knownAt:'2026-01-01T00:00:00Z',datedFacts:[{statement:'旧金额12345'}],originalEvidence:[{text:'旧私聊原文'}]};
const policy=()=>({version:'playbook-reuse-v1',enabledAt:'2026-02-01T00:00:00Z',records:[{id:original.id,hash:playbookHash(original),enabled:true,sourceIds:['approved'],matchAny:['成本']}]});
const options=b=>({records:b.records,...b.context,source,question:'本月成本如何核对？',cutoff:'2026-02-02T00:00:00Z'});
test('approved source-bound playbook recalls methods without copying raw answers or dated facts',()=>{
 const bundle=playbookReferenceMemory([original],policy(),source),snapshot=selectMemorySnapshot(options(bundle));
 assert.equal(snapshot.selected.length,1);assert.equal(snapshot.selected[0].id,original.id);
 const block=buildMemorySystemBlock(snapshot);assert.match(block,/先核对分母/);assert.ok(!block.includes('12345'));assert.ok(!block.includes('旧私聊原文'));
 assert.equal(selectMemorySnapshot({...options(bundle),question:'活跃周同比'}).excluded[0].reason,'DIRECTION_MISMATCH');
 assert.equal(selectMemorySnapshot({...options(bundle),cutoff:'2026-01-30T00:00:00Z'}).selected.length,0);
});
test('content changes, disablement, scope changes and admission revocation remove reference at next dispatch',()=>{
 const b=playbookReferenceMemory([original],policy(),source),prepared=selectMemorySnapshot(options(b));
 for(const [records,p,s] of [[[],policy(),source],[[{...original,steps:[{action:'changed'}]}],policy(),source],[[original],{...policy(),records:[{...policy().records[0],enabled:false}]},source],[[original],policy(),{id:'other',version:'v1'}]]){
  const current=playbookReferenceMemory(records,p,s);assert.equal(current.records.length,0);
  assert.equal(revalidateMemorySnapshot(prepared,{...options(current),source:s}).selected.length,0);
 }
 assert.equal(playbookReferenceMemory([original],null,source).records.length,0);
 assert.equal(buildMemorySystemBlock(selectMemorySnapshot({...options(b),records:[]})),'');
});
test('structured viewer merges runtime status without losing steps or duplicating a ticket memory',()=>{
 const runtime=playbookReferenceMemory([original],policy(),source).records[0];
 const rows=mergeMemoryRecords([{id:'old',text:'legacy'},runtime],[original]);
 assert.equal(rows.length,2);assert.equal(rows.find(r=>r.id===original.id).steps.length,1);
 assert.equal(memoryReviewRows(rows,[],{origin:'METHOD'}).length,1);
 assert.equal(memoryReviewRows(rows,[],{origin:'REFERENCE'}).length,1);
 const trace=ticketMemoryTrace('ticket-1',[original],{records:[runtime],runs:[]});
 assert.equal(trace.generated.length,1);assert.equal(trace.generated[0].activation.status,'REFERENCE_ENABLED');
});
test('context merging retains both original source fences and per-playbook evidence hashes',()=>{
 const c=mergeMemoryContext({allowedSourceIds:['approved','doc'],sourceVersions:{doc:'d1'},sourceHashes:{doc:'h1'}},playbookReferenceMemory([original],policy(),source).context);
 assert.equal(new Set(c.allowedSourceIds).size,3);assert.equal(c.sourceHashes.doc,'h1');assert.ok(c.sourceHashes['playbook:playbook-1']);
});

test('effective intervals survive the reference bridge and expiry cannot be bypassed',()=>{
 const expired={...original,effectiveFrom:'2026-01-01T00:00:00Z',effectiveUntil:'2026-01-10T00:00:00Z'};
 const p=policy();p.records[0].hash=playbookHash(expired);
 const b=playbookReferenceMemory([expired],p,source);
 assert.equal(b.records[0].effectiveUntil,expired.effectiveUntil);
 assert.equal(selectMemorySnapshot(options(b)).excluded[0].reason,'EXPIRED');
 const invalid={...expired,effectiveUntil:'invalid'};p.records[0].hash=playbookHash(invalid);
 assert.equal(playbookReferenceMemory([invalid],p,source).records.length,0);
});
