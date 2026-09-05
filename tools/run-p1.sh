#!/bin/bash
# Drive the P1 task list with Astra, one `codex exec` per task, verifying with node --test
# and committing on success. Prints one line per task (Monitor-friendly). Exit 2 = task failed
# twice (hand off to Fable), exit 3 = Astra blocked (rate/usage limit).
shopt -s nullglob
APP="$HOME/work/interp-app"; cd "$APP" || exit 1
GITC="git -c user.name=gai -c user.email=gai@kaflixcloud.co.jp"
run_tests() {
  local files=(tests/*.test.mjs)
  [ ${#files[@]} -eq 0 ] && { echo "no tests"; return 0; }
  node --test "${files[@]}" > docs/build/last-test.log 2>&1
}
blocked() { grep -qiE "^ERROR:.*(usage limit|rate limit|quota|429|too many requests)|requires a newer version|unexpected argument|Usage: codex exec" "$1"; }
for f in docs/build/tasks/P1-*.md; do
  id=$(basename "$f" .md)
  [ -f "docs/build/$id.done" ] && continue
  t0=$(date +%s)
  tools/astra-task.sh "$id" "$f" >/dev/null
  if blocked "docs/build/$id.log"; then echo "$id ASTRA-BLOCKED $(grep -iE 'usage limit|rate limit|quota|429' docs/build/$id.log | head -1 | cut -c1-140)"; exit 3; fi
  if run_tests; then
    $GITC add -A >/dev/null; $GITC commit -qm "$id: $(grep -m1 '^## ' "$f" | sed 's/^## //' | cut -c1-60)

Built by GPT-6 Astra via Codex CLI; verified with node --test.
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LuvfLUrfz3d8VPU49Ce22F" >/dev/null 2>&1
    touch "docs/build/$id.done"; echo "$id OK $(( $(date +%s) - t0 ))s files=$($GITC show --stat --format= HEAD | tail -1)"
    continue
  fi
  # retry once with the failure attached
  { cat "$f"; echo; echo "# 이전 시도 실패 · 아래 테스트 출력을 보고 고쳐라 (같은 규칙 · 같은 파일 범위)"; echo '```'; tail -80 docs/build/last-test.log; echo '```'; } > "docs/build/tasks/$id.retry.md"
  tools/astra-task.sh "$id-retry" "docs/build/tasks/$id.retry.md" >/dev/null
  if blocked "docs/build/$id-retry.log"; then echo "$id ASTRA-BLOCKED on retry"; exit 3; fi
  if run_tests; then
    $GITC add -A >/dev/null; $GITC commit -qm "$id (retry): $(grep -m1 '^## ' "$f" | sed 's/^## //' | cut -c1-60)

Built by GPT-6 Astra via Codex CLI (second attempt); verified with node --test.
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LuvfLUrfz3d8VPU49Ce22F" >/dev/null 2>&1
    touch "docs/build/$id.done"; echo "$id OK-after-retry $(( $(date +%s) - t0 ))s"
    continue
  fi
  echo "$id FAILED-twice → handoff · $(grep -cE '^not ok' docs/build/last-test.log) failing tests"; exit 2
done
echo "P1 COMPLETE"
