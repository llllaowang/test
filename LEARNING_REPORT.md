# LangGraph + Trace 学习报告

> 面向 AI Agent 入门 · Python / TypeScript 对照 · 2026-11-02
>
> 阅读约 15 分钟。手机上先看第 1～4 节，再按兴趣读代码。

## 1. 这个项目让我学什么

这个 demo 把 Agent 的反馈闭环缩小成一个可以看懂的任务：**先报价，检查是否正确，失败后调整参数，再报价。**

三个组件各有分工：

- **LangGraph**：安排执行顺序，保存任务状态，决定重试还是结束。
- **Microsoft Trace**：记录计算依赖，把输出上的反馈传播到可修改参数，并通过 OptoPrime 请求更新建议。
- **Ollama + Qwen**：在真实模型模式中阅读计算过程和反馈，给出新的参数值。

这里的 Trace 是微软的生成式优化框架，Python 包名为 `trace-opt`，导入路径是 `opto`。
本项目没有把日志记录或 LangSmith 当成这个 Trace。

一个需要记住的边界：这是**最小反馈工作流**。报价行动和路由由程序预先定义，Qwen 负责优化参数；它还没有根据用户意图自主选择多个工具。

## 2. 用一笔运费走完闭环

规则：

```text
报价 = 每公斤费用 rate × 重量 weight + 固定费用 5
```

初始 `rate=1`。环境给出一个带标准答案的样例：2kg 应报价 11。

第一次计算：

```text
1 × 2 + 5 = 7
```

评估器比较 `7 != 11`，生成反馈：重量为 2，期望报价为 11，当前报价为 7，只允许修改整数费率。

Trace 将这条反馈关联到原始输出，OptoPrime 整理执行依赖和可训练参数，再请求 Qwen 提出修改建议。
理想建议是 `rate=3`，下一次计算得到：

```text
3 × 2 + 5 = 11
```

程序再次检查答案，确认通过后退出。模型说“正确”并不能替代评估器的检查。

最后换一个未参与优化的样例：4kg 应报价 17。
这能初步检查是否更新了通用费率，但一个新样例不足以证明真实业务中的泛化能力。

## 3. 两个图，分别解决什么问题

### LangGraph：控制流图

```text
START
  ↓
act：计算报价
  ↓
evaluate：比较答案
  ├─ 通过或达到上限 → END
  └─ 失败 → optimize → 回到 act
```

它回答：“现在运行哪个节点？下一步往哪里走？”

### Trace：计算依赖图

```text
rate（可训练）
  ↓ 乘以 weight
中间结果
  ↓ 加上 5
quote
  ↑ 在这里接收评估反馈
```

它回答：“输出是怎么产生的？哪些上游参数可以修改？”

**LangGraph 的控制流图不会自动变成 Trace 的计算图。**
本项目在 LangGraph 节点之间保留 Trace 对象或它的句柄，从而接通两个图。

## 4. 运行结果告诉我们什么

默认假模型模式的结果为：

```text
第 1 轮：rate=1，报价=7，失败
第 2 轮：rate=3，报价=11，通过
新样例：4kg 报价=17，通过
```

假模型是按已写好的规则解方程，用来稳定展示接口；它没有自主推理能力。
不过，LangGraph 和 Trace 都是真实库，反馈传播与参数更新也真实执行。

本机使用 `qwen3.5:9b` 实测，Python 和 TS 编排版本都出现了：

```text
第 1 轮：rate=1，报价=7，失败
第 2 轮：rate=1，报价=7，失败
第 3 轮：rate=3，报价=11，通过
新样例：4kg 报价=17，通过
```

第一次模型响应中的建议字段格式有误，参数没有更新；后续返回合法建议才成功。
这说明：**自然语言解释合理，不等于结构化输出一定可以执行。**

实测检查：Python 的 3 个测试通过，TS 类型检查及 4 个测试通过。
这些验证覆盖正常更新、首次成功退出、尝试上限等行为；真实模型的每次结果仍可能不同。

## 5. Python 核心代码

以下是从项目抽取、缩短的核心片段，用来解释逻辑。完整可运行代码见 [demo.py](demo.py)。

### 5.1 声明任务状态

```python
class State(TypedDict, total=False):
    weight: int
    expected: int
    attempt: int
    quote: Any      # Trace Node
    passed: bool
    feedback: str
    history: list[dict]
```

State 是节点之间共享的数据。它保存本次任务的输入、尝试次数、输出和反馈。

`rate` 则是可优化策略参数，放在 `build_graph()` 的闭包里，供多个节点调用共享。
本项目每次重新启动程序都会把它初始化为 1，没有实现跨运行保存策略。

### 5.2 建立 Trace 依赖

```python
from opto.trace import node
from opto.optimizers import OptoPrime

rate = node(1, trainable=True)
optimizer = OptoPrime([rate], llm=model)

def act(state: State):
    quote = rate * state["weight"] + 5
    return {
        "quote": quote,
        "attempt": state.get("attempt", 0) + 1,
    }
```

`trainable=True` 表示允许优化器修改这个参数。
乘法与加法发生在 Trace Node 上，所以输出保留对 rate 的依赖。
这里没有重新训练 Qwen 的模型权重，改变的是应用层费率参数。

### 5.3 评估和反馈

```python
actual = state["quote"].data
passed = actual == state["expected"]
feedback = (
    f"weight={state['weight']}; "
    f"expected={state['expected']}; actual={actual}. "
    "Formula: quote = rate * weight + 5. "
    "Change only rate, an integer."
)
```

用 `.data` 读取普通数值，方便展示与比较。
评估器提供可靠的标准答案，相当于一个简单的环境反馈来源。
真实 Agent 往往需要测试执行结果、检索证据或人工反馈，未必能直接拿到答案。

### 5.4 传播反馈并更新

```python
def optimize(state: State):
    optimizer.zero_feedback()
    optimizer.backward(
        state["quote"], state["feedback"]
    )
    optimizer.step()
    return {}
```

三步分别是：清理旧反馈、沿依赖图传播反馈、请求模型建议并尝试更新参数。
这里的 backward 处理的是执行依赖和一般反馈，并非本例在对费率计算数值梯度。

**传给 backward 的必须是原始 quote Node。**
只保留 `.data` 后再创建新 Node，会丢失原来与 rate 相连的计算链。

### 5.5 把节点连起来

```python
graph = StateGraph(State)
graph.add_node("act", act)
graph.add_node("evaluate", evaluate)
graph.add_node("optimize", optimize)

graph.add_edge(START, "act")
graph.add_edge("act", "evaluate")
graph.add_conditional_edges(
    "evaluate", route,
    {"end": END, "optimize": "optimize"},
)
graph.add_edge("optimize", "act")
app = graph.compile()
```

`route` 在评估通过或次数达到上限时返回 `end`，否则返回 `optimize`。
重试预算是流程的一部分；不能指望模型总能修正错误。

## 6. TypeScript 核心代码

完整流程见 [ts-demo/src/demo.ts](ts-demo/src/demo.ts)。

### 6.1 TS 状态与节点

```typescript
const State = Annotation.Root({
  weight: Annotation<number>,
  expected: Annotation<number>,
  attempt: Annotation<number>,
  quote: Annotation<Quote>,
  passed: Annotation<boolean>,
  feedback: Annotation<string>,
  history: Annotation<HistoryRow[]>,
});
```

`Quote` 是普通 JSON 数据：

```typescript
interface Quote {
  handle: string;
  value: number;
  rate: number;
}
```

TS 没有接收 Python Trace 对象，而是保存句柄和用于评估的数值。

### 6.2 执行与优化

```typescript
const graph = new StateGraph(State)
  .addNode("act", async (state) => ({
    quote: await client.act(state.weight),
    attempt: state.attempt + 1,
  }))
  .addNode("evaluate", evaluate)
  .addNode("optimize", async (state) => {
    await client.optimize(
      state.quote.handle, state.feedback
    );
    return {};
  })
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

TS 与 Python 的控制流含义相同；这里的 `await` 等待桥接请求完成后才运行下一步。
当前程序是顺序节点，没有并行写入同一个状态字段。

### 6.3 为什么还要 Python worker

本项目使用的 Microsoft Trace 是官方 Python 库，因此 TS 版本采用子进程桥接，保留真实 Trace 优化能力。

```text
TypeScript LangGraph
  ↓ JSON 请求
Python worker：保留原始 Trace Node
  ↓ 优化器请求
本地 Ollama / qwen3.5:9b
```

通信使用 JSON Lines：每行一个 JSON 对象，通过 id 配对请求和响应。

例如 TS 请求计算：

```json
{"id":2,"method":"act","args":{"weight":2}}
```

worker 返回：

```json
{"id":2,"result":{"handle":"1","value":7,"rate":1}}
```

以下为 worker 中省略协议处理后的关键逻辑：

```python
# act：保存原始 Trace 对象
quote = rate * args["weight"] + 5
outputs[handle] = quote

# optimize：通过句柄找回原始对象
optimizer.zero_feedback()
optimizer.backward(
    outputs[args["handle"]], args["feedback"]
)
optimizer.step()
```

句柄只在这个 worker 的当前运行期间有效。重启进程后，即使 TS 保存过句柄，也找不回之前的 Node。
因此，JSON 状态可序列化不代表整个 Trace 优化会话已经支持 checkpoint 恢复。

## 7. 本地 Qwen 怎样参与

模型适配器向 Ollama 发出聊天请求，核心请求形状为：

```json
{
  "model": "qwen3.5:9b",
  "messages": [
    {"role": "system", "content": "优化器的格式要求"},
    {"role": "user", "content": "计算依赖、参数与反馈"}
  ],
  "stream": false,
  "format": "json",
  "think": false,
  "options": {"temperature": 0}
}
```

地址是 `http://localhost:11434/api/chat`。
上面是请求结构说明，实际提示内容由 OptoPrime 生成，详见运行后的 `optimizer.json`。

JSON 模式帮助模型输出 JSON，但业务字段仍可能错误。
本次实测就遇到了建议字段结构不符合要求的情况，因此仍需要检查输出并限制重试。

## 8. 从这个例子理解 Agent 的几个概念

**状态 State**：当前任务的数据，例如重量、尝试次数和反馈。

**工具或行动 Action**：与环境交互的操作。本例是确定性报价运算；以后可以替换为检索、查询或执行代码。

**策略参数**：影响行动结果的可调内容。本例是 rate，以后可以是提示词，但需要重新建立相应计算依赖和评估方式。

**反馈 Feedback**：环境对结果的评价。本例来自标准答案，不是模型自行认定是否成功。

**记忆 Memory**：跨步骤或任务保留的信息。本例有历史记录，但没有实现持久的经验记忆库。

**学习或优化**：本例通过反馈调整应用参数，不更新模型权重。记录历史本身也不等于优化已经发生。

如果联想到 Reflexion：可以把“从失败反馈改善下一次行为”作为共同出发点。
但这个 demo 使用 Trace 的执行依赖和参数更新接口，并没有实现 Reflexion 的完整反思文本记忆机制。

## 9. 回家后可以做的实验

### 实验一：关闭重试

```powershell
# 仓库根目录
.\.venv\Scripts\python.exe demo.py --max-attempts 1

# ts-demo 目录
npm.cmd run demo -- --max-attempts 1
```

观察：首轮失败后直接退出，参数没有更新。
思考：为什么尝试次数与优化次数不是同一个概念？

### 实验二：对比假模型和真实模型

```powershell
# 仓库根目录
.\.venv\Scripts\python.exe demo.py
.\.venv\Scripts\python.exe demo.py --ollama

# ts-demo 目录
npm.cmd run demo
npm.cmd run demo:ollama
```

对比各自 `artifacts/optimizer.json` 的提示与响应。每次运行会覆盖该目录下的旧记录。

### 实验三：尝试不可能的答案

把 2kg 的期望报价改为 12，但仍只允许整数费率。
方程 `2 × rate + 5 = 12` 没有整数解，重试也无法保证成功。

思考：在真实任务中，如何识别“模型还没做好”与“任务约束根本无解”？

### 实验四：下一步做一个更完整的 Agent

建议按这个顺序扩展：

1. 先增加多个训练样例和独立验证集，评估规则覆盖不同输入。
2. 再添加两个明确工具，让模型根据输入选择工具。
3. 然后把可优化内容扩展为提示词，保留提示词到输出的 Trace 依赖。
4. 最后考虑跨运行保存策略、检查点恢复和长期记忆。

不要同时加上所有能力。每增加一个组件，都先明确它的输入、输出和成功标准。

## 10. 阅读导航与资料

从手机回到代码时，可以按以下顺序阅读：

- [Python 完整示例](demo.py)
- [TS LangGraph 流程](ts-demo/src/demo.ts)
- [TS 子进程客户端](ts-demo/src/trace-client.ts)
- [Python Trace worker](ts-demo/trace_worker.py)
- [Python 运行教程](README.md)
- [TS 运行教程](ts-demo/README.md)

官方资料：

- [Microsoft Trace](https://github.com/microsoft/Trace)
- [OptoPrime 实现](https://github.com/microsoft/Trace/blob/main/opto/optimizers/optoprime.py)
- [Python StateGraph API](https://reference.langchain.com/python/langgraph/graph/state)
- [TypeScript StateGraph API](https://langchain-ai.github.io/langgraphjs/reference/classes/langgraph.StateGraph.html)
- [Ollama Chat API](https://docs.ollama.com/api/chat)

## 11. 读完后用自己的话回答

1. LangGraph 控制流图和 Trace 计算依赖图分别有什么作用？
2. 为什么不能只把 quote 的数字传给优化器？
3. 为什么 Qwen 第一次提出建议后，费率可能没有变化？
4. TS 版本的 handle 保存在哪里，什么时候会失效？
5. 本项目改变了模型权重，还是应用层参数？
6. 为什么这个例子还不具备完整的自主工具选择和长期记忆？

能说清这六点，就已经抓住这个 demo 最值得学习的部分。
