"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { pollBackend, startDiscovery } = require("../src/discovery");
const { Pool } = require("../src/pool");
const { Leaser } = require("../src/lease");
const { fakeFetch } = require("./fakes");

const U = "http://luna:11434";

test("llama-swap backend: models, loaded, slot counts", async () => {
  const f = fakeFetch({
    [`${U}/v1/models`]: { data: [{ id: "big" }, { id: "small" }] },
    [`${U}/running`]: { running: [{ model: "small", state: "ready" }, { model: "big", state: "starting" }] },
    [`${U}/upstream/small/slots`]: [{}, {}, {}, {}],
  });
  assert.deepStrictEqual(await pollBackend(U, f), { models: ["big", "small"], loaded: ["small"], slots: { small: 4 } });
});

test("Ollama backend: no /running → loaded null", async () => {
  const f = fakeFetch({ [`${U}/v1/models`]: { data: [{ id: "m" }] } });
  assert.deepStrictEqual(await pollBackend(U, f), { models: ["m"], loaded: null, slots: {} });
});

test("a pollOnce already in flight skips a second overlapping call", async () => {
  let calls = 0;
  let resolveFirst;
  const gate = new Promise((r) => { resolveFirst = r; });
  const cfg = { backends: { luna: U }, downAfterFails: 3, pollMs: 10000, pollTimeoutMs: 100 };
  const pool = new Pool(["luna"], 2);
  const fetchJson = async (url) => {
    if (url === `${U}/v1/models`) {
      calls += 1;
      await gate; // first call hangs here until we release it
      return { data: [{ id: "m" }] };
    }
    throw new Error(`HTTP 404 ${url}`);
  };
  const d = startDiscovery({ cfg, pool, leaser: new Leaser(pool), fetchJson });

  const first = d.pollOnce();
  const second = d.pollOnce(); // must be a no-op: the first is still in flight
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(calls, 1, "the overlapping pollOnce must not start a second fetch");

  resolveFirst();
  await first;
  await second;
  assert.strictEqual(calls, 1);
  d.stop();
});

test("slot count for a model is fetched once and reused on the next poll", async () => {
  let slotsFetches = 0;
  const cfg = { backends: { luna: U }, downAfterFails: 3, pollMs: 10000, pollTimeoutMs: 100 };
  const pool = new Pool(["luna"], 2);
  const f = fakeFetch({
    [`${U}/v1/models`]: { data: [{ id: "big" }, { id: "small" }] },
    [`${U}/running`]: { running: [{ model: "small", state: "ready" }] },
  });
  const fetchJson = async (url) => {
    if (url === `${U}/upstream/small/slots`) { slotsFetches += 1; return [{}, {}, {}, {}]; }
    return f(url);
  };
  const d = startDiscovery({ cfg, pool, leaser: new Leaser(pool), fetchJson });

  await d.pollOnce();
  assert.strictEqual(slotsFetches, 1);
  assert.strictEqual(pool.backends.get("luna").slots.get("small"), 4);

  await d.pollOnce();
  assert.strictEqual(slotsFetches, 1, "the second poll must reuse the cached slot count, not re-fetch /slots");
  assert.strictEqual(pool.backends.get("luna").slots.get("small"), 4);

  d.stop();
});

test("three failed polls mark the backend down", async () => {
  const cfg = { backends: { luna: U }, downAfterFails: 3, pollMs: 10000, pollTimeoutMs: 100 };
  const pool = new Pool(["luna"], 2);
  const d = startDiscovery({ cfg, pool, leaser: new Leaser(pool), fetchJson: fakeFetch({ [`${U}/v1/models`]: { data: [{ id: "m" }] } }) });
  await d.pollOnce();
  d.stop();
  assert.strictEqual(pool.backends.get("luna").up, true);

  const dead = startDiscovery({ cfg, pool, leaser: new Leaser(pool), fetchJson: fakeFetch({}) });
  await dead.pollOnce(); await dead.pollOnce();
  assert.strictEqual(pool.backends.get("luna").up, true);
  await dead.pollOnce();
  dead.stop();
  assert.strictEqual(pool.backends.get("luna").up, false);
});
