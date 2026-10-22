import { createHash } from 'node:crypto';
import { sanitizeText } from './live-qa.mjs';
import { PERMANENT_BLOCKED_LOCATOR_HASHES } from './history-index.mjs';
import { isAbsolute } from 'node:path';

const id = value => typeof value === 'string' && /^[\w.:-]{1,180}$/.test(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** An attachment is visible only with its current source and native reference graph. */
export function authorizedHistoricalMedia(manifest, ticket, messages, policy, window) {
  if (manifest?.version !== 'historical-ticket-media/v1' || !isAbsolute(manifest.imageRoot || '')
    || !Array.isArray(manifest.images) || manifest.images.length > 2000 || !Array.isArray(messages) || messages.length > 5000) throw Error('INVALID_HISTORY_MEDIA');
  const start = Date.parse(window.startAt ?? window.start), end = Date.parse(window.endAt ?? window.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw Error('INVALID_HISTORY_MEDIA');
  const blocked = new Set([...PERMANENT_BLOCKED_LOCATOR_HASHES, ...(policy.blockedLocatorHashes || [])]);
  const allowed = message => message && policy.sourceRefs.get(message.sourceId) === message.sourceRef
    && !policy.excludedSourceIds.has(message.sourceId) && policy.allowedSourceIds.has(message.sourceId)
    && instant(message.pushedAt) && Date.parse(message.pushedAt) >= start && Date.parse(message.pushedAt) <= end
    && !blocked.has(createHash('sha256').update(JSON.stringify(['wps', message.sourceRef, message.messageId])).digest('hex'));
  const graph = new Map(messages.map(message => [`${message.sourceId}:${message.messageId}`, message]));
  const roots = new Map(ticket.events.map(event => [`${event.sourceId}:${event.messageId}`, graph.get(`${event.sourceId}:${event.messageId}`)]));
  const seen = new Set();
  return manifest.images.filter(row => {
    if (row.ticketId !== ticket.id) return false;
    if (!id(row.id) || seen.has(row.id) || !id(row.sourceId) || !id(row.sourceRef) || !id(row.messageId)
      || !digest(row.imageRefHash) || !['VERIFIED', 'UNAVAILABLE'].includes(row.status)
      || row.status === 'VERIFIED' && (!digest(row.sha256) || !/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(row.imageFile || ''))) return false;
    seen.add(row.id);
    const message = graph.get(`${row.sourceId}:${row.messageId}`), root = roots.get(row.linkedEventId);
    if (!allowed(root) || !allowed(message) || row.at !== message.pushedAt || message.sourceRef !== row.sourceRef || !message.images?.some(image => image.refHash === row.imageRefHash)) return false;
    let current = root;
    const visited = new Set();
    for (let depth = 0; depth < 8 && current && allowed(current); depth++) {
      if (visited.has(current.messageId)) break;
      visited.add(current.messageId);
      if (current.messageId === message.messageId && current.sourceId === message.sourceId) {
        return row.relation === (depth === 0 ? 'EVENT_ATTACHMENT' : 'EXPLICIT_REFERENCE');
      }
      const parent = current.quoteMessageId || current.replyMessageId;
      current = parent ? graph.get(`${current.sourceId}:${parent}`) : null;
    }
    const age = Date.parse(root.pushedAt) - Date.parse(message.pushedAt);
    return row.relation === 'NEARBY_CANDIDATE' && !root.quoteMessageId && !root.replyMessageId
      && root.sourceId === message.sourceId && root.sourceRef === message.sourceRef && age >= 0 && age <= 86400000;
  });
}

export function projectHistoricalMedia(rows, ticketId, secrets = []) {
  return rows.map(row => ({ id: row.id, linkedEventId: row.linkedEventId, relation: row.relation, sourceMessageId: row.messageId,
    at: row.at, caption: sanitizeText(row.caption || '原始图片', secrets).slice(0, 300), status: row.status,
    reason: row.status === 'VERIFIED' ? null : '尚未取得可核验原图。',
    imagePath: row.status === 'VERIFIED' ? `/api/discovery-history-image?ticket=${encodeURIComponent(ticketId)}&image=${encodeURIComponent(row.id)}` : null,
  }));
}
