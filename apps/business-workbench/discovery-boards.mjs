import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sanitizeText } from './live-qa.mjs';
import { PERMANENT_BLOCKED_LOCATOR_HASHES } from './history-index.mjs';

const fail = () => { throw Object.assign(new Error('DISCOVERY_BOARDS_INVALID'), { code: 'DISCOVERY_BOARDS_INVALID' }); };
const id = value => typeof value === 'string' && /^[\w.:-]{1,180}$/.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const within = (root, path) => { const rel = relative(root, path); return rel && !rel.startsWith('..') && !isAbsolute(rel); };
const clean = (value, secrets) => {
  let result = sanitizeText(typeof value === 'string' ? value : '');
  for (const secret of secrets || []) if (secret) result = result.split(secret).join('[已移除凭据]');
  return result.slice(0, 2000);
};

export function validateBoardManifest(store) {
  if (store?.version !== 'discovery-boards/v1' || !isAbsolute(store.imageRoot || '') || !instant(store.generatedAt)
    || !Array.isArray(store.allowedLinkHosts) || store.allowedLinkHosts.some(host => typeof host !== 'string' || !/^[a-z0-9.-]+$/.test(host))
    || !Array.isArray(store.boards) || store.boards.length > 100) fail();
  const boards = new Set(), images = new Set();
  for (const board of store.boards) {
    if (!id(board.id) || boards.has(board.id) || typeof board.title !== 'string' || !board.title.trim()
      || (board.analysisSourceId !== undefined && !id(board.analysisSourceId)) || !Array.isArray(board.snapshots) || board.snapshots.length > 1000) fail();
    boards.add(board.id);
    for (const shot of board.snapshots) {
      if (!id(shot.id) || images.has(shot.id) || !id(shot.sourceId) || !id(shot.sourceRef) || !id(String(shot.messageId || ''))
        || !date(shot.statisticsDate) || !instant(shot.pushedAt)
        || typeof shot.imageFile !== 'string' || isAbsolute(shot.imageFile) || !within(resolve(store.imageRoot),resolve(store.imageRoot,shot.imageFile))
        || !/\.(png|jpe?g|webp)$/i.test(shot.imageFile) || !/^[a-f0-9]{64}$/.test(shot.sha256)) fail();
      images.add(shot.id);
      // Links are optional. Unverified or credential-bearing destinations are never served.
      if (shot.sourceUrl !== undefined && !safeBoardUrl(shot.sourceUrl,store.allowedLinkHosts)) fail();
      if (shot.comparisonDate !== undefined && !date(shot.comparisonDate)) fail();
      if (shot.ocr !== undefined && !validSnapshotOcr(shot.ocr, shot.sha256)) fail();
    }
  }
  return store;
}

export function validSnapshotOcr(ocr, imageSha256) {
  return ocr && ['COMPLETED', 'VERIFIED'].includes(ocr.status) && id(ocr.version) && instant(ocr.createdAt)
    && ocr.imageSha256 === imageSha256 && /^[a-f0-9]{64}$/.test(ocr.imageSha256)
    && typeof ocr.text === 'string' && Boolean(ocr.text.trim()) && ocr.text.length <= 16000;
}

export function validBoardScopeWindow(scope) { return instant(scope?.startAt) && instant(scope?.endAt) && Date.parse(scope.startAt)<=Date.parse(scope.endAt); }

export function safeBoardUrl(value, hosts) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname)
      && [...url.searchParams.keys()].every(key => key === 'id') && url.href.length <= 4096 && !url.hash ? url.href : null;
  } catch { return null; }
}

function allowed(shot, policy) {
  const locator = createHash('sha256').update(JSON.stringify(['wps', shot.sourceRef, String(shot.messageId)])).digest('hex');
  const window=policy.referenceWindows?.get(shot.sourceId);
  if(window && (!instant(window.startAt) || !instant(window.endAt) || Date.parse(window.startAt)>Date.parse(window.endAt) || Date.parse(shot.pushedAt)<Date.parse(window.startAt) || Date.parse(shot.pushedAt)>Date.parse(window.endAt)))return false;
  return policy.allowedSourceIds?.has(shot.sourceId) && policy.sourceRefs?.get(shot.sourceId) === shot.sourceRef && !policy.excludedSourceIds?.has(shot.sourceId)
    && !new Set([...PERMANENT_BLOCKED_LOCATOR_HASHES, ...(policy.blockedLocatorHashes || [])]).has(locator);
}

const route = (kind, board, shot) => `/api/discovery-board-${kind}?board=${encodeURIComponent(board.id)}&snapshot=${encodeURIComponent(shot.id)}`;
export function projectBoards(store, policy) {
  validateBoardManifest(store);
  return { configured: true, updatedAt: new Date(store.generatedAt).toISOString(), boards: store.boards.flatMap(board => {
    const snapshots = board.snapshots.filter(shot => allowed(shot, policy)).sort((a,b) => b.statisticsDate.localeCompare(a.statisticsDate) || Date.parse(b.pushedAt)-Date.parse(a.pushedAt));
    if (!snapshots.length) return [];
    return [{ id:board.id, title:clean(board.title,policy.secrets), analysisSourceId:board.analysisSourceId || null, relationNote:clean(board.relationNote,policy.secrets), snapshots:snapshots.map(shot=>({
      id:shot.id, title:clean(shot.title || board.title,policy.secrets), statisticsDate:shot.statisticsDate, pushedAt:new Date(shot.pushedAt).toISOString(),
      comparisonDate:shot.comparisonDate || null, imageSha256:shot.sha256, ocr:shot.ocr ? {status:shot.ocr.status,version:shot.ocr.version,createdAt:shot.ocr.createdAt,imageSha256:shot.ocr.imageSha256} : {status:'NOT_READ'},
      imagePath:route('image',board,shot), linkPath:shot.sourceUrl ? route('link',board,shot) : null,
    })) }];
  }) };
}

export function findBoardSnapshot(store, policy, boardId, snapshotId) {
  validateBoardManifest(store);
  const board=store.boards.find(item=>item.id===boardId), shot=board?.snapshots.find(item=>item.id===snapshotId);
  return shot && allowed(shot,policy) ? { board, shot } : null;
}

export async function readBoardImage(store, shot, checkoutRoot) {
  const root = await realpath(store.imageRoot);
  const checkout = await realpath(checkoutRoot).catch(()=>resolve(checkoutRoot));
  if (!within(checkout,root) && root!==checkout) {
    const requested=resolve(root,shot.imageFile), actual=await realpath(requested);
    if (!within(root,actual) || actual!==requested) fail();
    const file=await open(requested,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info=await file.stat(); if (!info.isFile() || info.size>12*1024*1024) fail();
      const bytes=await file.readFile(); if (bytes.length>12*1024*1024 || createHash('sha256').update(bytes).digest('hex')!==shot.sha256) fail();
      const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
        : bytes[0]===255 && bytes[1]===216 && bytes[2]===255 ? 'image/jpeg'
          : bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP' ? 'image/webp' : null;
      if (!mime) fail(); return { bytes,mime };
    } finally { await file.close(); }
  }
  fail();
}
