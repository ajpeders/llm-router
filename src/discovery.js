"use strict";

async function defaultFetchJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function pollBackend(baseUrl, fetchJson) {
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
    try {
      const s = await fetchJson(`${baseUrl}/upstream/${m}/slots`);
      if (Array.isArray(s) && s.length > 0) slots[m] = s.length;
    } catch {
      // capacity falls back to cfg.defaultSlots
    }
  }
  return { models, loaded, slots };
}

function startDiscovery({ cfg, pool, leaser, fetchJson }) {
  const get = fetchJson || ((url) => defaultFetchJson(url, cfg.pollTimeoutMs));

  async function pollOnce() {
    await Promise.all(
      Object.entries(cfg.backends).map(async ([name, url]) => {
        try {
          pool.applyPoll(name, await pollBackend(url, get));
        } catch (err) {
          pool.applyFailure(name, cfg.downAfterFails);
          console.log(`[llm-router] poll ${name} failed: ${err.message}`);
        }
      })
    );
    leaser.notify();
  }

  const timer = setInterval(pollOnce, cfg.pollMs);
  return { pollOnce, stop: () => clearInterval(timer) };
}

module.exports = { pollBackend, startDiscovery, defaultFetchJson };
