"use strict";
const { DatabaseSync } = require("node:sqlite");
const { randomUUID } = require("node:crypto");

// One statement per entry: prepare() accepts a single statement.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    request TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    callback TEXT,
    dedupe_key TEXT,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    next_run_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS jobs_pending ON jobs (status, model, next_run_at)",
  "CREATE INDEX IF NOT EXISTS jobs_dedupe ON jobs (dedupe_key, status)",
];

function row(r) {
  if (!r) return null;
  return { ...r, request: JSON.parse(r.request), result: r.result === null ? null : JSON.parse(r.result) };
}

class Queue {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.prepare("PRAGMA journal_mode = WAL").get();
    for (const stmt of SCHEMA) this.db.prepare(stmt).run();
  }

  submit({ model, request, priority = 0, callback = null, dedupe_key = null }, now) {
    if (dedupe_key) {
      const hit = this.db
        .prepare("SELECT id FROM jobs WHERE dedupe_key = ? AND status IN ('pending','running')")
        .get(dedupe_key);
      if (hit) return { id: hit.id, deduped: true };
    }
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO jobs (id, model, request, priority, callback, dedupe_key, status, created_at, updated_at, next_run_at)
                VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(id, model, JSON.stringify(request), priority, callback, dedupe_key, now, now, now);
    return { id, deduped: false };
  }

  get(id) {
    return row(this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
  }

  pendingByModel(now) {
    return this.db
      .prepare(`SELECT model, COUNT(*) AS count, MIN(created_at) AS oldest FROM jobs
                WHERE status = 'pending' AND next_run_at <= ? GROUP BY model ORDER BY model`)
      .all(now)
      .map((r) => ({ model: r.model, count: r.count, oldest: r.oldest }));
  }

  claim(model, now) {
    const r = this.db
      .prepare(`SELECT id FROM jobs WHERE status = 'pending' AND model = ? AND next_run_at <= ?
                ORDER BY priority DESC, created_at ASC LIMIT 1`)
      .get(model, now);
    if (!r) return null;
    this.db
      .prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?")
      .run(now, r.id);
    return this.get(r.id);
  }

  complete(id, result, now) {
    this.db
      .prepare("UPDATE jobs SET status = 'done', result = ?, error = NULL, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(result), now, id);
  }

  // attempts counts claims; after the first failure there are retryDelaysMs.length retries.
  fail(id, error, now, retryDelaysMs) {
    const { attempts } = this.db.prepare("SELECT attempts FROM jobs WHERE id = ?").get(id);
    const delay = retryDelaysMs[attempts - 1];
    if (delay === undefined) {
      this.db.prepare("UPDATE jobs SET status = 'dead', error = ?, updated_at = ? WHERE id = ?").run(String(error), now, id);
      return "dead";
    }
    this.db
      .prepare("UPDATE jobs SET status = 'pending', error = ?, updated_at = ?, next_run_at = ? WHERE id = ?")
      .run(String(error), now, now + delay, id);
    return "pending";
  }

  // A preempted run isn't the job's fault: back to pending, attempt not counted.
  requeue(id, now) {
    this.db
      .prepare("UPDATE jobs SET status = 'pending', attempts = attempts - 1, updated_at = ?, next_run_at = ? WHERE id = ? AND status = 'running'")
      .run(now, now, id);
  }

  recoverRunning(now) {
    return Number(this.db.prepare("UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running'").run(now).changes);
  }

  purge(now, retentionMs) {
    return Number(this.db.prepare("DELETE FROM jobs WHERE status = 'done' AND updated_at < ?").run(now - retentionMs).changes);
  }

  oldestPendingAgeMs(now) {
    const r = this.db.prepare("SELECT MIN(created_at) AS t FROM jobs WHERE status = 'pending'").get();
    return r.t === null ? null : now - r.t;
  }

  counts() {
    const out = { pending: 0, running: 0, done: 0, dead: 0 };
    for (const r of this.db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all()) out[r.status] = r.n;
    return out;
  }
}

module.exports = { Queue };
