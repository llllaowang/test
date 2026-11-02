"""验证计算依赖跨 LangGraph 节点保留，以及循环正确结束。"""
import unittest

from demo import build_graph


class DemoTests(unittest.TestCase):
    def test_feedback_updates_parameter_and_generalizes(self):
        graph, rate, optimizer = build_graph()
        result = graph.invoke({"weight": 2, "expected": 11})
        self.assertTrue(result["passed"])
        self.assertEqual([row["quote"] for row in result["history"]], [7, 11])
        self.assertEqual(rate.data, 3)
        self.assertEqual((rate * 4 + 5).data, 17)
        self.assertEqual(len(optimizer.log), 1)

    def test_attempt_limit_does_not_update_unvalidated_parameter(self):
        graph, rate, optimizer = build_graph(max_attempts=1)
        result = graph.invoke({"weight": 2, "expected": 11})
        self.assertFalse(result["passed"])
        self.assertEqual(result["attempt"], 1)
        self.assertEqual(rate.data, 1)
        self.assertEqual(optimizer.log, [])

    def test_already_correct_does_not_optimize(self):
        graph, rate, optimizer = build_graph()
        result = graph.invoke({"weight": 2, "expected": 7})
        self.assertTrue(result["passed"])
        self.assertEqual(result["attempt"], 1)
        self.assertEqual(optimizer.log, [])


if __name__ == "__main__":
    unittest.main()
