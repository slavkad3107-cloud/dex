# dex

Claude Code plugin — a **Claude-as-judge ensemble** for accurate answers. Claude answers first, consults a panel of
**free/local advisor models**, runs a multi-round **debate** (anonymous critique + devil's advocate)
with **external verification** (WebSearch/compute), and **machine-evaluates** itself (`/dex:eval`).
Naive majority-vote (fuse) is **disabled** — measured worst. Local CLIs only; synchronous (no background jobs).

`/dex` = `/dex:debate` (default, always full pipeline). `/dex:auto` is **disabled** — debate is always run.

## Layout
- `commands/` — slash commands (`dex`, `debate`, `ask`, `eval`, `setup`, `config`, `optimize`); thin Claude-side wrappers.
  - **`debate` is the default** (`/dex` = `/dex:debate`): full multi-round pipeline always. `/dex:auto` is disabled.
  - `eval` = run the machine-scored eval harness (`scripts/eval.mjs`) and print a stratified scorecard.
  - **`fuse` (standalone 1-round naive synthesis) and the naive-majority ENSEMBLE are DISABLED** (`commands/fuse.md.disabled`): measured WORST in both regimes (78% easy, **38% hard** — weak voices outvote the strong one, dropping below a single good model and below Claude-alone). The panel is still queried in parallel by `auto`/`debate` via the `dex.mjs fuse` **runner**, but answers are **judge-synthesized (quality-weighted) + verified**, never majority-voted.
- `scripts/dex.mjs` — zero-dependency Node runner: a **provider registry** + config layer.
  Subcommands: `setup | run | fuse | config` (`fuse` supports `--samples N` for self-consistency).
- `scripts/eval.mjs` — zero-dep **eval harness**: reads `~/.dex/eval-set.json`, runs each item through
  `ask`/`fuse`, **machine-scores** answers via each item's `accept`/`reject`/`acceptAll` regex (normalize:
  lowercase, ё→е, collapse ws; `correct = no reject AND (all acceptAll, else any accept)`), prints a
  stratified scorecard (model × category × difficulty + ensemble = majority-of-panel-correct). Auto-loads
  API keys from `~/.claude/settings.json` — no manual export. Only `ask`/`fuse` are auto-measurable;
  `debate` is Claude-orchestrated (run `/dex:debate` on the listed failures).
- `skills/dex-synthesis/SKILL.md` — the judge/synthesis contract.
- `.claude-plugin/` — `plugin.json` + `marketplace.json` (repo is its own single-plugin marketplace).

## How fuse works
Runs in the main Claude context. Claude is **panelist #3 + judge + actor**. To keep it a genuine
third input and not just a referee of the two advisors, step 1 is **blind drafting**: Claude writes
its own complete answer to a temp file (`/tmp/dex-claude-<ts>.md`) *before* the panel runs, then
runs the advisor panel in parallel, then synthesizes all three committed submissions per
`dex-synthesis` (its draft is co-equal, not silently rewritten), then takes action. **Only Claude
writes** to the workspace. The runner (`dex.mjs fuse`) only queries Codex + Gemini — Claude's
contribution is the in-process draft, so there is intentionally **no "claude" provider**.

## How debate works (`/dex:debate`)
A multi-round extension of fuse, orchestrated entirely Claude-side (no runner change — each round is
just another `dex.mjs fuse --json` call with a constructed prompt). Round 0: Claude's blind draft.
Round 1: independent answers. Round 2: **always runs** — each advisor receives all Round-1 answers
(anonymized) and is asked to critique & refine. Convergence is judged **only after Round 2**; a **3rd
round fires only if substantive disagreement remains** (hard cap at 3 — beyond that, gains vanish and
models converge sycophantically). Claude synthesizes the final round per `dex-synthesis` and reports
the debate arc. Efficiency note: R1→R2 yields most of the gain; R2→R3 pays off only when genuinely
split; cost grows ~super-linearly per round (each round re-sends accumulated answers). Best run on the
**cloud panel** — local CPU models make rounds too slow.

Accuracy layers added by a 3-cycle self-optimization loop (each closes a distinct measured error class):
optional **self-consistency** (`fuse --samples N` — an internally-unstable voice self-demotes);
**claim-local verification** (decompose → agreement matrix → route WebSearch/compute only to disputed,
high-specificity-consensus, or **lone-wolf** claims; compute computable ones directly); **per-claim
aggregation** (mix best fragment per claim) + coherence pass; **cross-family synthesis audit** (a
non-Claude voice flags dropped critiques / unsupported synthesis claims — catches judge-as-aggregator
errors self-check can't); **calibrated confidence labels** (подтверждено/высокая/предположительно/спорно/неизвестно,
abstain on unknown). Measurement lives in `~/.dex/eval-set.json` (run it to MEASURE, not estimate).

## Read-only is a per-provider capability (`PROVIDERS[name].isolation`)
- `codex` → `readonly-sandbox`: runs in the project dir under `-s read-only` (a real OS sandbox), so
  it reads the repo but genuinely cannot write — a hard boundary.
- `gemini` → `isolated` (also the safe DEFAULT for any provider not marked `readonly-sandbox`): gemini
  has **no** OS read-only sandbox, and `--approval-mode plan` only blocks edit tools (it can still
  write via `run_shell_command` — verified). So `runProvider` runs it in a **throwaway temp cwd** with
  `PWD`/`OLDPWD`/`INIT_CWD` scrubbed, which stops it discovering the repo path or making relative/cwd
  writes into it. This is **isolation, not a hardened sandbox**: gemini still inherits `$HOME` (needed
  for auth) and will act on any absolute path it's handed — do NOT feed advisors untrusted content
  expecting confinement. Put context gemini needs into the prompt.
- The `runProvider` harness creates/scrubs/deletes the throwaway dir; unknown isolation values default
  to isolated (fail safe).

## Prompts never travel through the shell
Prompts reach the runner via `--prompt-file` (or stdin), never a shell-quoted argument; each CLI then
gets the prompt on **stdin**, never argv. Slash commands write the task to a temp file with the Write
tool, then pass `--prompt-file`. (`--prompt` exists for tests/programmatic use only.)

## CLI invocations (verified; flags vary by version — re-verify before changing)
- Codex (tested 0.133.0): `codex exec --color never -s read-only --skip-git-repo-check --ephemeral -m <model> -C <cwd> -o <tmp>`, prompt on stdin → read `<tmp>`.
- Gemini (tested 0.46.0): `gemini --skip-trust --approval-mode plan -m <model> --output-format json`, prompt on stdin, in a throwaway cwd → parse `.response`.
- A provider is `ok` only on **exit code 0** with non-empty output; otherwise a structured error
  (gemini errors may arrive as JSON on stdout or stderr).

## Config / settings (precedence low→high)
defaults < `~/.dex/config.json` < `./.dex.json` < env < CLI flags. Shape:
`{ "providers": { "<name>": { "enabled": bool, "model": str } }, "panel": ["<name>"...], "timeout": sec }`
- Disabled provider → skipped in fuse, not counted "missing" in setup, no warning.
- Models: `DEX_CODEX_MODEL` / `DEX_GEMINI_MODEL`; timeout `DEX_TIMEOUT` (seconds, per provider). Default timeout 1800s (30 min).
- `dex config` (subcommand + `/dex:config`) reads/writes ONE settings file: `set`/`unset <key>` edits `~/.dex/config.json` by default, or `./.dex.json` with `--project`; `show` prints the merged effective view + sources. Keys: `timeout`, `panel`, `<provider>.model`, `<provider>.enabled`. It edits a single scope (never the merged view) and refuses to clobber a file that is already invalid JSON.
- Preferred defaults are codex `gpt-5.5-pro` / gemini `gemini-3.1-pro`. Model availability is account/tier dependent — if the resolved default isn't usable for the account (e.g. `gpt-5.5-pro` is rejected on a ChatGPT account; `gemini-3.1-pro`/`gemini-3-pro` 404 on personal OAuth), `runProvider` retries once with `-m` omitted so the CLI uses its own default. This fallback fires ONLY for the built-in default (`resolveModel().isDefault`); an explicit flag/env/config model is never swapped. Detection is heuristic (`looksLikeModelError`) and the fallback is logged to stderr.

## setup readiness
`ready` = at least one provider **in the resolved panel** is usable (so a panel/config that excludes
every usable provider reports not-ready, not a false positive). `degraded` = ready but some enabled
provider unusable. `missingProviders` = enabled-but-unusable. `configErrors` surfaces invalid settings
files (they're reported, not silently fail-open). `tooOld`/`versionUnknown` flag CLI version problems.

## Adding a provider
Add one entry to `PROVIDERS` in `scripts/dex.mjs`:
`{ bin, tested, isolation, defaultModel, modelEnv, installHint, authHint, checkAuth(), run({prompt,model,cwd,timeoutMs,env}) }`.
Use `isolation: "readonly-sandbox"` ONLY if it has a real OS read-only sandbox (like codex `-s
read-only`); otherwise leave it `"isolated"` (the safe default). setup / run / fuse / panel / config
are data-driven off the map; to also expose it via `/dex:ask`, add its name to the allow-list in
`commands/ask.md` (one line). Providers are CLI-based today — an API-key-only provider would need a
small change to the `usable` check (which currently requires a local binary).

## Conventions
- `scripts/dex.mjs`: Node ESM, **zero npm deps** (`node:child_process`, `node:fs`, `node:os`, `node:path`).
- Advisors must never be able to write the workspace; only Claude acts. Keep it synchronous — no jobs/broker/MCP.
- Keep command markdown thin; logic/parsing lives in `dex.mjs`. Reference plugin files via `${CLAUDE_PLUGIN_ROOT}`.
- Node project — the global "use uv for Python" rule doesn't apply (no Python here).

## Test
- `node scripts/dex.mjs setup` (or `--json`); `bash scripts/smoke-test.sh` for the full gate.
- Per-finding regression tests are documented in the README.
