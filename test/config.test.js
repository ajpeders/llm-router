"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { loadConfig } = require("../src/config");

const B = '{"luna":"http://100.84.247.20:11434","mac":"http://192.168.0.47:11434"}';

test("defaults match the spec", () => {
  const c = loadConfig({ BACKENDS_JSON: B });
  assert.deepStrictEqual(c.backends, { luna: "http://100.84.247.20:11434", mac: "http://192.168.0.47:11434" });
  assert.strictEqual(c.pollMs, 10000);
  assert.strictEqual(c.downAfterFails, 3);
  assert.strictEqual(c.firstByteTimeoutMs, 120000);
  assert.strictEqual(c.idleTimeoutMs, 60000);
  assert.strictEqual(c.idleWindowMs, 120000);
  assert.strictEqual(c.batchTimeoutMs, 30 * 60000);
  assert.strictEqual(c.nonStreamTimeoutMs, 30 * 60000);
  assert.strictEqual(c.oldestOverrideMs, 30 * 60000);
  assert.strictEqual(c.drainMaxMs, 10 * 60000);
  assert.deepStrictEqual(c.retryDelaysMs, [30000, 120000, 600000]);
  assert.strictEqual(c.batchHoldoffMs, 10 * 60000);
  assert.deepStrictEqual(c.backgroundSources, ["kanban", "cron"]);
  assert.deepStrictEqual(loadConfig({ BACKENDS_JSON: B, BACKGROUND_SOURCES: " a, b ,," }).backgroundSources, ["a", "b"]);
  assert.deepStrictEqual(loadConfig({ BACKENDS_JSON: B, BACKGROUND_SOURCES: "" }).backgroundSources, []);
  assert.strictEqual(c.doneRetentionMs, 7 * 86400000);
  assert.strictEqual(c.dbPath, "/data/jobs.db");
});

test("env overrides ints", () => {
  assert.strictEqual(loadConfig({ BACKENDS_JSON: B, POLL_MS: "500" }).pollMs, 500);
  assert.strictEqual(loadConfig({ BACKENDS_JSON: B, IDLE_WINDOW_MS: "50" }).idleWindowMs, 50);
  assert.strictEqual(loadConfig({ BACKENDS_JSON: B, NONSTREAM_TIMEOUT_MS: "9000" }).nonStreamTimeoutMs, 9000);
});

test("rejects bad backends", () => {
  assert.throws(() => loadConfig({}), /no backends/);
  assert.throws(() => loadConfig({ BACKENDS_JSON: "{" }), /not valid JSON/);
  assert.throws(() => loadConfig({ BACKENDS_JSON: '{"x":"ftp://a"}' }), /backend x/);
});
