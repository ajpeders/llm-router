"use strict";

const byName = (a, b) => a.name.localeCompare(b.name);

// Order: loaded with a free slot (most free first) → idle backend that can load it
// → wait. Loading is only allowed on an idle backend: on llama-swap a load evicts the
// resident model, which would kill its in-flight requests and defeat model grouping.
function pickBackend(pool, model, lane) {
  const cands = [...pool.backends.values()].filter((b) => b.up && b.models.has(model));
  if (cands.length === 0) return { none: true };

  const reserve = lane === "batch" ? 1 : 0;
  const free = (b) => pool.capacity(b, model) - reserve - pool.inflight(b, model);

  const ready = cands
    .filter((b) => pool.isLoaded(b, model) && free(b) > 0)
    .sort((a, b) => free(b) - free(a) || byName(a, b));
  if (ready.length) return { backend: ready[0].name };

  const idle = cands.filter((b) => !pool.isLoaded(b, model) && pool.totalInflight(b) === 0).sort(byName);
  if (idle.length) return { backend: idle[0].name };

  return { wait: true };
}

module.exports = { pickBackend };
