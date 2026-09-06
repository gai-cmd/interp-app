# P3-00 동시통역 연속성·키 저장 점검 보고

2026-09-06. P3-00만 구현했다. 현재 저장소의 `design-p3.md`에는 P3-00 절이 없어 이번 사용자 과제 본문을 우선 적용했다. `DESIGN.md`, P2 §7.3·8.4~8.6·17, v0.6 §11·12·20 및 편입된 v0.5 §12, P1 검수·과제별 보고 계약을 대조했다. 설계 문서·`docs/build/*`·`tools/*`는 수정하지 않았고 커밋하지 않았다.

## 발견한 원인·게이트

| 경로 | 확인 결과와 조치 |
|---|---|
| Gemini `live.js` | 청크를 `audio` 이벤트로 즉시 전달한다. `finished`·`generationComplete`·`turnComplete` 대기 게이트 없음. 보존했다. |
| `sim.js` | `audio` 이벤트에서 바로 스트림 재생기로 전달한다. 자막을 별도 voice로 보내지 않는다. 운영 계측 수집과 모델 선택을 연결했다. |
| `pcm-player.js` | `enqueue`에서 즉시 예약한다. `finish`는 유한 턴 종료용이며 동시통역의 재생기가 아니다. P1 계약 보존을 위해 수정하지 않았다. |
| 실제 동시통역 `stream-player.js` | 약 60ms 여유로 즉시 예약한다. 8초 초과 시 따라잡기에서만 턴 경계를 기다리며 최대 2초 뒤 강제 복귀한다. 의도한 과부하 정책이므로 유지했다. 음소거·오디오 차단 시 청크 폐기도 유지했다. |
| 마이크 업링크 | 32ms PCM 프레임을 연속 전송한다. 무음에서 `activityEnd`·`audioStreamEnd`를 보내지 않는다. 직접 중지는 기존처럼 소켓을 닫는다. `finishInput` API의 명시적 종료 기능은 보존하되 실행 중 호출하지 않는다. |
| `segment-assembler.js` | 전사 도착 때 partial을 즉시 발행한다. 1.5초 로컬 확정 타이머는 표시·PCM 게이트가 아니다. 유지했다. |
| `caption-store.js`·`sim-view.js` | partial 즉시 저장·렌더, 같은 행에서 final 교체가 이미 동작한다. partial 낭독 금지를 유지하고 muted 글자색을 보강했다. |
| 서버 응답 | 기존 setup은 VAD 값을 생략했다. 명시적 VAD 정책과 Flash 구 단위 통역 지시를 추가했다. 폰 관찰의 원인이 서버 VAD라고 확정할 증거는 없으며 실키 재현은 남았다. |
| 진단 | `listen-metrics.js`가 있어도 직접 엔진·main 설정 진단 연결이 없었다. 수신·예약·partial·final·setup 및 발화 상대 지연을 연결했다. |
| 키 저장 | 저장 기능은 있었지만 저장 완료를 키 섹션에 표시하지 않았다. 체크 기본 OFF 때문에 재방문 시 키가 사라지는 것이 오류처럼 보일 수 있었다. 저장 결과·오류를 섹션 안에 지속 표시하고 배지를 갱신한다. |

## 정책값·설계 대비 결정

- `LIVE_VAD`: `disabled: false`, `silenceDurationMs: 400`, `prefixPaddingMs: 100`, `START_SENSITIVITY_HIGH`, `END_SENSITIVITY_LOW`. 400ms는 짧은 구 사이 침묵에 반응하되 100ms 같은 공격적 분할을 피하는 초기 정책이다. onset padding을 0으로 줄이지 않고 종료 감도를 낮게 두어 잘림을 완화한다. 실측 최적값이나 응답 지연 보장이 아니다. 상수와 영어 근거 주석을 남겼다.
- Flash 프롬프트에 이해 가능한 부분 구부터 통역하고 문장 완성을 기다리지 말라는 지시를 추가했다. 번역 전용 3.5에는 시스템 지시를 보내지 않는다.
- 기본은 `gemini-3.5-live-translate-preview` 유지. [Google 번역 가이드](https://ai.google.dev/gemini-api/docs/live-api/live-translate)는 이 모델을 턴을 기다리지 않는 연속 번역 처리로 설명한다. 3.1 Flash가 더 빠르다는 실측 증거는 없다. 설정에서 3.5·3.1·기존 2.5 후보를 선택한다. 변경은 현재 통역을 종료하고 다음 수동 시작에 적용한다. 선택은 이번 실행 동안 유지한다. 기존 오류별 폴백·재연결 예산은 유지한다.
- VAD 필드는 [Google Live 기능 가이드](https://ai.google.dev/gemini-api/docs/live-api/capabilities)를 참고했다. 설정 지원·지연·잘림은 실제 계정과 모델별로 시험해야 한다. 문서 조회일은 2026-09-06이다.
- 개인 키 저장 체크는 저장소가 제공된 화면에서 기본 ON이다. 이미 메모리 전용 키가 있으면 그 선택을 유지한다. v0.6 §11.1의 메모리 기본과 다른 **UI 기본값**이며 개인 폰 중심이라는 이번 과제 지시를 적용했다. 키 저장소 API의 `remember=false` 기본, 공용 키 메모리 전용, 저장 버튼을 눌러야 저장되는 규칙은 유지한다. 경고를 체크박스 바로 옆에 연결했다.
- 저장 성공은 API 인증 성공을 뜻하지 않는다. 형식 오류는 `INVALID_KEY`, 저장소 쓰기 오류는 `STORAGE_FAILED` 사용자 문구로 표시한다. 원본 오류·키는 표시하지 않는다. 기존 상단 오류 알림도 유지한다. 서버의 키 유효성은 사용자가 실행하는 기존 연결 검사로 확인한다.
- 기존 P1 테스트 조정: `settings.test.mjs`의 메모리 저장 시나리오에서 기본 ON을 단언한 뒤 명시적으로 체크를 해제한다. `app-lifecycle.test.mjs`의 unload 단언은 기본 저장 키가 남는 것으로 변경했다. 저장 선택 정책이 바뀌었기 때문이며 테스트 삭제·skip은 없다.

## 계측 해석

`firstAudioReceivedMs`는 실행 시작부터 첫 청크 수신, `firstAudioScheduledMs`는 실행 시작부터 첫 성공한 예약 호출까지다. AudioContext 시각과 로컬 시각을 빼지 않는다. 예약 호출 시각은 실제 소리 시작 시각이 아니다.

새 `speechToFirstAudioMs`와 `speechEndToFirstAudioMs`는 로컬 마이크 RMS 0.01 이상을 발화로 보고 400ms 무음 뒤 종료를 확인한다. 종료 시점은 마지막 유성 레벨 관측이다. 발화 중 첫 오디오가 도착하면 종료 후 상대 지연은 음수가 될 수 있다. 아직 확인되지 않은 수치는 미측정으로 표시한다. 후속 발화에서 새 표본으로 갱신하며 재연결 시 진행 중 대응을 버린다. 완료한 마지막 표본은 남긴다.

이 값은 로컬 근사다. 배경 소음·반향·조용한 목소리·이전 구의 늦은 출력 때문에 입력/출력 대응이 어긋날 수 있다. 원문·오디오·키를 보관하지 않고 숫자만 유지한다. 실제 첫소리와 종단 지연 판정에는 외부 녹음·영상 관측이 필요하다. 설정의 진단에서 운영 수치를 확인할 수 있다. 기존 미연결 허브 계측까지 완료한 것으로 보지 않는다.

## 검증

Node v24.18.0에서 직접 실행했다.

| 명령 | 결과 |
|---|---|
| `node --test tests/*.test.mjs` | 607 통과, 실패·취소·skip·todo 0 |
| `node --test tests/` | 내부 606개 및 디렉터리 진입 1개 통과 |
| `node scripts/check-i18n.mjs` | I18N_OK, 3개 언어·321개 키·57개 파일 |
| `node scripts/stage-release.mjs --id p3-00 --out /tmp/interp-rel-p3-00 && node scripts/check-release.mjs /tmp/interp-rel-p3-00 && rm -r /tmp/interp-rel-p3-00` | RELEASE_OK, 72개 파일, 임시 산출물 정리 |
| `git diff --check` | 통과 |

회귀 단언: 최종 확정 전 PCM 예약과 partial 표시, 무음 포함 세션 중 종료 신호 미전송, partial 행 재사용과 final 교체, VAD·Flash 지시, 모델 변경 시 종료·수동 재시작, 저장 확인·언어 갱신·저장소 실패·무효 키, 발화 종료 전 음수 지연과 종료 뒤 양수 지연.

Browser 스킬로 실제 화면 검증을 시도했으나 `Browser is not available: iab`로 연결되지 않았다. DOM 회귀는 통과했지만 430/768/1280px, 다크 모드·포커스·44px 실측과 실키·폰 음성 검증은 미검증이다. 앱 지연 경로의 회귀 통과를 오너의 실기기 증상 해소로 단정하지 않는다.

## 파일과 인계

수정: `app/engine/listen-metrics.js`, `app/engine/sim.js`, `app/providers/gemini/live-config.js`, `app/ui/settings-view.js`, `app/main.js`, `app/i18n/{ko,en,ja}.json`, `styles.css`, `tests/{app-lifecycle,gemini-live,listen-metrics,settings,sim-view,sim}.test.mjs`, `docs/p2-device-results.md`.

신규: `docs/p3-00-review.md`.

새 외부 패키지·빌드 도구·별도 제공자 세션·네트워크 경로는 없다. 기존 이식 출처 주석을 유지했고 신규 원본 이식은 없다. 오너의 문장별 재현·두 모델 비교 절차는 [실기기 결과표](p2-device-results.md#p3-00-오너-연속성키-저장-재시험)에 있다. 다음 과제는 실제 모델·계정·기기별 지연과 잘림 증거를 채우고, 기존 P2 규모·전체 예배 출시 보류 조건을 유지해야 한다.
