import { createHash } from 'node:crypto';

const account = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,180}$/.test(value) ? value : null;
const key = value => `person-${createHash('sha256').update(JSON.stringify(['wps-account', value])).digest('hex').slice(0, 20)}`;

// Only call with the source-authorized ticket events. No directory lookups or
// claims about responsibility are made from mentions or an adjacent reply.
export function conversationParticipants(events, clean) {
  const names = new Map(), displayNames = new Map();
  for (const event of events) {
    const id = account(event.speakerId), name = clean(event.speaker, 200);
    if (!id || !name) continue;
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(id);
    const time = Date.parse(event.occurredAt ?? event.at);
    if (!displayNames.has(id) || time >= displayNames.get(id).time) displayNames.set(id, {name,time});
  }
  // Latest author label inside this authorized ticket is shared by all views.
  // The original per-message speaker and quote remain unchanged.
  const person = (id, name) => ({ key: id ? key(id) : null, name: displayNames.get(id)?.name || clean(name, 200) || '身份待确认', identityVerified: Boolean(id) });
  return events.map(event => {
    const participant = person(account(event.speakerId), event.speaker);
    const mentions = [], seen = new Set();
    const addMention = (name, nativeId) => {
      name = clean(name, 200).replace(/^@/, '').trim();
      if (!name || seen.has(`${nativeId || ''}:${name}`)) return;
      seen.add(`${nativeId || ''}:${name}`);
      // Name-only matches remain provisional, even if a single author uses it.
      const matches = names.get(name), native = account(nativeId);
      mentions.push({ ...person(native, name), candidateKey: !native && matches?.size === 1 ? key([...matches][0]) : null,
        basis: native ? 'IM_MENTION_ID' : 'NAME_ONLY', ambiguous: !native && matches?.size > 1 });
    };
    const raw = event.quote ?? event.text ?? '';
    let content; try { content = JSON.parse(raw); } catch { content = null; }
    let visited = 0;
    const walk = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 10 || ++visited > 2000) return;
      if (Array.isArray(node)) { node.slice(0, 300).forEach(value => walk(value, depth + 1)); return; }
      if (node.type === 'mention' && node.mention_content) addMention(node.mention_content.text || '', node.mention_content.identity?.id);
      for (const field of ['rich_text', 'elements', 'content', 'children']) if (node[field]) walk(node[field], depth + 1);
    };
    if (content) walk(content);
    else {
      for (const match of raw.matchAll(/<(?:at|mention)\b([^>]*)>([^<>]{1,200})<\/(?:at|mention)>/gi)) {
        const nativeId = match[1].match(/\buser_id=["']([^"']+)["']/i)?.[1];
        addMention(match[2], nativeId);
      }
      for (const name of names.keys()) {
        if (raw.includes(`@${name}`) && !mentions.some(item => item.name === name)) addMention(name);
      }
    }
    const refs = [event.replyMessageId, event.reply_msg_id, event.reply_to_message_id, event.quoteMessageId, event.quote_msg_id]
      .map(value => account(String(value ?? ''))).filter(value => value && value !== '0');
    const parent = events.find(row => row.sourceId === event.sourceId && refs.includes(String(row.messageId))
      && Date.parse(row.occurredAt ?? row.at) <= Date.parse(event.occurredAt ?? event.at) && row !== event);
    return { participant, mentions: mentions.slice(0, 20), replyTo: parent ? {
      eventId: `${parent.sourceId}:${parent.messageId}`, participant: person(account(parent.speakerId), parent.speaker), basis: 'IM_MESSAGE_REFERENCE',
    } : null, replyAssociation: parent ? 'EXPLICIT' : refs.length ? 'REFERENCE_NOT_IN_TICKET' : ['answer', 'reply'].includes(event.kind) ? 'UNCONFIRMED' : 'NONE' };
  });
}
