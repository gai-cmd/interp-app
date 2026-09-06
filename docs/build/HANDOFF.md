# 인계 기록

- 2026-09-05 · P1-12부터 **GPT-6 Astra → Claude Fable 5.1** 인계.
  이유: Codex CLI `ERROR: You've hit your usage limit ... try again at 5:19 PM` (ChatGPT Plus 사용 한도). P1-01~P1-11은 Astra가 구현·검증·커밋 완료(테스트 누적 통과).
  방식: 같은 과제 프롬프트(`docs/build/tasks/P1-NN.fable.md`)를 Fable 서브에이전트에 주고, 오케스트레이터(Claude Opus)가 `node --test` 검증 후 커밋.
- 2026-09-05 · 오너 지시 "이 프로젝트는 자비스와 완전 독립" → 저장소를 `~/work/interp-app` 에서 **`~/work/interp-app`** 로 이동(P1-18 커밋 직후, P1-19 시작 전). 자비스 코드는 런타임에 참조하지 않으며, jp-patch/interp-web 파일은 이식 출처(주석·reuse-map)로만 남는다.
- 2026-09-05 20:3x JST · Codex 한도 해제 확인 → **P1-20b(Astra 검수·수정 라운드)와 P1-21부터 다시 GPT-6 Astra**. Fable 구현분 P1-12~P1-20은 Astra가 설계 대비 검수·수정한다.
- 2026-09-05 21:0x JST · P1-21 시작 직후 Codex 한도 재소진(`try again at 10:22 PM`) → **P1-21은 Fable**. P1-20b(Astra 검수·수정)는 완료·커밋됨.
- 2026-09-05 21:40 JST · 오너 지시: **P2 설계는 Astra 단독**. Fable 초안 작업은 시작 단계에서 중단·폐기. 22:22 한도 해제 후 Astra 3라운드(설계·과제 목록) → Astra 코딩. Fable은 Astra가 막힐 때만 코딩 인계.
- 2026-09-05 21:5x JST · 두 번째 ChatGPT 계정(gpt@try-n.com, `~/.codex-astra2`) 추가. 오너 규칙: **Astra 두 프로필을 번갈아 쓰고, 둘 다 한도면 멈췄다가 재개**(설계가 가장 중요 · P2는 Fable 인계 없음). `tools/run-until-done.sh`가 이를 자동화.
- 2026-09-06 10:2x JST · 오너: **관리자(P3-01)부터는 설계서대로 Fable/Opus가 코딩해도 됨**. 규칙: Astra 가능하면 Astra, 두 프로필 모두 한도면 대기 대신 Fable 인계(`tools/run-with-handoff.sh`). P3-00은 Astra가 진행 중.
- 2026-09-06 10:3x JST · 오너 확정: **Astra = 설계·검수·프로젝트 오너 역할만**, 코딩은 Fable(`tools/fable-task.sh`, `tools/run-fable.sh`). P3-00은 Astra가 이미 진행 중이라 그대로 마무리. P3-01부터 Fable 코딩 → Astra 검수 라운드(P3 끝·중간).
