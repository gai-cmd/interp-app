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
- 2026-09-06 12:1x JST · 오너 "멈춰 · 옆 세션에서 이어서" → 모든 빌더 정지. 상태: main 330c7f9(+보고서 커밋), P3 완료 12/44(P3-00·01·02·02b·02c·02d·03·04·05·06·09·10 done), **P3-07은 워크트리 `/tmp/interp-lanes/P3-07`(브랜치 task/P3-07)에 3차 시도까지 한 상태로 남김** — 이어갈 때 그 워크트리에서 `node --test tests/*.test.mjs` 확인 후 통과면 커밋·`git merge task/P3-07`·`.done` 표시, 아니면 워크트리 삭제 후 스케줄러가 새로 시작. 재개 명령: `cd ~/work/interp-app && python3 tools/scheduler.py P3 2` (P3-02e 포함). 배포 최신: gh-pages = p3-mute-20260906(하드 뮤트·파비콘). 오너 미확인 항목: 동시통역 대답 금지 재검증, 소리 끄기 잔여음(내 폰 마이크/현장 방송 어느 모드인지), iOS에서 키 미보존(P3-02e).
- 2026-09-06 15:0x JST · 옆 세션(Opus) 세션 한도 → **이 세션(Fable 5.1, `~` 작업 디렉터리)으로 인계**. P3-07 4차를 직접 마무리(`widened()` 진상위집합 판정, 710/710) → 병합·`.done`. `python3 tools/scheduler.py P3 2` 재개(로그 `docs/build/round5-p3.log`). 오너 12:01 보고("동작 안 함·동시통역 기본 탭")는 P3-02e 과제로 큐에 있음.
