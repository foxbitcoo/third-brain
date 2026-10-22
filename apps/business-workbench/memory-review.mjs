import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const list = value => Array.isArray(value) ? value : [];
const string = value => typeof value === 'string' ? value : '';
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const acknowledgement = value => /^(收到|好的|好|OK|ok|已阅|谢谢|赞|👌|👍)[。.!！\s]*$/u.test(value.trim());

/** Preserve history as reviewable candidates, never silently promote replies or acknowledgements to verified knowledge. */
export function historicalMemoryCandidates({ tickets, sourceRef, sourceIds, knownAt }) {
  if (!sourceRef?.sourceId || !sourceRef.hash || !sourceRef.version || !sourceRef.locator || !validDate(sourceRef.knownAt) || !validDate(knownAt) || !list(sourceIds).length) throw new Error('Historical memory requires located, hashed source evidence and explicit diagnostic scope.');
  return [...new Map(list(tickets).filter(ticket => ticket?.id && string(ticket.question).trim()).map(ticket => [ticket.id, ticket])).values()].map(ticket => {
    const events = list(ticket.events).map(event=>({...event,id:event.id||event.messageId,text:event.text??event.quote??'',at:event.at||event.occurredAt,kind:event.kind==='answer'?'reply':event.kind}));
    const replies = events.filter(event => event.kind === 'reply' && string(event.text).trim() && !acknowledgement(event.text));
    const acknowledgements = events.filter(event => acknowledgement(string(event.text))).map(event => ({ id: event.id, text: event.text, at: event.at, speaker: event.speaker, meaning: 'RECEIVED_NOT_FACT_VERIFIED' }));
    const deliverables = [];
    for (const event of events) {
      for (const artifact of [...list(event.artifacts), ...list(event.deliverables), ...list(event.links)]) {
        const item = typeof artifact === 'string' ? { title: artifact, url: /^https:\/\//.test(artifact) ? artifact : undefined } : artifact;
        if (item) deliverables.push({ ...item, eventId: event.id, at: event.at });
      }
      for (const url of string(event.text).match(/https:\/\/[^\s<>"）)]+/g) || []) deliverables.push({ title: '历史回复中的链接', url, eventId: event.id, at: event.at });
    }
    const uniqueDeliverables = [...new Map(deliverables.map(item => [item.url || item.id || item.title, item])).values()];
    const text = `历史原问：${ticket.question}\n${replies.length ? replies.map(event => `历史答复（尚未核验）：${event.text}`).join('\n') : '未取得有实质内容的历史答复。'}\n本条仅保存待核验的历史经验候选；不将历史数值当作当前数值，不将接收回复当作结论正确。`.slice(0, 12000);
    return {
      id: `history-memory-${digest({ sourceId: sourceRef.sourceId, ticketId: ticket.id }).slice(0, 24)}`,
      kind: 'ANALYSIS_RULE', status: 'CANDIDATE', title: string(ticket.title || ticket.question).slice(0, 280), text, knownAt,
      keywords: [], sourceRefs: [{ ...sourceRef, locator: `${sourceRef.locator}#ticket=${encodeURIComponent(ticket.id)}` }],
      applicability: { sourceIds: [...sourceIds] },
      lineage: { ticketId: ticket.id, question: ticket.question, deliverables: uniqueDeliverables, acknowledgements,
        replyRefs: replies.map(event => ({ id: event.id, text: event.text, at: event.at })),
        extraction: '从已授权历史工单保留原问和答复作为候选，尚未提炼为可直接用于分析的规则。',
        historicalStatus: ticket.status || 'UNKNOWN', correctness: 'NOT_VERIFIED' },
    };
  });
}
