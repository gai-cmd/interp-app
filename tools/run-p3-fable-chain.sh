#!/bin/bash
# Wait for Astra's P3-00, stop the Astra driver, then build P3-01.. with Fable.
cd "$HOME/work/interp-app" || exit 1
until [ -f docs/build/P3-00.done ]; do sleep 5; done
echo "P3-00 done · switching coding to Fable"
pkill -f "run-until-done.sh P3" 2>/dev/null; pkill -f "run-p1.sh P3" 2>/dev/null; pkill -f "codex exec -m gpt-6-astra" 2>/dev/null; sleep 2
git checkout -q -- . 2>/dev/null; git clean -fdq -e docs/build 2>/dev/null
bash tools/run-fable.sh P3; code=$?
echo "FABLE-P3-EXIT $code"
