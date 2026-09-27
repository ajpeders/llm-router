# Architecture

## Overview

llm-router is a Node.js pool router (`router.js` + `src/`, uses `node:sqlite`
and `node:http`/global `fetch`, no npm dependencies) in front of one or more
OpenAI-API-compatible backends (llama-swap, Ollama). It serves two lanes on
top of the same backend pool:

- **Interactive** (`/v1/*`): proxied straight through, streamed, for
  chat/code-assistant clients that need a live answer.
- **Batch** (`/jobs`): a persistent, model-grouped job queue, worked off by a
  drainer that loads one model at a time so a big model isn't reloaded per
  job. Meant for callers that don't need an answer *now* — digest jobs,
  overnight summarization, anything queued by a triage/automation client.

Interactive requests always win a contested slot over batch (see Leaser
below), so batch work never blocks live chat.

Two CLIs ship alongside it:
- `rllm` — the documented, day-to-day CLI (one-shot prompts, chat, code
  assistant with file context), talks to `/v1/*`.
- `cli.js` — an earlier CLI (`status`/`models`/`run`/`chat`), also ported to
  `/v1/*`, kept in the repo and syntax-checked by CI but not the documented
  workflow.

## Components

| File | Role |
|------|------|
| `router.js` | Entry point: builds config, pool, leaser, queue, drainer, server; starts discovery polling and the HTTP listener. |
| `src/config.js` | Reads and validates env into a frozen config object. |
| `src/pool.js` | In-memory backend state: up/down, model sets, loaded model (llama-swap), per-model slot counts, per-model inflight counts. |
| `src/discovery.js` | Polls every backend's `/v1/models` (+ `/running`, `/upstream/<model>/slots` on llama-swap) on an interval; feeds `pool`. |
| `src/lease.js` | `Leaser`: acquires/releases a `(backend, model)` slot; queues waiters when none is free; interactive waiters always resolve before batch waiters. |
| `src/pick.js` | Picks which up backend to try for a model/lane, given current slot capacity and inflight. |
| `src/queue.js` | SQLite-backed job table (`node:sqlite`): submit, claim, complete, fail-with-retry, purge, counts. |
| `src/drain.js` | `Drainer`: picks one model at a time to work off the batch queue, claims jobs, runs them through the pool/leaser, handles retry/dead transitions. |
| `src/upstream.js` | Raw HTTP(S) plumbing: streamed proxy for interactive, buffered JSON call for batch job runs. |
| `src/idle.js` | Tracks in-flight interactive requests + last-activity timestamp for `/idle`. |
| `src/notify.js` | Posts a dead-job alert to ntfy when configured. |
| `src/server.js` | Route table: `/health`, `/idle`, `/v1/models`, `/v1/*` proxy, `/jobs`, `/jobs/:id`, `/status`. |
| `rllm` | CLI client for the router (prompt, chat, code assistant). |
| `cli.js` | Alternate CLI client (`status`, `models`, `run`, `chat`). |
| `Dockerfile` | `node:24-alpine`, copies `router.js` + `src/`, runs `node router.js`. |
| `docker-compose.yml` | Runs the router behind Traefik (`web` network, TLS via `letsencrypt`, `local-only@file` middleware), `init: true` so SIGTERM reaches the node process directly, and a bind mount for `jobs.db`. |
| `.forgejo/workflows/ci.yml` | `node --check` on `router.js`/`cli.js`/`rllm`, then `node --test 'test/*.test.js'`. |

## Data flow

### Interactive (`/v1/*`)

1. A client sends `POST /v1/chat/completions` (or any other `/v1/*` path)
   with a JSON body carrying `model`.
2. The server reads the model, marks idle-tracker activity (unless
   `x-llm-router-batch: 1`), and asks the leaser to `acquire(model,
   "interactive", waitTimeoutMs)`.
3. The leaser asks `pick.js` for a backend that is up, reports (or has never
   disproven) the model, and has a free slot; if none is free right now, the
   request waits up to `WAIT_TIMEOUT_MS` for one to open up.
4. `no_backend` is distinguished into `404 unknown_model` (no backend has
   *ever* reported this model, and at least one poll has succeeded) vs. `503
   backend_down` (every backend that could serve it is down, or we haven't
   polled successfully yet — ambiguous, so it errs toward not lying).
5. On acquire, the request is streamed straight through to the backend
   (`proxyStream`), tagged `x-llm-router-backend: <name>` on the response,
   and the slot is released in a `finally` regardless of outcome.

### Batch (`/jobs`)

1. `POST /jobs` validates `{model, request, priority?, callback?,
   dedupe_key?}`, and inserts a `pending` row (or returns the existing job's
   id if `dedupe_key` matches one still `pending`/`running`).
2. The drainer's `tick()` (called every second and after every job
   completion) does nothing while batch is paused (see Key decisions), and
   otherwise picks one model to work off — the one with the most pending
   jobs, unless something has been waiting past `OLDEST_OVERRIDE_MS`, in
   which case that starved model wins outright — and claims/runs jobs for it
   until no more capacity or no more pending jobs for that model.
3. The drainer never switches models while jobs for the current model are
   still in flight, and won't switch away from an empty model list without a
   window expiring, avoiding an oscillation that would keep reloading the
   backend's resident model.
4. A finished job's result is written back (`done` + `result`), or on
   failure it's retried at `retryDelaysMs` (30s, 2m, 10m) with backoff, going
   `dead` after all three retries are exhausted. A `dead` job with `NTFY_URL`
   configured triggers an ntfy alert.
5. `GET /jobs/:id` returns the full row (status, result/error, attempts,
   timestamps).

### Both lanes

- `GET /status` returns the pool snapshot (per-backend up/down, models,
  loaded model, slots, inflight) plus queue counts, per-model pending
  breakdown, oldest-pending age, and which model (if any) is currently
  draining.
- `GET /health` and `GET /v1/models` are lighter summaries for quick checks.

## Model discovery

- `startDiscovery()` polls every backend's `/v1/models` in parallel every
  `POLL_MS`, skipping a tick if the previous one is still in flight.
- On llama-swap, it also polls `/running` for the currently-loaded model and
  caches `/upstream/<model>/slots` (slot count + min per-slot `n_ctx`) per
  model, keyed on the model's launch `cmd` from `/running` — fetched only while
  the model is ready (fetching it for a non-resident model would itself
  trigger a load on llama-swap), and re-fetched only when the cmd changes
  (someone edited `--parallel`/`--ctx-size`). Cached values keep being
  reported while the model is unloaded, so `pickBackend` can still skip a
  backend whose context is too small for a request. Ollama backends have
  no `/running`; `loaded` stays `null` for them (capacity always known)
  rather than `[]` (would read as "loaded nothing").
- A successful poll is the only thing that can shrink "models we don't yet
  know exist" — a poll *failure* only means the backend is unreachable right
  now, so it must never be conflated with "this model doesn't exist"
  (`pool.polledOnce`/`knownModels` exist specifically to keep those two
  cases apart across a restart before the first poll lands).
- 3 consecutive failed polls (`DOWN_AFTER_FAILS`) mark a backend down;
  `down_since` records when.

## Key decisions

- **Route by context size, pessimistically.** `estimateTokens` (JSON chars ÷ 3,
  tools included) over-estimates on purpose: too high just prefers the
  bigger-context backend; too low sends the request somewhere that returns
  HTTP 400 (this happened: Hermes's 25k-token turns landed on a 16k mac). An
  unknown context is assumed to fit; if nothing is known to fit, the largest
  is tried and the backend has the final word.
- **Zero npm dependencies.** Only Node core modules (`node:sqlite`,
  `node:http`/`https`, global `fetch`) — CI reflects this (`node --check`,
  no install step) plus `node --test` for the actual unit tests.
- **Interactive always outranks batch for a contested slot.** `Leaser.notify`
  resolves interactive waiters before batch waiters regardless of queue
  order, so a live chat request never waits behind a queued batch job.
- **Batch yields to interactive by pausing and preempting, not by sharing.**
  The drainer claims nothing while an interactive request is in flight or
  one arrived within `BATCH_HOLDOFF_MS`, and each untagged interactive
  request calls `Drainer.preempt()`, which aborts in-flight jobs through an
  `AbortController` (dropping the upstream connection stops llama-server
  generating) and `Queue.requeue`s them with the attempt refunded. Because
  batch only ever runs while interactive is quiet, it may use a model's full
  slot count (`batchReserve` still holds one slot back if batch is ever asked
  for while interactive is active).
- **Batch drains one model at a time.** Loading a model onto a backend
  (especially via llama-swap) is expensive; grouping by model amortizes that
  cost across every pending job for it instead of paying it per job.
- **OpenAI API only, no more `/api/*` Ollama-native proxying.** Both
  interactive and batch traffic speak `/v1/chat/completions` /
  `/v1/embeddings` — this is what lets the router treat llama-swap and
  Ollama backends identically.
- **Retry only on backend/transport failure**, not on a 4xx from the model
  request itself — a bad request is the caller's fault and isn't retried
  across backends or requeued.
- **The queue is durable (SQLite, WAL mode), not in-memory.** A router
  restart recovers `running` jobs back to `pending` (`recoverRunning`) rather
  than losing in-flight work.

## Deployment

- The Docker image contains `router.js` + `src/`; `rllm` and `cli.js` are
  meant to be run/installed on a client machine, not inside the container.
- `docker-compose.yml` exposes the service through Traefik with TLS and a
  `local-only@file` middleware (LAN-only access) — matching the router's
  role as an internal homelab service — and mounts `../../state/llm-router`
  to `/data` for `jobs.db`.
- All runtime configuration is environment-variable driven (see README) —
  there is no config file.
- No consumer is pointed at it yet. The Traefik repoint of
  `llm.thelunadog.com` to this router is blocked on lunabot, which still
  calls Ollama-native `/api/*` endpoints (`apps/discordbot/services/llm.py`)
  that this router no longer proxies. Every current LLM consumer still talks
  to luna directly (see ROADMAP).
