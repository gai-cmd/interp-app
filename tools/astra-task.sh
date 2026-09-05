#!/bin/bash
# Run one build task with GPT-6 Astra (Codex CLI, ChatGPT subscription) inside this app dir.
# ASTRA_HOME selects the Codex profile (~/.codex or ~/.codex-astra2) · rotated by run-p1.sh on usage limits.
#   tools/astra-task.sh <task-id> <task-prompt-file>
# Output: docs/build/<task-id>.log (full transcript) and docs/build/<task-id>.last.md (final message).
set -u
APP="$HOME/work/interp-app"
ID="$1"; PROMPT="$2"
mkdir -p "$APP/docs/build"
cd "$APP"
CODEX_HOME="${ASTRA_HOME:-$HOME/.codex}" env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT codex exec -m gpt-6-astra -s workspace-write --skip-git-repo-check -C "$APP" \
  --output-last-message "docs/build/$ID.last.md" - < "$PROMPT" > "docs/build/$ID.log" 2>&1
echo "exit $?" >> "docs/build/$ID.log"
tail -1 "docs/build/$ID.log"
