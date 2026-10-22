import {findBoardSnapshot,readBoardImage} from './discovery-boards.mjs';
import {buildQuestionContext} from './question-context.mjs';
import {createHash} from 'node:crypto';
import {PERMANENT_BLOCKED_LOCATOR_HASHES} from './history-index.mjs';

const invalid=()=>{throw Object.assign(new Error('INVALID_DISCOVERY_REQUEST'),{code:'INVALID_DISCOVERY_REQUEST'});};

/** The browser supplies identifiers, never trusted OCR or source definitions. */
export async function resolveBoardQuestion({input,store,policy,checkoutRoot,sourceVersion}) {
  if (!input.boardId&&!input.snapshotId&&!input.historyTicketId)return null;
  if (!input.boardId||!input.snapshotId)invalid();
  const found=findBoardSnapshot(store,policy,input.boardId,input.snapshotId);
  if(!found||found.board.analysisSourceId!==input.sourceId)invalid();
  await readBoardImage(store,found.shot,checkoutRoot);
  const snapshot={...found.shot,sourceVersion};
  const question={text:input.question,messageId:'manual-question',sourceId:snapshot.sourceId,sourceRef:snapshot.sourceRef};
  const context=buildQuestionContext({question,messages:[],board:found.board,snapshot,ocr:snapshot.ocr,selectionBasis:'USER_SELECTED',...policy});
  return context;
}

export async function questionBindingStillAllowed({context,sourceId,sourceVersion,store,policy,checkoutRoot}) {
  for(const evidence of context?.evidence||[]){
    const ref=policy.sourceRefs.get(evidence.sourceId),window=policy.referenceWindows?.get(evidence.sourceId);
    if(!ref||!policy.allowedSourceIds.has(evidence.sourceId)||policy.excludedSourceIds?.has(evidence.sourceId))return false;
    const locator=createHash('sha256').update(JSON.stringify(['wps',ref,evidence.messageId])).digest('hex');
    if(new Set([...PERMANENT_BLOCKED_LOCATOR_HASHES,...(policy.blockedLocatorHashes||[])]).has(locator))return false;
    if(window&&(!evidence.pushedAt||Date.parse(evidence.pushedAt)<Date.parse(window.startAt)||Date.parse(evidence.pushedAt)>Date.parse(window.endAt)))return false;
  }
  if(!context?.binding?.boardId)return true;
  const binding=context.binding;
  const found=findBoardSnapshot(store,policy,binding.boardId,binding.snapshotId);
  if(!found||found.board.analysisSourceId!==sourceId||found.shot.sha256!==binding.imageSha256||found.shot.statisticsDate!==binding.statisticsDate
    ||(found.shot.comparisonDate||null)!==(binding.comparisonDate||null)||found.shot.sourceId!==binding.sourceId||found.shot.sourceRef!==binding.sourceRef||String(found.shot.messageId)!==binding.messageId
    ||sourceVersion&&sourceVersion!==binding.sourceVersion)return false;
  const ocr=found.shot.ocr;
  if(Boolean(ocr)!==Boolean(context.ocr))return false;
  if(ocr&&(ocr.version!==context.ocr.version||ocr.status!==context.ocr.status||ocr.imageSha256!==context.ocr.imageSha256
    ||createHash('sha256').update(ocr.text).digest('hex')!==context.ocr.textSha256))return false;
  try{await readBoardImage(store,found.shot,checkoutRoot);return true;}catch{return false;}
}
