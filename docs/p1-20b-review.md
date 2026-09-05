# P1-20b 검수·수정 보고

2026-09-05. 확정 기준은 `design-v0.6.md`이며, 편입된 v0.5 §8.3~8.5·§9.2·§9.4·§12를 함께 검토했다. `build/HANDOFF.md`, P1-12~P1-20 보고 및 원래 과제의 완료 기준을 대조했다. 설계 문서·`docs/build/*`·`tools/*`는 수정하지 않았고 커밋하지 않았다.

## 수정 결과

- **A:** 상태·진단·UI의 오류코드 형식을 `^[A-Z][A-Z0-9_]{0,39}$`로 통일했다. `UNKNOWN_429`가 자막 오류와 진단 결과까지 유지된다. 숫자 시작·소문자·공백·구분자·길이 초과 등은 거부하며, 제공자 오류 허용 목록은 기존 계약 그대로다. 미상 429는 한 번 호출하고 자동 대기·재시도를 하지 않는다.
- **B:** 세션 관리자가 수신한 `closed`를 기억하고, 그 종료로 생긴 내부 `ABORTED`만 `SESSION_CLOSED`로 정규화한다. 첫 오디오 이전 단절은 기기 음성으로 한 번 폴백하고, 오디오 수신 후에는 `partial`과 수동 재생 선택을 남긴다. 실제 사용자 취소는 두 시점 모두 `cancelled`이며 자동 기기 재생이 없다. 같은 문장을 자동 재전송하거나 소켓을 자동 재개설하지 않는다.
- **C:** 세션 관리자 → 음성 엔진 → 순차 엔진 → 셸의 구독을 연결했다. 세션 열림·종료·명시적 닫힘과 음성 상태 변경이 배지에 반영되며 종료 시 구독도 해제된다.
- 요청한 i18n 키 10개를 모두 연결했다. 기기 재생 버튼, 키 없음 배지, 짧은 교환 라벨과 별도 접근성 라벨, 제출 단축키 안내, 개인 키 저장 상태, 공용 이용 종료 시각, 기록·앱·이용 안내 제목, 다른 탭 닫기 안내에 사용한다. 기존 세 언어 JSON 문구만 사용한다.
- 설정·진단·PWA 스타일을 추가했다. 기존 색상·간격·반경·44px 토큰을 사용하고 좁은 화면에서 세로 배치한다. 입력·체크박스·라디오도 44px이며 긴 문구와 다크 모드를 기존 토큰으로 처리한다. 실제 브라우저의 픽셀 측정·스크린리더·확대 검사는 이번 세션에서 수행하지 못했다.
- 검수 중 추가로 찾은 위반도 수정했다. 진단과 순차 작업 사이의 녹음·재생 겹침 및 업데이트 적용 중 새 작업 시작을 앱 구성 단계의 `isBusy` 주입으로 차단한다. 서비스 워커는 이전 릴리스 캐시를 즉시 삭제하지 않으며 적용 직전 창 수를 다시 확인한다. 페이지도 정확히 창 하나일 때만 업데이트를 요청한다.

## 첫 페이지 부팅 조사

실제 헤드리스 Chrome의 최초 방문 현상은 **미재현**이다. 브라우저 스킬로 연결을 시도했으나 현재 세션의 브라우저 목록이 비어 있어 실제 Chrome·모바일 화면 검증을 수행하지 못했다.

대신 저장소에 추가된 빈 기기 음성 목록 재현 fixture를 실행해 **같은 부팅 중단을 Node 모의 환경에서 재현**했다. `getVoices()`가 `[]`를 반환할 때 빈 select의 값 배열 `[]`와 필요한 자동 옵션 배열 `['']`을 `join('\n')`으로 비교하면 둘 다 빈 문자열이다. 옵션 생성이 생략되고 `childNodes[0].textContent`가 예외를 발생시킨다. 다음 로드에서 음성 목록이 준비되면 이 조건이 사라진다. 이것은 관측 현상을 설명하는 확인된 코드 결함이지만 원래 Chrome 실패의 유일한 원인이라고 단정하지 않는다.

배열 길이도 비교해 빈 목록에서도 자동 옵션을 생성하고, `voiceschanged`를 받아 늦게 준비된 목록을 갱신한다. 빈 목록 → 3개 음성 목록 전환, 정상 셸 유지, SW 등록, 소켓 생성 없음, 종료 후 리스너 해제를 검증했다.

| 후보 | 조사·방어 결과 |
|---|---|
| SW 등록 | 셸·설정 구성 후 비대기 등록을 유지한다. 등록 거절을 주입해도 셸이 유지된다. 버전 조회는 기존 3초 제한을 유지한다. |
| AudioContext | 사용자 동작 전 생성하지 않는다. 생성자 실패·API 부재에서도 셸이 유지되고 기기 음성·자막 경로가 남는다. |
| i18n fetch | 거절 시 조용히 `null`로 끝나던 분기를 제거했다. 기존 공통 deadline으로 10초 상한과 AbortSignal을 적용하고, 실패 시 `#app`에 기존 `error.NETWORK_ERROR`를 표시한다. |
| localStorage | getter·읽기 실패는 저장소 없음으로 취급한다. 손상된 저장 키는 기존 정리·안내를 유지한다. 저장소 접근 거절을 주입해도 부팅한다. |
| DOM 준비 | 자동 진입은 문서가 파싱 중이면 DOMContentLoaded까지 기다린다. 첫 자동 진입에서 셸이 구성되는 모의 검사를 추가했다. |
| 기타 초기화 예외 | 구성·오디오·엔진 초기화까지 정리 경계를 넓혔다. 원문 오류를 버리고 `error.unknown`을 텍스트와 `role=alert`로 표시한다. 로그·오류 원문·키를 DOM에 쓰지 않는다. |

표시 언어 사전을 아직 얻지 못한 경우에는 모듈 의존성으로 읽어 둔 기존 `app/i18n/en.json`의 영어 문구를 사용하고 해당 영역의 `lang=en`을 설정한다. 문자열 복사나 새 라이브러리를 도입하지 않았다. 앱 모듈 그래프 자체가 로드되지 않는 네트워크 장애·문법 미지원까지 이 런타임 안내로 복구할 수는 없다.

## 과제별 파일 검수 표

표의 “유지”는 소스 검토와 해당 자동 테스트를 통과했다는 뜻이며 실키·실기기 합격을 뜻하지 않는다. “비해당”은 해당 파일이 그 정책을 실행하지 않는 정적 자산이라는 뜻이다. 테스트 파일은 같은 행의 제품 계약을 검증하는 증거로 검토했다.

| 과제·검토한 파일 | §8 엔진·폴백 | §9 한도·종료 | §11 보안 | §12 i18n | §20 제공자·완료 기준 및 조치 |
|---|---|---|---|---|---|
| P1-12: `app/providers/gemini/voice.js`, `app/engine/voice.js`, `tests/gemini-voice.test.mjs`, `tests/voice-policy.test.mjs` | 한 텍스트·PCM 스트리밍·턴 경계 재사용 유지. B 수정 | 첫 오디오 이전 폴백·이후 부분 실패·사용자 취소 분리. 자동 재전송 없음 | 출처 주석·비밀 없는 정규화 유지. Electron·Node ws·전체 PCM 누적 없음 | 오류·부분 실패·기기 음성 안내 키 유지 | 라우터 경유 유지. 구독 API 추가. Live 1개 계약 유지 |
| P1-13: `app/providers/gemini/index.js`, `app/config.js`, `tests/provider-integration.test.mjs` | 결합 WAV 번역과 독립 STT, 목소리 등록 유지 | 등록된 Gemini 모델 폴백·공통 예산 유지 | endpoint 고정·키 출처 격리·QR 덮어쓰기 차단 유지 | 제공자·이용 조건 키 유지 | 실제 제공자 Gemini 하나. translate/stt/voice ready, live planned 유지. 수정 없음 |
| P1-14: `app/engine/seq.js`, `app/state.js`, `tests/seq.test.mjs`, `tests/state.test.mjs` | 자막 확정과 음성 결과 분리, 새 발화 전 취소 유지 | A 수정. 진단과 겹치는 작업 시작 차단 추가 | 늦은 응답 폐기·키 변경 종료·공용 종료 시 대화 삭제·기록 OFF 유지 | 숫자 오류코드 메시지 연결 보완 | 기존 라우터·예산 사용. 음성 구독 전달 추가 |
| P1-15: `index.html`, `styles.css`, `app/ui/shell.js`, `app/ui/seq-view.js`, `app/ui/errors.js`, `tests/ui-format.test.mjs` | UI → 엔진 유지. PTT 대체 버튼·텍스트 입력 유지 | 연결 배지 C 수정. 최대 100개 턴 DOM 유지 | 원문·번역문 textContent, 비활성 동시통역 실행 차단 유지 | A 및 미연결 버튼·배지·힌트 수정. 설정·진단·PWA 스타일 추가 | UI에 endpoint·인증 처리 없음. 실제 모바일 시각·접근성 검증은 미검증 |
| P1-16: `app/ui/settings-view.js`, `app/ui/diagnostics-view.js`, `app/engine/diagnostics.js`, `tests/settings.test.mjs`, `tests/diagnostics.test.mjs` | 사용자 시작 검사·동일 음성 엔진 사용 유지 | 진단/순차 겹침 차단 추가. 진단도 공통 Live 슬롯 사용 | 개인/공용 구분·마스킹·허브 전용 키 입력 차단·검사 결과 무효화 유지 | A, 제목·저장 상태·종료 시각 연결, 빈 음성 목록 부팅 결함 수정 | 제공자 하나면 선택기 숨김. 등록과 기능 검사 결과 구분 유지. PTT 진단 범위는 아래 유지 결정 참조 |
| P1-17: `manifest.ko.webmanifest`, `manifest.en.webmanifest`, `manifest.ja.webmanifest`, `icons/icon-192.png`, `icons/icon-512.png`, `tests/manifest.test.mjs` | 비해당 | 비해당 | 외부 자산·APK·스토어 링크 없음 | 세 언어 이름·같은 앱 ID·scope·설치 이름 갱신 한계 유지 | 192/512 PNG 실제 규격·결정적 생성 일치 통과. 수정 없음 |
| P1-18: `sw.js`, `_headers`, `scripts/stage-release.mjs`, `scripts/check-release.mjs`, `tests/sw.test.mjs`, `tests/release.test.mjs` | API·오디오 캐시 제외 유지 | 자동 skipWaiting 없음. 적용 직전 창 수 재확인 추가 | 허용 목록·CSP·불변 버전 경로·완전 설치 유지. 이전 캐시 삭제 위반 수정 | 비해당 | 새 provider 등록 없이 endpoint와 CSP 일치. 릴리스 스크립트·헤더는 수정하지 않음 |
| P1-19: `app/main.js`, `app/pwa.js`, `tests/app-lifecycle.test.mjs`, `tests/pwa-policy.test.mjs` | capture·voice 한 인스턴스, 페이지 종료 정리 유지 | 부팅 deadline·상호 작업 차단 추가. 다중 탭 업데이트 보류 강화 | fragment 선제거·초기화 실패 정리·무로그 오류 안내 유지/보완 | pwa.closeOtherTabs 연결. 사전 실패 시 기존 영어 사전 안내 | 구성·엔진·UI 경계 유지. 첫 로드 방어 및 자동 진입 검사 추가 |
| P1-20: `tests/integration.test.mjs`, `tests/privacy.test.mjs`, `tests/fixtures/scenarios.mjs` | 무음·취소·늦은 응답·기기 폴백·부분 재생 유지/확장 | 미상 429 todo 제거. 소켓 단절 todo를 수신 전후/사용자 취소 포함 회귀로 전환 | 로그·저장소·오류·DOM·출하 산출물에 테스트 비밀 없음 검증 | 실제 문구 연결 결과 검증 | 빈 음성 목록 cold-load todo도 해결. 잘못된 키·진단 겹침 검사 포함. 전체 todo 0 |

관련 선행 파일인 `app/engine/session-manager.js`, `app/i18n/index.js`도 이번 예외 범위에서 수정했다. 전자는 B와 C의 실제 경계이며, 후자는 부팅 타임아웃의 fetch 취소 전달 경계다. 선행 구현 누락이나 임시 대체 어댑터는 없다.

재사용 원본의 `voiceOpen/voiceSpeak`, `voiceDirect/ttsDirect`, `jpGeminiSpeak` 및 translate/live/xlsx 경계를 읽고 기존 이식 출처 주석과 `reuse-map.md`를 대조했다. 이번 변경은 정책·연결·UI 보완이며 새 원본 코드를 이식하지 않았다. 기존 프로젝트를 런타임에서 import하지 않는다.

## 설계 해석·유지 결정과 다음 과제 주의

- 설계 변경 없이 오류 분류·이벤트 구독·초기화 복구를 보강했다. 10초 부팅 제한은 새 앱 정책값으로, 제공자 호출 3회 예산과 별개이며 자동 API 재시도를 추가하지 않는다.
- 부팅 실패 안내용 영어 사전은 JSON 모듈 import를 사용한다. 빌드·외부 패키지는 없다. P1-21에서 실제 지원 대상 Safari/Chrome의 JSON 모듈 지원 및 릴리스 경로·JSON MIME을 확인해야 한다. 모듈 자체가 실행되지 않는 장애는 이 안내의 범위 밖이다.
- 기존 P1-16의 `ptt` 진단은 마이크 캡처 + **독립 stt 전사** 검사다. 네 능력 중 stt의 개별 검사를 보존하기 위해 유지했다. 이 성공을 결합 WAV 번역이나 음성 출력 성공으로 확대하지 않는다. 일반 PTT는 기존 결합 translate 요청 1회이며 Node 통합 검사가 이를 별도로 확인한다. P1-21 실키 검증에서는 실제 순차 PTT 전체 경로를 별도로 실행해야 한다.
- 이전 릴리스 캐시를 보존한다. 오래된 캐시의 안전한 수거는 별도 보존 정책과 구버전 탭 검증 없이 추가하지 않는다. 다중 탭 재확인은 최선 노력이며 다른 브라우저·기기까지 Live 수를 강제하지 않는다.
- Live 직접 인증의 기존 WebSocket 생성 시점 인증 URL은 유지한다. 앱 페이지 URL·로그·진단·저장소·출하 산출물에는 보관하지 않는다. REST 인증은 기존 헤더 경계다. 이를 모든 네트워크 URL에서 키가 사라졌다는 주장으로 확대하지 않는다.
- P1-21에 남는 항목: Android/iPhone 실키 6방향 발화, 설치 PWA/복귀/업데이트, 실제 44px·확대·다크 모드·스크린리더, cold-load Chrome 재확인, 행사장 안팎 REST/Live 제한, 이용 조건·대상 검토. 이번 Node 성공을 개인/PWA/공용 출시 검증 완료로 기록하지 않는다.

## 실행 결과

Node `v24.18.0`. 실행 디렉터리는 저장소 루트다.

| 명령 | 결과 |
|---|---|
| `node --test tests/*.test.mjs` | 337 통과(기능 검사 336 + 디렉터리 진입 파일 1), fail 0, todo 0, 취소·skip 0 |
| `node --test tests/` | 내부 기능 검사 336 통과, 상위 진입 검사 1 통과, 모두 fail 0·todo 0 |
| `node scripts/check-i18n.mjs` | I18N_OK, 3개 언어·205개 키·39개 소스 |
| `node scripts/stage-release.mjs --id p1-20b --out /tmp/interp-rel-p1-20b && node scripts/check-release.mjs /tmp/interp-rel-p1-20b` | RELEASE_STAGED 및 RELEASE_OK, 52개 파일 |
| `rm -r /tmp/interp-rel-p1-20b` | 생성·검증한 임시 산출물 정리 완료 |
| `git diff --check` | 통과 |

요청한 원래 `rm -rf` 포함 명령은 자동 승인 검토가 강제 삭제 옵션을 이유로 실행 전에 거절했다. 생성·검증은 같은 명령으로 실행하고, 정리는 허용되는 비강제 `rm -r`로 수행했다.

Node 24.18.0에서 명시적 `tests/` 인자는 자동 파일 탐색이 아니라 모듈 진입 경로로 처리되어 최초 실행이 MODULE_NOT_FOUND로 실패했다. `tests/package.json`과 `tests/directory.test.mjs`를 추가해 같은 `.test.mjs` 목록을 새 테스트 조정 프로세스에서 실행한다. 기존 세션 관리자 테스트의 의도적 종료 실패 상태가 다른 파일로 전파되지 않도록 파일별 프로세스 격리를 보존한다. glob 명령에서는 진입 파일이 하위 실행을 하지 않아 중복·재귀 실행이 없다.

부팅·통합·개인정보·세션·음성 정책·UI·설정·PWA·SW 대상 테스트도 수정 중 실행했다. 초기 실패는 교체된 UI 라벨의 이전 기대값과 새 결함 재현 검사였으며, 제품 수정 및 기대 문구 갱신 후 전체 검사를 통과했다.

## 신규·수정 파일

- `app/engine/diagnostics.js`
- `app/engine/seq.js`
- `app/engine/session-manager.js`
- `app/engine/voice.js`
- `app/i18n/index.js`
- `app/main.js`
- `app/pwa.js`
- `app/state.js`
- `app/ui/errors.js`
- `app/ui/seq-view.js`
- `app/ui/settings-view.js`
- `app/ui/shell.js`
- `styles.css`
- `sw.js`
- `tests/app-lifecycle.test.mjs`
- `tests/fixtures/scenarios.mjs`
- `tests/integration.test.mjs`
- `tests/privacy.test.mjs`
- `tests/settings.test.mjs`
- `tests/state.test.mjs`
- `tests/sw.test.mjs`
- `tests/ui-format.test.mjs`
- `docs/p1-20b-review.md`
- `tests/package.json`
- `tests/directory.test.mjs`
