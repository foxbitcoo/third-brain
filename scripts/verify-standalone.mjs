#!/usr/bin/env node
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { createIsolatedEnvironment, isPublicCopyEntry } from "./standalone-policy.mjs";

const source = path.resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "third-brain-public-standalone-"));
const target = path.join(temporaryRoot, "public-release");
const temporaryHome = path.join(temporaryRoot, "home");
await mkdir(temporaryHome, { recursive: true });
await writeFile(path.join(temporaryHome, ".npmrc"), "audit=false\nfund=false\n", "utf8");
const cleanEnvironment = createIsolatedEnvironment(temporaryHome);

function run(command, args, expectedStatuses = [0]) {
  const result = spawnSync(command, args, {
    cwd: target,
    env: cleanEnvironment,
    encoding: "utf8",
  });
  if (!expectedStatuses.includes(result.status)) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

try {
  await cp(source, target, { recursive: true, filter: isPublicCopyEntry });
  const install = run("npm", ["install", "--no-audit", "--no-fund"]);
  if (!install.stdout.includes("第三大脑 · 安装预检")
    || !install.stdout.includes("WPS 应用配置：待配置")
    || !install.stdout.includes("大模型配置：待配置")) {
    throw new Error("npm install did not immediately show the configuration guide");
  }
  run("npm", ["run", "build"]);
  run(process.execPath, ["--test", "test/*.test.mjs"]);
  run("npm", ["run", "test:workbench"]);
  run("npm", ["run", "test:context"]);
  run(process.execPath, ["scripts/check-release.mjs"]);
  run(process.execPath, ["scripts/setup-local.mjs"]);
  if (((await stat(path.join(target, ".env.local"))).mode & 0o777) !== 0o600) {
    throw new Error("setup did not protect .env.local with mode 600");
  }
  const preflight = run(process.execPath, ["scripts/preflight.mjs"], [2]);
  if (!preflight.stdout.includes("WPS 应用配置：待配置") || !preflight.stdout.includes("大模型配置：待配置")) {
    throw new Error("clean preflight did not report both external configurations as missing");
  }
  const {createInstalledOptions} = await import(path.join(target,'src','installed-workbench.mjs'));
  const {createWorkbenchServer} = await import(path.join(target,'apps','business-workbench','server.mjs'));
  const modern=createWorkbenchServer(await createInstalledOptions({root:target,env:cleanEnvironment}));
  await new Promise(resolve=>modern.listen(0,'127.0.0.1',resolve));
  try {
    const address=`http://127.0.0.1:${modern.address().port}`;
    const html=await(await fetch(address)).text();
    if(!html.includes('工作助理')||html.includes('本地工作台'))throw Error('Default entry is not the modern workbench');
    const asset=html.match(/src="([^"]+\.js)"/)[1];
    const client=await(await fetch(address+asset)).text();
    for(const label of ['工作概览','业务问答','信息源管理','主动发现','项目记忆'])if(!client.includes(label))throw Error('Missing modern route');
    const dataset=await(await fetch(address+'/api/dataset')).json();
    if(dataset.dataset.cases.length)throw Error('Clean install must not contain business data');
    for(const route of ['/api/attention','/api/discovery','/api/discovery-memory','/api/installation'])if(!(await fetch(address+route)).ok)throw Error('Modern API unavailable');
  } finally { await new Promise(resolve=>modern.close(resolve)); }
  const { createLocalSetupServer } = await import(path.join(target, "src", "setup-server.mjs"));
  const setupServer = createLocalSetupServer({
    setupFile: path.join(target, "public", "setup.html"),
    envFile: path.join(target, ".env.local"),
    port: 4310,
  });
  await new Promise((resolve) => setupServer.listen(0, "127.0.0.1", resolve));
  try {
    const setupUrl = `http://127.0.0.1:${setupServer.address().port}`;
    const [setupResponse, setupStatusResponse] = await Promise.all([
      fetch(setupUrl),
      fetch(`${setupUrl}/api/setup/status`),
    ]);
    const setupPage = await setupResponse.text();
    const setupStatus = await setupStatusResponse.json();
    if (!setupResponse.ok
      || !setupPage.includes("先准备三样东西")
      || setupStatus.configurationReady !== false
      || setupStatus.requiredFields.length !== 6) {
      throw new Error("first-run setup guide readback failed");
    }
  } finally {
    await new Promise((resolve) => setupServer.close(resolve));
  }
  const { createDemoServer } = await import(path.join(target, "scripts", "serve-demo.mjs"));
  const { server, url } = await createDemoServer({ root: path.join(target, "demo"), port: 0 });
  try {
    const response = await fetch(url);
    const html = await response.text();
    if (response.status !== 200 || !html.includes("第三大脑 · 公开预览") || !html.includes("不连接真实数据")) {
      throw new Error("standalone demo readback failed");
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const { createLocalHttpServer } = await import(path.join(target, "src", "http-server.mjs"));
  const localServer = createLocalHttpServer({
    indexFile: path.join(target, "public", "index.html"),
    runtime: {
      async status() { return { configured: true, wpsAuthorized: false, importedMessages: 0, importComplete: false }; },
      async readWorkspace() { return { messageCount: 0, analysis: null }; },
    },
  });
  await new Promise((resolve) => localServer.listen(0, "127.0.0.1", resolve));
  try {
    const localUrl = `http://127.0.0.1:${localServer.address().port}`;
    const [pageResponse, statusResponse] = await Promise.all([
      fetch(localUrl),
      fetch(`${localUrl}/api/status`),
    ]);
    const page = await pageResponse.text();
    const statusPayload = await statusResponse.json();
    if (!pageResponse.ok || !page.includes("第三大脑 · 本地试用") || statusPayload.configured !== true) {
      throw new Error("standalone local runtime readback failed");
    }
  } finally {
    await new Promise((resolve) => localServer.close(resolve));
  }
  process.stdout.write("独立运行验证通过：干净 HOME 下安装、构建、新版五页入口与 API、首次设置、全部测试和公开扫描通过；真实 WPS 与模型调用保持 NOT_RUN。\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
