"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { createServer } = require("../src/server");
const { Pool } = require("../src/pool");
const { Leaser } = require("../src/lease");
const { Queue } = require("../src/queue");

async function setup() {
  const backend = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ served: JSON.parse(b).model }));
    });
  });
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  const cfg = { backends: { luna: `http://127.0.0.1:${backend.address().port}` }, waitTimeoutMs: 200, firstByteTimeoutMs: 1000, idleTimeoutMs: 1000 };
  const pool = new Pool(["luna"], 2);
  pool.applyPoll("luna", { models: ["m"], loaded: ["m"], slots: { m: 2 } });
  const leaser = new Leaser(pool);
  const queue = new Queue(":memory:");
  const server = createServer({ cfg, pool, leaser, queue, drainer: { current: null }, now: () => 1000 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, pool, close: () => { server.close(); backend.close(); } };
}

const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("interactive proxy routes by model and releases the slot", async () => {
  const s = await setup();
  const r = await post(`${s.base}/v1/chat/completions`, { model: "m", messages: [] });
  assert.deepStrictEqual(await r.json(), { served: "m" });
  assert.strictEqual(s.pool.inflight(s.pool.backends.get("luna"), "m"), 0);
  assert.strictEqual((await post(`${s.base}/v1/chat/completions`, { model: "zzz" })).status, 404);
  assert.strictEqual((await post(`${s.base}/v1/chat/completions`, {})).status, 400);
  s.close();
});

test("jobs API and status", async () => {
  const s = await setup();
  const r = await post(`${s.base}/jobs`, { model: "m", request: { messages: [] }, dedupe_key: "x" });
  assert.strictEqual(r.status, 202);
  const { id } = await r.json();
  assert.strictEqual((await (await fetch(`${s.base}/jobs/${id}`)).json()).status, "pending");
  assert.strictEqual((await fetch(`${s.base}/jobs/nope`)).status, 404);
  assert.strictEqual((await post(`${s.base}/jobs`, { model: "m" })).status, 400);
  const st = await (await fetch(`${s.base}/status`)).json();
  assert.strictEqual(st.queue.counts.pending, 1);
  assert.deepStrictEqual((await (await fetch(`${s.base}/v1/models`)).json()).data.map((m) => m.id), ["m"]);
  assert.strictEqual((await fetch(`${s.base}/api/tags`)).status, 404);
  s.close();
});
