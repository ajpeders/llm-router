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
    // A non-streaming /v1 request gets no response headers from llama-server
    // until generation is fully done, so the interactive firstByteTimeoutMs
    // (tuned for a streaming first token) is the wrong cap for it. Use the
    // same long cap batch jobs use, for the same reason.
    nonStreamTimeoutMs: int(env, "NONSTREAM_TIMEOUT_MS", 30 * 60000),
    // Quiet window /idle uses to decide the router itself is idle (no in-flight
    // interactive request and no activity for at least this long).
    idleWindowMs: int(env, "IDLE_WINDOW_MS", 120000),
    // A batch reply is non-streaming: the backend sends nothing until the whole
    // answer is ready, so this is the real total cap for a batch job's run.
    batchTimeoutMs: int(env, "BATCH_TIMEOUT_MS", 30 * 60000),
    // Batch is paused while any interactive request is in flight and until this long
    // after the last one, so a coding session isn't interleaved with batch jobs.
    batchHoldoffMs: int(env, "BATCH_HOLDOFF_MS", 10 * 60000),
    // x-llm-router-source values whose /v1 traffic is background work (an agent's
    // own task runner, cron), treated like x-llm-router-batch: 1 — it neither
    // pauses nor preempts batch. Everything else is a person, i.e. interactive.
    backgroundSources: (env.BACKGROUND_SOURCES ?? "kanban,cron").split(",").map((s) => s.trim()).filter(Boolean),
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
