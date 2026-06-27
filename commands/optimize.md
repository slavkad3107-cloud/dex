---
description: Self-optimization loop — analyzes eval history, proposes panel/config changes, tests them, accepts the winner.
argument-hint: "[--cycles N] [--category X] [--limit N]"
allowed-tools: Bash(node:*), Read, Write
---

You are running **dex self-optimization**. You are the **proposer, tester, and judge**. Your goal:
find config changes that measurably improve eval accuracy on the weakest categories, then apply
the winner and record the result.

Raw arguments: $ARGUMENTS

Parse: `--cycles N` (default 3), `--category X` (focus category, default: auto-detect weakest),
`--limit N` (items per eval run, default 30 — keep runs fast).

---

## Phase 0 — Baseline

Read eval history to understand current state:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/eval-trend.mjs" --last 5
```

If no history exists, run a baseline eval first (scoped to hard+trap for speed):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/eval.mjs" --mode fuse --difficulty hard --limit $LIMIT
```

Parse the scorecard. Identify the **weakest category × difficulty cell** (lowest correct/total ratio).
This is your optimization target. If the user specified `--category`, use that instead.

Record: `baseline_score`, `target_category`, `target_difficulty`.

---

## Phase 1 — Propose (per cycle)

Based on the weakest cell and current config, generate **3 candidate changes**. Read the current config:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dex.mjs" config show
```

Good candidates to try (pick the most relevant to the weak cell):

| Weak cell | Good candidates to try |
|---|---|
| `trap` / hard counting | Add `cohere` or `or-gemma` (different family), remove weakest voice |
| `reasoning` / hard | Add `deepseek` (strong math), try `--samples 3` self-consistency |
| `fact` / hard | Keep panel as-is, the issue is verification — debate mode is the fix |
| `multipart` | Add a voice known for structured output (mistral, cohere) |
| Any / easy | Panel is already enough — do NOT over-optimize easy items |

Write each candidate as a JSON patch to `~/.dex/config.json`. Always include the current config as
**candidate A (control)** — if nothing beats it, the config stays unchanged.

Examples:
- Add provider: `{"panel": ["deepseek","groq","cerebras","mistral","cohere","or-gemma","qwen-q4"]}`
- Remove weakest: `{"panel": ["deepseek","groq","cerebras","mistral","or-gemma"]}`
- Swap model: `{"providers": {"groq": {"model": "llama-3.1-8b-instant"}}}` (to test smaller/faster)

---

## Phase 2 — Test each candidate

For each candidate (A, B, C):

1. Write the candidate config patch to a **temp file** (NOT to `~/.dex/config.json` yet):

```bash
# Write patch to temp, merge with current config in node
node -e "
  const fs = require('fs'), os = require('os'), path = require('path');
  const base = JSON.parse(fs.readFileSync(path.join(os.homedir(),'.dex','config.json'),'utf8') || '{}');
  const patch = JSON.parse(process.argv[1]);
  const merged = {...base, ...patch, providers: {...(base.providers||{}), ...(patch.providers||{})}};
  fs.writeFileSync('/tmp/dex-opt-test.json', JSON.stringify(merged, null, 2));
" '<PATCH_JSON>'
```

2. Run eval with the temp config (pass via env override — dex reads `DEX_CONFIG` if set):

```bash
DEX_CONFIG=/tmp/dex-opt-test.json node "${CLAUDE_PLUGIN_ROOT}/scripts/eval.mjs" \
  --mode fuse --category $TARGET_CATEGORY --difficulty $TARGET_DIFFICULTY --limit $LIMIT
```

Note: if `dex.mjs` doesn't support `DEX_CONFIG` yet, write the patch directly to a temp
`.dex.json` in a temp dir and pass `--cwd` to eval.mjs. Fall back to temporarily writing
`~/.dex/config.json`, but **restore the original immediately after** — never leave config dirty.

3. Record `score_correct / score_total` for this candidate.

Run all 3 candidates. Show a comparison table as you go:

```
Candidate  | Change              | Score (target cell) | vs baseline
A (control)| no change           | 4/10  40%           | —
B          | +cohere             | 7/10  70%           | +30%
C          | -qwen-q4            | 5/10  50%           | +10%
```

---

## Phase 3 — Judge & apply

Pick the winner: highest score on the target cell. If tied, prefer the simpler config (fewer
providers — less failure surface). If NO candidate beats the baseline by ≥5%, declare the
current config optimal for this cell and stop.

If there is a clear winner:

1. Apply it to `~/.dex/config.json`:

```bash
node -e "
  const fs = require('fs'), os = require('os'), path = require('path');
  const cfgPath = path.join(os.homedir(),'.dex','config.json');
  const base = JSON.parse(fs.readFileSync(cfgPath,'utf8') || '{}');
  const patch = JSON.parse(process.argv[1]);
  const merged = {...base, ...patch, providers: {...(base.providers||{}), ...(patch.providers||{})}};
  fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
  console.log('config updated');
" '<WINNER_PATCH_JSON>'
```

2. Run a **full confirmation eval** on the target cell to verify the gain holds:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/eval.mjs" --mode fuse \
  --category $TARGET_CATEGORY --difficulty $TARGET_DIFFICULTY
```

3. Append the optimization result to `~/.dex/opt-log.jsonl`:

```bash
node -e "
  const fs = require('fs'), os = require('os'), path = require('path');
  const entry = JSON.parse(process.argv[1]);
  fs.appendFileSync(path.join(os.homedir(),'.dex','opt-log.jsonl'), JSON.stringify(entry)+'\n');
" '{"ts":"<ISO>","cycle":<N>,"target":"<cat>/<diff>","baseline":<B>,"winner":<W>,"delta":<D>,"change":"<desc>"}'
```

---

## Phase 4 — Next cycle

If `--cycles N > 1`: go back to Phase 0 with the updated config as the new baseline.
Find the **next weakest cell** (not the same one just fixed — rotate targets).

Hard limit: never run more than `--cycles` cycles. After the last cycle, print a summary:

```
=== DEX OPTIMIZATION SUMMARY ===
Cycles run: N
Changes applied: K
Baseline (start): X/Y total
Final score:      A/B total (+Z%)
Log: ~/.dex/opt-log.jsonl
```

---

## Safety rules

- **Never leave config in a broken state.** If any step errors, restore the original config before stopping.
- **Don't optimize on easy items** — the panel is already sufficient there. Easy accuracy going down slightly while hard accuracy improves = a good trade.
- **Don't add more than 2 providers per cycle** — more voices increase noise as much as signal.
- **If full panel already scores >90% on target cell** — stop, it's already optimal. Report it.
- Delete temp files (`/tmp/dex-opt-*.json`) after each cycle.
