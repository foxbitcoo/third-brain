import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function assertSameOriginJson(request) {
  const expectedOrigin = `http://${request.headers.host}`;
  if (request.headers.origin !== expectedOrigin) throw new Error("请求来源不是当前本地页面");
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new Error("请求必须使用 application/json");
  }
}

function assertLoopbackHost(request) {
  try {
    const hostname = new URL(`http://${request.headers.host}`).hostname;
    if (hostname !== "127.0.0.1") throw new Error();
  } catch {
    throw new Error("本地服务只接受 127.0.0.1 Host");
  }
}

function isDisabledReportRoute(pathname) {
  return pathname === "/api/public-workbench/report-history"
    || pathname === "/api/public-workbench/reports"
    || pathname.startsWith("/api/public-workbench/reports/");
}

export function createLocalHttpServer({ runtime, indexFile }) {
  const indexPath = typeof indexFile === "string" ? indexFile : fileURLToPath(indexFile);
  return createServer(async (request, response) => {
    try {
      assertLoopbackHost(request);
      const url = new URL(request.url, "http://127.0.0.1");
      if(request.method==='GET'&&url.pathname==='/api/context-sources')return json(response,200,await runtime.readContextSources());
      if(request.method==='GET'&&url.pathname==='/api/context-image'){
        const image=await runtime.readContextImage(url.searchParams.get('document'),url.searchParams.get('hash'));
        response.writeHead(200,{'content-type':image.mime,'cache-control':'no-store','x-content-type-options':'nosniff'});response.end(image.body);return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        const html = await readFile(indexPath, "utf8");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
          "x-frame-options": "DENY",
        });
        response.end(html);
        return;
      }
      if (request.method === "GET" && url.pathname === "/workbench-ui.js") {
        const script = await readFile(indexPath.replace(/index\.html$/u, "workbench-ui.js"), "utf8");
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(script);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/status") return json(response, 200, await runtime.status());
      if (request.method === "GET" && url.pathname === "/api/workspace") return json(response, 200, await runtime.readWorkspace());
      if (request.method === "GET" && url.pathname === "/api/public-workbench") return json(response, 200, await runtime.readPublicWorkbench());
      if (isDisabledReportRoute(url.pathname)) {
        return json(response, 404, { error: "feature_not_available", feature: "report_to_issue" });
      }
      if (request.method === "POST" && url.pathname === "/oauth/wps/start") {
        assertSameOriginJson(request);
        return json(response, 200, { url: runtime.beginAuthorization().url });
      }
      if (request.method === "GET" && url.pathname === "/oauth/wps/callback") {
        await runtime.finishAuthorization({ code: url.searchParams.get("code"), state: url.searchParams.get("state") });
        response.writeHead(302, { location: "/?authorized=1", "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/chats") return json(response, 200, await runtime.listChats());
      if (request.method === "POST" && url.pathname === "/api/import") {
        assertSameOriginJson(request);
        return json(response, 200, await runtime.importMessages(await body(request)));
      }
      if (request.method === "POST" && url.pathname === "/api/analyze") {
        assertSameOriginJson(request);
        return json(response, 200, await runtime.analyzeImportedMessages());
      }
      if (request.method === "POST" && url.pathname === "/api/judgments") {
        assertSameOriginJson(request);
        return json(response, 200, await runtime.saveJudgment(await body(request)));
      }
      if (request.method === "POST" && url.pathname === "/api/public-workbench/conflicts") {
        assertSameOriginJson(request);
        return json(response, 200, await runtime.confirmPublicConflict(await body(request)));
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      json(response, 400, { error: error?.code || "request_failed", message: String(error?.message || "操作失败").slice(0, 160) });
    }
  });
}
