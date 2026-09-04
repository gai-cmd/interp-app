#!/bin/bash
# Run one build task with GPT-6 Astra (Codex CLI, ChatGPT subscription) inside this app dir.
#   tools/astra-task.sh <task-id> <task-prompt-file>
# Output: docs/build/<task-id>.log (full transcript) and docs/build/<task-id>.last.md (final message).
set -u
APP="$HOME/jarvis2/interp-app"
ID="$1"; PROMPT="$2"
mkdir -p "$APP/docs/build"
cd "$APP"
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT codex exec -m gpt-6-astra --full-auto --skip-git-repo-check -C "$APP" \
  --output-last-message "docs/build/$ID.last.md" - < "$PROMPT" > "docs/build/$ID.log" 2>&1
echo "exit $?" >> "docs/build/$ID.log"
tail -1 "docs/build/$ID.log"
