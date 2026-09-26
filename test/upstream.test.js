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
