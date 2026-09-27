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

function pickBackend(pool, model, lane, opts = {}) {
  const cands = [...pool.backends.values()].filter((b) => b.up && b.models.has(model));
  if (cands.length === 0) return { none: true };

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

module.exports = { pickBackend, batchReserve };
