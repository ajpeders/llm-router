"use strict";
const http = require("node:http");
const https = require("node:https");

// Hop-by-hop headers must never be forwarded as-is between a client and an upstream:
// they describe the connection itself, not the resource, and stale values from one
// leg (e.g. a chunked client request re-sent with a fixed content-length) make the
// other leg's parser reject the message outright.
const HOP_BY_HOP_HEADERS = [
  "connection", "keep-alive", "transfer-encoding", "te", "trailer",
  "upgrade", "proxy-authorization", "proxy-connection", "expect",
];

function stripHopByHop(headers, extra = []) {
  const h = { ...headers };
  for (const k of HOP_BY_HOP_HEADERS) delete h[k];
  for (const k of extra) delete h[k];
  return h;
}

// One upstream request with a first-byte timer that becomes an idle timer after the
// response headers arrive. There is deliberately no total cap: long agent turns stream
// for many minutes, and a fixed cap was why the old router got retired.
function request({ baseUrl, method, path, headers, body, firstByteTimeoutMs, idleTimeoutMs, onResponse, onError }) {
  const target = new URL(path, baseUrl);
  const client = target.protocol === "https:" ? https : http;
  let timer;
  const arm = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => req.destroy(new Error(why)), ms); };

  const req = client.request(target, { method, headers }, (res) => {
    arm(idleTimeoutMs, "upstream_timeout");
    // Re-arms on every chunk *consumed* here, not on the wire — if the client reads
    // slowly and backpressure stalls upRes.pipe(res), no data event fires and this
    // idle timer still trips, which is the intended behavior.
    res.on("data", () => arm(idleTimeoutMs, "upstream_timeout"));
    res.on("end", () => clearTimeout(timer));
    res.on("error", (err) => { clearTimeout(timer); onError(err, true); });
    onResponse(res);
  });
  req.on("error", (err) => { clearTimeout(timer); onError(err, false); });
  arm(firstByteTimeoutMs, "upstream_timeout");
  if (body.length) req.write(body);
  req.end();
  return req;
}

function proxyStream({ req, res, body, baseUrl, firstByteTimeoutMs, idleTimeoutMs }) {
  return new Promise((resolve) => {
    const headers = stripHopByHop(req.headers, ["host"]);
    // The body is already fully buffered, so content-length is always correct here —
    // any transfer-encoding the client sent is stripped above.
    headers["content-length"] = String(body.length);

    const up = request({
      baseUrl, method: req.method, path: req.url, headers, body, firstByteTimeoutMs, idleTimeoutMs,
      onResponse: (upRes) => {
        const h = stripHopByHop(upRes.headers);
        res.writeHead(upRes.statusCode || 502, h);
        upRes.pipe(res);
        upRes.on("end", resolve);
      },
      onError: (err, afterHeaders) => {
        if (!afterHeaders && !res.headersSent) {
          const status = err.message === "upstream_timeout" ? 504 : 502;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: status === 504 ? "upstream_timeout" : "upstream_error", detail: err.message }));
        } else {
          res.destroy(err);
        }
        resolve();
      },
    });
    res.on("close", () => { up.destroy(); resolve(); });
  });
}

function callJson({ baseUrl, path, payload, firstByteTimeoutMs, idleTimeoutMs, signal }) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const up = request({
      baseUrl, method: "POST", path, body, firstByteTimeoutMs, idleTimeoutMs,
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      onResponse: (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try { json = JSON.parse(text); } catch { json = { raw: text }; }
          resolve({ status: res.statusCode, json });
        });
      },
      onError: (err) => reject(err),
    });
    // Preemption: dropping the connection is what makes llama-server stop generating.
    if (signal) {
      const abort = () => up.destroy(new Error("preempted"));
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    }
  });
}

module.exports = { proxyStream, callJson };
