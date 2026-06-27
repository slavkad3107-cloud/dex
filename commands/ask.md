---
description: Send a prompt to a single dex provider (cloud or local) and show its answer verbatim
argument-hint: "<provider-slug> <prompt>"
allowed-tools: Bash(node:*), Write
---

Delegate a single prompt to one model and return its answer. No fusing, no synthesis, no edits.

Raw arguments:
$ARGUMENTS

Parse and run safely:
- Read the **first word** of the arguments to decide the provider. It MUST be a provider slug
  registered in dex — the slugs printed by `/dex:setup` (currently: `deepseek`, `mistral`, `cohere`,
  `groq`, `cerebras`, `ghmodels`, `or-llama`, `or-qwen`, `or-gemma`, `or-nemotron`, `or-gptoss`,
  `or-coder`, `qwen`, `qwen-q4`, `llama32`, `llama32-3b`, `deepseek-r1`). If it is anything else, or the arguments
  are empty, show the
  usage `(/dex:ask <provider-slug> <prompt>)`, list the slugs, and stop. The slug must match
  `^[a-z0-9-]+$` — reject anything with other characters rather than passing it to the shell.
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
- Note: DeepSeek and Gemini both run isolated and can't see your files (include any needed context in the prompt).
- If the command errors because the CLI is missing or unauthenticated, tell the user to run
  `/dex:setup`.
