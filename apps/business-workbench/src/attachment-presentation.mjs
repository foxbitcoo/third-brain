// Presentation only: missing pipeline receipts must never imply a download failure.
export function evidenceDisplayText(evidence = {}) {
  const text = typeof evidence.text === 'string' ? evidence.text : '';
  return text.replaceAll('[图片未读取]', '[图片内容未纳入本条依据；资料未记录获取或识别结果]');
}
