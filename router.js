"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = parseInt(process.env.PORT || "8080", 10);
const MODEL_REFRESH_MS = parseInt(process.env.MODEL_REFRESH_MS || "30000", 10);
const TAGS_TIMEOUT_MS = parseInt(process.env.TAGS_TIMEOUT_MS || "4000", 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "300000", 10);
const BACKEND_TIER = (process.env.BACKEND_TIER || "mac,arch")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_BACKENDS = {
  mac: "http://192.168.0.47:11434",
  arch: "http://192.168.0.40:11434",
};

function parseBackends(raw) {
  if (!raw) return DEFAULT_BACKENDS;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return DEFAULT_BACKENDS;
    }
    const out = {};
    for (const [name, url] of Object.entries(parsed)) {
      if (typeof name === "string" && typeof url === "string" && url.startsWith("http")) {
        out[name] = url;
      }
    }
    return Object.keys(out).length > 0 ? out : DEFAULT_BACKENDS;
  } catch {
    return DEFAULT_BACKENDS;
  }
}

const BACKENDS = parseBackends(process.env.BACKENDS_JSON);
const BACKEND_NAMES = Object.keys(BACKENDS);

function buildTierOrder() {
  const out = [];
  for (const backend of BACKEND_TIER) {
    if (BACKEND_NAMES.includes(backend) && !out.includes(backend)) {
      out.push(backend);
    }
  }
  for (const backend of BACKEND_NAMES) {
    if (!out.includes(backend)) {
      out.push(backend);
    }
  }
  return out;
}

const TIER_ORDER = buildTierOrder();
if (TIER_ORDER.length === 0) {
  console.error("No backends configured.");
  process.exit(1);
}

// Optional MiniMax cloud backend. Only OpenAI-style chat completions are sent
// there; Ollama-native /api/* routes stay local.
const MINIMAX = "minimax";
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || "";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || "MiniMax-Text-01";
const MINIMAX_API_BASE = (process.env.MINIMAX_API_BASE || "https://api.minimax.chat/v1").replace(/\/+$/, "");
const MINIMAX_PRIORITY = process.env.MINIMAX_PRIORITY === "primary" ? "primary" : "fallback";

const modelSets = {};
for (const backend of BACKEND_NAMES) modelSets[backend] = new Set();

function log(message) {
  console.log(`[llm-router] ${message}`);
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshModels() {
  await Promise.all(
    BACKEND_NAMES.map(async (backend) => {
      const base = BACKENDS[backend];
      try {
        const payload = await fetchJson(`${base}/api/tags`, TAGS_TIMEOUT_MS);
        const next = new Set();
        if (payload && Array.isArray(payload.models)) {
          for (const m of payload.models) {
            if (m && typeof m === "object") {
              if (typeof m.model === "string" && m.model) next.add(m.model);
              if (typeof m.name === "string" && m.name) next.add(m.name);
            }
          }
        }
        modelSets[backend] = next;
      } catch (err) {
        modelSets[backend] = new Set();
        log(`model refresh failed for ${backend} (${base}): ${err.message}`);
      }
    })
  );
}

function buildMergedModelsPayload() {
  const merged = new Set();
  const byBackend = {};

  for (const backend of TIER_ORDER) {
    const models = [...modelSets[backend]].sort();
    byBackend[backend] = models;
    for (const model of models) merged.add(model);
  }

  return {
    ok: true,
    tier: TIER_ORDER,
    total_models: merged.size,
    models: [...merged].sort(),
    by_backend: byBackend,
  };
}

function getModelFromJsonBody(contentType, body) {
  if (!contentType || !contentType.toLowerCase().includes("application/json")) return null;
  if (!body || body.length === 0) return null;
  try {
    const data = JSON.parse(body.toString("utf8"));
    return data && typeof data.model === "string" ? data.model : null;
  } catch {
    return null;
  }
}

function getModelFromQuery(reqUrl) {
  try {
    const parsed = new URL(reqUrl, "http://router.local");
    const queryModel = parsed.searchParams.get("model");
    return queryModel && queryModel.trim() ? queryModel.trim() : null;
  } catch {
    return null;
  }
}

function getRequestedModel(req, body) {
  const jsonModel = getModelFromJsonBody(req.headers["content-type"], body);
  if (jsonModel) return jsonModel;

  const headerModel = req.headers["x-model"];
  if (typeof headerModel === "string" && headerModel.trim()) return headerModel.trim();

  return getModelFromQuery(req.url || "/");
}

function orderedBackendsForModel(model) {
  if (!model) {
    return [...TIER_ORDER];
  }

  const available = TIER_ORDER.filter((backend) => modelSets[backend].has(model));
  if (available.length === 0) {
    return [...TIER_ORDER];
  }

  return [...available, ...TIER_ORDER.filter((backend) => !available.includes(backend))];
}

function minimaxEligible(req) {
  if (!MINIMAX_API_KEY || req.method !== "POST") return false;
  return new URL(req.url, "http://router.local").pathname === "/v1/chat/completions";
}

// MiniMax goes first when it's primary, when the MiniMax model is asked for by
// name, or when no local backend has the requested model; otherwise it's last.
function withMinimax(targets, model) {
  const noLocalModel = model && !BACKEND_NAMES.some((backend) => modelSets[backend].has(model));
  if (MINIMAX_PRIORITY === "primary" || model === MINIMAX_MODEL || noLocalModel) {
    return [MINIMAX, ...targets];
  }
  return [...targets, MINIMAX];
}

function upstreamFor(backend, req, body) {
  if (backend !== MINIMAX) {
    return { url: new URL(req.url, BACKENDS[backend]), body, auth: null };
  }
  let outBody = body;
  try {
    const data = JSON.parse(body.toString("utf8"));
    data.model = MINIMAX_MODEL;
    outBody = Buffer.from(JSON.stringify(data));
  } catch {
    // Forward unparseable bodies as-is and let MiniMax reject them.
  }
  return {
    url: new URL(MINIMAX_API_BASE + req.url.replace(/^\/v1/, "")),
    body: outBody,
    auth: `Bearer ${MINIMAX_API_KEY}`,
  };
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function shouldRetryStatus(statusCode) {
  return typeof statusCode === "number" && statusCode >= 500;
}

function proxyAttempt(req, res, body, backend, isLastAttempt) {
  return new Promise((resolve) => {
    const upstream = upstreamFor(backend, req, body);
    const targetUrl = upstream.url;
    const outBody = upstream.body;
    const isHttps = targetUrl.protocol === "https:";
    const client = isHttps ? https : http;

    const headers = { ...req.headers };
    delete headers.host;
    if (outBody.length > 0) {
      headers["content-length"] = String(outBody.length);
    } else {
      delete headers["content-length"];
    }
    if (upstream.auth) headers.authorization = upstream.auth;
    headers["x-llm-router-backend"] = backend;

    const options = {
      method: req.method,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    };

    const upstreamReq = client.request(options, (upstreamRes) => {
      if (!isLastAttempt && shouldRetryStatus(upstreamRes.statusCode)) {
        upstreamRes.resume();
        resolve({ ok: false, reason: `status ${upstreamRes.statusCode}` });
        return;
      }

      const responseHeaders = { ...upstreamRes.headers };
      delete responseHeaders.connection;
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on("end", () => resolve({ ok: true }));
    });

    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(new Error("upstream timeout"));
    });

    upstreamReq.on("error", (err) => {
      if (isLastAttempt) {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "all_backends_failed", detail: err.message }));
        }
        resolve({ ok: true });
      } else {
        resolve({ ok: false, reason: err.message });
      }
    });

    if (outBody.length > 0) upstreamReq.write(outBody);
    upstreamReq.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing_url" }));
    return;
  }

  if (req.url === "/health") {
    const snapshot = {};
    for (const name of BACKEND_NAMES) snapshot[name] = modelSets[name].size;
    res.writeHead(200, { "content-type": "application/json" });
    const minimax = MINIMAX_API_KEY ? { model: MINIMAX_MODEL, priority: MINIMAX_PRIORITY } : null;
    res.end(JSON.stringify({ ok: true, tier: TIER_ORDER, backends: snapshot, minimax }));
    return;
  }

  if (req.url === "/api/models/all" || req.url === "/models/all") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(buildMergedModelsPayload()));
    return;
  }

  try {
    const body = await collectBody(req);
    const model = getRequestedModel(req, body);
    const localTargets = orderedBackendsForModel(model);
    const targets = minimaxEligible(req) ? withMinimax(localTargets, model) : localTargets;

    for (let i = 0; i < targets.length; i += 1) {
      const backend = targets[i];
      const isLastAttempt = i === targets.length - 1;
      const attempt = await proxyAttempt(req, res, body, backend, isLastAttempt);
      if (attempt.ok) {
        const modelText = model ? ` model=${model}` : "";
        log(`${req.method} ${req.url}${modelText} -> ${backend}`);
        return;
      }
      log(`retrying ${req.method} ${req.url} after ${backend} (${attempt.reason})`);
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "router_error", detail: err.message }));
    }
  }
});

server.listen(PORT, "0.0.0.0", async () => {
  log(`starting on :${PORT}`);
  log(`tier order: ${JSON.stringify(TIER_ORDER)}`);
  log(`backends: ${JSON.stringify(BACKENDS)}`);
  log(MINIMAX_API_KEY ? `minimax: ${MINIMAX_MODEL} (${MINIMAX_PRIORITY}) via ${MINIMAX_API_BASE}` : "minimax: disabled");
  await refreshModels();
  setInterval(refreshModels, MODEL_REFRESH_MS);
});
