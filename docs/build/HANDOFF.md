# 인계 기록

- 2026-09-05 · P1-12부터 **GPT-6 Astra → Claude Fable 5.1** 인계.
  이유: Codex CLI `ERROR: You've hit your usage limit ... try again at 5:19 PM` (ChatGPT Plus 사용 한도). P1-01~P1-11은 Astra가 구현·검증·커밋 완료(테스트 누적 통과).
  방식: 같은 과제 프롬프트(`docs/build/tasks/P1-NN.fable.md`)를 Fable 서브에이전트에 주고, 오케스트레이터(Claude Opus)가 `node --test` 검증 후 커밋.
- 2026-09-05 · 오너 지시 "이 프로젝트는 자비스와 완전 독립" → 저장소를 `~/jarvis2/interp-app` 에서 **`~/work/interp-app`** 로 이동(P1-18 커밋 직후, P1-19 시작 전). 자비스 코드는 런타임에 참조하지 않으며, jp-patch/interp-web 파일은 이식 출처(주석·reuse-map)로만 남는다.
