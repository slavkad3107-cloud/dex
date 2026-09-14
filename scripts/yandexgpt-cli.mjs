#!/usr/bin/env node
// Thin CLI wrapper for YandexGPT (Yandex Cloud Foundation Models) — called by dex as a provider
// (paid; money-guarded in dex.mjs).
// Usage:
//   yandexgpt-cli.mjs --version   → print version
//   yandexgpt-cli.mjs             → read prompt from stdin, print response to stdout
// Auth: YANDEX_API_KEY (service-account API key) + YANDEX_FOLDER_ID (cloud folder id).
// Model: DEX_YANDEX_MODEL (default: yandexgpt-lite/latest) → modelUri gpt://<folder>/<model>.
// NOTE: not OpenAI-shaped — messages use `text`, the answer is result.alternatives[0].message.text.
import https from "node:https";

const VERSION = "1.0.0";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}

const apiKey = process.env.YANDEX_API_KEY;
const folder = process.env.YANDEX_FOLDER_ID;
if (!apiKey || !folder) {
  process.stderr.write("YANDEX_API_KEY and YANDEX_FOLDER_ID must both be set.\n");
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

const model = process.env.DEX_YANDEX_MODEL || "yandexgpt-lite/latest";

const body = JSON.stringify({
  modelUri: `gpt://${folder}/${model}`,
  completionOptions: { stream: false, temperature: 0, maxTokens: "8000" },
  messages: [{ role: "user", text: prompt.trim() }],
});

const { status, data, err } = await new Promise((resolve) => {
  const req = https.request(
    {
      hostname: "llm.api.cloud.yandex.net",
      path: "/foundationModels/v1/completion",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Api-Key ${apiKey}`,
        "x-folder-id": folder,
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => resolve({ status: res.statusCode, data: d }));
    }
  );
  req.on("error", (e) => resolve({ status: 0, data: "", err: e }));
  req.write(body);
  req.end();
});

if (status === 0) {
  process.stderr.write(`yandexgpt: network error — ${err?.message}\n`);
  process.exit(1);
}
if (status !== 200) {
  process.stderr.write(`YandexGPT API error (HTTP ${status}): ${data.slice(0, 400)}\n`);
  process.exit(1);
}

let text = "";
try { text = JSON.parse(data)?.result?.alternatives?.[0]?.message?.text?.trim() || ""; } catch {}
if (!text) {
  process.stderr.write(`yandexgpt: unexpected response: ${data.slice(0, 300)}\n`);
  process.exit(1);
}

process.stdout.write(text + "\n");
