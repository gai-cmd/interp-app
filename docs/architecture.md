# 실행 기반과 모듈 계약

기준: 확정 [design-v0.6.md](design-v0.6.md)의 §20·8·9·11·12·15. v0.6에서 유지한 내용은 [design-v0.5.md](design-v0.5.md)를 따른다. P1-01은 실행 기반과 계약 문서만 구현한다. 아래 앱 계약의 실제 구현은 각 후속 과제의 책임이다.

## 실행

- Node 24.x, `type: module`, 외부 npm 의존성·설치·빌드 도구 없음.
- 브라우저는 앱 내부 상대 경로 ES 모듈을 사용한다. Node 내장 모듈은 scripts/tests에서만 사용한다.
- `npm test` 또는 `node --test tests/*.test.mjs`: 전체 테스트. 테스트 파일은 `tests/*.test.mjs`.
- `node --test tests/serve.test.mjs`: 개발 서버 회귀 검사.
- `node scripts/serve.mjs --port 8080`: `http://127.0.0.1:8080`에서 실행. 기본 포트도 8080이며 Ctrl-C로 종료한다.
- 루트는 실행 작업 디렉터리가 아니라 serve.mjs의 상위 저장소다. `createDevServer({ root })`는 테스트용 루트를 받아 바인딩 전 Node HTTP Server를 반환하는 비동기 함수다. import만으로 서버를 열지 않는다.

서버는 GET/HEAD, 디렉터리의 index.html을 지원한다. HTML·CSS·JS/MJS·JSON·manifest·이미지·폰트·WASM·WAV·텍스트에 명시적 MIME을 설정하고, 미지 확장자는 application/octet-stream으로 전송한다. HEAD는 GET과 같은 길이·MIME에 빈 본문을 반환한다. 캐시는 no-store, MIME 추측은 nosniff로 차단한다.

URL 정규화 전에 경로를 한 번 디코딩하고 점으로 시작하는 경로 요소, 역슬래시, 제어 문자, 남은 퍼센트 인코딩을 거부한다. 파일·디렉터리·index.html의 심볼릭 링크를 거부하고 실제 경로가 루트 내부인지 재검사한다. 이중 인코딩은 지원하지 않는다. 접근 거부는 403, 없는 파일은 404, GET/HEAD 이외는 405다. 디렉터리 목록·SPA 대체 응답·API 프록시는 없다. 오류 본문은 비워 UI 번역 문구를 도입하지 않으며 요청 URL·헤더·파일 경로·원본 오류를 기록하지 않는다. CLI 출력은 개발용 코드와 비밀 없는 루프백 주소뿐이다.

개발 서버는 신뢰하는 로컬 작업 트리를 읽는 도구다. 일반 문서·테스트도 루트 안이면 읽을 수 있으므로 저장소 전체를 배포하거나 공용 서버로 사용하지 않는다. 실행 중 악의적인 로컬 사용자가 디렉터리를 교체하는 경쟁까지 격리하는 파일시스템 샌드박스는 아니다. 배포 파일 허용 목록과 CSP는 P1-18에서 구현한다.

현재 index.html은 P1-15 소유이므로 `/`의 404는 정상이다. 임시 화면을 만들지 않는다. 폰 마이크 검증은 HTTPS 배포 또는 신뢰된 개발 HTTPS에서 수행한다. 맥 HTTP LAN 주소 결과나 Node 테스트 성공을 모바일 마이크·PWA 합격으로 기록하지 않는다.

### 실행 환경에서 확인한 차이

Node 24.18.0에서 요청된 `node --test tests/`는 MODULE_NOT_FOUND로 실패했다. 디렉터리를 모듈 진입점으로 처리하기 때문에 package.json의 test는 명시적 `tests/*.test.mjs` 탐색으로 정했다. 우회용 여섯 번째 진입 파일은 만들지 않는다. 개발 샌드박스는 127.0.0.1:8080 listen을 EPERM으로 거부한다. HTTP 회귀 검사는 메모리 Duplex 연결로 실제 Node HTTP 파서·서버 응답·파일 스트림을 실행하며 TCP 바인딩 성공을 대신 증명하지 않는다. 권한이 있는 로컬 터미널에서 서버 실행 확인이 남는다.

## 제공자 계약

호출 순서: UI → 통역 엔진 → 능력 라우터 → 제공자 어댑터. UI는 endpoint·인증·제공자 요청 필드를 알지 않는다. 환경 객체(fetch, WebSocket, AudioContext, 타이머 등)는 생성 시 주입하고 import 시 마이크·소켓·브라우저 전역을 실행하지 않는다.

| 능력 | 인터페이스 | 입력과 결과 |
|---|---|---|
| translate | `translate(request, context) → Promise<TranslationResult>` | 텍스트 필수 지원, 선언된 경우 WAV 지원. 원문·번역문·감지 언어·상태·모델 반환 |
| stt | `stt(request, context) → Promise<SttResult>` | 유한 음성·선택 언어 힌트. 전사문·감지 언어·상태·모델 반환 |
| live | `live.open(request, context) → Promise<LiveSession>` | 스트리밍 PCM. 임시/확정 자막·오디오·중단·종료 이벤트 |
| voice | `voice.open(request, context) → Promise<VoiceSession>` | 확정 텍스트·언어·보이스. 오디오·선택 전사·완료·오류 이벤트 |

context는 turnId, sessionId, generation, AbortSignal인 signal, 제한된 자격증명 참조를 전달한다. LiveSession은 sendAudio/finishInput/close, VoiceSession은 speak/cancel/close와 정규화 이벤트를 제공한다. 유한 작업은 성공·실패·취소·시간 초과로 끝나고, 스트림 종료는 한 번만 알린다. 이벤트에는 해당 작업 식별자를 연결해 종료 후 이벤트를 버린다. 세부 필드와 구독 API는 P1-02에서 이 의미를 보존해 확정한다.

등록 정보는 id/label, browserDirect, 네 능력별 implementation(ready/planned/unsupported)·transports·입출력 형식·models/voices, credentialPolicy(directPersonal/directShared/hubManaged), quotaPolicy(scope/normalizeError), fallbackPolicy, 고정 HTTPS/WSS endpoints, terms 안내 식별자·검토 상태·날짜를 포함한다. label 등 사용자 표시 문구는 i18n 키로 연결한다.

라우터는 구현 → 제공자·transport → 해당 자격증명 → 공통 예산 → 오류 정규화 → 허용 폴백 순서로 검사한다. browserDirect=false면 직접 호출을 강제 차단하고 true여도 능력별 제한을 지킨다. 허브가 없는 허브 전용 경로는 HUB_REQUIRED로 끝낸다. 등록, 구현 상태, 현재 제공자·키 출처·능력별 연결 검사 결과는 별개다.

P1 실제 제공자는 Gemini 하나이며 translate/stt/voice 구현, live는 P2 예정이다. 일반 PTT는 WAV 전사+번역 결합 요청 한 번을 사용하고 독립 STT를 중복 호출하지 않는다. 두 번째 제공자는 테스트 fixture에만 둔다.

## 상태와 종료 계약

P1-14의 app/state.js와 engine/seq.js가 상태를 소유하고 UI는 상태를 표시한다. 다음은 의미 계약이며 상태 상수의 최종 철자는 P1-14에서 정한다.

- 순차 흐름: 대기 → 녹음 → 번역 → 표시 → 음성 재생 → 대기. 텍스트 입력은 녹음을 건너뛴다. 무음·인식 불가는 정상적인 별도 결과로 다룬다.
- 세션 식별자, 턴 식별자, 단조 증가 세대 번호로 작업을 구분한다. 취소·키 삭제/변경·제공자/모드/통역 언어 변경은 이전 작업을 abort하고 세대를 갱신한다. 늦은 결과·오디오·재시도는 폐기한다.
- 새 발화는 이전 재생을 취소하며 재생 중에는 녹음하지 않는다. 성공·실패·취소·시간 초과 모두 종료 상태에 도달하고 트랙·소켓·타이머·큐를 정리한다.
- 확정 결과는 턴당 중복 반영하지 않는다. 음성 실패는 확정 번역문을 삭제하거나 실패 번역으로 바꾸지 않는다. 번역 결과 상태와 음성 출력 상태를 분리한다.
- 개인/공용 키 출처, direct/hub 경로, UI 언어/통역 언어는 별도 상태다. P1 기록 저장은 OFF이며 현재 대화는 메모리에만 두고 공용 종료 시 지운다.

공통 실행기는 STT·번역·설정 변경·모델 폴백 합산 최대 3회, 번역 모델 최대 2개를 강제한다. 어댑터 내부 재시도는 금지한다. 기본 gemini-3.1-flash-lite와 적용 가능한 품질/모델 오류의 gemini-3.5-flash만 사용한다. 모델·thinking 필드는 제공자 config에서 관리한다. 이 이름들은 오너 설계 입력이며 최신 API 지원을 검증했다는 뜻이 아니다.

Live는 제공자 합산 앱 내 활성 소켓 1개다. 이전 종료 확인 실패 시 새 연결을 열지 않는다. 최초 연결 외 재연결 최대 3회, 약 1·2·4초+지터, 서버의 더 긴 대기를 우선한다. 소켓 open만으로 실패 횟수를 초기화하지 않고 사용자 재시작 또는 60초 안정 동작을 기준으로 한다. 탭 간 조정은 최선 노력이다.

키 무효·권한 거부·일일 소진·안전 차단은 자동 반복/우회를 금지한다. 확인된 IP 거부만 회선 거부로 안내한다. 미상 429는 일일 소진으로 단정하지 않고 반복을 억제한다. 분당 제한은 서버 대기, 동시 세션 제한은 이전 종료 확인, 503/일시 네트워크 오류는 예산 안 재시도를 적용한다. Gemini 한도 범위는 프로젝트이며 키 교체는 한도 초기화가 아니다. 제공자·개인/공용 키의 자동 전환과 유료 자동 전환은 금지한다.

## 오디오 계약

| 경계 | 형식·책임 |
|---|---|
| 캡처 → 리샘플러 | 실제 AudioContext 샘플레이트를 전달. 사용자 동작으로 시작, PTT 최대 30초, stop/실패 시 트랙 종료 |
| API 입력 | PCM16 little-endian, mono, 16kHz. WAV는 이 PCM의 올바른 헤더·길이를 포함 |
| API 출력 → 재생 | PCM16 little-endian, mono, 24kHz. 청크를 순서대로 예약 재생 |
| 브라우저 바이너리 | Uint8Array/ArrayBuffer/DataView 사용. 브라우저에 Node Buffer/ws를 가져오지 않음 |

44.1/48kHz 입력은 다운샘플링 필터와 프레임 사이 상태를 유지해 변환한다. 다른 형식을 쓰는 제공자는 어댑터에서 변환하거나 미지원으로 선언한다. AudioContext 시간으로 예약하며 종료된 source를 해제한다. 취소는 예약 source·큐·타이머를 함께 정리한다. 첫 청크 수신, 예약 재생 시작, 실측 첫소리는 별도 지표다.

송수신 큐는 유한하게 유지한다. 초기 설계값은 대기 3초에 지연 표시, 8초 초과에 구간 경계에서 최신 상태 복귀와 누락 표시다. 복구 후 녹음 전체를 재전송하지 않는다. 목소리 텍스트 자동 재전송은 없고 첫 오디오 이전 실패에는 기기 음성 폴백을 허용한다. 일부 오디오 수신 뒤에는 전체 자동 재독을 금지하고 사용자가 기기 음성을 선택한다. 기기 음성도 실패하면 자막을 유지한다. 기기 음성의 오프라인 처리를 보장하지 않는다.

## 보안·표시·재사용

자격증명 주소는 (providerId, keySource)이며 실제 키는 선택 경로의 인증 경계에서만 해석한다. 개인 키 기본은 메모리, 선택 저장만 localStorage다. 공용 키는 메모리만 사용하고 허브 전용 원본 키는 브라우저에 배포하지 않는다. QR fragment는 앱 시작 전 회수하고 즉시 replaceState로 제거한다. endpoint·모델·정책을 QR로 덮어쓰지 못한다.

키·원본 payload·인증 URL·헤더·제공자 오류 원문은 로그·오류 객체·기록·캐시에 남기지 않는다. REST는 지원되는 키 헤더를 쓴다. 설계 §8.1이 언급한 Live 인증 URL도 인증 경계 밖으로 노출하거나 보관하지 않는다. 앱이 URL 인증을 실제 구현할 때는 사용자 지시의 URL 비밀 금지와 제공자 인증 방식의 양립 여부를 P1-11에서 확인하고, 불가능하면 지원을 허위 선언하지 않는다.

UI 문구는 모두 app/i18n/ko.json·en.json·ja.json의 같은 키로 관리한다(P1-04). ko-KR/ja-JP/en-US를 정규화하고 미지원 언어는 영어로 폴백한다. 날짜·숫자는 Intl, 제공자 텍스트는 textContent로 렌더링한다. 오류는 정규화 코드 → 사전 키로 연결하며 원문을 표시하지 않는다.

원본 프로젝트는 수정하거나 브라우저에서 직접 import하지 않는다. [reuse-map.md](reuse-map.md)에 기록한 경계대로 이식하며 이식 파일 상단에 영어 출처 주석을 남긴다. P2/P3의 빈 파일은 만들지 않는다.

## P2-01 스트림 이벤트 확장

기준은 [design-p2.md](design-p2.md) §8.6·§9 및 P2-01이다. `contract.js`의 동결된 `STREAM_EVENT_FIELDS`를 라우터가 사용하여 허용 목록과 구현이 어긋나지 않게 한다.

| 이벤트 | 전달하는 데이터 필드 |
|---|---|
| `audio` | `audio`, `sampleRate` |
| `transcript` | `text`, `final` |
| `subtitle` | 기존 `sourceText`, `translatedText`, `final`, `revision`; 선택적 `segmentId`, `seq`, `role` |
| `goAway` | `timeLeftMs` |
| `error` | 기존 `normalizeError`로 정규화한 `error` |
| `interrupted`, `complete`, `closed` | 추가 데이터 없음 |

모든 이벤트에는 `type`과 라우터 호출 시점 context의 `turnId`, `sessionId`, `generation`을 붙인다. 어댑터가 보낸 같은 이름의 ID나 호출 이후 context 변경은 이를 덮어쓰지 못한다. `segmentId`는 어댑터가 조립한 구간 식별자로 유지한다. 없는 선택 필드는 생략하며 `0`, `false`, 빈 문자열 등 기존 값은 유지한다. 알려지지 않은 이벤트 및 허용 목록 밖 raw payload·임의 필드는 폐기한다. 이벤트 객체는 얕게 동결하며 PCM을 복제하거나 버퍼 내부까지 동결하지 않는다.

정규화 어댑터는 `segmentId` 문자열, 음이 아닌 안전한 정수 `seq`, `source | translation` 역할, 음이 아닌 유한한 밀리초 `timeLeftMs`를 제공한다. 기존 계약처럼 필드 값 검증은 어댑터 책임이고 라우터는 허용 필드 선택과 수명주기를 맡는다. 허용된 텍스트 자체의 비밀 탐지·삭제 기능은 아니다. P2-02·03은 실행 세션·연결 세대·역할·독립 카운터로 구간을 식별하고 공통 구간 모델의 `id`·`sequence`에 대응시킨다. 라우터는 원문/번역문 문장 경계를 짝짓거나 revision을 조립하지 않는다.

`goAway`는 종료 예고이며 자체적으로 세션을 종료하거나 재시도하지 않는다. 후속 엔진은 송신 중지 → 이전 연결의 실제 종료 확인 → 공통 예산에 따른 새 연결 순서를 지킨다. 소비자 `close()`·abort·voice `cancel()` 이후에는 정리 완료 전이라도 모든 이벤트를 차단한다. 원격 `closed`는 최대 한 번 전달하고 이후 이벤트를 차단한다. 기존 P1-20b의 원격 종료와 사용자 취소 구분 및 물리적 종료 확인 계약은 유지한다.

이 허브 경로 검사는 제공자 라우터의 주입형 `hub.call` 계약이다. 현장 방송 청중의 `cast.caption` 수신 경로는 P2-10 이후 별도 모듈 책임이며 이를 라우터에 추가하지 않았다. UI 문자열·키 처리·Gemini 능력 등록도 변경하지 않았다.

설계와 다른 정책 결정이나 누락된 의존 인터페이스는 없다. 이번 변경은 기존 P1 코드의 계약 확장이며 레거시 코드를 새로 이식하지 않았다. 따라서 이식 출처·해시 및 범위 밖 `reuse-map.md` 변경은 없다. 지정된 다섯 기존 파일만 수정한다.

검증에는 live/voice × direct/hub의 기존 필드·선택 필드·context ID 보존, raw 필드·오류 비밀 제거, goAway 이후 사용 가능, 원격 closed 중복 차단, 소비자 close 대기 중 동기·늦은 이벤트 차단을 포함한다. P1-20b에서 추가한 `tests/package.json`·`directory.test.mjs` 덕분에 위 P1-01 실행 환경 기록과 달리 현재 `node --test tests/`도 전체 기능 검사를 실행한다. 자동 검증은 실제 API·실기기·P2 출시 검증을 대신하지 않는다.

## P2-05 Live 등록과 공통 복구 정책

Gemini의 네 능력 모두 구현 상태가 ready다. Live 기본 모델은
`gemini-3.5-live-translate-preview`, 순방향 폴백은
`gemini-3.1-flash-live-preview` → `gemini-live-2.5-flash-preview`다.
입력 pcm16(16kHz·mono), 출력 pcm16(24kHz·mono)과 subtitle을 선언한다.
모델별 AUDIO·transcription·translationConfig 및 flash 고정 프롬프트는
P2-03의 live-config.js를 그대로 사용한다. 지원 목소리는 빈 목록이다.
createGeminiAdapter는 voice와 live에 같은 저수준 Live client를 주입한다.

등록 ready는 현재 키·출처·모델·브라우저의 연결 검사 성공이 아니다. 등록만으로
네트워크를 열거나 진단 결과를 생성하지 않는다. 기존 terms의 unreviewed와
hubManaged=false도 유지한다. 실제 Live 검사와 측정은 P2-18 책임이다.
모델 이름은 저장소 설계값이며 실제 서비스 지원 여부를 검증한 결과가 아니다.

`config.resolveFallback(providerId, capability = 'translate')`는 기존 단일 인자
REST 호출을 보존한다. live는 별도 resolveGeminiLiveFallback을 반환하고 voice와
미지원 능력에는 null을 반환한다. Live 후보는 등록된 조건 순서대로만 이동한다.
모델·설정 미지원, UNAVAILABLE, NETWORK_ERROR만 모델 폴백에 해당한다.
분당 제한·SESSION_LIMIT은 같은 모델로 제한 복구하며 한도·키·권한·안전 오류를
이유로 모델을 순환하지 않는다. REST의 INVALID_RESULT 품질 폴백은 Live에 적용하지 않는다.

### 후속 엔진에서 사용할 인터페이스

`createLiveRecovery({ now?, random?, setTimeout?, clearTimeout? })`를 사용자 시작마다
한 번 만들고 모든 연결·모델에서 같은 객체와 budget을 유지한다. 기본 now는 단조
performance.now다. 공통 createBudget과 createLiveRetryPolicy를 재사용하며 지터,
서버 대기, 취소는 기존 retry.js 도구가 수행한다.

- `budget`: 최초를 포함해 네 연결을 허용한다. 직접 제공자 호출은 라우터만
  consume한다. 허브 클라이언트는 자신의 연결 경계에서 동일 객체를 소비한다.
- `opened()`: setup 또는 hello 완료를 알리며 실패 횟수를 초기화하지 않는다.
- `activity()`: 유효한 동작을 확인한 시점부터 안정 구간을 시작한다. 반복 호출은
  시작 시점을 옮기지 않는다. 단절 전에 60초 연속 안정 동작이 확인되면 다음 복구에서
  현재 연결을 새 구간의 최초 연결로 계산하고 추가 세 번을 허용한다.
- `wait(error, { signal, closed, goAway, request, resolveFallback })`: 실제 이전 종료가
  확인된 closed=true에서만 다음 연결을 허용한다. 약 1·2·4초 지터 대기와 더 긴
  서버 대기를 적용하고 다음 request를 반환한다. goAway는 같은 request를 반환하며
  모델 폴백과 같은 추가 연결 예산을 쓴다. 중복 대기와 대기 중 연결은 거부한다.
- `restart()`: 이전 실행을 취소·정리한 후 사용자가 수동 재시작할 때만 사용한다.
  대기 중에는 거부한다. 새 사용자 실행 객체 생성도 같은 의미다.

P2-09·11은 입력을 중지하고 lease.close()/sessionManager.close()의 성공을 확인한 뒤
wait를 호출한다. finishInput, 소켓 close 호출 시작, 정리 timeout은 종료 확인이 아니다.
종료 확인 실패 시 기존 세션 관리자 점유를 유지한다. 재시도에는 이전 lease 정리용
signal이 아니라 사용자 실행 signal을 전달한다. 각 새 연결은 세션 관리자의 새로운
generation을 사용한다. 녹음 재전송·별도 voice 호출·자동 REST 전환은 추가하지 않는다.
정책 자체는 소켓·캡처·오디오를 소유하지 않는다.

설계 정책 변경이나 누락된 의존 구현은 없다. 위 정책 인터페이스는 이 과제에서
정의했다. 새 레거시 코드를 이식하지 않고 P2-03·04 구현을 import했다.
따라서 범위 밖 reuse-map.md와 i18n 파일은 변경하지 않았고 새 UI 문자열도 없다.
기존 인증 경계는 유지하며 WebSocket 생성 내부의 인증 URL이라는 P1의 제한도
그대로다. 모든 네트워크 URL에서 비밀이 제거되었다고 주장하지 않는다.

### P2-05 자동 검증 결과와 범위 충돌

Node v24.18.0에서 지정 테스트
`node --test tests/provider-integration.test.mjs tests/live-recovery.test.mjs`는
19개 통과, 실패·취소·skip·todo 0이다. `node scripts/check-i18n.mjs`는
I18N_OK(3개 언어·205개 키·43개 소스), `git diff --check`도 통과했다.

`node --test tests/*.test.mjs`와 `node --test tests/`는 직접 실행했으나
동일한 기존 검사 한 개 때문에 실패한다. tests/settings.test.mjs:292는
live 검사 상태를 planned로 고정한다. 이번 ready 등록 후 실제 화면 상태는
untested이며 이는 등록과 실키 검사 결과를 분리하는 설계에 부합한다.
그 파일은 사용자 지정 수정 범위 밖이므로 수정·삭제·우회하지 않았다.
전체 테스트 통과라는 완료 기준은 미충족이다. 이 기대값을 새 등록 계약에
맞추는 범위 확장이 필요하다. 실키·실기기 검증과 출시 판정도 수행하지 않았다.

재검수에서도 지정 19개 검사는 통과했고 전체 검사는 같은 설정 테스트 한 개가
실패했다. provider-integration.test.mjs에 실제 createDiagnostics 조합으로
implementation=ready, state=untested, result=null, 검사 결과 목록 비어 있음과
네트워크 호출 없음 검사를 보강했다. 등록과 검사 상태 분리를 직접 검증한다.
필요한 범위 밖 변경은 settings.test.mjs의 live 기대 상태 planned를 untested로,
언어 전환 후 기대 사전 키 capability.planned를 capability.untested로 바꾸는 두 곳이다.
제품 등록을 planned로 되돌리거나 진단에 다른 등록 정보를 주입하는 우회는 하지 않는다.

## P2-13 허브 청취 엔진과 최근 자막 복구

`createHubListenEngine({client, deviceTTS, now?, setTimeout?, clearTimeout?})`는
P2-11 클라이언트와 P2-08 자막·상태, P2-12 기기 음성 큐를 조립한다.
새 레거시 코드를 이식하지 않았다. 원본 live.js의 모델 음성 폐기 정책을 확인했고,
translate·xlsx·제공자 voice 경로는 호출하지 않는다. 의존 구현 누락이나
P1 테스트 기대값 변경은 없다. 지정된 세 파일만 추가·수정했다.

### 호출과 화면 계약

- `join({hubId, roomCode, language?}, {signal?})`는 동기적으로
  `{ready, done, closed}`를 반환한다. ready는 최초 hello 성공 여부,
  done은 작업 종료, closed는 실제 소켓 종료 확인이다.
- `leave()`는 종료를 요청한다. 종료 확인 시간이 초과되면 상태는 failed이지만
  busy는 유지한다. 이후 closed가 해결되어야 새 참가가 가능하다.
- `setMuted(false)`는 running에서 사용자가 소리를 켤 때 호출한다.
  재접속 중 호출은 거부한다. `setLanguage()`는 기존 참가를 중지하며 자동 접속하지 않는다.
- `snapshot()/subscribe()`는 세션·방송·출력 상태를 따로 제공한다.
  `translations`는 선택 목표어, `sources`는 원문이다. 문장별 대응을 추정하지 않는다.
  `captions`는 전체 언어의 공통 저장소 snapshot이며 확정/중단 행 합계 100개와
  활성 임시 행만 유지한다. 화면은 문자열을 textContent로 표시해야 한다.
- `recentPossible=true`는 최근 자막이 섞일 수 있다는 안내 신호이며 개별 행의
  replay 판정이 아니다. 새 UI 문구는 추가하지 않았다. P2-14·16에서 상태·reason·
  recentPossible을 세 언어 사전 키로 렌더링한다. 기기 음성 안내 키는 기존 큐를 따른다.
- `close()`는 엔진을 폐기하고 메모리 자막과 구독을 정리한다. 실제 소켓 종료가
  미확인인 경우 busy는 여전히 유지된다.

### 복구와 식별의 한계

서버의 최근 30개는 모든 언어를 합친 확정 이벤트 최대 30개다. 클라이언트에서
언어별 30개를 요청하거나 30번째 수신을 replay 종료로 취급하지 않는다.
모든 언어를 수신 순서대로 저장한 뒤 화면에서 필터링한다. lastSeq는 마지막으로
관측한 숫자이며 누락 문장 수나 방송 ID가 아니다. 서버 ts로 지연을 계산하지 않는다.

첫 참가·재접속은 음성 OFF다. 음소거 때 받은 final도 음성 큐의 중복 억제에
전달하며 소리를 켜도 읽지 않는다. partial·원문·다른 목표어·중복·확정 후 revision은
자동 낭독하지 않는다. 소리 켜기 뒤 도착한 첫 final만 자격을 얻는다.
서버에 replay 경계가 없어 사용자 동작 뒤 도착한 과거 final까지 완벽히 구별할 수는 없다.

재접속에서는 epoch·저장소·큐의 중복 억제를 유지하고 수신 누락 가능성을 표시한다.
단절 중 방송 재시작으로 낮아진 seq나 재사용 ID가 오면 기존 저장소의 watermark와
revision 정책상 일부 새 자막이 억제될 수 있다. 이를 확실한 새 방송으로 추정해
자동 초기화하지 않는다. 사용자가 나갔다 다시 참가하면 새 epoch로 초기화한다.
cast.stopped도 종료 후 수동 참가만 허용하므로 다음 방송은 새 epoch가 된다.
hello만 있으면 방송 상태는 unknown이다. connected 상태 메시지는 waiting,
선택 목표어 자막 수신은 receiving으로 표시한다. 선택 언어 제거·방 종료·접근 거부·
fatal은 큐와 연결을 정리한다. raw detail은 보관하지 않으며 fatal은 안전한
broadcast-error 사유와 UNAVAILABLE 코드로 표현한다.

### 후속 과제 주의

P2-15·17은 참가 전에 앱 작업 소유권을 확보하고 순차·직접 Live·진단 재생 종료를
확인해야 한다. 허브는 제공자 Live 슬롯을 사용하지 않는다. pagehide·탭 이탈에는
leave를 연결하고 복귀 후 수동 참가한다. 등록 허브와 CSP는 P2-20 책임이다.
방 코드는 클라이언트의 참가 URL에만 필요하며 엔진 snapshot·오류·측정에 넣지 않는다.
큐 통계와 자막 통계는 기존 모듈의 단조 시계 측정을 재사용한다. 실제 TTS 첫소리·
종단 지연·실기기·규모 운영 합격은 이번 자동 테스트 결과로 주장하지 않는다.

### 자동 검증 결과

`node --test tests/hub-listen.test.mjs` 12개, 공통 G의
`node --test tests/*.test.mjs` 535개가 통과했다.
`node --test tests/`도 내부 전체 검사와 디렉터리 진입 검사를 통과했다.
실패·취소·skip·todo는 0이다. `node scripts/check-i18n.mjs`는
3개 언어·205개 키·53개 소스에서 I18N_OK, `git diff --check`도 통과했다.

## P2-15 앱 작업 소유권과 세션 전환

`createActivity()`의 모든 인스턴스는 같은 모듈의 앱 작업 슬롯·전환 큐·세대를
공유한다. 별도의 `createSessionManager()` 인스턴스들도 기존 제공자 Live 슬롯을
공유한다. 두 슬롯의 의미는 다르다. 허브 참가와 그 기기 TTS는 앱 작업을 점유하지만
제공자 Live 슬롯을 점유하지 않는다. 순차 작업은 녹음·REST·재생 전체를,
직접 동시통역은 준비·연결·복구·재생 전체를 앱 작업으로 소유한다.
탭·기기 간 보안 경계나 제공자 프로젝트의 할당량 강제 장치는 아니다.

### 호출 계약

- `acquire(kind, {cancel, close, signal?})`는 동기적으로 lease를 반환한다.
  kind는 `seq`, `sim`, `hub`, `diagnostics`, `preview`다. 점유·전환 대기 중이면
  기존 `SESSION_LIMIT` 코드로 거부한다. 사용자 제스처에서 acquire 후 같은 호출
  스택으로 기존 엔진을 시작할 수 있다. 권한·키 검사도 점유 확보 후 수행한다.
- `replace(kind, hooks)`는 기존 세대를 즉시 무효화하고 취소를 호출한다.
  기존 정리 확인 후 FIFO 순서로 새 lease를 반환한다. diagnostics·preview는
  replace로 호출해도 실행 중 작업을 빼앗지 않고 acquire와 같은 규칙을 적용한다.
- lease는 `generation`, `signal`, `isCurrent()`, 멱등 `close()`를 제공한다.
  비동기 결과·이벤트를 반영하기 전에 isCurrent를 검사한다. 앱 세대는 엔진 상태의
  세대 및 제공자 연결 세대와 별개이며 연결 세대를 덮어쓰지 않는다.
- cancel은 캡처·송신·재시도·PCM·TTS를 동기적으로 중지하는 훅이다.
  close는 엔진 정리와 늦게 생성되는 자원 및 실제 소켓 종료까지 확인한다.
  cancel의 Promise 완료를 기다리기 전에 close도 시작하며 두 결과 모두 확인한다.
  어느 쪽의 실패도 숨기지 않는다. 엔진 시작 실패도 lease.close로 정리한다.
- 관리자 `close()`는 활성 작업을 즉시 무효화하고 이미 대기 중인 전환도 취소한다.
  이후 사용자의 명시적 시작은 허용한다. 과거 lease.close는 새 작업을 종료하지 않는다.
- `snapshot()/subscribe()`는 generation·occupied·active·kind만 제공한다.
  occupied는 정리·전환 대기 중에도 true다. PWA 업데이트 판단에 사용한다.
  키·방 코드·텍스트·원본 오류는 저장하거나 알리지 않는다. 새 UI 문자열은 없다.

정리 기본 제한은 기존 세션 관리자와 같은 10초이며 타이머를 주입할 수 있다.
시간 초과는 점유 해제가 아니다. 실제 정리가 나중에 성공하면 해제되지만,
정리 Promise가 실패하면 새 관리자 생성으로도 우회할 수 없다. 제품용 강제 초기화
API는 없다. 실패 테스트는 별도 모듈 인스턴스를 사용해 다른 사례에 점유를 누출하지 않는다.

세션 관리자 replace도 큐를 기다리기 전에 기존 signal을 abort해 늦은 이벤트를
차단한다. 구독 알림 전에 opening Promise를 설치해 구독자의 즉시 close를 지원한다.
원격 closed에 따른 내부 abort는 SESSION_CLOSED로 유지하고 사용자 취소는 ABORTED다.
P1의 실제 종료 확인·오류 정규화·자동 음성 재전송 금지 계약을 보존한다.

### 후속 연결과 구현 범위

P2-09 sim과 P2-13 hub 엔진은 이미 구현되어 있다. 파일 제한에 따라 이번에는
엔진·셸·진단 파일을 수정하지 않았으며 P2-17·18에서 모든 시작 경로에 위 점유
계약을 연결해야 한다. 기존 엔진을 직접 실행하면 앱 작업 슬롯을 자동 획득하지 않는다.

- sim: cancel/close 훅에 stop을 연결하고, done 이후에도 sessionManager.close의
  성공을 확인한다. sim의 failed 결과나 done 해결만으로 소켓 종료를 단정하지 않는다.
- hub: cancel에서 leave를 호출해 TTS를 즉시 비우고, close에서 leave와 참가 handle의
  closed를 확인한다. leave 결과만으로 종료를 확정하지 않는다.
- seq·진단·미리듣기: 기존 cancel과 작업 done, voice 정리, sessionManager.close를
  조합한다. 정상 완료도 lease.close로 점유를 반환한다. 재접속 중에는 유지한다.
- 키·제공자·통역 언어·청취 방식 변경과 pagehide는 await activity.close 후 설정을
  적용하며 새 연결은 수동 시작한다. UI 언어·음소거·설정 창 열기는 전환하지 않는다.
- 비동기 replace 이후 브라우저 제스처 권한은 보장되지 않는다. 탭 전환은 close로
  끝내고 다음 시작 제스처에서 동기 acquire와 기존 엔진 start/join을 호출한다.

설계 정책 변경과 의존 구현 누락은 없다. 훅 기반 점유 API의 구체적 형태는 이 과제에서
정했다. 원본 translate/live/xlsx 및 voice/TTS 경계를 확인했으나 레거시 코드를
이식하지 않았으므로 새 출처 해시나 범위 밖 reuse-map 변경은 없다.
P1 테스트 기대값 변경·삭제·skip은 없다. 기존 종료 실패 검사는 의미를 유지하며
별도 모듈에 격리했다. 실키·실기기·종단 지연·규모 시험은 수행하지 않았다.

### P2-15 자동 검증 결과

Node v24.18.0에서 다음 명령을 직접 실행했다.

| 명령 | 결과 |
|---|---|
| `node --test tests/activity.test.mjs tests/session-manager.test.mjs` | 16개 통과 |
| `node --test tests/*.test.mjs` | 550개 통과 |
| `node --test tests/` | 내부 기능 549개 및 진입 검사 1개 통과 |
| `node scripts/check-i18n.mjs` | I18N_OK, 3개 언어·301개 키·54개 소스 |
| `git diff --check` | 통과 |

모든 테스트의 실패·취소·skip·todo는 0이다. 신규 파일은 activity.js와
activity.test.mjs이며, session-manager.js·session-manager.test.mjs·이 문서를
수정했다. git 커밋은 만들지 않았다.

## P3-01 P3 공통 인터페이스와 경계

기준은 [design-p3.md](design-p3.md) §1·§3·§4다. 아래는 P3-02 이후 과제가 서로 import할 계약이며,
P3-01은 코드를 만들지 않는다. 구현 과제는 이 형태를 따르되 정당한 이유로 바꾸면 보고서에 적는다.
공통 스타일: `createX({ 주입 의존성 })`은 import만으로 브라우저 전역·네트워크·저장소를 건드리지 않고,
동결된 객체를 반환하며, `snapshot()`은 동결된 비밀 없는 값을, `subscribe(fn)`은 해제 함수를 준다.
시계·타이머는 `now/setTimeout/clearTimeout`으로 주입한다.

### 정책 모듈 (`app/policy/`)

| 파일 | 과제 | 계약 |
|---|---|---|
| `schema.js` | P3-04 | `POLICY_SCHEMA_VERSION = 1`, `POLICY_LIMITS`(본문 65,536바이트·공지 10·행사 100·본문 1,000자·긴급 이유 300자), `REGISTERED_SETTINGS`(§1.4의 여덟 설정 이름과 종류·허용값·범위), `REGISTERED_FEATURES`(여섯 기능 이름), `compareVersions(a, b)`(숫자 비교, 잘못된 형식은 예외), `validatePolicy(input, { registeredHubIds, now })` |
| `resolve.js` | P3-05·08 | `resolveEffective({ policy, preferences, event, hubControl, capabilities })` 순수 함수 |
| `client.js` | P3-06 | `createPolicyClient({ fetch, location, now, setTimeout, clearTimeout, appVersion, registeredHubIds })` |
| `runtime.js` | P3-07 | `createPolicyRuntime({ client, preferences, activity, sessionManager, now })` |

`validatePolicy`는 입력을 변경하지 않고 `{ ok: true, policy }` 또는 `{ ok: false, issues }`를 돌려준다.
`policy`는 검증된 필드만 새 객체에 복사해 깊이 동결한 값이고, `issues`는 `{ code, path }` 배열이다
(`path`는 `settings.ui.tone.default`처럼 점 경로, 값·원문은 넣지 않는다). 이슈 코드는
`POLICY_SCHEMA`, `POLICY_FIELD`, `POLICY_RANGE`, `POLICY_TEXT`, `POLICY_REFERENCE`, `POLICY_CONFLICT`,
`POLICY_UNKNOWN_KEY`, `POLICY_TOO_LARGE`로 시작하는 대문자 식별자만 쓴다. 관리자 콘솔·`check-release`·앱은
모두 이 함수 하나를 쓴다. `__proto__`·`constructor`·`prototype` 키와 미등록 키는 거부한다.

`resolveEffective`의 결과:

```text
{
  blocked: null | { code, revision },        // 실행 전체 차단 사유 (아래 코드 표)
  settings: { [name]: { value, source, allowed, locked, reasonKey } },
  features: { [name]: { enabled, reasonKey } },
  event: null | { id, providerId, expiresAt, allowedCapabilities },
}
```

`source`는 `personal | policyDefault | forced | appDefault`, `reasonKey`는 잠금·제한 설명의 사전 키다.
개인 선택 원본은 결과에 덮어쓰지 않으며 저장소에 실효값을 쓰지 않는다. `ui.language`는 정책 대상이 아니다.

`createPolicyClient`는 `start()`, `stop()`, `refresh({ reason })`, `snapshot()`, `subscribe()`를 제공한다.
상태는 `loading | ready | stale | failed | expired`, `snapshot()`은 `{ status, policy, revision, fetchedAt, error }`이며
`error`는 코드 문자열뿐이다. 요청 세대 카운터로 늦은 응답을 버리고, 60초 전경 갱신·전경 복귀 갱신·5분 stale
유지는 §1.5 값이다. 정책 URL은 `location.pathname`의 마지막 `/`까지를 배포 루트로 삼은 `policy.json`
하나이며 `redirect: 'error'`, `cache: 'no-store'`, 5초 제한, 64KiB 본문 상한을 적용한다. 본문·정책은 영구
저장하지 않는다.

`createPolicyRuntime`은 `snapshot()`, `subscribe()`, `assertAction(kind)`를 제공한다. `kind`는
`seq.start | seq.retry | seq.replay | diagnostics | sim.direct | hub.join | event.join`이다.
차단 시 `PolicyError`(`runtime.js`에서 정의, `name = 'PolicyError'`, `code` 필드)를 던진다. 코드:

| 코드 | 뜻 |
|---|---|
| `POLICY_LOADING` | 첫 조회 중 |
| `POLICY_UNAVAILABLE` | 첫 조회 실패·잘못된 정책·5분 stale 초과 |
| `POLICY_EXPIRED` | `validUntil` 경과 |
| `POLICY_STOPPED` | 긴급 중지 |
| `POLICY_FEATURE_DISABLED` | 해당 기능 토글 OFF |
| `APP_VERSION_TOO_OLD` | `minAppVersion` 미달 |
| `EVENT_ENDED` | 참가 행사 만료·중지·목록 제거 |
| `HUB_CONTROL_STOPPED` | 허브 통제 중지 latch |
| `HUB_CONTROL_LOST` | 협상한 제어의 heartbeat 상실 |

이 코드는 `ERROR_CODES`(제공자 계약)에 넣지 않는다. 화면은 `errorCodeKey(error.code)`로 `error.<CODE>`
키를 만들며 `redact()`를 거치지 않는다. P3-02가 아홉 코드의 `error.*` 키를 세 언어로 추가한다.
런타임은 정책 축소·중지 시 `activity.close()`와 기존 `stopWork()` 경로만 호출하고, 소켓 종료 확인 실패를
성공으로 바꾸거나 Live 점유를 강제 해제하지 않는다. 허용 확대·중지 해제는 게이트만 열고 자동 시작하지 않는다.

### 개인 설정 저장소 (`app/preferences.js`, P3-05·14·18·25·29)

`createPreferences({ storage, now })`는 `get(name)`, `set(name, value)`, `remove(name)`, `snapshot()`,
`subscribe(fn)`, `persisted`(저장소 사용 가능 여부)를 제공한다. `name`은 `REGISTERED_SETTINGS`와 아래 로컬
전용 이름만 받고, 값은 등록된 종류·허용값으로 검증한 뒤 저장한다. 오염값·저장소 거부는 기본값으로
대체하고 예외를 밖으로 내지 않는다. 다른 탭의 `storage` 이벤트는 P3-14가 구독한다.

| 이름 | 저장 키 | 비고 |
|---|---|---|
| `ui.language` | `interp-app.ui.v1.language` | 기존 키 재사용, 정책 잠금 불가 |
| `ui.mode` / `ui.tone` / `ui.text` | `interp-app.ui.v1.mode` / `.tone` / `.text` | DESIGN.md §10, 부트 스크립트와 같은 해석 |
| `captions.size` | `interp-app.ui.v1.captionSize` | 1~2rem, 0.125 단위 |
| `interpretation.sourceLanguage` / `targetLanguage` | `interp-app.pref.v1.interpretation.sourceLanguage` / `.targetLanguage` | P3-01 결정: 표시 설정 외 등록 설정은 `interp-app.pref.v1.<이름>` |
| `voice.output` | `interp-app.pref.v1.voice.output` | 위와 같음 |
| `billing.plan` | `interp-app.pref.v1.billing.plan.<providerId>` | 제공자별 |
| `audio.inputDeviceId` / `audio.outputDeviceId` | `interp-app.audio.v1.inputDeviceId` / `.outputDeviceId` | 로컬 전용, 정책·로그·진단 내보내기 제외 |
| `usage.rates.<providerId>` | `interp-app.pref.v1.usage.rates.<providerId>` | 정책 `allowLocalOverride=true`일 때만 |

`interp-app.personal-key.v1.<providerId>`와 `interp-app.ui.v1.install-hint`는 기존 소유자(키 저장소·PWA)가
계속 관리하며 preferences를 거치지 않는다.

### 표시 설정 (`app/ui/appearance-boot.js`, `app/ui/appearance.js`, P3-13·14)

부트 스크립트는 모듈이 아닌 동기 스크립트로 `<head>`의 스타일시트 앞에 놓인다. 저장된 `ui.mode/tone/text`만
읽어 `<html data-mode|data-tone|data-text>`를 설정하고, `system`이면 `data-mode`를 제거한다. 저장소 예외·
오염값은 `system/navy/m`으로 진행한다. 네트워크·키·정책 접근이 없고 전역을 남기지 않는다. `appearance.js`의
`createAppearance({ document, matchMedia, preferences, runtime })`는 같은 값 해석 함수를 export해 부트와 런타임이
한 규칙을 쓰고, `apply(effectiveSettings)`, `destroy()`를 제공한다. 관리자 HTML도 같은 부트 스크립트를 쓴다.

### 허브 통제 (`app/hub/protocol.js`, `app/hub/control.js`, P3-09·10·11)

`parseHubMessage`는 `policy.control` 봉투를 추가로 정규화한다(최대 16,384바이트, `ttlSeconds` 10~120,
`disabledFeatures`는 `REGISTERED_FEATURES` 부분집합, `notice`는 세 언어 본문). `createHubProtocol`은
`hello`에 선택 `control: { version: 1, eventId, epoch, revision }`을 붙이는 `buildHello(session, control)`을 제공한다.
`createHubControl({ now, setTimeout, clearTimeout })`는 `negotiate({ eventId, epoch })`, `receive(snapshot)`,
`disconnected()`, `reset()`, `snapshot()`, `subscribe()`를 제공하며 snapshot은 `{ supported, eventId, epoch, revision,
stopped, disabledFeatures, notice, heartbeatLost, expiresAt }`다. 중복·역순 revision·다른 epoch·TTL 초과 메시지는
무시하고, 중지 latch는 더 높은 revision의 유효 snapshot으로만 풀린다. 단절·TTL 만료는 `heartbeatLost`만 세운다.
`resolveEffective`가 `hubControl`을 교집합으로만 적용한다. 서버 프로토콜 문서는 `docs/hub-control-protocol.md`(P3-09·10)다.

### 마이크 권한·장치·출력 (`app/audio/permissions.js`, `devices.js`, `output-device.js`, P3-23~28)

- `createMicrophonePermission({ navigator, now })`: `query()`, `request({ signal })`, `snapshot()`, `subscribe()`.
  상태 `granted | denied | prompt | unsupported`, 오류 구분 `denied | noDevice | busy | unknown`. `request`는
  사용자 제스처 안에서만 호출하며, 취소 뒤 늦게 도착한 스트림의 트랙을 즉시 중지한다. 결과 스트림은
  호출자가 소유하며 `probe` 용도는 즉시 정리한다. `NotReadableError`는 `busy`이지 `denied`가 아니다.
- `createAudioDevices({ navigator, preferences })`: `refresh()`, `list()`(`{ kind, deviceId, label }`, 시스템 기본값 항상
  포함), `subscribe()`. 권한 전 라벨은 비워 둔다. 사라진 저장 ID는 기본값으로 복귀한다.
- `createOutputDevice({ preferences })`: `supports(context)`(실제 `AudioContext.prototype.setSinkId` 검사),
  `apply(context)`, `snapshot()`. 기기 `speechSynthesis`에는 적용하지 않는다.
- `createPlatform`은 `getUserMedia(constraints)`에 선택 장치를 병합하되 `channelCount: 1`과 sampleRate 요청을 잃지 않는다.

### 사용량·추정 비용 (`app/engine/usage.js`, P3-29~31)

`createUsage({ now, preferences, getRates })`는 `begin({ capability, model, providerId, keySource })`가 반환하는 구간
핸들의 `end()`(멱등)로 활성 시간을 기록하고, `snapshot()`으로 `{ segments, totals: { [capability]: { seconds, model } },
estimate: { status: 'unavailable' | 'partial' | 'complete', amount, currency, ratesRevision, basis } }`를 준다.
요율은 구간 시작 시점의 `pricing.revision`으로 고정한다. 허브 청취(`keySource: 'hub'`)와 공용 행사 사용량은 개인
합계에 더하지 않는다. 키·원문·오디오는 이벤트에 넣지 않는다. Free/Paid는 표시만 바꾼다.

### 관리자 콘솔 (`admin/index.html`, `app/admin/`, P3-32~34)

`admin/index.html`은 배포 루트의 두 번째 진입 HTML이며 `app/admin/main.js` 모듈 하나와 부트 스크립트 하나만
참조한다. `createPolicyEditor({ document, i18n, validatePolicy, current })`는 편집 상태·검증·미리보기를,
`createPolicyExport({ document, Blob, URL, clipboard })`는 다운로드·복사를, `createSharedPayloadTool({ document, i18n,
policy, parseSharedFragment })`는 v2 payload 생성을 맡는다. 편집 상태는 앱 정책 서비스와 연결하지 않으며, 키는
메모리에만 있고 닫기·`pagehide`에서 지운다. 관리자 페이지에서는 마이크·정책 갱신·제공자 호출을 시작하지 않는다.

### 공용 키 payload v2 (`app/security/shared-key.js`, P3-08·34)

`parseSharedFragment`는 `version: 1`과 `version: 2`를 모두 받는다. v2는 `{ version, providerId, eventId, eventName,
key, expiresAt }`이며 `eventId`는 `^[a-z0-9-]{1,64}$`다. 정책 대조(`resolve.js`)는 파서 밖에서 한다: v2는 활성
행사 ID·제공자·행사명·만료가 모두 일치해야 하고, v1은 활성 행사와 제공자·행사명·만료가 **유일하게** 일치할 때만
쓴다. 기존 길이 상한(`MAX_FRAGMENT_LENGTH`)과 메모리 전용 보관은 유지한다. 행사 ID는 서명이 아니다.

### 릴리스·서비스 워커 (P3-13·35·36)

- 진입 HTML 검사: 동기 부트 스크립트(경로 고정 `./releases/<id>/app/ui/appearance-boot.js`) 하나와
  `./releases/<id>/app/main.js` 모듈 하나. 그 외 스크립트·inline은 `RELEASE_ENTRY_INVALID`.
- 루트 파일에 `policy.json`, `admin/index.html`을 추가하되 `shellFor()`의 precache에는 넣지 않는다. 정책 요청은
  SW에서 network-only이고 실패해도 셸 설치를 막지 않는다.
- `check-release`는 정책을 `validatePolicy`로 검사하고 `minAppVersion ≤ APP_VERSION`, `allowedHubIds ⊆ REGISTERED_HUBS`,
  정책·관리자 자산의 비밀 패턴을 확인한다. `--point` 롤백은 정책 파일을 덮어쓰지 않는다.
- `_headers` 통과는 GitHub Pages 실제 헤더 적용의 증거가 아니다.

### i18n 키 접두사 (P3-02·03이 추가, 이후 과제가 사용)

| 접두사 | 용도 |
|---|---|
| `policy.status.<상태>` | 정책 조회 상태: loading·ready·stale·failed·expired |
| `policy.source.<출처>` | 설정 출처 표시: personal·policyDefault·forced·appDefault |
| `policy.lock.*`, `policy.blocked.*`, `policy.notice.*` | 잠금 설명·차단 배너·공지 |
| `error.POLICY_*`, `error.APP_VERSION_TOO_OLD`, `error.EVENT_ENDED`, `error.HUB_CONTROL_*` | 위 `PolicyError` 코드 |
| `admin.section.*`, `admin.action.*`, `admin.issue.<코드>`, `admin.preview.*`, `admin.publish.*` | 관리자 콘솔 |
| `event.*` | 공용 키 행사 상태 |
| `display.mode.<값>`, `display.tone.<값>`, `display.text.<값>`, `display.captions.*` | 표시 설정: system·light·dark / navy·warm·forest·mono / s·m·l·xl |
| `keyGuide.*` | 키 발급 안내 카드(3단계·링크·제한 안내) |
| `permission.<상태>`, `permission.help.<플랫폼>` | 마이크 권한: granted·denied·prompt·unsupported·noDevice·busy / ios·android·desktop |
| `device.*` | 입력·출력 장치 |
| `billing.plan.<값>`, `billing.estimate.<상태>`, `billing.*` | 요금제: free·paid / 추정: unavailable·partial·complete |
| `settings.section.<이름>`, `settings.sectionHint.<이름>` | 설정 섹션 제목·설명: display·interpretation·provider·sharedKey·billing·audio·diagnostics·records·app·terms |
| `hubControl.<상태>` | 허브 실시간 통제: supported·unsupported·stopped·lost |

동적으로 조합하는 열거 키는 `scripts/check-i18n.mjs`의 명시 목록에 등록한다(P3-32가 관리자 소스 경로도 추가).

### 변경하지 않는 기존 계약

`createAppConfig`·라우터·`createKeyStore`·`createActivity`·`createSessionManager`·`createLiveRecovery`·
허브 청취 엔진·자막 저장소·스트림 재생기의 계약과 이 문서의 P1/P2 절은 그대로다. 정책 런타임은 이들을
호출하는 쪽이지 대체하지 않는다. 새 모듈은 브라우저에 Node 전용 API를 들이지 않으며 레거시 코드를 이식하지 않는다.
