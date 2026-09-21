# HOWTO

Step-by-step guides for common tasks. See README.md for the full env var
reference and API examples.

## Run the router locally

```bash
node router.js
```

Uses the built-in default backends (`mac`, `arch`) unless you override them
(see below). Check it came up:

```bash
curl http://localhost:8080/health
```

## Add or remove a backend machine

Set `BACKENDS_JSON` to the full map of backend name → Ollama base URL, and
restart the router (it re-reads env at startup only):

```bash
BACKENDS_JSON='{"mac":"http://192.168.0.47:11434","arch":"http://192.168.0.40:11434","gpu":"http://192.168.0.55:11434"}' \
node router.js
```

Any backend present in `BACKENDS_JSON` is used, whether or not it's listed
in `BACKEND_TIER`.

## Change backend priority order

Set `BACKEND_TIER` to a comma-separated list of backend names, most
preferred first:

```bash
BACKEND_TIER=gpu,mac,arch node router.js
```

Backends not listed are still usable — they're appended after the named
ones. Priority only matters when a request doesn't specify a model, or when
none of the tiered backends currently report having the requested model.

## Enable MiniMax cloud fallback

Set the key in `.env` (the other `LLM_ROUTER_MINIMAX_*` vars are optional,
see `.env.example`) and redeploy:

```bash
LLM_ROUTER_MINIMAX_API_KEY=your_minimax_key
LLM_ROUTER_MINIMAX_MODEL=MiniMax-Text-01
```

Only OpenAI-style `POST /v1/chat/completions` requests are eligible. Confirm
it's on with `curl http://localhost:8080/health` — the `minimax` field shows
the model and priority (`null` when disabled). Responses served by MiniMax
log as `-> minimax`.

## Deploy with Docker Compose

1. Copy `.env.example` to `.env` and fill in your domain and backends:
   ```bash
   cp .env.example .env
   ```
2. Start it:
   ```bash
   docker compose up -d llm-router
   ```
3. Confirm it's serving:
   ```bash
   curl https://<LLM_ROUTER_DOMAIN>/health
   ```

Only `router.js` runs in the container — `rllm` and `cli.js` are for use on
a client machine, not something you deploy.

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

## Check router health and model availability

```bash
curl http://localhost:8080/health          # per-backend model counts + tier order
curl http://localhost:8080/api/models/all  # merged model list + per-backend breakdown
```

`rllm models` and `cli.js models` both wrap the second call with formatted
output.

## Diagnose a backend that isn't receiving traffic

1. `curl http://localhost:8080/health` — if a backend shows `0` models, its
   last `/api/tags` poll failed or returned nothing.
2. Check the router's stdout logs for `model refresh failed for <backend>
   (<url>): <error>` — this fires every `MODEL_REFRESH_MS` (default 30s)
   until the backend is reachable again.
3. Confirm the backend's Ollama is reachable directly:
   ```bash
   curl http://<backend-ip>:11434/api/tags
   ```
4. Once fixed, no restart is needed — the router picks it back up on its
   next poll cycle.

## Run the CI check locally

There's no build step or dependency install; CI just syntax-checks the
three entrypoints:

```bash
node --check router.js
node --check cli.js
node --check rllm
```
