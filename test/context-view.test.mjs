import{test}from'node:test';import assert from'node:assert/strict';
import{mkdtemp,writeFile,mkdir,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{createHash}from'node:crypto';
import{readContextSummary,readContextImage}from'../src/context-view.mjs';
test('context projection excludes provider data paths and exposes candidate status independently of listening',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'context-view-'));
 try{const path=join(dir,'context.json');await writeFile(path,JSON.stringify({schema:'context-refresh/v1',events:[],candidates:[{name:'Example person',status:'candidate',chatResolution:'PENDING_IDENTITY_MATCH',raw:'not for UI'}],documents:[],meetingChecks:[]}));
 const data=await readContextSummary(path);assert.equal(data.candidates[0].listening,false);assert.ok(!JSON.stringify(data).includes('not for UI'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('local media read rejects paths outside the receipt directory and bytes that changed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'context-media-'));
 try{const path=join(dir,'context.json'),image=join(dir,'image.png'),blob=Buffer.from('example-image'),hash=createHash('sha256').update(blob).digest('hex');await writeFile(image,blob);
 const context={schema:'context-refresh/v1',documents:[{id:'example-report',images:[{hash,path:image,mime:'image/png'}]}]};await writeFile(path,JSON.stringify(context));assert.deepEqual((await readContextImage(path,'example-report',hash)).body,blob);
 await writeFile(image,'changed');await assert.rejects(()=>readContextImage(path,'example-report',hash),/changed/);
 context.documents[0].images[0].path=join(dir,'..','not-in-context.png');await writeFile(context.documents[0].images[0].path,blob);
 try{await writeFile(path,JSON.stringify(context));await assert.rejects(()=>readContextImage(path,'example-report',hash),/unavailable/);}finally{await rm(context.documents[0].images[0].path);}
 }finally{await rm(dir,{recursive:true,force:true});}
});
