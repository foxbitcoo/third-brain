/** Text understanding and visual OCR have separate model capabilities. */
export const DEFAULT_TEXT_MODEL = 'deepseek-v4-pro';
export const DEFAULT_VISION_MODEL = 'deepseek-flash';
export const MODEL_ROUTE_VERSION = 'deepseek-pro-text-v1';

const TEXT_MODELS = new Set([DEFAULT_TEXT_MODEL, DEFAULT_VISION_MODEL]);

/** Explicit overrides are recorded by callers; unsupported IDs fail closed. */
export function getTextModelRoute({ model = DEFAULT_TEXT_MODEL } = {}) {
  if (!TEXT_MODELS.has(model)) throw new TypeError('UNSUPPORTED_TEXT_MODEL');
  return { model, thinking: { type: 'disabled' }, response_format: { type: 'json_object' } };
}

/** Pro is text-only; images must go through the separate visual OCR route. */
export function getVisionModelRoute() {
  return { model: DEFAULT_VISION_MODEL, thinking: { type: 'disabled' } };
}

export function buildTextExtractionRequest({ messages, model, maxTokens = 1000 } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) throw new TypeError('TEXT_MESSAGES_REQUIRED');
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 393216) throw new RangeError('INVALID_MAX_TOKENS');
  for (const message of messages) {
    if (!message || !['system', 'user', 'assistant'].includes(message.role)) throw new TypeError('INVALID_MESSAGE_ROLE');
    const content = message.content;
    if (typeof content !== 'string' && !(Array.isArray(content) && content.length > 0 && content.every(part => part?.type === 'text' && typeof part.text === 'string'))) {
      throw new TypeError('TEXT_ROUTE_REQUIRES_TEXT_ONLY');
    }
    // Do not permit ignored extra fields to carry unsupported multimodal input.
    if (Object.keys(message).some(key => !['role', 'content'].includes(key))) throw new TypeError('UNSUPPORTED_MESSAGE_FIELD');
  }
  return { ...getTextModelRoute({ model }), max_tokens: maxTokens, messages: structuredClone(messages) };
}
