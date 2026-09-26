"use strict";

function int(env, name, def) {
  const v = parseInt(env[name] ?? "", 10);
  return Number.isFinite(v) ? v : def;
}

function loadConfig(env = process.env) {
  let backends;
  try {
    backends = JSON.parse(env.BACKENDS_JSON || "{}");
  } catch {
    throw new Error("BACKENDS_JSON is not valid JSON");
  }
  for (const [name, url] of Object.entries(backends)) {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error(`backend ${name}: bad url`);
  }
  if (Object.keys(backends).length === 0) throw new Error("BACKENDS_JSON has no backends");

  return Object.freeze({
    port: int(env, "PORT", 8080),
    backends,
    pollMs: int(env, "POLL_MS", 10000),
    pollTimeoutMs: int(env, "POLL_TIMEOUT_MS", 4000),
    downAfterFails: int(env, "DOWN_AFTER_FAILS", 3),
    defaultSlots: int(env, "DEFAULT_SLOTS", 2),
    firstByteTimeoutMs: int(env, "FIRST_BYTE_TIMEOUT_MS", 120000),
    idleTimeoutMs: int(env, "IDLE_TIMEOUT_MS", 60000),
    waitTimeoutMs: int(env, "WAIT_TIMEOUT_MS", 600000),
    dbPath: env.DB_PATH || "/data/jobs.db",
    oldestOverrideMs: int(env, "OLDEST_OVERRIDE_MS", 30 * 60000),
    drainMaxMs: int(env, "DRAIN_MAX_MS", 10 * 60000),
    retryDelaysMs: [30000, 120000, 600000],
    doneRetentionMs: int(env, "DONE_RETENTION_MS", 7 * 86400000),
    ntfyUrl: env.NTFY_URL || "",
    ntfyToken: env.NTFY_TOKEN || "",
  });
}

module.exports = { loadConfig };
