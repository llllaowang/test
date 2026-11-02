import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { TraceClient, type Quote } from "./trace-client.js";

export interface HistoryRow { attempt: number; rate: number; quote: number; passed: boolean }
export interface Options {
  ollama?: boolean; model?: string; baseUrl?: string; maxAttempts?: number;
  weight?: number; expected?: number; initialRate?: number;
  onStep?: (message: string) => void;
}

// LangGraph 状态只包含可序列化 JSON。handle 对应 Python 内存中的 Trace Node。
const State = Annotation.Root({
  weight: Annotation<number>,
  expected: Annotation<number>,
  attempt: Annotation<number>,
  quote: Annotation<Quote>,
  passed: Annotation<boolean>,
  feedback: Annotation<string>,
  history: Annotation<HistoryRow[]>,
});

export async function runDemo(options: Options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  const weight = options.weight ?? 2;
  const expected = options.expected ?? 11;
  const initialRate = options.initialRate ?? 1;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts 必须为正整数");
  if (!Number.isSafeInteger(weight) || weight <= 0) throw new Error("weight 必须为正整数");
  if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(initialRate)) throw new Error("报价与费率必须为整数");
  const client = new TraceClient();
  try {
    await client.init({ ollama: options.ollama ?? false, model: options.model ?? "qwen3.5:9b",
      baseUrl: options.baseUrl ?? "http://localhost:11434", initialRate });
    const graph = new StateGraph(State)
      .addNode("act", async (state) => ({
        quote: await client.act(state.weight), attempt: state.attempt + 1,
      }))
      .addNode("evaluate", (state) => {
        const passed = state.quote.value === state.expected;
        const row = { attempt: state.attempt, rate: state.quote.rate, quote: state.quote.value, passed };
        options.onStep?.(`第 ${row.attempt} 轮：rate=${row.rate}，报价=${row.quote}，通过=${passed}`);
        return {
          passed, history: [...state.history, row],
          feedback: passed ? "Correct" : `Shipping quote incorrect. weight=${state.weight}; expected=${state.expected}; actual=${state.quote.value}. Formula: quote = rate * weight + 5. Change only rate, an integer. Infer a reusable per-kg rate.`,
        };
      })
      .addNode("optimize", async (state) => {
        options.onStep?.("Trace 正在根据反馈请求优化建议……");
        await client.optimize(state.quote.handle, state.feedback);
        return {};
      })
      .addEdge(START, "act")
      .addEdge("act", "evaluate")
      .addConditionalEdges("evaluate", (state) =>
        state.passed || state.attempt >= maxAttempts ? "end" : "optimize",
        { end: END, optimize: "optimize" })
      .addEdge("optimize", "act")
      .compile();

    const final = await graph.invoke({ weight, expected, attempt: 0, history: [] },
      { recursionLimit: maxAttempts * 3 + 5 });
    const snapshot = await client.inspect();
    const holdout = await client.act(4);
    return { mode: options.ollama ? "ollama" : "mock", model: options.ollama ? options.model ?? "qwen3.5:9b" : null,
      history: final.history, passed: final.passed, finalRate: snapshot.rate,
      holdout: { weight: 4, quote: holdout.value, expected: 17, passed: holdout.value === 17 },
      optimizerLog: snapshot.log, mermaid: (await graph.getGraphAsync()).drawMermaid() };
  } finally {
    client.close();
  }
}
