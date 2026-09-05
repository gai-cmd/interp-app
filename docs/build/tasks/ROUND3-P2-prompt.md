당신은 GPT-6 Astra이고, 이 저장소(`~/work/interp-app/`)의 설계자이자 구현자다. P1(순차통역·설정·PWA)은 완료됐다: `docs/design-v0.6.md`(확정 설계), `docs/p1-20b-review.md`(당신의 검수), `docs/build/P1-*.last.md`(과제별 보고), `docs/device-matrix.md`·`venue-runbook.md`·`release-checklist.md`(현재 판정: 구현 완료만 충족, 실기기·실키 미검증). 테스트 337개 통과.

이제 **P2 — 동시통역·설교 운영**을 설계 v0.6 §8.4·§8.5·§9·§10·§16(P2)·§17·§20 기준으로 구현 가능한 과제로 쪼개라. 코드 수정은 하지 말고 문서만 stdout으로 출력하라.

## 조건
- 각 과제는 당신이 한 번의 `codex exec`(샌드박스 workspace-write, 네트워크 없음)로 끝낼 크기: 신규·수정 파일 3~6개(테스트 포함), 완료 기준·완료 확인 명령(`node --test tests/*.test.mjs` 전체 통과 포함)·예상 함정 명시. P1 과제 목록과 같은 형식(`## P2-01 — 제목`, 목적/만들 파일/의존 과제/완료 기준/완료 확인 명령/예상 함정).
- 기존 계약을 깨지 말 것: 제공자 등록(§20, `app/providers/gemini/index.js`의 `live` 능력을 `planned`→`ready`), 세션 관리자 "앱 내 Live 1개"(순차 목소리와 동시통역이 동시에 열리지 않게 전환 규칙 명시), 라우터 이벤트 규약, i18n 키 3개 언어 동시 추가(`scripts/check-i18n.mjs`), UI는 `app/ui/shell.js`의 동시통역 탭(현재 aria-disabled) 활성화, 스타일 토큰 재사용, 릴리스 허용 목록(`scripts/stage-release.mjs`)에 새 파일 종류가 필요하면 그 과제에 명시.
- 이식 원본: `~/jarvis2/interp-web/lib/live.js`(SegmentAssembler·LiveLane: 번역 전용 모델 `gemini-3.5-live-translate-preview`의 translationConfig, flash-live 폴백, goAway 교체, quota fatal), `~/jarvis2/jp-patch/inject/main-handlers.js`(sim* 함수)와 `inject/ambient-state.js`(jpSim*: 32 ms 업링크·24k 재생·자막 flush 1.5초). 출처 주석 규칙 동일.
- 폰 마이크 설교 청취 모드(각자 키)와 **기존 맥 허브 방송 수신 모드**(`interp-web` 서버의 `/ws?room=코드` 프로토콜: hello / cast.caption{lang,segmentId,seq,text,final,revision} / cast.status / cast.stopped, 최근 자막 30개 재생)를 둘 다 다루되, 허브 수신은 `app/hub/{client,protocol}.js`로 분리하고 서버 코드는 수정하지 않는다.
- 실기기·실키·규모 시험은 과제로 넣되 "오케스트레이터/오너 입력 필요"로 표시하고 자동 검사와 구분하라. 규모 수치(최대 인원·언어 수·예배 길이)는 아직 미확정이다 — 파라미터로 남겨라.
- P1에서 드러난 함정을 반영: 빈 `speechSynthesis` 목록·첫 로드 예외·오류코드 정규식·Live 소켓 비정상 종료(ABORTED vs SESSION_CLOSED)·JSON 모듈 import의 Safari 미확인.

## 출력 구성
1. P2 상세 설계(바뀌거나 구체화되는 절만 전문: 동시통역 상태 기계, 오디오 큐·지연 예산·느린 수신자 처리, 자막 조립·revision·누락 표시, 세션 전환 규칙, 허브 프로토콜 매핑, 화면 명세, 오류·한도 처리, 측정 항목).
2. P2 과제 목록 P2-01부터(의존 순서대로).
3. 오너 결정·입력이 필요한 항목만 별도 목록(추천안 포함).
