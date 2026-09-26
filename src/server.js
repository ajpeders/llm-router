"use strict";
const http = require("node:http");
const { proxyStream } = require("./upstream");
const { createIdleTracker } = require("./idle");

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(buf) {
  try { return JSON.parse(buf.toString("utf8") || "null"); } catch { return null; }
}

function createServer({ cfg, pool, leaser, queue, drainer, now = Date.now }) {
  // Interactive-lane idle tracker: batch jobs run through the drainer, never through
  // this server, so they're excluded automatically. A request tagged
  // x-llm-router-batch: 1 is excluded explicitly (used by callers that hit /v1
  // directly for batch-shaped work outside the queue).
  const idleTracker = createIdleTracker(cfg.idleWindowMs ?? 120000);

  return http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://router.local").pathname;
      const tier = Object.keys(cfg.backends);
      if (req.method === "GET" && path === "/idle") {
        return send(res, 200, idleTracker.snapshot(now()));
      }
      if (req.method === "GET" && path === "/health") {
        const backends = {};
        for (const b of pool.backends.values()) backends[b.name] = b.models.size;
        return send(res, 200, { ok: true, tier, backends });
      }
      if (req.method === "GET" && path === "/api/models/all") {
        const by_backend = {};
        for (const b of pool.backends.values()) by_backend[b.name] = [...b.models].sort();
        const models = pool.allModels();
        return send(res, 200, { ok: true, tier, total_models: models.length, models, by_backend });
      }
      if (req.method === "GET" && path === "/status") {
        const age = queue.oldestPendingAgeMs(now());
        return send(res, 200, {
          backends: pool.snapshot(),
          queue: { counts: queue.counts(), by_model: queue.pendingByModel(now()), oldest_pending_age_s: age === null ? null : Math.floor(age / 1000) },
          draining: drainer.current,
        });
      }
      if (req.method === "GET" && path === "/v1/models") {
        return send(res, 200, { object: "list", data: pool.allModels().map((id) => ({ id, object: "model", owned_by: "llm-router" })) });
      }
      if (req.method === "POST" && path === "/jobs") {
        const b = parseJson(await readBody(req));
        const badCallback = b && b.callback !== undefined && b.callback !== null &&
          (typeof b.callback !== "string" || !/^https?:\/\//.test(b.callback));
        const badDedupe = b && b.dedupe_key !== undefined && b.dedupe_key !== null && typeof b.dedupe_key !== "string";
        if (!b || typeof b.model !== "string" || !b.request || typeof b.request !== "object" || badCallback || badDedupe) {
          return send(res, 400, { error: "bad_job", hint: "{model: string, request: object, priority?, callback?, dedupe_key?}" });
        }
        const r = queue.submit(
          { model: b.model, request: b.request, priority: b.priority | 0, callback: b.callback || null, dedupe_key: b.dedupe_key || null },
          now()
        );
        return send(res, 202, r);
      }
      const jobMatch = req.method === "GET" && path.match(/^\/jobs\/([\w-]+)$/);
      if (jobMatch) {
        const job = queue.get(jobMatch[1]);
        return job ? send(res, 200, job) : send(res, 404, { error: "not_found" });
      }
      if (path.startsWith("/v1/")) {
        const isBatch = req.headers["x-llm-router-batch"] === "1";
        if (!isBatch) {
          idleTracker.begin();
          idleTracker.markActivity(now());
        }
        try {
          const body = await readBody(req);
          const parsedBody = parseJson(body);
          const model = parsedBody?.model;
          if (typeof model !== "string") return send(res, 400, { error: "missing_model" });
          // Non-streaming requests get no headers from llama-server until generation
          // is fully done, so the interactive first-byte timeout (tuned for a
          // streaming response's first token) is the wrong cap here — use the same
          // long cap batch jobs use for exactly this reason (see cfg.batchTimeoutMs).
          const isStreaming = parsedBody?.stream === true;
          const firstByteTimeoutMs = isStreaming ? cfg.firstByteTimeoutMs : cfg.nonStreamTimeoutMs;
          let backend;
          try {
            backend = await leaser.acquire(model, "interactive", cfg.waitTimeoutMs);
          } catch (err) {
            if (err.message === "no_backend") {
              // "No up backend serves it" is ambiguous between "this model doesn't
              // exist" and "its backend is just down right now" (or we haven't polled
              // anyone yet). Only call it unknown once we've polled at least once and
              // no backend has ever reported this model.
              if (!pool.polledOnce || pool.knownModels.has(model)) {
                return send(res, 503, { error: "backend_down", model });
              }
              return send(res, 404, { error: "unknown_model", model });
            }
            return send(res, 503, { error: "busy", detail: err.message });
          }
          // req.destroyed is not a useful signal here: an IncomingMessage auto-destroys
          // once its body has been fully read (readBody above), which happens on every
          // normal request, not just an aborted one. The socket is the real signal for
          // "the client is actually gone."
          if (res.destroyed || !res.socket || res.socket.destroyed) {
            leaser.release(backend, model);
            return;
          }
          try {
            await proxyStream({ req, res, body, baseUrl: cfg.backends[backend], firstByteTimeoutMs, idleTimeoutMs: cfg.idleTimeoutMs });
          } finally {
            leaser.release(backend, model);
          }
          console.log(`[llm-router] ${req.method} ${path} model=${model} -> ${backend}`);
          return;
        } finally {
          if (!isBatch) idleTracker.end();
        }
      }
      return send(res, 404, { error: "not_found", hint: "use /v1 (OpenAI API)" });
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: "router_error", detail: err.message });
    }
  });
}

module.exports = { createServer };
