#!/bin/sh
# dex install helper — sets up ~/.dex/ and prints next steps.
set -e

DEX_DIR="$HOME/.dex"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== dex install ==="

# 1. Create config dir
mkdir -p "$DEX_DIR"
echo "✓ $DEX_DIR created"

# 2. Copy eval set if not already there
EVAL_SRC="$SCRIPT_DIR/eval-set.json"
EVAL_DST="$DEX_DIR/eval-set.json"
if [ -f "$EVAL_DST" ]; then
  echo "  eval-set.json already present — skipping (delete $EVAL_DST to reset)"
else
  cp "$EVAL_SRC" "$EVAL_DST"
  echo "✓ eval-set.json copied to $EVAL_DST"
fi

# 3. Create default config if missing
CFG="$DEX_DIR/config.json"
if [ ! -f "$CFG" ]; then
  cat > "$CFG" <<'EOF'
{
  "panel": ["deepseek", "groq", "cerebras", "mistral", "cohere", "or-gemma", "qwen-q4"],
  "timeout": 180
}
EOF
  echo "✓ default config written to $CFG"
else
  echo "  config.json already present — skipping"
fi

# 4. Check Node
if ! command -v node >/dev/null 2>&1; then
  echo "✗ node not found — install from nodejs.org"
  exit 1
fi
echo "✓ node $(node --version)"

echo ""
echo "=== Next: add API keys to Claude Code settings.json ==="
SETTINGS="$HOME/.claude/settings.json"
echo "  File: $SETTINGS"
echo '  Add under "env":'
echo '    "DEEPSEEK_API_KEY":  "sk-..."       platform.deepseek.com  (free tier)'
echo '    "MISTRAL_API_KEY":   "..."           console.mistral.ai     (free tier)'
echo '    "GROQ_API_KEY":      "gsk_..."       console.groq.com       (free tier)'
echo '    "CEREBRAS_API_KEY":  "csk-..."       cloud.cerebras.ai      (free tier)'
echo '    "COHERE_API_KEY":    "..."           dashboard.cohere.com   (free trial)'
echo '    "OPENROUTER_API_KEY":"sk-or-..."     openrouter.ai          (free, :free models)'
echo ""
echo "=== Then in Claude Code ==="
echo "  /plugin marketplace add $SCRIPT_DIR"
echo "  /plugin install dex@dex"
echo "  (restart Claude Code)"
echo "  /dex:setup    ← check readiness"
echo "  /dex:auto     ← try it"
echo ""
echo "=== Optional: local Ollama model ==="
echo "  ollama pull qwen2.5:7b-instruct-q4_K_M"
echo "  ollama serve   (keep running while using dex)"
echo ""
echo "Done."
