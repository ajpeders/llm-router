// projects/llm-router/router.idle.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { spawn } = require("node:child_process");

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method: "GET", headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("/idle reports idle=true shortly after startup with a short window", async () => {
  // Fake backend so refreshModels has something to hit.
  const backend = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [] }));
  });
  await new Promise((r) => backend.listen(0, r));
  const backendPort = backend.address().port;

  const proc = spawn("node", ["router.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: "0",
      IDLE_WINDOW_MS: "50",
      BACKENDS_JSON: JSON.stringify({ fake: `http://127.0.0.1:${backendPort}` }),
      BACKEND_TIER: "fake",
    },
  });

  // Read the "starting on :PORT" log to learn the chosen port.
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const to = setTimeout(() => reject(new Error("router did not start")), 5000);
    proc.stdout.on("data", (d) => {
      buf += d;
      const m = buf.match(/starting on :(\d+)/);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
    proc.stderr.on("data", (d) => (buf += d));
  });

  try {
    await new Promise((r) => setTimeout(r, 120)); // exceed 50ms window
    const res = await get(port, "/idle");
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.idle, true);
    assert.strictEqual(json.inFlight, 0);
    assert.strictEqual(json.quietWindowMs, 50);
  } finally {
    proc.kill();
    backend.close();
  }
});
