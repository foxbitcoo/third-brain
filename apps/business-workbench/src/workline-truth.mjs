// Bind to the selected case ID; never guess a document from its title or rank.
export function worklineTruthUrl(guides, caseId, { masked = false, demo = false } = {}) {
  if (masked || demo || !caseId) return null;
  const matches = (guides || []).filter(guide => guide.case_id === caseId);
  if (matches.length !== 1 || typeof matches[0].answer_url !== 'string') return null;
  try {
    const url = new URL(matches[0].answer_url);
    return url.protocol === 'https:' && !url.username && !url.password
      && (url.hostname === 'feishu.cn' || url.hostname.endsWith('.feishu.cn'))
      && /^\/(docx|wiki)\/[^/]+$/.test(url.pathname) ? url.href : null;
  } catch { return null; }
}
