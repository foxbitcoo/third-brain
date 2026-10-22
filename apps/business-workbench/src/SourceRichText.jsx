import React from 'react';
import { cleanMentions, partialRichMessageRuns, richMessageRuns } from './presentation.mjs';

export default function SourceRichText({ value, renderText = cleanMentions, allowLinks = true }) {
  const complete = richMessageRuns(value);
  const runs = complete || partialRichMessageRuns(value);
  if (!runs) return <>{renderText(value)}</>;
  return <span className="source-rich-text">{!complete && <span className="source-partial-note">原文片段 · 内容不完整，仅展示已留存的完整文字段落<br /></span>}{runs.map((run, index) => {
    let body = renderText(run.text);
    if (run.style?.code) body = <code>{body}</code>;
    if (run.style?.bold) body = <strong>{body}</strong>;
    if (run.style?.italic) body = <em>{body}</em>;
    if (run.style?.underline) body = <u>{body}</u>;
    if (run.style?.strike) body = <s>{body}</s>;
    return <React.Fragment key={index}>{run.href && allowLinks
      ? <a href={run.href} target="_blank" rel="noopener noreferrer">{body}</a> : body}</React.Fragment>;
  })}{!complete && <details className="source-partial-original"><summary>查看保留的原文片段</summary><code>{value}</code></details>}</span>;
}
