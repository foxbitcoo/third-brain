# 工单记忆

把记忆想成一本按方向分隔的经验笔记：保留历史上怎样分析问题的方法，下一次遇到同方向或周期性问题时参考，再重新取得本期资料。

```mermaid
flowchart LR
 A[授权工单：提问、答复、引用原图] --> B[DeepSeek 整理七段经验卡]
 B --> C[来源与格式检查通过后自动生效]
 C --> D[按方向和问题找相关方法]
 D --> E[实际带入分析请求]
 E --> F[重新查本期数据并生成报告]
```

七段固定为：原文、问题模式、下次如何回答、交付清单、适用条件、不能直接套用、仍需当前资料。原文默认折叠，方向包括成本核算与优化、指标监控与汇报、异常排查与口径，以及其他分析经验。方向辅助筛选，不授权访问新的数据源。

成功提取且校验通过后自动成为可用方法，不需要人工逐条确认。格式不完整、引用不存在、来源撤销或调用状态不明时，不生成可用记忆。更新会保留旧版本；旧数值与当时事实不作为本期答案。Mem0 尚未接入实际业务，当前运行的是仓库内的本地模块，无需额外向量数据库。

## 配置自己的数据

在 `THIRD_BRAIN_WORKBENCH_CONFIG` 指定的仓库外文件中配置以下路径；所有路径都指向安装者自己的绝对路径，不能复制维护者数据。

| 字段 | 用途 |
| --- | --- |
| historicalTicketsPath / historicalTicketScopePath | 工单与独立授权的历史范围；日期和原生会话标识必须对应 |
| attentionPath / questionContextsPath | 当前来源权限与消息引用关系 |
| memoryPlaybooksPath | schemaVersion 为 memory-playbooks-v1 的存储；初始 records、cases 为空，builds 为空对象 |
| memoryBuilderPath | DeepSeek 提取设置，见下文 |
| memoryReusePath | 可用方法允许被哪些查数来源使用 |
| memoryPeriodicTestPath / memoryEvaluationPath | 可选的已完成试验回执；不配置则不显示对照入口 |

提取设置版本为 `deepseek-ticket-memory/v1`，模型为 `deepseek-flash`，endpoint 为 `https://api.deepseek.com/chat/completions`。需提供 `ticketsPath`、`scopePath`、`attentionPath`、`messagesPath`、`originalsPath`、`mediaPath`、`seedPath`、`budgetDirectory`、`workDirectory` 和 `outputPath`。提取设置中的工单、授权、会话、输出路径须与工作台扩展配置一致。`outputPath` 必须位于仓库外的 `workDirectory` 内；原图必须已下载到本机并有来源绑定及哈希。数据契约可参考 `ticket-memory-builder.test.mjs` 的完全虚构样本。

使用范围文件支持 `playbook-reuse-v2`：`enabledAt` 为启用时间，`autoActivate` 为 true，`sourceIds` 为允许参考这些方法的诊断来源 ID，`records` 为可选逐条配置，`disabledIds` 为停用项。自动生效不扩展查数来源或查询权限。原有 v1 逐条配置仍兼容。

提取凭据读取安装者的 `DEEPSEEK_API_KEY`（环境变量或安装目录的 .env.local），不会读取维护者凭据文件。只有点击工单的「提取／更新 Memory」才触发该入口的模型请求，刷新页面不调用模型。提取与诊断可指向同一预算目录，共享每日上限；提取默认每日 10 元，图片理解阶段共享每日 2 元子上限。预算不足保留待处理。

每次最多输入两张有明确引用关系的原图；临近但未确认的图片不参与提取。页面显示本轮读取和缺口。图片本地路径不直接暴露为前端地址。

## 怎么判断有没有用

记忆页面显示具体方法和对应工单；工单的「记忆」页分开显示本单产出、相关记忆，以及实际请求带入的正文。匹配不等于注入，只有保存了带入内容并收到提供商响应才显示已使用。

周期方法对照可使用较早工单的记忆回答较晚问题，留出较晚工单的后续答复，保持模型、原问题和当前证据相同。无工具的方法迁移试验只比较分析思路，不能证明已完成查数或提高完整 Loop 成功率；完整 Loop 对照还需真实的只读查数连接及结果。
