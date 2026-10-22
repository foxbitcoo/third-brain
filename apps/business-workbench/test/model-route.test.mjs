import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TEXT_MODEL, DEFAULT_VISION_MODEL, getTextModelRoute, getVisionModelRoute, buildTextExtractionRequest } from '../model-route.mjs';

const messages = [{ role: 'system', content: 'Return JSON.' }, { role: 'user', content: 'Connection check.' }];

test('text extraction defaults to V4 Pro with the existing non-thinking JSON contract', () => {
  assert.equal(DEFAULT_TEXT_MODEL, 'deepseek-v4-pro');
  assert.deepEqual(buildTextExtractionRequest({ messages }), { model: 'deepseek-v4-pro', thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, max_tokens: 1000, messages });
});

test('explicit text model override is preserved and unknown models fail', () => {
  assert.equal(buildTextExtractionRequest({ messages, model: 'deepseek-flash', maxTokens: 2500 }).model, 'deepseek-flash');
  assert.throws(() => getTextModelRoute({ model: 'unverified-model' }), /UNSUPPORTED_TEXT_MODEL/);
});

test('OCR retains Flash and never sends image input through the text request', () => {
  assert.equal(DEFAULT_VISION_MODEL, 'deepseek-flash');
  assert.equal(getVisionModelRoute().model, 'deepseek-flash');
  for (const model of ['deepseek-v4-pro', 'deepseek-flash']) {
    for (const part of [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }, { type: 'input_image', image_url: 'https://example.com/image.png' }, { type: 'file', file: { file_id: 'test' } }]) {
      assert.throws(() => buildTextExtractionRequest({ model, messages: [{ role: 'user', content: [part] }] }), /TEXT_ROUTE_REQUIRES_TEXT_ONLY/);
    }
  }
});

test('request validation rejects empty messages, invalid roles, metadata payloads and token limits', () => {
  assert.throws(() => buildTextExtractionRequest({ messages: [] }), /TEXT_MESSAGES_REQUIRED/);
  assert.throws(() => buildTextExtractionRequest({ messages: [{ role: 'tool', content: 'test' }] }), /INVALID_MESSAGE_ROLE/);
  assert.throws(() => buildTextExtractionRequest({ messages: [{ role: 'user', content: 'text', image_url: 'test' }] }), /UNSUPPORTED_MESSAGE_FIELD/);
  for (const maxTokens of [0, 1.5, 393217]) assert.throws(() => buildTextExtractionRequest({ messages, maxTokens }), /INVALID_MAX_TOKENS/);
});

test('caller input and returned route objects remain independent', () => {
  const input = [{ role: 'user', content: [{ type: 'text', text: 'Original evidence' }] }];
  const request = buildTextExtractionRequest({ messages: input });
  request.messages[0].content[0].text = 'Changed';
  assert.equal(input[0].content[0].text, 'Original evidence');
  const route = getTextModelRoute(); route.thinking.type = 'enabled';
  assert.equal(getTextModelRoute().thinking.type, 'disabled');
});
