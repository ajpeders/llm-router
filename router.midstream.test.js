// projects/llm-router/router.midstream.test.js
//
// Covers the in-flight-counter leak: if the upstream response errors AFTER
// headers are already sent (e.g. connection reset mid-body), proxyAttempt's
// promise must still settle so idleTracker.end() runs in the caller's
// finally. Otherwise inFlight never returns to 0 and /idle wedges to false.
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const net = require("node:net");
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

test("in-flight counter does not leak when upstream dies mid-stream after headers", async () => {
  // Fake backend, built on a raw net server so we can send headers plus a
  // partial body and then cleanly close the connection (FIN) before the
  // declared content-length is satisfied. This is the "connection reset
  // mid-stream" case: the client's http parser reports it as a response-level
  // 'error'/"aborted", NOT as a request-level error (the request itself was
  // sent and completed fine). Using http.createServer + socket.destroy()
  // instead would raise an ECONNRESET that node also surfaces as a
  // request-level error, masking the bug this test targets.
  const backend = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (!buf.includes("\r\n\r\n")) return;
      const requestLine = buf.split("\r\n")[0] || "";
      if (requestLine.includes("/api/tags")) {
        const payload = JSON.stringify({ models: [] });
        sock.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`
        );
        return;
      }
      // Declare more content than we actually send, then close the socket
      // gracefully. The client will have received headers + partial body but
      // never reach content-length, so it must observe this as a stream error.
      sock.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n");
      sock.write('{"partial": true');
      sock.end();
    });
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
    // Fire a request that will hit the fake backend and get killed mid-body.
    // We don't care whether the client sees a clean response; we only care
    // that the router's in-flight counter recovers afterward.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const req = http.request(
        { port, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          res.on("data", () => {});
          res.on("end", finish);
          // The router's own response to us also has a content-length it can
          // never fully satisfy (it mirrors the upstream's), so our client
          // response stream will itself error/abort instead of cleanly
          // ending. That is expected here, not a test failure.
          res.on("error", finish);
        }
      );
      req.on("error", finish); // client-side reset is expected, not a test failure
      req.end(JSON.stringify({ model: "whatever", messages: [] }));
    });

    // Give the router a moment to process the stream error and run its
    // finally block.
    await new Promise((r) => setTimeout(r, 200));

    const res = await get(port, "/idle");
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.inFlight, 0, "in-flight counter leaked after mid-stream upstream failure");
  } finally {
    proc.kill();
    backend.close();
  }
});
