// projects/llm-router/test/idle.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const { createIdleTracker } = require("../src/idle");

test("idle when no in-flight and quiet window elapsed", () => {
  const t = createIdleTracker(1000);
  t.markActivity(0);
  const s = t.snapshot(2000); // 2000ms later > 1000ms window
  assert.strictEqual(s.idle, true);
  assert.strictEqual(s.inFlight, 0);
  assert.strictEqual(s.quietWindowMs, 1000);
});

test("not idle while a request is in flight", () => {
  const t = createIdleTracker(1000);
  t.markActivity(0);
  t.begin();
  assert.strictEqual(t.snapshot(5000).idle, false);
  t.end();
  assert.strictEqual(t.snapshot(5000).idle, true);
});

test("not idle inside the quiet window", () => {
  const t = createIdleTracker(1000);
  t.markActivity(0);
  assert.strictEqual(t.snapshot(500).idle, false); // 500ms < 1000ms
});

test("end() floors in-flight at zero", () => {
  const t = createIdleTracker(1000);
  t.end();
  t.end();
  assert.strictEqual(t.snapshot(9999).inFlight, 0);
});
