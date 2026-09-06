#!/bin/bash
# P3+ rule (owner, 2026-09-06): design is fixed (Astra); coding may fall back to Fable/Opus.
# Runs the Astra driver; exits 3 immediately when both Codex profiles are limited so the
# orchestrator can hand the next tasks to Fable subagents instead of pausing.
PREFIX="${1:-P3}"; cd "$HOME/work/interp-app" || exit 1
bash tools/run-p1.sh "$PREFIX"; code=$?
[ $code -eq 0 ] && { echo "$PREFIX DONE"; exit 0; }
[ $code -eq 2 ] && { echo "$PREFIX task failed twice · stopping for review"; exit 2; }
echo "$PREFIX ASTRA-LIMITED → HANDOFF-FABLE"; exit 3
