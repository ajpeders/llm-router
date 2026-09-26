"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { chooseModel, Drainer } = require("../src/drain");
const { Queue } = require("../src/queue");
const { Pool } = require("../src/pool");
const { Leaser } = require("../src/lease");

const cfg = { oldestOverrideMs: 30 * 60000, drainMaxMs: 10 * 60000, retryDelaysMs: [0, 0, 0] };

test("chooseModel: most pending, stale overrides", () => {
  const p = [{ model: "a", count: 1, oldest: 0 }, { model: "b", count: 5, oldest: 100 }];
  assert.strictEqual(chooseModel(p, 1000, 30 * 60000), "b");
  assert.strictEqual(chooseModel(p, 30 * 60000 + 1, 30 * 60000), "a");
  assert.strictEqual(chooseModel([], 0, 1), null);
});

// One llama-swap backend holding one model at a time: interleaved submits for two big
// models must produce exactly two loads, not four.
test("interleaved jobs for two models load each model once", async () => {
  const pool = new Pool(["luna"], 2);
  pool.applyPoll("luna", { models: ["A", "B"], loaded: [], slots: { A: 3, B: 3 } });
  const leaser = new Leaser(pool);
  const queue = new Queue(":memory:");
  for (const m of ["A", "B", "A", "B", "A", "B"]) queue.submit({ model: m, request: { messages: [] } }, 0);

  const loads = [];
  const runJob = async (job, backend) => {
    const b = pool.backends.get(backend);
    if (!b.loaded.has(job.model)) { loads.push(job.model); b.loaded = new Set([job.model]); }
    await new Promise((r) => setTimeout(r, 5));
    return { ok: job.model };
  };
  const d = new Drainer({ queue, leaser, pool, cfg, runJob, onFinished: async () => {}, now: () => 1 });
  for (let i = 0; i < 20 && queue.counts().done < 6; i++) { d.tick(); await d.idle(); }
  assert.deepStrictEqual(loads, ["A", "B"]);
  assert.strictEqual(queue.counts().done, 6);
});

test("pauses while an interactive request waits", async () => {
  const pool = new Pool(["luna"], 2);
  pool.applyPoll("luna", { models: ["A"], loaded: ["A"], slots: { A: 1 } });
  const leaser = new Leaser(pool);
  leaser.tryAcquire("A", "interactive");
  const waiting = leaser.acquire("A", "interactive", 1000);
  const queue = new Queue(":memory:");
  queue.submit({ model: "A", request: {} }, 0);
  const d = new Drainer({ queue, leaser, pool, cfg, runJob: async () => ({}), onFinished: async () => {}, now: () => 1 });
  d.tick();
  assert.strictEqual(queue.counts().pending, 1);
  leaser.release("luna", "A");
  await waiting;
});

test("failures retry, then dead fires onFinished", async () => {
  const pool = new Pool(["luna"], 2);
  pool.applyPoll("luna", { models: ["A"], loaded: ["A"], slots: { A: 2 } });
  const queue = new Queue(":memory:");
  const id = queue.submit({ model: "A", request: {} }, 0).id;
  const finished = [];
  const d = new Drainer({
    queue, leaser: new Leaser(pool), pool, cfg,
    runJob: async () => { throw new Error("boom"); },
    onFinished: async (job) => finished.push(job.status),
    now: () => 1,
  });
  for (let i = 0; i < 6; i++) { d.tick(); await d.idle(); }
  assert.strictEqual(queue.get(id).status, "dead");
  assert.deepStrictEqual(finished, ["dead"]);
});
