import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionReason, sourceAttentionPresentation } from '../src/source-attention-presentation.mjs';

const candidate = { status: 'candidate', tier: 'on_match', reason: '近期会话发现，业务关联待核实' };

test('candidate presentation never claims its stored default tier is a listening setting', () => {
  const view = sourceAttentionPresentation(candidate);
  assert.equal(view.category, 'candidate');
  assert.equal(view.badge, '未关注');
  assert.equal(view.setting, '未关注');
  assert.equal(view.reasonLabel, '发现原因');
  assert.equal(view.review, '未审核');
  assert.ok(!JSON.stringify(view).includes('按需监听'));
  assert.equal(candidate.tier, 'on_match');
});

test('legacy keyword-only admission is shown as unverified recall while manual inclusion keeps its tier', () => {
  const legacy = { status: 'active', tier: 'on_match', decisionOrigin: 'keyword', keywordEvidence: [{}] };
  const recalled = sourceAttentionPresentation(legacy);
  assert.equal(recalled.category, 'candidate');
  assert.equal(recalled.reason, '命中业务关键词，召回待核实');
  const manual = sourceAttentionPresentation({ ...legacy, manualOverride: true });
  assert.equal(manual.category, 'on_match');
  assert.equal(manual.badge, '按需监听');
  assert.equal(manual.setting, '手动固定');
  assert.equal(manual.reasonLabel, '关注理由');
  assert.equal(sourceAttentionPresentation({ ...legacy, status: 'excluded' }).category, 'excluded');
});

test('model review outcomes explain candidate state without inventing admission', () => {
  const gates = [
    [{ status: 'NOT_RUN' }, '未审核'],
    [{ status: 'FAILED', reason: '{"raw":"private"}' }, '筛选暂未完成'],
    [{ status: 'VERIFIED', decision: 'allow_preview', reason: '相关业务需进一步核实', model: 'internal-model' }, '业务相关，待核实'],
    [{ status: 'VERIFIED', decision: 'irrelevant' }, '业务不相关'],
    [{ status: 'VERIFIED', decision: 'insufficient' }, '资料不足'],
  ];
  for (const [metadataGate, text] of gates) {
    const view = sourceAttentionPresentation({ ...candidate, metadataGate });
    assert.equal(view.review, text);
    assert.equal(view.badge, '未关注');
    assert.ok(!JSON.stringify(view).includes('internal-model'));
    assert.ok(!JSON.stringify(view).includes('private'));
  }
  assert.equal(sourceAttentionPresentation({ ...candidate, metadataGate: gates[2][0] }).reason, '相关业务需进一步核实');
  const active = sourceAttentionPresentation({ status: 'active', tier: 'priority', reason: '需本人决策', decisionOrigin:'auto', lastEvaluatedAt:'2026-10-15T08:00:00Z', matchedWorklines:['w'], evidenceRefs:['m'] });
  assert.equal(active.badge, '重点监控');
  assert.equal(active.reason, '需本人决策');
});

test('business summaries omit diagnostic JSON, thinking payloads and identity tokens', () => {
  for (const value of ['{"reason":"internal"}', '<think>hidden deliberation</think>', 'open_id=private', undefined]) {
    assert.equal(attentionReason(value, '待核实'), '待核实');
  }
  assert.equal(attentionReason('由 ou_private 联系 123e4567-e89b-12d3-a456-426614174000'), '由 ［身份标识已隐藏］ 联系 ［内部标识已隐藏］');
  assert.equal(attentionReason('相关业务：数据报告。需本人决策。'), '相关业务：数据报告。需本人决策。');
});

test('untrusted legacy active is shown as unmonitored consistently with read permission',()=>{
 const view=sourceAttentionPresentation({status:'active',tier:'normal',decisionOrigin:'imported',matchedWorklines:['w'],evidenceRefs:[]});assert.equal(view.category,'candidate');assert.equal(view.badge,'未关注');
});

test('main attention reasons keep business facts while source IDs and matching fields move into details', () => {
 const reason = '示例同事甲在消息 1000000001 汇报某业务成本，示例用户（本人 ID 9000000001）参与讨论。且 previousWorklines 中包含“成本优化”，业务对象为成本优化。';
 const source = { status:'active', tier:'normal', manualOverride:true, reason };
 const original = structuredClone(source), view = sourceAttentionPresentation(source);
 assert.equal(view.reason, '示例同事甲在消息 汇报某业务成本，示例用户参与讨论。');
 assert.equal(view.diagnosticReason, reason);
 assert.equal(view.setting, '手动固定');
 assert.deepEqual(source, original);
 assert.equal(attentionReason('消息id 1000000002和1000000003中提出增加看板目标完成度。'), '消息中提出增加看板目标完成度。');
 assert.equal(attentionReason('示例同事乙的消息（id 1000000004）明确提到模板全量。'), '示例同事乙的消息明确提到模板全量。');
 assert.equal(attentionReason('本人示例同事（9000000001）在此群中参与交接，需核对权限。'), '本人示例同事在此群中参与交接，需核对权限。');
});

test('technical-only reasons remain unknown and forbidden sources keep their state', () => {
 const reason = 'previousWorklines 中包含内部匹配。';
 const view = sourceAttentionPresentation({status:'excluded', tier:'normal', reason});
 assert.equal(view.reason, '关联依据待核实');
 assert.equal(view.diagnosticReason, reason);
 assert.equal(view.category, 'excluded');
 assert.equal(view.setting, '已禁止关注');
 assert.equal(view.badge, '禁止关注');
});
