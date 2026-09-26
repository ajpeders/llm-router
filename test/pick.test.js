"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { Pool } = require("../src/pool");
const { pickBackend } = require("../src/pick");

function pool2() {
  const p = new Pool(["luna", "mac"], 2);
  p.applyPoll("luna", { models: ["big", "small"], loaded: ["small"], slots: { small: 4 } });
  p.applyPoll("mac", { models: ["small"], loaded: ["small"], slots: { small: 2 } });
  return p;
}

test("prefers loaded backend with most free slots", () => {
  assert.deepStrictEqual(pickBackend(pool2(), "small", "interactive"), { backend: "luna" });
});

test("least busy wins once luna fills up", () => {
  const p = pool2();
  for (let i = 0; i < 3; i++) p.acquire("luna", "small");
  assert.deepStrictEqual(pickBackend(p, "small", "interactive"), { backend: "mac" });
});

test("batch never takes the last slot", () => {
  const p = new Pool(["mac"], 2);
  p.applyPoll("mac", { models: ["small"], loaded: ["small"], slots: { small: 2 } });
  p.acquire("mac", "small");
  assert.deepStrictEqual(pickBackend(p, "small", "batch"), { wait: true });
  assert.deepStrictEqual(pickBackend(p, "small", "interactive"), { backend: "mac" });
});

test("loads an unloaded model only on an idle backend", () => {
  const p = pool2();
  assert.deepStrictEqual(pickBackend(p, "big", "interactive"), { backend: "luna" });
  p.acquire("luna", "small");
  assert.deepStrictEqual(pickBackend(p, "big", "interactive"), { wait: true });
});

test("down backends are skipped; unknown model is none", () => {
  const p = pool2();
  for (let i = 0; i < 3; i++) p.applyFailure("luna", 3);
  assert.deepStrictEqual(pickBackend(p, "small", "interactive"), { backend: "mac" });
  assert.deepStrictEqual(pickBackend(p, "big", "interactive"), { none: true });
  assert.deepStrictEqual(pickBackend(p, "nope", "interactive"), { none: true });
});

test("loaded=null (Ollama) counts as loaded, default slots apply", () => {
  const p = new Pool(["ollama"], 2);
  p.applyPoll("ollama", { models: ["m"], loaded: null, slots: {} });
  p.acquire("ollama", "m");
  assert.deepStrictEqual(pickBackend(p, "m", "interactive"), { backend: "ollama" });
  assert.deepStrictEqual(pickBackend(p, "m", "batch"), { wait: true });
});

test("downSince is set on failure and cleared on recovery", () => {
  let t = 1000;
  const p = new Pool(["a"], 2, () => t);
  p.applyPoll("a", { models: [], loaded: null, slots: {} });
  assert.strictEqual(p.backends.get("a").downSince, null);
  t = 2000;
  for (let i = 0; i < 3; i++) p.applyFailure("a", 3);
  assert.strictEqual(p.backends.get("a").downSince, 2000);
});
