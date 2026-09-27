"use strict";

async function defaultFetchJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// slotsCache is an optional Map<model, {cmd, slots, ctx}> reused (and mutated) across
// polls of the same backend. An entry is re-fetched only when llama-swap reports a
// different launch cmd for the model (its --parallel / --ctx-size may have changed);
// otherwise it's reused forever. Cached models are reported even while unloaded, so
// routing still knows a model's slot count and context size when it isn't resident.
async function pollBackend(baseUrl, fetchJson, slotsCache = new Map()) {
  const list = await fetchJson(`${baseUrl}/v1/models`);
  const models = (list.data || []).map((m) => m.id).sort();

  let ready = null;
  try {
    const r = await fetchJson(`${baseUrl}/running`);
    ready = (r.running || []).filter((x) => x.state === "ready");
  } catch {
    ready = null; // not llama-swap (e.g. Ollama): loaded-state unknown
  }

  for (const { model: m, cmd = "" } of ready || []) {
    if (slotsCache.get(m)?.cmd === cmd) continue;
    // Only ever fetched for a model llama-swap already reports ready: GET
    // /upstream/<m>/slots on a non-resident model would itself start it.
    try {
      const s = await fetchJson(`${baseUrl}/upstream/${m}/slots`);
      if (Array.isArray(s) && s.length > 0) {
        const ctxs = s.map((x) => x.n_ctx).filter(Number.isFinite);
        slotsCache.set(m, { cmd, slots: s.length, ctx: ctxs.length ? Math.min(...ctxs) : null });
      }
    } catch {
      // capacity falls back to cfg.defaultSlots; context size stays unknown
    }
  }
  const slots = {};
  const ctx = {};
  for (const [m, e] of slotsCache) {
    slots[m] = e.slots;
    if (e.ctx) ctx[m] = e.ctx;
  }
  return { models, loaded: ready && ready.map((x) => x.model), slots, ctx };
}

function startDiscovery({ cfg, pool, leaser, fetchJson }) {
  const get = fetchJson || ((url) => defaultFetchJson(url, cfg.pollTimeoutMs));
  // Slot counts / context sizes are cached per backend+model+launch cmd: re-fetching
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
