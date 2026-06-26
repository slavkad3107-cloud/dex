#!/usr/bin/env node
// Generic OpenAI-compatible chat client — one wrapper for any provider exposing a
// `/chat/completions` endpoint (Groq, OpenRouter, Cerebras, GitHub Models, …). gavel calls it
// through a per-provider shim that hard-codes the flags below; the prompt arrives on stdin.
//
// TRANSPORT: uses `curl`, not node's https. Some Cloudflare-fronted APIs (Groq, Cerebras) block
// node's TLS fingerprint with HTTP 403 while curl passes. curl ships with Windows 10+/macOS/Linux.
// The API key goes in a temp header file (never argv, so it can't leak via the process list).
//
// Flags (set by the shim):
//   --provider <name>        label used in error messages
//   --base <url>             full chat-completions endpoint URL
//   --key-env <ENVVAR>       name of the env var holding the API key
//   --model-env <ENVVAR>     name of the env var that may override the model
//   --default-model <model>  model used when --model-env is unset
//   --version                print version and exit (used by gavel's install probe)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = "1.0.0";

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}

const provider = flag("provider") || "openai-compat";
const base = flag("base");
const keyEnv = flag("key-env");
const modelEnv = flag("model-env");
const defaultModel = flag("default-model");

if (!base || !keyEnv) {
  process.stderr.write(`${provider}: misconfigured wrapper (missing --base/--key-env).\n`);
  process.exit(1);
}

const apiKey = process.env[keyEnv];
if (!apiKey) {
  process.stderr.write(`${keyEnv} is not set. Export it to authenticate ${provider}.\n`);
  process.exit(1);
}

let prompt = "";
process.stdin.setEncoding("utf8");
await new Promise((resolve) => {
  process.stdin.on("data", (c) => { prompt += c; });
  process.stdin.on("end", resolve);
  process.stdin.on("error", resolve);
});

if (!prompt.trim()) {
  process.stderr.write("No prompt received on stdin.\n");
  process.exit(1);
}

const model = (modelEnv && process.env[modelEnv]) || defaultModel;
if (!model) {
  process.stderr.write(`${provider}: no model resolved (set --default-model or ${modelEnv}).\n`);
  process.exit(1);
}

const body = JSON.stringify({
  model,
  messages: [{ role: "user", content: prompt.trim() }],
  stream: false,
});

// Body + auth header live in temp files: body has no secret; the header file holds the key and is
// passed via `-H @file` so the key never appears in curl's argv. Both are deleted in finally.
const stamp = `${process.pid}-${Date.now()}`;
const bodyFile = path.join(os.tmpdir(), `gavel-oai-${stamp}.json`);
const hdrFile = path.join(os.tmpdir(), `gavel-oai-${stamp}.hdr`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function curlOnce() {
  return new Promise((resolve) => {
    const args = [
      "-sS", "-X", "POST", base,
      "-H", "Content-Type: application/json",
      "-H", "Accept: application/json",
      "-H", `@${hdrFile}`,
      "--data-binary", `@${bodyFile}`,
      "-w", "\n%{http_code}",
      "--max-time", "120",
    ];
    const child = spawn("curl", args);
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", (e) => resolve({ status: 0, data: "", err: `curl not found or failed: ${e.message}` }));
    child.on("close", () => {
      const i = out.lastIndexOf("\n");
      const status = i >= 0 ? parseInt(out.slice(i + 1).trim(), 10) || 0 : 0;
      const data = i >= 0 ? out.slice(0, i) : out;
      resolve({ status, data, err });
    });
  });
}

let status, data, err;
try {
  fs.writeFileSync(bodyFile, body);
  fs.writeFileSync(hdrFile, `Authorization: Bearer ${apiKey}\n`);

  // Free models routinely return 429 (upstream rate limit) under parallel panel load. Retry a few
  // times, honoring the OpenRouter retry_after_seconds hint (capped), before giving up.
  const MAX_429_RETRIES = 3, RETRY_CAP_MS = 20000;
  for (let attempt = 0; ; attempt++) {
    ({ status, data, err } = await curlOnce());
    if (status !== 429 || attempt >= MAX_429_RETRIES) break;
    let waitMs = 3000;
    try { const m = JSON.parse(data)?.error?.metadata?.retry_after_seconds; if (m) waitMs = Math.ceil(m * 1000); } catch {}
    waitMs = Math.min(Math.max(waitMs, 1000), RETRY_CAP_MS) + 500;
    process.stderr.write(`${provider}: 429 rate-limited, retry ${attempt + 1}/${MAX_429_RETRIES} in ${Math.round(waitMs / 1000)}s…\n`);
    await sleep(waitMs);
  }
} finally {
  try { fs.unlinkSync(bodyFile); } catch {}
  try { fs.unlinkSync(hdrFile); } catch {}
}

if (status === 0) {
  process.stderr.write(`${provider}: transport error — ${err || "no response from curl"}\n`);
  process.exit(1);
}
if (status !== 200) {
  process.stderr.write(`${provider} API error (HTTP ${status}): ${(data || err).slice(0, 400)}\n`);
  process.exit(1);
}

let parsed;
try { parsed = JSON.parse(data); }
catch (e) {
  process.stderr.write(`${provider}: failed to parse response: ${e.message}\n`);
  process.exit(1);
}

const text = parsed?.choices?.[0]?.message?.content;
if (!text) {
  process.stderr.write(`${provider}: unexpected response: ${data.slice(0, 300)}\n`);
  process.exit(1);
}

process.stdout.write(text + "\n");
