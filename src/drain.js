"use strict";
const { callJson } = require("./upstream");

function chooseModel(pending, now, oldestOverrideMs) {
  if (pending.length === 0) return null;
  const stale = pending.filter((p) => now - p.oldest >= oldestOverrideMs).sort((a, b) => a.oldest - b.oldest);
  if (stale.length) return stale[0].model;
  return [...pending].sort((a, b) => b.count - a.count || a.oldest - b.oldest)[0].model;
}

// Drains one model at a time so a big model loads once per drain, not once per job.
class Drainer {
  constructor({ queue, leaser, pool, cfg, runJob, onFinished, now = Date.now, isInteractiveIdle = () => false }) {
    Object.assign(this, { queue, leaser, pool, cfg, runJob, onFinished, now, isInteractiveIdle });
    this.current = null;
    this.drainStart = 0;
    this.running = new Set();
  }

  tick() {
    if (this.leaser.interactiveWaiting) return;
    const now = this.now();
    // Only models the batch lane can get a slot for right now (structurally, ignoring
    // current inflight). A 1-slot model qualifies only while the interactive lane is
    // idle; otherwise it would park the drainer on a model tryAcquire can't serve.
    const interactiveIdle = this.isInteractiveIdle();
    const pending = this.queue.pendingByModel(now).filter((p) => this.pool.batchServable(p.model, interactiveIdle));

    const hasCurrent = this.current && pending.some((p) => p.model === this.current);
    if (!hasCurrent || now - this.drainStart >= this.cfg.drainMaxMs) {
      // Don't switch models while the current one still has jobs in flight — the
      // switch would force a swap under them.
      if (this.running.size > 0) return;
      const next = chooseModel(pending, now, this.cfg.oldestOverrideMs);
      // Reset the window on every re-pick, even when the same model is chosen again —
      // otherwise, once the window has expired once, drainStart stays stuck in the
      // past and every later tick re-hits the "nothing in flight" gate above forever,
      // throttling steady-state draining of the same model to fully-idle-only.
      this.drainStart = now;
      this.current = next;
    }
    if (!this.current) return;

    for (;;) {
      let backend;
      try {
        backend = this.leaser.tryAcquire(this.current, "batch", { interactiveIdle });
      } catch {
        return; // no backend serves it right now
      }
      if (!backend) return;
      let job;
      try {
        job = this.queue.claim(this.current, now);
      } catch (err) {
        this.leaser.release(backend, this.current);
        throw err;
      }
      if (!job) { this.leaser.release(backend, this.current); return; }
      this._run(job, backend);
    }
  }

  _run(job, backend) {
    const p = (async () => {
      let final;
      try {
        const result = await this.runJob(job, backend);
        this.queue.complete(job.id, result, this.now());
        final = this.queue.get(job.id);
      } catch (err) {
        const status = this.queue.fail(job.id, err.message, this.now(), this.cfg.retryDelaysMs);
        if (status === "dead") final = this.queue.get(job.id);
      } finally {
        this.leaser.release(backend, job.model);
      }
      if (final) {
        try {
          await this.onFinished(final);
        } catch (err) {
          console.log(`[llm-router] onFinished for ${job.id} failed: ${err.message}`);
        }
      }
    })();
    this.running.add(p);
    p.finally(() => { this.running.delete(p); this.tick(); }).catch((err) => {
      console.log(`[llm-router] onFinished for ${job.id} failed: ${err.message}`);
    });
  }

  async idle() {
    while (this.running.size) await Promise.all([...this.running]);
  }
}

function makeRunJob(cfg) {
  return async (job, backend) => {
    const isEmbed = job.request && job.request.input !== undefined;
    const r = await callJson({
      baseUrl: cfg.backends[backend],
      path: isEmbed ? "/v1/embeddings" : "/v1/chat/completions",
      payload: { ...job.request, model: job.model, ...(isEmbed ? {} : { stream: false }) },
      // Non-streaming: headers only arrive once the whole reply is ready, so the
      // first-byte timeout is the batch job's total cap. Use batchTimeoutMs, not the
      // interactive lane's firstByteTimeoutMs.
      firstByteTimeoutMs: cfg.batchTimeoutMs,
      idleTimeoutMs: cfg.idleTimeoutMs,
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
    return r.json;
  };
}

module.exports = { chooseModel, Drainer, makeRunJob };
