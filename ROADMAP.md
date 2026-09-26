# Roadmap

## Done

- [x] Pool router + batch queue (2026-09-26): `/v1/*` interactive proxy with
  per-backend/per-model slot leasing, persistent `/jobs` batch queue drained
  model-at-a-time, `/status`, `/idle`. Deployed with env-driven backends,
  `jobs.db` state, and `bin/monitor` alerting on a down backend or a stale
  queue.

## Next

- [ ] **Mac llama-swap backend.** `mac` is already in `BACKENDS_JSON` but has
  no llama-swap set up yet — bring it up so the router has a real second
  backend, not just luna.
- [ ] **Raise luna's `qwen3-coder:30b` to `--parallel 2`.** Currently 1 slot;
  a batch job can never get a slot alongside an interactive one on it (see
  `Pool.batchServable`'s `capacity - 1 > 0` guard).
- [ ] **Pilot clients**: point watcher, jobsearch, digest, and Hermes at the
  router's `/v1` and `/jobs` instead of hitting a backend directly.
- [ ] **Migrate the remaining Ollama-API consumers** off `/api/generate` /
  `/api/chat` onto `/v1/chat/completions` — the router no longer proxies
  Ollama-native routes.
- [ ] **Traefik repoint of `llm.thelunadog.com`** to this router — blocked on
  lunabot, which still calls `/api/*` (`apps/discordbot/services/llm.py`) and
  needs to move to `/v1` first.

## Older backlog

- [ ] Universalize the README / docs / code for outside users: document setup
  from scratch on generic infrastructure, replace homelab-specific assumptions
  (private hostnames, LAN addresses, personal paths and defaults) with
  env-driven configuration plus examples, and keep the public GitHub mirror
  directly runnable.
