import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { runDemo } from "./demo.js";
import { initializeTelemetry } from "./telemetry.js";

async function main() {
  const { values } = parseArgs({ options: {
    ollama: { type: "boolean", default: false },
    model: { type: "string", default: "qwen3.5:9b" },
    "base-url": { type: "string", default: "http://localhost:11434" },
    "max-attempts": { type: "string", default: "3" },
    weight: { type: "string", default: "2" },
    expected: { type: "string", default: "11" },
    "initial-rate": { type: "string", default: "1" },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("npm run demo -- [--ollama] [--model qwen3.5:9b] [--base-url http://localhost:11434] [--max-attempts 3] [--weight 2] [--expected 11] [--initial-rate 1]");
    return;
  }
  console.log(values.ollama ? `本地 Ollama：${values.model}` : "教学假模型：无需模型服务");
  // telemetry 初始化 Langfuse 导出；没有凭据时业务仍可离线运行。
  const telemetry = initializeTelemetry();
  console.log(telemetry.enabled ? "Langfuse 已启用" : "未配置 Langfuse 凭据：仅保存本地记录");
  try {
    const { optimizerLog, mermaid, ...run } = await runDemo({
      ollama: values.ollama, model: values.model, baseUrl: values["base-url"],
      maxAttempts: Number(values["max-attempts"]), weight: Number(values.weight),
      expected: Number(values.expected), initialRate: Number(values["initial-rate"]),
      onStep: console.log,
    });
    // 固定输出到 ts-demo/artifacts，不依赖启动时的工作目录。
    const output = new URL("../artifacts/", import.meta.url);
    await mkdir(output, { recursive: true });
    await Promise.all([
      writeFile(new URL("run.json", output), JSON.stringify(run, null, 2)),
      writeFile(new URL("optimizer.json", output), JSON.stringify(optimizerLog, null, 2)),
      writeFile(new URL("graph.mmd", output), mermaid),
    ]);
    console.log(`新样例：4kg 报价=${run.holdout.quote}，期望=17`);
    console.log(run.passed ? "成功，记录已保存到 ts-demo/artifacts/" : "达到重试上限，尚未成功");
  } finally {
    // 短命 CLI 退出前刷新并关闭导出器，避免尚未上传的观察丢失。
    await telemetry.shutdown();
  }
}

main().catch((error: Error) => {
  console.error(`运行失败：${error.message}`);
  process.exitCode = 1;
});
