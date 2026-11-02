import test from "node:test";
import assert from "node:assert/strict";
import { runDemo } from "./demo.js";

test("真实 Trace 跨 TS/Python 桥传播反馈并更新参数", async () => {
  const result = await runDemo();
  assert.deepEqual(result.history.map((row) => row.quote), [7, 11]);
  assert.equal(result.finalRate, 3);
  assert.equal(result.passed, true);
  assert.equal(result.holdout.passed, true);
  assert.equal(result.optimizerLog.length, 1);
});

test("达到尝试上限时不再优化", async () => {
  const result = await runDemo({ maxAttempts: 1 });
  assert.equal(result.passed, false);
  assert.equal(result.history.length, 1);
  assert.equal(result.finalRate, 1);
  assert.equal(result.optimizerLog.length, 0);
});

test("初始参数正确则直接结束", async () => {
  const result = await runDemo({ initialRate: 3 });
  assert.equal(result.passed, true);
  assert.equal(result.history.length, 1);
  assert.equal(result.optimizerLog.length, 0);
});

test("非法尝试上限在创建 worker 前被拒绝", async () => {
  await assert.rejects(runDemo({ maxAttempts: 0 }), /maxAttempts/);
});
