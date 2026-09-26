"use strict";

async function defaultFetchJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// slotsCache is an optional Map<model, count> reused (and mutated) across polls of the
// same backend, so a model whose count is already known is never re-fetched.
async function pollBackend(baseUrl, fetchJson, slotsCache = new Map()) {
  const list = await fetchJson(`${baseUrl}/v1/models`);
  const models = (list.data || []).map((m) => m.id).sort();

  let loaded = null;
  try {
    const r = await fetchJson(`${baseUrl}/running`);
    loaded = (r.running || []).filter((x) => x.state === "ready").map((x) => x.model);
  } catch {
    loaded = null; // not llama-swap (e.g. Ollama): loaded-state unknown
  }

  const slots = {};
  for (const m of loaded || []) {
    if (slotsCache.has(m)) { slots[m] = slotsCache.get(m); continue; }
    // GET /upstream/<m>/slots can itself start `m` on llama-swap — only worth the risk
    // once per model, ever; the cached value is reused on every later poll.
    try {
      const s = await fetchJson(`${baseUrl}/upstream/${m}/slots`);
      if (Array.isArray(s) && s.length > 0) { slots[m] = s.length; slotsCache.set(m, s.length); }
    } catch {
      // capacity falls back to cfg.defaultSlots
    }
  }
  return { models, loaded, slots };
}

function startDiscovery({ cfg, pool, leaser, fetchJson }) {
  const get = fetchJson || ((url) => defaultFetchJson(url, cfg.pollTimeoutMs));
  // Slot counts are cached per backend+model forever once fetched: re-fetching
  // /upstream/<model>/slots on every poll can itself start that model on llama-swap,
  // which is exactly the load-on-discovery bug this cache exists to avoid.
  const slotsCaches = new Map(Object.keys(cfg.backends).map((name) => [name, new Map()]));
  let inFlight = false;

  async function pollOnce() {
    // A poll can take longer than pollMs (a slow/hanging backend); skip a scheduled
    // tick that lands while the previous one is still running rather than stacking
    // concurrent polls of the same backends.
    if (inFlight) return;
    inFlight = true;
    try {
      await Promise.all(
        Object.entries(cfg.backends).map(async ([name, url]) => {
          try {
            pool.applyPoll(name, await pollBackend(url, get, slotsCaches.get(name)));
          } catch (err) {
            pool.applyFailure(name, cfg.downAfterFails);
            console.log(`[llm-router] poll ${name} failed: ${err.message}`);
          }
        })
      );
      leaser.notify();
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(pollOnce, cfg.pollMs);
  return { pollOnce, stop: () => clearInterval(timer) };
}

module.exports = { pollBackend, startDiscovery, defaultFetchJson };
