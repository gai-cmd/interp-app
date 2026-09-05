#!/bin/bash
# Owner rule (2026-09-05): Astra only, alternating the two Codex profiles; when BOTH are
# usage-limited, PAUSE and resume later — never hand P2 design/coding to another model.
#   tools/run-until-done.sh P2
PREFIX="${1:-P2}"; cd "$HOME/work/interp-app" || exit 1
while true; do
  bash tools/run-p1.sh "$PREFIX"; code=$?
  if [ $code -eq 0 ]; then echo "$PREFIX DONE"; exit 0; fi
  if [ $code -eq 2 ]; then echo "$PREFIX task failed twice · stopping for review"; exit 2; fi
  # 3 = all profiles limited · wait for the earliest "try again at HH:MM" (fallback 30 min)
  last=$(ls -t docs/build/$PREFIX-*.log 2>/dev/null | head -1)
  at=$(grep -io 'try again at [0-9:]* [AP]M' "$last" 2>/dev/null | head -1 | sed 's/try again at //I')
  wait=1800
  if [ -n "$at" ]; then
    target=$(date -j -f "%I:%M %p" "$at" +%s 2>/dev/null); now=$(date +%s)
    if [ -n "$target" ]; then [ "$target" -le "$now" ] && target=$((target+86400)); wait=$((target-now+90)); fi
  fi
  echo "$PREFIX PAUSED · both Astra profiles limited · resuming in $((wait/60)) min ($at)"
  sleep "$wait"
done
