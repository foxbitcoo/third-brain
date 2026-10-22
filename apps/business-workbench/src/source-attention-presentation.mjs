import {isTrustedListeningSource} from '../source-listening-policy.mjs';
export const attentionLabels = { priority: '重点监控', normal: '普通监控', on_match: '按需监听', candidate: '候选来源', excluded: '禁止关注' };

function candidateReview(source) {
  const gate = source.metadataGate;
  if (gate?.status === 'FAILED') return '筛选暂未完成';
  if (gate?.status !== 'VERIFIED') return '未审核';
  return { allow_preview: '业务相关，待核实', irrelevant: '业务不相关', insufficient: '资料不足' }[gate.decision] || '未审核';
}

// Show business summaries only; diagnostic payloads and internal identity tokens are not explanations.
export function attentionReason(value, fallback = '关联依据待核实') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const text = value.trim();
  if (/^[\[{]/.test(text) || /<\/?(?:think|analysis)>|(?:chain.of.thought|reasoning_content)|\b(?:user_id|open_id|chat_id|source_key)\b/i.test(text)) return fallback;
  const reason = text
    .replace(/^上轮已授权读取；当前问答在「(.+?)」引用了该来源的原始记录。保守继承普通监控，引用关联不代表自动评级。$/, '相关业务：$1。已有问答引用该来源记录。')
    .replace(/^上轮人工扩读理由：/, '')
    .replace(/当前保守继承为普通监控，尚未自动评级。$/, '')
    .replace(/(?:，?且\s*)?\bpreviousWorklines\b[^。！？\n]*(?:[。！？]|$)/gi, '')
    .replace(/[（(]\s*(?:(?:本人\s*)?(?:消息\s*)?id)\s*[:：=]?\s*\d+(?:\s*[、,，和及]\s*\d+)*\s*[）)]/gi, '')
    .replace(/消息\s*(?:id\s*[:：=]?\s*)?\d+(?:\s*[、,，和及]\s*\d+)*/gi, '消息')
    .replace(/本人\s*id\s*[:：=]?\s*\d+/gi, '本人')
    .replace(/((?:本人|用户)[^（）()\n]{0,20})[（(]\d{8,}[）)]/g, '$1')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '［内部标识已隐藏］')
    .replace(/\b(?:ou_|on_|oc_|_user_)[A-Za-z0-9_-]+\b/g, '［身份标识已隐藏］')
    .trim();
  return reason && !/^[，,。；;\s]*$/.test(reason) ? reason : fallback;
}

export function sourceAttentionPresentation(source) {
  // Old keyword-only entries can carry an active tier; recall alone never proves admission.
  const candidate = source.status === 'candidate' || (source.status === 'active' && !isTrustedListeningSource(source));
  const category = candidate ? 'candidate' : source.status === 'active' ? source.tier : source.status;
  const reasonLabel = candidate ? '发现原因' : source.status === 'excluded' ? '原关注理由' : '关注理由';
  const fallback = candidate ? (source.keywordEvidence?.length ? '命中业务关键词，召回待核实' : '近期会话发现，业务关联待核实') : '关联依据待核实';
  const rawReason = candidate ? source.metadataGate?.reason || source.reason : source.reason;
  const reason = attentionReason(rawReason, fallback);
  return {
    category,
    candidate,
    badge: candidate ? '未关注' : attentionLabels[category] || '状态待核实',
    setting: candidate ? '未关注' : source.status === 'excluded' ? '已禁止关注' : source.manualOverride ? '手动固定' : source.decisionOrigin === 'imported' ? '原有关注' : '模型审核分档',
    reasonLabel,
    reason,
    // Keep source diagnostics available only inside the existing settings detail.
    // JSON and thinking payloads are never promoted into a user-facing explanation.
    diagnosticReason: typeof rawReason === 'string' && rawReason.trim() !== reason
      && !/^[\[{]|<\/?(?:think|analysis)>|chain.of.thought|reasoning_content/i.test(rawReason.trim()) ? rawReason : '',
    review: candidate ? candidateReview(source) : '',
  };
}
