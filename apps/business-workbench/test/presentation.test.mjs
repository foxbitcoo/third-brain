import test from 'node:test';
import assert from 'node:assert/strict';
import { latestEvidenceTime, compareEvidenceRecency, dateLabel, blindRuns, cleanMentions, createPresenter, datasetEvidence, datasetFingerprint, excerpt, identityPreferenceKey, initialAnswerPair, modelLabel, readIdentityMode, readReviews, richMessageRuns, partialRichMessageRuns, recordModelExposure, routeLabel, runLabel, safeSourceUrl, saveIdentityMode, saveReview, scopeLabel } from '../src/presentation.mjs';

test('tagged mentions are readable text without trusting markup or inventing an identity', () => {
  assert.equal(cleanMentions('<at user_id="opaque">示例同事</at> 说明 <mention id="opaque"/> @_user_42'), '@示例同事 说明 @未识别成员 @未识别成员');
});

test('known text-message envelopes display their body while unknown JSON stays intact', () => {
  assert.equal(cleanMentions(JSON.stringify({ text: { content: '日活给7天日均\n保留第二行' } })), '日活给7天日均\n保留第二行');
  for (const value of ['{"text":', '{"text":{"content":7}}', '{"text":{"content":"正文","extra":"保留"}}', '{"text":{"content":"正文"},"attachment":"保留"}', '{"content":"普通JSON"}']) {
    assert.equal(cleanMentions(value), value);
  }
});

test('text-message decoding precedes identity collection, mentions and anonymous masking without changing evidence', () => {
  const text = '{"text":{"content":"<at id=\\"opaque\\">\\u53e6\\u4e00\\u4f4d\\u6210\\u5458</at> 请看 https://example.invalid/private foo@example.invalid"}}';
  const dataset = { cases: [{ evidence: [{ speaker: '审阅者', text }], runs: [] }] };
  const original = structuredClone(dataset);
  assert.equal(createPresenter(dataset, false)(text), '@另一位成员 请看 https://example.invalid/private foo@example.invalid');
  assert.equal(createPresenter(dataset, true)(text), '@成员 02 请看 ［链接已隐藏］ ［邮箱已隐藏］');
  assert.deepEqual(dataset, original);
});

test('recognized rich-message nodes display text, mentions, documents and neutral attachment placeholders', () => {
  const text = JSON.stringify({ rich_text: { elements: [{ type: 'nl', elements: [
    { type: 'mention', mention_content: { text: '另一位成员' }, elements: null },
    { type: 'text', text_content: { content: ' 请核对\n' }, elements: null },
    { type: 'doc', doc_content: { text: '需求文档', file: { link_url: 'https://example.invalid/doc' } }, elements: null },
    { type: 'image', image_content: { storage_key: 'not-for-display' }, elements: null },
  ] }] } });
  const dataset = { cases: [{ evidence: [{ speaker: '审阅者', text }], runs: [] }] };
  const original = structuredClone(dataset);
  assert.equal(createPresenter(dataset, false)(text), '@另一位成员 请核对\n需求文档 https://example.invalid/doc [图片附件]');
  assert.equal(createPresenter(dataset, true)(text), '@成员 02 请核对\n需求文档 ［链接已隐藏］ [图片附件]');
  assert.deepEqual(dataset, original);
});

test('unknown or overly deep rich messages retain the entire original instead of dropping content', () => {
  const unknown = { type: 'unsupported', payload: '必须保留' };
  const unsafe = { type: 'doc', doc_content: { text: '文档', file: { link_url: 'javascript:alert(1)' } } };
  let deep = { type: 'text', text_content: { content: '必须保留' } };
  for (let i = 0; i < 10; i++) deep = { type: 'nl', elements: [deep] };
  for (const node of [unknown, unsafe, deep, { type: 'text', text_content: { content: '已知' }, unknown_content: '必须保留' }]) {
    const value = JSON.stringify({ rich_text: { elements: [{ type: 'text', text_content: { content: '前文' } }, node] } });
    assert.equal(cleanMentions(value), value);
  }
});

test('masking covers known identities in prose, source locators, mentions, email and URLs', () => {
  const dataset = { cases: [{ evidence: [{ speaker: '示例同事' }, { speaker: 'unknown' }], runs: [{ answer: { viewpoints: [{ person: '示例负责人' }] } }] }] };
  const present = createPresenter(dataset, true);
  assert.equal(present('<at id="123">示例同事</at> 与示例负责人'), '@成员 01 与成员 02');
  assert.equal(present('示例同事 https://example.invalid/private?a=1 foo@example.invalid'), '成员 01 ［链接已隐藏］ ［邮箱已隐藏］');
  assert.equal(present('unknown'), 'unknown');
  assert.equal(createPresenter(dataset, false)('<at id="123">示例同事</at>'), '@示例同事');
});

test('identity alias replacement is a single pass even when names overlap', () => {
  const present = createPresenter({ cases: [{ evidence: [{ speaker: '成员' }, { speaker: '成员乙' }], runs: [] }] }, true);
  assert.equal(present('成员乙 成员'), '成员 02 成员 01');
});

test('masking includes explicitly mentioned people who never speak or appear in viewpoints', () => {
  const dataset = { cases: [{ evidence: [{ speaker: '审阅者', text: '<at user_id="neutral">另一位成员</at> 请看这份资料。' }], runs: [] }] };
  assert.equal(createPresenter(dataset, true)(dataset.cases[0].evidence[0].text), '@成员 02 请看这份资料。');
});

test('private display mapping unifies aliases, verified names and mention-only people without changing answers', () => {
  const dataset = { cases: [{ evidence: [{ speaker: 'P01', text: 'P02提出建议；示例乙回应。' }], runs: [{ answer: { summary: 'P02提出建议。', viewpoints: [] } }] }] };
  const original = structuredClone(dataset);
  const display = { participants: [{ alias: 'P01', display_name: null }, { alias: 'P02', display_name: '示例乙' }] };
  const hidden = createPresenter(dataset, true, display);
  const visible = createPresenter(dataset, false, display);
  assert.equal(hidden('P01 P02 <at id="neutral">示例乙</at>'), '成员 01 成员 02 @成员 02');
  assert.equal(visible('P01 P02'), '姓名待确认 示例乙');
  assert.equal(hidden('数据源与知识库接入 HTML数据看板'), '数据源与知识库接入 HTML数据看板');
  assert.deepEqual(dataset, original);
});

test('plain participant tokens are masked without a speaker entry and cannot replace parts of business IDs', () => {
  const dataset = { cases: [{ evidence: [], runs: [{ answer: { summary: '请P02补充。', viewpoints: [] } }] }] };
  const present = createPresenter(dataset, true);
  assert.equal(present('请P02补充，KEEP02和P02X不变。'), '请成员 01补充，KEEP02和P02X不变。');
});

test('display-only titles also contribute explicit mentions and participant aliases to masking', () => {
  const display = { case_titles: { one: '<at>标题中成员</at>与P02的业务方案' } };
  const value = createPresenter({ cases: [] }, true, display)(display.case_titles.one);
  assert.ok(!value.includes('标题中成员') && !value.includes('P02'));
  assert.ok(value.endsWith('的业务方案'));
});

test('same-name people remain distinct and a bare name keeps its unresolved identity', () => {
  const display = { participants: [{ alias: 'P01', display_name: '同名甲' }, { alias: 'P02', display_name: '同名甲' }] };
  assert.equal(createPresenter({ cases: [] }, true, display)('P01 P02 同名甲'), '成员 01 成员 02 同名成员（身份未确认）');
  assert.equal(createPresenter({ cases: [] }, false, display)('P01 P02 同名甲'), '同名甲（成员 01） 同名甲（成员 02） 同名甲（身份未确认）');
});

test('identity tokens inside links or email cannot leave private path fragments after masking', () => {
  const dataset = { cases: [{ evidence: [{ speaker: 'P01' }], runs: [] }] };
  const original = 'P01 https://internal.invalid/P01/private-token P01@internal.invalid';
  assert.equal(createPresenter(dataset, true)(original), '成员 01 ［链接已隐藏］ ［邮箱已隐藏］');
  const display = { participants: [{ alias: 'P01', display_name: '示例甲' }] };
  assert.equal(createPresenter(dataset, false, display)(original), '示例甲 https://internal.invalid/P01/private-token P01@internal.invalid');
});

test('rich text recognizes verified people across prose and tags but leaves URLs, email and model entity labels intact', () => {
  const dataset = { cases: [{ evidence: [{ speaker: 'P02', text: '普通资料' }], runs: [{ answer: { viewpoints: [{ person: '示例公司' }] } }] }] };
  const present = createPresenter(dataset, false, { participants: [{ alias: 'P02', display_name: '示例乙' }] });
  const text = 'P02与@示例乙及<at id="x">P02</at>讨论示例公司 https://example.invalid/P02 P02@example.invalid。';
  const parts = present.parts(text);
  assert.deepEqual(parts.filter(part => part.type === 'person').map(({ key, label, text }) => ({ key, label, text })), [
    { key: 'P02', label: '示例乙', text: '示例乙' },
    { key: 'P02', label: '示例乙', text: '@示例乙' },
    { key: 'P02', label: '示例乙', text: '@示例乙' },
  ]);
  assert.ok(parts.filter(part => part.type === 'text').map(part => part.text).join('').includes('示例公司 https://example.invalid/P02 P02@example.invalid。'));
  assert.ok(present.hasPerson('示例乙表示可以继续。', 'P02'));
  assert.ok(!present.hasPerson('由另一位同事继续。', 'P02'));
});

test('unknown people keep a neutral unresolved label and excerpts never cut a person token', () => {
  const present = createPresenter({ cases: [] }, false, { participants: [{ alias: 'P01', display_name: null }, { alias: 'P02', display_name: '示例乙' }] });
  for (const value of ['P01', 'unknown', '未识别成员']) {
    assert.equal(present.person(value)[0].label, '姓名待确认');
    assert.equal(present.person(value)[0].status, 'unknown');
  }
  assert.equal(present.parts('请P02继续', 3).map(part => part.text).join(''), '请…');
  assert.equal(present.parts('请P02继续', 4).map(part => part.text).join(''), '请示例乙…');
});

test('person records distinguish authored messages from mention-only messages without changing either', () => {
  const item = { evidence: [
    { id: 'spoken', speaker: 'P02', text: 'P02说明当前状态。' },
    { id: 'mentioned', speaker: 'P03', text: '<at>P02</at> 请补充。' },
    { id: 'unrelated', speaker: 'P03', text: 'https://example.invalid/P02 P02@example.invalid KEEP02' },
  ], runs: [] };
  const original = structuredClone(item);
  const display = { participants: [{ alias: 'P02', display_name: '示例乙' }, { alias: 'P03', display_name: '示例丙' }] };
  for (const masked of [false, true]) {
    const present = createPresenter({ cases: [item] }, masked, display);
    const related = present.relatedRecords(present.person('P02')[0], item);
    assert.deepEqual(related.spoken.map(record => record.id), ['spoken']);
    assert.deepEqual(related.mentioned.map(record => record.id), ['mentioned']);
    assert.deepEqual(present.relatedRecords(present.person('unknown')[0], item), { spoken: [], mentioned: [] });
  }
  assert.deepEqual(item, original);
});

test('ambiguous same-name mentions do not acquire either verified person as their speaker', () => {
  const item = { evidence: [{ id: 'one', speaker: 'P01', text: '同名甲补充资料。' }], runs: [] };
  const present = createPresenter({ cases: [item] }, false, { participants: [{ alias: 'P01', display_name: '同名甲' }, { alias: 'P02', display_name: '同名甲' }] });
  assert.deepEqual(present.relatedRecords(present.person('同名甲')[0], item), { spoken: [], mentioned: [] });
  assert.equal(present.hasPerson('同名甲表示同意。', 'P02'), false);
});

test('identity display defaults to names unless the browser stores an explicit current anonymous choice', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  for (const value of [undefined, 'true', '{broken', JSON.stringify({ mode: 'anonymous' }), JSON.stringify({ version: 2, source: 'default', mode: 'anonymous' })]) {
    values.set(identityPreferenceKey, value);
    assert.equal(readIdentityMode(storage), 'identified');
  }
  saveIdentityMode('anonymous', storage);
  assert.equal(readIdentityMode(storage), 'anonymous');
  saveIdentityMode('identified', storage);
  assert.equal(readIdentityMode(storage), 'identified');
  assert.equal(readIdentityMode({ getItem: () => { throw new Error('unavailable'); } }), 'identified');
  assert.throws(() => saveIdentityMode('anonymous', { setItem: () => { throw new Error('quota'); } }));
});

test('shared evidence is counted once across cases while case-level sources remain complete', () => {
  const source = { id: 'shared', source_type: 'im', occurred_at: '2026-09-04T10:00:00Z', text: '同一条记录' };
  const dataset = { cases: ['one', 'two', 'three'].map(id => ({ id, evidence: [structuredClone(source)] })) };
  const original = structuredClone(dataset);
  const { records, conflictingIds } = datasetEvidence(dataset);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].caseIds, ['one', 'two', 'three']);
  assert.equal(conflictingIds, 0);
  assert.deepEqual(dataset, original);
});

test('conflicting evidence IDs retain both contents and equal text under different IDs is not guessed to be one source', () => {
  const dataset = { cases: [{ id: 'a', evidence: [{ id: 'x', text: '甲' }] }, { id: 'b', evidence: [{ id: 'x', text: '乙' }, { id: 'y', text: '甲' }] }] };
  const { records, conflictingIds } = datasetEvidence(dataset);
  assert.equal(records.length, 3);
  assert.equal(conflictingIds, 1);
});

test('overview excerpts are bounded without breaking Unicode while short text stays intact', () => {
  assert.equal(excerpt('短回答'), '短回答');
  assert.equal(excerpt('😀第二句\n第三句', 4), '😀第二句…');
  assert.equal(Array.from(excerpt('很长的业务摘要'.repeat(30))).length, 89);
});

test('source links cannot execute script, embed credentials or open a local file', () => {
  for (const url of ['javascript:alert(1)', 'file:///private/example', 'data:text/html,test', 'https://user:pass@example.invalid', 'relative']) assert.equal(safeSourceUrl(url), null);
  assert.equal(safeSourceUrl('https://example.invalid/source'), 'https://example.invalid/source');
});

test('blind aliases are stable within a case and independent of route/model labels', () => {
  const item = { id: 'neutral-case', runs: [{ id: 'run-a', model: 'one', route: 'A' }, { id: 'run-b', model: 'two', route: 'B' }] };
  const first = blindRuns(item).map(run => [run.id, run.alias]);
  assert.deepEqual(blindRuns({ ...item, runs: item.runs.toReversed().map(run => ({ ...run, model: 'changed', route: 'C' })) }).map(run => [run.id, run.alias]), first);
  assert.deepEqual(first.map(run => run[1]), ['答案 01', '答案 02']);
});

test('a validated reading guide selects its candidate and comparison without reordering or changing the original answer', () => {
  const item = { id: 'neutral-case', runs: ['a', 'b', 'c'].map(id => ({ id, status: 'VERIFIED', route: 'A', model: 'fixture-model', answer: { summary: `Unchanged ${id}` } })) };
  const original = structuredClone(item);
  const ordered = blindRuns(item);
  const guide = { run_id: ordered[2].id, comparison_run_id: ordered[1].id };
  const selection = initialAnswerPair(item, false, guide);
  assert.equal(selection.leftId, ordered[2].id);
  assert.equal(selection.rightId, ordered[1].id);
  assert.deepEqual(selection.runs, ordered);
  assert.deepEqual(item, original);
  const unguided = initialAnswerPair(item, false);
  assert.equal(unguided.leftId, ordered[0].id);
  assert.equal(unguided.rightId, ordered[1].id);
  item.runs.find(run => run.id === ordered[0].id).status = 'FAILED';
  assert.equal(initialAnswerPair(item, false).leftId, ordered[1].id);
});

test('null comparison picks another readable answer and never treats an unavailable run as a second answer', () => {
  const item = { id: 'neutral-case', runs: [
    { id: 'card', status: 'VERIFIED', model: 'fixture-model', answer: { summary: 'Candidate' } },
    { id: 'incomplete', status: 'FAILED', model: 'fixture-model', answer: { summary: 'Partial output' } },
    { id: 'missing', status: 'VERIFIED', model: 'fixture-model', answer: null },
  ] };
  const original = structuredClone(item);
  const guide = { run_id: 'card', comparison_run_id: null };
  const single = initialAnswerPair(item, false, guide);
  assert.equal(single.leftId, 'card');
  assert.equal(single.rightId, undefined);
  assert.equal(single.canCompare, false);
  assert.deepEqual(item, original);
  item.runs.push({ id: 'readable', status: 'VERIFIED', model: 'fixture-model', answer: { summary: 'Comparison' } });
  const pair = initialAnswerPair(item, false, guide);
  assert.equal(pair.rightId, 'readable');
  assert.equal(pair.canCompare, true);
  item.runs = item.runs.slice(0, 1);
  assert.equal(initialAnswerPair(item, false, guide).canCompare, false);
  assert.equal(initialAnswerPair(item, false).rightId, undefined);
});

test('model labels show real versions independently of identity masking and hide without renumbering', () => {
  const run = { alias: '答案 07', model: 'deepseek-v4-flash', route: 'B' };
  assert.equal(runLabel(run), '答案 07 · DeepSeek V4 Flash · B 档案');
  assert.equal(runLabel(run, false), '答案 07');
  assert.equal(modelLabel('gpt-6-astra'), 'GPT-6 Astra');
  assert.equal(modelLabel('deepseek-v4-pro'), 'DeepSeek V4 Pro');
  assert.equal(modelLabel('mimo-v2.5'), 'MiMo V2.5');
  assert.equal(modelLabel('glm-5.3-flash'), 'GLM-5.3 Flash');
  assert.equal(modelLabel('unknown-model-version'), 'unknown-model-version');
  assert.equal(routeLabel('A'), 'A 原文');
  assert.equal(routeLabel('C'), 'C 检索');
});

test('default model exposure preserves old blind reviews and stays separate from identity preferences', () => {
  const oldReview = JSON.stringify([{ case_id: 'neutral-case', run_ids: ['a', 'b'], models_revealed: false, models_visible_at_save: false }]);
  const values = new Map([['review-scope', oldReview], [identityPreferenceKey, '{"version":2,"source":"explicit","mode":"anonymous"}']]);
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  recordModelExposure('review-scope', storage);
  recordModelExposure('review-scope', storage);
  assert.equal(values.get('review-scopeexposed'), 'true');
  assert.equal(values.get('review-scope'), oldReview);
  assert.equal(readIdentityMode(storage), 'anonymous');
  assert.equal(values.size, 3);
});

test('changed answer content cannot inherit an old dataset review scope', async () => {
  assert.notEqual(await datasetFingerprint({ cases: [{ answer: 'first' }] }), await datasetFingerprint({ cases: [{ answer: 'corrected' }] }));
});

test('local review save replaces only the same ordered pair and survives another read', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const record = { case_id: 'neutral-case', run_ids: ['a', 'b'], judgment: 'needs_correction', note: 'Synthetic UI exercise' };
  saveReview('scope-one', record, storage);
  saveReview('scope-one', { ...record, note: 'updated' }, storage);
  saveReview('scope-one', { ...record, run_ids: ['b', 'a'] }, storage);
  assert.equal(readReviews('scope-one', storage).length, 2);
  assert.equal(readReviews('scope-one', storage)[0].note, 'updated');
  assert.deepEqual(readReviews('scope-two', storage), []);
});

test('corrupt or unavailable local review storage cannot be silently overwritten or reported saved', () => {
  const corrupt = { getItem: () => '{broken', setItem: () => assert.fail('must not overwrite corrupt reviews') };
  assert.throws(() => saveReview('key', { case_id: 'x', run_ids: [] }, corrupt));
  assert.throws(() => saveReview('key', { case_id: 'x', run_ids: [] }, { getItem: () => null, setItem: () => { throw new Error('quota'); } }));
});


test('known imported scope is localized without guessing the meaning of other scope text', () => {
  const original = '7 approved IM conversations, 72h; all returned messages retained including nontext placeholders';
  assert.equal(scopeLabel(original), '已接入的7个会话 · 最近72小时 · 含未读取附件占位');
  assert.equal(scopeLabel('another scope with different conditions'), 'another scope with different conditions');
  assert.equal(original.includes('approved IM'), true);
});


test('unknown document business time is labelled unknown rather than the Unix epoch', () => {
  for (const value of [null, undefined, '']) assert.equal(dateLabel(value, true), '时间未知');
  assert.notEqual(dateLabel('2026-10-15T10:00:00Z'), '时间未知');
});


test('valid IM business times survive undated documents and recent evidence keeps known times first', () => {
  const old = { id: 'old-im', occurred_at: '2026-10-14T09:00:00+08:00' };
  const newest = { id: 'new-im', occurred_at: '2026-10-15T10:00:00+08:00' };
  const doc = { id: 'undated-doc', occurred_at: null, source_modified_at: '2026-10-16T12:00:00Z' };
  const rows = [doc, old, newest];
  assert.equal(latestEvidenceTime(rows), Date.parse(newest.occurred_at));
  assert.equal(dateLabel(latestEvidenceTime(rows)), dateLabel(newest.occurred_at));
  assert.deepEqual([...rows].sort(compareEvidenceRecency).map(r => r.id), ['new-im', 'old-im', 'undated-doc']);
});

test('all-undated or empty evidence remains unknown without falling back to modification or as-of dates', () => {
  const rows = [{ id: 'doc-a', occurred_at: null, source_modified_at: '2026-10-16T12:00:00Z' }, { id: 'doc-b', occurred_at: null }];
  assert.equal(latestEvidenceTime(rows), null);
  assert.equal(dateLabel(latestEvidenceTime(rows)), '时间未知');
  assert.equal(latestEvidenceTime([]), null);
  assert.deepEqual([...rows].sort(compareEvidenceRecency), rows);
});


test('WPS styled text becomes readable runs and preserves source formatting without exposing resource keys', () => {
  const value = JSON.stringify({rich_text:{elements:[{type:'nl',elements:[
    {type:'text',alt_text:'',elements:null,indent:0,index:0,style_content:{style:{bold:true,color:'#e2651a',italic:false},text:'核心结论：',url:'',url_title:''}},
    {type:'text',style_content:{text:'查看报告',url:'https://example.invalid/report',style:{italic:true,code:true}}},
    {type:'mention',mention_content:{text:'@示例同事'}},
    {type:'image',image_content:{storage_key:'private-resource-key'}}
  ]}]}});
  const runs = richMessageRuns(value);
  assert.deepEqual(runs[0], {text:'核心结论：',style:{bold:true}});
  assert.deepEqual(runs[1], {text:'查看报告',style:{italic:true,code:true},href:'https://example.invalid/report'});
  assert.equal(cleanMentions(value), '核心结论：查看报告 https://example.invalid/report @示例同事[图片附件]');
  assert.ok(!JSON.stringify(runs).includes('private-resource-key'));
  const original = JSON.parse(value);
  const dataset = {cases:[{evidence:[{speaker:'审阅者',text:value}],runs:[]}]};
  const masked = createPresenter(dataset,true)(value);
  assert.ok(!masked.includes('示例同事') && !masked.includes('example.invalid'));
  assert.deepEqual(JSON.parse(value),original);
});

test('styled text rejects unsafe link destinations and limits input instead of trusting arbitrary markup', () => {
  for (const url of ['javascript:alert(1)','data:text/html,test','https://user:secret@example.invalid']) {
    const value=JSON.stringify({rich_text:{elements:[{type:'text',style_content:{text:'原文应保留',url}}]}});
    assert.equal(richMessageRuns(value),null);
    assert.equal(cleanMentions(value),value);
  }
  const value=JSON.stringify({rich_text:{elements:[{type:'text',style_content:{text:'<img src=x onerror=alert(1)>',style:{bold:true,background:'url(x)'}}}]}});
  assert.equal(richMessageRuns(value)[0].text,'<img src=x onerror=alert(1)>');
  assert.deepEqual(richMessageRuns(value)[0].style,{bold:true});
  assert.equal(richMessageRuns('x'.repeat(1000001)),null);
});


test('ordered and unordered WPS paragraphs preserve visible list hierarchy', () => {
  const value=JSON.stringify({rich_text:{elements:[{type:'ol',index:1,elements:[{type:'text',style_content:{text:'核对成本',style:{bold:true}}}]},{type:'ul',elements:[{type:'text',text_content:{content:'保留口径'}}]}]}});
  assert.equal(cleanMentions(value),'2. 核对成本\n• 保留口径');
});

test('truncated rich excerpts show only complete retained nodes with an explicit incompleteness notice', () => {
  const value=JSON.stringify({rich_text:{elements:[{type:'text',style_content:{text:'已保存的完整句子',style:{bold:true}}},{type:'text',style_content:{text:'未保存完整的句子'}}]}});
  const truncated=value.slice(0,value.indexOf('未保存')+2);
  const runs=partialRichMessageRuns(truncated);
  assert.deepEqual(runs,[{text:'已保存的完整句子',style:{bold:true}}]);
  assert.ok(cleanMentions(truncated).includes('内容不完整'));
  assert.ok(!cleanMentions(truncated).includes('style_content'));
  assert.equal(partialRichMessageRuns(value),null);
  assert.equal(partialRichMessageRuns('{"ordinary":"业务JSON"'),null);
});


test('anonymous presentation masks identities and contacts across styled run boundaries', () => {
  const value=JSON.stringify({rich_text:{elements:[
    {type:'text',style_content:{text:'示例',style:{bold:true}}},
    {type:'text',style_content:{text:'同事 https://exa',style:{italic:true}}},
    {type:'text',style_content:{text:'mple.invalid/private person@exa'}},
    {type:'text',style_content:{text:'mple.invalid'}}
  ]}});
  const present=createPresenter({cases:[{evidence:[{speaker:'示例同事',text:value}],runs:[]}]},true);
  const result=present(value);
  assert.ok(!result.includes('示例同事') && !result.includes('example.invalid'));
  assert.ok(result.includes('链接已隐藏') && result.includes('邮箱已隐藏'));
});


test('partial source refuses unknown parent shapes and masks conservatively across styled fragments', () => {
  const unknown='{"rich_text":{"elements":[{"type":"unknown","business":"must retain","nested":{"type":"text","style_content":{"text":"nested"}}},';
  assert.equal(partialRichMessageRuns(unknown),null);
  const complete=JSON.stringify({rich_text:{elements:[
    {type:'text',style_content:{text:'示例',style:{bold:true}}},
    {type:'text',style_content:{text:'同事 https://exa'}},
    {type:'text',style_content:{text:'mple.invalid/private person@exa'}},
    {type:'text',style_content:{text:'mple.invalid'}},
    {type:'text',style_content:{text:'截断位置'}}
  ]}});
  const partial=complete.slice(0,complete.indexOf('截断位置')+1);
  assert.equal(partialRichMessageRuns(partial).map(r=>r.text).join(''),'示例同事 https://example.invalid/private person@example.invalid');
  const present=createPresenter({cases:[{evidence:[{speaker:'示例同事',text:partial}],runs:[]}]},true);
  assert.ok(!present(partial).includes('示例') && !present(partial).includes('exa'));
});
