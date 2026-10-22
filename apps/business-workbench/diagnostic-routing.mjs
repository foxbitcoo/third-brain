/** Conservative local intent routing. Only explicitly compatible recipes shorten a run. */
export function diagnosticCapabilities(source, rounds = []) {
  const used = new Set(rounds.filter(round => round.result?.status === 'VERIFIED').map(round => round.plan?.recipeId));
  return { sourceId: source.id, sourceVersion: source.version, authorized: source.userAuthorized === true,
    definitionVerified: source.definitionVerified === true,
    recipes: (source.recipes || []).map(({ id, title, purpose, dimensions, supportedQuestionTypes }) => ({ id, title, purpose, dimensions, supportedQuestionTypes, queried: used.has(id) })),
    instruction: '已列出的方案是现有能力，不要要求用户重新提供这些工具。方案存在不代表业务事实、指标口径、时间范围已明确；缺少真实业务事实时仍须精确提问。不能扩展授权或自动执行尚未选择的方案。' };
}
/** Creation never makes a lexical complexity decision. The first paid plan supplies it. */
export function classifyDiagnosticQuestion() {
  return { version: 'diagnostic-route-v2', kind: 'pending', status: 'AWAITING_MODEL', fastPath: false,
    compatibleRecipeIds: [], reason: '等待模型结合问题、来源及引用资料判断查询完整性。' };
}
export function modelDiagnosticRoute(plan, source, questionContext) {
  const fields = ['object','metric','period','comparison','goal'];
  const classification = plan?.route?.kind;
  if (!['simple','complex','needs_context'].includes(classification) || typeof plan.route.reason !== 'string'
    || !plan.completeness || fields.some(key => !['complete','missing','not_required'].includes(plan.completeness[key]))) return null;
  if(['object','metric','period','goal'].some(key=>plan.completeness[key]==='not_required'))return null;
  const requiredMissing = fields.filter(key => plan.completeness[key] === 'missing');
  if(questionContext?.binding && questionContext.binding.status!=='BOUND' || questionContext?.missing?.includes('BOARD_ALIGNMENT_MISSING'))requiredMissing.push('boardAlignment');
  const kind = requiredMissing.length ? 'needs_context' : classification;
  return { version: 'diagnostic-route-v2', status: 'MODEL_VERIFIED', kind,
    fastPath: kind === 'simple' && source.userAuthorized === true && source.definitionVerified === true,
    compatibleRecipeIds: source.recipes.filter(row => row.id === plan.recipeId).map(row => row.id),
    completeness: structuredClone(plan.completeness), missing: requiredMissing, reason: plan.route.reason };
}
export function humanInputBoundary(questions = [], missingCategory, capabilities) {
  const category = ['business_fact','metric_definition','source_access','query_capability'].includes(missingCategory) ? missingCategory : 'unspecified';
  const availableUnusedRecipeIds = (capabilities?.recipes || []).filter(recipe => !recipe.queried).map(recipe => recipe.id);
  return { missingCategory: category, questions: questions.filter(value => typeof value === 'string' && value.trim()), availableUnusedRecipeIds,
    capabilityCheck: category === 'query_capability' && availableUnusedRecipeIds.length ? 'EXISTING_CAPABILITIES_REQUIRE_REVIEW' : 'NO_AUTOMATIC_OVERRIDE',
    // Never turn a human stop into an automatic query based on lexical matching.
    decision: 'needs_human' };
}
