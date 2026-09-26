"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { chooseModel, Drainer, makeRunJob } = require("../src/drain");
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

  // Track loads independently of pool.backends.*.loaded: since the pool.acquire fix,
  // the pool itself now marks `loaded` as the just-acquired model on every acquire
  // (a swap is in progress on any backend that didn't already report it loaded), so
  // reading b.loaded here would always see the model we're about to run.
  const loads = [];
  let currentlyLoaded = null;
  const runJob = async (job) => {
    if (currentlyLoaded !== job.model) { loads.push(job.model); currentlyLoaded = job.model; }
    await new Promise((r) => setTimeout(r, 5));
    return { ok: job.model };
  };
  const d = new Drainer({ queue, leaser, pool, cfg, runJob, onFinished: async () => {}, now: () => 1 });
  for (let i = 0; i < 20 && queue.counts().done < 6; i++) { d.tick(); await d.idle(); }
  assert.deepStrictEqual(loads, ["A", "B"]);
  assert.strictEqual(queue.counts().done, 6);
});

test("single-slot model is never batch-servable; other models still drain", async () => {
  const pool = new Pool(["luna"], 2);
  pool.applyPoll("luna", { models: ["A", "B"], loaded: ["A", "B"], slots: { A: 1, B: 3 } });
  const leaser = new Leaser(pool);
  const queue = new Queue(":memory:");
  queue.submit({ model: "A", request: {} }, 0);
  queue.submit({ model: "A", request: {} }, 0);
  queue.submit({ model: "A", request: {} }, 0);
  queue.submit({ model: "B", request: {} }, 0);
  const d = new Drainer({ queue, leaser, pool, cfg, runJob: async () => ({}), onFinished: async () => {}, now: () => 1 });
  for (let i = 0; i < 5; i++) { d.tick(); await d.idle(); }
  assert.strictEqual(queue.counts().done, 1, "B's job must complete");
  assert.strictEqual(queue.counts().pending, 3, "A's jobs stay pending forever — 1 slot leaves no batch capacity");
});

// interactiveWaiting is a GLOBAL pause, not a per-model capacity check: an interactive
// waiter for model B must block draining of model A even though A has plenty of its
// own free capacity. (A saturated single-model scenario can't distinguish this, because
// the shared per-model inflight counter already denies batch capacity whenever that
// same model's interactive lane is saturated enough to queue a waiter.)
test("pauses globally while any interactive request waits, resumes once clear", async () => {
  const pool = new Pool(["luna"], 2);
  pool.applyPoll("luna", { models: ["A", "B"], loaded: ["A", "B"], slots: { A: 3, B: 1 } });
  const leaser = new Leaser(pool);
  const queue = new Queue(":memory:");
  queue.submit({ model: "A", request: {} }, 0);

  const h1 = leaser.tryAcquire("B", "interactive");
  assert.ok(h1);
  const waiting = leaser.acquire("B", "interactive", 1000); // B's only slot is held; this queues

  const d = new Drainer({ queue, leaser, pool, cfg, runJob: async () => ({}), onFinished: async () => {}, now: () => 1 });
  d.tick();
  assert.strictEqual(queue.counts().pending, 1, "tick must not claim A's job while B has an interactive waiter");
  assert.strictEqual(leaser.interactiveWaiting, true);

  leaser.release("luna", "B"); // frees B's slot; the waiting interactive request is served
  const gotBackend = await waiting;
  assert.strictEqual(gotBackend, "luna");
  assert.strictEqual(leaser.interactiveWaiting, false);

  d.tick();
  await d.idle();
  assert.strictEqual(queue.counts().done, 1, "tick claims A's job once the waiter queue is empty");
});

// A batch reply is non-streaming: the backend sends nothing at all until it has the
// whole answer, so the *first byte* timeout is the real total cap for a batch job.
// makeRunJob must use cfg.batchTimeoutMs for that, not the interactive-lane
// firstByteTimeoutMs — otherwise a batch job dies at 120s while the reviewer's
// intended 120s cap for the *interactive* lane doesn't get a full 30 minutes on batch.
test("makeRunJob uses batchTimeoutMs, not firstByteTimeoutMs, as the total cap", async () => {
  const up = http.createServer(() => {}); // never responds
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${up.address().port}`;
  try {
    const runJob = makeRunJob({ backends: { luna: baseUrl }, firstByteTimeoutMs: 5000, idleTimeoutMs: 5000, batchTimeoutMs: 30 });
    const start = Date.now();
    await assert.rejects(runJob({ model: "m", request: { messages: [] } }, "luna"), /upstream_timeout/);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `should time out at batchTimeoutMs (30ms), not sit until firstByteTimeoutMs (5000ms); took ${elapsed}ms`);
  } finally {
    up.closeAllConnections();
    up.close();
  }
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

test("onFinished throwing does not crash the process; job stays done, slot released", async () => {
  const pool = new Pool(["luna"], 2);
  pool.applyPoll("luna", { models: ["A"], loaded: ["A"], slots: { A: 2 } });
  const leaser = new Leaser(pool);
  const queue = new Queue(":memory:");
  const id = queue.submit({ model: "A", request: {} }, 0).id;

  let unhandled = null;
  const onUnhandledRejection = (err) => { unhandled = err; };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const d = new Drainer({
      queue, leaser, pool, cfg,
      runJob: async () => ({ ok: true }),
      onFinished: async () => { throw new Error("ntfy blip"); },
      now: () => 1,
    });
    d.tick();
    await d.idle();
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }

  assert.strictEqual(unhandled, null, "a throwing onFinished must not produce an unhandled rejection");
  assert.strictEqual(queue.get(id).status, "done");
  assert.strictEqual(pool.totalInflight(pool.backends.get("luna")), 0);
});
