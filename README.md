# llm-router

Lightweight proxy that load-balances requests across multiple [Ollama](https://ollama.com) backends. Routes to the backend that has the requested model, retries on failure, and exposes a merged model list across all machines.

Includes `rllm` — a minimal CLI for one-shot prompts, chat, and code assistance.

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
| `BACKENDS_JSON` | `{"mac":"http://192.168.0.47:11434","arch":"http://192.168.0.40:11434"}` | Backend name → Ollama URL |
| `BACKEND_TIER` | `mac,arch` | Priority order (comma-separated) |
| `MODEL_REFRESH_MS` | `30000` | How often to poll backends for models |
| `TAGS_TIMEOUT_MS` | `4000` | Timeout for model list fetch |
| `REQUEST_TIMEOUT_MS` | `300000` | Proxy request timeout |
| `MINIMAX_API_KEY` | *(unset)* | Enables MiniMax cloud backend for `/v1/chat/completions` |
| `MINIMAX_MODEL` | `MiniMax-Text-01` | Model sent to MiniMax (overrides the request's model) |
| `MINIMAX_API_BASE` | `https://api.minimax.chat/v1` | MiniMax OpenAI-compatible base URL |
| `MINIMAX_PRIORITY` | `fallback` | `fallback` (after local) or `primary` (before local) |
| `IDLE_WINDOW_MS` | `120000` | Quiet window (ms) with no real requests before `/idle` reports idle |

**Adding machines:**

```bash
BACKENDS_JSON='{"mac":"http://192.168.0.47:11434","arch":"http://192.168.0.40:11434","gpu":"http://192.168.0.55:11434"}' \
BACKEND_TIER=gpu,mac,arch \
node router.js
```

### Docker

```bash
docker compose up -d llm-router
```

Config lives in `homelab/services/llm-router/.env`.

### API

The router is a transparent Ollama proxy — any Ollama-compatible client works.

```bash
# health + backend status
curl http://localhost:8080/health

# merged model list across all backends
curl http://localhost:8080/api/models/all

# generate
curl http://localhost:8080/api/generate \
  -d '{"model":"qwen3:8b","prompt":"what is a mutex","stream":false}'

# chat
curl http://localhost:8080/api/chat \
  -d '{
    "model": "qwen3:8b",
    "stream": false,
    "messages": [
      {"role": "system", "content": "you are a code assistant"},
      {"role": "user", "content": "what is a mutex"}
    ]
  }'
```

**From code:**

```python
import ollama
client = ollama.Client(host="http://localhost:8080")
res = client.chat(model="qwen3:8b", messages=[{"role":"user","content":"hello"}])
```

```js
import { Ollama } from "ollama";
const ollama = new Ollama({ host: "http://localhost:8080" });
const res = await ollama.chat({ model: "qwen3:8b", messages: [{ role: "user", content: "hello" }] });
```

```bash
# ollama CLI
OLLAMA_HOST=http://localhost:8080 ollama run qwen3:8b
```

Responses include an `x-llm-router-backend` header indicating which machine handled the request.

### Idle endpoint

```bash
curl http://localhost:8080/idle
```

Returns `{ idle, inFlight, idleSeconds, quietWindowMs }`, reflecting whether the router has had no real requests in flight or received recently within `IDLE_WINDOW_MS`. Requests sent with header `x-llm-router-batch: 1` are excluded from idle tracking, so a batch-job consumer polling its own traffic doesn't mask true idleness.

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

Without `RLLM_MODEL` set, `rllm` fetches the model list from the router and picks the one with the highest parameter count in its name (e.g. `qwen3:32b` beats `qwen3:8b`). Override with `-m` or `RLLM_MODEL`.
