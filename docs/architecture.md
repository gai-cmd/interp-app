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
