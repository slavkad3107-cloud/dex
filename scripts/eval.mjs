#!/usr/bin/env node
// dex eval harness — runner + machine scorer. Reads ~/.dex/eval-set.json, runs each item through a
// mode (fuse | ask), machine-scores every answer via the item's accept/reject/acceptAll regex contract,
// and prints a stratified scorecard (per model × category × difficulty + ensemble). Zero npm deps.
//
// Usage:
//   node eval.mjs                          # fuse (full panel), all items
//   node eval.mjs --mode ask --provider cerebras
//   node eval.mjs --samples 3 --limit 20 --category trap --difficulty hard --json
//
// Keys are auto-loaded from ~/.claude/settings.json `env` — no manual export needed.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEX = path.join(SCRIPTS_DIR, "dex.mjs");
const EVAL_PATH = path.join(HOME, ".dex", "eval-set.json");
const SETTINGS = path.join(HOME, ".claude", "settings.json");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

const mode = arg("mode", "fuse");           // fuse | ask
const provider = arg("provider", "cerebras"); // used when --mode ask
const samples = arg("samples", null);
const limit = Number(arg("limit", "0")) || 0;
const filterCat = arg("category", null);
const filterDiff = arg("difficulty", null);
const timeout = arg("timeout", "180");
const asJson = has("json");
// --ids "1,4,7": run only these item ids. --answers <file>: score a supplied {id: "answer"} map
// (e.g. Claude-alone or any model not wired as a provider) through the SAME machine scorer.
const idsArg = arg("ids", null);
const idsSet = idsArg ? new Set(idsArg.split(",").map((s) => Number(s.trim()))) : null;
const answersFile = arg("answers", null);
let answersMap = null;
if (answersFile) { try { answersMap = JSON.parse(fs.readFileSync(answersFile, "utf8")); } catch { console.error("bad --answers file"); process.exit(2); } }

// Auto-load API keys from settings.json env so the harness runs without manual export.
const env = { ...process.env };
try {
  const s = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  for (const [k, v] of Object.entries(s.env || {})) if (v) env[k] = String(v);
} catch {}

const norm = (s) => (s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
const rx = (p) => { try { return new RegExp(p, "i"); } catch { return null; } };

// Scoring contract (from eval-set _note): correct = no reject match AND (all acceptAll if present, else
// any accept). Returns true/false, or null when the item has no scoring fields.
function score(answer, item) {
  const a = norm(answer);
  if (Array.isArray(item.reject) && item.reject.some((p) => { const r = rx(p); return r && r.test(a); })) return false;
  if (Array.isArray(item.acceptAll) && item.acceptAll.length) return item.acceptAll.every((p) => { const r = rx(p); return r && r.test(a); });
  if (Array.isArray(item.accept) && item.accept.length) return item.accept.some((p) => { const r = rx(p); return r && r.test(a); });
  return null;
}

function runGavel(args, input) {
  return new Promise((resolve) => {
    const child = spawn("node", [DEX, ...args], { env, stdio: ["pipe", "pipe", "ignore"], shell: false });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    child.stdin.on("error", () => {});
    child.stdin.write(input);
    child.stdin.end();
  });
}

// Returns [{provider, text, ok}] for one item.
async function runItem(item) {
  if (answersMap) {
    const t = answersMap[item.id] ?? answersMap[String(item.id)];
    return [{ provider: "supplied", text: t != null ? String(t) : "", ok: t != null }];
  }
  const prompt = item.question + "\nОтветь кратко: только итоговый ответ (число/слово), без рассуждений.";
  if (mode === "ask") {
    const r = await runGavel(["run", "--provider", provider, "--cwd", HOME, "--json", "--timeout", timeout], prompt);
    return r && r.ok ? [{ provider, text: r.text, ok: true }] : [{ provider, text: "", ok: false }];
  }
  const a = ["fuse", "--cwd", HOME, "--json", "--timeout", timeout];
  if (samples) a.push("--samples", samples);
  const arr = await runGavel(a, prompt);
  return Array.isArray(arr) ? arr.map((x) => ({ provider: x.provider, text: x.ok ? x.text : "", ok: !!x.ok })) : [];
}

function tallyInit() { return { correct: 0, total: 0 }; }
function bump(t, ok) { t.total++; if (ok) t.correct++; }
function pct(t) { return t.total ? Math.round((100 * t.correct) / t.total) : 0; }

async function main() {
  const data = JSON.parse(fs.readFileSync(EVAL_PATH, "utf8"));
  let items = data.items.filter((it) => it.accept || it.acceptAll);
  if (filterCat) items = items.filter((it) => it.category === filterCat);
  if (filterDiff) items = items.filter((it) => it.difficulty === filterDiff);
  if (idsSet) items = items.filter((it) => idsSet.has(it.id));
  if (limit) items = items.slice(0, limit);

  const perModel = {};      // provider -> {overall, cat:{}, diff:{}}
  const ensemble = { overall: tallyInit(), cat: {}, diff: {} };
  const rows = [];

  for (const it of items) {
    const answers = await runItem(it);
    let nCorrect = 0, nAns = 0;
    const cell = {};
    for (const a of answers) {
      if (!a.ok) { cell[a.provider] = "err"; continue; }
      const ok = score(a.text, it) === true;
      cell[a.provider] = ok ? "✓" : "✗";
      nAns++; if (ok) nCorrect++;
      const m = (perModel[a.provider] ||= { overall: tallyInit(), cat: {}, diff: {} });
      bump(m.overall, ok);
      bump((m.cat[it.category] ||= tallyInit()), ok);
      bump((m.diff[it.difficulty] ||= tallyInit()), ok);
    }
    const ensOk = nAns > 0 && nCorrect > nAns / 2; // majority of answering panel correct
    bump(ensemble.overall, ensOk);
    bump((ensemble.cat[it.category] ||= tallyInit()), ensOk);
    bump((ensemble.diff[it.difficulty] ||= tallyInit()), ensOk);
    rows.push({ id: it.id, category: it.category, difficulty: it.difficulty, ensemble: ensOk ? "✓" : "✗", cells: cell });
  }

  // Append run to history log for trend tracking
  const historyPath = path.join(HOME, ".dex", "eval-history.jsonl");
  const historyEntry = JSON.stringify({
    ts: new Date().toISOString(), mode, provider: mode === "ask" ? provider : undefined,
    items: items.length, perModel, rows: rows.map(r => ({ id: r.id, category: r.category, difficulty: r.difficulty })),
  });
  try { fs.appendFileSync(historyPath, historyEntry + "\n"); } catch {}

  if (asJson) { process.stdout.write(JSON.stringify({ mode, provider: mode === "ask" ? provider : undefined, perModel, ensemble, rows }, null, 2) + "\n"); return; }

  const models = Object.keys(perModel);
  const cats = [...new Set(items.map((i) => i.category))];
  const diffs = ["easy", "med", "hard"].filter((d) => items.some((i) => i.difficulty === d));
  const L = (s, n) => String(s).padEnd(n);

  console.log(`\nDEX EVAL — mode=${mode}${mode === "ask" ? " (" + provider + ")" : ""} · ${items.length} items` + (samples ? ` · samples=${samples}` : ""));
  console.log("=".repeat(64));
  console.log(L("model", 12) + L("acc", 11) + cats.map((c) => L(c.slice(0, 7), 9)).join("") + diffs.map((d) => L(d, 6)).join(""));
  const line = (name, o, cat, diff) =>
    L(name, 12) + L(`${o.correct}/${o.total} ${pct(o)}%`, 11) +
    cats.map((c) => L(cat[c] ? `${cat[c].correct}/${cat[c].total}` : "-", 9)).join("") +
    diffs.map((d) => L(diff[d] ? `${diff[d].correct}/${diff[d].total}` : "-", 6)).join("");
  for (const m of models) console.log(line(m, perModel[m].overall, perModel[m].cat, perModel[m].diff));
  console.log("=".repeat(64));
  console.log("note: naive-majority ENSEMBLE/fuse is DISABLED (measured worst — weak voices outvote the");
  console.log("      strong one). This shows PER-MODEL accuracy; use /dex:auto or /dex:debate (judge +");
  console.log("      verification), never a majority vote of the panel.");
}

main();
