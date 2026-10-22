// Format only. These helpers never infer identities, facts, or work-state changes.
function unwrapTextEnvelope(value) {
  const text = String(value);
  if (!text.trimStart().startsWith('{')) return text;
  try {
    const envelope = JSON.parse(text);
    // Only this exact WPS text-message shape is display metadata. Unknown JSON
    // stays intact so attachments or other source content cannot disappear.
    if (Object.keys(envelope).length === 1 && envelope.text && !Array.isArray(envelope.text)
      && Object.keys(envelope.text).length === 1 && typeof envelope.text.content === 'string') return envelope.text.content;
    const runs = richMessageRuns(text);
    if (runs) return runs.map(run => run.text + (run.href ? ` ${run.href} ` : '')).join('').replace(/\n$/, '');
  } catch {
    const runs = partialRichMessageRuns(text);
    if (runs) return '[原文片段，内容不完整；匿名展示中隐藏正文，请关闭匿名后核对已留存片段]';
  }
  return text;
}

// Decode only recognized display nodes. Preserve unknown envelopes verbatim.
// No source HTML, resource key or arbitrary CSS is executed by the renderer.
export function richMessageRuns(value) {
  if (typeof value !== 'string' || value.length > 1000000) return null;
  try {
    const envelope = JSON.parse(value);
    if (!envelope || Object.keys(envelope).length !== 1 || !envelope.rich_text
      || Object.keys(envelope.rich_text).length !== 1 || !Array.isArray(envelope.rich_text.elements)) return null;
    let remaining = 500;
    const decode = (node, depth) => {
      if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 8 || --remaining < 0) return null;
      const fields = { nl: [], ol: [], ul: [], text: ['text_content', 'style_content'], mention: ['mention_content'], doc: ['doc_content'], image: ['image_content'] }[node.type];
      if (!fields || Object.keys(node).some(key => !['type', 'alt_text', 'elements', 'indent', 'index', ...fields].includes(key))) return null;
      if (['nl', 'ol', 'ul'].includes(node.type)) {
        if (!Array.isArray(node.elements)) return null;
        const children = node.elements.map(child => decode(child, depth + 1));
        const marker = node.type === 'ul' ? '• ' : node.type === 'ol' ? `${Number.isSafeInteger(node.index) && node.index >= 0 ? node.index + 1 : 1}. ` : '';
        return children.some(child => child === null) ? null : [...(marker ? [{ text: marker }] : []), ...children.flat(), { text: '\n' }];
      }
      if (node.elements != null && (!Array.isArray(node.elements) || node.elements.length)) return null;
      if (node.type === 'text') {
        const content = node.style_content;
        if (content && (typeof content !== 'object' || typeof content.text !== 'string')) return null;
        const body = content ? content.text : node.text_content?.content;
        if (typeof body !== 'string') return null;
        const url = content?.url;
        if (url && !safeSourceUrl(url)) return null;
        const sourceStyle = content?.style || {};
        const style = Object.fromEntries(['bold', 'italic', 'underline', 'strike', 'code'].filter(key => sourceStyle[key] === true).map(key => [key, true]));
        return [{ text: body, style, ...(url ? { href: safeSourceUrl(url) } : {}) }];
      }
      if (node.type === 'mention') {
        const name = node.mention_content?.text;
        return typeof name === 'string' && name.trim() && !/[<>]/.test(name)
          ? [{ text: `<mention>${name.replace(/^@/, '')}</mention>` }] : null;
      }
      if (node.type === 'image') return node.image_content && typeof node.image_content === 'object' ? [{ text: '[图片附件]' }] : null;
      const title = node.doc_content?.text, url = node.doc_content?.file?.link_url;
      if (typeof title !== 'string' || (url !== undefined && !safeSourceUrl(url))) return null;
      return [{ text: title, ...(url ? { href: safeSourceUrl(url) } : {}) }];
    };
    const nodes = envelope.rich_text.elements.map(node => decode(node, 0));
    return nodes.some(node => node === null) ? null : nodes.flat();
  } catch { return null; }
}

// Imported excerpts can end inside a JSON string. Recover only fully closed,
// recognized leaf nodes, never fabricate the missing suffix or its conclusions.
export function partialRichMessageRuns(value) {
  if (typeof value !== 'string' || value.length > 1000000 || !/^\s*\{\s*"rich_text"\s*:\s*\{\s*"elements"\s*:\s*\[/.test(value)) return null;
  try { JSON.parse(value); return null; } catch { /* Partial source only. */ }
  const keys = {
    root: ['rich_text'], rich: ['elements'],
    node: ['type', 'alt_text', 'elements', 'indent', 'index', 'style_content', 'text_content', 'mention_content', 'doc_content', 'image_content'],
    style_content: ['style', 'text', 'url', 'url_title'], style: ['bold', 'color', 'italic', 'strike', 'underline', 'code'],
    text_content: ['content'], mention_content: ['identity', 'text', 'type'], identity: ['id', 'user_id', 'identity_id', 'company_id'],
    doc_content: ['text', 'file'], file: ['link_url', 'link_id', 'id', 'name', 'type'],
    image_content: ['type', 'storage_key', 'url', 'download_url', 'name', 'width', 'height', 'size', 'thumbnail_storage_key', 'thumbnail_type'],
  };
  const stack = [], runs = [];
  for (let i = 0; i < value.length; i++) {
    const char = value[i], parent = stack.at(-1);
    if (char === '"') {
      let end = i + 1;
      for (; end < value.length; end++) { if (value[end] === '\\') end++; else if (value[end] === '"') break; }
      if (end >= value.length) break;
      let token; try { token = JSON.parse(value.slice(i, end + 1)); } catch { return null; }
      let next = end + 1; while (/\s/.test(value[next] || '') && next < value.length) next++;
      if (value[next] === ':') {
        if (!keys[parent?.role]?.includes(token)) return null;
        parent.key = token;
      } else if (parent?.role === 'node' && parent.key === 'type' && !['nl', 'ol', 'ul', 'text', 'mention', 'doc', 'image'].includes(token)) return null;
      i = end;
    } else if (char === '{' || char === '[') {
      if (stack.length > 30) return null;
      const role = !parent ? 'root' : parent.role === 'nodes' ? 'node'
        : parent.role === 'root' && parent.key === 'rich_text' ? 'rich'
        : ['rich', 'node'].includes(parent.role) && parent.key === 'elements' ? 'nodes'
        : parent.key;
      if (char === '[' ? role !== 'nodes' : !keys[role]) return null;
      stack.push({role, start:i, runStart:runs.length, char});
    } else if (char === '}' || char === ']') {
      const frame = stack.pop();
      if (!frame || (char === '}' ? frame.char !== '{' : frame.char !== '[')) return null;
      if (frame.role !== 'node') continue;
      let node; try { node = JSON.parse(value.slice(frame.start, i + 1)); } catch { return null; }
      const decoded = richMessageRuns(JSON.stringify({rich_text:{elements:[node]}}));
      if (!decoded) return null;
      // Replace any collected descendants with the complete parent, preserving
      // original paragraph/list boundaries rather than splitting styled runs.
      runs.splice(frame.runStart, runs.length - frame.runStart, ...decoded);
      if (runs.length > 1000) return null;
    }
  }
  return runs.length ? runs : null;
}

export function cleanMentions(value = '') {
  return unwrapTextEnvelope(value)
    .replace(/<(?:at|mention)\b[^>]*>([\s\S]*?)<\/(?:at|mention)>/gi, (_, name) => `@${name.replace(/<[^>]*>/g, '').trim() || '未识别成员'}`)
    .replace(/<(?:at|mention)\b[^>]*\/?>/gi, '@未识别成员')
    .replace(/@_user_\d+/g, '@未识别成员');
}

export function createPresenter(dataset, masked, display = {}) {
  const names = new Set();
  const collectMentionIdentities = value => {
    if (typeof value === 'string') {
      value = unwrapTextEnvelope(value);
      // Participant tokens can occur only in prose, without a speaker row.
      for (const match of value.matchAll(/(?<![A-Za-z0-9_])P\d{2,}(?![A-Za-z0-9_])/g)) names.add(match[0]);
      for (const match of value.matchAll(/<(?:at|mention)\b[^>]*>([\s\S]*?)<\/(?:at|mention)>/gi)) {
        const name = match[1].replace(/<[^>]*>/g, '').trim();
        if (name) names.add(name);
      }
    } else if (Array.isArray(value)) value.forEach(collectMentionIdentities);
    else if (value && typeof value === 'object') Object.values(value).forEach(collectMentionIdentities);
  };
  for (const item of dataset.cases) {
    for (const evidence of item.evidence) names.add(evidence.speaker);
    for (const run of item.runs) for (const view of run.answer?.viewpoints || []) {
      // A private verified roster outranks entity labels supplied by a model.
      if (!display.participants?.length || /^P\d{2,}$/.test(view.person)) names.add(view.person);
    }
    collectMentionIdentities(item);
  }
  collectMentionIdentities(display.case_titles);
  const identities = new Map();
  const namedIdentities = new Map();
  let count = 0;
  for (const participant of display.participants || []) {
    const label = `成员 ${String(++count).padStart(2, '0')}`;
    const identity = { key: participant.alias, masked: label, visible: participant.display_name || '姓名待确认', status: participant.display_name ? 'verified' : 'unknown' };
    identities.set(participant.alias, identity);
    if (participant.display_name) {
      if (!namedIdentities.has(participant.display_name)) namedIdentities.set(participant.display_name, []);
      namedIdentities.get(participant.display_name).push(identity);
    }
  }
  for (const [name, matches] of namedIdentities) {
    if (matches.length === 1) identities.set(name, matches[0]);
    else {
      matches.forEach(identity => { identity.visible = `${name}（${identity.masked}）`; });
      identities.set(name, { masked: '同名成员（身份未确认）', visible: `${name}（身份未确认）`, status: 'ambiguous' });
    }
  }
  for (const name of names) {
    if (!name || /^(unknown|未知|身份未知|未识别|未识别成员)$/i.test(name) || identities.has(name)) continue;
    const unresolved = /^P\d{2,}$/.test(name);
    identities.set(name, { key: name, masked: `成员 ${String(++count).padStart(2, '0')}`, visible: unresolved ? '姓名待确认' : name, status: unresolved ? 'unknown' : 'source' });
  }
  identities.set('未识别成员', { masked: '姓名待确认', visible: '姓名待确认', status: 'unknown' });
  const pattern = [...identities.keys()].sort((a, b) => b.length - a.length)
    .map(name => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return /^P\d+$/.test(name) ? `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])` : escaped;
    }).join('|');
  const personPart = (identity, mentioned = false) => {
    const label = identity[masked ? 'masked' : 'visible'];
    return { type: 'person', key: identity.key, label, text: `${mentioned ? '@' : ''}${label}`, status: masked ? 'anonymous' : identity.status };
  };
  const parts = (value = '', limit) => {
    // Protect whole links and email addresses before an alias can insert spaces
    // into them. Visible mode also preserves their original spelling.
    const protectedParts = cleanMentions(value).split(/((?:https?:\/\/|www\.)[^\s<>"）)]+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b)/gi);
    const result = [];
    for (const [index, part] of protectedParts.entries()) {
      if (!part) continue;
      if (index % 2) {
        result.push({ type: 'text', text: masked ? (/^(?:https?:\/\/|www\.)/i.test(part) ? '［链接已隐藏］' : '［邮箱已隐藏］') : part });
        continue;
      }
      let offset = 0;
      // Consume an existing @ so a structured mention renders it exactly once.
      for (const match of part.matchAll(new RegExp(`@?(${pattern})`, 'g'))) {
        if (match.index > offset) result.push({ type: 'text', text: part.slice(offset, match.index) });
        result.push(personPart(identities.get(match[1]), match[0].startsWith('@')));
        offset = match.index + match[0].length;
      }
      if (offset < part.length) result.push({ type: 'text', text: part.slice(offset) });
    }
    if (!Number.isFinite(limit)) return result;
    const bounded = [];
    let remaining = Math.max(0, limit);
    for (const part of result) {
      const length = Array.from(part.text).length;
      if (length <= remaining) { bounded.push(part); remaining -= length; continue; }
      if (part.type === 'text' && remaining) bounded.push({ type: 'text', text: Array.from(part.text).slice(0, remaining).join('') });
      bounded.push({ type: 'text', text: '…' });
      break;
    }
    return bounded;
  };
  const present = value => parts(value).map(part => part.text).join('');
  present.parts = parts;
  present.person = value => /^(unknown|未知|身份未知|未识别|未识别成员)$/i.test(String(value).trim())
    ? [personPart({ masked: '姓名待确认', visible: '姓名待确认', status: 'unknown' })]
    : parts(value);
  present.hasPerson = (value, person) => {
    const keys = new Set(present.person(person).filter(part => part.type === 'person' && part.key).map(part => part.key));
    return parts(value).some(part => part.type === 'person' && keys.has(part.key));
  };
  present.relatedRecords = (person, item) => {
    const result = { spoken: [], mentioned: [] };
    if (!person.key || !item) return result;
    for (const evidence of item.evidence) {
      if (present.person(evidence.speaker).some(part => part.key === person.key)) result.spoken.push(evidence);
      else if (parts(evidence.text).some(part => part.key === person.key)) result.mentioned.push(evidence);
    }
    return result;
  };
  return present;
}

export const identityPreferenceKey = 'third-brain:identity-display:v2';

export function readIdentityMode(storage) {
  try {
    const preference = JSON.parse(storage.getItem(identityPreferenceKey) || 'null');
    return preference?.version === 2 && preference.source === 'explicit' && ['identified', 'anonymous'].includes(preference.mode)
      ? preference.mode : 'identified';
  } catch { return 'identified'; }
}

export function saveIdentityMode(mode, storage) {
  if (!['identified', 'anonymous'].includes(mode)) throw new Error('Invalid identity display mode');
  storage.setItem(identityPreferenceKey, JSON.stringify({ version: 2, source: 'explicit', mode }));
}

export function excerpt(value, limit = 88) {
  const characters = Array.from(String(value).replace(/\s+/g, ' ').trim());
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : characters.join('');
}

export function scopeLabel(value) {
  const match = String(value).match(/^(\d+) approved IM conversations,\s*(\d+)h; all returned messages retained including nontext placeholders$/);
  return match ? `已接入的${match[1]}个会话 · 最近${match[2]}小时 · 含未读取附件占位` : value;
}

// Shared evidence is counted once across questions. Conflicting uses of an ID
// stay separate so a bad identifier cannot silently discard a source.
export function datasetEvidence(dataset) {
  const byId = new Map();
  const records = [];
  for (const item of dataset.cases) for (const evidence of item.evidence) {
    const signature = JSON.stringify(['source_type', 'source_title', 'occurred_at', 'speaker', 'text', 'url', 'locator'].map(key => evidence[key] ?? null));
    if (!byId.has(evidence.id)) byId.set(evidence.id, new Map());
    const variants = byId.get(evidence.id);
    if (!variants.has(signature)) {
      const record = { item, evidence, caseIds: [] };
      variants.set(signature, record);
      records.push(record);
    }
    variants.get(signature).caseIds.push(item.id);
  }
  return { records, conflictingIds: [...byId.values()].filter(variants => variants.size > 1).length };
}

export function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

const evidenceTime = evidence => {
  const value = Date.parse(evidence?.occurred_at);
  return Number.isFinite(value) ? value : null;
};

export function latestEvidenceTime(evidence = []) {
  return evidence.reduce((latest, row) => {
    const value = evidenceTime(row);
    return value === null ? latest : latest === null ? value : Math.max(latest, value);
  }, null);
}

export function compareEvidenceRecency(first, second) {
  const a = evidenceTime(first), b = evidenceTime(second);
  return a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a;
}

export function dateLabel(value, time = false) {
  if (value === null || value === undefined || value === '') return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', ...(time ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
    timeZone: 'Asia/Shanghai',
  }).format(date);
}

export function blindRuns(item) {
  const hash = value => [...value].reduce((result, char) => Math.imul(result ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261);
  return [...item.runs].sort((a, b) => hash(`${item.id}/${a.id}`) - hash(`${item.id}/${b.id}`))
    .map((run, index) => ({ ...run, alias: `答案 ${String(index + 1).padStart(2, '0')}` }));
}

export function initialAnswerPair(item, demo, guide) {
  const runs = blindRuns(item);
  const readable = runs.filter(run => run.answer && (demo || run.status === 'VERIFIED'));
  const leftId = guide?.run_id || readable[0]?.id || runs[0]?.id;
  const rightId = guide?.comparison_run_id || readable.find(run => run.id !== leftId)?.id;
  return { runs, leftId, rightId, canCompare: readable.length > 1 };
}

// Model metadata is separate from participant display and anonymous identities.
export function modelLabel(model) {
  return {
    'gpt-6-astra': 'GPT-6 Astra',
    'deepseek-v4-flash': 'DeepSeek V4 Flash',
    'deepseek-v4-pro': 'DeepSeek V4 Pro',
    'mimo-v2.5': 'MiMo V2.5',
    'glm-5.3-flash': 'GLM-5.3 Flash',
  }[model] || String(model || '模型未提供');
}

export function routeLabel(route) {
  return { A: 'A 原文', B: 'B 档案', C: 'C 检索' }[route] || `路线 ${route || '未提供'}`;
}

export function runLabel(run, visible = true) {
  return visible ? `${run.alias} · ${modelLabel(run.model)} · ${routeLabel(run.route)}` : run.alias;
}

export function recordModelExposure(reviewKey, storage) {
  storage.setItem(reviewKey + 'exposed', 'true');
}

export async function datasetFingerprint(dataset) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(dataset)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function readReviews(key, storage) {
  const saved = storage.getItem(key);
  if (!saved) return [];
  const value = JSON.parse(saved);
  if (!Array.isArray(value)) throw new Error('Invalid review storage');
  return value;
}

export function saveReview(key, record, storage) {
  const records = readReviews(key, storage);
  const identity = row => JSON.stringify([row.case_id, row.run_ids]);
  const next = [...records.filter(row => identity(row) !== identity(record)), record];
  storage.setItem(key, JSON.stringify(next));
  return next;
}
