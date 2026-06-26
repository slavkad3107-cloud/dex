---
description: Run the machine-scored eval harness (ask/fuse) over ~/.gavel/eval-set.json and print a stratified scorecard.
argument-hint: "[fuse|ask <provider>] [--category X] [--difficulty easy|med|hard] [--limit N]"
allowed-tools: Bash(node:*)
---

Run the automated eval harness and report the scorecard. It auto-loads API keys from
`~/.claude/settings.json` and machine-scores every answer via each item's `accept`/`reject`/`acceptAll`
regex — no hand-scoring.

Raw arguments: $ARGUMENTS

Parse the arguments and run `scripts/eval.mjs` accordingly (default `--mode fuse`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/eval.mjs" --mode fuse
```

- For `ask <provider>`: `--mode ask --provider <provider>` (provider must be a real gavel slug).
- Pass through `--category`, `--difficulty`, `--limit`, `--samples` if the user gave them.
- The full `fuse` run is slow (every item × the whole panel, incl. the local model) — warn the user and
  consider running it in the background, or use `--limit`/`--category` to scope.

Present the scorecard verbatim. Then:
- Point out the weakest **category × difficulty** cells and the **ensemble-failure item ids**.
- Note that `eval.mjs` measures only `ask`/`fuse` (one gavel call); `debate`/`auto` are
  Claude-orchestrated, so to measure those, run `/dex:debate` on the listed failure items.
