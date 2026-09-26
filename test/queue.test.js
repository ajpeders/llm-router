"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { Queue } = require("../src/queue");

const req = { messages: [{ role: "user", content: "hi" }] };
const D = [30000, 120000, 600000];

test("submit, claim by priority then age, complete", () => {
  const q = new Queue(":memory:");
  const a = q.submit({ model: "m", request: req }, 1).id;
  const b = q.submit({ model: "m", request: req, priority: 5 }, 2).id;
  assert.strictEqual(q.claim("m", 10).id, b);
  assert.strictEqual(q.claim("m", 10).id, a);
  assert.strictEqual(q.claim("m", 10), null);
  q.complete(a, { ok: 1 }, 11);
  const j = q.get(a);
  assert.strictEqual(j.status, "done");
  assert.deepStrictEqual(j.result, { ok: 1 });
  assert.deepStrictEqual(j.request, req);
  assert.strictEqual(j.attempts, 1);
});

test("dedupe returns the pending job", () => {
  const q = new Queue(":memory:");
  const first = q.submit({ model: "m", request: req, dedupe_key: "k" }, 1);
  const again = q.submit({ model: "m", request: req, dedupe_key: "k" }, 2);
  assert.deepStrictEqual(again, { id: first.id, deduped: true });
  q.complete(q.claim("m", 3).id, {}, 3);
  assert.strictEqual(q.submit({ model: "m", request: req, dedupe_key: "k" }, 4).deduped, false);
});

test("fail backs off 3 times then dead", () => {
  const q = new Queue(":memory:");
  const id = q.submit({ model: "m", request: req }, 0).id;
  let now = 0;
  for (const delay of D) {
    q.claim("m", now);
    assert.strictEqual(q.fail(id, "boom", now, D), "pending");
    assert.strictEqual(q.claim("m", now + delay - 1), null);
    now += delay;
  }
  q.claim("m", now);
  assert.strictEqual(q.fail(id, "boom", now, D), "dead");
  assert.strictEqual(q.get(id).attempts, 4);
});

test("pendingByModel, oldest age, recover, purge", () => {
  const q = new Queue(":memory:");
  q.submit({ model: "a", request: req }, 5);
  q.submit({ model: "a", request: req }, 7);
  q.submit({ model: "b", request: req }, 6);
  assert.deepStrictEqual(q.pendingByModel(10), [{ model: "a", count: 2, oldest: 5 }, { model: "b", count: 1, oldest: 6 }]);
  assert.strictEqual(q.oldestPendingAgeMs(10), 5);
  const j = q.claim("b", 10);
  assert.strictEqual(q.recoverRunning(11), 1);
  q.complete(q.claim("b", 12).id, {}, 12);
  assert.strictEqual(q.purge(12 + 100, 50), 1);
  assert.strictEqual(q.get(j.id), null);
  assert.deepStrictEqual(q.counts(), { pending: 2, running: 0, done: 0, dead: 0 });
});
