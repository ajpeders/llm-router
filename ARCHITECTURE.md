# Architecture

## Overview

llm-router is a small Node.js HTTP proxy (`router.js`, no dependencies — uses
only Node core modules and global `fetch`) that sits in front of one or more
Ollama instances and load-balances/fails over between them. Clients talk to
it exactly as they would talk to Ollama; it forwards the request to a backend
machine, retries on failure, and merges each backend's model list into one
view.

Two CLIs ship alongside it:
- `rllm` — the documented, day-to-day CLI (one-shot prompts, chat, code
  assistant with file context).
- `cli.js` — an earlier CLI (`status` / `models` / `run` / `chat` subcommands)
  kept in the repo but not referenced in README or the Dockerfile; not part
  of the documented workflow.

## Components

| File | Role |
|------|------|
| `router.js` | The proxy/router server. Only file shipped in the Docker image. |
| `rllm` | CLI client for the router (prompt, chat, code assistant). |
| `cli.js` | Alternate CLI client (`status`, `models`, `run`, `chat`). Not built into the Docker image, not documented in README. |
| `Dockerfile` | `node:20-alpine`, copies `router.js` only, runs `node router.js`. |
| `docker-compose.yml` | Runs the router behind Traefik (`web` network, TLS via `letsencrypt`, `local-only@file` middleware). |
| `.forgejo/workflows/ci.yml` | CI: no `package.json`/deps, so it just runs `node --check` on `router.js`, `cli.js`, and `rllm`. |

## Data flow

1. A client (Ollama-compatible SDK, `curl`, `rllm`, `cli.js`, ...) sends a
   request to the router (e.g. `POST /api/generate`, `POST /api/chat`).
2. The router reads the full request body and determines the requested
   model, in priority order: JSON body `model` field → `x-model` header →
   `?model=` query param.
3. It builds an ordered list of backends to try (`orderedBackendsForModel`):
   backends currently known to have that model come first (in `BACKEND_TIER`
   order), followed by the rest of the tier order as fallback. If no model
   is given, or no backend currently reports it, the plain tier order is
   used.
4. It proxies the raw request to the first backend (`proxyAttempt`), copying
   headers/body and streaming the upstream response straight through,
   tagging it with `x-llm-router-backend: <name>`.
5. On a 5xx response or connection error, and if it wasn't the last backend
   in the list, it retries the next backend. The final attempt returns
   whatever that backend gives (success, error status, or a synthesized
   `502 all_backends_failed`) regardless of status code.
6. `GET /health` and `GET /api/models/all` (alias `/models/all`) are handled
   directly by the router and never proxied.

## Model discovery

- `refreshModels()` polls every backend's `/api/tags` in parallel on an
  interval (`MODEL_REFRESH_MS`, default 30s) with a per-call timeout
  (`TAGS_TIMEOUT_MS`).
- Each backend's response models are stored as a `Set` of identifiers,
  including both the `model` and `name` fields Ollama returns (covers naming
  differences across Ollama versions).
- A failed poll clears that backend's model set (rather than keeping stale
  data) and logs the error.
- `buildMergedModelsPayload()` merges all backends' sets into a sorted,
  deduplicated list plus a `by_backend` breakdown — this is what
  `/api/models/all` returns and what `rllm`/`cli.js` read to list/pick
  models.

## Key decisions

- **Zero dependencies.** The router only uses Node's `http`/`https`/`url`
  and the global `fetch`; the CI check reflects this (`node --check`, no
  `npm install`).
- **Transparent proxy, not a client wrapper.** Any Ollama-compatible client
  works against the router unmodified — it forwards method, path, headers,
  and body as-is.
- **Retry only on 5xx / transport errors**, never on 4xx — a bad request
  from the client is assumed to be the client's fault, so it isn't
  redistributed across backends.
- **Model-aware routing with graceful fallback.** The router prefers a
  backend that already reports having the requested model (avoids a cold
  pull), but if none do, it still tries the full tier order rather than
  failing outright.
- **Backend list is config, not code.** `BACKENDS_JSON` defines available
  backends; `BACKEND_TIER` only affects ordering/priority — backends left
  out of `BACKEND_TIER` are still used, appended at the end.
- **`rllm`'s "best model" heuristic is purely lexical**: it regexes the
  trailing `<number>b` in a model name (e.g. `qwen3:32b`) and picks the
  highest value when no model is pinned via `-m`/`RLLM_MODEL`. It has no
  awareness of actual capability or backend load.
- **MiniMax is an optional cloud backend, chat-completions only.** Enabled by
  `MINIMAX_API_KEY`. Only `POST /v1/chat/completions` can go there — MiniMax
  speaks the OpenAI API, so Ollama-native `/api/*` routes stay local rather
  than being translated. The request's `model` is rewritten to
  `MINIMAX_MODEL` and the auth header replaced with the MiniMax key. With
  `MINIMAX_PRIORITY=fallback` it's tried last, *except* it goes first when no
  local backend lists the requested model (a local 404 isn't retried, so
  otherwise it would never be reached) or when `MINIMAX_MODEL` is requested
  by name. `primary` always tries it first.

## Deployment

- The Docker image contains only `router.js`; `rllm` and `cli.js` are meant
  to be run/installed on a client machine, not inside the container.
- `docker-compose.yml` exposes the service through Traefik with TLS and a
  `local-only@file` middleware (LAN-only access), matching the router's role
  as an internal homelab service.
- All runtime configuration is environment-variable driven (see README) —
  there is no config file.
