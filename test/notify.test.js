"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { deliverCallback, alertDead } = require("../src/notify");

function recorder(fail = false) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); if (fail) throw new Error("down"); return { ok: true }; };
  return { calls, f };
}

const job = { id: "j1", model: "m", status: "dead", callback: "http://cb/x", error: "boom", attempts: 4 };

test("callback posts the job record", async () => {
  const r = recorder();
  await deliverCallback(job, r.f);
  assert.strictEqual(r.calls[0].url, "http://cb/x");
  assert.deepStrictEqual(JSON.parse(r.calls[0].init.body), job);
});

test("callback failure does not throw; missing callback is a no-op", async () => {
  await deliverCallback(job, recorder(true).f);
  const r = recorder();
  await deliverCallback({ ...job, callback: null }, r.f);
  assert.strictEqual(r.calls.length, 0);
});

test("dead alert goes to ntfy with token; skipped without url", async () => {
  const r = recorder();
  await alertDead(job, { ntfyUrl: "http://ntfy/homelab-alerts", ntfyToken: "tk" }, r.f);
  assert.strictEqual(r.calls[0].url, "http://ntfy/homelab-alerts");
  assert.strictEqual(r.calls[0].init.headers.Authorization, "Bearer tk");
  assert.match(r.calls[0].init.body, /j1/);
  const none = recorder();
  await alertDead(job, { ntfyUrl: "", ntfyToken: "" }, none.f);
  assert.strictEqual(none.calls.length, 0);
});
