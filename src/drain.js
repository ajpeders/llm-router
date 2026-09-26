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
  constructor({ queue, leaser, pool, cfg, runJob, onFinished, now = Date.now }) {
    Object.assign(this, { queue, leaser, pool, cfg, runJob, onFinished, now });
    this.current = null;
    this.drainStart = 0;
    this.running = new Set();
  }

  tick() {
    if (this.leaser.interactiveWaiting) return;
    const now = this.now();
    const servable = new Set(this.pool.allModels());
    const pending = this.queue.pendingByModel(now).filter((p) => servable.has(p.model));

    const hasCurrent = this.current && pending.some((p) => p.model === this.current);
    if (!hasCurrent || now - this.drainStart >= this.cfg.drainMaxMs) {
      // Don't switch models while the current one still has jobs in flight — the
      // switch would force a swap under them.
      if (this.running.size > 0) return;
      const next = chooseModel(pending, now, this.cfg.oldestOverrideMs);
      if (next !== this.current) this.drainStart = now;
      this.current = next;
    }
    if (!this.current) return;

    for (;;) {
      let backend;
      try {
        backend = this.leaser.tryAcquire(this.current, "batch");
      } catch {
        return; // no backend serves it right now
      }
      if (!backend) return;
      const job = this.queue.claim(this.current, now);
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
      if (final) await this.onFinished(final);
    })();
    this.running.add(p);
    p.finally(() => { this.running.delete(p); this.tick(); });
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
      firstByteTimeoutMs: cfg.firstByteTimeoutMs,
      idleTimeoutMs: cfg.idleTimeoutMs,
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
    return r.json;
  };
}

module.exports = { chooseModel, Drainer, makeRunJob };
