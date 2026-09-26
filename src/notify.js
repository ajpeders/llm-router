"use strict";

async function deliverCallback(job, fetchImpl = fetch) {
  if (!job.callback) return;
  try {
    await fetchImpl(job.callback, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.log(`[llm-router] callback for ${job.id} failed: ${err.message}`);
  }
}

async function alertDead(job, cfg, fetchImpl = fetch) {
  if (!cfg.ntfyUrl) return;
  try {
    await fetchImpl(cfg.ntfyUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.ntfyToken}`, Title: "llm-router job dead", Priority: "high", Tags: "robot" },
      body: `job ${job.id} (model ${job.model}) failed ${job.attempts}x: ${job.error}`,
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.log(`[llm-router] ntfy alert for ${job.id} failed: ${err.message}`);
  }
}

module.exports = { deliverCallback, alertDead };
