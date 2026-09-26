"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "cli.js");

function sse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("cli.js run streams SSE deltas from /v1/chat/completions and prints them", async () => {
  let seenPath = null, seenBody = null;
  const server = http.createServer((req, res) => {
    seenPath = req.url;
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seenBody = JSON.parse(b);
      sse(res, [
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: ", world" } }] },
      ]);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const router = `http://127.0.0.1:${server.address().port}`;

  try {
    const { code, stdout } = await runCli(["run", "mymodel", "say", "hi"], { LLM_ROUTER_URL: router });
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, "Hello, world\n");
    assert.strictEqual(seenPath, "/v1/chat/completions");
    assert.strictEqual(seenBody.model, "mymodel");
    assert.deepStrictEqual(seenBody.messages, [{ role: "user", content: "say hi" }]);
    assert.strictEqual(seenBody.stream, true);
  } finally {
    server.close();
  }
});

test("cli.js run --no-stream prints choices[0].message.content", async () => {
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "buffered reply" } }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const router = `http://127.0.0.1:${server.address().port}`;

  try {
    const { code, stdout } = await runCli(["run", "mymodel", "say", "hi", "--no-stream"], { LLM_ROUTER_URL: router });
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, "buffered reply\n");
  } finally {
    server.close();
  }
});
