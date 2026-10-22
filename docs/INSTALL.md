# 安装引导

## 1. 本机准备

- Node.js 22.12 或更高；
- WPS 企业自建应用；
- OpenAI-compatible 模型 API：服务商、完整 API 地址、模型名称／Endpoint ID 和 API Key。

```bash
npm install
npm start
```

首次启动会在终端显示 `http://127.0.0.1:4310`。用浏览器打开该地址后进入新版五页工作台。在「信息源管理」点击「开始设置」，依次填写自己的 WPS 应用、权限、回调地址和模型配置。配置会通过本地页面写入权限为 600 的 `.env.local`；页面不会再把密钥读出来。

保存后，在终端按 Control + C 停止服务，再次运行 `npm start`，在「信息源管理」中完成 WPS 授权与群聊选择。每次启动会自动构建新版前端。

如果希望手动配置，也可以运行 `npm run setup`。该命令只在本机创建权限为 600 的 `.env.local`，不会覆盖已有配置。

## 2. 填写自己的配置

```text
WPS_APP_ID=
WPS_APP_KEY=
WPS_REDIRECT_URI=http://127.0.0.1:4310/oauth/wps/callback
WPS_SCOPES=kso.user_base.read kso.mcp_message.readwrite
LLM_PROVIDER=
LLM_BASE_URL=
LLM_MODEL=
LLM_API_KEY=
LOCAL_PORT=4310
```

不要提交、截图或发送 `.env.local`。本项目不支持浏览器 `WPS_SID`。

## 3. WPS 后台

在应用安全配置中把用户授权回调地址设置为：

```text
http://127.0.0.1:4310/oauth/wps/callback
```

分别搜索 `kso.user_base.read` 和 `kso.mcp_message.readwrite`，两项都选择 `user`，不要选择 `app`，也不要输入 `delegated:`。申请并发布后，当前用户重新授权。详见 [WPS 权限](WPS-PERMISSIONS.md)。

## 4. 预检与启动

```bash
npm run preflight
npm start
```

预检只检查字段和范围，不会联网证明审批、OAuth 或模型连接已经成功。启动后打开 `http://127.0.0.1:4310` 完成真实验证。

如果只想先看无数据页面：

```bash
npm run demo
```

## 5. 已安装旧版时升级

```sh
git pull --ff-only
npm install
npm start
```

默认入口现在是工作概览、业务问答、信息源管理、主动发现、项目记忆。已有私人数据继续保留在本机，不提交到 Git。主动发现、看板原图、历史工单与 Memory 的额外来源配置见 [新版工作台](WORKBENCH.md)。
