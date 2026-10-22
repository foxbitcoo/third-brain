#!/usr/bin/env node
// Explicit input files only. No traversal, network calls, credentials, OCR or
// automatic source authorization. Use --help for the private repair contract.
import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMessageContext } from '../question-context.mjs';
import { validHistoricalTickets } from '../historical-tickets.mjs';

const checkout=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const outside=(root,path)=>{const rel=relative(root,path);return rel && (rel.startsWith('..'+ '/') || isAbsolute(rel));};
const args=process.argv.slice(2);
if(args.length===1 && args[0]==='--help') {
  process.stdout.write('node reparse-question-context.mjs --input /private/messages.json --output /private/reparsed.json [--tickets /private/tickets.json --tickets-output /private/tickets-repaired.json] [--scope /private/scope.json]\nInput: {version:"question-context-repair-input/v1",messages:[{sourceId,raw}],sourceRefs:{sourceId:nativeRef}}. Explicit authorized exports only. Output is separate; originals are never overwritten.\n');
} else {
  const options={};for(let i=0;i<args.length;i+=2){if(!['--input','--output','--tickets','--tickets-output','--scope'].includes(args[i]) || !args[i+1])throw new Error('INVALID_REPAIR_ARGUMENTS');options[args[i].slice(2).replace('-output','Output')]=resolve(args[i+1]);}
  if(!options.input || !options.output || options.input===options.output || options.tickets===options.output || options.ticketsOutput && options.ticketsOutput===options.tickets || options.ticketsOutput===options.input || options.ticketsOutput===options.output)throw new Error('INVALID_REPAIR_ARGUMENTS');
  const actualCheckout=await realpath(checkout);
  async function readPrivateText(path) {
    const actual=await realpath(path);if(actual!==path || !outside(actualCheckout,actual))throw new Error('REPAIR_REQUIRES_PRIVATE_INPUT');
    const info=await stat(actual);if(!info.isFile() || info.size>16*1024*1024)throw new Error('REPAIR_INPUT_TOO_LARGE');
    return readFile(actual,'utf8');
  }
  const readPrivate=async path=>JSON.parse(await readPrivateText(path));
  for(const path of [options.output,options.ticketsOutput].filter(Boolean)) {
    const outParent=await realpath(dirname(path));
    if(!outside(actualCheckout,resolve(outParent,path.split('/').at(-1))))throw new Error('REPAIR_REQUIRES_PRIVATE_OUTPUT');
    if(await stat(path).then(()=>true,()=>false))throw new Error('REPAIR_OUTPUT_ALREADY_EXISTS');
  }
  let input;
  if(options.input.endsWith('.jsonl')) {
    if(!options.scope)throw new Error('REPAIR_JSONL_REQUIRES_SCOPE');
    const scope=await readPrivate(options.scope);
    const sourceRefs=scope.sourceRefs || {};
    const rows=(await readPrivateText(options.input)).split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));
    input={version:'question-context-repair-input/v1',sourceRefs,messages:rows.map(raw=>{
      const sourceId=Object.keys(sourceRefs).find(key=>sourceRefs[key]===String(raw.chat_id));
      if(!sourceId)throw new Error('REPAIR_RAW_SOURCE_OUTSIDE_SCOPE');
      return {sourceId,raw};
    })};
  } else input=await readPrivate(options.input);
  if(input.version!=='question-context-repair-input/v1' || !Array.isArray(input.messages) || input.messages.length>20000 || !input.sourceRefs)throw new Error('INVALID_REPAIR_INPUT');
  const messages=input.messages.map(row=>extractMessageContext(row.raw,{sourceId:row.sourceId}));
  if(messages.some(row=>input.sourceRefs[row.sourceId]!==row.sourceRef))throw new Error('REPAIR_SOURCE_BINDING_MISMATCH');
  let tickets=null,updatedEvents=0;
  if(options.tickets) {
    tickets=await readPrivate(options.tickets);if(!validHistoricalTickets(tickets))throw new Error('INVALID_HISTORY_TICKETS');
    for(const ticket of tickets.tickets)for(const event of ticket.events) {
      const message=messages.find(row=>row.sourceId===event.sourceId && row.messageId===String(event.messageId));if(!message)continue;
      event.quoteMessageId=message.quoteMessageId;event.replyMessageId=message.replyMessageId;
      event.imageReferences=message.images;event.linkReferences=message.links;event.parsedContentHash=message.contentHash;
      const parentId=message.quoteMessageId || message.replyMessageId;
      if(parentId)event.replyTo={...(typeof event.replyTo==='object'?event.replyTo:{}),sourceId:message.sourceId,messageId:parentId,kind:message.quoteMessageId?'quote':'reply'};
      const merge=(existing,added)=>[...(Array.isArray(existing)?existing:[]),...added.filter(item=>!(Array.isArray(existing)?existing:[]).some(old=>old.refHash===item.refHash))];
      event.images=merge(event.images,message.images.map(image=>({...image,status:'REFERENCE_ONLY'})));event.links=merge(event.links,message.links);updatedEvents++;
    }
  }
  const output={version:'question-context-repair/v1',createdAt:new Date().toISOString(),messages,tickets,receipt:{inputMessages:messages.length,updatedEvents,networkCalls:0,originalsOverwritten:false}};
  if(options.ticketsOutput) {
    if(!tickets)throw new Error('REPAIR_TICKETS_OUTPUT_REQUIRES_TICKETS');
    await writeFile(options.ticketsOutput,JSON.stringify(tickets,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  await writeFile(options.output,JSON.stringify(output,null,2)+'\n',{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify(output.receipt)+'\n');
}
