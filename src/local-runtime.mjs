import { buildWpsAuthorizationUrl, exchangeWpsAuthorizationCode } from "./wps-oauth.mjs";
import { createWpsMessageClient } from "./wps-message-client.mjs";
import { createPublicCandidateWorkbench } from "./public-workbench.mjs";
import {readContextSummary,readContextImage}from'./context-view.mjs';

export function createLocalTrialRuntime({
  config,
  store,
  oauth,
  wpsClientFactory = (options) => createWpsMessageClient(options),
  inference,
  now = () => new Date(),
  contextPath,
}) {
  let authorizationState;
  let selectableChats = new Map();
  const oauthPort = oauth || {
    buildAuthorization: () => buildWpsAuthorizationUrl({
      appId: config.wps.appId,
      redirectUri: config.wps.redirectUri,
      scopes: config.wps.scopes,
    }),
    exchange: ({ code }) => exchangeWpsAuthorizationCode({
      appId: config.wps.appId,
      appKey: config.wps.appKey,
      redirectUri: config.wps.redirectUri,
      code,
    }),
  };
  const publicWorkbench = createPublicCandidateWorkbench({ store, now });

  async function credentials() {
    const value = await store.read("credentials");
    if (!value?.accessToken) throw new Error("请先完成 WPS 用户授权");
    return value;
  }

  return Object.freeze({
    async readContextSources(){return readContextSummary(contextPath);},
    async readContextImage(document,hash){return readContextImage(contextPath,document,hash);},
    async status() {
      const credential = await store.read("credentials");
      const workspace = await store.read("workspace");
      return {
        configured: config.ready,
        wpsAuthorized: Boolean(credential?.accessToken),
        importedMessages: workspace?.messages?.length || 0,
        importComplete: workspace?.sources?.every((source) => source.completeness?.complete) ?? false,
        analyzedAt: workspace?.analysis?.generatedAt || null,
      };
    },
    beginAuthorization() {
      const result = oauthPort.buildAuthorization();
      authorizationState = { value: result.state, expiresAt: Date.now() + 10 * 60 * 1000 };
      return result;
    },
    async finishAuthorization({ code, state }) {
      if (!authorizationState || state !== authorizationState.value || Date.now() > authorizationState.expiresAt) {
        throw new Error("WPS OAuth state 无效或已过期");
      }
      authorizationState = undefined;
      const result = await oauthPort.exchange({ code });
      await store.write("credentials", result);
      return { authorized: true };
    },
    async listChats() {
      const credential = await credentials();
      const result = await wpsClientFactory({ accessToken: credential.accessToken }).listChats();
      const groupChats = result.chats.filter((chat) => chat.groupChat && !chat.privateChat);
      selectableChats = new Map(groupChats.map((chat) => [chat.id, chat]));
      return { chats: groupChats, completeness: result.completeness, hiddenPrivateChats: result.chats.length - groupChats.length };
    },
    async importMessages({ chatIds, days }) {
      if (!Array.isArray(chatIds) || chatIds.length < 1 || chatIds.length > 10) throw new Error("请选择 1 至 10 个群聊");
      if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("首轮只支持最近 1 至 30 天");
      for (const chatId of chatIds) {
        if (!selectableChats.has(chatId)) throw new Error("只能导入刚刚读取并显示的群聊；私聊默认不进入首轮试用");
      }
      const credential = await credentials();
      const client = wpsClientFactory({ accessToken: credential.accessToken });
      const endAt = now();
      const startAt = new Date(endAt.getTime() - days * 24 * 60 * 60 * 1000);
      const messages = [];
      const sources = [];
      for (const chatId of [...new Set(chatIds)]) {
        const result = await client.getMessages({ chatId, startAt: startAt.toISOString(), endAt: endAt.toISOString() });
        const chat = selectableChats.get(chatId);
        messages.push(...result.messages.map((item) => ({ ...item, chatId, chatName: chat.name })));
        sources.push({ chatId, chatName: chat.name, messageCount: result.messages.length, completeness: result.completeness });
      }
      await store.write("workspace", {
        importedAt: endAt.toISOString(),
        range: { startAt: startAt.toISOString(), endAt: endAt.toISOString() },
        chatIds: [...new Set(chatIds)],
        sources,
        messages,
      });
      return {
        messageCount: messages.length,
        complete: sources.every((source) => source.completeness.complete),
        sources,
        range: { startAt: startAt.toISOString(), endAt: endAt.toISOString() },
      };
    },
    async analyzeImportedMessages() {
      const workspace = await store.read("workspace");
      if (!workspace?.messages?.length) throw new Error("请先导入消息");
      if (!workspace.sources?.every((source) => source.completeness?.complete)) {
        throw new Error("当前导入存在截断；请缩短时间范围或减少群聊后重新导入，再进行分析");
      }
      const result = await inference.analyze({ messages: workspace.messages });
      const evidenceById = new Map(workspace.messages.map((message) => [message.id, message]));
      const candidates = result.candidates.map((candidate) => ({
        title: String(candidate.title || "候选"),
        reason: String(candidate.reason || ""),
        nextQuestion: String(candidate.nextQuestion || ""),
        evidence: [...new Set(Array.isArray(candidate.evidenceIds) ? candidate.evidenceIds : [])]
          .map((id) => evidenceById.get(id))
          .filter(Boolean)
          .slice(0, 3)
          .map((message) => ({
            messageId: message.id,
            chatName: message.chatName,
            occurredAt: message.occurredAt,
            excerpt: message.text.slice(0, 220),
          })),
      }));
      const analysis = { summary: result.summary, candidates, generatedAt: now().toISOString(), judgments: [] };
      await store.write("workspace", { ...workspace, analysis });
      return analysis;
    },
    async saveJudgment({ candidateIndex, decision }) {
      const allowed = new Set(["important", "related", "noise", "uncertain"]);
      if (!Number.isInteger(candidateIndex) || !allowed.has(decision)) throw new Error("裁决参数无效");
      const workspace = await store.read("workspace");
      if (!workspace?.analysis?.candidates?.[candidateIndex]) throw new Error("候选不存在");
      const judgments = (workspace.analysis.judgments || []).filter((item) => item.candidateIndex !== candidateIndex);
      judgments.push({ candidateIndex, decision, decidedAt: now().toISOString() });
      workspace.analysis.judgments = judgments;
      await store.write("workspace", workspace);
      return { saved: true, candidateIndex, decision };
    },
    async readWorkspace() {
      const workspace = await store.read("workspace");
      if (!workspace) return { range: null, chatIds: [], messageCount: 0, analysis: null };
      return {
        range: workspace.range,
        chatIds: workspace.chatIds,
        messageCount: workspace.messages?.length || 0,
        sources: workspace.sources || [],
        analysis: workspace.analysis || null,
      };
    },
    async readPublicWorkbench() {
      return publicWorkbench.read();
    },
    async confirmPublicConflict(input) {
      return publicWorkbench.confirmConflict(input);
    },
  });
}
