import test from 'node:test';
import assert from 'node:assert/strict';
import { worklineTruthUrl } from '../src/workline-truth.mjs';

const archiveHost = ['example','feishu','cn'].join('.');
const guides = [
  { case_id: 'alpha', answer_url: `https://${archiveHost}/docx/archive#alpha` },
  { case_id: 'beta', answer_url: `https://${archiveHost}/docx/archive#beta` },
];

test('uses exact case identity and retains the chapter anchor across renamed or reordered work', () => {
  assert.equal(worklineTruthUrl([...guides].reverse(), 'alpha'), guides[0].answer_url);
  assert.equal(worklineTruthUrl(guides, 'beta'), guides[1].answer_url);
  assert.equal(worklineTruthUrl(guides, 'new-work'), null);
  assert.equal(worklineTruthUrl([...guides, guides[0]], 'alpha'), null);
});

test('does not disclose private archive links in anonymous mode or the public demo', () => {
  assert.equal(worklineTruthUrl(guides, 'alpha', { masked: true }), null);
  assert.equal(worklineTruthUrl(guides, 'alpha', { demo: true }), null);
});

test('rejects missing, unsafe and non-document destinations instead of inventing a fallback', () => {
  for (const answer_url of [null, '', 'javascript:alert(1)', `http://${archiveHost}/docx/archive`,
    `https://${archiveHost}.evil.invalid/docx/archive`, `https://user:pass@${archiveHost}/docx/archive`,
    'https://example.feishu.cn/', 'https://example.invalid/docx/archive']) {
    assert.equal(worklineTruthUrl([{ case_id: 'alpha', answer_url }], 'alpha'), null);
  }
});
