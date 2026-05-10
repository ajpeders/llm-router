#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const readline = require("readline");
const { URL } = require("url");

const ROUTER_URL = process.env.LLM_ROUTER_URL || "http://localhost:8080";

function usage() {
  console.error(`Usage: llm-router <command> [options]

Commands:
  status                     Show router health and backend model counts
  models [--backend <name>]  List available models (optionally filter by backend)
  run <model> <prompt>       Send a prompt and stream the response
  chat <model>               Interactive chat session with a model

Options:
  --router <url>   Router base URL (default: LLM_ROUTER_URL or http://localhost:8080)
  --raw            Print raw JSON instead of formatted output (status/models)
  --no-stream      Buffer full response instead of streaming (run)

Examples:
  llm-router status
  llm-router models
  llm-router models --backend mac
  llm-router run llama3.2 "explain recursion in one sentence"
  llm-router chat mistral
`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--router") { args.router = argv[++i]; }
    else if (a === "--backend") { args.backend = argv[++i]; }
    else if (a === "--raw") { args.raw = true; }
    else if (a === "--no-stream") { args.noStream = true; }
    else { args._.push(a); }
    i++;
  }
  return args;
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const reqOptions = {
      method: options.method || "GET",
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: options.headers || {},
    };
    const req = client.request(reqOptions, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function requestStream(url, options = {}, onChunk) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const reqOptions = {
      method: options.method || "POST",
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: options.headers || {},
    };
    const req = client.request(reqOptions, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8")}`)));
        return;
      }
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (line.trim()) {
            try { onChunk(JSON.parse(line)); } catch { /* skip non-JSON */ }
          }
        }
      });
      res.on("end", () => {
        if (buf.trim()) {
          try { onChunk(JSON.parse(buf)); } catch { /* skip */ }
        }
        resolve();
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── commands ──────────────────────────────────────────────────────────────────

async function cmdStatus(router, args) {
  const res = await request(`${router}/health`);
  const data = JSON.parse(res.body);
  if (args.raw) { console.log(JSON.stringify(data, null, 2)); return; }

  const ok = data.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`${ok} Router: ${router}`);
  console.log(`  Tier order: ${data.tier.join(" → ")}`);
  console.log(`  Backends:`);
  for (const [name, count] of Object.entries(data.backends)) {
    const dot = count > 0 ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
    console.log(`    ${dot} ${name.padEnd(12)} ${count} model${count === 1 ? "" : "s"}`);
  }
}

async function cmdModels(router, args) {
  const res = await request(`${router}/api/models/all`);
  const data = JSON.parse(res.body);
  if (args.raw) { console.log(JSON.stringify(data, null, 2)); return; }

  if (args.backend) {
    const models = data.by_backend?.[args.backend];
    if (!models) {
      console.error(`Unknown backend: ${args.backend}`);
      console.error(`Available: ${data.tier.join(", ")}`);
      process.exit(1);
    }
    console.log(`Models on \x1b[1m${args.backend}\x1b[0m (${models.length}):`);
    for (const m of models) console.log(`  ${m}`);
    return;
  }

  console.log(`\x1b[1m${data.total_models}\x1b[0m model${data.total_models === 1 ? "" : "s"} across ${data.tier.length} backend${data.tier.length === 1 ? "" : "s"}\n`);
  for (const backend of data.tier) {
    const models = data.by_backend[backend] || [];
    console.log(`  \x1b[1m${backend}\x1b[0m (${models.length})`);
    for (const m of models) console.log(`    ${m}`);
  }
}

async function cmdRun(router, args) {
  const [, model, ...rest] = args._;
  if (!model || rest.length === 0) {
    console.error("Usage: llm-router run <model> <prompt>");
    process.exit(1);
  }
  const prompt = rest.join(" ");
  const payload = JSON.stringify({ model, prompt, stream: !args.noStream });

  if (args.noStream) {
    const res = await request(`${router}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      body: payload,
    });
    const data = JSON.parse(res.body);
    console.log(data.response ?? JSON.stringify(data, null, 2));
    return;
  }

  process.stdout.write("");
  await requestStream(
    `${router}/api/generate`,
    { headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }, body: payload },
    (chunk) => {
      if (typeof chunk.response === "string") process.stdout.write(chunk.response);
    }
  );
  process.stdout.write("\n");
}

async function cmdChat(router, args) {
  const [, model] = args._;
  if (!model) {
    console.error("Usage: llm-router chat <model>");
    process.exit(1);
  }

  const history = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const prompt = (q) => new Promise((r) => rl.question(q, r));

  console.log(`\x1b[2mChat with \x1b[1m${model}\x1b[0m\x1b[2m via ${router} — Ctrl+C or /quit to exit\x1b[0m\n`);

  while (true) {
    let userInput;
    try { userInput = await prompt("\x1b[1mYou:\x1b[0m "); } catch { break; }
    if (!userInput.trim()) continue;
    if (userInput.trim() === "/quit" || userInput.trim() === "/exit") break;

    history.push({ role: "user", content: userInput });
    const payload = JSON.stringify({ model, messages: history, stream: true });

    process.stdout.write("\x1b[1mAssistant:\x1b[0m ");
    let assistantContent = "";
    try {
      await requestStream(
        `${router}/api/chat`,
        { headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }, body: payload },
        (chunk) => {
          const text = chunk.message?.content ?? "";
          if (text) { process.stdout.write(text); assistantContent += text; }
        }
      );
    } catch (err) {
      console.error(`\n\x1b[31mError: ${err.message}\x1b[0m`);
    }
    process.stdout.write("\n\n");
    if (assistantContent) history.push({ role: "assistant", content: assistantContent });
  }

  rl.close();
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const router = (args.router || ROUTER_URL).replace(/\/$/, "");
  const cmd = args._[0];

  try {
    if (cmd === "status") await cmdStatus(router, args);
    else if (cmd === "models") await cmdModels(router, args);
    else if (cmd === "run") await cmdRun(router, args);
    else if (cmd === "chat") await cmdChat(router, args);
    else usage();
  } catch (err) {
    console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

main();
