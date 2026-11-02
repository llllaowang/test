import test from "node:test";
import assert from "node:assert/strict";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { runDemo } from "./demo.js";
import { OllamaClient } from "./ollama-client.js";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// exporter 在内存中收集真实 Langfuse SDK 产生的 OTel span，无需云端凭据。
const exporter = new InMemorySpanExporter();
// sdk 为测试安装上下文管理器，验证节点的父子调用关系。
const sdk = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
sdk.register();
test.after(async () => sdk.shutdown());

test("参数更新成功，Langfuse 节点归属于同一个工作流", async () => {
  exporter.reset();
  const result = await runDemo();
  assert.deepEqual(result.history.map((row) => row.quote), [7, 11]);
  assert.equal(result.finalRate, 3);
  assert.equal(result.holdout.passed, true);
  const spans = exporter.getFinishedSpans();
  const root = spans.find((span) => span.name === "shipping-agent")!;
  assert.ok(root);
  assert.equal(spans.filter((span) => span.name === "act").length, 2);
  for (const span of spans.filter((span) => span !== root)) {
    assert.equal(span.spanContext().traceId, root.spanContext().traceId);
    assert.equal(span.parentSpanContext?.spanId, root.spanContext().spanId);
  }
});

test("达到上限时不优化，首次成功时也不优化", async () => {
  const limited = await runDemo({ maxAttempts: 1 });
  assert.equal(limited.passed, false);
  assert.equal(limited.optimizerLog.length, 0);
  const correct = await runDemo({ initialRate: 3 });
  assert.equal(correct.passed, true);
  assert.equal(correct.history.length, 1);
  assert.equal(correct.optimizerLog.length, 0);
});

test("无效建议保留旧参数并在上限结束", async () => {
  const result = await runDemo({ suggest: async () => ({ rate: NaN, reasoning: "invalid" }) });
  assert.equal(result.finalRate, 1);
  assert.equal(result.passed, false);
  assert.equal(result.history.length, 3);
  assert.ok(result.optimizerLog.every((row) => row.error && row.suggestion === null));
  await assert.rejects(runDemo({ maxAttempts: 0 }), /maxAttempts/);
});

test("真实 HTTP 适配器创建 generation 并记录 token 用量", async () => {
  // originalFetch 保存真实 fetch，测试结束恢复。
  const originalFetch = globalThis.fetch;
  exporter.reset();
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: { content: JSON.stringify({ rate: 3, reasoning: "solve" }) },
    prompt_eval_count: 10, eval_count: 5,
  }), { status: 200 });
  try {
    const client = new OllamaClient();
    const result = await runDemo({ ollama: true, suggest: (input) => client.suggest(input) });
    assert.equal(result.passed, true);
    const spans = exporter.getFinishedSpans();
    const generation = spans.find((span) => span.name === "ollama.suggest-rate")!;
    const optimize = spans.find((span) => span.name === "optimize")!;
    assert.ok(generation);
    assert.equal(generation.parentSpanContext?.spanId, optimize.spanContext().spanId);
    assert.equal(generation.attributes["langfuse.observation.type"], "generation");
    assert.ok(JSON.stringify(generation.attributes).includes("qwen3.5:9b"));
    assert.ok(JSON.stringify(generation.attributes).includes('10'));
  } finally { globalThis.fetch = originalFetch; }
});

test("CLI 退出前将 Langfuse 数据导出到本地测试接收器", async () => {
  // paths 记录导出器实际请求的地址，模拟服务不连接云端。
  const paths: string[] = [];
  // server 接收真实 SDK 发出的 OTLP HTTP 请求。
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // address 是随机分配的测试监听端口。
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    // result 是独立 CLI 的输出，凭据为无实际权限的测试字符串。
    const result = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)),
      fileURLToPath(new URL("./main.ts", import.meta.url)),
    ], { timeout: 30_000, env: { ...process.env,
      LANGFUSE_PUBLIC_KEY: "pk-lf-local-test", LANGFUSE_SECRET_KEY: "sk-lf-local-test",
      LANGFUSE_BASE_URL: `http://127.0.0.1:${address.port}`,
    } });
    assert.match(result.stdout, /Langfuse 已启用/);
    assert.ok(paths.some((path) => path.includes("/api/public/otel/v1/traces")), paths.join(","));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
