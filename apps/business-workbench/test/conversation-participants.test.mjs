import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationParticipants } from '../conversation-participants.mjs';
const clean=(value,max=12000)=>typeof value==='string'?value.slice(0,max):'';
const base=(messageId,speakerId,speaker,kind='question')=>({sourceId:'source-a',messageId,speakerId,speaker,kind,occurredAt:'2026-01-02T01:00:00Z',quote:''});

test('same IM author has the same opaque participant key across questions and replies',()=>{
 const e=[base('q','native-author-1','成员甲'),base('r','native-author-2','成员乙','reply'),{...base('f','native-author-1','成员甲','followup'),quoteMessageId:'r'}];
 e[1].quoteMessageId='q';
 const result=conversationParticipants(e,clean);
 assert.equal(result[0].participant.key,result[2].participant.key);
 assert.notEqual(result[0].participant.key,result[1].participant.key);
 assert.equal(result[1].replyTo.participant.key,result[0].participant.key);
 assert.equal(result[2].replyTo.eventId,'source-a:r');
 assert.ok(!JSON.stringify(result).includes('native-author'));
});
test('explicit IM mention IDs bind participants, while HTML index IDs and name matches remain provisional',()=>{
 const e=[{...base('q','native-a','成员甲'),quote:JSON.stringify({rich_text:{elements:[{type:'mention',mention_content:{text:'成员乙',identity:{id:'native-b'}}}]}})},base('r','native-b','成员乙','reply')];
 const result=conversationParticipants(e,clean);
 assert.equal(result[0].mentions[0].key,result[1].participant.key);
 assert.equal(result[0].mentions[0].identityVerified,true);
 e[0].quote='<at id="1">成员乙</at>';
 const provisional=conversationParticipants(e,clean)[0].mentions[0];
 assert.equal(provisional.key,null);assert.equal(provisional.identityVerified,false);assert.equal(provisional.basis,'NAME_ONLY');
});
test('same names from distinct IM accounts never merge and cannot verify a mention',()=>{
 const e=[{...base('q','native-a','成员甲'),quote:'@同名成员 请看'},base('r','native-b','同名成员','reply'),base('f','native-c','同名成员','reply')];
 const result=conversationParticipants(e,clean);
 assert.notEqual(result[1].participant.key,result[2].participant.key);
 assert.equal(result[0].mentions[0].ambiguous,true);
 assert.equal(result[0].mentions[0].candidateKey,null);
});
test('an adjacent answer does not prove reply recipient, nor do cross-source or future IDs',()=>{
 const q=base('q','a','成员甲'),r=base('r','b','成员乙','reply');
 assert.equal(conversationParticipants([q,r],clean)[1].replyAssociation,'UNCONFIRMED');
 r.quoteMessageId='q';
 assert.equal(conversationParticipants([{...q,sourceId:'other'},r],clean)[1].replyTo,null);
 assert.equal(conversationParticipants([{...q,occurredAt:'2026-01-03T01:00:00Z'},r],clean)[1].replyTo,null);
});
test('participant labels are sanitized and unknown speaker accounts are never guessed',()=>{
 const e=[{...base('q',null,'名字 secret'),quote:'<at user_id="explicit-account">成员乙</at>'}];
 const result=conversationParticipants(e,(value,max)=>clean(value,max).replaceAll('secret','[hidden]'))[0];
 assert.equal(result.participant.key,null);assert.equal(result.participant.name,'名字 [hidden]');
 assert.equal(result.mentions[0].identityVerified,true);
});


test('one account has one displayed name/avatar label despite old nicknames or mention aliases',()=>{
 const q={...base('q','native-a','旧昵称'),quote:JSON.stringify({rich_text:{elements:[{type:'mention',mention_content:{text:'提及别名',identity:{id:'native-a'}}}]}})};
 const r={...base('r','native-a','当前姓名','reply'),occurredAt:'2026-01-02T02:00:00Z',quoteMessageId:'q'};
 const original=structuredClone([q,r]);
 const result=conversationParticipants([q,r],clean);
 assert.equal(result[0].participant.name,'当前姓名');assert.equal(result[0].mentions[0].name,'当前姓名');
 assert.deepEqual(result[0].participant,result[1].participant);
 assert.deepEqual(result[1].replyTo.participant,result[0].participant);
 assert.deepEqual([q,r],original);
});
