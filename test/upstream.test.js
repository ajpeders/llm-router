"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { proxyStream, callJson } = require("../src/upstream");

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, "127.0.0.1", () => resolve(s));
  });
}
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls a flag instead of awaiting a promise directly, so a test that would otherwise
// hang forever on a bug instead fails fast with a clear assertion.
async function waitUntil(fn, timeoutMs = 2000) {
  const start = Date.now();
  while (!fn() && Date.now() - start < timeoutMs) await sleep(10);
  return fn();
}

test("slow-but-steady stream longer than idle timeout survives", async () => {
  const up = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let n = 0;
    const t = setInterval(() => { res.write(`data: ${n}\n\n`); if (++n === 5) { clearInterval(t); res.end(); } }, 40);
  });
  const front = await listen(async (req, res) => {
    await proxyStream({ req, res, body: Buffer.alloc(0), baseUrl: urlOf(up), firstByteTimeoutMs: 1000, idleTimeoutMs: 100 });
  });
  const r = await fetch(`${urlOf(front)}/v1/chat/completions`);
  const text = await r.text();
  assert.strictEqual(r.status, 200);
  assert.match(text, /data: 4/); // total ~200ms > idle 100ms, still completes
  up.close(); front.close();
});

test("no first byte → 504", async () => {
  const up = await listen(() => {}); // never answers
  const front = await listen(async (req, res) => {
    await proxyStream({ req, res, body: Buffer.alloc(0), baseUrl: urlOf(up), firstByteTimeoutMs: 50, idleTimeoutMs: 50 });
  });
  const r = await fetch(`${urlOf(front)}/v1/x`);
  assert.strictEqual(r.status, 504);
  up.closeAllConnections(); up.close(); front.close();
});

test("callJson posts and parses", async () => {
  const up = await listen((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ echo: JSON.parse(b), path: req.url }));
    });
  });
  const r = await callJson({ baseUrl: urlOf(up), path: "/v1/chat/completions", payload: { a: 1 }, firstByteTimeoutMs: 500, idleTimeoutMs: 500 });
  assert.deepStrictEqual(r, { status: 200, json: { echo: { a: 1 }, path: "/v1/chat/completions" } });
  up.close();
});

test("idle timeout after headers settles proxyStream and ends the client stream", async () => {
  const up = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 0\n\n");
    // then stalls forever — never writes again, never ends
  });
  let settled = false;
  const front = await listen(async (req, res) => {
    await proxyStream({ req, res, body: Buffer.alloc(0), baseUrl: urlOf(up), firstByteTimeoutMs: 1000, idleTimeoutMs: 50 });
    settled = true;
  });
  const r = await fetch(`${urlOf(front)}/v1/x`);
  assert.strictEqual(r.status, 200);
  // Reading to completion should not hang: the idle timeout destroys the client
  // stream once it fires, one way or another (error or a truncated end).
  await r.text().catch(() => {});
  assert.strictEqual(await waitUntil(() => settled), true, "proxyStream promise never settled");
  up.closeAllConnections(); up.close(); front.close();
});

test("client abort mid-stream settles proxyStream and destroys the upstream request", async () => {
  let upstreamSideClosed = false;
  const up = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 0\n\n");
    res.on("close", () => { upstreamSideClosed = true; });
  });
  let settled = false;
  const front = await listen(async (req, res) => {
    await proxyStream({ req, res, body: Buffer.alloc(0), baseUrl: urlOf(up), firstByteTimeoutMs: 1000, idleTimeoutMs: 1000 });
    settled = true;
  });
  const controller = new AbortController();
  const fetchPromise = fetch(`${urlOf(front)}/v1/x`, { signal: controller.signal }).catch(() => {});
  await sleep(50);
  controller.abort();
  await fetchPromise;
  assert.strictEqual(await waitUntil(() => settled), true, "proxyStream promise never settled");
  assert.strictEqual(await waitUntil(() => upstreamSideClosed), true, "upstream request was never destroyed");
  up.closeAllConnections(); up.close(); front.close();
});

test("connection refused before headers → 502", async () => {
  // Bind a port, close it immediately, so nothing is listening there.
  const probe = await listen(() => {});
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const front = await listen(async (req, res) => {
    await proxyStream({ req, res, body: Buffer.alloc(0), baseUrl: `http://127.0.0.1:${port}`, firstByteTimeoutMs: 500, idleTimeoutMs: 500 });
  });
  const r = await fetch(`${urlOf(front)}/v1/x`);
  assert.strictEqual(r.status, 502);
  const j = await r.json();
  assert.strictEqual(j.error, "upstream_error");
  front.close();
});

test("callJson rejects when the response stalls past the idle timeout", async () => {
  const up = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{"); // partial body, then stalls forever
  });
  await assert.rejects(
    callJson({ baseUrl: urlOf(up), path: "/v1/x", payload: {}, firstByteTimeoutMs: 500, idleTimeoutMs: 50 }),
  );
  up.closeAllConnections(); up.close();
});

test("chunked client request is proxied with a clean content-length, no transfer-encoding conflict", async () => {
  const up = await listen((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        body: b,
        transferEncoding: req.headers["transfer-encoding"] || null,
        contentLength: req.headers["content-length"] || null,
      }));
    });
  });
  const front = await listen(async (req, res) => {
    // Mirror how the real router works: buffer the whole client body first.
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    await proxyStream({ req, res, body, baseUrl: urlOf(up), firstByteTimeoutMs: 500, idleTimeoutMs: 500 });
  });
  const r = await fetch(`${urlOf(front)}/v1/x`, {
    method: "POST",
    duplex: "half", // required by undici when body is a stream with no known length
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    }),
  });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.body, "hello world");
  assert.strictEqual(j.transferEncoding, null);
  assert.strictEqual(j.contentLength, String(Buffer.byteLength("hello world")));
  up.close(); front.close();
});
