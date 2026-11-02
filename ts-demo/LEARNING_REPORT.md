# 从当前 TS 代码学习 LangGraph、Langfuse 和本地 Ollama

> 代码阅读报告 · 2026-11-02 · 仅分析 `ts-demo` 当前执行路径
>
> 适合手机分段阅读，约 20 分钟。代码片段为原实现的节选或标明的简化片段，完整实现以源码为准。

## 1. 先理解这个项目在做什么

这个项目执行一个小型反馈工作流：**计算运费 → 检查结果 → 失败时请求新费率 → 再计算**。

它把三个组件组合在一起：

| 组件 | 在当前代码中的职责 |
| --- | --- |
| LangGraph | 保存共享状态，执行节点，决定继续还是结束 |
| Ollama / Qwen | 根据失败信息生成下一轮费率建议 |
| Langfuse | 记录工作流、节点、模型输入输出和错误，便于排查问题 |

**修改费率的是应用代码。** Langfuse 负责观察执行过程，不会自动训练模型或调整参数。

当前主程序直接通过 TypeScript 的 `fetch` 请求 Ollama，不需要启动 Python。
本地目录中即使出现旧的 `trace-client.ts`，它也没有被当前入口、工作流或模型客户端导入，不属于当前运行链路。
本报告不分析该遗留文件，也不分析父目录的 Python 示例。

## 2. 从一个具体例子开始

代码使用的运费公式是：

```text
quote = rate × weight + 5
```

- `rate`：每公斤费用，可以调整。
- `weight`：重量，单位 kg。
- `quote`：计算出的总运费。
- `5`：固定费用，写在代码中。

默认输入为 `weight=2`、`expected=11`、`initialRate=1`。

第一轮得到 `1 × 2 + 5 = 7`，与标准答案 11 不符。
程序生成失败反馈，请求一个新费率。理想建议为 3，下一轮得到 `3 × 2 + 5 = 11`，评估通过后退出。

默认教学模式按已写好的数学规则计算建议，因此稳定得到上述过程。
真实 Ollama 模式由 Qwen 生成建议，可能失败或需要多轮，不能保证每次结果一致。

## 3. 文件怎样分工

```text
package.json
  └─ src/main.ts             CLI 入口与结果保存
       ├─ src/telemetry.ts   Langfuse 初始化与退出刷新
       └─ src/demo.ts        LangGraph 状态与反馈循环
            └─ src/ollama-client.ts
                            HTTP 模型调用与响应校验

src/demo.test.ts             自动化测试
.env.example                Langfuse 配置模板
```

建议先读 `demo.ts`，理解业务，再读 `ollama-client.ts` 和 `telemetry.ts`。
`main.ts` 最后看，会更容易理解命令行输入怎样接入流程。

## 4. 四个 npm 命令的区别

以下命令都在 `ts-demo` 目录运行：

| 命令 | 实际执行 | 含义 |
| --- | --- | --- |
| `npm run demo` | `tsx src/main.ts` | 使用教学规则生成建议，不调用 Ollama |
| `npm run demo:ollama` | `tsx src/main.ts --ollama` | 调用本地 Qwen 生成建议 |
| `npm run check` | `tsc --noEmit` | 检查类型，不运行业务、不输出 JS |
| `npm test` | `tsx --test src/demo.test.ts` | 执行自动化测试 |

`tsx` 直接运行 TS；`tsc` 是 TypeScript 编译器。
两个 demo 命令是否向 Langfuse 上传数据，取决于项目凭据是否配置，与是否启用 Ollama 相互独立。

## 5. CLI：输入怎样进入工作流

`main.ts` 使用 `parseArgs` 读取参数：

```ts
const { values } = parseArgs({
  options: {
    ollama: { type: "boolean", default: false },
    model: { type: "string", default: "qwen3.5:9b" },
    weight: { type: "string", default: "2" },
    expected: { type: "string", default: "11" },
    // 其余字段见源码
  },
});
```

命令行中的重量、报价和次数先作为字符串读取，再用 `Number(...)` 转成数字传入 `runDemo`。
真正的数值检查在 `runDemo` 内执行，所以输入错误不会只靠 TS 静态类型拦截。

例如：

```powershell
npm run demo -- --weight 2 --expected 11 --initial-rate 1 --max-attempts 3
```

第一个 `--` 表示后面的参数交给脚本，而不是 npm 自己处理。

## 6. State：节点之间共享什么

`demo.ts` 的状态定义如下：

```ts
const State = Annotation.Root({
  weight: Annotation<number>,
  expected: Annotation<number>,
  rate: Annotation<number>,
  attempt: Annotation<number>,
  quote: Annotation<number>,
  passed: Annotation<boolean>,
  feedback: Annotation<string>,
  history: Annotation<HistoryRow[]>,
  optimizerLog: Annotation<OptimizationLog[]>,
});
```

这些字段都是普通数值、文本或数组：

- `weight / expected` 是任务输入。
- `rate` 是当前策略参数。
- `attempt / quote / passed / feedback` 描述最新一轮。
- `history` 保存每次评估的结果。
- `optimizerLog` 保存参数建议或失败原因。

`State` 描述数据结构，节点里的 `state` 是运行到该节点时的状态值。
当前节点返回一个局部更新对象，没有返回的字段继续保留。
代码没有为数组配置追加 reducer，因此使用 `[...state.history, row]` 显式构造更新后的完整数组。

初始状态在调用时提供：

```ts
await graph.invoke({
  weight, expected,
  rate: initialRate,
  attempt: 0,
  history: [],
  optimizerLog: [],
}, {
  recursionLimit: maxAttempts * 3 + 5,
});
```

`quote / passed / feedback` 在后续节点读取前，由前面的节点先写入。
`recursionLimit` 是 LangGraph 执行步数保护，不等于业务层的报价次数上限。

## 7. act：执行确定性行动

```ts
.addNode("act", (state) =>
  startActiveObservation("act", (span) => {
    const quote = state.rate * state.weight + 5;
    span.update({
      input: { rate: state.rate, weight: state.weight },
      output: { quote },
    });
    return { quote, attempt: state.attempt + 1 };
  })
)
```

这一节点同时做两件事：计算报价，记录观测。

`return` 更新 LangGraph 状态；`span.update` 更新 Langfuse 观察。
它们面对的是两套不同的数据：前者驱动后续执行，后者帮助人查看发生了什么。
仅调用 `span.update` 不会改变工作流的 `rate` 或 `quote`。

## 8. evaluate：谁判断结果是否正确

核心逻辑是：

```ts
const passed = state.quote === state.expected;
const row = {
  attempt: state.attempt,
  rate: state.rate,
  quote: state.quote,
  passed,
};

return {
  passed,
  history: [...state.history, row],
  feedback: passed ? "Correct" : /* 失败说明 */,
};
```

失败说明包含重量、标准答案、实际报价和公式，要求只修改费率。
本例的正确性来自与标准答案比较，不是由模型自行声称“我已经成功”。

`passed` 当前保存在节点输出和根观察输出中。代码没有单独创建 Langfuse Score 实体，不能把这些输出字段当成已经接入了独立评分 API。

## 9. optimize：建议来自哪里，参数怎样改变

代码中的建议来源优先级为：

```ts
const suggestion = options.suggest
  ? await options.suggest(input)
  : options.ollama
    ? await client.suggest(input)
    : {
        rate: Math.floor((input.expected - 5) / input.weight),
        reasoning: "教学规则：求解整数费率。",
      };
```

先使用调用方注入的 `suggest`，再判断是否调用 Ollama，否则用教学规则。
这个可注入接口使测试可以控制响应，不必每次等待真实 Qwen。

校验后，参数更新发生在：

```ts
return {
  rate: suggestion.rate,
  optimizerLog: [
    ...state.optimizerLog,
    { input, suggestion },
  ],
};
```

这是显式状态更新，不存在隐藏的自动反向传播。
改变的是本次运行的应用费率，Qwen 的模型权重没有变化。

教学规则使用 `Math.floor`，所以不代表所有输入都能得到正确答案。
例如 2kg 目标报价为 12 时，没有满足公式的整数费率；无限重试也解决不了约束本身无解的问题。

## 10. 异常怎样处理

`optimize` 会捕获请求或建议校验错误：

```ts
catch (error) {
  const message = error instanceof Error
    ? error.message
    : String(error);

  span.update({
    level: "ERROR",
    statusMessage: message,
    output: { retainedRate: state.rate },
  });

  return {
    optimizerLog: [
      ...state.optimizerLog,
      { input, suggestion: null, error: message },
    ],
  };
}
```

这里没有返回新 `rate`，所以工作流保留旧费率。
之后再执行一次报价和检查，直到成功或次数耗尽。
当前没有重试退避，也没有把网络错误与业务无解分成不同路由；这些可以作为后续扩展。

## 11. 条件边怎样控制循环

```ts
.addEdge(START, "act")
.addEdge("act", "evaluate")
.addConditionalEdges(
  "evaluate",
  (state) =>
    state.passed || state.attempt >= maxAttempts
      ? "end"
      : "optimize",
  { end: END, optimize: "optimize" },
)
.addEdge("optimize", "act")
.compile();
```

```text
START → act → evaluate
                ├─ 成功或达到上限 → END
                └─ 失败 → optimize → act
```

`maxAttempts=3` 表示最多报价 3 次，最多生成 2 次新参数建议。
最后一次评估失败后直接结束，不会再生成一个没有机会验证的新费率。

## 12. OllamaClient：一次真实模型请求

模型客户端是 TS 原生 HTTP 实现：

```ts
const response = await fetch(
  `${this.baseUrl.replace(/\/$/, "")}/api/chat`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model: this.model,
      messages,
      stream: false,
      think: false,
      format: /* 要求 rate 与 reasoning 的 JSON Schema */,
      options: { temperature: 0, num_predict: 1024 },
    }),
  },
);
```

- `messages` 包含系统要求与当前失败信息。
- `stream: false` 表示等待完整响应后解析。
- `think: false` 请求不输出 thinking。
- `temperature: 0` 降低采样随机性，但不等于保证正确。
- `num_predict: 1024` 限制生成长度。
- 超时为 180 秒。

请求要求模型返回这样的建议结构：

```json
{"rate":3,"reasoning":"由目标报价和重量求出费率"}
```

模型响应要解析两层：先解析 Ollama HTTP 外层 JSON，再对 `message.content` 执行 `JSON.parse`。
代码随后检查 `rate` 是非负安全整数，`reasoning` 是字符串。
TS 的 `as` 类型断言不会验证远程 JSON，因此运行时校验不可省略。

请求中的 Schema 要求没有额外字段；本地手写校验主要检查必要字段与类型，没有逐一拒绝所有额外字段。

## 13. Langfuse：怎样记录模型调用

```ts
return startActiveObservation(
  "ollama.suggest-rate",
  async (generation) => {
    generation.update({
      model: this.model,
      input: messages,
      modelParameters: { temperature: 0 },
    });

    // 请求 Ollama，解析并校验建议

    generation.update({
      output: suggestion,
      usageDetails: {
        // 外层响应字段存在时记录 input / output token 数
      },
    });
    return { rate: suggestion.rate, reasoning: suggestion.reasoning };
  },
  { asType: "generation" },
);
```

一次运行的观察树为：

```text
shipping-agent
  ├─ act
  ├─ evaluate
  ├─ optimize
  │    └─ ollama.suggest-rate  [generation]
  ├─ act
  └─ evaluate
```

根观察 `shipping-agent` 包住整个 `graph.invoke`；每个节点创建子观察。
模型生成在 `optimize` 的活动上下文中创建，因此成为该节点的子级。

Langfuse 保存业务数据与模型调用信息；OpenTelemetry 提供上下文和导出基础设施。
教学规则模式不调用模型，所以没有 generation 节点。
generation 仅在校验成功后写入成功输出与 token 用量，不能假设失败请求也总有这些字段。

## 14. telemetry.ts：初始化、配置与退出

关键初始化代码：

```ts
const sdk = new NodeTracerProvider({
  spanProcessors: [new LangfuseSpanProcessor()],
});
sdk.register();
return { enabled: true, shutdown: () => sdk.shutdown() };
```

它注册观测上下文，并安装向 Langfuse 导出数据的 processor。
当前 `main.ts` 在执行 `runDemo` 前初始化，结束时刷新：

```ts
const telemetry = initializeTelemetry();
try {
  // 运行工作流并保存结果
} finally {
  await telemetry.shutdown();
}
```

CLI 很快退出，尚在缓冲区的记录可能还没发出，所以需要等待 `shutdown()`。
直接从其他文件调用 `runDemo` 时，也需要由调用方初始化观测设施，才能实际收集、导出观察。

`telemetry.ts` 从自身相对路径加载 `ts-demo/.env`，已有环境变量优先。

```dotenv
LANGFUSE_PUBLIC_KEY=自己的项目公钥
LANGFUSE_SECRET_KEY=自己的项目密钥
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

两项 key 都没有时，不安装导出器，仍可以运行业务。
只有一项时直接报错。地址应使用项目实际区域或自部署地址。
“已启用”表示导出器配置完成，最终是否到达云端仍应查看对应项目。
启用后，提示词、反馈和输出会发送到该实例；`.env` 已列入 Git 忽略规则。

## 15. 本地记录与新样例检查

入口使用 `Promise.all` 写入三个互相独立的输出文件：

| 文件 | 当前内容 |
| --- | --- |
| `artifacts/run.json` | 模式、模型名、历史、成功状态、最终费率和新样例结果 |
| `artifacts/optimizer.json` | 应用提供给建议函数的输入、建议或错误 |
| `artifacts/graph.mmd` | LangGraph 控制流图的 Mermaid 文本 |

文件位置相对于 `main.ts` 固定，不依赖调用命令时的工作目录。每次运行会覆盖。
本地 `optimizer.json` 没有包含完整系统提示词；完整模型 messages 在启用的 generation 观察中记录。

新样例固定为 4kg，期望固定为 17：

```ts
const holdout = {
  weight: 4,
  quote: final.rate * 4 + 5,
  expected: 17,
  passed: final.rate * 4 + 5 === 17,
};
```

这个期望对应费率 3。如果通过 CLI 改成另一套合法费率任务，4kg 的标准答案仍然是 17，不会自动随之调整。
因此它只是默认教学任务的检查，不能当成通用验证集。

另外，达到重试上限仅输出“尚未成功”，当前并没有因此设置非零进程退出码。
只有异常传播到入口的 `catch` 时，才设置 `process.exitCode = 1`。

## 16. 五个测试实际验证了什么

1. 默认任务从 7 修正到 11，且行动节点与根观察拥有一致 traceId、正确父 span。
2. 达到上限时不再优化，初始费率正确时直接结束。
3. 注入无效建议后保留旧费率，有限重试；非法次数被拒绝。
4. 用模拟 fetch 响应验证真实客户端的解析路径，以及 generation 与 optimize 的父子关系和部分属性。
5. 启动独立 CLI，将真实 Langfuse SDK 的 HTTP 导出发送到本地测试接收器，验证退出前发生导出请求。

第 4 项没有请求真实 Qwen，第 5 项没有连接真实 Langfuse 云端。
它们验证程序结构和协议流程，不等于证明真实服务的可用性。
token 属性测试只做了较宽松的内容检查，尚未逐字段精确断言所有计量属性。

## 17. 从这个项目理解 AI Agent

本例具备状态、行动、反馈、参数调整和停止条件，适合学习闭环。
但它的节点和工具由程序预先定义，模型只在失败后提供一个费率建议。

当前没有实现：

- 模型自主选择多个工具与动态规划。
- 跨运行保存费率和经验记忆。
- 可恢复的 checkpoint。
- Qwen 权重训练。
- 多任务训练集与独立验证集。

历史记录便于回看，Langfuse 便于观测；两者都不会自动变成长期记忆或学习机制。

## 18. 建议做的四个练习

### 练习一：验证无需优化

```powershell
npm run demo -- --initial-rate 3
```

预期第一轮通过，没有 optimize 和 generation。

### 练习二：只允许一次尝试

```powershell
npm run demo -- --max-attempts 1
```

预期报价为 7，失败后立即结束。解释为什么没有生成建议。

### 练习三：观察无解约束

```powershell
npm run demo -- --expected 12
```

因为 `2 × 整数费率 + 5` 不可能等于 12，程序达到上限。
观察反复执行同样行动有什么价值，思考何时应提前判断任务无解。

### 练习四：观察真实模型

```powershell
npm run demo:ollama
```

对照控制台、`optimizer.json` 与 Langfuse 中的节点树。
重点看失败输入、新建议、下一轮参数是否真的改变，以及 generation 是否挂在 optimize 下。

## 19. 下一步可以怎样扩展

先把固定 4kg 检查改成可配置的验证集，然后增加错误分类与重试退避。
再考虑接入独立 Langfuse Score、跨运行参数持久化、多个工具及模型选择逻辑。
每一步都应区分：哪些字段控制业务，哪些字段只用于观测。

## 20. 源码导航

- [main.ts：CLI 与文件输出](src/main.ts)
- [demo.ts：状态与反馈工作流](src/demo.ts)
- [ollama-client.ts：模型请求与响应校验](src/ollama-client.ts)
- [telemetry.ts：Langfuse 初始化](src/telemetry.ts)
- [demo.test.ts：五个自动化测试](src/demo.test.ts)
- [README：安装与配置](README.md)

读完后，试着回答：**谁负责决定下一步、谁负责提出新参数、谁负责判断正确、谁负责记录过程？**
这四个职责分别对应 LangGraph 路由、建议函数、evaluate 节点和 Langfuse。
