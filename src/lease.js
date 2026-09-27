"use strict";
const { pickBackend } = require("./pick");

class Leaser {
  constructor(pool) {
    this.pool = pool;
    this.waiters = [];
  }

  tryAcquire(model, lane, opts = {}) {
    const r = pickBackend(this.pool, model, lane, opts);
    if (r.none) throw new Error("no_backend");
    if (r.wait) return null;
    this.pool.acquire(r.backend, model);
    return r.backend;
  }

  acquire(model, lane, timeoutMs, opts = {}) {
    try {
      const name = this.tryAcquire(model, lane, opts);
      if (name) return Promise.resolve(name);
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      const w = { model, lane, opts, resolve, reject };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error("wait_timeout"));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  release(name, model) {
    this.pool.release(name, model);
    this.notify();
  }

  notify() {
    const ordered = [
      ...this.waiters.filter((w) => w.lane === "interactive"),
      ...this.waiters.filter((w) => w.lane !== "interactive"),
    ];
    for (const w of ordered) {
      let name;
      try {
        name = this.tryAcquire(w.model, w.lane, w.opts);
      } catch (err) {
        this._drop(w);
        w.reject(err);
        continue;
      }
      if (name) {
        this._drop(w);
        w.resolve(name);
      }
    }
  }

  _drop(w) {
    clearTimeout(w.timer);
    this.waiters = this.waiters.filter((x) => x !== w);
  }

  get interactiveWaiting() {
    return this.waiters.some((w) => w.lane === "interactive");
  }
}

module.exports = { Leaser };
