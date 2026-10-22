import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {authorizedHistoricalMedia,projectHistoricalMedia} from '../historical-ticket-media.mjs';
const h='a'.repeat(64),window={startAt:'2026-01-01T00:00:00Z',endAt:'2026-01-03T00:00:00Z'};
function fixture(){
 const root={sourceId:'source',sourceRef:'chat',messageId:'q',pushedAt:'2026-01-02T10:00:00Z',quoteMessageId:'parent',images:[]};
 const parent={...root,messageId:'parent',quoteMessageId:null,pushedAt:'2026-01-02T09:00:00Z',images:[{refHash:h}]};
 const row={id:'image',ticketId:'ticket',linkedEventId:'source:q',sourceId:'source',sourceRef:'chat',messageId:'parent',imageRefHash:h,status:'VERIFIED',relation:'EXPLICIT_REFERENCE',imageFile:h+'.png',sha256:h,at:parent.pushedAt};
 return{manifest:{version:'historical-ticket-media/v1',imageRoot:'/private/images',images:[row]},ticket:{id:'ticket',events:[{sourceId:'source',messageId:'q'}]},messages:[root,parent],policy:{sourceRefs:new Map([['source','chat']]),allowedSourceIds:new Set(['source']),excludedSourceIds:new Set()},row,root,parent};
}
const allowed=f=>authorizedHistoricalMedia(f.manifest,f.ticket,f.messages,f.policy,window);
test('only graph-proven quote parents may expose an original through a local route',()=>{
 const f=fixture();assert.equal(allowed(f).length,1);const [publicImage]=projectHistoricalMedia(allowed(f),'ticket');
 assert.equal(publicImage.imagePath,'/api/discovery-history-image?ticket=ticket&image=image');assert.ok(!JSON.stringify(publicImage).includes('imageFile'));assert.ok(!JSON.stringify(publicImage).includes('/private/'));
 f.root.quoteMessageId='other';assert.equal(allowed(f).length,0);
});
test('exclusions, blocked parent locator, window, source reassignment and hash changes hide media',()=>{
 const changes=[f=>f.policy.excludedSourceIds.add('source'),f=>f.policy.allowedSourceIds.clear(),f=>f.policy.sourceRefs.set('source','other'),f=>{f.parent.pushedAt='2025-12-31T00:00:00Z';},f=>{f.row.imageRefHash='b'.repeat(64);},f=>{f.row.imageFile='../escape.png';},f=>{f.policy.blockedLocatorHashes=new Set([createHash('sha256').update(JSON.stringify(['wps','chat','parent'])).digest('hex')]);}];
 for(const change of changes){const f=fixture();change(f);assert.equal(allowed(f).length,0);}
});
test('nearby candidates remain separate and require same source, preceding time and no explicit parent',()=>{
 const f=fixture();f.row.relation='NEARBY_CANDIDATE';assert.equal(allowed(f).length,0);f.root.quoteMessageId=null;assert.equal(allowed(f).length,1);
 assert.equal(projectHistoricalMedia(allowed(f),'ticket')[0].relation,'NEARBY_CANDIDATE');f.parent.pushedAt='2026-01-02T11:00:00Z';assert.equal(allowed(f).length,0);
});
test('missing graph and foreign ticket rows cannot be served, unavailable entries have no image route',()=>{
 const f=fixture();f.messages=[];assert.equal(allowed(f).length,0);const g=fixture();g.row.ticketId='other';assert.equal(allowed(g).length,0);
 const x=fixture();x.row.status='UNAVAILABLE';assert.equal(projectHistoricalMedia(allowed(x),'ticket')[0].imagePath,null);
});

test('HTTP ticket previews serve only scoped graph-bound bytes and honor later exclusion',async t=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {startWorkbenchServer,parseArgs}=await import('../server.mjs');
 const dir=await mkdtemp(join(tmpdir(),'ticket-media-'));let server;t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 const f=fixture(),png=Buffer.from('89504e470d0a1a0a00000000','hex'),hash=createHash('sha256').update(png).digest('hex');f.manifest.imageRoot=dir;f.row.imageFile=hash+'.png';f.row.sha256=hash;
 const paths=Object.fromEntries(['history','scope','graph','media','attention'].map(k=>[k,join(dir,k+'.json')]));
 const history={version:'historical-question-tickets/v1',window,generatedAt:window.endAt,tickets:[{id:'ticket',title:'Synthetic question',question:'Synthetic question',status:'UNKNOWN',statusReason:'Unverified',historical:true,autoExecute:false,sourceIds:['source'],events:[{sourceId:'source',messageId:'q',kind:'question',occurredAt:f.root.pushedAt,quote:'Synthetic question'}]}]};
 const scope={version:'historical-ticket-scope/v1',basis:'USER_REQUEST',...window,sourceIds:['source'],sourceRefs:{source:'chat'}};const attention={version:1,sources:[{id:'source',chatId:'chat',status:'active',tier:'priority',manualOverride:true,matchedWorklines:[]}]};
 for(const [key,value] of Object.entries({history,scope,graph:{messages:f.messages},media:f.manifest,attention}))await writeFile(paths[key],JSON.stringify(value));await writeFile(join(dir,f.row.imageFile),png);
 server=await startWorkbenchServer({port:0,historicalTicketsPath:paths.history,historicalTicketScopePath:paths.scope,questionContextsPath:paths.graph,historicalMediaPath:paths.media,attentionPath:paths.attention});const base=`http://127.0.0.1:${server.address().port}`;
 const detail=await(await fetch(base+'/api/discovery-history?id=ticket')).json();assert.equal(detail.ticket.media.length,1);const path=detail.ticket.media[0].imagePath;
 let response=await fetch(base+path);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
 assert.equal((await fetch(base+path+'&path=/private/file')).status,400);assert.equal((await fetch(base+path,{headers:{Origin:'https://foreign.invalid'}})).status,403);
 f.root.quoteMessageId='unrelated';await writeFile(paths.graph,JSON.stringify({messages:f.messages}));assert.equal((await fetch(base+path)).status,404);
 f.root.quoteMessageId='parent';await writeFile(paths.graph,JSON.stringify({messages:f.messages}));attention.sources[0].chatId='reassigned-chat';await writeFile(paths.attention,JSON.stringify(attention));assert.equal((await fetch(base+path)).status,404);assert.equal((await(await fetch(base+'/api/discovery-history')).json()).tickets.length,0);
 attention.sources[0].chatId='chat';attention.sources[0].status='excluded';await writeFile(paths.attention,JSON.stringify(attention));assert.equal((await fetch(base+path)).status,404);
 assert.equal(parseArgs(['--historical-media',paths.media]).historicalMediaPath,paths.media);
});
