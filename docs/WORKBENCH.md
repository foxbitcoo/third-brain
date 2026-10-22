# 新版工作台

需要 Node.js 22.12+、npm 和 Python 3（仅文档/会邀采集时使用）。

```sh
npm install
npm start
```

默认打开 `http://127.0.0.1:4310/`，启动时自动构建 React/Semi UI 工作台。首次没有工作数据，可进入「信息源管理」设置自己的 WPS 应用和模型、完成 OAuth、选择群聊、导入、生成工作候选。配置保存后重启服务。生成才调用安装者的模型，读取页面不产生模型费用。原始消息、授权和生成结果存于本机加密存储，不随 Git 发布。旧版仅供兼容：`npm run start:legacy`。

## 能力与输入

| 页面 | 运行实现 | 数据要求 |
| --- | --- | --- |
| 工作概览 | 当前主线、优先级标签、最多10条重点展示 | 导入后生成候选，或本人工作资料包 |
| 业务问答 | 原始依据、富文本、来源引用及实际模型问答 | 已导入候选与自己的模型 |
| 信息源管理 | 授权导入、关注档位、会邀、会议记录、文档版本和原图 | OAuth；扩展采集需对应接口权限 |
| 主动发现 | 可点击 Loop、标准 Query、分流、逐轮返回、核查、报告、历史工单与看板快照 | 本人授权的指标口径、只读查数方案、MCP 和模型 |
| 项目记忆 | 候选审阅、证据链、适用范围、召回及注入审计 | 本人历史工单/报告、确认记录和本地记忆存储 |

公开仓库包含上述通用实现和离线契约测试。未配置的数据源显示未就绪；不复制维护者的工作主线、历史工单、Memory、定时任务、私有文档链接或授权。真实办公接口连通性取决于安装者权限；离线测试不代表其账号已获准。

## 扩展配置

可通过 `THIRD_BRAIN_WORKBENCH_CONFIG` 指向仓库外的本地 JSON 文件。它只接收文件路径，不接收可执行代码。允许字段：

- `dataPath`：business-qa-v1 工作资料；不设置时使用安装者自己的加密工作区。
- `attentionPath`：version:1 的来源关注策略。
- `historyPath`、`readingGuidePath`、`sourceMapPath`、`displayTitlesPath`、`documentPolicyPath`。
- `discoveryPath`：diagnostic-config-v1 配置；`storeDirectory`、`memoryDirectory` 均须在仓库外；sources 中逐项明确 `userAuthorized`、版本、定义和经核验的只读 recipes。
- `historicalTicketsPath`、`historicalTicketScopePath`、`discoveryBoardsPath`、`questionContextsPath`、`historicalMediaPath`、`contextSourcesPath`、`worklinesPath`。

所有路径使用安装者自己的绝对路径，服务在每次访问时重新检查文件边界。字段契约与校验代码在 `apps/business-workbench/`，指标分析规则见 [分析契约](product/DATA-DIAGNOSTIC-CONTRACT.md) 和 [Agent 规范](../skills/data-diagnostic-agent/SKILL.md)。

诊断默认读取明确配置的 `DEEPSEEK_API_KEY`；可选模型使用 `MIMO_API_KEY` 等独立变量。查数连接使用 `DELPER_MCP_URL` 与 `DELPER_MCP_TOKEN`，经该连接支持的 Bearer 授权进入允许的只读工具。未提供或连接不支持这种授权时明确未就绪，不读取维护者凭据文件、不从浏览器借用登录态、不伪造查数成功。会邀/文档采集模块属于独立连接器，需自行核验对应授权；OAuth 消息导入不自动授权这些接口。

复杂诊断最多3轮、3次查数，并受模型调用上限、预算和来源权限约束。每轮保留改写 Query、查数回执、实际返回表格、报告依据、继续/停止原因。缺口未补齐就请求人工补充。报告待审不等于原因已证实。

## 验证与升级

```sh
npm test
npm run test:workbench
npm run test:context
npm run build
npm run check
```

升级不搬运任何人的本地数据。代码一致不表示不同安装者的业务结果相同；数据、权限和配置由各安装者管理。
