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
  assert.strictEqual((await post(`${s.base}/jobs`, { model: "m", request: {}, callback: "ftp://x" })).status, 400);
  assert.strictEqual((await post(`${s.base}/jobs`, { model: "m", request: {}, dedupe_key: 5 })).status, 400);
  const st = await (await fetch(`${s.base}/status`)).json();
  assert.strictEqual(st.queue.counts.pending, 1);
  assert.deepStrictEqual((await (await fetch(`${s.base}/v1/models`)).json()).data.map((m) => m.id), ["m"]);
  assert.strictEqual((await fetch(`${s.base}/api/tags`)).status, 404);
  s.close();
});

test("known model with a down backend is 503, not 404; never-seen model is 404; pre-poll is 503", async () => {
  const cfg = { backends: { luna: "http://127.0.0.1:1" }, waitTimeoutMs: 50, firstByteTimeoutMs: 1000, idleTimeoutMs: 1000 };
  const pool = new Pool(["luna"], 2);
  const leaser = new Leaser(pool);
  const queue = new Queue(":memory:");
  const server = createServer({ cfg, pool, leaser, queue, drainer: { current: null }, now: () => 1000 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Before the first poll, polledOnce is false: anything must be 503, not 404 — the
  // model could well exist, we just haven't asked any backend yet.
  const preFirstPoll = await post(`${base}/v1/chat/completions`, { model: "m" });
  assert.strictEqual(preFirstPoll.status, 503);
  assert.deepStrictEqual(await preFirstPoll.json(), { error: "backend_down", model: "m" });

  // Now poll once (model "m" seen), then take the backend down.
  pool.applyPoll("luna", { models: ["m"], loaded: ["m"], slots: { m: 2 } });
  for (let i = 0; i < 3; i++) pool.applyFailure("luna", 3);
  assert.strictEqual(pool.backends.get("luna").up, false);

  const seenButDown = await post(`${base}/v1/chat/completions`, { model: "m" });
  assert.strictEqual(seenButDown.status, 503);
  assert.deepStrictEqual(await seenButDown.json(), { error: "backend_down", model: "m" });

  const neverSeen = await post(`${base}/v1/chat/completions`, { model: "nope" });
  assert.strictEqual(neverSeen.status, 404);
  assert.deepStrictEqual(await neverSeen.json(), { error: "unknown_model", model: "nope" });

  server.close();
});

test("/health and /api/models/all carry tier for the CLIs", async () => {
  const s = await setup();
  const health = await (await fetch(`${s.base}/health`)).json();
  assert.deepStrictEqual(health.tier, ["luna"]);
  const all = await (await fetch(`${s.base}/api/models/all`)).json();
  assert.deepStrictEqual(all.tier, ["luna"]);
  s.close();
});

test("client aborts while waiting for a slot: slot isn't leaked, upstream never sees it", async () => {
  let backendHits = 0;
  const backend = http.createServer((req, res) => {
    backendHits += 1;
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ served: JSON.parse(b).model }));
    });
  });
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  const cfg = { backends: { luna: `http://127.0.0.1:${backend.address().port}` }, waitTimeoutMs: 5000, firstByteTimeoutMs: 1000, idleTimeoutMs: 1000 };
  const pool = new Pool(["luna"], 1);
  pool.applyPoll("luna", { models: ["m"], loaded: ["m"], slots: { m: 1 } });
  const leaser = new Leaser(pool);
  const queue = new Queue(":memory:");
  const server = createServer({ cfg, pool, leaser, queue, drainer: { current: null }, now: () => 1000 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Fill the only slot directly, bypassing HTTP, so the second request is forced to wait.
  const heldBackend = await leaser.acquire("m", "interactive", 1000);
  assert.strictEqual(pool.inflight(pool.backends.get("luna"), "m"), 1);

  // Second request queues on the leaser (no free slot). Abort the client mid-wait.
  const url = new URL(`${base}/v1/chat/completions`);
  const req2 = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json" } });
  req2.on("error", () => {}); // expected: destroy() below aborts this connection
  req2.end(JSON.stringify({ model: "m" }));
  await new Promise((r) => setTimeout(r, 50));
  req2.destroy();
  await new Promise((r) => setTimeout(r, 50));

  // Free the held slot: the queued (but now-aborted) waiter is served next and must
  // release immediately instead of reaching the backend.
  leaser.release(heldBackend, "m");
  await new Promise((r) => setTimeout(r, 100));

  assert.strictEqual(pool.inflight(pool.backends.get("luna"), "m"), 0);
  assert.strictEqual(backendHits, 0);

  server.close();
  backend.close();
});

test("a malformed request target (\"//\") is handled, not an unhandled rejection", async () => {
  const s = await setup();
  const url = new URL(s.base);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: "//", method: "GET" }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
  assert.ok([400, 404, 500].includes(status));
  assert.strictEqual((await fetch(`${s.base}/health`)).status, 200);
  s.close();
});
