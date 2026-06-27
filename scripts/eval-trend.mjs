#!/usr/bin/env node
// dex eval-trend — reads ~/.dex/eval-history.jsonl and prints accuracy over time.
// Usage: node scripts/eval-trend.mjs [--provider X] [--last N]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HISTORY = path.join(os.homedir(), ".dex", "eval-history.jsonl");

const filterProvider = process.argv.includes("--provider")
  ? process.argv[process.argv.indexOf("--provider") + 1] : null;
const last = process.argv.includes("--last")
  ? Number(process.argv[process.argv.indexOf("--last") + 1]) : 0;

let lines;
try { lines = fs.readFileSync(HISTORY, "utf8").trim().split("\n").filter(Boolean); }
catch { console.error(`No history found at ${HISTORY}. Run /dex:eval first.`); process.exit(1); }

const runs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const filtered = filterProvider ? runs.filter(r => r.provider === filterProvider || r.mode === filterProvider) : runs;
const view = last > 0 ? filtered.slice(-last) : filtered;

if (!view.length) { console.log("No matching runs found."); process.exit(0); }

const allModels = [...new Set(view.flatMap(r => Object.keys(r.perModel || {})))];
const L = (s, n) => String(s ?? "").slice(0, n).padEnd(n);

console.log(`\nDEX EVAL TREND — ${view.length} run(s)${filterProvider ? ` · filter: ${filterProvider}` : ""}`);
console.log("=".repeat(20 + allModels.length * 14));
console.log(L("date", 12) + L("mode", 10) + allModels.map(m => L(m, 14)).join(""));
console.log("-".repeat(20 + allModels.length * 14));

for (const r of view) {
  const date = r.ts ? r.ts.slice(0, 10) : "?";
  const mode = (r.provider ? `ask(${r.provider})` : r.mode) || "?";
  const cells = allModels.map(m => {
    const s = r.perModel?.[m]?.overall;
    return s ? L(`${s.correct}/${s.total} ${Math.round(s.correct/s.total*100)}%`, 14) : L("-", 14);
  }).join("");
  console.log(L(date, 12) + L(mode, 10) + cells);
}
console.log("=".repeat(20 + allModels.length * 14));
console.log(`History file: ${HISTORY}`);
