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
