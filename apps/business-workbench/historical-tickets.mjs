import { conversationParticipants } from './conversation-participants.mjs';
import { sanitizeText } from './live-qa.mjs';
import { createHash } from 'node:crypto';
import { PERMANENT_BLOCKED_LOCATOR_HASHES } from './history-index.mjs';

const states = new Set(['ANSWERED', 'PENDING', 'UNKNOWN']);
const text = (value, max = 12000) => sanitizeText(typeof value === 'string' ? value : '').slice(0, max);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const iso = value => new Date(value).toISOString();
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,180}$/.test(value);

export function validHistoricalTickets(store) {
  if (store?.version !== 'historical-question-tickets/v1' || !Array.isArray(store.tickets) || store.tickets.length > 1500) return false;
  const start = store.window?.startAt ?? store.window?.start, end = store.window?.endAt ?? store.window?.end;
  if (!date(start) || !date(end) || Date.parse(start) > Date.parse(end) || !date(store.generatedAt)) return false;
  const seen = new Set();
  return store.tickets.every(ticket => {
    if (!id(ticket?.id) || seen.has(ticket.id) || !states.has(ticket.status) || typeof ticket.title !== 'string' || !ticket.title.trim()
      || typeof ticket.question !== 'string' || !ticket.question.trim() || typeof ticket.statusReason !== 'string'
      || ticket.historical !== true || ticket.autoExecute !== false
      || !Array.isArray(ticket.sourceIds) || !ticket.sourceIds.length || ticket.sourceIds.some(source => !id(source))
      || !Array.isArray(ticket.events) || !ticket.events.length || ticket.events.length > 300) return false;
    seen.add(ticket.id);
    const events = new Set();
    const validEvents = ticket.events.every(event => {
      const at = event.occurredAt ?? event.at, quote = event.quote ?? event.text;
      const key = `${event.sourceId}:${event.messageId}`;
      if (!id(event.sourceId) || !ticket.sourceIds.includes(event.sourceId) || !id(String(event.messageId ?? ''))
        || events.has(key) || !date(at) || Date.parse(at) < Date.parse(start) || Date.parse(at) > Date.parse(end)
        || typeof quote !== 'string' || quote.length > 30000 || !['question', 'answer', 'reply', 'followup', 'context', 'image'].includes(event.kind)) return false;
      events.add(key); return true;
    });
    const questions = ticket.events.filter(event => event.kind === 'question');
    if (!validEvents || !questions.length) return false;
    const firstQuestion = Math.min(...questions.map(event => Date.parse(event.occurredAt ?? event.at)));
    return ticket.status !== 'ANSWERED' || ticket.events.some(event => ['answer', 'reply'].includes(event.kind)
      && (event.quote ?? event.text).trim() && Date.parse(event.occurredAt ?? event.at) >= firstQuestion);
  });
}

// Extra historical reads are authorized by a separate, locally controlled scope,
// never by text returned from a model or a field inside the evidence store.
export function historicalScopeIds(scope, window) {
  if (!scope || scope.version !== 'historical-ticket-scope/v1' || scope.basis !== 'USER_REQUEST'
    || scope.startAt !== window.startAt || scope.endAt !== window.endAt
    || !Array.isArray(scope.sourceIds) || scope.sourceIds.length > 100 || scope.sourceIds.some(source => !id(source))
    || !scope.sourceRefs || typeof scope.sourceRefs !== 'object' || Array.isArray(scope.sourceRefs)
    || scope.sourceIds.some(source => !id(scope.sourceRefs[source]))) throw new Error('INVALID_HISTORY_TICKET_SCOPE');
  return new Set(scope.sourceIds);
}

export function projectHistoricalTickets(store, { allowedSourceIds = new Set(), excludedSourceIds = new Set(), scopeIds = new Set(), sourceRefs = new Map(), blockedLocatorHashes = new Set(), ticketId, secrets = [] } = {}) {
  if (!validHistoricalTickets(store)) throw new Error('INVALID_HISTORY_TICKETS');
  const clean = (value, max) => sanitizeText(text(value, max), secrets);
  const allowed = source => !excludedSourceIds.has(source) && (allowedSourceIds.has(source) || scopeIds.has(source));
  // A mixed-source ticket is hidden as a whole: summaries and merge reasons can
  // contain information from any linked source, so pruning events is insufficient.
  const blocked = new Set([...PERMANENT_BLOCKED_LOCATOR_HASHES, ...blockedLocatorHashes]);
  const tickets = store.tickets.filter(ticket => ticket.sourceIds.every(allowed) && ticket.events.every(event => {
    const nativeSource = sourceRefs.get(event.sourceId);
    if (!id(nativeSource)) return false;
    const hash = createHash('sha256').update(JSON.stringify(['wps', nativeSource, String(event.messageId)])).digest('hex');
    return !blocked.has(hash);
  }));
  const window = { start: iso(store.window.startAt ?? store.window.start), end: iso(store.window.endAt ?? store.window.end), asOf: iso(store.generatedAt) };
  const eventsFor = ticket => ticket.events.slice().sort((a, b) => Date.parse(a.occurredAt ?? a.at) - Date.parse(b.occurredAt ?? b.at));
  const summary = ticket => {
    const events = eventsFor(ticket);
    const question = events.find(event => event.kind === 'question');
    return { id: ticket.id, title: clean(ticket.title, 500), status: ticket.status, firstAskedAt: iso(question.occurredAt ?? question.at),
      lastActivityAt: iso(events.at(-1).occurredAt ?? events.at(-1).at), sourceCount: new Set(ticket.sourceIds).size, evidenceCount: events.length };
  };
  if (ticketId !== undefined) {
    if (!id(ticketId)) throw new Error('INVALID_HISTORY_TICKET_ID');
    const ticket = tickets.find(row => row.id === ticketId);
    if (!ticket) return null;
    const participantViews = conversationParticipants(eventsFor(ticket), clean);
    return { configured: true, window, ticket: { ...summary(ticket), question: clean(ticket.question), statusReason: clean(ticket.statusReason),
      sourceCandidates: (Array.isArray(ticket.sourceCandidates) ? ticket.sourceCandidates : []).slice(0, 10).map(source => ({ id: clean(source.id, 180), title: clean(source.title, 500), verified: source.verified === true })),
      events: eventsFor(ticket).map((event, index) => ({ ...participantViews[index], id: `${event.sourceId}:${event.messageId}`, kind: event.kind === 'answer' ? 'reply' : event.kind,
        at: iso(event.occurredAt ?? event.at), speaker: clean(event.speaker, 200), sourceTitle: clean(event.sourceTitle || '原始会话', 300), text: clean(event.quote ?? event.text, 30000),
        quoteMessageId: id(String(event.quoteMessageId ?? event.quote_msg_id ?? '')) && String(event.quoteMessageId ?? event.quote_msg_id) !== '0' ? String(event.quoteMessageId ?? event.quote_msg_id) : null,
        replyMessageId: id(String(event.replyMessageId ?? event.reply_msg_id ?? event.reply_to_message_id ?? '')) && String(event.replyMessageId ?? event.reply_msg_id ?? event.reply_to_message_id) !== '0' ? String(event.replyMessageId ?? event.reply_msg_id ?? event.reply_to_message_id) : null,
        // Raw download URLs, local paths, account IDs and model-supplied HTML are
        // never projected. Images remain explicitly unread until a safe route exists.
        images: ((Array.isArray(event.images) && event.images.length) ? event.images : event.image?.status && event.image.status !== 'NONE' ? [event.image] : []).slice(0, 8).map(image => ({ available: false, reason: clean(image.reason || '原图尚未接入当前工单页面', 300), caption: clean(image.caption, 1000) })) })),
      analysisNotes: clean(ticket.mergeReason || ticket.analysisNotes), boundaries: ['历史已有答复仅表示存在回复线索，不等同于问题已解决。', '历史回填不会自动重新查数或加入今天的待办。', ...(ticket.uncertainties || []).filter(value => typeof value === 'string').slice(0, 20).map(value => clean(value, 1500))] } };
  }
  return { configured: true, window, coverage: { status: clean(store.coverage?.status || 'PARTIAL', 100), checkedSources: count(store.coverage?.checkedSources),
    totalSources: count(store.coverage?.totalSources), notes: ['覆盖受当前来源许可及历史读取范围限制；未读和读取失败不能视为没有问题。', ...(store.coverage?.notes || []).filter(value => typeof value === 'string').slice(0, 20).map(value => clean(value, 1500))] },
    counts: { total: tickets.length, answered: tickets.filter(ticket => ticket.status === 'ANSWERED').length, pending: tickets.filter(ticket => ticket.status === 'PENDING').length, unknown: tickets.filter(ticket => ticket.status === 'UNKNOWN').length },
    tickets: tickets.map(summary).sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)) };
}
