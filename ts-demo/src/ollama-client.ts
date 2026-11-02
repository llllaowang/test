import { startActiveObservation } from "@langfuse/tracing";

/** 优化器接收的任务信息，全部是普通 JSON，不包含 Python 对象。 */
export interface OptimizationInput {
  /** 当前费率。 */
  rate: number;
  /** 样例重量，单位 kg。 */
  weight: number;
  /** 标准报价。 */
  expected: number;
  /** 实际报价。 */
  actual: number;
  /** 评估节点给出的失败反馈。 */
  feedback: string;
}

/** 经过运行时校验的模型建议。 */
export interface Suggestion {
  /** 下一轮使用的非负整数费率。 */
  rate: number;
  /** 模型返回的建议说明。 */
  reasoning: string;
}

/** TS 直接调用 Ollama；Langfuse 只记录调用，不负责优化参数。 */
export class OllamaClient {
  constructor(
    /** 本地模型名称。 */
    private readonly model = "qwen3.5:9b",
    /** Ollama 服务地址。 */
    private readonly baseUrl = "http://localhost:11434",
  ) {}

  /** input 是本轮失败信息；返回模型给出的新费率。 */
  async suggest(input: OptimizationInput): Promise<Suggestion> {
    // generation 表示一次模型生成，自动继承 optimize 节点的父级上下文。
    return startActiveObservation("ollama.suggest-rate", async (generation) => {
      // messages 是发送给本地 Qwen 的提示词。
      const messages = [
        { role: "system", content: "You improve a shipping rate. Formula: quote = rate * weight + 5. Change only the non-negative integer rate. Return JSON with rate and reasoning. Infer a reusable rate, do not hardcode a quote." },
        { role: "user", content: JSON.stringify(input) },
      ];
      generation.update({ model: this.model, input: messages, modelParameters: { temperature: 0 } });
      // response 是 Ollama HTTP 响应；180 秒包含模型首次加载的等待时间。
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(180_000),
        body: JSON.stringify({
          model: this.model, messages, stream: false, think: false,
          format: {
            type: "object", properties: {
              rate: { type: "integer", minimum: 0 }, reasoning: { type: "string" },
            }, required: ["rate", "reasoning"], additionalProperties: false,
          },
          options: { temperature: 0, num_predict: 1024 },
        }),
      });
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
      // body 是 Ollama 返回的外层 JSON；不能仅靠 TS 类型代替运行时验证。
      const body = await response.json() as {
        message?: { content?: string }; prompt_eval_count?: number; eval_count?: number;
      };
      if (typeof body.message?.content !== "string") throw new Error("Ollama 缺少 message.content");
      // suggestion 是模型生成的内层 JSON，只有通过检查后才允许更新参数。
      const suggestion: unknown = JSON.parse(body.message.content);
      if (typeof suggestion !== "object" || suggestion === null ||
          !("rate" in suggestion) || typeof suggestion.rate !== "number" ||
          !Number.isSafeInteger(suggestion.rate) || suggestion.rate < 0 ||
          !("reasoning" in suggestion) || typeof suggestion.reasoning !== "string") {
        throw new Error("模型建议必须包含非负整数 rate 和字符串 reasoning");
      }
      generation.update({ output: suggestion, usageDetails: {
        ...(typeof body.prompt_eval_count === "number" ? { input: body.prompt_eval_count } : {}),
        ...(typeof body.eval_count === "number" ? { output: body.eval_count } : {}),
      } });
      return { rate: suggestion.rate, reasoning: suggestion.reasoning };
    }, { asType: "generation" });
  }
}
