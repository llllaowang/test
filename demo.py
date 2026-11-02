"""LangGraph 管流程，Microsoft Trace 管反馈传播和参数更新。"""
import argparse
import json
import os
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any, TypedDict
from urllib.request import Request, urlopen

# 禁止 LiteLLM 在导入时下载价格表；离线模式不发起模型调用。
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")

from langgraph.graph import END, START, StateGraph
from opto.trace import node
from opto.optimizers import OptoPrime


class State(TypedDict, total=False):
    weight: int
    expected: int
    attempt: int
    quote: Any  # 保留 Trace Node，不能在节点之间只传 .data！
    passed: bool
    feedback: str
    history: list[dict]


class TeachingModel:
    """可重复的假模型：按反馈解方程，只用于演示 OptoPrime 接口。

    没有语言理解能力，也不是 Trace 自己学会了数学。
    真正的 Trace 计算图、backward 和 step 仍然照常运行。
    """
    def __call__(self, *, messages, **kwargs):
        prompt = messages[-1]["content"]
        variables = prompt.split("#Variables", 1)[1].split("#Constraints", 1)[0]
        name = re.search(r"\(int\)\s+(\w+)\s*=", variables).group(1)
        feedback = prompt.split("#Feedback", 1)[1]
        weight, expected = map(int, re.search(r"weight=(\d+); expected=(\d+)", feedback).groups())
        rate = (expected - 5) // weight
        content = json.dumps({"reasoning": "教学规则：由反馈计算每公斤费用。",
                              "suggestion": {name: rate}})
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


class OllamaModel:
    """把 Ollama 原生 /api/chat 响应适配为 OptoPrime 接口。"""
    def __init__(self, model="qwen3.5:9b", base_url="http://localhost:11434"):
        self.model = model
        self.base_url = base_url.rstrip("/")

    def __call__(self, *, messages, max_tokens=2048, **kwargs):
        payload = {"model": self.model, "messages": messages, "stream": False,
                   "format": "json", "think": False,
                   "options": {"temperature": 0, "num_predict": max_tokens}}
        request = Request(self.base_url + "/api/chat",
                          data=json.dumps(payload).encode("utf-8"),
                          headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=180) as response:
            result = json.load(response)
        content = result["message"]["content"]
        if not content.strip():
            raise ValueError("Ollama 返回空内容，请检查模型或生成长度")
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


def build_graph(*, live=False, max_attempts=3, llm=None):
    if max_attempts < 1:
        raise ValueError("max_attempts 必须至少为 1")
    # 这是长期可优化的策略参数，不是每次请求的临时状态。
    rate = node(1, trainable=True)
    optimizer = OptoPrime([rate], **({} if live and llm is None else
                                   {"llm": llm if llm is not None else TeachingModel()}))

    def act(state: State):
        # Trace 的运算符生成依赖链：rate → 乘法 → 加法 → quote。
        quote = rate * state["weight"] + 5
        return {"quote": quote, "attempt": state.get("attempt", 0) + 1}

    def evaluate(state: State):
        actual = state["quote"].data
        passed = actual == state["expected"]
        feedback = (f"Shipping quote incorrect. weight={state['weight']}; "
                    f"expected={state['expected']}; actual={actual}. "
                    "Formula: quote = rate * weight + 5. Change only rate, an integer. "
                    "Infer a reusable per-kg rate, not a hardcoded quote.")
        row = {"attempt": state["attempt"], "rate": rate.data,
               "quote": actual, "passed": passed}
        return {"passed": passed, "feedback": "Correct" if passed else feedback,
                "history": state.get("history", []) + [row]}

    def optimize(state: State):
        optimizer.zero_feedback()
        # 从输出 Node 反向传播，自然语言反馈到达 trainable rate。
        optimizer.backward(state["quote"], state["feedback"])
        optimizer.step()  # OptoPrime 请求模型建议，再更新 rate。
        return {}

    def route(state: State):
        if state["passed"] or state["attempt"] >= max_attempts:
            return "end"
        return "optimize"

    graph = StateGraph(State)
    graph.add_node("act", act)
    graph.add_node("evaluate", evaluate)
    graph.add_node("optimize", optimize)
    graph.add_edge(START, "act")
    graph.add_edge("act", "evaluate")
    graph.add_conditional_edges("evaluate", route, {"end": END, "optimize": "optimize"})
    graph.add_edge("optimize", "act")
    return graph.compile(), rate, optimizer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--live", action="store_true", help="通过 LiteLLM 调用配置的服务")
    mode.add_argument("--ollama", action="store_true", help="调用本地 Ollama，无需 API Key")
    parser.add_argument("--model", default="qwen3.5:9b", help="Ollama 模型名")
    parser.add_argument("--base-url", default="http://localhost:11434", help="Ollama 地址")
    parser.add_argument("--max-attempts", type=int, default=3)
    args = parser.parse_args()
    if args.live and not os.environ.get("TRACE_LITELLM_MODEL"):
        parser.error("真实模式请先设置 TRACE_LITELLM_MODEL 及对应服务的 API Key")
    if args.max_attempts < 1:
        parser.error("--max-attempts 必须至少为 1")
    graph, rate, optimizer = build_graph(live=args.live, max_attempts=args.max_attempts,
        llm=OllamaModel(args.model, args.base_url) if args.ollama else None)
    mode_name = "ollama" if args.ollama else "live" if args.live else "mock"
    print(f"模式：{mode_name}" + (f" / {args.model}" if args.ollama else ""), flush=True)
    final = graph.invoke({"weight": 2, "expected": 11, "history": []},
                         config={"recursion_limit": args.max_attempts * 3 + 5})
    for row in final["history"]:
        print(f"第 {row['attempt']} 轮：rate={row['rate']}，报价={row['quote']}，通过={row['passed']}")
    # 在没有参与优化的新重量上检查是否学到了通用费率。
    holdout = rate * 4 + 5
    print(f"新样例：4kg 报价={holdout.data}，期望=17")
    print("结束：" + ("成功" if final["passed"] else "达到重试上限，尚未成功"))
    output = Path("artifacts")
    output.mkdir(exist_ok=True)
    (output / "graph.mmd").write_text(graph.get_graph().draw_mermaid(), encoding="utf-8")
    (output / "run.json").write_text(json.dumps({"mode": mode_name,
        "history": final["history"], "final_rate": rate.data,
        "holdout_passed": holdout.data == 17}, ensure_ascii=False, indent=2), encoding="utf-8")
    # 查看 OptoPrime 实际收到的计算图、反馈和模型返回。
    (output / "optimizer.json").write_text(json.dumps(optimizer.log, ensure_ascii=False,
        indent=2), encoding="utf-8")
    print("学习记录已保存至 artifacts/")


if __name__ == "__main__":
    main()
