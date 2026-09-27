"use strict";

const byName = (a, b) => a.name.localeCompare(b.name);

// Order: loaded with a free slot (most free first) → idle backend that can load it
// → wait. Loading is only allowed on an idle backend: on llama-swap a load evicts the
// resident model, which would kill its in-flight requests and defeat model grouping.
//
// Batch reserves one slot per backend+model for interactive traffic unless the
// interactive lane is idle (opts.interactiveIdle). The drainer only claims while idle,
// and an arriving interactive request preempts running batch jobs, so an idle batch
// lane may use every slot — including a 1-slot model's only one.
function batchReserve(capacity, lane, opts) {
  return lane === "batch" && !opts.interactiveIdle ? 1 : 0;
}

// Deliberately high estimate of a request's prompt size in tokens (JSON chars / 3,
// tool schemas included): over-estimating only steers a request to a bigger-context
// backend, under-estimating sends it somewhere that answers HTTP 400.
function estimateTokens(body) {
  return Math.ceil(JSON.stringify(body ?? "").length / 3);
}

// Backends whose known context size can't hold opts.needCtx are dropped. A backend
// with unknown context (never seen loaded) is kept. If nothing is known to fit, the
// largest known context is tried anyway — the estimate is pessimistic, so let the
// backend make the final call rather than refusing outright.
function fitContext(pool, cands, model, need) {
  if (!need) return cands;
  const ctx = (b) => b.ctx?.get(model);
  const fits = cands.filter((b) => !ctx(b) || ctx(b) >= need);
  if (fits.length) return fits;
  const max = Math.max(...cands.map(ctx));
  return cands.filter((b) => ctx(b) === max);
}

function pickBackend(pool, model, lane, opts = {}) {
  const up = [...pool.backends.values()].filter((b) => b.up && b.models.has(model));
  if (up.length === 0) return { none: true };
  const cands = fitContext(pool, up, model, opts.needCtx);

  const usable = (b) => pool.capacity(b, model) - batchReserve(pool.capacity(b, model), lane, opts);
  const free = (b) => usable(b) - pool.inflight(b, model);

  const ready = cands
    .filter((b) => pool.isLoaded(b, model) && free(b) > 0)
    .sort((a, b) => free(b) - free(a) || byName(a, b));
  if (ready.length) return { backend: ready[0].name };

  const idle = cands.filter((b) => !pool.isLoaded(b, model) && pool.totalInflight(b) === 0 && usable(b) > 0).sort(byName);
  if (idle.length) return { backend: idle[0].name };

  return { wait: true };
}

module.exports = { pickBackend, batchReserve, estimateTokens };
