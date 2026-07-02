#!/usr/bin/env node
// Thin CLI wrapper for Google Generative AI REST API — called by dex as a provider.
// Usage:
//   gemini-api-cli.mjs --version   → print version
//   gemini-api-cli.mjs             → read prompt from stdin, print response to stdout
// Auth: GEMINI_API_KEY env var (free at aistudio.google.com).
// Model: DEX_GEMINI_API_MODEL env var (default: gemini-2.0-flash).
import https from "node:https";

const VERSION = "1.0.0";

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) {
  process.stderr.write("GEMINI_API_KEY is not set. Get a free key at aistudio.google.com.\n");
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

const model = process.env.DEX_GEMINI_API_MODEL || "gemini-2.0-flash";

const body = JSON.stringify({
  contents: [{ role: "user", parts: [{ text: prompt.trim() }] }],
  generationConfig: { temperature: 0.7 },
});

const path = `/v1beta/models/${model}:generateContent?key=${apiKey}`;

function once() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => { d += c; });
        res.on("end", () => resolve({ status: res.statusCode, data: d }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Small jitter to avoid burst rate-limits, then up to 2 retries on transient
// 429/503. A hard-blocked key (free-tier limit:0) still fails → provider is
// simply excluded from the debate by the caller (ok:false).
await sleep(500 + Math.random() * 1500);
let status, data;
for (let attempt = 0; attempt < 3; attempt++) {
  ({ status, data } = await once());
  if (status !== 429 && status !== 503) break;
  if (attempt < 2) await sleep(3000 * (attempt + 1) + Math.random() * 1000);
}

if (status !== 200) {
  process.stderr.write(`Gemini API error (HTTP ${status}): ${data}\n`);
  process.exit(1);
}

let parsed;
try { parsed = JSON.parse(data); }
catch (e) {
  process.stderr.write(`Failed to parse Gemini response: ${e.message}\n`);
  process.exit(1);
}

const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
if (!text) {
  process.stderr.write(`Unexpected Gemini response: ${data}\n`);
  process.exit(1);
}

process.stdout.write(text + "\n");
