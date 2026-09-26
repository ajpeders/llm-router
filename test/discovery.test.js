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
