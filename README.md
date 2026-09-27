# llm-router

Node.js pool router in front of one or more OpenAI-API-compatible LLM
backends (llama-swap, Ollama). It load-balances and fails over between
backends per model, and adds a persistent batch job queue (`/jobs`) for
non-interactive work that shouldn't compete with live chat traffic.

Includes `rllm` — a minimal CLI for one-shot prompts, chat, and code
assistance.

---

## Router

### Setup

```bash
node router.js
```

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Listen port |
| `BACKENDS_JSON` | *(required)* | Backend name → base URL, e.g. `{"luna":"http://100.84.247.20:11434","mac":"http://192.168.0.47:11434"}`. Same model IDs must exist on every backend that serves them; their context sizes may differ (requests are routed by size). |
| `DEFAULT_SLOTS` | `2` | Slot count assumed for a model until its backend reports `/upstream/<model>/slots` (llama-swap only) |
| `POLL_MS` | `10000` | Backend poll interval |
| `POLL_TIMEOUT_MS` | `4000` | Per-poll timeout |
| `DOWN_AFTER_FAILS` | `3` | Consecutive failed polls before a backend is marked down |
| `FIRST_BYTE_TIMEOUT_MS` | `120000` | Interactive-lane timeout waiting for the first response byte (streaming requests only) |
| `NONSTREAM_TIMEOUT_MS` | `1800000` | Interactive-lane timeout for a request with `stream != true` — its headers only arrive once generation is fully done, so it needs the same long cap as a batch job |
| `IDLE_TIMEOUT_MS` | `60000` | Stream idle timeout (interactive and batch) |
| `IDLE_WINDOW_MS` | `120000` | Quiet window with no real requests before `/idle` reports idle |
| `BATCH_HOLDOFF_MS` | `600000` | Batch is paused while any interactive `/v1` request is in flight and until this long after the last one |
| `BATCH_TIMEOUT_MS` | `1800000` | Total cap for a batch job's run (non-streaming, so this is the real ceiling) |
| `WAIT_TIMEOUT_MS` | `600000` | How long an interactive request waits for a free slot before failing |
| `DB_PATH` | `/data/jobs.db` | SQLite path for the job queue |
| `OLDEST_OVERRIDE_MS` | `1800000` | Age at which the drainer force-switches to the oldest starved model |
| `DRAIN_MAX_MS` | `600000` | Max time the drainer sticks to one model before re-picking |
| `DONE_RETENTION_MS` | `604800000` | How long a `done`/`dead` job row is kept before purge |
| `NTFY_URL` | *(unset)* | ntfy topic URL for dead-job alerts |
| `NTFY_TOKEN` | *(unset)* | ntfy auth token |

### Docker

```bash
docker compose up -d llm-router
```

Config lives in `homelab/apps/llm-router/.env` (see `.env.example`); job
queue state persists in the mounted `state/llm-router/jobs.db`.

### Architecture in one paragraph

The router keeps a live pool of backends (`src/pool.js`), polled on an
interval (`src/discovery.js`) for their model list, loaded model (when the
backend is llama-swap and reports `/running`), and per-model slot counts.
Every request needing a backend goes through a leaser (`src/lease.js`) that
acquires a slot for `(backend, model)`; interactive requests get priority
over the batch lane when both want the same slot. Interactive traffic
(`/v1/*`) is proxied straight through, streamed, with a slot held for the
duration. Batch traffic goes through `/jobs`, is persisted to SQLite
(`src/queue.js`), and worked off model-by-model by a drainer
(`src/drain.js`) so a big model loads once per drain window, not once per
job.

**Context-aware routing.** The same model can run with different
`--ctx-size` on different backends (luna's `qwen3.6:35b-a3b` is 98k, the mac's
is smaller). Discovery reads each loaded model's per-slot `n_ctx` from
llama-server's `/slots` and re-reads it whenever llama-swap reports a changed
launch command. A request (interactive or batch) whose estimated size — JSON
characters ÷ 3, deliberately high — exceeds a backend's context skips that
backend and waits for one that fits; if none is known to fit, it goes to the
largest. `/status` shows each backend's `ctx`.

**Interactive always wins.** Batch jobs queue up and wait while no backend
can serve their model, and run once one can — but only while the
interactive lane is quiet: no interactive `/v1` request in flight and none
within `BATCH_HOLDOFF_MS` (default 10 min). While quiet, batch may use every
slot, including a 1-slot model's only one. An interactive request arriving
mid-batch **preempts** it: every running batch job is aborted and requeued
as `pending` (the aborted run doesn't count toward its retries), the request
gets the slot immediately, and batch stays paused until the holdoff has
elapsed since the *last* interactive request. The trade-off is that the
aborted jobs' partial generation is thrown away and redone later. `/status`
reports `batch_paused`.

Automation that submits `/jobs` (e.g. Hermes) never pauses the queue. If it
also calls `/v1/*` directly for work that isn't urgent, tag those calls
`x-llm-router-batch: 1` so they don't count as interactive either.

### API

```bash
# health + backend/tier summary
curl http://localhost:8080/health

# merged model list (OpenAI-style)
curl http://localhost:8080/v1/models

# interactive chat (OpenAI-compatible)
curl http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3:8b","messages":[{"role":"user","content":"what is a mutex"}]}'

# submit a batch job (returns immediately with an id)
curl -X POST http://localhost:8080/jobs \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3:8b","request":{"messages":[{"role":"user","content":"say ok"}]}}'

# poll a job
curl http://localhost:8080/jobs/<id>

# pool + queue status
curl http://localhost:8080/status
```

Interactive (`/v1/*`) responses include an `x-llm-router-backend` header
indicating which backend handled the request. A request that wants to run
batch-shaped work directly against `/v1/*` (bypassing the queue) but not
count against `/idle`'s quiet window should send `x-llm-router-batch: 1`.

**`POST /jobs` body:** `{model: string, request: object, priority?: number,
callback?: string, dedupe_key?: string}`. `request` is the OpenAI-style
request body (`messages` for chat, `input` for embeddings — detected by
which field is present). `dedupe_key` collapses a resubmit of the same
logical job while one with that key is `pending`/`running`. `callback`, if
given, is POSTed the finished job on completion.

**Job lifecycle:** `pending` → `running` → `done` or, after retrying through
`retryDelaysMs` (30s, 2m, 10m), `dead`.

### `/status`

```json
{
  "backends": [{"name": "luna", "up": true, "down_since": null, "models": [...], "loaded": [...], "slots": {...}, "inflight": {...}}],
  "queue": {"counts": {"pending": 0, "running": 0, "done": 1, "dead": 0}, "by_model": [...], "oldest_pending_age_s": null},
  "draining": null
}
```

### `/idle`

```bash
curl http://localhost:8080/idle
```

Returns `{ idle, inFlight, idleSeconds, quietWindowMs }` — true once no
interactive request is in flight and none has arrived for `IDLE_WINDOW_MS`.
Batch traffic (through `/jobs`, or `/v1/*` tagged `x-llm-router-batch: 1`)
never counts toward this, so a batch consumer polling its own work doesn't
mask true idleness.

---

## rllm

Minimal CLI for interacting with the router.

### Install

```bash
ln -s /path/to/llm-router/rllm ~/.local/bin/rllm
```

### Usage

```bash
# one-shot prompt (auto-picks best available model)
rllm "explain what a goroutine is"

# pin a model
rllm -m qwen3:8b "explain what a goroutine is"

# pipe input
cat error.log | rllm "what is causing this?"
git diff | rllm "summarize these changes"

# list models across all backends
rllm models

# plain chat
rllm chat
rllm chat -m qwen3:8b

# code assistant
rllm code                          # interactive, no context
rllm code router.js                # load a file
rllm code src/                     # load a directory
rllm code router.js cli.js         # multiple files/dirs
rllm code router.js "how does failover work?"  # one-shot with file context
```

**Inside a chat session:**

```
/file <path>     load a file into context
/clear           reset conversation history
/model <name>    switch model mid-session
/quit            exit
```

**Environment variables:**

```bash
export LLM_ROUTER_URL=http://localhost:8080  # router address (default)
export RLLM_MODEL=qwen2.5-coder:14b         # pin a default model
```

### How model selection works

Without `RLLM_MODEL` set, `rllm` fetches the model list from `/v1/models`
and picks the one with the highest parameter count in its name (e.g.
`qwen3:32b` beats `qwen3:8b`). Override with `-m` or `RLLM_MODEL`.
