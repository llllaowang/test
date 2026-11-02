// spawn 启动 Python；ChildProcessWithoutNullStreams 表示三个标准流都可访问。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
// existsSync 检查默认虚拟环境中的 Python 是否存在。
import { existsSync } from "node:fs";
// createInterface 将标准输出按行拆分，对应 JSON Lines 协议。
import { createInterface } from "node:readline";
// fileURLToPath 将当前模块相对 URL 转成操作系统文件路径。
import { fileURLToPath } from "node:url";

/** Python act 方法返回的报价信息。 */
export interface Quote {
  /** 原始 Trace Node 的句柄，只在当前 worker 中有效。 */
  handle: string;
  /** 报价的普通数值，用于 TS 侧评估。 */
  value: number;
  /** 生成本次报价时使用的每公斤费用。 */
  rate: number;
}

/** Python 返回的参数与日志信息；日志范围取决于具体方法。 */
export interface Snapshot {
  /** Python 中可训练费率的当前值。 */
  rate: number;
  /** inspect 返回全部优化日志，optimize 返回最近一条或空数组。 */
  log: unknown[];
}

/** 一个任务持有一个 worker，避免并发请求互相覆盖可训练参数。 */
export class TraceClient {
  // 当前客户端独享的 Python 子进程，负责保留 Trace Node 和优化器。
  private child: ChildProcessWithoutNullStreams;
  // 请求编号计数器，每发出一次请求递增一次。
  private sequence = 0;
  // 尚未完成的请求：用请求 id 找到对应 Promise 的回调和超时计时器。
  private pending = new Map<number, {
    // 请求成功时调用；value 是从 Python JSON 响应中取出的 result。
    resolve: (value: unknown) => void;
    // 请求失败时调用；error 是将传给调用方的异常。
    reject: (error: Error) => void;
    // 本次请求的超时句柄，收到响应或客户端失败时清除。
    timer: NodeJS.Timeout;
  }>();
  // 客户端发生的终止性错误；设置后拒绝后续请求。
  private failure?: Error;

  constructor() {
    // 相对于本文件定位仓库根目录下的 Windows Python 虚拟环境。
    const parentPython = fileURLToPath(new URL("../../.venv/Scripts/python.exe", import.meta.url));
    // Python 路径优先取环境变量，其次用项目虚拟环境，最后尝试 PATH 中的 python。
    const python = process.env.PYTHON_PATH ?? (existsSync(parentPython) ? parentPython : "python");
    // -u 禁用 Python 标准流缓冲，让每行响应及时送达 TS。
    this.child = spawn(python, ["-u", fileURLToPath(new URL("../trace_worker.py", import.meta.url))], {
      // 创建可读写管道：stdin 发送请求，stdout 接收 JSON，stderr 接收日志。
      stdio: "pipe",
      // 继承当前环境，并固定 Python 标准流使用 UTF-8，避免中文乱码。
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      // Windows 下不弹出子进程控制台窗口。
      windowsHide: true,
    });
    // chunk 是 Python stderr 发来的一段日志，直接转发到当前进程。
    this.child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    // error 是向 Python 写入请求时发生的管道错误。
    this.child.stdin.on("error", (error) => this.fail(error));
    // error 是启动或管理子进程时发生的错误，例如 Python 路径不存在。
    this.child.on("error", (error) => this.fail(error));
    // code 是子进程退出码；进程被信号终止时也可能为 null。
    this.child.on("exit", (code) => this.fail(new Error(`Trace worker 已退出（${code}）`)));
    // line 是 Python stdout 上的一整行，应当恰好包含一个 JSON 响应。
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        // response 是解析后的协议消息，包含 id 以及 result 或 error。
        const response = JSON.parse(line);
        // waiter 是该响应 id 对应的待完成请求；不存在时忽略此响应。
        const waiter = this.pending.get(response.id);
        if (!waiter) return;
        // 已收到响应，无需再保留超时任务或待处理映射。
        clearTimeout(waiter.timer);
        this.pending.delete(response.id);
        if (response.error) waiter.reject(new Error(response.error));
        else waiter.resolve(response.result);
      } catch {
        this.fail(new Error(`Trace worker 返回了无效 JSON：${line}`));
      }
    });
  }

  /** error 是本次客户端故障；使所有等待中的请求失败，避免 Promise 一直挂起。 */
  private fail(error: Error) {
    this.failure = error;
    // waiter 是每个尚未完成请求的回调和计时器。
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  /**
   * T 是调用方预期的返回类型，仅提供 TS 静态检查，不做运行时数据校验。
   * method 是 worker 支持的方法名；args 是该方法的 JSON 参数对象。
   */
  private call<T>(method: string, args: object = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    // id 唯一标识本次请求，Python 会将它原样带回响应。
    const id = ++this.sequence;
    // resolve 把结果交给 await 调用方；reject 把异常交给调用方。
    return new Promise<T>((resolve, reject) => {
      // timer 在 400 秒后使客户端失败并终止 worker，限制整体等待时间。
      const timer = setTimeout(() => {
        this.fail(new Error(`Trace ${method} 超时，请检查 Ollama 服务`));
        this.child.kill();
      }, 400_000);
      // value 是通用响应值，转为调用方预期的 T；保存回调供接收响应时使用。
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      // 每条消息以换行结束，Python 才能用逐行读取的方式识别请求边界。
      this.child.stdin.write(JSON.stringify({ id, method, args }) + "\n");
    });
  }

  /** options 包含模型与参数配置，在 Python 中创建可训练参数及优化器。 */
  init(options: {
    /** 是否使用真实 Ollama 模型，否则使用教学假模型。 */
    ollama: boolean;
    /** Ollama 模型名称。 */
    model: string;
    /** Ollama 服务的基础地址。 */
    baseUrl: string;
    /** 可训练费率的起始值。 */
    initialRate: number;
  }) {
    return this.call<{ rate: number }>("init", options);
  }
  /** weight 是公斤数；返回报价及对应原始 Trace Node 的句柄。 */
  act(weight: number) { return this.call<Quote>("act", { weight }); }
  /** handle 标识要反馈的原始输出；feedback 是评估器生成的自然语言反馈。 */
  optimize(handle: string, feedback: string) {
    return this.call<Snapshot>("optimize", { handle, feedback });
  }
  /** 获取 Python 侧当前费率与全部优化日志，不更新参数。 */
  inspect() { return this.call<Snapshot>("inspect"); }
  /** 关闭请求流并终止本次运行的 worker；其中保存的 Trace 句柄随之失效。 */
  close() { this.child.stdin.end(); this.child.kill(); }
}
