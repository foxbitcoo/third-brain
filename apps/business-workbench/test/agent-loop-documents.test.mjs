import test from 'node:test';
import assert from 'node:assert/strict';
import {loadDiagnosticAgent} from '../diagnostic-agent.mjs';
import {diagnosticGuideDocument,loopNodeDocument,fullDocumentFocus} from '../src/agent-loop-documents.mjs';

test('all loop nodes link to actual versioned sections rather than invented standalone documents',async()=>{
  const agent=await loadDiagnosticAgent();
  for(const id of ['resolve','routing','simple','plan','query','review','decision','report','human']) {
    const doc=loopNodeDocument(agent,id);
    assert.equal(doc.version,agent.skill.version);assert.equal(doc.documentTitle,agent.skill.title);
    assert.ok(doc.groups.some(group=>group.lines.length));assert.match(doc.source,/循环|模型分流/);
  }
  assert.equal(loopNodeDocument(agent,'unknown-node'),null);
});
test('the displayed document preserves the actual introduction and rules while omitting frontmatter',async()=>{
  const agent=await loadDiagnosticAgent(),document=diagnosticGuideDocument(agent);
  const text=document.sections.flatMap(section=>section.lines).join('\n');
  assert.match(text,/每个新任务保存本规范的版本/);assert.match(text,/当前结构化查数接口不支持直接上传图片/);
  assert.doesNotMatch(text,/name: data-diagnostic-agent|description: Diagnose|SHA256_TEST/);
  assert.equal(diagnosticGuideDocument({skill:{markdown:'',version:'1.0.0'}}),null);
});
test('review, decision and report do not present source instructions as successful analysis',async()=>{
  const agent=await loadDiagnosticAgent();
  const review=loopNodeDocument(agent,'review');
  assert.match(review.caveat,/不是独立模型效果评分或因果认证/);
  const decision=loopNodeDocument(agent,'decision');assert.match(decision.groups.flatMap(group=>group.lines).join('\n'),/预算足够时继续/);
  const report=loopNodeDocument(agent,'report');assert.match(report.groups.flatMap(group=>group.lines).join('\n'),/报告可审阅不等于根因已证实/);
});
test('full document focus targets only the corresponding numbered source rules',()=>{
  assert.equal(fullDocumentFocus('review','循环','4. 核查数据'),true);
  assert.equal(fullDocumentFocus('review','循环','8. 决定是否继续'),false);
  assert.equal(fullDocumentFocus('review','工具与职责','4. 其他说明'),false);
});
