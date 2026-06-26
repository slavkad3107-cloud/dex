#!/usr/bin/env node
// Thin CLI wrapper for the Cohere v2 Chat API — called by gavel.mjs as a provider.
// Usage:
//   cohere-cli.mjs --version        → print version
//   cohere-cli.mjs                  → read prompt from stdin, print response to stdout
// Auth: COHERE_API_KEY env var (free trial key at dashboard.cohere.com).
// Model: GAVEL_COHERE_MODEL env var (default: command-a-03-2025).
// NOTE: Cohere is NOT OpenAI-shaped — the v2 response nests content as an ARRAY of blocks
// (message.content[].text), so it needs this dedicated parser, not the generic openai-compat wrapper.
import https from "node:https";

const VERSION = "1.0.0";

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}

const apiKey = process.env.COHERE_API_KEY;
if (!apiKey) {
  process.stderr.write("COHERE_API_KEY is not set. Export it to authenticate.\n");
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

const model = process.env.GAVEL_COHERE_MODEL || "command-a-03-2025";

const body = JSON.stringify({
  model,
  messages: [{ role: "user", content: prompt.trim() }],
  stream: false,
});

const { status, data } = await new Promise((resolve, reject) => {
  const req = https.request(
    {
      hostname: "api.cohere.com",
      path: "/v2/chat",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
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

if (status !== 200) {
  process.stderr.write(`Cohere API error (HTTP ${status}): ${data}\n`);
  process.exit(1);
}

let parsed;
try { parsed = JSON.parse(data); }
catch (e) {
  process.stderr.write(`Failed to parse Cohere response: ${e.message}\n`);
  process.exit(1);
}

// v2 chat: message.content is an array of typed blocks; concatenate the text blocks.
const blocks = parsed?.message?.content;
const text = Array.isArray(blocks)
  ? blocks.filter((b) => b && b.type === "text").map((b) => b.text).join("").trim()
  : "";
if (!text) {
  process.stderr.write(`Unexpected Cohere response: ${data}\n`);
  process.exit(1);
}

process.stdout.write(text + "\n");
