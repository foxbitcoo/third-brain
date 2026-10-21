const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");
const request = async (url, options) => {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || value.error);
  return value;
};
const post = (url, body) => request(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const routePanels = {
  home: ["home"],
  decisions: ["analysisPanel", "decisions"],
  sources: ["sources", "sourceImport", "contextSources"],
  relationships: ["relationships"],
  settings: ["settings"],
};

const decisionLabels = {
  important: "重要",
  related: "相关但非重点",
  noise: "噪声",
  uncertain: "不确定",
};

for (const [route, ids] of Object.entries(routePanels)) {
  for (const id of ids) byId(id).dataset.routePanel = route;
}

function activeRoute() {
  const value = location.hash.slice(1) || "home";
  return routePanels[value] ? value : "home";
}

function renderRoute() {
  const active = activeRoute();
  for (const [route, ids] of Object.entries(routePanels)) {
    for (const id of ids) byId(id).hidden = route !== active;
  }
  document.querySelectorAll("[data-route-link]").forEach((link) => {
    link.setAttribute("aria-current", link.dataset.routeLink === active ? "page" : "false");
  });
}

function candidateCard(candidate) {
  const conflict = candidate.conflictingClaims
    ? "<p class=\"workbench-note\">冲突说法：" + candidate.conflictingClaims
      .map((claim) => escapeHtml(claim.statement) + "（" + escapeHtml(claim.sourceLabel) + "）").join("；") + "</p>"
      + "<div class=\"workbench-form\"><input id=\"conflict-event-type-" + candidate.id + "\" placeholder=\"事件类型（必填）\">"
      + "<input id=\"conflict-business-statement-" + candidate.id + "\" placeholder=\"业务事实（必填）\">"
      + "<input id=\"conflict-occurred-at-" + candidate.id + "\" placeholder=\"发生时间 ISO UTC（必填）\">"
      + "<button onclick=\"confirmConflict('" + candidate.id + "')\">确认三字段裁决</button></div>"
    : "";
  return "<article class=\"workbench-card\"><h3>" + escapeHtml(candidate.title) + "</h3><p>"
    + escapeHtml(candidate.businessChange) + "</p><p class=\"workbench-note\">判读规则："
    + escapeHtml(candidate.rule) + "<br>类型：" + escapeHtml(candidate.eventType)
    + " · 时间：" + escapeHtml(candidate.occurredAt) + " · 合成人物：" + escapeHtml(candidate.actor)
    + "<br>来源：" + escapeHtml(candidate.sourceLabel) + " · 最小依据：" + escapeHtml(candidate.minimumEvidence)
    + "<br>待判断：" + escapeHtml(candidate.userDecision) + " · 推荐：" + escapeHtml(candidate.recommendation)
    + "</p><span class=\"pill " + (candidate.lineage.accepted === 7 ? "ok" : "") + "\">候选集谱系 "
    + candidate.lineage.accepted + "/" + candidate.lineage.expected + " · " + escapeHtml(candidate.lineage.status)
    + "</span>" + conflict + "</article>";
}

async function renderWorkbench() {
  const workbench = await request("/api/public-workbench");
  byId("workbench").innerHTML = "<p class=\"workbench-label\">候选区 · 判读区 · 冲突确认区</p>"
    + workbench.candidates.map(candidateCard).join("");
}

async function renderContext(){
 try{
  const context=await request('/api/context-sources');if(!context.configured)return;
  const esc=escapeHtml;
  const states={NOT_DUE:'会议尚未结束',RECORD_CHECK_DUE:'会后待查记录',CANCELED:'已取消',TIME_UNAVAILABLE:'时间待核对'};
  byId('contextResult').innerHTML='<p>'+esc(context.updatedAt)+' · '+(context.status==='COMPLETE'?'本轮检查完成':'部分完成，保留待补读项')+'</p>'
   +context.events.map(e=>'<article class="workbench-card"><h3>'+esc(e.title)+'</h3><p>'+esc(e.start)+' — '+esc(e.end)+'</p><p>'+esc(states[e.state]||e.state)+' · '+e.attendees.map(a=>esc(a.name)).join('、')+'</p><small>会邀是工作安排，不代表会议已举行或行动已完成。</small></article>').join('')
   +'<details><summary>参会人候选（'+context.candidates.length+'）</summary>'+context.candidates.map(c=>'<p>'+esc(c.name)+' · 仅候选，未自动关注</p>').join('')+'</details>'
   +'<details><summary>文档与图片（'+context.documents.length+'）</summary>'+context.documents.map(d=>'<article class="workbench-card"><h3>'+esc(d.title)+'</h3><p>版本 '+esc(d.version??'未知')+' · '+esc(d.change)+' · 图片 '+d.imagesRead+'/'+d.imageCount+' 已识别</p>'+d.images.map(i=>'<figure><img loading="lazy" style="max-width:100%;max-height:480px;object-fit:contain" src="'+esc(i.url)+'" alt="文档原图"><figcaption>'+esc(i.heading)+'</figcaption></figure>').join('')+'</article>').join('')+'</details>'
   +'<details><summary>会后检查（'+context.meetingChecks.length+'）</summary>'+context.meetingChecks.map(m=>'<p>'+esc(states[m.state]||m.state)+(m.complete?'':' · 覆盖不完整')+'</p>').join('')+'</details>';
 }catch{byId('contextResult').textContent='本地资料刷新回执暂时无法读取。';}
}

window.confirmConflict=async (candidateId) => {
  try {
    await post("/api/public-workbench/conflicts", {
      candidateId,
      eventType: byId("conflict-event-type-" + candidateId).value,
      businessStatement: byId("conflict-business-statement-" + candidateId).value,
      occurredAt: byId("conflict-occurred-at-" + candidateId).value,
    });
    await renderWorkbench();
  } catch (error) {
    alert(error.message);
  }
};

async function refreshStatus() {
  const status = await request("/api/status");
  byId("status").innerHTML = "<span class=\"pill " + (status.configured ? "ok" : "") + "\">配置"
    + (status.configured ? "完成" : "缺失") + "</span><span class=\"pill "
    + (status.wpsAuthorized ? "ok" : "") + "\">WPS" + (status.wpsAuthorized ? "已授权" : "未授权")
    + "</span><span class=\"pill " + (status.importedMessages && status.importComplete ? "ok" : "") + "\">"
    + (status.importedMessages || 0) + " 条本地消息" + (status.importedMessages && !status.importComplete ? "（不完整）" : "") + "</span>";
  byId("analyze").disabled = !status.importedMessages || !status.importComplete;
}

byId("navToggle").onclick = () => {
  const navigation = byId("workbenchNav");
  navigation.classList.toggle("open");
  byId("navToggle").setAttribute("aria-expanded", String(navigation.classList.contains("open")));
};
document.querySelectorAll(".workbench-nav a").forEach((link) => {
  link.onclick = (event) => {
    event.preventDefault();
    location.hash = link.dataset.routeLink;
    byId("workbenchNav").classList.remove("open");
  };
});
byId("authorize").onclick = async () => {
  try {
    location.href = (await post("/oauth/wps/start", {})).url;
  } catch (error) {
    alert(error.message);
  }
};
byId("load").onclick = async () => {
  try {
    const result = await request("/api/chats");
    const chats = result.chats || [];
    const completeness = result.completeness?.complete
      ? ""
      : "<p class=\"error\">会话清单未完整：" + escapeHtml(result.completeness?.reason) + "</p>";
    const hiddenPrivateChats = result.hiddenPrivateChats
      ? "<p>首轮已隐藏 " + escapeHtml(result.hiddenPrivateChats) + " 个私聊；私聊不会被导入。</p>"
      : "";
    byId("chats").innerHTML = completeness + hiddenPrivateChats + chats.map((chat) => "<label class=\"chat\"><input type=\"checkbox\" value=\""
      + escapeHtml(chat.id) + "\"><span><b>" + escapeHtml(chat.name) + "</b><br><small>"
      + escapeHtml(chat.type) + "</small></span></label>").join("") || "<p>没有读取到群聊。</p>";
    byId("import").disabled = !chats.length;
  } catch (error) {
    byId("chats").innerHTML = "<p class=\"error\">" + escapeHtml(error.message) + "</p>";
  }
};
byId("import").onclick = async () => {
  const chatIds = [...document.querySelectorAll("#chats input:checked")].map((item) => item.value);
  try {
    const result = await post("/api/import", { chatIds, days: Number(byId("days").value) });
    const range = result.range
      ? escapeHtml(result.range.startAt.slice(0, 10)) + " 至 " + escapeHtml(result.range.endAt.slice(0, 10))
      : "本次选择范围";
    const completeness = result.complete ? "（完整）" : "（存在截断，已禁止分析）";
    const sources = (result.sources || []).map((source) => "<small>" + escapeHtml(source.chatName) + "："
      + escapeHtml(source.messageCount) + " 条 · " + (source.completeness.complete
        ? "完整"
        : "截断（" + escapeHtml(source.completeness.reason) + "）") + "</small><br>").join("");
    const retry = result.complete ? "" : "<p class=\"error\">请缩短时间范围或减少群聊后重新导入。</p>";
    byId("importResult").innerHTML = "<p>已加密保存 " + escapeHtml(result.messageCount) + " 条，"
      + range + completeness + "</p>" + sources + retry;
    await refreshStatus();
  } catch (error) {
    byId("importResult").textContent = error.message;
  }
};

window.saveDecision=async (candidateIndex, decision) => {
  await post("/api/judgments", { candidateIndex, decision });
  document.querySelector('[data-decision-for="' + candidateIndex + '"]').textContent = "已记录：" + decisionLabels[decision];
};

byId("analyze").onclick = async () => {
  const output = byId("analysis");
  try {
    output.hidden = false;
    output.textContent = "分析中…";
    const result = await post("/api/analyze", {});
    output.innerHTML = "<b>" + escapeHtml(result.summary) + "</b>" + (result.candidates || []).map((candidate, index) =>
      "<div class=\"candidate\"><b>" + escapeHtml(candidate.title || "候选") + "</b><p>"
      + escapeHtml(candidate.reason || "") + "</p><small>" + escapeHtml(candidate.nextQuestion || "") + "</small><div>"
      + ((candidate.evidence || []).map((evidence) => "<p><b>" + escapeHtml(evidence.chatName) + "</b> · "
        + escapeHtml(evidence.occurredAt) + "<br>“" + escapeHtml(evidence.excerpt) + "”</p>").join("")
        || "<p class=\"error\">该候选没有可回查依据，请优先判为不确定。</p>")
      + "</div><p>" + Object.entries(decisionLabels).map(([key, label]) =>
        "<button class=\"secondary\" onclick=\"saveDecision(" + index + ",'" + key + "')\">" + label + "</button>").join(" ")
      + " <span data-decision-for=\"" + index + "\"></span></p></div>").join("");
  } catch (error) {
    output.textContent = error.message;
  }
};

addEventListener("hashchange", renderRoute);
addEventListener("popstate", renderRoute);
async function initializeWorkbench() {
  renderRoute();
  await refreshStatus();
  await renderWorkbench();
  await renderContext();
}
void initializeWorkbench();
