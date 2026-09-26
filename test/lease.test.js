"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { Pool } = require("../src/pool");
const { Leaser } = require("../src/lease");

function one(slots) {
  const p = new Pool(["a"], slots);
  p.applyPoll("a", { models: ["m"], loaded: ["m"], slots: { m: slots } });
  return p;
}

test("acquire resolves immediately when a slot is free", async () => {
  const l = new Leaser(one(2));
  assert.strictEqual(await l.acquire("m", "interactive", 1000), "a");
});

test("waiter is served on release, interactive before batch", async () => {
  const l = new Leaser(one(2));
  l.tryAcquire("m", "interactive");
  l.tryAcquire("m", "interactive"); // pool full
  const order = [];
  const batch = l.acquire("m", "batch", 1000).then(() => order.push("batch"));
  const inter = l.acquire("m", "interactive", 1000).then(() => order.push("interactive"));
  assert.strictEqual(l.interactiveWaiting, true);
  l.release("a", "m");
  await inter;
  assert.deepStrictEqual(order, ["interactive"]);
  l.release("a", "m");
  l.release("a", "m");
  await batch;
  assert.deepStrictEqual(order, ["interactive", "batch"]);
});

test("unknown model rejects no_backend; wait times out", async () => {
  const l = new Leaser(one(1));
  await assert.rejects(l.acquire("nope", "interactive", 1000), /no_backend/);
  l.tryAcquire("m", "interactive");
  await assert.rejects(l.acquire("m", "interactive", 20), /wait_timeout/);
  assert.strictEqual(l.interactiveWaiting, false);
});
