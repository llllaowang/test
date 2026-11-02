# TypeScript LangGraph + Langfuse + Ollama

📱 [当前 TS 代码学习报告：核心代码与逐步讲解](LEARNING_REPORT.md)

本版本已从 Microsoft Trace 迁移到 **Langfuse 官方 TS SDK**。它是纯 TS 应用，不需要 Python、Trace Node、句柄或子进程。
父目录 Python demo 仍使用 Microsoft Trace，两个版本现在演示不同的集成方式。

## 运行

要求 Node.js 22+；真实模型模式要求本地 Ollama 已安装 `qwen3.5:9b`。

```powershell
cd ts-demo
npm.cmd ci
npm.cmd run demo
npm.cmd run demo:ollama
```

默认模式采用教学规则更新参数。`demo:ollama` 直接通过 HTTP 请求本地 Qwen，生成费率建议。

## 接入 Langfuse

在 Langfuse Cloud 或自部署实例创建项目，获取项目的 public / secret key。

```powershell
Copy-Item .env.example .env
# 编辑 .env，填写自己的项目凭据和项目所在区域的地址。
npm.cmd run demo:ollama
```

`.env` 内容：

```dotenv
LANGFUSE_PUBLIC_KEY=你的项目公钥
LANGFUSE_SECRET_KEY=你的项目密钥
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

请按项目实际部署区域修改地址；自部署可使用自己的服务地址。
没有配置密钥时不会初始化导出器，业务照常运行并保存本地记录。
只配置其中一个 key 时会报错，避免误以为已成功接入。
启用后，运行中的输入、输出、反馈及模型调用会发送到指定 Langfuse 项目。
启动时显示“已启用”表示导出器已配置，仍需在 Langfuse UI 确认数据到达；网络或凭据错误由 SDK 报告。

## Langfuse 记录什么

```text
shipping-agent（整次工作流）
  ├─ act：费率、重量、报价
  ├─ evaluate：标准答案、实际报价、是否通过
  ├─ optimize：失败信息、新费率或错误
  │    └─ ollama.suggest-rate（generation）
  │         模型、提示词、响应、耗时、输入/输出 token 数
  └─ 下一轮 act / evaluate ...
```

OpenTelemetry 保存父子上下文，`LangfuseSpanProcessor` 导出观察。
CLI 在退出前调用 `shutdown()` 刷新记录。教学规则模式没有真实模型调用，因此不会创建 generation。

**Langfuse 在本例中负责观测，不会代替 OptoPrime 自动反向传播或修改参数。**
参数调整是 `optimize` 节点自己调用 Qwen，然后显式写回 LangGraph 的 `rate` 状态。
Langfuse 中记录的 `passed` 是评估输出，本例没有另外创建独立的 Langfuse Score 实体。

## 核心代码导航

- [demo.ts](src/demo.ts)：状态、行动、评估、参数更新和条件路由；保留中文变量注释。
- [ollama-client.ts](src/ollama-client.ts)：原生 fetch 调用 Qwen，记录 generation，校验模型 JSON。
- [telemetry.ts](src/telemetry.ts)：加载 .env，初始化 Langfuse OpenTelemetry 导出。
- [main.ts](src/main.ts)：CLI 参数、结果保存和退出刷新。
- [demo.test.ts](src/demo.test.ts)：业务和内存观测验证，不访问 Langfuse 云端。

已验证：类型检查、五个测试（含真实 SDK 向本地测试接收器导出）、本地 Qwen 参数修正；依赖审计无漏洞。
尚未验证你的 Langfuse 云端项目接收，因为当前未配置项目凭据。
OpenTelemetry 的兼容版本及 overrides 已固定在 package.json / package-lock.json，安装请使用 `npm ci`。

运费任务：`quote = rate × weight + 5`。初始 rate=1，2kg 报价为 7，目标为 11。
默认教学模式会将 rate 更新为 3；随后用 4kg 检查报价是否为 17。
模型建议无效或请求失败时记录 ERROR，保留旧费率继续有限次数重试。
这不是训练 Qwen 权重，也尚未实现跨运行保存策略或长期记忆。

```powershell
npm.cmd run demo -- --ollama --model qwen3.5:9b --weight 2 --expected 11 --initial-rate 1 --max-attempts 3
npm.cmd run check
npm.cmd test
```

本地结果保存在 `artifacts/run.json`、`optimizer.json`、`graph.mmd`，每次运行会覆盖。
`optimizer.json` 现在保存应用层建议记录，不再是 OptoPrime 的执行图提示。

## 官方资料

- [Langfuse TS SDK 与 OpenTelemetry 初始化](https://langfuse.com/docs/observability/sdk/overview)
- [Langfuse 观测入门](https://langfuse.com/docs/observability/get-started)
- [Ollama Chat API](https://docs.ollama.com/api/chat)
