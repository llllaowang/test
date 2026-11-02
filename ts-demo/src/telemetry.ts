import { config } from "dotenv";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

// 仅加载当前 TS 项目的配置，不读取父目录配置；已有环境变量优先。
config({ path: new URL("../.env", import.meta.url), quiet: true });

/** 创建进程级观测设施；没有凭据时不初始化导出器，也不向外发送数据。 */
export function initializeTelemetry() {
  // publicKey / secretKey 是 Langfuse 项目凭据，不能写进 Git。
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (Boolean(publicKey) !== Boolean(secretKey)) {
    throw new Error("请同时配置 LANGFUSE_PUBLIC_KEY 和 LANGFUSE_SECRET_KEY");
  }
  if (!publicKey || !secretKey) {
    return { enabled: false, shutdown: async () => {} };
  }
  // sdk 注册上下文管理器及 Langfuse 导出器，让嵌套观察形成父子调用链。
  const sdk = new NodeTracerProvider({ spanProcessors: [new LangfuseSpanProcessor()] });
  sdk.register();
  return { enabled: true, shutdown: () => sdk.shutdown() };
}
