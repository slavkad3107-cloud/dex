---
description: Auto mode — IS the full debate. Always runs the complete /dex:debate pipeline (R0→R4). No cost cascade, no early stop.
argument-hint: "<task or question>"
---

You are running **dex:auto**. In this plugin **auto mode == debate**: there is no cheap-probe
cascade and no early stop — every question gets the full multi-round debate. (The old cost-cascade
was retired: naive fuse measured worst, and a "confident" single voice is exactly where hidden errors
hide. Always debate.)

The task / question:
$ARGUMENTS

If the task is empty, ask what to debate, then stop.

**Do this: run the complete `/dex:debate` pipeline on the task above** — identical behavior to invoking
`/dex:debate` directly. Follow `commands/debate.md` exactly:

- **R0** — Claude blind draft (before the panel sees anything), written to a temp file.
- **R1** — panel answers independently (голый вопрос, no cross-reading) via
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/dex.mjs" fuse --cwd "$(pwd)" --json --prompt-file <file>`.
- **R2** *(always)* — panel receives R0+R1 anonymized (Эксперт А/Б/В…) → critique + devil's advocate + refine.
- **R3** *(always)* — panel receives R0+R1+R2 anonymized → same instruction as R2.
- **R4** *(always)* — Claude judge collects all anonymous results → dex-synthesis → coherence pass →
  adversarial self-check → cross-family audit → final verdict with calibrated confidence label
  (подтверждено / высокая / предположительно / спорно / неизвестно).

**Provider hygiene (every round):** parse the JSON array `{provider, model, ok, text, error}`.
Keep only `ok:true` answers; **any provider that fails or times out (e.g. cohere 403 geo-block,
gemini quota) is silently excluded from that round** — never block the debate waiting on it, never
count a missing voice. Note which providers dropped in the final report.

**Always report the plugin version** (`.claude-plugin/plugin.json`) and the list of participating vs
excluded providers at the end, so the user sees exactly which panel produced the verdict.
