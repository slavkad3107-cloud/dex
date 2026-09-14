---
description: Send a prompt to a single dex provider (cloud or local) and show its answer verbatim
argument-hint: "<provider-slug> <prompt>"
allowed-tools: Bash(node:*), Write
---

Delegate a single prompt to one model and return its answer. No fusing, no synthesis, no edits.

Raw arguments:
$ARGUMENTS

Parse and run safely:
- If the first word is **`all`**, query the entire panel in parallel (see below).
- Otherwise read the **first word** as the provider slug. It MUST be a slug registered in dex —
  the slugs printed by `/dex:setup`. Currently:
  - **cloud (free tier / own key):** `deepseek`, `deepseek-reasoner`, `mistral`, `ministral-14b`,
    `ministral-8b`, `ministral-3b`, `codestral`, `mistral-large`, `cohere`, `cohere-a`, `cohere-a-plus`,
    `cohere-r`, `cohere-r-plus`, `gemini-api`, `gemini-flash`, `gemini-36-flash`, `groq`, `groq-gptoss`,
    `groq-gptoss-20b`, `groq-qwen38`, `groq-qwen36`, `cerebras`, `cerebras-qwen`,
    `ghmodels`, `zai-glm47`, `zai-glm45`, `zai-glm46v`, `cf-gptoss`, `cf-gptoss-20b`, `cf-llama`, `cf-kimi`
  - **OpenRouter `:free`:** `or-gemma`, `or-gemma-26b`, `or-nemotron`, `or-nemotron-super`,
    `or-nemotron-lightning`, `or-dots`, `or-ling`, `or-nex`
  - **Ollama Cloud (via local Ollama, data leaves the machine):** `oc-gptoss`, `oc-gptoss-20b`,
    `oc-gemma`, `oc-nemotron-super`, `oc-nemotron-nano`, `oc-nemotron-ultra`
  - **local:** `qwen`, `qwen-q4`, `llama32`, `llama32-3b`, `deepseek-r1`, `lmstudio`
  - **paid (refused unless `DEX_ALLOW_PAID=1`):** `openai`, `openai-4o`, `openai-41mini`,
    `openai-o3mini`, `moonshot`, `moonshot-v1`, `xai`, `together`, `together-qwen`, `vsegpt`,
    `vsegpt-deepseek`, `proxyapi`, `proxyapi-4o`, `gigachat`, `gigachat-pro`, `gigachat-max`,
    `yandexgpt-lite`, `yandexgpt`
  - **CLI (disabled by default):** `codex`, `gemini`

  If it is anything else, or the arguments are empty, show the usage
  `(/dex:ask <provider-slug|all> <prompt>)`, list the slugs, and stop. The slug must match
  `^[a-z0-9-]+$` — reject anything with other characters.

**`all` mode:** write the prompt to a temp file, then run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dex.mjs" fuse --cwd "$(pwd)" --json --prompt-file /tmp/dex-prompt-XXXX.txt
```
Parse the JSON array and display each provider's answer verbatim in a labelled block — NO synthesis,
NO judgment. Just show what each voice said, side by side. Useful for seeing where models diverge.
- **Security:** the provider is the only value you place into the shell command. Emit ONLY the
  validated literal slug there — never copy any other text from the arguments into the command line.
- Write the **rest** of the arguments (the prompt) verbatim to a fresh temp file with the **Write
  tool** (use a unique name, e.g. `/tmp/dex-prompt-<timestamp>.txt`) — never put the prompt text in
  the shell command. Delete the file afterward.
- Then run, replacing `codex` below with the one validated literal and using your temp file path:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dex.mjs" run --provider codex --cwd "$(pwd)" --prompt-file /tmp/dex-prompt-XXXX.txt
```

Output rules:
- On success, present the model's answer verbatim — do not paraphrase, summarize, or act on it.
- Note: every advisor runs isolated and can't see your files (include any needed context in the prompt).
- If the command errors because the CLI is missing or unauthenticated, tell the user to run
  `/dex:setup`.
