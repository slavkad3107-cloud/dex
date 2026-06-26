# dex

**Claude-as-judge ensemble for accurate answers** — a Claude Code plugin.

Claude answers first, consults a panel of free/local advisor models, escalates by difficulty (`/dex:auto`), runs a multi-round **debate** with anonymous critique and external verification, and **machine-evaluates itself** (`/dex:eval`).

Forked from [junkim100/gavel](https://github.com/junkim100/gavel) (MIT).

---

## Key finding (measured, June 2026)

> **Naive majority vote is not the answer.** The value comes from the judge + verification + smart routing — not from counting votes.

| Mode | Easy (18 Q) | Hard (8 Q) | Notes |
|---|---|---|---|
| Claude alone | 18/18 | 5/8 | Baseline |
| `ask cerebras` | 16/18 | 6–7/8 | Single strong voice |
| `fuse` (naive ensemble) | 14/18 | 3/8 | **Worst** — weak voices outvote the strong one |
| `auto` / `debate` | 18/18 | 8/8 | Judge + verification wins |

**`/dex:auto` is the recommended default** — same accuracy as debate, much lower average cost.
**`/dex:fuse` (standalone) is disabled** — measured worst in both regimes.

---

## Install

```text
/plugin marketplace add /path/to/dex
/plugin install dex@dex
```

Then restart Claude Code. Commands become `/dex:auto`, `/dex:debate`, `/dex:ask`, `/dex:eval`, `/dex:setup`, `/dex:config`.

---

## Setup

Add API keys to your Claude Code `settings.json` under `env`:

```json
{
  "env": {
    "DEEPSEEK_API_KEY": "sk-...",
    "MISTRAL_API_KEY": "...",
    "GROQ_API_KEY": "gsk_...",
    "CEREBRAS_API_KEY": "csk-...",
    "OPENROUTER_API_KEY": "sk-or-..."
  }
}
```

All providers are free-tier (rate-limited). No payment required for any of them.

Then run `/dex:setup` to verify readiness.

For local Ollama models: install [ollama](https://ollama.com), pull a model (`ollama pull qwen2.5:7b-instruct-q4_K_M`), and run `ollama serve`.

---

## Commands

| Command | What it does |
|---|---|
| `/dex:auto <task>` | **Recommended default.** Cheap probe first → escalate to panel → debate only if genuinely hard. |
| `/dex:debate <task>` | Full multi-round debate: blind draft → structured critique → claim verification → synthesis audit. |
| `/dex:ask <provider> <task>` | Query a single provider and show the raw answer (no synthesis). |
| `/dex:eval [fuse\|ask <provider>]` | Run the machine-scored eval harness and print a stratified scorecard. |
| `/dex:setup` | Check provider auth and readiness. |
| `/dex:config [show\|set\|unset]` | View or change settings (model, timeout, panel). |

---

## Providers

All bundled — no extra installs beyond Node.js. Only API keys needed.

| Slug | Model | Key env | Sign up |
|---|---|---|---|
| `deepseek` | deepseek-chat | `DEEPSEEK_API_KEY` | platform.deepseek.com |
| `mistral` | mistral-small-latest | `MISTRAL_API_KEY` | console.mistral.ai |
| `groq` | llama-3.3-70b-versatile | `GROQ_API_KEY` | console.groq.com |
| `cerebras` | gpt-oss-120b | `CEREBRAS_API_KEY` | cloud.cerebras.ai |
| `or-gemma` | google/gemma-4-31b-it:free | `OPENROUTER_API_KEY` | openrouter.ai |
| `qwen-q4` | qwen2.5:7b-instruct-q4_K_M | — (local Ollama) | ollama.com |

A money guard (`expectFree`) refuses any non-`:free` OpenRouter model unless `GAVEL_ALLOW_PAID=1`.

`codex` and `gemini` are disabled (gemini is geo-blocked; codex replaced by better free alternatives).

---

## How it works

### `/dex:auto` — cost-aware router

1. **Stage 1 (cheap):** Your draft + one strong voice (cerebras, 3× self-consistency). Stop if agreement.
2. **Stage 2 (panel):** Full panel, 1 round, judge-synthesized (NOT majority vote). Stop if ≥2 decorrelated families agree.
3. **Stage 3 (debate):** Full debate pipeline. Reserved for genuinely hard/contested questions.

### `/dex:debate` — multi-round debate

- **Round 0:** Claude's blind draft (committed before advisors run).
- **Round 1:** Independent answers from all panel members (optional `--samples 3` self-consistency).
- **Round 2:** Blind structured critique: each advisor receives anonymized answers and must critique with `[thesis]→[error]→[proof]→[fix]` + devil's advocate.
- **Round 3 (conditional):** Only if substantive disagreement remains. Hard cap at 3.
- **Claim-local verification:** Disputed, lone-wolf, and high-specificity-consensus claims are verified via WebSearch or direct computation.
- **Synthesis:** Per-claim aggregation + coherence pass + adversarial self-check + cross-family synthesis audit.
- **Calibrated labels:** `verified` / `high` / `tentative` / `contested` / `unknown`.

### Why not vote-count?

Naive majority vote lets weak/noisy voices outvote the strong one. In our eval, it scored **14/18 easy** and **3/8 hard** — worse than a single good model AND worse than Claude alone. The panel is still queried in parallel (via the `fuse` runner as transport), but answers are **judge-synthesized** (quality-weighted) + verified, never counted.

---

## Configuration

```json
// ~/.gavel/config.json  (user-level)  or  ./.gavel.json  (project-level)
{
  "panel": ["deepseek", "groq", "cerebras", "mistral", "or-gemma", "qwen-q4"],
  "timeout": 180
}
```

Or via the command: `/dex:config set timeout 120`.

---

## Eval harness

`eval-set.json` (104 stratified questions) is machine-scored via `accept`/`reject`/`acceptAll` regex:

```bash
node scripts/eval.mjs --mode ask --provider cerebras
node scripts/eval.mjs --mode fuse
node scripts/eval.mjs --mode ask --provider cerebras --category trap
```

Copy `eval-set.json` to `~/.gavel/eval-set.json` before running.

`debate`/`auto` are Claude-orchestrated — run `/dex:debate` on failure items from the scorecard.

---

## License

MIT — see [LICENSE](./LICENSE).
