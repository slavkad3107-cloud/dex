---
description: Auto-router — cheapest path first (1 strong voice), escalate to fuse then debate only if confidence is low. Best accuracy per effort.
argument-hint: "<task or question>"
---

You are running **gavel:auto** — a cost-aware cascade. Spend model effort only when the answer is
uncertain. You (Claude) are panelist + judge + actor. Escalate through the stages below and **STOP at
the first stage that yields a confident answer**, then act. Get prompts to models via a temp file +
`--prompt-file --json` (never inline in the shell).

The task / question:
$ARGUMENTS

If the task is empty, ask what to route, then stop.

**Stage 1 — cheap probe (your draft + one strong voice).** Form your own answer first. Then query the
single strongest reliable voice with self-consistency (3 samples):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gavel.mjs" run --provider cerebras --cwd "$(pwd)" --prompt-file /tmp/gavel-auto.txt
```

(Run it ~3× — or use `fuse --samples 3` limited to one provider — to gauge stability.) **STOP here and
answer (confidence `high`)** if ALL hold: your draft and the voice agree, the voice is self-consistent
across samples, and there's no high-stakes *checkable* fact. Otherwise → Stage 2.

**Stage 2 — panel (full panel, 1 round, JUDGE-synthesized — NOT a majority vote).** Query the whole
panel once (the `fuse` subcommand is just the parallel-query transport — naive majority/ENSEMBLE is
disabled because it measured worst, letting weak voices outvote the strong one):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gavel.mjs" fuse --cwd "$(pwd)" --json --prompt-file /tmp/gavel-auto.txt
```

Synthesize by **reasoning quality, not vote count** — a single well-argued/verified answer outranks a
majority of weak ones. **STOP and answer** if ≥2 decorrelated families agree and no load-bearing fact
is disputed. If answers **diverge**, a load-bearing fact is **disputed**, or it's a **tie** → Stage 3.

**Stage 3 — debate (full pipeline).** Run the complete `/dex:debate` flow (blind structured critique
+ devil's advocate → claim-local verification + lone-wolf routing → calibrated verdict + synthesis
audit). Reserve this for genuinely hard/contested questions — it's ~2.5–5× the cost of fuse.

**Report which stage resolved it** (1/2/3) and why, so the user sees the effort spent — then take the
appropriate action. The point of `auto` is to reach Stage 3 only when the question actually warrants it.
