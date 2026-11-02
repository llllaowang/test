// Annotation 定义状态字段；START / END 是起止标记；StateGraph 用于构建工作流。
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
// TraceClient 与 Python worker 通信；Quote 描述报价句柄、数值和费率。
import { TraceClient, type Quote } from "./trace-client.js";

/** 一轮报价与评估的记录。 */
export interface HistoryRow {
  /** 当前是第几次尝试，从 1 开始。 */
  attempt: number;
  /** 本轮计算时使用的每公斤费用。 */
  rate: number;
  /** 本轮计算得到的运费金额。 */
  quote: number;
  /** 本轮报价是否等于标准答案。 */
  passed: boolean;
}

/** 调用方可选的运行配置；未提供的字段使用默认值。 */
export interface Options {
  /** true 调用本地 Ollama；false 使用教学假模型。 */
  ollama?: boolean;
  /** Ollama 模型名，默认 qwen3.5:9b。 */
  model?: string;
  /** Ollama 服务地址，默认 http://localhost:11434。 */
  baseUrl?: string;
  /** 最多执行多少轮报价，包含第一次尝试。 */
  maxAttempts?: number;
  /** 训练样例的重量，单位为公斤。 */
  weight?: number;
  /** 训练样例的正确运费，用于评估实际报价。 */
  expected?: number;
  /** Trace 可训练费率的初始值。 */
  initialRate?: number;
  /** 可选的进度回调；message 是本次要显示的日志文本。 */
  onStep?: (message: string) => void;
}

// LangGraph 状态只包含可序列化 JSON。handle 对应 Python 内存中的 Trace Node。
// State 是整个工作流共享的状态结构定义，不是某次运行的状态值。
const State = Annotation.Root({
  // 当前任务的重量输入，单位为公斤。
  weight: Annotation<number>,
  // 当前任务的标准报价，评估节点用它判断对错。
  expected: Annotation<number>,
  // 已执行的报价轮数，初始为 0，每次 act 加 1。
  attempt: Annotation<number>,
  // 最新报价：handle 找回原始 Trace Node，value 用于评估，rate 用于记录。
  quote: Annotation<Quote>,
  // 最新一轮评估是否通过，供条件路由决定是否结束。
  passed: Annotation<boolean>,
  // 最新评估反馈，失败时传给 Trace 优化器。
  feedback: Annotation<string>,
  // 本次运行各轮的评估历史，每次追加一条记录。
  history: Annotation<HistoryRow[]>,
});

/** options 是本次运行配置；每次调用独立创建工作流和 Python worker。 */
export async function runDemo(options: Options = {}) {
  // 解析后的尝试次数上限；?? 只在配置为 null / undefined 时使用默认值。
  const maxAttempts = options.maxAttempts ?? 3;
  // 本次训练输入的重量，默认 2kg。
  const weight = options.weight ?? 2;
  // 本次训练的标准报价，默认 11。
  const expected = options.expected ?? 11;
  // Python worker 初始化可训练参数时使用的费率，默认 1。
  const initialRate = options.initialRate ?? 1;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts 必须为正整数");
  if (!Number.isSafeInteger(weight) || weight <= 0) throw new Error("weight 必须为正整数");
  if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(initialRate)) throw new Error("报价与费率必须为整数");
  // 本次运行专用的桥接客户端，管理 Python 子进程及请求响应。
  const client = new TraceClient();
  try {
    await client.init({
      // 模型运行模式：默认使用不依赖 Ollama 的教学假模型。
      ollama: options.ollama ?? false,
      // 真实模型模式下要加载的 Ollama 模型。
      model: options.model ?? "qwen3.5:9b",
      // Python 模型适配器请求的服务地址。
      baseUrl: options.baseUrl ?? "http://localhost:11434",
      // 将初始费率交给 Python 创建 trainable Node。
      initialRate,
    });
    // graph 是编译后的可执行工作流，包含节点、固定边和条件路由。
    const graph = new StateGraph(State)
      // state 是 act 执行前的共享状态快照。
      .addNode("act", async (state) => ({
        // 请求 Python 计算报价，保留原始 Trace Node 并返回其句柄。
        quote: await client.act(state.weight),
        // 本次报价也算一次尝试。
        attempt: state.attempt + 1,
      }))
      // state 包含 act 刚写入的最新报价与轮数。
      .addNode("evaluate", (state) => {
        // passed 是本轮判断结果，不依赖模型自己宣称是否成功。
        const passed = state.quote.value === state.expected;
        // row 保存本轮计算时的参数和结果，供日志与学习记录使用。
        const row = {
          // 本轮的尝试编号。
          attempt: state.attempt,
          // 生成这笔报价时的费率，尚未执行下一次优化。
          rate: state.quote.rate,
          // 从 Python 返回的普通数值，便于展示和持久化。
          quote: state.quote.value,
          // 复用本轮比较得到的布尔结果。
          passed,
        };
        options.onStep?.(`第 ${row.attempt} 轮：rate=${row.rate}，报价=${row.quote}，通过=${passed}`);
        return {
          // 将本轮是否通过写回共享状态。
          passed,
          // 创建新数组追加本轮记录，保留之前各轮的历史。
          history: [...state.history, row],
          // 通过时标记 Correct；失败时描述输入、期望值和允许修改的参数。
          feedback: passed ? "Correct" : `Shipping quote incorrect. weight=${state.weight}; expected=${state.expected}; actual=${state.quote.value}. Formula: quote = rate * weight + 5. Change only rate, an integer. Infer a reusable per-kg rate.`,
        };
      })
      // state 提供失败输出的句柄及与它对应的评估反馈。
      .addNode("optimize", async (state) => {
        options.onStep?.("Trace 正在根据反馈请求优化建议……");
        await client.optimize(state.quote.handle, state.feedback);
        return {};
      })
      .addEdge(START, "act")
      .addEdge("act", "evaluate")
      // 此处 state 是 evaluate 更新后的状态，用于判断结束或继续优化。
      .addConditionalEdges("evaluate", (state) =>
        state.passed || state.attempt >= maxAttempts ? "end" : "optimize",
        { end: END, optimize: "optimize" })
      .addEdge("optimize", "act")
      .compile();

    // final 是整个工作流结束后的状态，包含最终评估结果和所有轮次记录。
    const final = await graph.invoke({
      // 训练样例输入。
      weight,
      // 训练样例的标准答案。
      expected,
      // 尚未执行任何报价。
      attempt: 0,
      // 本次运行从空历史开始。
      history: [],
    }, {
      // LangGraph 的执行步数限制，留出 act / evaluate / optimize 循环的空间。
      recursionLimit: maxAttempts * 3 + 5,
    });
    // snapshot 是 Python 侧最终费率和优化日志的快照。
    const snapshot = await client.inspect();
    // holdout 是用最终费率计算的 4kg 新样例，未参与之前的参数优化。
    const holdout = await client.act(4);
    return {
      // 记录本次使用真实模型还是教学假模型。
      mode: options.ollama ? "ollama" : "mock",
      // 真实模式记录模型名称，假模型模式用 null 表示没有调用 Ollama。
      model: options.ollama ? options.model ?? "qwen3.5:9b" : null,
      // 整个训练流程的逐轮记录。
      history: final.history,
      // 最后一轮训练样例是否通过。
      passed: final.passed,
      // Trace 参数更新后最终保留的每公斤费用。
      finalRate: snapshot.rate,
      // 独立新样例的输入、实际输出、标准答案和检查结果。
      holdout: {
        // 新样例重量，单位为公斤。
        weight: 4,
        // 根据最终费率计算得到的报价。
        quote: holdout.value,
        // 本教学任务中 4kg 对应的标准答案。
        expected: 17,
        // 新样例是否与标准答案一致。
        passed: holdout.value === 17,
      },
      // OptoPrime 实际构造的提示、反馈与模型响应记录。
      optimizerLog: snapshot.log,
      // LangGraph 控制流图的 Mermaid 文本，便于保存和查看。
      mermaid: (await graph.getGraphAsync()).drawMermaid(),
    };
  } finally {
    client.close();
  }
}
