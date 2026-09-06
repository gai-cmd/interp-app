#!/bin/bash
# Run one build task with Claude Fable (Claude subscription, non-interactive) inside this app dir.
#   tools/fable-task.sh <task-id> <task-prompt-file>
# Output: docs/build/<task-id>.log (transcript) and docs/build/<task-id>.last.md (final message).
set -u
APP="$HOME/work/interp-app"; ID="$1"; PROMPT="$2"
mkdir -p "$APP/docs/build"; cd "$APP"
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p --model fable --effort high \
  --allowedTools "Read,Edit,Write,Glob,Grep,Bash(node *),Bash(ls *),Bash(cat *),Bash(git status*),Bash(git diff*),Bash(rm -r /tmp/interp-rel-*),Bash(rm -rf /tmp/interp-rel-*),Bash(mkdir *),Bash(wc *),Bash(head *),Bash(tail *),Bash(grep *),Bash(diff *)" \
  --output-format text < "$PROMPT" > "docs/build/$ID.last.md" 2> "docs/build/$ID.log"
echo "exit $?" >> "docs/build/$ID.log"
tail -1 "docs/build/$ID.log"
