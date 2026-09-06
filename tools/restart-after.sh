#!/bin/bash
# Wait for a task's .done marker, then restart the Fable driver so newly added task
# prompts (sorted after it) are picked up. Discards partial edits of the interrupted task.
#   tools/restart-after.sh P3-02 P3
DONE="$1"; PREFIX="${2:-P3}"; cd "$HOME/work/interp-app" || exit 1
until [ -f "docs/build/$DONE.done" ]; do sleep 5; done
echo "$DONE done · restarting driver to include new tasks"
pkill -f "run-p3-fable-chain" 2>/dev/null; pkill -f "run-fable.sh $PREFIX" 2>/dev/null; pkill -f "claude -p --model fable" 2>/dev/null; sleep 2
git checkout -q -- . 2>/dev/null; git clean -fdq -e docs/build 2>/dev/null
bash tools/run-fable.sh "$PREFIX"; echo "FABLE-$PREFIX-EXIT $?"
