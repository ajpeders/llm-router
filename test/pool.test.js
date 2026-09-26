"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { Pool } = require("../src/pool");
const { Leaser } = require("../src/lease");

test("polledOnce is set only by a successful poll, never by failures alone", () => {
  const p = new Pool(["luna"], 2);
  assert.strictEqual(p.polledOnce, false);
  for (let i = 0; i < 3; i++) p.applyFailure("luna", 3);
  assert.strictEqual(p.backends.get("luna").up, false);
  assert.strictEqual(p.polledOnce, false, "repeated failures alone must not set polledOnce");
  p.applyPoll("luna", { models: ["m"], loaded: ["m"], slots: { m: 2 } });
  assert.strictEqual(p.polledOnce, true);
});

test("acquire marks a swap in progress: loaded becomes just the newly acquired model", () => {
  const p = new Pool(["luna"], 2);
  p.applyPoll("luna", { models: ["A", "B"], loaded: ["A"], slots: { A: 2, B: 2 } });
  p.acquire("luna", "B");
  assert.deepStrictEqual([...p.backends.get("luna").loaded], ["B"]);
});

test("acquire on an already-loaded model leaves loaded untouched", () => {
  const p = new Pool(["luna"], 2);
  p.applyPoll("luna", { models: ["A"], loaded: ["A"], slots: { A: 2 } });
  p.acquire("luna", "A");
  assert.deepStrictEqual([...p.backends.get("luna").loaded], ["A"]);
});

test("acquire on a backend with loaded=null (Ollama) leaves it null", () => {
  const p = new Pool(["ollama"], 2);
  p.applyPoll("ollama", { models: ["m"], loaded: null, slots: {} });
  p.acquire("ollama", "m");
  assert.strictEqual(p.backends.get("ollama").loaded, null);
});

// Regression for the reviewer's probed sequence: a batch job for A is in flight on the
// only backend that serves both A and B; an interactive B waiter is queued because B
// isn't the resident model; A releases and the B waiter takes the backend, which starts
// a swap. Without marking `loaded` as {B} immediately, the drainer's next tryAcquire for
// A still sees stale loaded=[A] and both A and B look runnable at once, even though
// llama-swap can only serve one resident model on this backend at a time.
test("swap on acquire prevents a second model from being sent mid-swap", async () => {
  const pool = new Pool(["luna"], 2);
  pool.applyPoll("luna", { models: ["A", "B"], loaded: ["A"], slots: { A: 2, B: 2 } });
  const leaser = new Leaser(pool);

  const aBackend = leaser.tryAcquire("A", "batch"); // batch A in flight
  assert.strictEqual(aBackend, "luna");

  const bWaiting = leaser.acquire("B", "interactive", 1000); // B queues: not loaded, backend busy
  assert.strictEqual(leaser.interactiveWaiting, true);

  leaser.release("luna", "A"); // A releases; the queued B waiter is served next
  assert.strictEqual(await bWaiting, "luna");
  assert.deepStrictEqual([...pool.backends.get("luna").loaded], ["B"]);

  // The drainer's next attempt to acquire A for batch must wait, not proceed — A is no
  // longer the resident model on the only backend that serves it.
  assert.strictEqual(leaser.tryAcquire("A", "batch"), null);

  // An interactive A request must also wait, for the same reason.
  let settled = false;
  const aInteractive = leaser.acquire("A", "interactive", 50).then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(settled, false, "interactive A must still be waiting, not resolved/rejected");
  await aInteractive;
});
