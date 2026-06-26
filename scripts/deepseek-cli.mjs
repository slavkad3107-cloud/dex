#!/usr/bin/env node
// Thin CLI wrapper for DeepSeek API — designed to be called by gavel.mjs as a provider.
// Usage:
//   deepseek-cli.mjs --version        → print version
//   deepseek-cli.mjs                  → read prompt from stdin, print response to stdout
// Auth: DEEPSEEK_API_KEY env var.
// Model: GAVEL_DEEPSEEK_MODEL env var (default: deepseek-chat).
import https from "node:https";

const VERSION = "1.0.0";

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  process.stderr.write("DEEPSEEK_API_KEY is not set. Export it to authenticate.\n");
  process.exit(1);
}

let prompt = "";
process.stdin.setEncoding("utf8");
await new Promise((resolve) => {
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", resolve);
  process.stdin.on("error", resolve);
});

if (!prompt.trim()) {
  process.stderr.write("No prompt received on stdin.\n");
  process.exit(1);
}

const model = process.env.GAVEL_DEEPSEEK_MODEL || "deepseek-chat";

const body = JSON.stringify({
  model,
  messages: [{ role: "user", content: prompt.trim() }],
  stream: false,
});

const { status, data } = await new Promise((resolve, reject) => {
  const req = https.request(
    {
      hostname: "api.deepseek.com",
      path: "/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, data }));
    }
  );
  req.on("error", reject);
  req.write(body);
  req.end();
});

if (status !== 200) {
  process.stderr.write(`DeepSeek API error (HTTP ${status}): ${data}\n`);
  process.exit(1);
}

let parsed;
try { parsed = JSON.parse(data); }
catch (e) {
  process.stderr.write(`Failed to parse DeepSeek response: ${e.message}\n`);
  process.exit(1);
}

const text = parsed?.choices?.[0]?.message?.content;
if (!text) {
  process.stderr.write(`Unexpected DeepSeek response: ${data}\n`);
  process.exit(1);
}

process.stdout.write(text + "\n");
