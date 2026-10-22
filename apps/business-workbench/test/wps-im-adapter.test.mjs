import test from 'node:test';import assert from 'node:assert/strict';import {createWpsAdapter} from '../wps-im-adapter.mjs';
test('WPS search uses SDK-compatible repeated query fields, nested messages and provider cursor',async()=>{
 let url;const adapter=createWpsAdapter({sid:'fixture-only',fetchImpl:async u=>{url=u;return{ok:true,json:async()=>({code:0,data:{items:[{chat:{id:'a'},highlights:['not evidence'],message:{id:'m',ctime:1792051200,content:{rich_text:{text:'applink'}}}}],next_page_token:'next'}})};}});
 const result=await adapter.searchMessages({keyword:'applink',chatIds:['a','b'],startAt:'2026-10-08T08:00:00Z',endAt:'2026-10-15T08:00:00Z',pageToken:'prior'});assert.equal(url.pathname,'/v7/messages/search');assert.deepEqual(url.searchParams.getAll('chat_id_list'),['a','b']);assert.equal(url.searchParams.get('filter_chat_type_list'),'group');assert.equal(url.searchParams.get('page_token'),'prior');assert.equal(result.nextPageToken,'next');assert.equal(result.items[0].chatId,'a');assert.equal(result.items[0].id,'m');assert.ok(result.items[0].text.includes('applink'));assert.equal(result.items[0].text.includes('not evidence'),false);
});
test('WPS search rejects missing cursor rather than returning complete',async()=>{
 const adapter=createWpsAdapter({sid:'fixture-only',fetchImpl:async()=>({ok:true,json:async()=>({code:0,data:{items:[],has_more:true}})})});await assert.rejects(adapter.searchMessages({keyword:'applink',chatIds:['a'],startAt:'2026-10-08T08:00:00Z',endAt:'2026-10-15T08:00:00Z'}),/MISSING_CURSOR/);
});

test('429 exposes Retry-After duration to discovery cooldown without retrying inside adapter',async()=>{
 let requests=0;const adapter=createWpsAdapter({sid:'fixture-only',fetchImpl:async()=>{requests++;return{ok:false,status:429,headers:{get:name=>name==='retry-after'?'120':null}};}});
 await assert.rejects(adapter.searchMessages({keyword:'applink',chatIds:['a'],startAt:'2026-10-08T08:00:00Z',endAt:'2026-10-15T08:00:00Z'}),e=>e.code==='WPS_HTTP_429'&&e.retryAfterMs===120000);assert.equal(requests,1);
});
