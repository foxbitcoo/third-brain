import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiagnosticQuestion, diagnosticCapabilities, humanInputBoundary } from '../diagnostic-routing.mjs';
const source = { id: 'source', version: 'v1', definitionVerified: true, userAuthorized: true, recipes: [
  { id: 'counts', title: 'Counts', supportedQuestionTypes: ['lookup','trend'] }, { id: 'version', title: 'Version contribution' },
] };
test('creation is pending for every wording and only a model completeness decision can shorten', () => {
  for (const question of ['昨天日活多少人？','本周日活趋势','本周为什么下降？','how many?']) {
    assert.equal(classifyDiagnosticQuestion(question,source).fastPath,false);
    assert.equal(classifyDiagnosticQuestion(question,source).status,'AWAITING_MODEL');
  }
});
test('capability manifest identifies queried and unused recipes without treating availability as a business fact', () => {
  const capabilities = diagnosticCapabilities(source, [{ plan: { recipeId: 'counts' }, result: { status: 'VERIFIED' } }]);
  assert.deepEqual(capabilities.recipes.map(row => row.queried), [true, false]);
  const toolQuestion = humanInputBoundary(['Can you provide version query capability?'], 'query_capability', capabilities);
  assert.equal(toolQuestion.capabilityCheck, 'EXISTING_CAPABILITIES_REQUIRE_REVIEW');
  assert.deepEqual(toolQuestion.availableUnusedRecipeIds, ['version']);
  assert.equal(toolQuestion.decision, 'needs_human');
  const businessQuestion = humanInputBoundary(['Which release really happened?'], 'business_fact', capabilities);
  assert.equal(businessQuestion.capabilityCheck, 'NO_AUTOMATIC_OVERRIDE');
  assert.equal(businessQuestion.decision, 'needs_human');
});
