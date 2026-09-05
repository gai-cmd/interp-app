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

## P2-03 Gemini 단일 동시통역 연결 — 2026-09-05

지정된 원본 5개의 SHA-256을 다시 계산하여 위 지문과 일치함을 확인했다. `live-config.js`는 `live.js`의 모델 후보·`buildSetup`을, `live.js` 어댑터는 `LiveLane`의 전사·송신 및 `main-handlers.js`의 `voiceOpen` PCM 수신 경계를 참고하여 이식했다. 두 구현 파일 상단에 출처·심벌·날짜·해시·변경점을 기록했다. `translate.js`, `xlsx.js`, `ttsDirect/voiceDirect`, `voiceSpeak`, `jpGeminiSpeak`는 재사용 경계를 대조했으며 이번 구현에 별도 번역·xlsx·낭독·재생 코드를 추가하지 않았다.

### 호출 계약

- `createGeminiLive({ live, clock? }).open({ input: { format: 'pcm16', sampleRate?: 16000, channels?: 1 }, targetLanguage: 'ko' | 'en' | 'ja', model? }, context)`를 제공한다. `context`는 기존 라우터의 signal·sessionId·generation·turnId·주소·자격증명 참조다. 조립기 ID를 위해 비어 있지 않은 sessionId와 0 이상의 정수 generation이 필요하다.
- `live`는 기존 `createGeminiLiveClient()` 인스턴스다. P2-05에서 voice와 **동일 인스턴스**를 주입하고 세션 관리자를 통해 열어야 한다. 이 어댑터는 소켓·인증 URL·키 조회를 만들지 않는다. 기존 P1의 소켓 생성 시점 인증 URL 경계는 수정하지 않았다.
- `sendAudio(pcm)`는 PCM16 little-endian·mono·16kHz를 담은 `Uint8Array`를 받는다. 2~1,024바이트의 짝수 길이만 허용하여 32ms 프레임과 마지막 짧은 프레임을 지원한다. subarray의 실제 바이트 범위를 그대로 인코딩하며 누적·재전송하지 않는다. 숫자 샘플 배열이나 WAV를 자동 변환하지 않는다.
- `finishInput()`은 `realtimeInput.audioStreamEnd = true`를 한 번 전송한다. 서버 자동 VAD를 유지하는 setup에 맞는 신호이며, `activityEnd` 또는 텍스트 `clientContent.turnComplete`로 대체하지 않는다. 입력 종료 후 출력은 계속 수신하지만 추가 `sendAudio`는 거절한다. 프로토콜 자체는 새 오디오로 입력 재개를 허용하나, 앱의 finish 인터페이스는 이 연결의 입력 종료로 정의했다. [공식 WebSocket 프로토콜](https://ai.google.dev/api/live)의 자동 VAD·audioStreamEnd 정의를 확인했다.
- `close()`는 멱등적이며 기존 transport의 close 확인·실패를 그대로 기다린다. `closed`는 물리적 종료 promise다. timeout을 종료 성공으로 바꾸지 않는다. setup 도중 취소 후 늦게 반환된 transport도 닫힌 뒤 open을 거절한다.

### setup·이벤트와 검증 정책

- 설계의 세 모델만 고정했다. 번역 전용 모델에는 translationConfig·입출력 전사만 설정하고 systemInstruction은 보내지 않는다. 두 flash 후보는 목표어 통역 전용 고정 프롬프트를 사용한다. 원어 힌트·자유 프롬프트·페르소나를 setup으로 전달하지 않으며, 목소리는 검증된 목록이 없으므로 지정 시 SETTINGS_UNSUPPORTED다. 모델 후보 선언은 실제 서비스·계정 지원 검증을 의미하지 않는다.
- `inputTranscription`과 `outputTranscription`은 원본의 증분 전사 경로를 유지해 각각 `mode: 'delta'`로 조립한다. 반복 문자열을 추측으로 제거하지 않는다. `interimInputTranscription` 같은 수정 가설은 이 증분 경로에 섞지 않으며, 향후 모델이 누적 snapshot을 반환한다면 해당 모델 정책과 정규화 검사를 별도 추가해야 한다. 전사의 실제 모델별 특성은 실키 시험에 남는다.
- `finished: true`는 텍스트가 없는 메시지에서도 해당 조립기를 확정한다. 이는 이식 원본과 상세 설계의 호환 필드이며 현재 공식 전사 스키마의 필수 제공 필드라고 주장하지 않는다. turnComplete와 1.5초 침묵도 확정한다. generationComplete는 턴 완료와 구분하여 자막·오디오 완료 신호로 사용하지 않는다. 공식 프로토콜은 생성 완료 뒤 재생 대기에 따라 turnComplete가 늦게 올 수 있다고 명시한다.
- source/translation 조립기는 별도 ID·카운터를 쓴다. subtitle에는 `id → segmentId`, `sequence → seq`, revision·role·final과 해당 역할의 텍스트만 전달한다. 원문을 받지 않으면 sourceText 필드 자체를 생성하지 않는다. modelTurn의 일반 text를 원문이나 번역 전사로 위장하지 않는다.
- `interrupted`는 활성 꼬리를 중단하고 별도 interrupted 이벤트를 보낸다. 같은 메시지의 오디오·완료보다 중단을 우선한다. 이후 새 턴은 계속 처리한다. 중지·단절은 조립기를 cancel하고 늦은 타이머·자막·오디오를 차단한다. 기존 라우터가 자막 status를 전달하지 않으므로 후속 엔진은 interrupted/error/closed/자체 중지에서 활성 자막을 중단 상태로 처리해야 한다.
- PCM은 `audio { audio: Uint8Array, sampleRate: 24000 }`로 직접 전달한다. bare `audio/pcm`은 Live의 기본 24kHz로 해석하고, 명시된 rate가 다르거나 지원하지 않는 MIME 매개변수·홀수/빈 PCM·비정규 base64이면 INVALID_RESULT로 닫는다. PCM 파트와 알려진 전사·제어 필드를 메시지 전체에서 검증한 뒤 방출하여 뒤쪽 잘못된 파트 앞의 오디오·자막이 일부 유출되지 않게 했다.
- 기존 transport의 수신 제한을 재사용하며 어댑터에도 content UTF-8 1MiB, 디코딩 PCM 청크 768KiB, 전사 조각 16,000자 상한을 둔다. 이는 제공자 한도가 아닌 앱 검증 정책이다. 메시지 봉투 크기 때문에 실효 PCM 최대치는 더 작다. 긴 세션의 누적 PCM·발화 기록·세션 길이 제한은 추가하지 않았다.
- goAway는 검증한 timeLeftMs만 전달하고 입력을 멈춰 현재 transport를 닫는다. 자동 재접속·모델 순환·REST/voice 호출은 없다. 복구를 시작하는 상위 엔진은 close 확인 후 공통 예산을 사용해야 한다. 오류는 기존 ProviderError 코드로 정규화하고 원문·cause·close reason·임의 필드는 버린다. UI 문자열을 추가하지 않아 사전 변경은 없다.

### 설계 구체화와 후속 인계

설계 목표를 변경하지 않았다. 미지정 함수명·입력 바이트 타입·마지막 짧은 프레임·수신 검증 상한·finish 이후 입력 재개 금지·bare PCM의 기본 rate 해석을 이번 파일 안에서 구체화했다. P2-01 계약과 P2-02 조립기가 모두 존재하므로 임시 대체 모듈은 없다.

P2-04는 기존 transport의 동시통역 송신 bufferedAmount 한도와 오류 분류를 보강한다. P2-05는 능력 등록·모델별 폴백 조건·voice/live 인스턴스 공유를 연결한다. 현재 앱의 live 능력 등록은 이 과제에서 바꾸지 않았다. P2-09는 입력 송신 펌프·음소거·연속 PCM 재생·goAway 복구와 활성 자막 중단을 조립한다. 라우터는 processing.live와 조립기 타임스탬프를 전달하지 않으므로 측정·메타데이터 확장은 해당 후속 과제에서 명시적으로 검토해야 한다.

### 검증 범위

`tests/fixtures/gemini-live.mjs`는 합성 PCM·전사, 종료를 수동 확인하는 주입 Live client와 기존 가짜 시계를 제공한다. 개별 검사는 모델별 setup, 실제 기존 transport와의 소켓 단일 소유권, 프레임·base64·24kHz·크기 검증, 원문 부재, 역할별 ID·반복 전사, 침묵·finished·턴 경계, 중단 우선순위, 콜백 도중 close, setup 도중 abort, 늦은 응답, 물리적 close와 timeout 구분, 오류 비밀 제거, 숨은 재시도 부재를 다룬다. Node Buffer를 제거한 상태에서도 PCM 경로를 실행한다. 실키·실기기·장시간 운영 성공을 주장하지 않는다. 완료 명령의 실제 결과는 최종 완료 메시지에 기록한다.

## P2-06 연속 캡처·송신 큐 — 2026-09-05

지정 경로에 이미 있던 미추적 `stream-capture.js` 초안을 유지하여 검증하고 프레임 상수를 명시했다. 원본 `ambient-state.js` 전체 SHA-256을 다시 계산하여 위 지문과 일치함을 확인했다. `jpSimStart`의 캡처 그래프·512샘플 묶음 개념과 P1 `capture.js`의 자원 수명주기를 재사용한다. 실제 실행에서는 기존 `capture-worklet.js`, `resampler.js`, `wav.js`의 `float32ToPCM16`, `platform.js`를 상대 경로로 사용한다. 원본의 요청 sampleRate 가정·Blob worklet·Electron IPC·base64 송신과 PTT의 WAV 누적은 이식하지 않았다. `uplink-queue.js`는 상세 설계에 따른 신규 구현이다. 다른 번역·음성·xlsx 원본은 이번 과제의 이식 대상이 아니다.

### 호출 계약

- `createStreamCapture({ platform?, onFrame?, onLevel? }).start({ signal?, turnId?, sessionId?, generation? })`는 사용자 제스처에서 호출한다. 생성만으로 마이크를 열지 않는다. 반환값은 `{ done, stop, cancel }`이며 팩터리에도 활성 캡처의 stop/cancel을 제공한다.
- `onFrame(pcm, metadata)`는 동기 콜백이다. PCM은 독립된 `Uint8Array` 1,024바이트이며 PCM16 LE·mono·16kHz다. 실제 AudioContext 샘플레이트로 상태 유지 리샘플러를 사용하며 정확히 512샘플씩 내보낸다. metadata에는 실행 ID·세대, 1부터 시작하는 sequence와 입출력 샘플레이트가 있다. 콜백은 `queue.enqueue(pcm)`에 연결하고 async sendAudio를 직접 연결하지 않는다.
- `onLevel`은 RMS·peak·입력 샘플레이트·입력 길이와 기존 `seq.inputLevel` 사전 키를 전달한다. 무음도 정상 스트리밍 입력이다. 2초 동안 유효 worklet 입력이 없으면 시작 전 입력 없음과 도중 정지를 구분하여 종료한다. 준비 단계만 30초 제한이며 녹음 전체 길이 제한은 없다.
- stop/cancel은 남은 불완전 프레임과 리샘플러 필터 이력을 버린다. 마지막 프레임을 패딩하거나 WAV로 만들지 않는다. done에는 emittedFrames와 discardedTailSamples 등 메타데이터만 남는다. discardedTailSamples는 조립 버퍼의 잔여 수이며 필터 이력까지 합친 값은 아니다.
- 권한·resume·worklet 로딩 중 취소, 장치 종료·mute, 페이지 숨김·pagehide, context 중단, processor 오류에서 트랙·그래프·타이머를 정리한다. 늦은 권한 결과의 트랙도 중지하며 새로운 캡처를 종료시키지 않는다. 오류 원문은 버리고 기존 오류 사전 키만 전달한다.
- `createUplinkQueue({ sendAudio, signal?, clock?, onDrop?, onError? })`는 **연결마다 새로** 생성한다. `sendAudio: pcm => liveSession.sendAudio(pcm)` 형태로 기존 어댑터를 주입한다. clock은 단조 `now()`와 setTimeout/clearTimeout이며 기본은 performance.now와 브라우저 타이머다.
- 초기에는 준비되지 않은 상태다. open 완료 후 `setReady(true)`로 활성화한다. `enqueue(pcm)`는 동기로 복사·적재하고 boolean을 반환한다. 연결 전 입력은 바로 버린다. `setReady(false)`는 대기 큐를 비우며 이후 입력도 버린다. `cancel()`은 멱등적인 영구 종료다. 이전 연결의 큐를 새 sendAudio로 교체하여 재사용하지 않는다.
- 큐 상한 8프레임은 **송신 중인 최대 1프레임을 포함**한다. 넘치면 가장 오래된 미전송 프레임을 버린다. 실제 단조 시각 기준 송신 시작 간격을 최소 32ms로 유지하고, 큐 진입 후 256ms 이상 지난 프레임도 버린다. 늦은 타이머에서 밀린 송신을 반복 실행하지 않는다. 송신 Promise가 정지해도 동시에 하나만 유지하며 대기는 최대 7프레임이다.
- `onDrop({ reason, frames, durationMs })`는 overflow·stale·not-ready·cancelled를 구분하는 입력 누락 통지다. `getStats()`는 queuedFrames·inFlight·maxFrames·sentFrames·droppedFrames·droppedMs 집계만 제공한다. sentFrames는 sendAudio 성공 횟수이며 제공자 수신 확인이 아니다. 이미 송신 중인 프레임은 폐기 집계에 포함하지 않으며 취소 이후 늦은 성공도 반영하지 않는다. 실패하면 큐를 취소하고 정규화한 ProviderError를 onError에 한 번 전달한다.

### 설계 구체화·후속 인계

설계 목표 변경이나 선행 의존성 누락은 없다. 8프레임에 송신 중 프레임을 포함하는 보수적인 상한, 256ms 대기 만료, 실제 시각 기준 32ms 송신 간격, 불완전 꼬리 폐기를 이번 과제에서 구체화했다. P1 기존 테스트의 단언은 변경하지 않았다. 추가 패키지·UI 문자열·자격증명 접근·네트워크 URL·로그·영구 저장은 없다.

P2-09는 캡처 onFrame을 현재 연결의 큐에 연결하고, 재연결/goAway 시 이전 큐를 즉시 취소한 뒤 기존 세션 관리자로 물리적 종료를 확인해야 한다. 큐 취소는 이미 브라우저로 넘어간 데이터의 회수나 소켓 종료 증거가 아니다. P2-04 Live client의 12KiB 오디오 송신 버퍼 제한과 정규화 오류를 그대로 사용하며 큐는 소켓을 열거나 복구 예산을 생성하지 않는다. 입력 누락 통지는 P2-08 상태·P2-14 사전·P2-16 화면에서 자막/출력 누락과 별도로 연결해야 한다. 수명주기 취소 신호도 캡처와 큐 양쪽에 전달한다.

실제 장치의 worklet 메시지 전달 지연은 이 큐의 진입 시각 이전 구간이므로 256ms 정책을 장치부터 제공자까지의 보장 지연으로 해석하지 않는다. 실기기 권한·오디오·장시간 지연 검증은 후속 기기 시험에 남는다.

### 자동 검증

합성 16/44.1/48kHz 톤의 주파수·진폭 보존과 불규칙 입력 블록, 정확한 프레임 크기, 30초 초과 무음 스트리밍, 불완전 꼬리 폐기, 권한·resume·worklet 지연 취소, 입력 정지·페이지·장치·processor 오류를 시험한다. 큐는 준비 전/복구 중 폐기, PCM 복사, 8프레임 상한·최고값·입력 누락 ms, 단일 미완료 Promise, 타이머 지연·만료, 취소 후 늦은 성공/실패, 안전한 오류 정규화를 가상 시계로 검증한다. 실행 명령과 최종 통과 수는 완료 메시지에 기록한다.

## P2-07 연속 PCM 재생·따라잡기 — 2026-09-05

`app/audio/stream-player.js`는 원본 `ambient-state.js`의 `jpGeminiSpeak`에서 24kHz PCM 변환과 AudioContext 예약 개념을 이식했다. 파일 전체 SHA-256을 재계산하여 위 지문과 일치함을 확인했다. 실제 LE 변환은 기존 `app/audio/wav.js`의 `pcm16ToFloat32`를 상대 경로로 재사용한다. P1 `pcm-player.js`의 자원 해제 방식을 참고하되 유한 턴·120초 watchdog·overflow 영구 종료는 이식하지 않았다. React·Electron·base64·자유 페르소나·전체 PCM 보관도 없다. 다른 번역·Live·xlsx 원본은 이번 파일의 이식 대상이 아니다.

### 호출 계약과 후속 연결

- `createStreamPlayer({ context, signal?, onState?, onDrop?, now?, setTimeout?, clearTimeout?, maxQueueSeconds?, maxSources?, muted? })`를 연결 세대마다 생성한다. AudioContext는 호출자가 소유하며 재생기는 close/suspend하지 않는다. 사용자 제스처에서 `resume()`을 호출한다. 동시 resume 요청은 같은 Promise를 공유한다. 거부 시 blocked 출력을 유지하고 사용자 재시도를 허용한다.
- P2-01 정규화 `audio`의 `audio` 바이트를 `enqueue(pcm)`에, `complete`를 `turnComplete()`에, `interrupted`를 `interrupt()`에 연결한다. 기존 P2-03에서 complete는 제공자 turnComplete를 뜻한다. subtitle final·generationComplete·PCM 청크 끝은 경계가 아니다. 지원 입력은 PCM16 LE·mono·24kHz의 ArrayBuffer/Uint8Array/DataView이며 빈 데이터·홀수 길이·다른 타입은 안전한 출력 실패로 종료한다. sampleRate 검증은 기존 어댑터 계약을 사용한다.
- AudioContext 현재 시각에서 약 60ms 여유로 연속 예약한다. 현재 시각부터 예약 끝까지 3초 이상이면 delayed다. 초기 여유·청크 사이 여유까지 포함하여 최대 8초이며 소스는 최대 256개다. 옵션으로 낮출 수 있지만 상한을 높이지는 못한다. 초과 청크는 디코딩·AudioBuffer 할당 전에 거부한다.
- overflow에서 재생 중·예약 소스를 모두 stop/disconnect하고 buffer/onended 참조를 해제한다. 이후 PCM을 저장하지 않고 다음 turnComplete까지 버린다. 2초 후에는 다음 새 청크부터 강제 재개하며 `onDrop({ reason: 'forced-boundary', durationMs: 0 })`로 중간 잘림을 알린다. 이 0은 경계 통지 자체의 추가 폐기량이며 이미 폐기한 음성은 별도 집계한다. 타이머 지연 시 브라우저가 콜백을 실행할 때 복귀하며 2초 벽시계 실행 보장을 주장하지 않는다.
- `setMuted(true)`는 예약과 복귀 타이머를 비우며 mute 중 새 PCM도 버린다. 소리를 다시 켜도 과거 음성은 없다. interrupt 역시 큐·타이머를 비우되 재생기 전체를 종료하지 않아 다음 새 음성을 받을 수 있다. `cancel()`/`close()`/signal abort는 멱등 영구 종료다. done은 안전한 상태 결과로 resolve하며 오류 원문·abort reason을 보존하지 않는다.
- suspended/interrupted context에서는 출력 blocked와 함께 큐를 비우고 PCM을 버린다. closed context·잘못된 PCM·노드 생성/예약 오류는 unavailable 및 기존 `error.VOICE_FAILED` 키로 출력만 종료한다. 세션·자막 수신을 실패시키거나 기기 TTS/다른 제공자를 호출하지 않는다. 취소 키는 기존 `error.ABORTED`다.
- `onState(snapshot)`는 출력 상태 변경을 통지한다. 재생 중 최대 한 개의 50ms 관찰 타이머로 새 청크가 없어도 delayed 해제를 알리고 늦은 ended 이벤트의 소스를 회수한다. 오디오 진행 판정은 AudioContext 시각으로만 한다. 빈 큐와 종료 후 관찰 타이머는 없다. onended도 즉시 해제하며 늦은 콜백은 무시한다.
- `onDrop({ reason, durationMs })`는 overflow/catching-up/forced-boundary/muted/blocked/interrupted/cancelled/failed를 구분한다. durationMs는 입력 청크 또는 예약 음성의 남은 샘플 길이이고 초기 무음 예약 여유는 제외한다. 이미 출력된 것으로 AudioContext가 판단한 부분도 물리적 청취 증명은 아니다. 콜백 예외는 내부 자원 정리를 막지 않는다.
- `snapshot()`은 queuedSeconds/sourceCount/state, firstReceivedAt(단조 ms), firstScheduledAt(AudioContext 초), actualFirstSoundAt(항상 null), droppedMs와 forcedBoundaries 누계만 보관한다. 오디오·자막·키·URL·이벤트 이력을 측정값에 넣지 않는다. 두 시계 값을 직접 빼거나 예약 시각을 실청취 시각으로 표시하면 안 된다. P2-18에서 필요한 분포와 지연 시간 집계는 제한된 측정 모듈로 수집한다.

### 설계 구체화와 범위

설계 목표 변경과 선행 의존성 누락은 없다. 소스 상한 256개, 큐 시간에 초기 예약 여유 포함, 50ms 상태 관찰, 출력 실패의 done 결과와 콜백 API를 구체화했다. 신규 UI 문자열은 없으며 상태·누락 원인은 기계 식별자로 전달한다. P2-14·16에서 세 언어 사전의 지연·따라잡기·음성 건너뛰기·중간 잘림 문구에 연결해야 한다. P2-09는 이전 세대의 player를 cancel하고 현재 연결의 정규화 이벤트만 전달해야 한다. 재생기 취소는 Live 소켓 종료 확인을 대신하지 않는다.

변경 파일은 `app/audio/stream-player.js`, `tests/stream-player.test.mjs`, `tests/fixtures/stream-audio.mjs`, 본 문서 네 개뿐이다. P1 파일·기존 테스트 단언은 변경하지 않았다. 외부 패키지·빌드 도구·네트워크·로그·저장소 접근은 없고 커밋하지 않았다.

### 자동 검증 범위

합성 PCM과 독립된 가상 단조/AudioContext 시계를 사용한다. LE offset·복사·연속 예약, 3초 상태 해제, 8초 및 256개 경계의 할당 전 거부, 실제 제공자 턴을 기다리는 복귀·2초 강제 복귀, 300초 연속 재생과 늦은 ended 회수, mute/interrupted/abort, suspended 130초와 반복 수신, resume 거부·진행 중 취소, closed context·잘못된 PCM·생성/connect/start 실패 및 오류 비밀 제거를 검사한다. 실제 스피커 첫소리·Safari/모바일·장시간 운영 성공은 이 모의 검사로 판정하지 않는다. 완료 명령과 최종 통과 수는 최종 보고에 기록한다.

## P2-10 기존 허브 프로토콜 파서 — 2026-09-05

### 원본과 변경 범위

서버 수정 없이 `~/jarvis2/interp-web/server.js`의 `publicSettings`, `castStart`, `castStop`, 청중 WebSocket 연결 경로를 읽고 수신 계약을 이식했다. 전체 SHA-256은 `b179d94a9de1f6af012e3b40226199bb6c30e4b5564d00b97931cdbbb6cd7d48`이다. 상태 종류는 `lib/live.js`의 `LiveLane`을 대조했고 해시 `8afc7818740a45bb69e349450f4290b9574adcd24cb8ee294060ec08056febfe`가 기존 지문과 일치했다. 지정된 translate·xlsx·main-handlers의 voice/tts·ambient-state 음성 경계도 확인했지만 이 과제에는 이식하지 않는다.

신규 파일은 `app/hub/protocol.js`, `tests/hub-protocol.test.mjs`, `tests/fixtures/hub.mjs`이며 이 문서를 갱신했다. 기존 P1 테스트 단언·제공자 라우팅·키 처리·능력 등록은 변경하지 않았다. P2-08의 `createCaptionStore().upsertHub()`가 존재하므로 선행 의존 누락은 없다. 코드만 반환하는 기존 `ProviderError`를 재사용한다.

### 호출 계약과 설계 구체화

- `createHubProtocol({ hubs? }) → { buildUrl(hubId, roomCode), parse }`. `hubs`는 코드 소유 구성·테스트 전용 주입점이며 `{ id, url }` 목록이다. 사용자·QR·서버 settings를 이 인자로 전달하지 않는다. 생성 시 검증·복사하며 참가 시에는 등록 ID만 받는다. 기본 `REGISTERED_HUBS`는 빈 불변 배열이다. 검증된 주소 없이 가짜 운영 허브를 등록하지 않는다.
- 등록 URL은 정규화된 절대 `wss://…/ws`만 허용한다. 사용자 정보·query·fragment·다른 경로·정규화로 바뀌는 주소를 거부한다. 참가 URL에는 `room`만 추가한다. 방 코드는 원본의 생성 규칙에 따라 대소문자를 보존하는 영숫자 1–8자로 제한한다. 원본이 base64url 특수문자를 제거하므로 짧은 코드도 가능하다. 자동 trim·대소문자 변환은 하지 않는다. 방 코드는 WebSocket 참가 URL에만 필요하며 페이지 URL·로그·저장소용 값으로 반환하지 않는다.
- `parseHubMessage(text)`는 동기·무상태 함수다. JSON 텍스트만 받는다. 전체 UTF-8 1MiB, 자막 16,000 UTF-16 단위, 식별자 256자 상한을 적용한다. 식별자는 원본 ID 형식에 필요한 영숫자·점·밑줄·콜론·하이픈만 받는다. `seq/revision/ts`는 0 이상의 안전한 정수이며 `ts`만 생략 가능하다. final은 실제 boolean이어야 한다. 빈 자막은 snapshot 삭제 수정을 위해 허용한다.
- 반환 이벤트는 `hello`, `caption`, `status`, `stopped`, `settings`, `closed`, `denied`다. 알려진 잘못된 메시지는 `INVALID_RESULT`, 알 수 없는 타입은 크기·JSON 객체 검사 후 null이다. 정상 `status` 호환은 지원 언어 또는 `*`와 실제 LiveLane 상태 6종이 모두 있는 경우에만 적용하며 다른 일반 `status`는 null이다.
- hello는 참가 sessionId와 정제 settings만 전달하며 방송 중 상태를 만들지 않는다. settings는 `allowedLangs/defaultLang`만 채택한다. 언어 목록은 최대 64개·각 코드 최대 35자로 검증하고 ko/en/ja 교집합에서 중복을 제거한다. 기본 언어가 교집합에 없으면 첫 허용 언어, 교집합이 비면 null이다. 빈 목록을 임의 언어로 채우지 않는다. `name`, `castActive`, `castLangs`, endpoint, 키, 저장·접근·quota 설정은 폐기한다.
- caption은 `lang/segmentId/seq/text/final/revision/ts?`만 전달한다. 모든 지원 언어와 `src`를 수신 순서 그대로 전달하며 선택 목표어 필터, 누락 계산, 중복·revision 판정은 하지 않는다. 소비자가 로컬 epoch를 붙여 P2-08에 전달한다. ts를 로컬 시계에서 빼서 지연으로 계산하지 않는다.
- status는 lang와 검증된 state만 전달한다. 선택 사항인 model도 청중 상태에 필요하지 않아 detail과 함께 폐기한다. fatal을 일일 quota·키 오류로 추정하지 않는다. stopped의 알려진 서버 사유는 `stopped/broadcast-error/time-limit` 의미 코드로 제한하고 알 수 없는 사유는 stopped로 축약한다. closed는 room-closed, outside/denied는 접근 거부로 매핑한다. 이들은 UI 문구가 아니며 P2-14·16에서 사전 키로 표시한다.

설계의 의미 변경은 없다. 함수 시그니처·필드별 상한·잘못된 입력 처리·기본 언어 폴백은 상세 설계에서 미지정한 부분을 위와 같이 구체화했다. PCM·구독·replay-end·source 명령 생성이나 서버 변경을 추가하지 않았다.

### 후속 주의와 검증

P2-11은 Blob/ArrayBuffer를 크기 확인 후 텍스트로 변환하고 비동기 해석 순서를 보존해야 한다. 대기 128개·2MiB, 초과 시 연결 정리, 종료·재접속·세대 검사는 클라이언트 책임이다. 이 파서에는 소켓·타이머·API 키·마이크·TTS·로그·저장소가 없다.

P2-13은 전체 이벤트 처리 후 목표어를 선택하며, hello에서 방송 중을 추정하지 않는다. settings가 선택 언어를 제거하면 중지한다. fatal/접근 거부/종료 시 상태·큐를 정리한다. 재접속 자막의 seq 불연속으로 누락 개수를 만들지 않으며 최근 자막 자동 낭독을 차단한다. P2-20은 실제 검증한 WSS 주소와 `ENDPOINT_ORIGINS`·CSP를 함께 등록해야 한다. Node fixture 성공을 실제 허브 접속·규모·출시 검증으로 확대하지 않는다.

단위 검사는 실제 타입 덮어쓰기, hello/settings 정제, 종료·접근 거부, URL·방 코드 주입 차단, UTF-8 크기 경계, 정수·revision·언어·텍스트 상한, raw 오류 폐기, 전체 언어 순서와 불연속 replay, 실제 P2-08 저장소의 revision·중복 final 처리를 포함한다.

실행 결과: `node --test tests/hub-protocol.test.mjs`는 9개 통과, `node scripts/check-i18n.mjs`는 `I18N_OK languages=3 keys=205 files=50`, `git diff --check`는 통과했다. `node --test tests/*.test.mjs`와 `node --test tests/`는 기존 개인정보 검사 한 항목이 실패했다. 처음 추가한 테스트의 긴 가짜 비밀 표식이 키 형태 탐지에 걸려 테스트 소스에서는 짧은 표식으로 수정했다. 그러나 외부에서 기록되는 `docs/build/P2-10.log`에도 이전 명령 내용이 남아 재실행은 이 로그를 원인으로 실패한다. 이 로그는 허용된 네 파일 밖이므로 수정·삭제하지 않았고 기존 개인정보 검사도 약화하지 않았다. 로그의 가짜 표식 정리 권한이 확보된 뒤 전체 검사를 재실행해야 하므로 전체 완료 판정은 보류한다.

### 재시도 검증

2026-09-05, Node v24.18.0에서 기존 구현과 원본 서버의 청중 메시지를 다시 대조했다. 파서·fixture·테스트 소스는 이전 수정 상태를 유지했고 이번 재시도에서는 이 문서만 갱신했다. 설계 변경이나 P1 단언 수정은 없다.

| 직접 실행한 명령 | 결과 |
|---|---|
| `node --test tests/hub-protocol.test.mjs` | 9개 통과 |
| `node --test tests/*.test.mjs` | 483개 통과, 개인정보 검사 1개 실패, skip·todo·취소 0 |
| `node --test tests/` | 내부 482개 통과, 개인정보 검사 1개 실패로 디렉터리 진입 검사 실패 |
| `node scripts/check-i18n.mjs` | `I18N_OK languages=3 keys=205 files=50` |
| `git diff --check` | 통과 |

기존 개인정보 검사의 값 패턴으로 빌드 로그를 읽기 전용 검사한 결과, 검출 위치는 `docs/build/P2-10.log:2736` 한 줄이다. 원문 값은 출력하지 않았다. 필요한 조치는 해당 줄의 가짜 표식 값만 짧은 `test-marker`로 치환하고 나머지 로그를 보존하는 것이다. 이 파일은 사용자 지정 수정 범위 밖이므로 범위 예외 승인 전에는 실행하지 않는다. 로그가 남아 있는 현재 상태에서는 네 파일만 수정하여 전체 검사를 통과시킬 수 없으며, 테스트에서 로그를 제외하거나 검사 패턴을 약화하지 않는다.
