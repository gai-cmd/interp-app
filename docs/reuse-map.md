# 재사용 원본과 이식 경계

2026-09-05에 로컬 원본을 읽고 파일 전체 바이트의 SHA-256을 계산했다. 아래는 P1-01의 비교 기준이며 실제 이식 완료나 제공자 최신 지원 검증을 뜻하지 않는다. 원본은 수정하지 않았다. 실행 기반 코드는 신규 작성으로 이식 코드가 없다.

## 원본 지문

경로의 `~`는 `/Users/gai`다. 원본 파일의 줄바꿈·주석을 포함해 해시한다.

| 원본 | SHA-256 |
|---|---|
| `~/jarvis2/interp-web/lib/translate.js` | `718fa137329f2ef4d5b0291ca3e445ddfcd1118fb2c7d01bc1fdf492c4d95cad` |
| `~/jarvis2/interp-web/lib/live.js` | `8afc7818740a45bb69e349450f4290b9574adcd24cb8ee294060ec08056febfe` |
| `~/jarvis2/interp-web/lib/xlsx.js` | `5e6236e0fa95e4db2efa67107e8729896903096508379f193b3abfb346578d67` |
| `~/jarvis2/jp-patch/inject/main-handlers.js` | `b00a8d33e6d2eea4c072c948b921b5b42f7ad0ad2a445e0f4b3eff074147e78b` |
| `~/jarvis2/jp-patch/inject/ambient-state.js` | `7a0a3653557f2c173e0b3aab0e5b7a71f282e2212aa92a072b08af485a0b8e60` |

재확인 명령:

```sh
shasum -a 256 ~/jarvis2/interp-web/lib/{translate,live,xlsx}.js ~/jarvis2/jp-patch/inject/{main-handlers,ambient-state}.js
```

다르면 새 원본을 검토하고 이식 파일의 출처 지문을 갱신한다. 예전 지문을 현재 원본의 지문이라고 복사하지 않는다. 범위 밖 파일인 이 문서의 갱신이 필요하면 별도 과제로 남긴다.

## 대응과 검증

| 원본·심벌 | 대상·과제 | 유지할 동작 | 제거·변경 및 검증 |
|---|---|---|---|
| translate.js: LANG, LANG_RULES, rulesFor, clean, inTargetLanguage, translate | `app/providers/gemini/prompts.js`, `translate.js`, `stt.js` 및 `app/engine/output-validator.js` (P1-06·08) | 구어체·격식·감정·숫자 보존 지시, 출력 정리 참고 | CommonJS와 URL 키 제거. 문자 종류 기반 거부·자동 통과를 재검토. WAV 전사+번역, 구조화 결과, 무음/인식 불가, abort·크기·시간 상한 추가. 별칭 자동 순환·모델별 설정 중첩 재시도 제거, 공통 3회 예산·모델 2개. 혼합 언어·숫자·고유명사와 기존 프롬프트 동작 비교 |
| live.js: buildSetup, LiveLane, SegmentAssembler | `app/providers/gemini/live-client.js` 프로토콜 참고(P1-11); `app/providers/gemini/live.js`, `app/engine/segment-assembler.js` (P2) | setupComplete, 자막 조각·문장 경계·revision, 종료 메시지 참고 | require('ws')·Buffer·process.env·Node 이벤트·숨은 재접속 제거. 원본은 다음 소켓을 먼저 여므로 종료 확인 후 교체로 변경. 원본의 오디오 폐기 정책은 폰 동시통역에서 직접 재생으로 변경. 100ms 묶음은 설계의 초기 32ms와 구분. Blob/ArrayBuffer 순서·goAway·중단·세대·타이머 테스트 |
| main-handlers.js: voiceOpen, voiceSpeak, voiceClose, voiceTurnEnd | `app/providers/gemini/live-client.js`, `voice.js`, `app/engine/voice.js` (P1-11·12) | setup 대기, 한 텍스트 턴, 스트리밍 PCM, 선택 전사 | Electron sender/IPC·Node 이벤트·로그·PCM 전체 누적·캐시 제거. 종료 확인·abort·턴/세대 격리·부분 실패 정책 추가. 늦은 청크, 연결 중 취소, 부분 재생 뒤 중복 읽기 검사. 원본 40턴/4분은 API 한도 보장이 아님 |
| main-handlers.js: ttsDirect, voiceDirect | `app/providers/gemini/voice.js` (P1-12) | 입력 문장만 읽고 대답·설명·번역·첨가하지 않는 지시 | 자유 페르소나·맥 로컬 Qwen3/say·TTS API 모델 폴백 제외. voiceDirect 중심으로 역할을 제한하고 ttsDirect는 지시 비교 자료로 사용. 생성 음성의 완전한 문자 일치 보장 금지 |
| ambient-state.js: jpGeminiSpeak | `app/audio/pcm-player.js` (P1-10) | 24kHz PCM 변환·AudioContext 시간 예약 | React ref·electronAPI 제거. DataView로 little-endian 명시, source 종료 해제·큐 상한·취소·타이머 정리 추가. 원본 firstMs는 청크 수신 시각이므로 실제 첫소리와 구분. 취소 후 무음·연속 청크 예약·리소스 해제 검사 |
| xlsx.js: workbook, zipStore, crc32, sheetXml, xmlEsc, colRef | `app/records/xlsx.js` (P3) | 무압축 ZIP·CRC32·OOXML·inline string | CommonJS·Buffer를 Uint8Array/DataView/TextEncoder로 교체. ZIP 무결성·유니코드/XML 이스케이프·셀 참조·문자열의 수식 비실행을 검증. P1 파일 생성 없음 |
| 기존 interp-web 허브 | 선택적 행사장 서버(P2) | 현장 언어별 방송 운영 참고 | P1 수정·필수 의존 없음. 개인 앱은 허브 없이 작동 |

원본 기능의 동등성 검사는 필요한 동작의 회귀를 확인한다. 약한 검증, 비밀 노출, 무제한 재시도까지 보존하지 않는다. 실제 키·발화는 fixture에 쓰지 않는다. 원본 CommonJS를 ES 모듈인 것처럼 직접 import하거나 Node ws를 브라우저로 가져오지 않는다.

## 이식 파일 출처 주석

이식하는 각 파일 맨 위에 아래 필드를 영어 주석으로 기록한다. 여러 원본이면 각각 명시한다. `<...>`는 실제 이식 때 채우며 구현 파일에 미완성 표기를 남기지 않는다.

```js
/**
 * Ported from: <original path>
 * Symbols: <original symbols>
 * Ported on: <YYYY-MM-DD>
 * Source SHA-256: <full-file hash>
 * Changes: <removed runtime dependencies and intentional behavior changes>
 */
```

## 후속 과제 경계

P1-02는 제공자 등록·라우팅의 구체 필드/이벤트 API, P1-05는 공통 예산·Live 소유권, P1-07은 바이너리 형식, P1-14는 상태 전이를 구현한다. 이 단계에는 선행 구현 의존성 누락이 없으며 대체 모듈을 만들지 않았다. [architecture.md](architecture.md)의 의미 계약을 사용하고 과제에 허용된 파일만 작성한다.

Live 원본은 키를 WebSocket URL에 붙인다. 이를 그대로 이식하면 사용자 지시의 URL 비밀 금지와 충돌한다. P1-11은 제공자 인증 지원을 확인해 이 경계를 해결해야 한다. P1-01에서는 API 연결이나 인증 URL을 생성하지 않았다.

## P2-02 자막 조립기 이식 — 2026-09-05

`app/engine/segment-assembler.js`는 원본 `live.js`의 `SegmentAssembler`를 제공자 독립 ES 모듈로 이식했다. 원본 전체 SHA-256을 다시 계산하여 위 지문과 일치함을 확인했다. 원본의 문장·침묵 확정과 partial revision 개념을 유지하고, 무조건 덧붙이기·입출력 공유 ID·중단 시 정상 확정은 제거했다. 다른 원본의 음성·번역·xlsx 구현은 이번 과제에서 이식하지 않았다.

### 호출 계약과 설계 구체화

- `new SegmentAssembler({ sessionId, generation, role, onSegment, clock?, silenceMs?, maxChars?, gapBefore? })`. 실행 세션·연결 세대·역할마다 하나를 생성한다. 같은 역할/세대에 조립기를 다시 만들면 카운터가 초기화되므로 반드시 새 generation을 부여한다. ID는 네 요소의 JSON 배열 직렬화로 구분자 충돌을 방지한다.
- `push({ text, mode: 'delta' | 'snapshot', finished? })`. delta는 그대로 추가한다. snapshot은 **현재 미확정 꼬리 전체**를 교체하며 빈 문자열도 삭제 수정으로 반영한다. 반복 발화를 추측으로 제거하지 않는다. 여러 확정 문장을 포함한 제공자 누적 snapshot은 어댑터가 구간별 수정으로 정규화해야 한다. 허브 snapshot을 이 조립기에 넣지 않는다.
- `flush()`와 `turnComplete()`는 정상 확정이다. 기본 침묵 제한은 마지막 유효 전사 입력부터 1,500ms이며, 원본 1,200ms를 변경했다. 빈 finished도 남은 자막을 확정한다.
- `interrupt()`는 현재 꼬리를 interrupted로 끝내고 다음 발화를 허용한다. `cancel()`은 중지·단절·세대 교체용 영구 종료이며 이후 입력·수정·타이머를 무시한다. 두 메서드는 멱등적이다. 종료 시 타이머와 버퍼를 정리하며 cancel은 수정 캐시도 비운다.
- 출력은 §8.6의 공통 구간 모델이다. `sequence`는 역할별 구간 번호이며 이벤트마다 증가하는 원격 seq가 아니다. `revision`은 같은 ID에서 증가한다. `receivedAt`은 첫 구간 생성 시각, `finalizedAt`은 종료 시각(partial은 null)이다. 기본 시계는 `performance.now()`이며 가짜 시계는 `now/setTimeout/clearTimeout`을 주입한다. `gapBefore`는 최초 구간에만 적용한다. 제공자 메타데이터는 이 모듈이 생성하지 않는다.
- `revise(id, { text, revision })`는 최근 종료 구간 100개에 대한 명시적 전체 문구 수정이다. 낮거나 같은 revision, 알 수 없는 ID는 false를 반환한다. final/interrupted 상태와 최초 확정 시각은 유지한다. 수정 문구도 길이 상한을 따른다. 과거 자막 저장·재생 여부는 P2-08 이후 소비자 책임이며 이 모듈은 음성을 실행하지 않는다.
- 미지정 길이 정책은 원본의 140을 유지하되 UTF-16 코드 단위 대신 `Intl.Segmenter`의 grapheme 수로 해석한다. 긴 단일 입력도 여러 구간으로 분할한다. 상한과 정확히 같은 길이에서는 마지막 grapheme의 다음 조각 결합을 위해 다음 입력 또는 침묵/턴 종료까지 확정을 보류한다. 문장 경계는 일본어·한국어·영어 문장부호와 닫는 따옴표를 처리한다. 소수점·대표 영어 약어를 보수적으로 보호하며 입력 끝의 마침표는 다음 조각 또는 침묵/턴 종료까지 보류한다. 모든 언어의 약어·문장 의도를 완벽하게 판별하는 규칙은 아니다.

### 선행 계약과 후속 주의

P2-01의 `app/providers/contract.js`가 존재하며 `ProviderError`를 상대 경로로 재사용한다. 선행 구현 누락이나 대체 제공자 모듈은 없다. 조립기 메서드·snapshot 범위·수정 캐시는 상세 설계에 함수 시그니처가 없어 이 파일 안에서 정의한 인터페이스다.

P2-03은 제공자 전사의 delta/snapshot 의미를 확인하고 위 인터페이스로 정규화해야 한다. P2-01 라우터 subtitle에서는 `id → segmentId`, `sequence → seq`, `status === 'final' → final`로 매핑한다. 라우터가 `status`, 타임스탬프, gapBefore를 전달한다고 가정하지 않는다. 중단은 기존 별도 `interrupted` 이벤트로 전달하고 P2-08/09에서 미확정 자막 상태를 처리한다. 실행 ID는 기존대로 라우터 context가 우선한다. final의 높은 revision을 새 낭독으로 취급하지 않는 소비자 중복 억제도 필요하다.

UI·네트워크·로그·저장소 코드는 추가하지 않았다. 입력 오류에는 기존 `INVALID_REQUEST`만 사용하여 사전에 없는 UI 문구나 입력 원문이 든 오류를 생성하지 않는다. P1 인증·세션 소유권·음성 폴백·배포 계약은 변경하지 않았다.

### 검증

`tests/fixtures/segments.mjs`는 합성 발화와 주입 가능한 가짜 시계다. `tests/segment-assembler.test.mjs`는 문장부호·조각 사이 소수점·약어·혼합 언어·반복 발화·Unicode·침묵 재설정·역할/세대 ID·revision·삭제 snapshot·종료·타이머 정리를 검사한다. 전체 회귀 및 G 실행 결과는 완료 메시지에 기록한다. 실제 제공자 연결·실기기 시험은 이번 과제 범위가 아니다.
