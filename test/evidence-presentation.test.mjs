import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isPublicDocImage} from '../scripts/release-check.mjs';
const html=await readFile(new URL('../demo/evidence-timeline.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const helpers=script.slice(0,script.indexOf('const styled='));
const {richMessageRuns,partialRichMessageRuns,safeSourceUrl,conversationView}=new Function(helpers+';return {richMessageRuns,partialRichMessageRuns,safeSourceUrl,conversationView};')();

test('public evidence example decodes styled paragraphs and list items',()=>{
 const raw=JSON.stringify({rich_text:{elements:[{type:'ol',index:1,elements:[{type:'text',style_content:{text:'示例文字',style:{bold:true}}}]}]}});
 const runs=richMessageRuns(raw);
 assert.deepEqual(runs,[{text:'2. '},{text:'示例文字',style:{bold:true}},{text:'\n'}]);
});
test('public partial source recovery retains only known nodes and refuses unknown parents',()=>{
 const complete=JSON.stringify({rich_text:{elements:[{type:'text',style_content:{text:'保留文字',style:{}}},{type:'text',style_content:{text:'缺失文字'}}]}});
 assert.equal(partialRichMessageRuns(complete.slice(0,complete.indexOf('缺失文字')+1))[0].text,'保留文字');
 assert.equal(partialRichMessageRuns('{"rich_text":{"elements":[{"type":"unknown","nested":{"type":"text","style_content":{"text":"隐藏字段"}}},'),null);
});
test('public renderer never inserts source HTML and links reject executable or credential destinations',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,x','https://user:secret@example.org/']) assert.equal(safeSourceUrl(url),null);
 assert.ok(!script.includes('innerHTML'));
 assert.ok(script.includes('document.createTextNode'));
 assert.ok(html.includes('完全虚构'));
});


test('release permits bounded documentation images but rejects wrong paths, malformed files and appended payloads',async()=>{
 const image=await readFile(new URL('../docs/product/assets/screenshots/evidence.png',import.meta.url));
 assert.equal(isPublicDocImage('docs/product/assets/screenshots/evidence.png',image),true);
 assert.equal(isPublicDocImage('public/evidence.png',image),false);
 assert.equal(isPublicDocImage('docs/product/assets/screenshots/fake.png',Buffer.from('not an image')),false);
 assert.equal(isPublicDocImage('docs/product/assets/screenshots/evidence.png',Buffer.concat([image,Buffer.from('extra payload')])),false);
 assert.equal(isPublicDocImage('docs/product/assets/screenshots/evidence.png',image.subarray(0,40)),false);
});


test('public mock conversation uses consistent people for authors mentions and reply targets',()=>{
 const people=[{key:'a',label:'成员A'},{key:'b',label:'成员B'}];
 const events=[{id:'q',source:'s',at:1,sender:'a',mentionKeys:['b']},{id:'r',source:'s',at:2,sender:'b',replyTo:'q'}];
 const view=conversationView(events,people);
 assert.equal(view[0].targets[0],view[1].author);
 assert.equal(view[1].parent.id,'q');
 assert.equal(conversationView([{...events[0],source:'other'},events[1]],people)[1].parent,null);
});
