import{test}from'node:test';import assert from'node:assert/strict';
import{projectContextSources}from'../context-sources.mjs';
import{contextRecords}from'../ingest-context.mjs';
import{normalizeHistory,retrieveHistory,buildHistoryIndex}from'../history-index.mjs';
import{spawnSync}from'node:child_process';
import{fileURLToPath}from'node:url';
const policy={version:'document-source-policy-v1',documents:[{documentId:'example-report',status:'allowed'}]};
test('ingestion CLI initializes without breaking imports from the refresh entry point',()=>{
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('../ingest-context.mjs',import.meta.url)),'/example/missing-config.json','/example/missing-context.json'],{encoding:'utf8'});
 assert.notEqual(child.status,0);assert.doesNotMatch(child.stderr,/ReferenceError/);assert.match(child.stderr,/ENOENT/);
});
test('context UI hides revoked documents and never returns raw provider envelopes or paths',()=>{
 const view=projectContextSources({schema:'context-refresh/v1',documents:[{id:'example-report',images:[{hash:'a'.repeat(64),path:'/example/private/image',state:'READ'}]},{id:'denied-report'}],events:[],candidates:[]},policy);
 assert.equal(view.documents.length,1);assert.equal(view.documents[0].imagesRead,1);assert.ok(!JSON.stringify(view).includes('/example/private'));assert.ok(!JSON.stringify(view).includes('signed'));
});
test('calendar evidence stays typed and is queryable only under explicit calendar admission',()=>{
 const raw=contextRecords({finishedAt:'2026-01-08T00:00:00Z',events:[{calendarId:'example-calendar',eventId:'example-event',title:'Operations growth review',start:'2026-01-08T10:00:00+08:00',end:'2026-01-08T11:00:00+08:00',state:'NOT_DUE',attendees:[{name:'Example colleague',response_status:'accepted'}]}]});
 const [row]=normalizeHistory(raw);assert.equal(row.source_type,'calendar');assert.equal(row.source_id,'calendar:wps-example-calendar');assert.match(row.text,/不代表会议已举行/);
 const index=buildHistoryIndex({corpusRecords:raw});
 assert.equal(retrieveHistory(index,{question:'Operations growth review',allowedSourceIds:[]}).evidence.length,0);
 assert.equal(retrieveHistory(index,{question:'Operations growth review',allowedSourceIds:['calendar:wps-example-calendar']}).evidence.length,1);
});
test('canceled invitations never become factual progress evidence',()=>{
 assert.equal(contextRecords({events:[{state:'CANCELED',start:'2026-01-08T00:00:00Z'}]}).length,0);
});

test('native report date controls retain the China calendar date for image headings', async () => {
 const {execFileSync}=await import('node:child_process');
 const {fileURLToPath}=await import('node:url');
 const module=fileURLToPath(new URL('../../../src',import.meta.url));
 const code=`import sys,json;sys.path.insert(0,sys.argv[1]);import context_refresh as m;print(json.dumps(m.otl_images({'blocks':[{'content':[{'type':'heading','content':[{'type':'staticTime','attrs':{'time':1792146600000}}]},{'type':'picture','attrs':{'sourceKey':'example-resource'}}]}]})))`;
 const rows=JSON.parse(execFileSync('python3',['-c',code,module],{encoding:'utf8'}));
 assert.equal(rows[0].heading,'2026-10-16');
});
