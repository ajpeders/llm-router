"use strict";
const { batchReserve } = require("./pick");

class Pool {
  constructor(names, defaultSlots, now = Date.now) {
    this.defaultSlots = defaultSlots;
    this.now = now;
    // Union of every model any backend has ever reported, plus whether any backend has
    // been polled (successfully or not) at all yet — used to tell "model doesn't exist"
    // apart from "its backend is down right now" / "we haven't asked anyone yet".
    this.knownModels = new Set();
    this.polledOnce = false;
    this.backends = new Map(
      names.map((name) => [
        name,
        { name, up: false, fails: 0, downSince: now(), models: new Set(), loaded: null, slots: new Map(), inflight: new Map() },
      ])
    );
  }

  applyPoll(name, { models, loaded, slots }) {
    const b = this.backends.get(name);
    b.up = true;
    b.fails = 0;
    b.downSince = null;
    b.models = new Set(models);
    for (const m of models) this.knownModels.add(m);
    b.loaded = loaded === null ? null : new Set(loaded);
    b.slots = new Map(Object.entries(slots));
    this.polledOnce = true;
  }

  applyFailure(name, downAfter) {
    const b = this.backends.get(name);
    b.fails += 1;
    if (b.fails >= downAfter && b.up) {
      b.up = false;
      b.downSince = this.now();
    }
    // Deliberately not `this.polledOnce = true` here. polledOnce ∪ knownModels answers
    // "does this model exist at all" — a poll *failure* teaches us nothing about the
    // model universe, only that a backend is unreachable right now. If a restart's
    // first poll ever fails (backend down at boot, knownModels still empty), setting
    // polledOnce here would make every request for an existing-but-unconfirmed model
    // look "unknown" (404) instead of "backend down" (503). Only a successful poll
    // (applyPoll) can ever shrink the space of models we consider possibly-real.
  }

  capacity(b, model) { return b.slots.get(model) ?? this.defaultSlots; }
  inflight(b, model) { return b.inflight.get(model) ?? 0; }
  totalInflight(b) { let n = 0; for (const v of b.inflight.values()) n += v; return n; }
  isLoaded(b, model) { return b.loaded === null || b.loaded.has(model); }

  acquire(name, model) {
    const b = this.backends.get(name);
    // A llama-swap backend that doesn't yet report `model` as loaded is mid-swap: this
    // acquire is what triggers the load. Mark it loaded now so a second tryAcquire for
    // the previously-resident model doesn't race the swap before the next poll corrects
    // the picture — llama-swap can only serve one resident model at a time.
    if (b.loaded !== null && !b.loaded.has(model)) b.loaded = new Set([model]);
    b.inflight.set(model, this.inflight(b, model) + 1);
  }

  release(name, model) {
    const b = this.backends.get(name);
    const n = this.inflight(b, model) - 1;
    if (n > 0) b.inflight.set(model, n); else b.inflight.delete(model);
  }

  allModels() {
    const all = new Set();
    for (const b of this.backends.values()) if (b.up) for (const m of b.models) all.add(m);
    return [...all].sort();
  }

  // Whether the batch lane can currently get a slot for this model on some up backend,
  // under pickBackend's reserve rule. Structural only — ignores current inflight, so a
  // model that's merely busy right now still counts. A 1-slot model counts only while
  // the interactive lane is idle.
  batchServable(model, interactiveIdle = false) {
    for (const b of this.backends.values()) {
      const cap = this.capacity(b, model);
      if (b.up && b.models.has(model) && cap - batchReserve(cap, "batch", { interactiveIdle }) > 0) return true;
    }
    return false;
  }

  snapshot() {
    return [...this.backends.values()].map((b) => ({
      name: b.name,
      up: b.up,
      down_since: b.downSince,
      models: [...b.models].sort(),
      loaded: b.loaded === null ? null : [...b.loaded].sort(),
      slots: Object.fromEntries(b.slots),
      inflight: Object.fromEntries(b.inflight),
    }));
  }
}

module.exports = { Pool };
