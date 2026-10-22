import {projectContextSources,readContextImage} from './context-sources.mjs';
import { loadAttention, saveChange, readPlan, isTrustedListeningSource } from './source-attention.mjs';
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { validateDataset } from './data.mjs';
import { projectWorkStructure } from './work-structure.mjs';
import { validReadingGuide } from './reading-guide.mjs';
import { askQuestion, applySourcePolicyFence, LiveQaError, validateAskInput, buildEvidenceContext, buildAskScope, blockedLocatorConfiguration, providerConfiguration } from './live-qa.mjs';
import { loadDocumentPolicy, parseDocumentPolicy, documentEvidenceAllowed } from './document-intake.mjs';
import { MAX_HISTORY_INDEX_BYTES, validateHistoryIndex } from './history-index.mjs';
import { createDiagnosticService } from './diagnostic-service.mjs';
import { loadDiagnosticAgent } from './diagnostic-agent.mjs';
import { historicalScopeIds, projectHistoricalTickets } from './historical-tickets.mjs';
import { projectBoards, findBoardSnapshot, readBoardImage, safeBoardUrl, validBoardScopeWindow } from './discovery-boards.mjs';
import {resolveBoardQuestion,questionBindingStillAllowed} from './discovery-question-context.mjs';
import { authorizedHistoricalMedia, projectHistoricalMedia } from './historical-ticket-media.mjs';
import {resolveHistoricalQuestionContext} from './historical-question-context.mjs';

const APP_ROOT = dirname(fileURLToPath(import.meta.url));
const CHECKOUT_ROOT = resolve(APP_ROOT, '../..');
const MAX_DATASET_BYTES = 20 * 1024 * 1024;
const MAX_HISTORY_BYTES = MAX_HISTORY_INDEX_BYTES;
const MAX_DISPLAY_MAPPING_BYTES = 5 * 1024 * 1024;
const MAX_READING_GUIDE_BYTES = 1024 * 1024;
const MAX_CONTEXT_BYTES = 32 * 1024 * 1024;
const FILE_FLAGS = { '--context-sources':'contextSourcesPath', '--historical-media':'historicalMediaPath', '--question-contexts':'questionContextsPath', '--discovery-boards': 'discoveryBoardsPath', '--historical-tickets': 'historicalTicketsPath', '--historical-ticket-scope': 'historicalTicketScopePath', '--discovery': 'discoveryPath', '--document-policy': 'documentPolicyPath', '--history': 'historyPath', '--worklines': 'worklinesPath', '--attention': 'attentionPath', '--data': 'dataPath', '--source-map': 'sourceMapPath', '--display-titles': 'displayTitlesPath', '--reading-guide': 'readingGuidePath' };
const ERRORS = {
  DISCOVERY_BOARDS_UNAVAILABLE: [503, '看板原图暂时无法读取。'],
  DISCOVERY_BOARDS_TOO_LARGE: [413, '看板图片清单超过读取上限。'],
  DISCOVERY_BOARDS_INVALID: [422, '看板原图或来源需要核对。'],
  HISTORICAL_TICKETS_UNAVAILABLE: [503, '历史工单暂时无法读取。'],
  HISTORICAL_TICKETS_TOO_LARGE: [413, '历史工单超过读取上限。'],
  HISTORICAL_TICKETS_INVALID: [422, '历史工单或阅读范围需要核对。'],
  DISCOVERY_UNAVAILABLE: [503, '主动分析服务暂不可用，请核对本地执行配置。'],
  DISCOVERY_BUSY: [409, '已有分析正在运行，请完成或取消后再发起。'],
  INVALID_DISCOVERY_REQUEST: [400, '分析请求无效，请核对问题、来源和补充事实。'],
  DISCOVERY_NOT_FOUND: [404, '未找到这项分析任务。'],
  SOURCE_POLICY_CHANGED: [409, '来源设置已变更，相关任务已隐藏。'],
  INVALID_ARGUMENTS: [400, '启动参数无效。使用 --port 数字；--document-policy、--history、--data、--source-map、--display-titles 和 --reading-guide 需指定绝对文件路径。'],
  DATA_PATH_NOT_ALLOWED: [403, '私有输入必须通过显式参数从 checkout 外部加载。'],
  DATASET_UNAVAILABLE: [503, '本地数据暂时无法读取，请检查启动时选择的数据文件。'],
  DATASET_TOO_LARGE: [413, '数据文件超过本地展示的大小限制。'],
  DATASET_INVALID: [422, '数据格式不符合 business-qa-v1，请检查数据契约。'],
  DISPLAY_MAPPING_UNAVAILABLE: [503, '本地显示映射暂时无法读取，请检查启动时选择的映射文件。'],
  DISPLAY_MAPPING_TOO_LARGE: [413, '显示映射文件超过本地展示的大小限制。'],
  DISPLAY_MAPPING_INVALID: [422, '显示映射格式无效，请检查参与人或题目标题映射。'],
  READING_GUIDE_UNAVAILABLE: [503, '精简导读暂时无法读取，请检查启动时选择的导读文件。'],
  READING_GUIDE_TOO_LARGE: [413, '精简导读文件超过本地展示的大小限制。'],
  READING_GUIDE_INVALID: [422, '精简导读与当前资料不匹配或格式无效，请检查问题、回答和引用。'],
  DOCUMENT_POLICY_UNAVAILABLE: [503, '文档许可暂时无法读取。'],
  DOCUMENT_POLICY_TOO_LARGE: [413, '文档许可文件超过读取上限。'],
  DOCUMENT_POLICY_INVALID: [422, '文档许可格式无效。'],
  HISTORY_UNAVAILABLE: [503, '累计历史索引暂时无法读取，请检查启动时选择的私有索引文件。'],
  HISTORY_TOO_LARGE: [413, '累计历史索引超过本地读取上限。'],
  HISTORY_INVALID: [422, '累计历史索引格式无效，问答已停止，请修复索引后重试。'],
  WORKLINES_UNAVAILABLE: [503, '工作议题暂时无法读取。'],
  WORKLINES_TOO_LARGE: [413, '工作议题文件超过读取上限。'],
  WORKLINES_INVALID: [422, '工作议题格式无效。'],
  REQUEST_NOT_ALLOWED: [403, '此本地服务只接受同源访问。'],
  INVALID_REQUEST: [400, '请求格式无效。'],
  INVALID_ASK_REQUEST: [400, '问题格式无效，请输入问题并仅提交允许的补充事实。'],
  UNKNOWN_CASE: [400, '选择的议题不在当前资料范围内。'],
  ASK_CONTEXT_TOO_LARGE: [413, '资料范围超过本次问答上限，请选择一个具体议题。'],
  INVALID_QA_PRIVACY_CONFIG: [503, '问答隐私配置无效，请检查本地服务配置。'],
  ASK_BUSY: [429, '已有问题正在回答，请等待完成后再提交。'],
  METHOD_NOT_ALLOWED: [405, '此接口不支持该请求方法。'],
  NOT_FOUND: [404, '未找到请求的内容。'],
  APP_NOT_BUILT: [503, '展示页面尚未构建，请先运行本地构建。'],
  SERVER_UNAVAILABLE: [503, '本地展示服务暂时不可用。'],
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

class WorkbenchError extends Error {
  constructor(code, diagnostics) {
    super(ERRORS[code][1]);
    this.code = code;
    this.status = ERRORS[code][0];
    this.diagnostics = diagnostics;
  }
}

export function parseArgs(args) {
  const result = { port: 4595 };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== '--port' && !Object.hasOwn(FILE_FLAGS, flag)) || seen.has(flag) || !value) throw new WorkbenchError('INVALID_ARGUMENTS');
    seen.add(flag);
    if (flag === '--port') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new WorkbenchError('INVALID_ARGUMENTS');
      result.port = Number(value);
    } else {
      if (!isAbsolute(value)) throw new WorkbenchError('INVALID_ARGUMENTS');
      result[FILE_FLAGS[flag]] = value;
    }
  }
  return result;
}

function isWithin(root, target) {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function dataSource({ appRoot = APP_ROOT, checkoutRoot = CHECKOUT_ROOT, dataPath }) {
  if (dataPath === undefined) {
    const file = resolve(appRoot, 'demo.json');
    try {
      const actual = await realpath(file);
      if (actual !== resolve(await realpath(appRoot), 'demo.json')) throw new WorkbenchError('DATA_PATH_NOT_ALLOWED');
      return { file: actual, mode: 'demo' };
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      if (error.code === 'ENOENT' || error.code === 'EACCES') return { file, mode: 'demo' };
      throw new WorkbenchError('DATASET_UNAVAILABLE');
    }
  }
  return { file: await externalFile(dataPath, checkoutRoot), mode: 'private' };
}

async function externalFile(selectedPath, checkoutRoot = CHECKOUT_ROOT, unavailableCode = 'DATASET_UNAVAILABLE') {
  if (typeof selectedPath !== 'string' || !isAbsolute(selectedPath)) throw new WorkbenchError('DATA_PATH_NOT_ALLOWED');
  const root = await realpath(checkoutRoot);
  const selected = resolve(selectedPath);
  if (isWithin(resolve(checkoutRoot), selected) || isWithin(root, selected)) throw new WorkbenchError('DATA_PATH_NOT_ALLOWED');
  let file;
  try {
    file = await realpath(selected);
  } catch (error) {
    // Keep the page available so it can explain missing/unreadable input safely.
    if (error.code === 'ENOENT' || error.code === 'EACCES') return selected;
    throw new WorkbenchError(unavailableCode);
  }
  if (isWithin(root, file)) throw new WorkbenchError('DATA_PATH_NOT_ALLOWED');
  return file;
}

async function readLocalJson(file, maxBytes, errorPrefix) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) throw new WorkbenchError(`${errorPrefix}_UNAVAILABLE`);
    if (info.size > maxBytes) throw new WorkbenchError(`${errorPrefix}_TOO_LARGE`);
    const text = await handle.readFile('utf8');
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new WorkbenchError(`${errorPrefix}_TOO_LARGE`);
    try { return JSON.parse(text); } catch { throw new WorkbenchError(`${errorPrefix}_INVALID`); }
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError(`${errorPrefix}_UNAVAILABLE`);
  } finally {
    await handle?.close();
  }
}

async function documentPolicyInput(options) {
  let documentPolicy = await loadDocumentPolicy();
  if (options.documentPolicyPath) {
    const file = await externalFile(options.documentPolicyPath, options.checkoutRoot, 'DOCUMENT_POLICY_UNAVAILABLE');
    try { documentPolicy = parseDocumentPolicy(await readLocalJson(file, MAX_DISPLAY_MAPPING_BYTES, 'DOCUMENT_POLICY')); }
    catch (error) { if (error instanceof WorkbenchError) throw error; throw new WorkbenchError('DOCUMENT_POLICY_INVALID'); }
  }
  return documentPolicy;
}

async function documentParentPolicyInput(options) {
  if (!options.attentionPath && !options.attentionProvider) return { parentAllowedSourceIds: new Set(), excludedSourceIds: new Set() };
  const store = options.attentionProvider ? await options.attentionProvider() : await loadAttention(await externalFile(options.attentionPath, options.checkoutRoot));
  return { parentAllowedSourceIds: new Set(store.sources.filter(isTrustedListeningSource).map(source => source.id)), excludedSourceIds: new Set(store.sources.filter(source => source.status !== 'active').map(source => source.id)) };
}

export async function loadDataset(options = {}) {
  try {
    // Resolve each selected file again on every read, including display-only
    // inputs. A changed symlink must not bypass the outside-checkout boundary.
    const { file, mode } = options.datasetProvider ? {mode:'private'} : await dataSource(options);
    const dataset = options.datasetProvider ? structuredClone(await options.datasetProvider()) : await readLocalJson(file, MAX_DATASET_BYTES, 'DATASET');
    const validation = validateDataset(dataset);
    if (!validation.valid) throw new WorkbenchError('DATASET_INVALID', validation.errors);
    const documentPolicy = await documentPolicyInput(options);
    const documentParentPolicy = await documentParentPolicyInput(options);
    // A card's summary and model runs depend on every input, not only its displayed citations.
    dataset.cases = dataset.cases.filter(item => documentEvidenceAllowed({ ...item, source_ids: [...(item.source_ids || []), ...(item.inputSourceIds || []), ...(item.input_source_ids || [])] }, documentPolicy, documentParentPolicy) && item.evidence.every(row => documentEvidenceAllowed(row, documentPolicy, documentParentPolicy)));
    const workStructure = projectWorkStructure(dataset);
    if (workStructure === undefined) delete dataset.work_structure;
    else dataset.work_structure = workStructure;
    const result = { dataset, mode, diagnostics: validation.diagnostics };
    const display = await loadDisplay(dataset, options);
    if (display !== undefined) result.display = display;
    if (options.readingGuidePath !== undefined) {
      const guideFile = await externalFile(options.readingGuidePath, options.checkoutRoot, 'READING_GUIDE_UNAVAILABLE');
      const guide = await readLocalJson(guideFile, MAX_READING_GUIDE_BYTES, 'READING_GUIDE');
      if (!validReadingGuide(guide, dataset)) throw new WorkbenchError('READING_GUIDE_INVALID');
      result.reading_guide = guide;
    }
    return result;
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError('DATASET_UNAVAILABLE');
  }
}

function plainShortString(value, maxLength) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) return null;
  const text = value.trim();
  return text.length > 0 && [...text].length <= maxLength ? text : null;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function displayParticipants(source) {
  if (!isRecord(source) || !Array.isArray(source.participant_mapping)) throw new WorkbenchError('DISPLAY_MAPPING_INVALID');
  const aliases = new Set();
  return source.participant_mapping.map(row => {
    if (!isRecord(row) || !nonemptyString(row.alias) || aliases.has(row.alias)
      || (row.verified_display_name !== null && typeof row.verified_display_name !== 'string')
      || !nonemptyString(row.name_binding_status) || !isRecord(row.name_source_evidence_ids)) {
      throw new WorkbenchError('DISPLAY_MAPPING_INVALID');
    }
    aliases.add(row.alias);
    const name = nonemptyString(row.verified_display_name) ? row.verified_display_name : null;
    const providerIdentity = row.name_binding_status === 'PROVIDER_MENTION_IDENTITY'
      || (row.name_binding_status === 'PROVIDER_SENDER_OR_MENTION_IDENTITY'
        && Array.isArray(row.identity_evidence_kinds) && row.identity_evidence_kinds.length > 0
        && row.identity_evidence_kinds.every(kind => ['provider_sender', 'provider_mention'].includes(kind)));
    let displayName = null;
    if (providerIdentity && name
      && Object.hasOwn(row.name_source_evidence_ids, row.verified_display_name)) {
      const evidenceIds = row.name_source_evidence_ids[row.verified_display_name];
      if (!Array.isArray(evidenceIds) || evidenceIds.some(id => typeof id !== 'string' || !id.trim())) {
        throw new WorkbenchError('DISPLAY_MAPPING_INVALID');
      }
      if (evidenceIds.length > 0) displayName = name;
    }
    // Do not spread the source row: platform IDs, binding evidence and other
    // mappings are private inputs, never part of the display API.
    return { alias: row.alias, display_name: displayName };
  });
}

function displayCaseTitles(source, dataset) {
  if (!isRecord(source) || !isRecord(source.case_titles)) throw new WorkbenchError('DISPLAY_MAPPING_INVALID');
  const titles = Object.create(null);
  for (const item of dataset.cases) {
    if (!Object.hasOwn(source.case_titles, item.id)) continue;
    const title = plainShortString(source.case_titles[item.id], 80);
    if (title !== null) titles[item.id] = title;
  }
  return titles;
}

async function loadDisplay(dataset, options) {
  if (options.sourceMapPath === undefined && options.displayTitlesPath === undefined) return undefined;
  const display = { participants: [], case_titles: {} };
  if (options.sourceMapPath !== undefined) {
    const file = await externalFile(options.sourceMapPath, options.checkoutRoot, 'DISPLAY_MAPPING_UNAVAILABLE');
    const source = await readLocalJson(file, MAX_DISPLAY_MAPPING_BYTES, 'DISPLAY_MAPPING');
    display.participants = displayParticipants(source);
  }
  if (options.displayTitlesPath !== undefined) {
    const file = await externalFile(options.displayTitlesPath, options.checkoutRoot, 'DISPLAY_MAPPING_UNAVAILABLE');
    const source = await readLocalJson(file, MAX_DISPLAY_MAPPING_BYTES, 'DISPLAY_MAPPING');
    display.case_titles = displayCaseTitles(source, dataset);
  }
  return display;
}

function headers(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
}

function sendJson(request, response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function checkRequest(request, port) {
  const host = request.headers.host;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) throw new WorkbenchError('REQUEST_NOT_ALLOWED');
  if (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`) throw new WorkbenchError('REQUEST_NOT_ALLOWED');
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new WorkbenchError('REQUEST_NOT_ALLOWED');
  if (!['GET', 'HEAD'].includes(request.method) && !(request.method === 'POST' && ['/api/attention', '/api/ask', '/api/discovery', '/api/discovery-action', '/api/discovery-memory', '/api/setup/save', '/oauth/wps/start', '/api/import', '/api/analyze', '/api/judgments'].includes(request.url) && request.headers.origin === `http://${host}` && request.headers['content-type'] === 'application/json')) throw new WorkbenchError('METHOD_NOT_ALLOWED');
  const rawPath = request.url?.split('?')[0];
  if (!rawPath?.startsWith('/') || rawPath.startsWith('//')) throw new WorkbenchError('INVALID_REQUEST');
  let path;
  try { path = decodeURIComponent(rawPath); } catch { throw new WorkbenchError('INVALID_REQUEST'); }
  if (path.includes('\0') || path.includes('\\') || path.startsWith('//')
    || path.split('/').some(segment => segment === '.' || segment === '..')) throw new WorkbenchError('INVALID_REQUEST');
  return path;
}

async function serveStatic(request, response, appRoot, path) {
  const dist = resolve(appRoot, 'dist');
  const requested = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
  if (!isWithin(dist, requested) || path.split('/').some(segment => segment.startsWith('.'))
    || !MIME[extname(requested)]) throw new WorkbenchError('NOT_FOUND');
  let handle;
  try {
    const root = await realpath(dist);
    if (root !== resolve(await realpath(appRoot), 'dist')) throw new WorkbenchError('NOT_FOUND');
    const target = await realpath(requested);
    if (!isWithin(root, target)) throw new WorkbenchError('NOT_FOUND');
    handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) throw new WorkbenchError('NOT_FOUND');
    response.writeHead(200, { 'Content-Type': MIME[extname(requested)], 'Content-Length': info.size });
    if (request.method === 'HEAD') response.end();
    else await pipeline(handle.createReadStream({ autoClose: false }), response);
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError(path === '/' ? 'APP_NOT_BUILT' : 'NOT_FOUND');
  } finally {
    await handle?.close();
  }
}

async function currentAttention(options) {
  if(options.attentionProvider)return options.attentionProvider();
  return options.attentionPath?loadAttention(await externalFile(options.attentionPath,options.checkoutRoot)):{sources:[]};
}

export function createWorkbenchServer(options = {}) {
  let askActive = false;
  let diagnosticService;
  async function boardInputs() {
    if(!options.discoveryBoardsPath)throw new WorkbenchError('DISCOVERY_BOARDS_UNAVAILABLE');
    const file=await externalFile(options.discoveryBoardsPath,options.checkoutRoot,'DISCOVERY_BOARDS_UNAVAILABLE');
    const store=await readLocalJson(file,1024*1024,'DISCOVERY_BOARDS');
    const attention=await currentAttention(options);
    const sourceRefs=new Map(attention.sources.filter(s=>s.chatId).map(s=>[s.id,String(s.chatId)])),referenceWindows=new Map();
    if(options.historicalTicketScopePath){
      const scope=await readLocalJson(await externalFile(options.historicalTicketScopePath,options.checkoutRoot,'HISTORICAL_TICKETS_UNAVAILABLE'),64*1024,'HISTORICAL_TICKETS');
      if(!validBoardScopeWindow(scope))throw new WorkbenchError('DISCOVERY_BOARDS_INVALID');
      historicalScopeIds(scope,{startAt:scope.startAt,endAt:scope.endAt});
      for(const id of scope.sourceIds)if(!sourceRefs.has(id)){sourceRefs.set(id,scope.sourceRefs[id]);referenceWindows.set(id,{startAt:scope.startAt,endAt:scope.endAt});}
    }
    const policy={allowedSourceIds:new Set(attention.sources.filter(isTrustedListeningSource).map(s=>s.id)),excludedSourceIds:new Set(attention.sources.filter(s=>s.status==='excluded').map(s=>s.id)),sourceRefs,referenceWindows,blockedLocatorHashes:new Set(blockedLocatorConfiguration()),secrets:(options.liveQaProviders??providerConfiguration()).map(p=>p.apiKey).filter(Boolean)};
    return{store,policy};
  }
  async function discovery() {
    if(options.discoveryService) return options.discoveryService;
    if(!options.discoveryPath) return null;
    if(!diagnosticService) diagnosticService=(async()=>createDiagnosticService({
      env:options.diagnosticEnvironment,
      configPath:await externalFile(options.discoveryPath,options.checkoutRoot,'DISCOVERY_UNAVAILABLE'),checkoutRoot:options.checkoutRoot||CHECKOUT_ROOT,
      resolveQuestionContext:async input=>{
        if(!input.boardId&&!input.snapshotId&&!input.historyTicketId)return null;
        const {store,policy}=await boardInputs();
        const config=await readLocalJson(await externalFile(options.discoveryPath,options.checkoutRoot,'DISCOVERY_UNAVAILABLE'),1024*1024,'DISCOVERY');
        if(input.historyTicketId){
          if(!options.historicalTicketsPath||!options.questionContextsPath||!options.historicalTicketScopePath)throw new WorkbenchError('INVALID_DISCOVERY_REQUEST');
          const history=await readLocalJson(await externalFile(options.historicalTicketsPath,options.checkoutRoot,'HISTORICAL_TICKETS_UNAVAILABLE'),12*1024*1024,'HISTORICAL_TICKETS');
          const scope=await readLocalJson(await externalFile(options.historicalTicketScopePath,options.checkoutRoot,'HISTORICAL_TICKETS_UNAVAILABLE'),64*1024,'HISTORICAL_TICKETS');
          const scopeIds=historicalScopeIds(scope,history.window);
          const view=projectHistoricalTickets(history,{...policy,scopeIds});
          if(!view.tickets.some(t=>t.id===input.historyTicketId))throw new WorkbenchError('INVALID_DISCOVERY_REQUEST');
          const graph=await readLocalJson(await externalFile(options.questionContextsPath,options.checkoutRoot,'HISTORICAL_TICKETS_UNAVAILABLE'),16*1024*1024,'HISTORICAL_TICKETS');
          const historyPolicy={...policy,allowedSourceIds:new Set([...policy.allowedSourceIds,...scopeIds]),referenceWindows:new Map([...scopeIds].map(id=>[id,{startAt:scope.startAt,endAt:scope.endAt}]))};
          const context=resolveHistoricalQuestionContext({question:input.question,ticket:history.tickets.find(t=>t.id===input.historyTicketId),normalizedMessages:graph.messages,boards:store,policy:historyPolicy});
          if(context.binding?.status==='BOUND'){
            const board=store.boards.find(b=>b.id===context.binding.boardId);
            if(board?.analysisSourceId!==input.sourceId)throw new WorkbenchError('INVALID_DISCOVERY_REQUEST');
            context.binding.sourceVersion=config.sources.find(s=>s.id===input.sourceId)?.version;
            const found=findBoardSnapshot(store,historyPolicy,context.binding.boardId,context.binding.snapshotId);
            if(!found)throw new WorkbenchError('INVALID_DISCOVERY_REQUEST');
            await readBoardImage(store,found.shot,options.checkoutRoot||CHECKOUT_ROOT);
          }
          return context;
        }
        return resolveBoardQuestion({input,store,policy,checkoutRoot:options.checkoutRoot||CHECKOUT_ROOT,sourceVersion:config.sources.find(s=>s.id===input.sourceId)?.version});
      },
      contextFor:async question=>{
        const {dataset}=await loadDataset(options);
        const context=buildEvidenceContext(dataset,{question,facts:[]},{...await historyInput(),...await sourcePolicy(),blockedLocatorHashes:blockedLocatorConfiguration()});
        return context.sources.slice(0,12).map(row=>({...row,text:row.text.slice(0,1200)}));
      },
      authorizeMemorySource:async entry=>{
        const policy=await sourcePolicy();
        if(entry.kind==='API_EXTRACTED_DOCUMENT_BODY')return typeof entry.canonicalDocumentId==='string'&&documentEvidenceAllowed({source_type:'document',document_id:entry.canonicalDocumentId},policy.documentPolicy,{parentAllowedSourceIds:policy.parentAllowedSourceIds,excludedSourceIds:policy.excludedSourceIds});
        // A derived historical reference inherits every source in its audited scope.
        if(!Array.isArray(entry.requiredSourceIds)||!entry.requiredSourceIds.length)return false;
        const historicalAttention=await currentAttention(options);
        const historicalExcluded=new Set(historicalAttention.sources.filter(item=>item.status==='excluded').map(item=>item.id));
        const extraIds=new Set();
        if(options.historicalTicketScopePath&&options.historicalTicketsPath){
          const scope=await readLocalJson(await externalFile(options.historicalTicketScopePath,options.checkoutRoot,'HISTORICAL_TICKETS_UNAVAILABLE'),64*1024,'HISTORICAL_TICKETS');
          const history=await readLocalJson(await externalFile(options.historicalTicketsPath,options.checkoutRoot,'HISTORICAL_TICKETS_UNAVAILABLE'),12*1024*1024,'HISTORICAL_TICKETS');
          for(const id of historicalScopeIds(scope,history.window))extraIds.add(id);
          const visible=projectHistoricalTickets(history,{allowedSourceIds:policy.allowedSourceIds,excludedSourceIds:historicalExcluded,scopeIds:extraIds,sourceRefs:new Map(scope.sourceIds.map(id=>[id,scope.sourceRefs[id]])),blockedLocatorHashes:new Set(blockedLocatorConfiguration())});
          if(visible.tickets.length!==history.tickets.length)return false;
        }
        return entry.requiredSourceIds.every(id=>!historicalExcluded.has(id)&&((policy.allowedSourceIds||policy.parentAllowedSourceIds)?.has(id)||extraIds.has(id)));
      },
      authorize:async(run,source)=>{
        if(run.questionContext){
          const {store,policy}=await boardInputs();
          if(run.questionContext.historicalTicketId){
            if(!options.historicalTicketScopePath||!options.historicalTicketsPath)return false;
            const scope=await readLocalJson(await externalFile(options.historicalTicketScopePath,options.checkoutRoot,'HISTORICAL_TICKETS_UNAVAILABLE'),64*1024,'HISTORICAL_TICKETS');
            const history=await readLocalJson(await externalFile(options.historicalTicketsPath,options.checkoutRoot,'HISTORICAL_TICKETS_UNAVAILABLE'),12*1024*1024,'HISTORICAL_TICKETS');
            const scopeIds=historicalScopeIds(scope,history.window);
            if(!projectHistoricalTickets(history,{...policy,scopeIds}).tickets.some(t=>t.id===run.questionContext.historicalTicketId))return false;
            policy.allowedSourceIds=new Set([...policy.allowedSourceIds,...scopeIds]);
            policy.referenceWindows=new Map([...scopeIds].map(id=>[id,{startAt:scope.startAt,endAt:scope.endAt}]));
          }
          for(const evidence of run.questionContext.evidence||[])if(!policy.allowedSourceIds.has(evidence.sourceId)||policy.excludedSourceIds.has(evidence.sourceId))return false;
          if(!await questionBindingStillAllowed({context:run.questionContext,sourceId:source.id,sourceVersion:source.version,store,policy,checkoutRoot:options.checkoutRoot||CHECKOUT_ROOT}))return false;
        }
        const policy=await sourcePolicy();
        if((source.sourceIds||[]).some(id=>policy.excludedSourceIds?.has(id)||(policy.allowedSourceIds&&!policy.allowedSourceIds.has(id))))return false;
        const fenced=applySourcePolicyFence({policy_sources:run.businessContext||[],sources:[true],answers:[]},policy.excludedSourceIds,policy.allowedSourceIds,policy.documentPolicy,policy.parentAllowedSourceIds);
        return fenced.sources.length===1;
      }
    }))();
    try{return await diagnosticService;}catch{throw new WorkbenchError('DISCOVERY_UNAVAILABLE');}
  }
  async function sourcePolicy() {
    const documentPolicy = await documentPolicyInput(options);
    const parentPolicy = await documentParentPolicyInput(options);
    let calendars=[];
    if(options.contextSourcesPath){const file=await externalFile(options.contextSourcesPath,options.checkoutRoot);const context=await readLocalJson(file,MAX_CONTEXT_BYTES,'HISTORY');calendars=[...new Set((context.events||[]).map(e=>`calendar:wps-${e.calendarId}`))];}
    return { documentPolicy, ...parentPolicy, ...(options.historyPath ? { allowedSourceIds: new Set([...parentPolicy.parentAllowedSourceIds,...calendars]) } : {}) };
  }
  async function historyInput() {
    if (options.historyPath === undefined) return {};
    const file = await externalFile(options.historyPath, options.checkoutRoot, 'HISTORY_UNAVAILABLE');
    const historyIndex = await readLocalJson(file, MAX_HISTORY_BYTES, 'HISTORY');
    if (!validateHistoryIndex(historyIndex)) throw new WorkbenchError('HISTORY_INVALID');
    return { historyIndex };
  }
  const server = createServer(async (request, response) => {
    headers(response);
    try {
      const path = checkRequest(request, server.address().port);
      if (options.extensionHandler && await options.extensionHandler(request, response, path)) return;
      if(path==='/api/context-sources'||path==='/api/context-image'){
        if(!options.contextSourcesPath){sendJson(request,response,200,{configured:false});return;}
        const file=await externalFile(options.contextSourcesPath,options.checkoutRoot);
        const context=await readLocalJson(file,MAX_CONTEXT_BYTES,'HISTORY');
        const documentPolicy=await documentPolicyInput(options);
        if(path==='/api/context-sources'){sendJson(request,response,200,projectContextSources(context,documentPolicy));return;}
        const params=new URL(request.url,'http://localhost').searchParams;
        if([...params.keys()].some(k=>!['document','hash'].includes(k))||params.getAll('document').length!==1||params.getAll('hash').length!==1)throw new WorkbenchError('INVALID_REQUEST');
        let image;try{image=await readContextImage(context,file,params.get('document'),params.get('hash'),documentPolicy);}catch{throw new WorkbenchError('NOT_FOUND');}
        response.writeHead(200,{'Content-Type':image.mime,'Content-Length':image.body.length,'Cache-Control':'no-store'});response.end(request.method==='HEAD'?undefined:image.body);return;
      }
      if (['/api/discovery-boards', '/api/discovery-board-image', '/api/discovery-board-link'].includes(path)) {
        const params=new URL(request.url,'http://localhost').searchParams;
        const detail=path!=='/api/discovery-boards';
        if ([...params.keys()].some(key=>!detail || !['board','snapshot'].includes(key)) || (detail && (params.getAll('board').length!==1 || params.getAll('snapshot').length!==1))) throw new WorkbenchError('INVALID_REQUEST');
        if (!options.discoveryBoardsPath) {
          if(detail)throw new WorkbenchError('NOT_FOUND');
          sendJson(request,response,200,{configured:false,boards:[]}); return;
        }
        try {
          const file=await externalFile(options.discoveryBoardsPath,options.checkoutRoot,'DISCOVERY_BOARDS_UNAVAILABLE');
          const store=await readLocalJson(file,1024*1024,'DISCOVERY_BOARDS');
          const attention=await currentAttention(options);
          const sourceRefs=new Map(attention.sources.filter(s=>s.chatId).map(s=>[s.id,String(s.chatId)])), referenceWindows=new Map();
          // Older monitored rows omit native IDs. Only the separately authorized,
          // bounded history scope may supply a missing binding; it grants no tier.
          if(options.historicalTicketScopePath) {
            const scopeFile=await externalFile(options.historicalTicketScopePath,options.checkoutRoot,'HISTORICAL_TICKETS_UNAVAILABLE');
            const scope=await readLocalJson(scopeFile,64*1024,'HISTORICAL_TICKETS');
            if(!validBoardScopeWindow(scope))throw new WorkbenchError('DISCOVERY_BOARDS_INVALID');
            historicalScopeIds(scope,{startAt:scope.startAt,endAt:scope.endAt});
            for(const id of scope.sourceIds)if(!sourceRefs.has(id)) { sourceRefs.set(id,scope.sourceRefs[id]);referenceWindows.set(id,{startAt:scope.startAt,endAt:scope.endAt}); }
          }
          const policy={ allowedSourceIds:new Set(attention.sources.filter(isTrustedListeningSource).map(s=>s.id)),
            excludedSourceIds:new Set(attention.sources.filter(s=>s.status==='excluded').map(s=>s.id)),sourceRefs,referenceWindows,
            blockedLocatorHashes:new Set(blockedLocatorConfiguration()),secrets:(options.liveQaProviders ?? providerConfiguration()).map(p=>p.apiKey).filter(Boolean) };
          if(!detail)sendJson(request,response,200,projectBoards(store,policy));
          else {
            const found=findBoardSnapshot(store,policy,params.get('board'),params.get('snapshot'));
            if(!found)throw new WorkbenchError('NOT_FOUND');
            if(path==='/api/discovery-board-link') {
              const target=safeBoardUrl(found.shot.sourceUrl,store.allowedLinkHosts);
              if(!target)throw new WorkbenchError('NOT_FOUND');
              response.writeHead(302,{Location:target}); response.end();
            } else {
              const {bytes,mime}=await readBoardImage(store,found.shot,options.checkoutRoot || CHECKOUT_ROOT);
              response.writeHead(200,{'Content-Type':mime,'Content-Length':bytes.length});response.end(request.method==='HEAD'?undefined:bytes);
            }
          }
        } catch(e) { throw e instanceof WorkbenchError ? e : new WorkbenchError('DISCOVERY_BOARDS_INVALID'); }
      }
      else if (path === '/api/discovery-history' || path === '/api/discovery-history-image') {
        if (!options.historicalTicketsPath) { sendJson(request, response, 200, { configured: false, tickets: [] }); return; }
        const params = new URL(request.url, 'http://localhost').searchParams;
        const mediaRequest=path==='/api/discovery-history-image';
        const keys=mediaRequest?['ticket','image']:['id'];
        if ([...params.keys()].some(key => !keys.includes(key)) || keys.some(key=>params.getAll(key).length>1) || mediaRequest&&keys.some(key=>!params.get(key))) throw new WorkbenchError('INVALID_REQUEST');
        const ticketId=mediaRequest?params.get('ticket'):params.get('id');
        const file = await externalFile(options.historicalTicketsPath, options.checkoutRoot, 'HISTORICAL_TICKETS_UNAVAILABLE');
        const store = await readLocalJson(file, 12 * 1024 * 1024, 'HISTORICAL_TICKETS');
        let scopeIds = new Set(), sourceRefs = new Map();
        if (options.historicalTicketScopePath) {
          const scopeFile = await externalFile(options.historicalTicketScopePath, options.checkoutRoot, 'HISTORICAL_TICKETS_UNAVAILABLE');
          const scope = await readLocalJson(scopeFile, 64 * 1024, 'HISTORICAL_TICKETS');
          try { scopeIds = historicalScopeIds(scope, { startAt: store.window?.startAt ?? store.window?.start, endAt: store.window?.endAt ?? store.window?.end }); sourceRefs = new Map(scope.sourceIds.map(id => [id, scope.sourceRefs[id]])); }
          catch { throw new WorkbenchError('HISTORICAL_TICKETS_INVALID'); }
        }
        // Read current controls after the evidence file. A one-time historical
        // scope may allow a candidate, but never override an explicit exclusion.
        const attention = await currentAttention(options);
        const allowedSourceIds = new Set(attention.sources.filter(isTrustedListeningSource).map(source => source.id));
        const excludedSourceIds = new Set(attention.sources.filter(source => source.status === 'excluded').map(source => source.id));
        // A historical grant cannot follow a source ID after its native chat is rebound.
        for(const source of attention.sources)if(sourceRefs.has(source.id)&&(!source.chatId||sourceRefs.get(source.id)!==String(source.chatId)))excludedSourceIds.add(source.id);
        const secrets = (options.liveQaProviders ?? providerConfiguration()).map(provider => provider.apiKey).filter(Boolean);
        let result;
        try { result = projectHistoricalTickets(store, { allowedSourceIds, excludedSourceIds, scopeIds, sourceRefs, blockedLocatorHashes: new Set(blockedLocatorConfiguration()), secrets, ...(ticketId ? { ticketId } : {}) }); }
        catch { throw new WorkbenchError('HISTORICAL_TICKETS_INVALID'); }
        if (!result) throw new WorkbenchError('NOT_FOUND');
        if (result.ticket && options.historicalMediaPath && options.questionContextsPath) {
          const media=await readLocalJson(await externalFile(options.historicalMediaPath,options.checkoutRoot,'HISTORICAL_TICKETS_UNAVAILABLE'),2*1024*1024,'HISTORICAL_TICKETS');
          const graph=await readLocalJson(await externalFile(options.questionContextsPath,options.checkoutRoot,'HISTORICAL_TICKETS_UNAVAILABLE'),16*1024*1024,'HISTORICAL_TICKETS');
          const rawTicket=store.tickets.find(ticket=>ticket.id===ticketId);
          const rows=authorizedHistoricalMedia(media,rawTicket,graph.messages,{allowedSourceIds:new Set([...allowedSourceIds,...scopeIds]),excludedSourceIds,sourceRefs,blockedLocatorHashes:new Set(blockedLocatorConfiguration())},store.window);
          if(mediaRequest){
            const row=rows.find(row=>row.id===params.get('image')&&row.status==='VERIFIED');
            if(!row)throw new WorkbenchError('NOT_FOUND');
            const image=await readBoardImage(media,row,options.checkoutRoot||CHECKOUT_ROOT);
            response.writeHead(200,{'Content-Type':image.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(image.bytes);return;
          }
          result.ticket.media=projectHistoricalMedia(rows,ticketId,secrets);
        } else if(mediaRequest)throw new WorkbenchError('NOT_FOUND');
        sendJson(request, response, 200, result);
      }
      else if (path === '/api/discovery' || path === '/api/discovery-action' || path === '/api/discovery-memory') {
        const service=await discovery();
        if(!service){
          if(request.method==='POST')throw new WorkbenchError('DISCOVERY_UNAVAILABLE');
          sendJson(request,response,200,{configured:false,agent:await loadDiagnosticAgent(),sources:[],runs:[],capabilities:{modelReady:false,executorReady:false}});return;
        }
        let result;
        try{
          if(request.method==='POST'){
            const chunks=[];let bytes=0;for await(const chunk of request){bytes+=chunk.length;if(bytes>64_000)throw new WorkbenchError('INVALID_DISCOVERY_REQUEST');chunks.push(chunk);}
            let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new WorkbenchError('INVALID_DISCOVERY_REQUEST');}
            result=path==='/api/discovery'?await service.create(input):path==='/api/discovery-memory'?await service.memoryAction(input):await service.action(input);
          }else{
            if(path==='/api/discovery-memory'){
              if(new URL(request.url,'http://localhost').search)throw new WorkbenchError('INVALID_DISCOVERY_REQUEST');
              sendJson(request,response,200,await service.memoryList());return;
            }
            if(path!=='/api/discovery')throw new WorkbenchError('METHOD_NOT_ALLOWED');
            const params=new URL(request.url,'http://localhost').searchParams;
            if([...params.keys()].some(k=>k!=='id')||params.getAll('id').length>1)throw new WorkbenchError('INVALID_DISCOVERY_REQUEST');
            result=params.has('id')?await service.get(params.get('id')):await service.list();
          }
        }catch(e){throw e instanceof WorkbenchError?e:new WorkbenchError(Object.hasOwn(ERRORS,e.code)?e.code:'DISCOVERY_UNAVAILABLE');}
        sendJson(request,response,200,result);
      }
      else if (path === '/api/ask') {
        if (request.method !== 'POST') throw new WorkbenchError('METHOD_NOT_ALLOWED');
        if (askActive) throw new WorkbenchError('ASK_BUSY');
        askActive = true;
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 64 * 1024) throw new WorkbenchError('INVALID_ASK_REQUEST');
            chunks.push(chunk);
          }
          let input;
          try { input = validateAskInput(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { throw new WorkbenchError('INVALID_ASK_REQUEST'); }
          const { dataset } = await loadDataset(options);
          const result = await askQuestion({ dataset, input, ...await historyInput(), ...await sourcePolicy(),
            ...(options.liveQaProviders ? { providers: options.liveQaProviders } : {}),
            ...(options.liveQaFetch ? { fetchImpl: options.liveQaFetch } : {}),
            ...(options.liveQaTimeoutMs ? { timeoutMs: options.liveQaTimeoutMs } : {}) });
          // Excluding a source while models are answering must hide the result.
          const currentPolicy = await sourcePolicy();
          sendJson(request, response, 200, applySourcePolicyFence(result, currentPolicy.excludedSourceIds, currentPolicy.allowedSourceIds, currentPolicy.documentPolicy, currentPolicy.parentAllowedSourceIds));
        } finally { askActive = false; }
      }
      else if (path === '/api/ask-scope') {
        const params = new URL(request.url, 'http://localhost').searchParams;
        if ([...params.keys()].some(key => !['case_id', 'question'].includes(key)) || params.getAll('case_id').length > 1 || params.getAll('question').length > 1) throw new WorkbenchError('INVALID_ASK_REQUEST');
        const input = validateAskInput({ question: params.has('question') ? params.get('question') : 'scope', facts: [], ...(params.has('case_id') ? { case_id: params.get('case_id') } : {}) });
        const { dataset } = await loadDataset(options);
        const secrets = (options.liveQaProviders ?? providerConfiguration()).map(provider => provider.apiKey).filter(Boolean);
        const history = await historyInput();
        const scopeInput = history.historyIndex && !params.has('question') ? { ...input, question: '' } : input;
        const context = buildEvidenceContext(dataset, scopeInput, { ...history, ...await sourcePolicy(), blockedLocatorHashes: blockedLocatorConfiguration(), secrets });
        sendJson(request, response, 200, buildAskScope(dataset, input, context));
      }
      else if (path === '/api/worklines') {
        if(!options.worklinesPath){sendJson(request,response,200,{configured:false,candidates:[],associations:[]});return;}
        const file=await externalFile(options.worklinesPath,options.checkoutRoot,'WORKLINES_UNAVAILABLE');
        const store=await readLocalJson(file,MAX_DISPLAY_MAPPING_BYTES,'WORKLINES');
        if(store.version!=='workline-discovery-v2'||!Array.isArray(store.candidates))throw new WorkbenchError('WORKLINES_INVALID');
        const blocked=new Set();
        {const policy=await currentAttention(options);for(const s of policy.sources)if(s.status==='excluded')blocked.add(s.id);}
        const currentPolicy = await sourcePolicy();
        const documentPolicy = currentPolicy.documentPolicy;
        const documentsAllowed = row => documentEvidenceAllowed({ ...row, source_ids: row.inputSourceIds || [] }, documentPolicy, currentPolicy) && (row.evidenceRefs || []).every(ref => documentEvidenceAllowed({ ...ref, source_id: ref.sourceId }, documentPolicy, currentPolicy));
        const visible=row=>documentsAllowed(row)&&(row.history || []).every(documentsAllowed)&&Array.isArray(row.evidenceRefs)&&row.evidenceRefs.length>0&&[...row.evidenceRefs,...(row.history||[]).flatMap(h=>h.evidenceRefs||[])].every(r=>r&&typeof r.sourceId==='string'&&!blocked.has(r.sourceId))&&[...(row.inputSourceIds||[]),...(row.history||[]).flatMap(h=>h.inputSourceIds||[])].every(id=>!blocked.has(id));
        const project=row=>({id:row.id,title:row.title,objective:row.objective,reason:row.reason,kind:row.kind,status:row.status,subtask:row.subtask,firstSeenAt:row.firstSeenAt,lastSeenAt:row.lastSeenAt,evidenceCount:row.evidenceRefs.length,sourceCount:new Set(row.evidenceRefs.map(r=>r.sourceId)).size});
        sendJson(request,response,200,{configured:true,updatedAt:store.updatedAt,status:store.lastReceipt?.status||'NOT_RUN',coverageLimited:store.lastReceipt?.boundary?.truncated===true,insufficientCount:store.lastReceipt?.insufficient?.length||0,candidates:store.candidates.filter(visible).map(project),associations:(store.lastReceipt?.associations||[]).filter(visible).map(project)});
      }
      else if (path === '/api/attention' || path === '/api/read-plan') {
        if (options.attentionProvider) {
          let value;
          if(request.method==='POST'){ let body='';for await(const chunk of request){body+=chunk;if(Buffer.byteLength(body)>4096)throw new WorkbenchError('INVALID_REQUEST');}try{value=JSON.parse(body);}catch{throw new WorkbenchError('INVALID_REQUEST');}}
          const store=await options.attentionProvider(value);sendJson(request,response,200,path==='/api/read-plan'?{sources:readPlan(store)}:{...store,configured:true});return;
        }
        if (!options.attentionPath) { sendJson(request,response,200,{configured:false,sources:[]});return; }
        const file=await externalFile(options.attentionPath,options.checkoutRoot);
        if(request.method==='POST') {
          let body='';for await(const chunk of request){body+=chunk;if(Buffer.byteLength(body)>4096)throw new WorkbenchError('INVALID_REQUEST');}
          let value;try{value=JSON.parse(body);}catch{throw new WorkbenchError('INVALID_REQUEST');}
          try {sendJson(request,response,200,await saveChange(file,value.id,value.action,value.tier));}catch{throw new WorkbenchError('INVALID_REQUEST');}
        }else { const store=await loadAttention(file);sendJson(request,response,200,path==='/api/read-plan'?{sources:readPlan(store)}:{...store,configured:true}); }
      }
      else if (path === '/api/dataset') sendJson(request, response, 200, await loadDataset(options));
      else if (path.startsWith('/api/')) throw new WorkbenchError('NOT_FOUND');
      else await serveStatic(request, response, options.appRoot ?? APP_ROOT, path);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const safe = error instanceof WorkbenchError ? error
        : error instanceof LiveQaError && Object.hasOwn(ERRORS, error.code) ? new WorkbenchError(error.code)
          : new WorkbenchError('SERVER_UNAVAILABLE');
      if (safe.code === 'METHOD_NOT_ALLOWED') response.setHeader('Allow', request.url === '/api/ask' ? 'POST' : 'GET, HEAD');
      sendJson(request, response, safe.status, {
        error: { code: safe.code, message: safe.message },
        ...(safe.diagnostics ? { diagnostics: safe.diagnostics } : {}),
      });
    }
  });
  server.closeDiagnostics=async()=>{if(diagnosticService)try{await(await diagnosticService).close();}catch{/* Safe failure was reported on the API. */}};
  server.on('close',()=>void server.closeDiagnostics());
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

export async function startWorkbenchServer(options = {}) {
  if (!options.datasetProvider) await dataSource(options);
  if (options.documentPolicyPath !== undefined) {
    await externalFile(options.documentPolicyPath, options.checkoutRoot, 'DOCUMENT_POLICY_UNAVAILABLE');
    try { await loadDocumentPolicy(options.documentPolicyPath); } catch { throw new WorkbenchError('DOCUMENT_POLICY_INVALID'); }
  }
  if (options.historyPath !== undefined) await externalFile(options.historyPath, options.checkoutRoot, 'HISTORY_UNAVAILABLE');
  for (const key of ['sourceMapPath', 'displayTitlesPath']) {
    if (options[key] !== undefined) await externalFile(options[key], options.checkoutRoot, 'DISPLAY_MAPPING_UNAVAILABLE');
  }
  if (options.readingGuidePath !== undefined) await externalFile(options.readingGuidePath, options.checkoutRoot, 'READING_GUIDE_UNAVAILABLE');
  const port = options.port ?? 4595;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new WorkbenchError('INVALID_ARGUMENTS');
  const server = createWorkbenchServer(options);
  await new Promise((resolveStarted, reject) => {
    const failed = error => { server.off('listening', started); reject(error); };
    const started = () => { server.off('error', failed); resolveStarted(); };
    server.once('error', failed);
    server.once('listening', started);
    server.listen(port, '127.0.0.1');
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const server = await startWorkbenchServer(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Local display candidate: http://127.0.0.1:${server.address().port}\n`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {await server.closeDiagnostics();server.close(() => process.exit(0));});
  } catch (error) {
    const safe = error instanceof WorkbenchError ? error : new WorkbenchError('SERVER_UNAVAILABLE');
    process.stderr.write(`${safe.code}: ${safe.message}\n`);
    process.exitCode = 1;
  }
}
