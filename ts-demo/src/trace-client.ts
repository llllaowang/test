import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export interface Quote { handle: string; value: number; rate: number }
export interface Snapshot { rate: number; log: unknown[] }

/** 一个任务持有一个 worker，避免并发请求互相覆盖可训练参数。 */
export class TraceClient {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private failure?: Error;

  constructor() {
    const parentPython = fileURLToPath(new URL("../../.venv/Scripts/python.exe", import.meta.url));
    const python = process.env.PYTHON_PATH ?? (existsSync(parentPython) ? parentPython : "python");
    this.child = spawn(python, ["-u", fileURLToPath(new URL("../trace_worker.py", import.meta.url))], {
      stdio: "pipe", env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });
    this.child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code) => this.fail(new Error(`Trace worker 已退出（${code}）`)));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const response = JSON.parse(line);
        const waiter = this.pending.get(response.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.pending.delete(response.id);
        if (response.error) waiter.reject(new Error(response.error));
        else waiter.resolve(response.result);
      } catch {
        this.fail(new Error(`Trace worker 返回了无效 JSON：${line}`));
      }
    });
  }

  private fail(error: Error) {
    this.failure = error;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  private call<T>(method: string, args: object = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`Trace ${method} 超时，请检查 Ollama 服务`));
        this.child.kill();
      }, 400_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, args }) + "\n");
    });
  }

  init(options: { ollama: boolean; model: string; baseUrl: string; initialRate: number }) {
    return this.call<{ rate: number }>("init", options);
  }
  act(weight: number) { return this.call<Quote>("act", { weight }); }
  optimize(handle: string, feedback: string) {
    return this.call<Snapshot>("optimize", { handle, feedback });
  }
  inspect() { return this.call<Snapshot>("inspect"); }
  close() { this.child.stdin.end(); this.child.kill(); }
}
