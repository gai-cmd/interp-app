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
