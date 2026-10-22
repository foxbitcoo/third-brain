import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceDisplayText } from '../src/attachment-presentation.mjs';

test('legacy image placeholders distinguish missing receipts from download failure', () => {
  const original = { text: '[图片未读取]\n正文 @某人\n[图片未读取]\n[图片未读取]' };
  const result = evidenceDisplayText(original);
  assert.equal((result.match(/资料未记录获取或识别结果/g) || []).length, 3);
  assert.ok(result.includes('正文 @某人'));
  assert.ok(!result.includes('下载失败'));
  assert.ok(!result.includes('无权限'));
  assert.equal(original.text.split('[图片未读取]').length, 4);
});

test('explicit verified stage labels and ordinary source text remain untouched', () => {
  const text = '[图片已记录；尚未获取与识别]\n原文未变';
  assert.equal(evidenceDisplayText({text}), text);
  assert.equal(evidenceDisplayText({text:'没有图片'}), '没有图片');
  assert.equal(evidenceDisplayText({}), '');
});
