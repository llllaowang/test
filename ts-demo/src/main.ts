import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { runDemo } from "./demo.js";

async function main() {
  const { values } = parseArgs({ options: {
    ollama: { type: "boolean", default: false },
    model: { type: "string", default: "qwen3.5:9b" },
    "base-url": { type: "string", default: "http://localhost:11434" },
    "max-attempts": { type: "string", default: "3" },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("npm run demo -- [--ollama] [--model qwen3.5:9b] [--base-url http://localhost:11434] [--max-attempts 3]");
    return;
  }
  console.log(values.ollama ? `本地 Ollama：${values.model}` : "教学假模型：无需模型服务");
  const { optimizerLog, mermaid, ...run } = await runDemo({
    ollama: values.ollama, model: values.model, baseUrl: values["base-url"],
    maxAttempts: Number(values["max-attempts"]), onStep: console.log,
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
}

main().catch((error: Error) => {
  console.error(`运行失败：${error.message}`);
  process.exitCode = 1;
});
