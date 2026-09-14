#!/usr/bin/env node
// Thin CLI wrapper for Sber GigaChat — called by dex as a provider (paid; money-guarded in dex.mjs).
// Usage:
//   gigachat-cli.mjs --version   → print version
//   gigachat-cli.mjs             → read prompt from stdin, print response to stdout
// Auth: GIGACHAT_AUTH_KEY = the base64 "Authorization key" from developers.sber.ru/studio. It is
//   exchanged for a ~30-min Bearer token (OAuth, scope GIGACHAT_API_PERS; override GIGACHAT_SCOPE).
// TLS: Sber's certificates chain to the Russian Ministry of Digital root CA (НУЦ Минцифры), which is
//   NOT in Node's trust store. Set GIGACHAT_CA_BUNDLE=<path to .pem> (gosuslugi.ru/crt), or — knowingly
//   unsafe — GIGACHAT_INSECURE=1. Verification is never disabled silently.
// Model: DEX_GIGACHAT_MODEL (default: GigaChat).
import https from "node:https";
import fs from "node:fs";
import crypto from "node:crypto";

const VERSION = "1.0.0";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}

const authKey = process.env.GIGACHAT_AUTH_KEY;
if (!authKey) {
  process.stderr.write("GIGACHAT_AUTH_KEY is not set. Export it to authenticate.\n");
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

const tls = {};
if (process.env.GIGACHAT_CA_BUNDLE) {
  try { tls.ca = fs.readFileSync(process.env.GIGACHAT_CA_BUNDLE); }
  catch (e) {
    process.stderr.write(`gigachat: cannot read GIGACHAT_CA_BUNDLE (${e.message})\n`);
    process.exit(1);
  }
} else if (process.env.GIGACHAT_INSECURE === "1") {
  tls.rejectUnauthorized = false;
}

function request(url, headers, body) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      ...tls,
    }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => resolve({ status: res.statusCode, data: d }));
    });
    req.on("error", (e) => resolve({ status: 0, data: "", err: e }));
    req.write(body);
    req.end();
  });
}

function fail(stage, r) {
  const e = r.err;
  if (e && /certificate|self[- ]signed|issuer|CERT_/i.test(`${e.code || ""} ${e.message}`)) {
    process.stderr.write("gigachat: TLS certificate check failed — install the Минцифры root CA and set " +
      "GIGACHAT_CA_BUNDLE=<path.pem> (gosuslugi.ru/crt), or GIGACHAT_INSECURE=1 (unsafe).\n");
  } else if (e) {
    process.stderr.write(`gigachat ${stage}: network error — ${e.message}\n`);
  } else {
    process.stderr.write(`gigachat ${stage}: HTTP ${r.status}: ${(r.data || "").slice(0, 400)}\n`);
  }
  process.exit(1);
}

const oauth = await request("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", {
  Authorization: `Basic ${authKey}`,
  RqUID: crypto.randomUUID(),
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
}, `scope=${process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS"}`);
if (oauth.status !== 200) fail("oauth", oauth);

let token = "";
try { token = JSON.parse(oauth.data).access_token || ""; } catch {}
if (!token) fail("oauth", { status: oauth.status, data: "no access_token in response" });

const model = process.env.DEX_GIGACHAT_MODEL || "GigaChat";
const chat = await request("https://gigachat.devices.sberbank.ru/api/v1/chat/completions", {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  Accept: "application/json",
}, JSON.stringify({ model, messages: [{ role: "user", content: prompt.trim() }], stream: false }));
if (chat.status !== 200) fail("chat", chat);

let text = "";
try { text = JSON.parse(chat.data)?.choices?.[0]?.message?.content?.trim() || ""; } catch {}
if (!text) {
  process.stderr.write(`gigachat: unexpected response: ${chat.data.slice(0, 300)}\n`);
  process.exit(1);
}

process.stdout.write(text + "\n");
