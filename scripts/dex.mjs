#!/usr/bin/env node
// dex — zero-dependency runner that shells out to advisor model CLIs (codex, gemini, …).
// Subcommands: setup | run | fuse. See ../CLAUDE.md for the contracts this implements.
//
// Design notes:
// - Advisors run READ-ONLY; only Claude (the caller) ever writes. Each provider hard-codes a
//   read-only policy and the prompt is always fed over stdin (never argv) — see PROVIDERS.
// - To add a provider, add one entry to PROVIDERS. Everything else (setup/run/fuse, config,
//   panel) is data-driven off that map.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// All bundled wrapper scripts live next to this file.
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

// --- helpers ---------------------------------------------------------------

function firstLines(s, n = 5) {
  return (s || "").trim().split("\n").slice(0, n).join("\n").trim();
}

function errorSnippet(r) {
  return firstLines(r.stderr) || firstLines(r.stdout);
}

// codex prints its real failure as an `ERROR: {json}` line in stderr, below a multi-line banner that
// firstLines() would otherwise return instead. Prefer that line's message so errors (and the model
// fallback's looksLikeModelError check) see the actual cause, not the banner.
function codexError(r) {
  for (const line of (r.stderr || "").split("\n")) {
    const i = line.indexOf("ERROR:");
    if (i === -1) continue;
    const rest = line.slice(i + "ERROR:".length).trim();
    const msg = extractJson(rest)?.error?.message;
    if (msg) return msg;
    if (rest) return rest;
  }
  return errorSnippet(r);
}

function extractJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

// Run a child process; never rejects. Resolves {code, stdout, stderr, timedOut, spawnError}.
// `input`, when provided, is written to the child's stdin (how prompts reach every CLI).
function runCommand(cmd, args, { cwd, timeoutMs, input, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const timer = timeoutMs
      ? setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, timeoutMs)
      : null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) =>
      done({ code: -1, stdout, stderr: stderr || String(err?.message ?? err), timedOut, spawnError: err?.code === "ENOENT" }));
    child.on("close", (code) => done({ code, stdout, stderr, timedOut, spawnError: false }));
    if (input != null) {
      child.stdin.on("error", () => {});
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function probe(bin, args = ["--version"]) {
  const r = await runCommand(bin, args, { timeoutMs: 10000 });
  if (r.spawnError) return { available: false, version: null, semver: null };
  const out = r.stdout || r.stderr || "";
  const m = out.match(/(\d+\.\d+\.\d+)/); // first semver anywhere in the output (not just line 1)
  return { available: true, version: firstLines(out, 1), semver: m ? m[1] : null };
}

// --- provider registry -----------------------------------------------------
// Each provider encapsulates: how to run it READ-ONLY with the prompt on stdin, how to parse its
// output, its default model + model env override, and how to check auth. Add a provider here.

const PROVIDERS = {
  codex: {
    bin: "codex",
    tested: "0.133.0",
    // `-s read-only` is a real OS sandbox, so codex can safely explore the project read-only.
    isolation: "readonly-sandbox",
    // Preferred default; if the account can't use it, runProvider falls back to the codex CLI default.
    defaultModel: "gpt-5.5-pro",
    modelEnv: "DEX_CODEX_MODEL",
    installHint: "install with `npm install -g @openai/codex`",
    authHint: "authenticate with `!codex login`",
    checkAuth() {
      const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      const p = path.join(home, "auth.json");
      return fs.existsSync(p) ? { authed: true, via: p } : { authed: false, via: null };
    },
    async run({ prompt, model, cwd, timeoutMs, env }) {
      const tmp = path.join(os.tmpdir(), `dex-codex-${process.pid}-${Date.now()}.txt`);
      // -s read-only enforces the advisor (no writes); prompt is piped on stdin (never argv).
      // model may be empty (fallback) → omit -m so codex uses its own default model.
      const args = [
        "exec", "--color", "never", "-s", "read-only",
        "--skip-git-repo-check", "--ephemeral",
        "-C", cwd, "-o", tmp,
      ];
      if (model) args.push("-m", model);
      const r = await runCommand("codex", args, { cwd, timeoutMs, input: prompt, env });
      let text = "";
      try { text = fs.readFileSync(tmp, "utf8").trim(); } catch {}
      try { fs.unlinkSync(tmp); } catch {}
      if (r.spawnError) return { ok: false, error: `codex CLI not found — ${this.installHint}, then ${this.authHint}.` };
      if (r.timedOut) return { ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
      if (r.code !== 0) return { ok: false, error: codexError(r) || `codex exited with code ${r.code}` };
      if (!text) text = (r.stdout || "").trim();
      if (!text) return { ok: false, error: "codex returned no output" };
      return { ok: true, text };
    },
  },

  deepseek: {
    bin: "node", bundled: true,
    tested: "1.0.0",
    isolation: "isolated",
    defaultModel: "deepseek-chat",
    modelEnv: "DEX_DEEPSEEK_MODEL",
    installHint: "bundled — set DEEPSEEK_API_KEY to enable (platform.deepseek.com)",
    authHint: "set DEEPSEEK_API_KEY environment variable",
    checkAuth() {
      if (process.env.DEEPSEEK_API_KEY)
        return { authed: true, via: "env (DEEPSEEK_API_KEY)" };
      return { authed: false, via: null };
    },
    async run({ prompt, model, cwd, timeoutMs, env }) {
      const runEnv = { ...env };
      if (model) runEnv.DEX_DEEPSEEK_MODEL = model;
      const r = await runCommand(process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath, [path.join(SCRIPTS_DIR, "deepseek-cli.mjs")], { cwd, timeoutMs, input: prompt, env: runEnv });
      if (r.spawnError) return { ok: false, error: `cannot start node — ${r.spawnError}` };
      if (r.timedOut) return { ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
      if (r.code !== 0) return { ok: false, error: errorSnippet(r) || `deepseek exited with code ${r.code}` };
      const text = (r.stdout || "").trim();
      if (!text) return { ok: false, error: "deepseek returned no output" };
      return { ok: true, text };
    },
  },

  mistral: {
    bin: "node", bundled: true,
    tested: "1.0.0",
    isolation: "isolated",
    defaultModel: "mistral-small-latest",
    modelEnv: "DEX_MISTRAL_MODEL",
    installHint: "bundled — set MISTRAL_API_KEY to enable (console.mistral.ai)",
    authHint: "set MISTRAL_API_KEY environment variable",
    checkAuth() {
      if (process.env.MISTRAL_API_KEY)
        return { authed: true, via: "env (MISTRAL_API_KEY)" };
      return { authed: false, via: null };
    },
    async run({ prompt, model, cwd, timeoutMs, env }) {
      const runEnv = { ...env };
      if (model) runEnv.DEX_MISTRAL_MODEL = model;
      const r = await runCommand(process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath, [path.join(SCRIPTS_DIR, "mistral-cli.mjs")], { cwd, timeoutMs, input: prompt, env: runEnv });
      if (r.spawnError) return { ok: false, error: `cannot start node — ${r.spawnError}` };
      if (r.timedOut) return { ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
      if (r.code !== 0) return { ok: false, error: errorSnippet(r) || `mistral exited with code ${r.code}` };
      const text = (r.stdout || "").trim();
      if (!text) return { ok: false, error: "mistral returned no output" };
      return { ok: true, text };
    },
  },

  cohere: {
    bin: "node", bundled: true,
    tested: "1.0.0",
    isolation: "isolated",
    defaultModel: "command-a-03-2025",
    modelEnv: "DEX_COHERE_MODEL",
    installHint: "bundled — set COHERE_API_KEY to enable (dashboard.cohere.com)",
    authHint: "set COHERE_API_KEY environment variable",
    checkAuth() {
      if (process.env.COHERE_API_KEY)
        return { authed: true, via: "env (COHERE_API_KEY)" };
      return { authed: false, via: null };
    },
    async run({ prompt, model, cwd, timeoutMs, env }) {
      const runEnv = { ...env };
      if (model) runEnv.DEX_COHERE_MODEL = model;
      const r = await runCommand(process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath, [path.join(SCRIPTS_DIR, "cohere-cli.mjs")], { cwd, timeoutMs, input: prompt, env: runEnv });
      if (r.spawnError) return { ok: false, error: `cannot start node — ${r.spawnError}` };
      if (r.timedOut) return { ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
      if (r.code !== 0) return { ok: false, error: errorSnippet(r) || `cohere exited with code ${r.code}` };
      const text = (r.stdout || "").trim();
      if (!text) return { ok: false, error: "cohere returned no output" };
      return { ok: true, text };
    },
  },

  gemini: {
    bin: "gemini",
    tested: "0.46.0",
    // gemini has no OS read-only sandbox and `--approval-mode plan` only blocks edit tools (the model
    // can still write via run_shell_command — verified). So we run it ISOLATED: a throwaway cwd with
    // PWD/OLDPWD/INIT_CWD scrubbed (see runProvider), so it won't discover or make relative/cwd writes
    // to your project. This is NOT a hardened sandbox — gemini still inherits $HOME (needed for auth)
    // and can act on any absolute path it is handed, so don't treat it as a boundary for untrusted
    // input. The run() flags are defense-in-depth + headless plumbing.
    isolation: "isolated",
    // Preferred default; if the account can't use it, runProvider falls back to the gemini CLI default.
    defaultModel: "gemini-3.1-pro",
    modelEnv: "DEX_GEMINI_MODEL",
    installHint: "install with `npm install -g @google/gemini-cli`",
    authHint: "run `!gemini` once to log in (OAuth) or set GEMINI_API_KEY",
    checkAuth() {
      if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY)
        return { authed: true, via: "env (GEMINI_API_KEY/GOOGLE_API_KEY)" };
      const p = path.join(os.homedir(), ".gemini", "oauth_creds.json");
      return fs.existsSync(p) ? { authed: true, via: p } : { authed: false, via: null };
    },
    async run({ prompt, model, cwd, timeoutMs, env }) {
      // --skip-trust unblocks headless mode in the fresh cwd; --approval-mode plan blocks edit tools;
      // prompt is piped on stdin (never argv); --output-format json so we can require a real answer.
      // model may be empty (fallback) → omit -m so gemini uses its own default model.
      const args = ["--skip-trust", "--approval-mode", "plan", "--output-format", "json"];
      if (model) args.push("-m", model);
      const r = await runCommand("gemini", args, { cwd, timeoutMs, input: prompt, env });
      if (r.spawnError) return { ok: false, error: `gemini CLI not found — ${this.installHint}, then ${this.authHint}.` };
      if (r.timedOut) return { ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
      const parsed = extractJson((r.stdout || "").trim()) || extractJson((r.stderr || "").trim());
      const parsedErr = parsed?.error
        ? (typeof parsed.error === "string" ? parsed.error : (parsed.error.message || JSON.stringify(parsed.error)))
        : null;
      if (parsedErr) return { ok: false, error: parsedErr };
      if (r.code !== 0) return { ok: false, error: errorSnippet(r) || `gemini exited with code ${r.code}` };
      // Require a real JSON answer. Do NOT fall back to raw stdout — that would launder a banner,
      // stats-only output, or an older CLI ignoring --output-format json into a fake [ok] answer.
      const text = typeof parsed?.response === "string" ? parsed.response.trim() : "";
      if (!text) return { ok: false, error: errorSnippet(r) || "gemini did not return a JSON response (the CLI may be too old, or not support --output-format json)" };
      return { ok: true, text };
    },
  },
};

// --- OpenAI-compatible cloud providers -------------------------------------
// Groq, OpenRouter, Cerebras, GitHub Models all speak the OpenAI /chat/completions API, so they
// share ONE wrapper (scripts/openai-compat-cli.mjs) behind per-provider bin shims that hard-code the
// endpoint/key/model. Here we only need the key env (for auth + hints) and the model defaults.
function makeOpenAiProvider({ bin, base, defaultModel, modelEnv, keyEnv, signupUrl, expectFree = false }) {
  return {
    bin: "node", bundled: true,
    tested: "1.0.0",
    isolation: "isolated",
    defaultModel,
    modelEnv,
    // expectFree: this provider is meant to use only OpenRouter `:free` models. A money guard below
    // refuses any model without the `:free` suffix (override with DEX_ALLOW_PAID=1) so a mistaken
    // config edit can never silently route to a paid model. setup also warns about it.
    expectFree,
    installHint: `bundled — set ${keyEnv} to enable (${signupUrl})`,
    authHint: `set ${keyEnv} environment variable`,
    checkAuth() {
      if (process.env[keyEnv]) return { authed: true, via: `env (${keyEnv})` };
      return { authed: false, via: null };
    },
    async run({ prompt, model, cwd, timeoutMs, env }) {
      if (expectFree && model && !model.includes(":free") && !process.env.DEX_ALLOW_PAID) {
        return { ok: false, error: `refusing to call "${model}" — not a :free model (money guard). Append ":free", or set DEX_ALLOW_PAID=1 to allow paid models.` };
      }
      const runEnv = { ...env };
      if (model) runEnv[modelEnv] = model;
      const scriptArgs = [
        path.join(SCRIPTS_DIR, "openai-compat-cli.mjs"),
        "--provider", bin, "--base", base,
        "--key-env", keyEnv, "--model-env", modelEnv, "--default-model", defaultModel,
      ];
      const r = await runCommand(process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath, scriptArgs, { cwd, timeoutMs, input: prompt, env: runEnv });
      if (r.spawnError) return { ok: false, error: `cannot start node — ${r.spawnError}` };
      if (r.timedOut) return { ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
      if (r.code !== 0) return { ok: false, error: errorSnippet(r) || `${bin} exited with code ${r.code}` };
      const text = (r.stdout || "").trim();
      if (!text) return { ok: false, error: `${bin} returned no output` };
      return { ok: true, text };
    },
  };
}

const OPENAI_COMPAT = [
  { bin: "groq",     base: "https://api.groq.com/openai/v1/chat/completions",              defaultModel: "llama-3.3-70b-versatile", modelEnv: "DEX_GROQ_MODEL",     keyEnv: "GROQ_API_KEY",     signupUrl: "console.groq.com" },
  { bin: "cerebras", base: "https://api.cerebras.ai/v1/chat/completions",                  defaultModel: "gpt-oss-120b",            modelEnv: "DEX_CEREBRAS_MODEL", keyEnv: "CEREBRAS_API_KEY", signupUrl: "cloud.cerebras.ai" },
  { bin: "ghmodels", base: "https://models.inference.ai.azure.com/chat/completions",       defaultModel: "gpt-4o-mini",             modelEnv: "DEX_GHMODELS_MODEL", keyEnv: "GITHUB_TOKEN",     signupUrl: "github.com/marketplace/models" },
];
for (const c of OPENAI_COMPAT) PROVIDERS[c.bin] = makeOpenAiProvider(c);

// OpenRouter is free and aggregates many models behind ONE key, so register several free flagship
// models as separate panelists — model diversity from a single free signup. They all reuse the one
// `openrouter` shim (bin), each carrying a different default model via the shared model env. Model ids
// verified live (June 2026) — free ids rotate, so re-check at openrouter.ai/models if one 404s; the
// money guard keeps any non-`:free` swap from being billed. NOTE: there is currently NO free *Gemini*
// on OpenRouter — Google's only free model is **Gemma** (`or-gemma`); paid Gemini is blocked by the
// money guard. Different families on purpose (Meta / Qwen / Google / Nvidia / OpenAI) for real debate.
const OPENROUTER_MODELS = {
  "or-llama":    "meta-llama/llama-3.3-70b-instruct:free",
  "or-qwen":     "qwen/qwen3-next-80b-a3b-instruct:free",
  "or-gemma":    "google/gemma-4-31b-it:free",
  "or-nemotron": "nvidia/nemotron-3-ultra-550b-a55b:free",
  "or-gptoss":   "openai/gpt-oss-120b:free",
  "or-coder":    "qwen/qwen3-coder:free",
};
for (const [slug, model] of Object.entries(OPENROUTER_MODELS)) {
  PROVIDERS[slug] = makeOpenAiProvider({
    bin: "openrouter", base: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: model, modelEnv: "DEX_OPENROUTER_MODEL",
    keyEnv: "OPENROUTER_API_KEY", signupUrl: "openrouter.ai", expectFree: true,
  });
}

// --- local Ollama models ---------------------------------------------------
// Each installed Ollama model is registered as its OWN provider, so they appear as separate
// panelists in /dex:fuse and can be compared side by side. Local = fully offline, no API key,
// no geo restrictions. `ollama run <model>` reads the prompt on stdin and prints the answer.
// To add/remove a local model: edit this map to match `ollama list` (key = dex provider slug).
const OLLAMA_MODELS = {
  qwen:          "qwen2.5:7b",
  "qwen-q4":     "qwen2.5:7b-instruct-q4_K_M",
  llama32:       "llama3.2:latest",
  "llama32-3b":  "llama3.2:3b",
  "deepseek-r1": "deepseek-r1:7b",
};

// Call the local Ollama HTTP API (default 127.0.0.1:11434, overridable via OLLAMA_HOST). Using the
// API instead of `ollama run` avoids the TTY redraw control codes the CLI emits even when piped, so
// the advisor text is clean JSON. Never rejects; resolves {ok, text} | {ok:false, error}.
function ollamaGenerate({ model, prompt, timeoutMs }) {
  return new Promise((resolve) => {
    let host = "127.0.0.1", port = 11434;
    const raw = process.env.OLLAMA_HOST;
    if (raw) {
      const m = raw.replace(/^https?:\/\//, "").match(/^([^:]+)(?::(\d+))?/);
      if (m) { host = m[1] || host; if (m[2]) port = Number(m[2]); }
    }
    const body = JSON.stringify({ model, prompt, stream: false });
    const req = http.request(
      { host, port, path: "/api/generate", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => resolve({ status: res.statusCode, data }));
      },
    );
    const timer = timeoutMs ? setTimeout(() => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs) : null;
    req.on("error", (e) => { if (timer) clearTimeout(timer); resolve({ error: e.message }); });
    req.on("close", () => { if (timer) clearTimeout(timer); });
    req.write(body);
    req.end();
  });
}

// Reasoning models (e.g. deepseek-r1) wrap their chain-of-thought in <think>…</think>; strip it so the
// advisor submission is just the answer. If stripping would empty the text, keep the original.
function stripThink(s) {
  const out = (s || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return out || (s || "").trim();
}

function makeOllamaProvider(modelTag) {
  return {
    bin: "ollama",
    tested: "0.30.10",
    // A pure text model with no tool/file access; nothing to sandbox, but keep the safe default.
    isolation: "isolated",
    defaultModel: modelTag,
    modelEnv: null, // model is intrinsic to the provider; resolveModel tolerates a null env name
    installHint: `install from ollama.com, then \`ollama pull ${modelTag}\``,
    authHint: `no key needed — ensure \`ollama serve\` is running and \`${modelTag}\` is pulled`,
    checkAuth() {
      // Local provider: no credentials. The binary existing (installed) is the readiness signal;
      // a stopped server or missing model surfaces as a clear run-time error.
      return { authed: true, via: "local (no key needed)" };
    },
    async run({ prompt, model, timeoutMs }) {
      const m = model || this.defaultModel;
      const r = await ollamaGenerate({ model: m, prompt, timeoutMs });
      if (r.error) return { ok: false, error: `cannot reach Ollama (${r.error}) — is \`ollama serve\` running?` };
      if (r.status !== 200) return { ok: false, error: `ollama API HTTP ${r.status}: ${(r.data || "").slice(0, 200)}` };
      let parsed;
      try { parsed = JSON.parse(r.data); } catch { return { ok: false, error: "ollama API returned non-JSON" }; }
      const text = stripThink(parsed?.response || "");
      if (!text) return { ok: false, error: parsed?.error || `ollama returned no output (is \`${m}\` pulled?)` };
      return { ok: true, text };
    },
  };
}

for (const [slug, tag] of Object.entries(OLLAMA_MODELS)) {
  PROVIDERS[slug] = makeOllamaProvider(tag);
}

const PROVIDER_NAMES = Object.keys(PROVIDERS);

// --- config / settings -----------------------------------------------------
// Precedence (low -> high): defaults < ~/.dex/config.json < ./.dex.json < env < CLI flags.
// Shape: { providers: { <name>: { enabled: bool, model: str } }, panel: [name...], timeout: sec }

const DEFAULT_TIMEOUT_S = 1800;

function loadConfig(cwd) {
  const cfg = { providers: {}, configErrors: [] };
  const sources = [
    path.join(os.homedir(), ".dex", "config.json"),
    path.join(cwd, ".dex.json"),
  ];
  for (const p of sources) {
    let text;
    try { text = fs.readFileSync(p, "utf8"); } catch { continue; } // absent/unreadable: ignore silently
    let raw;
    try { raw = JSON.parse(text); }
    catch (e) { cfg.configErrors.push(`${p}: invalid JSON (${e.message})`); continue; } // surface, don't fail open silently
    if (typeof raw.timeout === "number") cfg.timeout = raw.timeout;
    if (Array.isArray(raw.panel)) cfg.panel = raw.panel;
    if (raw.providers && typeof raw.providers === "object") {
      for (const [k, v] of Object.entries(raw.providers)) {
        cfg.providers[k] = { ...(cfg.providers[k] || {}), ...v };
      }
    }
  }
  return cfg;
}

function isEnabled(name, config) {
  return config.providers?.[name]?.enabled !== false; // enabled unless explicitly disabled
}

// Returns { model, isDefault }. isDefault is true only when the model is our built-in defaultModel
// (no explicit/env/config override) — i.e. the case where runProvider may fall back to the CLI default
// if the account can't use it. An explicitly chosen model is always respected, never swapped.
function resolveModel(name, explicit, config) {
  const p = PROVIDERS[name];
  const override = explicit || process.env[p.modelEnv] || config.providers?.[name]?.model;
  return { model: override || p.defaultModel, isDefault: !override };
}

// Heuristic: does this provider error mean "the requested model isn't usable for this account"?
// Covers codex ("... model is not supported ...") and gemini ("Requested entity was not found.").
function looksLikeModelError(error) {
  const e = error || "";
  return /\b(model|requested entity)\b/i.test(e) &&
    /(not supported|not found|unknown|not available|does not have access|no access|unavailable|invalid)/i.test(e);
}

function resolvePanel(config) {
  const base = Array.isArray(config.panel) && config.panel.length ? config.panel : PROVIDER_NAMES;
  return base.filter((n) => PROVIDERS[n] && isEnabled(n, config));
}

// Per-provider fast-timeout defaults: cloud APIs that typically respond in <5s shouldn't block
// debate/auto rounds for 3 minutes if they hang — a 30s cap surfaces the error quickly.
const FAST_PROVIDERS = new Set(["groq", "cerebras", "ghmodels", "or-llama", "or-qwen", "or-gemma",
  "or-nemotron", "or-gptoss", "or-coder", "mistral", "cohere"]);
const FAST_TIMEOUT_S = 30;

function resolveTimeoutMs(opts, config, providerName) {
  // Explicit flag / env / config always wins. Otherwise use per-provider fast default for cloud APIs.
  const explicit = Number(opts.timeout) || Number(process.env.DEX_TIMEOUT) || config.timeout;
  if (explicit > 0) return explicit * 1000;
  if (providerName && FAST_PROVIDERS.has(providerName)) return FAST_TIMEOUT_S * 1000;
  return DEFAULT_TIMEOUT_S * 1000;
}

function warnConfigErrors(config) {
  for (const e of config.configErrors || []) process.stderr.write(`dex: ignoring invalid config — ${e}\n`);
}

// --- config writing (the `config` subcommand) ------------------------------
// Reads/writes ONE settings file (user ~/.dex/config.json or project ./.dex.json), never the
// merged view — so `set`/`unset` change exactly that scope and leave precedence intact.

function userConfigPath() { return path.join(os.homedir(), ".dex", "config.json"); }
function projectConfigPath(cwd) { return path.join(cwd, ".dex.json"); }

function readConfigFile(p) {
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch { return {}; } // absent → empty (we'll create it)
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`refusing to edit ${p}: it is not valid JSON (${e.message})`); }
}

function writeConfigFile(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

// Map a dotted key to a JSON path + value parser. Returns null for unknown keys.
function configKeySpec(key) {
  if (key === "timeout") return { path: ["timeout"], parse: parseTimeoutValue };
  if (key === "panel") return { path: ["panel"], parse: parsePanelValue };
  const m = key.match(/^([a-z0-9-]+)\.(model|enabled)$/i);
  if (m && PROVIDERS[m[1]]) {
    const jpath = ["providers", m[1], m[2]];
    return { path: jpath, parse: m[2] === "enabled" ? parseBoolValue : (v) => String(v) };
  }
  return null;
}

function configKeyList() {
  return ["timeout", "panel", ...PROVIDER_NAMES.flatMap((n) => [`${n}.model`, `${n}.enabled`])];
}

function parseTimeoutValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`timeout must be a positive number of seconds, got "${v}"`);
  return n;
}

function parseBoolValue(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`expected true or false, got "${v}"`);
}

function parsePanelValue(v) {
  const list = String(v).split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error("panel cannot be empty");
  const bad = list.filter((n) => !PROVIDERS[n]);
  if (bad.length) throw new Error(`unknown provider(s) in panel: ${bad.join(", ")} (valid: ${PROVIDER_NAMES.join(", ")})`);
  return list;
}

function setPath(obj, jpath, value) {
  let o = obj;
  for (let i = 0; i < jpath.length - 1; i++) {
    if (typeof o[jpath[i]] !== "object" || o[jpath[i]] === null) o[jpath[i]] = {};
    o = o[jpath[i]];
  }
  o[jpath[jpath.length - 1]] = value;
}

function unsetPath(obj, jpath) {
  let o = obj;
  for (let i = 0; i < jpath.length - 1; i++) {
    if (typeof o[jpath[i]] !== "object" || o[jpath[i]] === null) return;
    o = o[jpath[i]];
  }
  delete o[jpath[jpath.length - 1]];
}

function parseVersion(s) {
  const m = (s || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versionBelow(actual, min) {
  const a = parseVersion(actual), b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

// Run a provider, isolating it from the user's project unless it declares a hard read-only sandbox.
// Safe default: anything that is NOT "readonly-sandbox" runs in a throwaway temp dir (deleted after)
// with PWD/OLDPWD/INIT_CWD scrubbed, so it can't discover the repo path or make relative/cwd writes.
async function runProvider(name, { prompt, model, isDefault, cwd, timeoutMs }) {
  const p = PROVIDERS[name];

  // Run once; if we're on our built-in default and the account can't use it, retry with the model
  // omitted so the CLI picks its own default. Returns the result tagged with the model actually used.
  const exec = async (runCwd, env) => {
    let res = await p.run({ prompt, model, cwd: runCwd, timeoutMs, env });
    let used = model;
    if (!res.ok && isDefault && model && looksLikeModelError(res.error)) {
      process.stderr.write(`dex: ${name} model "${model}" unavailable (${res.error}); falling back to ${name} CLI default.\n`);
      res = await p.run({ prompt, model: "", cwd: runCwd, timeoutMs, env });
      used = res.ok ? `${name} default` : model;
    }
    return { ...res, model: used };
  };

  if (p.isolation === "readonly-sandbox") {
    return await exec(cwd, process.env);
  }
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), `dex-${name}-`));
  const env = { ...process.env, PWD: tmpCwd };
  delete env.OLDPWD;
  delete env.INIT_CWD;
  try {
    return await exec(tmpCwd, env);
  } finally {
    try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch {}
  }
}

// --- arg + prompt handling -------------------------------------------------

const VALUE_OPTS = new Set([
  "provider", "model", "prompt", "prompt-file", "cwd", "timeout", "samples",
  ...PROVIDER_NAMES.map((n) => `${n}-model`),
]);

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { opts._.push(a); continue; } // positional (config action/key/value)
    const key = a.slice(2);
    if (VALUE_OPTS.has(key)) opts[key] = argv[++i];
    else opts[key] = true; // boolean flag (e.g. --json)
  }
  return opts;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { data += d; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

// Prompt never travels through the shell: it comes from a file (--prompt-file), stdin, or --prompt
// (the last for tests/programmatic use only). Slash commands use --prompt-file via the Write tool.
async function resolvePrompt(opts) {
  if (opts["prompt-file"] != null) {
    try { return fs.readFileSync(opts["prompt-file"], "utf8").trim(); }
    catch (err) { throw new Error(`cannot read --prompt-file: ${err?.message ?? err}`); }
  }
  if (opts.prompt != null) return String(opts.prompt).trim();
  if (!process.stdin.isTTY) return (await readStdin()).trim();
  return "";
}

// --- subcommands -----------------------------------------------------------

async function cmdSetup(opts) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const config = loadConfig(cwd);
  const [node, npm] = await Promise.all([probe("node"), probe("npm")]);

  const providers = {};
  const missingProviders = [];
  const nextSteps = [];
  let anyUsable = false;

  await Promise.all(PROVIDER_NAMES.map(async (name) => {
    const p = PROVIDERS[name];
    const enabled = isEnabled(name, config);
    // Bundled providers (deepseek, mistral, groq, cerebras, openrouter, …) ship as scripts in this
    // package — no external binary to probe. They're always "installed"; only auth (API key) matters.
    const bin = p.bundled
      ? { available: true, version: "bundled", semver: null }
      : await probe(p.bin);
    const auth = p.checkAuth();
    const usable = enabled && bin.available && auth.authed;
    const tooOld = bin.semver ? versionBelow(bin.semver, p.tested) : false;
    const versionUnknown = !p.bundled && bin.available && !bin.semver;
    providers[name] = {
      enabled, installed: bin.available, version: bin.version, semver: bin.semver, tested: p.tested,
      isolation: p.isolation, authed: auth.authed, authVia: auth.via, usable, tooOld, versionUnknown,
      model: resolveModel(name, null, config).model,
    };
    if (!enabled) return;
    if (tooOld) nextSteps.push(`${name}: installed ${bin.semver} is older than tested ${p.tested}; required flags may be unsupported.`);
    else if (versionUnknown) nextSteps.push(`${name}: could not parse its version; ensure it is at least ${p.tested}.`);
    if (usable) { anyUsable = true; return; }
    missingProviders.push(name);
    if (!bin.available) nextSteps.push(`${name}: ${p.installHint}.`);
    else if (!auth.authed) nextSteps.push(`${name}: ${p.authHint}.`);
  }));

  // Money guard: a "free-only" provider (OpenRouter :free models) whose configured model lost its
  // :free suffix could incur charges — surface it loudly (and the run-time guard blocks the call).
  const paidRisk = [];
  for (const name of PROVIDER_NAMES) {
    const p = PROVIDERS[name];
    if (!p.expectFree || !isEnabled(name, config)) continue;
    const m = providers[name].model;
    if (m && !m.includes(":free") && !process.env.DEX_ALLOW_PAID) {
      const w = `${name}: model "${m}" has no :free suffix — it could incur charges (blocked unless DEX_ALLOW_PAID=1). Fix: config set ${name}.model <id>:free`;
      paidRisk.push(w);
      nextSteps.push(w);
    }
  }

  // Readiness reflects whether /dex:fuse can actually run: at least one PANEL member is usable
  // (not merely "some provider somewhere is usable", which could be excluded by the panel/config).
  const panel = resolvePanel(config);
  const panelUsable = panel.filter((n) => providers[n]?.usable);
  const ready = panelUsable.length > 0;
  const degraded = ready && missingProviders.length > 0;

  if (!ready && anyUsable) {
    nextSteps.push("Usable advisors exist but none are in the active panel — fix `panel`/`enabled` in your settings.");
  }
  for (const e of config.configErrors) nextSteps.push(`config: ${e}`);
  if (!nextSteps.length) {
    nextSteps.push(ready ? "Ready — try `/dex:fuse <task>`." : "No advisor is usable yet — install/authenticate at least one above.");
  }

  const report = {
    ready, degraded, node, npm, providers, missingProviders, panel, paidRisk,
    configErrors: config.configErrors,
    timeoutSeconds: resolveTimeoutMs(opts, config) / 1000, nextSteps,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  const mark = (b) => (b ? "✓" : "✗");
  const lines = ["dex setup", "============"];
  lines.push(`node:   ${mark(node.available)} ${node.version || "not found"}`);
  lines.push(`npm:    ${mark(npm.available)} ${npm.version || "not found"}`);
  for (const name of PROVIDER_NAMES) {
    const s = providers[name];
    if (!s.enabled) { lines.push(`${name}: enabled ✗ (disabled in settings — skipped)`); continue; }
    lines.push(
      `${name}: installed ${mark(s.installed)}${s.installed ? ` (${s.version}${s.tooOld ? ` ⚠ older than tested ${s.tested}` : ""})` : ""}` +
      ` · auth ${mark(s.authed)}${s.authVia ? ` (${s.authVia})` : ""}` +
      ` · usable ${mark(s.usable)} · ${s.isolation} · model ${s.model}`,
    );
  }
  lines.push("");
  lines.push(`ready: ${mark(ready)}${degraded ? "  (degraded — some advisors unavailable)" : ""}`);
  lines.push(`panel: ${panel.length ? panel.join(", ") : "(none)"}  ·  timeout ${report.timeoutSeconds}s`);
  if (missingProviders.length) lines.push(`unavailable (enabled): ${missingProviders.join(", ")}`);
  lines.push("");
  lines.push("Next steps:");
  for (const s of nextSteps) lines.push(`- ${s}`);
  process.stdout.write(lines.join("\n") + "\n");
}

async function cmdRun(opts) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const config = loadConfig(cwd);
  warnConfigErrors(config);
  const provider = opts.provider;
  if (!PROVIDERS[provider]) {
    process.stderr.write(`usage: dex run --provider <${PROVIDER_NAMES.join("|")}> --prompt-file <path> [--model M] [--cwd DIR] [--timeout S]\n`);
    process.exit(2);
  }
  if (!isEnabled(provider, config)) {
    process.stderr.write(`error: provider "${provider}" is disabled in settings (enable it in ~/.dex/config.json or ./.dex.json)\n`);
    process.exit(2);
  }
  const prompt = await resolvePrompt(opts);
  if (!prompt) { process.stderr.write("error: no prompt (use --prompt-file, --prompt, or stdin)\n"); process.exit(2); }

  const { model, isDefault } = resolveModel(provider, opts.model, config);
  const timeoutMs = resolveTimeoutMs(opts, config, provider);
  const res = await runProvider(provider, { prompt, model, isDefault, cwd, timeoutMs });
  const result = { provider, model: res.model, ok: res.ok, text: res.ok ? res.text : "", error: res.ok ? null : res.error };

  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else if (result.ok) process.stdout.write(result.text + "\n");
  else process.stderr.write(`error (${provider} · ${model}): ${result.error}\n`);
  process.exit(result.ok ? 0 : 1);
}

function renderFuse(results) {
  const ok = results.filter((r) => r.ok).length;
  const bar = "=".repeat(64);
  const out = [`DEX PANEL — ${ok}/${results.length} model(s) responded`, bar];
  for (const r of results) {
    out.push("", `----- ${r.provider} · ${r.model} · [${r.ok ? "ok" : "error"}] -----`);
    out.push(r.ok ? r.text : `(no answer) ${r.error}`);
  }
  out.push("", bar);
  return out.join("\n") + "\n";
}

async function cmdFuse(opts) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const config = loadConfig(cwd);
  warnConfigErrors(config);
  const prompt = await resolvePrompt(opts);
  if (!prompt) { process.stderr.write("error: no prompt (use --prompt-file, --prompt, or stdin)\n"); process.exit(2); }

  // Only query panel members that are actually authenticated — so providers you've added but not yet
  // keyed (e.g. a fresh cloud signup) are quietly skipped rather than spamming [error] every fuse.
  // Local providers (ollama) report authed:true and are always attempted.
  const fullPanel = resolvePanel(config);
  const panel = fullPanel.filter((n) => PROVIDERS[n].checkAuth().authed);
  const skipped = fullPanel.filter((n) => !PROVIDERS[n].checkAuth().authed);
  if (skipped.length) {
    process.stderr.write(`dex: skipping unauthenticated panel member(s): ${skipped.join(", ")} (add the API key, or run /dex:setup)\n`);
  }
  if (!panel.length) {
    const msg = "No advisor models are enabled/available. Run `/dex:setup`.";
    if (opts.json) process.stdout.write(JSON.stringify({ panel: [], results: [], note: msg }, null, 2) + "\n");
    else process.stdout.write(msg + "\n");
    process.exit(1);
  }

  // Self-consistency (#2): with --samples N>1, query each voice N times. A voice whose N answers
  // disagree on the load-bearing claim is internally UNSTABLE → the judge treats it as low-confidence
  // (so a wobbly weak voice self-demotes); a voice stable across samples is high-confidence. Semantic
  // "do the N answers agree?" is left to the judge — the runner just returns the raw `samples` array.
  const samples = Math.max(1, Math.min(5, Number(opts.samples) || 1));
  const results = await Promise.all(panel.map(async (name) => {
    const { model, isDefault } = resolveModel(name, opts[`${name}-model`], config);
    const timeoutMs = resolveTimeoutMs(opts, config, name);
    if (samples <= 1) {
      const res = await runProvider(name, { prompt, model, isDefault, cwd, timeoutMs });
      return { provider: name, model: res.model, ok: res.ok, text: res.ok ? res.text : "", error: res.ok ? null : res.error };
    }
    const runs = [];
    for (let s = 0; s < samples; s++) runs.push(await runProvider(name, { prompt, model, isDefault, cwd, timeoutMs }));
    const okRuns = runs.filter((r) => r.ok);
    return {
      provider: name, model: (okRuns[0] || runs[0]).model,
      ok: okRuns.length > 0,
      text: okRuns.length ? okRuns[0].text : "",
      error: okRuns.length ? null : (runs[0].error || "no sample ok"),
      samples: runs.map((r) => (r.ok ? r.text : `[err] ${r.error || ""}`)),
    };
  }));

  if (opts.json) process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  else process.stdout.write(renderFuse(results));
  process.exit(results.some((r) => r.ok) ? 0 : 1);
}

const CONFIG_USAGE =
  `usage: dex config show [--json]\n` +
  `       dex config set <key> <value> [--project]\n` +
  `       dex config unset <key> [--project]\n` +
  `keys: ${configKeyList().join(", ")}\n` +
  `--project edits ./.dex.json (this repo); default edits ~/.dex/config.json (all projects).`;

function cmdConfigShow(cwd, opts) {
  const config = loadConfig(cwd);
  warnConfigErrors(config);
  const providers = Object.fromEntries(PROVIDER_NAMES.map((name) => {
    const { model, isDefault } = resolveModel(name, null, config);
    return [name, { enabled: isEnabled(name, config), model, modelIsDefault: isDefault }];
  }));
  const effective = { timeout: resolveTimeoutMs(opts, config) / 1000, panel: resolvePanel(config), providers };

  if (opts.json) {
    process.stdout.write(JSON.stringify(effective, null, 2) + "\n");
    return;
  }

  const userP = userConfigPath(), projP = projectConfigPath(cwd);
  const lines = ["dex config (effective)", "========================="];
  lines.push(`timeout: ${effective.timeout}s`);
  lines.push(`panel:   ${effective.panel.length ? effective.panel.join(", ") : "(none)"}`);
  lines.push("");
  for (const name of PROVIDER_NAMES) {
    const s = providers[name];
    lines.push(`${name}: model ${s.model}${s.modelIsDefault ? " (default — auto-falls-back if unavailable)" : " (pinned — no fallback)"} · enabled ${s.enabled ? "✓" : "✗"}`);
  }
  lines.push("");
  lines.push("Sources (low→high precedence; later overrides earlier):");
  lines.push(`  ~/.dex/config.json  ${fs.existsSync(userP) ? "present" : "absent"}`);
  lines.push(`  ./.dex.json         ${fs.existsSync(projP) ? "present" : "absent"}`);
  lines.push(`  env vars: DEX_TIMEOUT, DEX_CODEX_MODEL, DEX_GEMINI_MODEL`);
  lines.push("");
  lines.push("Change with: dex config set <key> <value>  (add --project for this repo only)");
  lines.push(`  e.g. dex config set timeout 600   ·   dex config set codex.model gpt-5.5`);
  process.stdout.write(lines.join("\n") + "\n");
}

async function cmdConfig(opts) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const [action = "show", key, value] = opts._;

  if (action === "show") return cmdConfigShow(cwd, opts);

  if (action !== "set" && action !== "unset") {
    process.stderr.write(CONFIG_USAGE + "\n");
    process.exit(2);
  }

  if (!key) { process.stderr.write(`error: ${action} needs a key.\n${CONFIG_USAGE}\n`); process.exit(2); }
  const spec = configKeySpec(key);
  if (!spec) { process.stderr.write(`error: unknown key "${key}".\nkeys: ${configKeyList().join(", ")}\n`); process.exit(2); }

  const file = opts.project ? projectConfigPath(cwd) : userConfigPath();
  const scope = opts.project ? "./.dex.json (this repo)" : "~/.dex/config.json (all projects)";
  const obj = readConfigFile(file); // throws on malformed JSON — we refuse to clobber it

  if (action === "set") {
    if (value === undefined) { process.stderr.write(`error: set ${key} needs a value.\n${CONFIG_USAGE}\n`); process.exit(2); }
    let parsed;
    try { parsed = spec.parse(value); } catch (e) { process.stderr.write(`error: ${e.message}\n`); process.exit(2); }
    setPath(obj, spec.path, parsed);
    writeConfigFile(file, obj);
    process.stdout.write(`set ${key} = ${JSON.stringify(parsed)} in ${scope}\n`);
    if (/\.model$/.test(key)) {
      process.stdout.write(`note: a pinned model opts out of auto-fallback — make sure your account can use it, or \`dex config unset ${key}\` to restore the default.\n`);
    }
  } else {
    unsetPath(obj, spec.path);
    writeConfigFile(file, obj);
    process.stdout.write(`unset ${key} in ${scope}\n`);
  }
}

// --- dispatch --------------------------------------------------------------

const sub = process.argv[2];
const opts = parseArgs(process.argv.slice(3));
const commands = { setup: cmdSetup, run: cmdRun, fuse: cmdFuse, config: cmdConfig };
const handler = commands[sub];
if (!handler) {
  process.stderr.write("usage: dex <setup|run|fuse|config> [options]\n");
  process.exit(2);
}
handler(opts).catch((err) => {
  process.stderr.write(`dex: ${err?.stack || err}\n`);
  process.exit(1);
});
