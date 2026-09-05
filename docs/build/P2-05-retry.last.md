완료 기준은 아직 미충족입니다. **Live ready 등록과 기존 설정 테스트의 planned 기대값이 충돌합니다.**

- 이번 수정: `tests/provider-integration.test.mjs`, `docs/architecture.md`. 실제 진단의 `ready / untested / result=null` 분리 검증과 충돌 근거를 추가했습니다.
- 기존 구현 유지: `app/providers/gemini/index.js`, `app/config.js`, `app/engine/live-recovery.js`, `tests/live-recovery.test.mjs`.
- 지정 테스트: **19개 통과**.
- `node --test tests/*.test.mjs`: **406개 통과, 1개 실패**.
- `node --test tests/`: 같은 설정 테스트로 실패.
- i18n 검사·`git diff --check`: 통과.

설계 변경이나 테스트 우회는 하지 않았고 커밋도 없습니다. 후속 엔진은 실행 전체에서 같은 복구 예산을 유지하고, 실제 소켓 종료 확인 후 재연결해야 합니다.

`tests/settings.test.mjs`의 두 기대값을 `planned → untested`로 수정하도록 범위를 확대해 주시겠습니까? 사용자 지정 6개 파일 밖이어서 확인이 필요하며, 수정 대상은 상태 기대값과 언어 전환 후 사전 키 두 곳입니다.