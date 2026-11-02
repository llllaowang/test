import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { startActiveObservation } from "@langfuse/tracing";
import { OllamaClient, type OptimizationInput, type Suggestion } from "./ollama-client.js";

/** 一轮报价与评估结果。 */
export interface HistoryRow {
  /** 从 1 开始的尝试编号。 */
  attempt: number;
  /** 本轮的每公斤费用。 */
  rate: number;
  /** 本轮计算出的运费。 */
  quote: number;
  /** 报价是否等于标准答案。 */
  passed: boolean;
}

/** 应用自身的参数更新记录，不是 Langfuse 自动优化的结果。 */
export interface OptimizationLog {
  /** 评估节点提供的失败信息。 */
  input: OptimizationInput;
  /** 通过校验的建议；模型调用失败时为空。 */
  suggestion: Suggestion | null;
  /** 调用或格式校验失败时的错误说明。 */
  error?: string;
}

export interface Options {
  /** true 使用本地 Ollama，默认 false 使用教学规则。 */
  ollama?: boolean;
  /** Ollama 模型名称。 */
  model?: string;
  /** Ollama 服务地址。 */
  baseUrl?: string;
  /** 最多报价多少轮，包含第一次。 */
  maxAttempts?: number;
  /** 训练样例重量 kg。 */
  weight?: number;
  /** 训练样例标准运费。 */
  expected?: number;
  /** 初始化的每公斤费率。 */
  initialRate?: number;
  /** 进度回调，message 为要显示的日志内容。 */
  onStep?: (message: string) => void;
  /** 可注入建议函数，便于测试错误响应与重试。input 为评估信息。 */
  suggest?: (input: OptimizationInput) => Promise<Suggestion>;
}

// State 定义普通 JSON 状态；不再包含 Python Trace Node 或 handle。
const State = Annotation.Root({
  // 样例重量。
  weight: Annotation<number>,
  // 标准报价。
  expected: Annotation<number>,
  // 当前可调整费率，作为显式状态在节点间传递。
  rate: Annotation<number>,
  // 已执行的报价次数。
  attempt: Annotation<number>,
  // 最新实际报价。
  quote: Annotation<number>,
  // 最新评估结果。
  passed: Annotation<boolean>,
  // 最新失败反馈。
  feedback: Annotation<string>,
  // 逐轮评估记录。
  history: Annotation<HistoryRow[]>,
  // 应用显式更新参数的记录。
  optimizerLog: Annotation<OptimizationLog[]>,
});

/** options 是本次运行配置；Langfuse 观测开启与否不影响业务结果。 */
export async function runDemo(options: Options = {}) {
  // maxAttempts 是包含首次报价的总尝试上限。
  const maxAttempts = options.maxAttempts ?? 3;
  // weight 是训练输入，expected 是训练标准答案。
  const weight = options.weight ?? 2;
  const expected = options.expected ?? 11;
  // initialRate 是初始策略参数。
  const initialRate = options.initialRate ?? 1;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts 必须为正整数");
  if (!Number.isSafeInteger(weight) || weight <= 0) throw new Error("weight 必须为正整数");
  if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(initialRate) || initialRate < 0) {
    throw new Error("报价必须为整数，费率必须为非负整数");
  }
  // client 是纯 TS Ollama HTTP 客户端，不启动 Python 子进程。
  const client = new OllamaClient(options.model, options.baseUrl);
  // root 是本次工作流的根观察；节点和模型生成是它的子级。
  return startActiveObservation("shipping-agent", async (root) => {
    root.update({ input: { weight, expected, initialRate, maxAttempts },
      metadata: { mode: options.ollama ? "ollama" : "mock" } });
    // graph 是 LangGraph 编译后的可执行工作流。
    const graph = new StateGraph(State)
      // state 是执行前状态；span 记录行动的输入输出。
      .addNode("act", (state) => startActiveObservation("act", (span) => {
        // quote 是确定性报价工具计算出的结果。
        const quote = state.rate * state.weight + 5;
        span.update({ input: { rate: state.rate, weight: state.weight }, output: { quote } });
        return { quote, attempt: state.attempt + 1 };
      }))
      // state 包含最新报价；span 记录本轮评估结果。
      .addNode("evaluate", (state) => startActiveObservation("evaluate", (span) => {
        // passed 是与标准答案比较的结果。
        const passed = state.quote === state.expected;
        // row 是一条完整的轮次记录。
        const row = { attempt: state.attempt, rate: state.rate, quote: state.quote, passed };
        options.onStep?.(`第 ${row.attempt} 轮：rate=${row.rate}，报价=${row.quote}，通过=${passed}`);
        span.update({ input: { actual: state.quote, expected: state.expected }, output: row });
        return { passed, history: [...state.history, row], feedback: passed ? "Correct" :
          `weight=${state.weight}; expected=${state.expected}; actual=${state.quote}. Formula: quote = rate * weight + 5. Change only rate.` };
      }))
      // state 提供本轮失败信息；span 观测应用自行实现的优化过程。
      .addNode("optimize", (state) => startActiveObservation("optimize", async (span) => {
        // input 是发给建议函数的上下文，没有隐式计算依赖传播。
        const input = { rate: state.rate, weight: state.weight, expected: state.expected,
          actual: state.quote, feedback: state.feedback };
        span.update({ input });
        options.onStep?.("根据评估反馈生成费率建议……");
        try {
          // suggestion 来自注入函数、真实 Qwen，或仅用于教学的确定性规则。
          const suggestion = options.suggest ? await options.suggest(input) : options.ollama
            ? await client.suggest(input)
            : { rate: Math.floor((input.expected - 5) / input.weight), reasoning: "教学规则：求解整数费率。" };
          if (!Number.isSafeInteger(suggestion.rate) || suggestion.rate < 0 || typeof suggestion.reasoning !== "string") {
            throw new Error("建议费率必须为非负整数，并包含 reasoning");
          }
          span.update({ output: suggestion });
          return { rate: suggestion.rate, optimizerLog: [...state.optimizerLog, { input, suggestion }] };
        } catch (error) {
          // message 是可记录的错误信息；本轮保留旧费率，下轮仍由评估器检查。
          const message = error instanceof Error ? error.message : String(error);
          span.update({ level: "ERROR", statusMessage: message, output: { retainedRate: state.rate } });
          options.onStep?.(`建议无效，保留原费率：${message}`);
          return { optimizerLog: [...state.optimizerLog, { input, suggestion: null, error: message }] };
        }
      }))
      .addEdge(START, "act")
      .addEdge("act", "evaluate")
      // state 为评估后状态，成功或达到上限就结束。
      .addConditionalEdges("evaluate", (state) =>
        state.passed || state.attempt >= maxAttempts ? "end" : "optimize",
        { end: END, optimize: "optimize" })
      .addEdge("optimize", "act")
      .compile();
    // final 为流程结束状态，参数已在 TS 状态中直接更新。
    const final = await graph.invoke({ weight, expected, rate: initialRate, attempt: 0, history: [], optimizerLog: [] },
      { recursionLimit: maxAttempts * 3 + 5 });
    // holdout 是未参与优化的 4kg 检查；期望 17 仅适用于本教学任务。
    const holdout = { weight: 4, quote: final.rate * 4 + 5, expected: 17, passed: final.rate * 4 + 5 === 17 };
    root.update({ output: { passed: final.passed, finalRate: final.rate, attempts: final.attempt, holdout } });
    return { mode: options.ollama ? "ollama" : "mock", model: options.ollama ? options.model ?? "qwen3.5:9b" : null,
      history: final.history, passed: final.passed, finalRate: final.rate, holdout,
      optimizerLog: final.optimizerLog, mermaid: (await graph.getGraphAsync()).drawMermaid() };
  });
}
