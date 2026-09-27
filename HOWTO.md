# HOWTO

Step-by-step guides for common tasks. See README.md for the full env var
reference and API examples, ARCHITECTURE.md for how the pool and queue work.

## Run the router locally

```bash
BACKENDS_JSON='{"luna":"http://100.84.247.20:11434"}' node router.js
```

`BACKENDS_JSON` is required — there's no built-in default. Check it came up:

```bash
curl http://localhost:8080/health
```

## Add or remove a backend machine

Set `BACKENDS_JSON` to the full map of backend name → base URL, and restart
the router (it re-reads env at startup only):

```bash
BACKENDS_JSON='{"luna":"http://100.84.247.20:11434","mac":"http://192.168.0.47:11434"}' \
node router.js
```

Every backend in `BACKENDS_JSON` is polled and used — there's no separate
priority list; `pick.js` chooses among up backends that report the model and
have a free slot.

## Deploy with Docker Compose

1. Copy `.env.example` to `.env` and fill in your domain and backends:
   ```bash
   cp .env.example .env
   ```
2. Start it:
   ```bash
   docker compose up -d --no-deps --build llm-router
   ```
   `--dry-run` first is worth doing on a shared compose file — confirm it
   only touches `llm-router`.
3. Confirm it's serving:
   ```bash
   curl https://<LLM_ROUTER_DOMAIN>/health
   ```

Only `router.js` + `src/` run in the container — `rllm` and `cli.js` are for
use on a client machine, not something you deploy. Job queue state
(`jobs.db`) persists in the bind-mounted `state/llm-router/` — it survives a
container recreate.

## Install and use `rllm`

```bash
ln -s /path/to/llm-router/rllm ~/.local/bin/rllm
export LLM_ROUTER_URL=http://localhost:8080   # or your deployed router URL
```

Common invocations:

```bash
rllm "explain what a goroutine is"        # one-shot, auto-picks best model
rllm -m qwen3:8b "explain a goroutine"    # pin a model
cat error.log | rllm "what's wrong here?" # pipe input in
rllm models                                # list models across all backends
rllm chat                                  # interactive chat
rllm code src/                             # load a directory as context, then chat
rllm code router.js "how does failover work?"  # one-shot with file context
```

Pin a default model so you don't rely on the auto-picker:

```bash
export RLLM_MODEL=qwen2.5-coder:14b
```

Inside a `chat`/`code` session: `/file <path>` to load more context,
`/clear` to reset history, `/model <name>` to switch models, `/quit` to
exit.

## Check the router

```bash
curl http://localhost:8080/v1/models   # merged model list across all backends
curl http://localhost:8080/health      # tier + per-backend model counts
curl http://localhost:8080/status      # full pool + queue snapshot
```

Chat completion, end to end:

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3:8b","messages":[{"role":"user","content":"say ok"}]}'
```

## Submit a batch job

```bash
ID=$(curl -s -X POST http://localhost:8080/jobs \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3:8b","request":{"messages":[{"role":"user","content":"say ok"}]}}' \
  | sed -E 's/.*"id":"([^"]+)".*/\1/')

# poll until done
until curl -s http://localhost:8080/jobs/$ID | grep -q '"status":"done"'; do sleep 2; done
curl http://localhost:8080/jobs/$ID
```

Add `"priority": 1` to jump ahead of same-model jobs at the default priority,
`"dedupe_key": "..."` to collapse duplicate resubmits while one is still
`pending`/`running`, or `"callback": "http://..."` to have the finished job
POSTed back instead of polling.

## Let an agent (e.g. Hermes) queue batch work

Have it `POST /jobs` as above — submitting never waits on or disturbs the
interactive lane. Jobs run when their model is servable and nobody has made
an interactive `/v1` request for `BATCH_HOLDOFF_MS` (30 min by default); your
own interactive requests abort running jobs and requeue them. Check whether
batch is currently held off:

```bash
curl -s http://localhost:8080/status | grep -o '"batch_paused":[a-z]*'
```

If the agent also calls `/v1/*` directly for background work, send
`x-llm-router-batch: 1` on those calls, or they will pause the queue like
your own requests do.

## Diagnose a backend that isn't receiving traffic

1. `curl http://localhost:8080/status` — if a backend shows `"up": false`,
   its last `DOWN_AFTER_FAILS` (default 3) polls all failed; `down_since`
   shows when.
2. Check the router's stdout logs for `poll <backend> failed: <error>` —
   this fires every `POLL_MS` (default 10s) until the backend answers again.
3. Confirm the backend is reachable directly:
   ```bash
   curl http://<backend-ip>:11434/v1/models
   ```
4. Once fixed, no restart is needed — the router picks it back up on its
   next poll cycle.

## Check whether the router is idle (for automation gates)

```bash
curl http://localhost:8080/idle
```

`idle: true` means no interactive request is in flight and none has arrived
within `IDLE_WINDOW_MS`. A batch consumer that itself calls `/v1/*` directly
(rather than through `/jobs`) should send `x-llm-router-batch: 1` so its own
traffic doesn't keep `/idle` permanently false.

## Run the CI checks locally

```bash
node --check router.js
node --check cli.js
node --check rllm
node --test 'test/*.test.js'
```
