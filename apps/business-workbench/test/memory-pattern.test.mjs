import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryPattern,memoryDirectionCounts,memoryActivationLabel} from '../memory-pattern.mjs';
import {playbookReferenceMemory} from '../diagnostic-playbook-memory.mjs';
import {memoryReviewRows} from '../src/memory-review-presentation.mjs';
const record={id:'m',title:'月度账单核对',question:'{{月份}}账单如何核实',sourceTicketId:'july',knownAt:'2026-08-19T00:00:00Z',status:'SOURCE_VERIFIED',activation:{status:'AUTO_ENABLED',enabledAt:'2026-10-23T01:00:00Z'},direction:{id:'S1'},inputs:['本期两侧token'],steps:[{action:'核对服务端与网关token'}],outputs:['差异表'],boundaries:['不能沿用历史金额'],queryPattern:'核对本月两侧token',sourceRefs:[{sourceId:'im',messageId:'reply',at:'2026-08-19T00:00:00Z'}],useWhen:['月度账单核查'],doNotUseWhen:['统计范围不同'],currentMaterials:['本期账单'],originalModelOutput:{uncertainties:['计费规则待取得']}};
test('seven-section reader keeps applicability, exceptions and missing current data separate',()=>{
 const view=memoryPattern(record);assert.deepEqual(view.useWhen,['月度账单核查']);assert.deepEqual(view.doNotUseWhen,['统计范围不同']);assert.deepEqual(view.currentMaterials,['本期账单','计费规则待取得']);assert.equal(view.direction.id,'S1');assert.equal(record.currentMaterials.length,1);
 const legacy=memoryPattern({...record,useWhen:undefined,doNotUseWhen:undefined,currentMaterials:undefined});assert.match(legacy.useWhen[0],/账单如何核实/);assert.equal(legacy.currentMaterials[0],'本期两侧token');
});
test('direction filters preserve counts and only narrow the displayed list',()=>{
 const other={...record,id:'n',title:'异常排查',direction:{id:'S3'}};
 assert.deepEqual(memoryDirectionCounts([record,other]).map(d=>[d.id,d.count]),[['S1',1],['S3',1]]);
 assert.equal(memoryReviewRows([record,other],[],{direction:'S1'}).length,1);
});
test('new successful extraction becomes eligible without per-record confirmation but cannot expand query-source scope',()=>{
 const policy={version:'playbook-reuse-v2',enabledAt:'2026-10-23T00:00:00Z',autoActivate:true,sourceIds:['approved'],records:[]};
 assert.equal(playbookReferenceMemory([record],policy,{id:'approved',version:'1'}).records.length,1);
 assert.equal(playbookReferenceMemory([record],policy,{id:'other',version:'1'}).records.length,0);
 assert.equal(playbookReferenceMemory([{...record,status:'CANDIDATE'}],policy,{id:'approved',version:'1'}).records.length,0);
 assert.equal(playbookReferenceMemory([record],{...policy,disabledIds:['m']},{id:'approved',version:'1'}).records.length,0);
});

test('candidate or unactivated memories cannot be labelled automatically active',()=>{
 assert.equal(memoryActivationLabel(record),'自动生效');
 assert.equal(memoryActivationLabel({...record,status:'CANDIDATE'}),'尚未启用');
 assert.equal(memoryActivationLabel({...record,activation:null}),'尚未启用');
 assert.equal(memoryActivationLabel({...record,status:'DISABLED'}),'已停用');
 assert.equal(memoryActivationLabel({...record,activation:{status:'REFERENCE_ENABLED'}}),'已启用');
});
