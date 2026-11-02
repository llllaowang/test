"""JSON Lines 桥：Trace 对象始终留在 Python，TS 只传句柄与普通 JSON。"""
import contextlib
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
# 复用前一个教学例子的模型适配器，不重复实现 Ollama 调用。
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
with contextlib.redirect_stdout(sys.stderr):
    from demo import OllamaModel, TeachingModel
    from opto.trace import node
    from opto.optimizers import OptoPrime


def main():
    rate = None
    optimizer = None
    outputs = {}
    sequence = 0
    for line in sys.stdin:
        request = json.loads(line)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                method, args = request["method"], request.get("args", {})
                if method == "init":
                    rate = node(args.get("initialRate", 1), trainable=True)
                    model = (OllamaModel(args["model"], args["baseUrl"])
                             if args["ollama"] else TeachingModel())
                    optimizer = OptoPrime([rate], llm=model)
                    outputs.clear()
                    result = {"rate": rate.data}
                elif method == "act":
                    quote = rate * args["weight"] + 5
                    sequence += 1
                    # 句柄指向原始 Node，不能把数值重新包装成 Node。
                    outputs.clear()
                    outputs[str(sequence)] = quote
                    result = {"handle": str(sequence), "value": quote.data, "rate": rate.data}
                elif method == "optimize":
                    optimizer.zero_feedback()
                    optimizer.backward(outputs[args["handle"]], args["feedback"])
                    optimizer.step()
                    result = {"rate": rate.data, "log": optimizer.log[-1:]}
                elif method == "inspect":
                    result = {"rate": rate.data, "log": optimizer.log}
                else:
                    raise ValueError(f"Unknown method: {method}")
            response = {"id": request["id"], "result": result}
        except Exception as error:
            response = {"id": request["id"], "error": f"{type(error).__name__}: {error}"}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
