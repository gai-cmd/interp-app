# 1. P2 상세 설계

기준은 `docs/design-v0.6.md`이며, “v0.5 그대로”로 편입한 절도 적용한다. 아래는 P2에서 구체화하는 절의 대체 본문이다. 모델 이름과 요청 형식은 저장소·이식 원본 기준이며, 현재 서비스 지원 여부를 검증한 결과는 아니다.

파일 수정·테스트 실행·배포는 하지 않았다. 아래 명령은 각 과제를 구현한 뒤 실행할 명령이다.

## §7.3 동시통역 화면

`app/ui/shell.js`의 동시통역 탭을 활성화한다. 탭 진입만으로 마이크 권한 요청·API 연결·허브 접속을 시작하지 않는다.

| 영역 | 내 폰 마이크 | 현장 방송 |
|---|---|---|
| 청취 방식 | 기본 선택 | 코드에 등록된 허브가 있을 때 표시 |
| 입력 | 원어 안내·마이크 레벨 | 현장 이름·방 코드 |
| 목표어 | ko/en/ja 선택 | `hello.settings.allowedLangs`와 앱 지원 언어의 교집합 |
| 출력 | Live 생성 음성 / 소리 끔 | 기기 음성 / 소리 끔 |
| 조작 | 시작·중지·수동 재시작 | 참가·나가기·수동 재접속 |
| 상태 | 권한 확인·연결·통역·재연결·지연·실패 | 연결·방송 대기·수신·재접속·지연·종료 |
| 자막 | 번역문, 수신된 경우만 원문 | 선택 목표어와 선택적 `src` 원문 |
| 안내 | 이어폰 권장·개인 키·좌석 음질 | 마이크·API 키 불필요·기기 음성 사용 |

공통 동작:

- 임시 자막은 같은 행을 갱신하고 확정 자막과 시각적으로 구분한다.
- 누락은 “연결 중 일부 내용을 받지 못했을 수 있어요”, 음성 건너뛰기는 “밀린 음성을 건너뛰었어요”처럼 원인별로 구분한다.
- 재접속 직후 과거 자막은 “최근 자막”으로 표시한다. 자동 낭독하지 않는다.
- 위로 스크롤한 동안 강제로 맨 아래로 이동하지 않는다. “최신 자막” 버튼을 제공한다.
- 메모리·DOM에는 최근 확정 구간 100개와 활성 임시 구간만 유지한다. 영구 저장은 P3 범위다.
- 연결 상태와 오디오 상태를 분리한다. 재생 차단이 자막 수신 실패로 표시되어서는 안 된다.
- 출력 언어·청취 방식 변경은 현재 작업을 종료하고 새 설정을 적용한다. 새 연결은 사용자가 시작한다.
- UI 언어 변경과 음소거는 연결을 교체하지 않는다.
- 동시통역 중 제공자 목소리 미리듣기·순차 재생·음성 진단을 함께 실행하지 않는다.
- 설정 창을 열기만 해서는 통역을 중지하지 않는다. 키·제공자 등 실행 조건 변경 시 중지한다.

기존 색상·간격·타이포그래피·버튼 토큰을 사용한다. 터치 영역 44px, 키보드 탭 조작, 200% 확대, 다크 모드를 유지한다. `aria-live`는 상태와 확정 자막 위주로 사용하며 부분 토큰마다 낭독하지 않는다.

모든 문구는 ko/en/ja 사전에 동시에 추가한다. 기기 음성 목록이 비었거나 조회가 예외를 던져도 화면은 부팅되어야 한다.

## §8.4 동시통역 엔진과 상태 기계

### 실행 경로

```text
내 폰 마이크
  → 스트리밍 캡처·16kHz 리샘플링
  → sim 엔진
  → 세션 관리자 → 능력 라우터 → Gemini live 어댑터
  → 자막 조립 / 24kHz PCM 재생

현장 방송
  → hub/client → hub/protocol
  → 자막 저장·갱신 / 기기 TTS 큐
```

현장 방송은 이미 생성된 자막을 받는 청중 기능이다. 제공자 API를 호출하는 `router.call(..., transport: 'hub')`와 다르다. 기존 허브 전용 제공자 라우팅 계약이나 Gemini의 `hubManaged` 선언을 변경하지 않는다.

### 상태

세션 상태와 출력 상태를 분리한다.

- 세션: `idle`, `preparing`, `connecting`, `running`, `reconnecting`, `stopping`, `stopped`, `failed`.
- 출력: `muted`, `ready`, `blocked`, `delayed`, `catching-up`, `unavailable`.
- 허브 방송 상태: `unknown`, `waiting`, `receiving`, `ended`.

| 입력·사건 | 전이·처리 |
|---|---|
| 시작 | `idle/stopped/failed → preparing`; 실행 세대 생성, 기존 작업 정리 |
| 준비 성공 | `connecting`; 직접 모드는 사용자 제스처에서 오디오 준비·권한 요청 |
| setup 완료 / 유효한 hello | `running`; 허브는 별도로 방송 대기 상태 가능 |
| goAway·복구 가능한 단절 | `reconnecting`; 송신 중지·이전 연결 종료 확인·제한된 재접속 |
| 복구 성공 | `running`; 이전 음성 재전송 없이 새 입력부터 처리 |
| 예산 소진·fatal | 정리 후 `failed`; 수동 재시작 제공 |
| 사용자 중지·탭 이탈·실행 조건 변경 | `stopping → stopped` |
| 허브 cast.stopped | 출력 큐를 비우고 `stopped`; 자동 재참가하지 않음 |
| 페이지 숨김·pagehide·입력 장치 종료 | 중지·미확정 구간 중단 처리; 복귀 후 수동 시작 |

종료는 멱등적으로 수행한다. 권한 요청·setup·재시도 대기·Blob 해석 중 중지해도 늦게 생긴 리소스를 정리한다.

소켓 종료 확인에 실패하면 UI 작업은 오류로 끝내되 세션 관리자의 점유는 유지한다. 시간 초과를 소켓 종료 성공으로 간주하지 않는다.

### Gemini 요청과 폴백

기본 모델은 `gemini-3.5-live-translate-preview`다.

- `generationConfig.responseModalities = ['AUDIO']`.
- `generationConfig.translationConfig = { targetLanguageCode, echoTargetLanguage: false }`.
- 입력·출력 transcription을 요청한다.
- 번역 전용 모델에는 `systemInstruction`을 보내지 않는다.
- 원어 선택을 지원되지 않는 API 필드로 전달하지 않는다. 자동 인식 경로임을 안내한다.
- 목소리 설정은 해당 모델에서 확인된 필드·목록만 사용한다. P1 voice 목록 전체를 동시통역 지원 목록으로 간주하지 않는다.

이식 원본의 flash-live 후보는 다음과 같다.

1. `gemini-3.1-flash-live-preview`
2. `gemini-live-2.5-flash-preview`

후보는 코드에 고정하고 모델별 setup과 지원 조건을 선언한다. flash-live에서는 목표어 통역만 하도록 고정 프롬프트를 사용한다. 자유 페르소나·맞장구·내용 첨가 옵션은 이식하지 않는다.

모델·설정 미지원 또는 허용된 일시 오류에만 등록된 폴백을 적용한다. 키·권한·한도·안전 차단으로 모델을 순환하지 않는다. 폴백을 포함한 추가 연결은 재연결 예산을 공유한다.

동시통역에서 받은 PCM은 직접 재생한다. 자막을 별도의 제공자 `voice` 세션으로 보내지 않는다. 직접 Live 실패 후 “짧게 나눠 순차통역”은 사용자가 선택하며 기존 순차통역 화면으로 이동한다. 자동 REST 반복은 구현하지 않는다.

## §8.5 오디오 큐·지연 예산·느린 수신자

### 직접 입력

입력은 PCM16 little-endian·mono·16kHz다.

- 실제 장치 샘플레이트에서 리샘플링한다.
- 512샘플, 1,024바이트, 32ms 단위로 전송한다.
- 기존 PTT의 30초 누적·WAV 생성 경로와 별도 스트리밍 캡처를 둔다.
- 입력 큐는 초기 정책값으로 최대 8프레임, 256ms로 제한한다.
- 넘치면 오래된 미전송 프레임을 버리고 입력 누락을 표시한다.
- 연결 전·재연결 중 음성을 누적하지 않는다.
- `sendAudio()`를 프레임마다 무제한 동시 호출하지 않는다. 단일 송신 펌프가 처리한다.
- WebSocket `bufferedAmount`에도 동시통역용 상한을 적용한다. 이미 브라우저 송신 버퍼에 들어간 데이터는 취소할 수 없으므로 상한 초과 시 연결을 정리하고 제한된 복구로 이동한다.

256ms는 조정 가능한 앱 정책이며 실측 성능이나 제공자 한도가 아니다.

### 직접 출력

출력은 PCM16 little-endian·mono·24kHz다.

- AudioContext 시간으로 예약한다.
- 초기 예약 여유는 기존 구현 수준인 약 60ms를 사용한다.
- 예약된 음성 길이가 3초 이상이면 지연 상태를 표시한다.
- 8초를 넘길 새 청크는 받지 않고 따라잡기 상태로 전환한다.
- 이미 예약한 오래된 소스를 정리한 뒤 다음 제공자 턴 경계에서 재개한다.
- 턴 경계가 오지 않으면 초기 정책값 2초 후 강제 재개하되 “중간 음성이 잘림”을 표시한다.
- 자막 확정은 오디오 경계의 증거로 사용하지 않는다. 두 스트림의 정밀 대응은 보장되지 않는다.
- `interrupted`는 현재 오디오 큐를 취소한다.
- 음소거 중 PCM을 저장하지 않는다. 소리를 다시 켜도 과거 음성을 재생하지 않는다.

기존 `pcm-player.js`는 유한 턴·120초 수명과 overflow 종료를 전제로 한다. 이를 설교 전체에 그대로 사용하지 않고 별도 스트림 재생기를 만든다.

### 허브 기기 음성

현재 `interp-web/lib/live.js`는 모델 오디오를 폐기한다. 서버는 청중에게 PCM을 방송하지 않는다. 따라서 현장 방송의 음성은 확정 번역 자막을 기기 TTS로 읽는다.

- 선택 목표어의 새 확정 자막만 큐에 넣는다.
- 동시에 하나만 읽고 브라우저 내부 TTS 큐에 여러 문장을 밀어 넣지 않는다.
- 임시 자막·원문·재접속 중복·최근 자막 재생분은 자동 낭독하지 않는다.
- 대기 자막 최대 20개, 가장 오래된 항목 대기 3초에서 지연 표시를 초기 정책으로 둔다.
- 8초를 넘긴 대기 항목은 문장 단위로 버리고 최신 확정 자막으로 따라잡는다.
- 진행 중인 한 문장은 기존 TTS watchdog으로 제한한다. 무한 대기를 허용하지 않는다.
- 음성 목록 없음·언어 음성 없음·재생 실패 시 자막 수신을 유지한다.
- 기기 음성의 외부 처리 여부를 오프라인으로 단정하지 않는다.

### 느린 허브 수신자

클라이언트 메시지 해석 큐에도 메시지 수·바이트 상한을 둔다. 초기값은 기존 Live 수신 한도와 같은 메시지당 1MiB, 대기 128개·2MiB다.

상한 초과 시 해당 클라이언트만 연결을 닫고 제한된 재접속을 수행한다. 서버의 전송 큐를 청중 코드에서 제어할 수 있다고 주장하지 않는다. 기존 서버의 느린 수신자 격리·메모리 증가 여부는 규모 시험에서 확인한다.

### 지연 측정의 경계

32ms 프레이밍·256ms 입력 큐·3초 경고·8초 복귀는 앱 내부 예산이다. 이를 발화부터 실제 청취까지의 보장 지연으로 합산하지 않는다.

모델 처리·회선·OS 오디오 출력은 별도로 측정한다. 종단 지연 합격선은 오너의 운영 기준으로 남긴다.

## §8.6 자막 조립·revision·누락

### 직접 Live

`SegmentAssembler`는 제공자에 종속되지 않는 순수 모듈로 만든다.

- 입력·출력 스트림에 각각 독립 조립기를 사용한다.
- 제공자가 delta로 정의한 전사는 추가하고 snapshot은 교체한다. 반복 단어만 보고 임의로 중복 제거하지 않는다.
- 문장 경계·`finished`·`turnComplete`에서 확정한다.
- 마지막 조각 이후 1.5초 동안 새 전사가 없으면 로컬 확정한다.
- 문장 길이 상한을 두고 긴 무구두점 발화를 분할한다.
- 중지·단절·`interrupted`에서는 남은 조각을 정상 final로 만들지 않고 `interrupted`로 종료한다.
- 원문과 번역문의 문장 수·경계가 같다고 가정하지 않는다.
- 숫자 소수점·약어·일본어 문장부호·혼합 언어·Unicode 경계를 시험한다.

구간 식별자는 실행 세션·연결 세대·역할·로컬 카운터를 포함한다. 입력과 출력 카운터를 분리하여 원본 `LiveLane`의 출력 카운터 공유에 따른 충돌을 이식하지 않는다.

`revision`은 같은 구간에서 증가한다. 이전 revision은 무시한다. final 이후 더 높은 revision이 오면 화면은 수정하되 이미 읽은 음성을 자동 재생하지 않는다. partial로 되돌리지 않는다.

### 공통 구간 모델

```text
id / sessionId / generation
role: source | translation
sequence / revision
sourceText 또는 translatedText
status: partial | final | interrupted
gapBefore
receivedAt / finalizedAt
processing.live: 선택 { providerId, model }
```

오디오 누락·입력 누락·수신 누락은 별도 원인으로 기록한다. 음성만 생략된 경우 자막을 “누락된 번역”으로 바꾸지 않는다.

### 허브 자막

허브의 `text`는 해당 `segmentId`의 전체 자막 snapshot으로 처리한다. 직접 Live 조립기에 다시 넣지 않는다.

키는 로컬 참가 epoch·`lang`·`segmentId`다. 같은 키의 더 높은 revision을 적용하고 중복 final은 재생하지 않는다.

서버 `seq`는 모든 언어와 partial 이벤트가 공유한다. 전체 이벤트 순서를 처리한 뒤 언어를 필터링한다. 목표어 이벤트 사이의 숫자 차이를 누락으로 판정하지 않는다.

재접속의 최근 30개는 확정 자막만 포함하므로 seq가 연속일 필요가 없다. 연결이 끊겼던 구간은 “누락 가능”으로 표시하며 정확한 누락 문장 수를 만들어 내지 않는다.

## §9 세션 전환·오류·한도

### 단일 Live 소유권

Gemini `voice`와 `live`는 `createGeminiAdapter()` 안에서 같은 `createGeminiLiveClient()` 인스턴스를 사용한다. 모든 제공자 Live 연결은 기존 세션 관리자를 통한다.

전환 순서는 다음으로 고정한다.

1. 앱 작업 세대를 갱신하여 이전 결과 반영을 차단한다.
2. 기존 캡처·송신·재시도·PCM·기기 TTS를 취소한다.
3. 기존 엔진과 Live lease를 닫는다.
4. 물리적 소켓 종료를 확인한다.
5. 새 작업의 권한·자격증명·라우팅을 검사한다.
6. 새 연결을 연다.

| 전환 | 규칙 |
|---|---|
| 순차 목소리 → 동시통역 | 이전 목소리 종료 확인 후 Live 시작 |
| 동시통역 → 순차 탭 | 동시통역 중지; 사용자가 다음 턴 실행 |
| 직접 → 허브 | 직접 Live·마이크 종료 후 허브 참가 |
| 허브 → 직접 | 허브·TTS 종료 후 개인 키와 마이크 검사 |
| 진단·미리듣기 | 실행 중 작업과 동시 시작 차단; 조용히 세션을 빼앗지 않음 |
| 키 삭제·출처 변경·제공자 변경 | 기존 작업 종료·이전 검사 결과 무효화 |
| PWA 업데이트 | 연결·재접속 대기·재생·정리 중 모두 적용 보류 |

허브 소켓은 제공자 Live 수에 포함하지 않지만 앱의 청취 작업 소유권을 공유한다. 순차 재생과 허브 TTS도 겹치지 않는다.

### goAway와 재연결

이식 원본의 후속 소켓 선연결은 사용하지 않는다.

- `goAway`를 받으면 입력을 멈추고 이전 연결을 닫는다.
- 종료 확인 후 같은 모델로 새 연결을 시도한다.
- 계획 교체도 추가 연결 예산에 포함한다.
- 최초 연결 외 최대 3회, 약 1·2·4초 지터 대기, 서버의 더 긴 대기 우선.
- 모델·설정 폴백도 같은 예산을 소비한다.
- 사용자 재시작 또는 60초 안정 연결 후에만 예산을 초기화한다.
- 잠깐 setup이 성공했다고 실패 횟수를 초기화하지 않는다.
- 복구 중 녹음 전체·마지막 발화를 자동 재전송하지 않는다.

### 오류

기존 `ProviderError` 분류를 유지한다.

- 사용자 취소만 `ABORTED`.
- 원격 종료는 `SESSION_CLOSED` 또는 근거 있는 네트워크·제공자 오류.
- 내부 cleanup의 abort가 원래 원격 오류를 덮지 않는다.
- 일일 소진은 fatal, 분당 제한은 서버 대기 후 제한 재시도.
- 원인 불명 429와 분류 불가능한 quota 소진은 자동 반복을 중단한다.
- `RESOURCE_EXHAUSTED` 문자열만으로 일일 소진을 단정하지 않는다.
- SESSION_LIMIT은 종료 확인 후 제한 재시도한다.
- TOKEN_LIMIT은 재접속으로 해결된다는 근거가 없으면 자동 반복하지 않는다.
- 403 전체를 IP 차단으로 표시하지 않는다.
- 제공자 원문·close reason·인증 URL을 UI·로그·진단에 보관하지 않는다.

허브 `fatal.detail`은 구조화된 제공자 오류가 아니다. 그대로 표시하거나 정규식만으로 일일 소진으로 바꾸지 않는다. 안전한 “방송 오류” 상태로 매핑한다.

## §10 기존 맥 허브 수신

### 모듈 경계와 접속

- `app/hub/protocol.js`: URL·메시지 검증, 서버 이벤트 정규화.
- `app/hub/client.js`: 브라우저 WebSocket·순서 보존·재접속·종료.
- `app/engine/hub-listen.js`: 자막 상태·기기 음성·청취 수명주기.
- 서버 코드는 수정하지 않는다.

접속은 코드에 등록된 WSS 허브의 `/ws?room=<인코딩된 코드>`다.

사용자·QR은 API endpoint나 임의 허브 origin을 등록할 수 없다. 방 코드는 메모리에만 보관하고 앱 URL·로그·저장소에 남기지 않는다. 방 코드는 해당 WebSocket 참가 URL에는 필요하므로 “모든 네트워크 URL에서 제거”를 주장하지 않는다.

청중은 `role=source`, `cast.start`, `cast.stop`, `cast.audio`, 순차 번역 요청을 보내지 않는다. 브라우저 API 키 조회·마이크 권한 요청도 하지 않는다.

### 실제 프로토콜 매핑

| 서버 메시지 | 앱 처리 |
|---|---|
| `hello {sessionId, settings}` | 참가 완료, 허용 언어·기본 언어 등 필요한 필드만 채택 |
| `cast.caption {lang, segmentId, seq, text, final, revision, ts?}` | 자막 snapshot 갱신; `src`는 원문 |
| `cast.status {lang, state, model?, detail?}` | 선택 언어 또는 `*` 방송 상태 갱신; raw detail 폐기 |
| `status` | 원본 서버의 타입 덮어쓰기 동작에 대한 제한된 호환 처리 |
| `cast.stopped {reason?}` | 종료·큐 정리; 허용된 의미만 표시 |
| `settings {settings}` | 허용 언어 갱신; 선택 언어 제거 시 중지 |
| `closed`, `outside`, `denied` | 각각 방 종료·접근 거부로 종료 |
| 기타 | 무시; 크기·형식 제한은 계속 적용 |

원본의 정상 상태 방송 코드에는 `{ type: 'cast.status', lang, ...ev }`가 있어 `ev.type === 'status'`가 최종 타입을 덮어쓴다. 서버 수정 없이 이 형태를 fixture와 파서에서 다룬다.

청중 연결 시 서버가 보내는 것은 hello와 최근 확정 자막 최대 30개이며, 현재 상태 snapshot을 반드시 보내지는 않는다. hello만으로 “방송 중”이라 표시하지 않는다.

### 최근 자막과 방송 식별 한계

프로토콜에는 replay 시작·끝이나 안정적인 broadcast ID가 없다.

- 첫 연결과 재연결은 기본적으로 자막만 받는다.
- “소리 켜기”를 누르기 전 받은 자막은 자동 낭독 대상에서 제외한다.
- 방 참가 화면에 최근 자막이 섞일 수 있음을 안내한다.
- 이미 본 `(lang, segmentId, revision)`은 재접속 후 다시 읽지 않는다.
- `cast.stopped` 후 방송 재시작은 새 참가 epoch로 처리한다.
- 단절 중 방송이 재시작되어 seq·ID가 재사용되었을 가능성은 완전히 판별할 수 없다. 불확실한 재접속에서는 음성을 끄고 사용자 재개를 요구한다.
- 최근 30개의 완전한 복구나 모든 과거/새 자막의 정확한 구별을 보장하지 않는다.

### 현 서버 제약

현재 서버는 다음을 구현하고 있다.

- 방송 언어 목록을 최대 3개로 자름.
- 방송 시작 후 150분 자동 종료.
- 느린 청중에 대한 명시적인 송신 버퍼 상한 없음.
- 청중에게 생성 PCM을 보내지 않음.

이는 목표 규모가 아니라 현재 서버의 제약이다. 목표가 이를 넘으면 무중단 운영 합격을 선언할 수 없다. P2 범위에서는 정원·운영 시간·재참가 절차 조정 또는 해당 운영 보류로 처리한다.

허브 주소는 검토된 코드 설정과 `ENDPOINT_ORIGINS`, 배포 CSP에 반영한다. 안전한 HTTPS/WSS·DNS·게스트 Wi-Fi 접근을 확인하지 못하면 현장 방송만 보류한다.

## §17 측정과 P2 완료 판정

### 측정 항목

| 범주 | 측정 |
|---|---|
| 연결 | 최초 setup/hello 시간, 실패율, 재접속 횟수·대기·복구 시간, close 확인 실패 |
| 입력 | 실제 샘플레이트, 송신 프레임 수, 큐 최대값, 버린 입력 ms |
| 자막 | 첫 partial·final 시간, revision 수, 중복 억제 수, interrupted·누락 가능 구간 |
| PCM | 최초 수신·예약 시각, 대기 p50/p95/최대, 3초 초과 시간, 버린 음성 ms |
| 기기 TTS | 최초 요청·start 이벤트、대기 시간、생략 문장数、失敗数 |
| 실청취 | 발화 기준 실제 첫 자막·첫소리 지연, 정확도·누락·첨가 |
| 기기 | 배터리 감소、발열、메모리 추이、장시간 정지·복귀 |
| 규모 | 동시 청중、언어별 청중、허브 CPU·메모리·LAN、AP 상태、오류율 |
| 한도 | 관측 호출·연결 시간·오류、관리자 콘솔 근거 |

측정은 단조 시계를 기본으로 한다. 서버 `ts`와 폰 시계를 동기화 확인 없이 빼서 네트워크 지연으로 표시하지 않는다. AudioContext 예약 시각·TTS start 이벤트를 물리적 첫소리로 표시하지 않는다.

키·방 코드·원문·번역문·원본 오디오를 기본 측정 결과에서 제외한다. 메모리 통계는 없는 브라우저에서 `미지원`으로 기록한다.

### 규모 파라미터

```text
N_max                 최대 동시 청중
L_active              실제 동시 방송 언어 수
T_service_minutes     전체 예배 길이
N_direct / N_hub       경로별 인원
N_by_language         언어별 인원
D_caption_p95_max     허용 자막 지연
D_audio_p95_max       허용 음성 지연
E_max / G_max         허용 실패율·누락 기준
```

수치는 미확정 상태로 유지한다. 10분 예비 시험 후 확정한 전체 길이와 최대 인원으로 시험한다.

완료는 자동 구현 검증, 실기기·실키 검증, PWA 지원 확인, 공용 Live 제한 검증, 허브 검증, 목표 규모 검증을 별도 판정한다. P1의 337개 통과는 회귀 기준이며 P2 출시 검증의 대체 자료가 아니다.

---

# 2. P2 과제 목록

모든 과제는 Node 24·외부 패키지 없음·네트워크 없는 `workspace-write` 실행을 전제로 한다. 나열한 파일만 수정하며, 테스트·문서도 파일 수에 포함한다. 보고서는 stdout으로 출력하고 오케스트레이터가 보관한다.

이식 파일 상단에는 원본 경로·심벌·이식일·실제 해시 또는 리비전·주요 변경을 기록한다. 해당 과제에서 `docs/reuse-map.md`도 갱신한다.

각 과제의 **공통 완료 확인 명령 G**는 다음 세 명령이다. 아래에서 `G`라고 표기한 경우 모두 실행한다.

```sh
node --test tests/*.test.mjs
node scripts/check-i18n.mjs
git diff --check
```

전체 테스트는 fail·todo·skip·취소 0을 기준으로 한다. 기존 337개를 삭제하거나 기대값을 약화해 통과시키지 않는다.

## P2-01 — 스트림 이벤트 계약과 회귀 고정

- **목적:** Live 이벤트가 라우터에서 유실되지 않도록 호환 가능한 확장을 정의한다.
- **만들 파일 5개:** `app/providers/contract.js`, `app/providers/router.js`, `tests/providers.test.mjs`, `tests/fixtures/providers.mjs`, `docs/architecture.md`.
- **의존 과제:** P1 완료.
- **완료 기준:** 기존 이벤트 필드 유지. `subtitle`에 구간 식별·순서·역할을 선택적으로 추가하고 `goAway {timeLeftMs}` 전달을 허용한다. IDs는 context 값이 우선한다. raw payload·임의 필드는 전달하지 않는다. 소비자 close 뒤 이벤트 없음과 원격 closed 최대 1회를 유지한다.
- **완료 확인 명령:** `node --test tests/providers.test.mjs`; G.
- **예상 함정:** 현재 라우터는 `goAway`, `segmentId`, `seq`를 버린다. 어댑터에서 emit만 추가해서는 동작하지 않는다.

## P2-02 — 자막 조립기 이식

- **목적:** 부분·확정·중단 자막을 제공자 독립 모듈로 만든다.
- **만들 파일 4개:** `app/engine/segment-assembler.js`, `tests/segment-assembler.test.mjs`, `tests/fixtures/segments.mjs`, `docs/reuse-map.md`.
- **의존 과제:** P2-01.
- **완료 기준:** 1.5초 flush, 길이 제한, 독립 역할 카운터, revision, cancel·interrupted, 가짜 시계 정리. 문장부호·소수점·혼합 언어·반복 발화를 시험한다.
- **완료 확인 명령:** `node --test tests/segment-assembler.test.mjs`; G.
- **예상 함정:** 원본의 무조건 문자열 추가·단순 마침표 분리·입출력 ID 공유·중단을 final로 flush하는 동작.

## P2-03 — Gemini 동시통역 단일 연결 어댑터

- **목적:** 모델별 setup과 PCM·전사 이벤트를 이식한다.
- **만들 파일 5개:** `app/providers/gemini/live.js`, `app/providers/gemini/live-config.js`, `tests/gemini-live.test.mjs`, `tests/fixtures/gemini-live.mjs`, `docs/reuse-map.md`.
- **의존 과제:** P2-01·02.
- **완료 기준:** 주입받은 기존 Live client 사용. 번역 전용 setup에 시스템 프롬프트 없음. flash-live setup 분리. `sendAudio/finishInput/close` 제공, 24kHz·PCM 길이·base64·수신 크기 검증. `finishInput`은 해당 프로토콜의 입력 종료 신호로 매핑하며 숨은 재접속 없음.
- **완료 확인 명령:** `node --test tests/gemini-live.test.mjs`; G.
- **예상 함정:** Node `Buffer`, Electron IPC, 임의 모델 순환, 원문 없는 응답의 원문 위장, 직접 모드에서도 오디오를 폐기하는 원본 동작.

## P2-04 — Live 전송 한도와 종료 오류 보강

- **목적:** 송신 밀림과 quota close를 안전하게 처리한다.
- **만들 파일 5개:** `app/providers/gemini/live-client.js`, `app/providers/gemini/errors.js`, `tests/live-client.test.mjs`, `tests/gemini-live-errors.test.mjs`, `tests/fixtures/live.mjs`.
- **의존 과제:** P2-03.
- **완료 기준:** 동시통역용 송신 버퍼 상한을 기존 voice 동작과 호환되게 적용한다. close reason은 인증 경계에서 제한적으로 분류 후 폐기한다. quota·429·503·모델 미지원·원격 close·사용자 abort를 구분한다.
- **완료 확인 명령:** `node --test tests/live-client.test.mjs tests/gemini-live-errors.test.mjs`; G.
- **예상 함정:** cleanup의 ABORTED가 원인 오류를 덮음, 모든 quota를 DAILY_LIMIT로 분류, 종료 확인 없이 슬롯 해제.

## P2-05 — Live 능력 등록과 공통 복구 정책

- **목적:** `live`를 ready로 등록하고 모든 추가 연결에 같은 예산을 적용한다.
- **만들 파일 6개:** `app/providers/gemini/index.js`, `app/config.js`, `app/engine/live-recovery.js`, `tests/provider-integration.test.mjs`, `tests/live-recovery.test.mjs`, `docs/architecture.md`.
- **의존 과제:** P2-03·04.
- **완료 기준:** `live: planned → ready`, 모델·출력 형식·폴백 선언. voice/live가 동일 Live client 공유. 복구 모듈은 기존 budget·지터·취소 도구를 사용하고 최초+3회, 60초 안정 초기화, goAway 포함 예산을 시험한다. 등록 상태와 연결 검사 상태를 분리한다.
- **완료 확인 명령:** `node --test tests/provider-integration.test.mjs tests/live-recovery.test.mjs`; G.
- **예상 함정:** 연결마다 예산 새로 생성, REST 폴백 resolver를 Live에 재사용, ready를 실키 검증 완료로 표시.

## P2-06 — 연속 마이크 캡처와 송신 프레임

- **목적:** PTT와 분리된 32ms 스트리밍 입력을 만든다.
- **만들 파일 5개:** `app/audio/stream-capture.js`, `app/audio/uplink-queue.js`, `tests/stream-capture.test.mjs`, `tests/uplink-queue.test.mjs`, `docs/reuse-map.md`.
- **의존 과제:** P2-04.
- **완료 기준:** 기존 worklet·resampler·PCM 변환 재사용. 실제 샘플레이트 변환, 512샘플 프레이밍, 8프레임 상한, 단일 송신 펌프, 레벨·입력 정지 감시, 취소 후 늦은 getUserMedia 결과 정리.
- **완료 확인 명령:** `node --test tests/stream-capture.test.mjs tests/uplink-queue.test.mjs`; G.
- **예상 함정:** AudioContext의 요청 sampleRate를 실제 값으로 가정, 30초 WAV 누적 재사용, 프레임 Promise 무한 적재, 타이머 지연 후 한꺼번에 송신.

## P2-07 — 연속 PCM 재생과 따라잡기

- **목적:** 설교 길이와 무관하게 제한된 메모리로 재생한다.
- **만들 파일 4개:** `app/audio/stream-player.js`, `tests/stream-player.test.mjs`, `tests/fixtures/stream-audio.mjs`, `docs/reuse-map.md`.
- **의존 과제:** P2-01.
- **완료 기준:** AudioContext 예약, 소스 수·8초 상한, 3초 지연 표시, turn 경계 복귀·2초 강제 경계, mute·interrupted·취소 정리. 예약 시각과 실제 첫소리를 구분한다.
- **완료 확인 명령:** `node --test tests/stream-player.test.mjs`; G.
- **예상 함정:** 기존 유한 PCM player의 120초 종료, PCM 청크를 문장 경계로 취급, suspended context에서 무한 누적.

## P2-08 — 동시통역 상태와 임시 자막 저장소

- **목적:** 직접·허브가 공유할 제한된 화면 상태를 만든다.
- **만들 파일 4개:** `app/engine/listen-state.js`, `app/engine/caption-store.js`, `tests/listen-state.test.mjs`, `tests/caption-store.test.mjs`.
- **의존 과제:** P2-02.
- **완료 기준:** 상태 전이 검증, 구간 upsert·revision·중복 final 억제, 역할·epoch 분리, 최근 100개 제한, 누락 원인 분리. 원격 seq는 직접 로컬 순서와 별도 보관한다.
- **완료 확인 명령:** `node --test tests/listen-state.test.mjs tests/caption-store.test.mjs`; G.
- **예상 함정:** 수정 자막을 새 행으로 추가, final의 partial 역행, 오디오 실패로 번역 상태 변경.

## P2-09 — 폰 마이크 동시통역 엔진 조립

- **목적:** 직접 청취의 시작부터 종료까지 연결한다.
- **만들 파일 3개:** `app/engine/sim.js`, `tests/sim.test.mjs`, `tests/fixtures/sim.mjs`.
- **의존 과제:** P2-05·06·07·08.
- **완료 기준:** 세션 관리자→라우터 경유, 캡처·송신·자막·PCM 연결. 재연결 중 입력 폐기, goAway 직렬 교체, fatal·중지·권한 지연 취소. 생성 PCM 외 추가 voice 호출 없음.
- **완료 확인 명령:** `node --test tests/sim.test.mjs`; G.
- **예상 함정:** ready 이벤트를 라우터 밖에서 기다림, 예전 generation의 오디오 반영, finishInput을 소켓 종료 확인으로 취급.

## P2-10 — 기존 허브 프로토콜 파서

- **목적:** 서버를 수정하지 않고 실제 청중 메시지를 해석한다.
- **만들 파일 4개:** `app/hub/protocol.js`, `tests/hub-protocol.test.mjs`, `tests/fixtures/hub.mjs`, `docs/reuse-map.md`.
- **의존 과제:** P2-08.
- **완료 기준:** hello·caption·status·stopped·settings·접근 거부 매핑, 정상 `status` 타입 호환. 방 코드·고정 WSS URL 검증, 크기·정수·언어·revision 검사. 예상 밖 settings와 raw detail 폐기.
- **완료 확인 명령:** `node --test tests/hub-protocol.test.mjs`; G.
- **예상 함정:** 존재하지 않는 PCM·구독·replay-end 프로토콜 가정, lang 필터 후 seq 누락 판정, 서버 source 명령 사용.

## P2-11 — 허브 WebSocket 클라이언트

- **목적:** 청중 접속·재접속·수신 큐를 구현한다.
- **만들 파일 3개:** `app/hub/client.js`, `tests/hub-client.test.mjs`, `tests/fixtures/hub-socket.mjs`.
- **의존 과제:** P2-05·10.
- **완료 기준:** `/ws?room=`만 사용, hello timeout, 순서 보존 Blob 처리, 수신 큐 상한, 이전 종료 확인 후 제한 재접속. 정상 방 종료는 재시도하지 않으며 API 키 조회·마이크·청중 송출 명령 0회.
- **완료 확인 명령:** `node --test tests/hub-client.test.mjs`; G.
- **예상 함정:** 침묵을 연결 단절로 판단, 없는 ping/pong 요구, hello 수신을 방송 성공으로 표시.

## P2-12 — 허브 자막용 기기 음성 큐

- **목적:** 새 확정 번역만 한 번씩 읽는다.
- **만들 파일 3개:** `app/audio/caption-speaker.js`, `tests/caption-speaker.test.mjs`, `tests/fixtures/speech.mjs`.
- **의존 과제:** P2-08.
- **완료 기준:** 기존 device-tts 주입, 1문장 직렬 재생, revision 중복 방지, 대기 20개·3초 경고·8초 건너뛰기, mute·언어 변경·실패 정리. 빈 음성 목록·조회 예외·지연된 voiceschanged·미발생 end 이벤트를 시험한다.
- **완료 확인 명령:** `node --test tests/caption-speaker.test.mjs`; G.
- **예상 함정:** speechSynthesis 내부 큐의 무한 적재, 이미 읽은 자막 수정본 자동 재독, 기기 TTS 실패로 허브 연결 종료.

## P2-13 — 허브 청취 엔진과 최근 자막 복구

- **목적:** 참가·자막 갱신·음성 재개·종료를 연결한다.
- **만들 파일 3개:** `app/engine/hub-listen.js`, `tests/hub-listen.test.mjs`, `docs/architecture.md`.
- **의존 과제:** P2-08·11·12.
- **완료 기준:** 최근 30개 수신·중복 억제, 재접속 음성 기본 OFF, 사용자 소리 켜기 이후 새 final만 재생. seq·ID 재사용, cast.stopped, 언어 제거, 상태 snapshot 부재 처리. 원문은 별도로 표시한다.
- **완료 확인 명령:** `node --test tests/hub-listen.test.mjs`; G.
- **예상 함정:** 30개를 언어당 30개로 해석, 정확한 replay 경계 주장, 재접속 후 오래된 설교 자동 낭독.

## P2-14 — P2 문구와 오류 키

- **목적:** 후속 UI·진단에서 사용할 세 언어 문구를 먼저 확정한다.
- **만들 파일 5개:** `app/i18n/ko.json`, `app/i18n/en.json`, `app/i18n/ja.json`, `app/ui/errors.js`, `tests/i18n.test.mjs`.
- **의존 과제:** P2-09·13.
- **완료 기준:** 상태·누락·지연·허브·기기 음성·개인 키·진단 키 동시 추가. `UNKNOWN_429`처럼 숫자 포함 오류코드 매핑을 시험한다. 공급자 원문을 보간하지 않는다.
- **완료 확인 명령:** `node --test tests/i18n.test.mjs`; G.
- **예상 함정:** `/^[A-Z_]+$/` 재도입, 세 언어 키 수만 맞고 실제 사용 키 누락, “연결됨”을 “통역 성공”으로 번역.

## P2-15 — 앱 작업 소유권과 세션 전환

- **목적:** 순차·동시·허브·진단이 공존할 때 단일 작업 규칙을 적용한다.
- **만들 파일 5개:** `app/engine/activity.js`, `app/engine/session-manager.js`, `tests/activity.test.mjs`, `tests/session-manager.test.mjs`, `docs/architecture.md`.
- **의존 과제:** P2-09·13.
- **완료 기준:** 직렬 전환·동시 시작 경쟁·정리 실패 차단. 원격 closed/ABORTED 구분 유지. 허브 TTS도 앱 작업 점유에 포함하고 제공자 Live 슬롯과 구분한다.
- **완료 확인 명령:** `node --test tests/activity.test.mjs tests/session-manager.test.mjs`; G.
- **예상 함정:** 두 번째 세션 관리자 생성으로 규칙을 우회하려 함, 취소를 먼저 기다려 늦은 이벤트 허용, 테스트 종료 실패 슬롯을 다른 사례에 누출.

## P2-16 — 동시통역 화면 컴포넌트

- **목적:** 직접·현장 방송 화면을 기존 토큰으로 구현한다.
- **만들 파일 3개:** `app/ui/sim-view.js`, `styles.css`, `tests/sim-view.test.mjs`.
- **의존 과제:** P2-08·14.
- **완료 기준:** 엔진 주입형 UI, 상태·언어·방 코드·소리·자막·최신 이동·누락 표시. textContent 렌더링, 제한된 DOM, 부분 자막의 과도한 aria-live 방지. 화면 생성 시 외부 작업 없음.
- **완료 확인 명령:** `node --test tests/sim-view.test.mjs`; G.
- **예상 함정:** UI에 endpoint·키 처리 삽입, 원문 자동 채움, 100개 제한 뒤 스크롤 위치 불안정.

## P2-17 — 셸 활성화와 앱 수명주기 연결

- **목적:** 실제 동시통역 탭을 열고 모든 종료 경로를 연결한다.
- **만들 파일 6개:** `app/main.js`, `app/ui/shell.js`, `app/engine/seq.js`, `app/state.js`, `tests/app-lifecycle.test.mjs`, `tests/ui-format.test.mjs`.
- **의존 과제:** P2-09·13·15·16.
- **완료 기준:** aria-disabled 제거, sim-view 마운트, 비동기 탭 전환·키 변경·pagehide·visibility 정리. 기존 seq·진단 busy 조건과 PWA busy/reload 조건에 청취 작업 포함. 늦은 설정 변경 결과 폐기.
- **완료 확인 명령:** `node --test tests/app-lifecycle.test.mjs tests/ui-format.test.mjs`; G.
- **예상 함정:** 순차 activeTurnId만 보고 업데이트 적용, 허브에서도 개인 키를 필수 요구, tab 선택 함수의 기존 동기 계약을 무심코 변경.

## P2-18 — 동시통역 진단과 관측 지표

- **목적:** 연결 검사와 실제 운영 측정을 분리해 제공한다.
- **만들 파일 6개:** `app/engine/diagnostics.js`, `app/engine/listen-metrics.js`, `app/ui/diagnostics-view.js`, `app/ui/settings-view.js`, `tests/diagnostics.test.mjs`, `tests/listen-metrics.test.mjs`.
- **의존 과제:** P2-14·17.
- **완료 기준:** 사용자 시작의 짧은 Live 검사, 공통 작업 소유권 사용, 모델·키 출처별 결과 무효화. 허브 상태와 Gemini Live 진단 분리. 단조 시계·집계 상한·비밀 없는 결과. 음성 목록 예외로 첫 로드가 실패하지 않는다.
- **완료 확인 명령:** `node --test tests/diagnostics.test.mjs tests/listen-metrics.test.mjs`; G.
- **예상 함정:** voice 진단 성공을 live 성공으로 복사, 예약 시간을 실측 첫소리로 보고, 남은 프로젝트 한도를 추정해 표시.

## P2-19 — Safari 첫 로드와 사전 로딩 방어

- **목적:** 미확인 JSON 모듈 import를 필수 부팅 경로에서 제거한다.
- **만들 파일 4개:** `app/main.js`, `app/i18n/index.js`, `app/i18n/boot-fallback.js`, `tests/app-lifecycle.test.mjs`.
- **의존 과제:** P2-17.
- **완료 기준:** 정적 JSON import assertion/attribute 의존 제거. 기존 세 언어 JSON은 명시적 로더로 읽는다. 작은 영어 부팅 실패 문구만 일반 JS 모듈로 제공하고 사전 키와 일치 검증. fetch 실패·시간 초과·취소·오프라인 첫 로드 처리.
- **완료 확인 명령:** `node --test tests/app-lifecycle.test.mjs tests/i18n.test.mjs`; G.
- **예상 함정:** 모듈 파싱 실패는 try/catch 부팅 안내로 잡히지 않음, fallback 사전 전체 복제로 번역 불일치, 기존 SW 경로 손상.

## P2-20 — 허브 등록·CSP·릴리스 검증

- **목적:** 신뢰한 현장 주소만 허용하고 P2 모듈을 안전하게 배포한다.
- **만들 파일 6개:** `app/hub/config.js`, `app/config.js`, `_headers`, `scripts/stage-release.mjs`, `tests/release.test.mjs`, `docs/release-checklist.md`.
- **의존 과제:** P2-10·17·19.
- **완료 기준:** 허브 목록 미입력 시 빈 목록·UI 미노출. 등록 endpoint에서 CSP origin 도출, 기존 check-release와 일치. 새 스트림 worklet 참조·JS 모듈이 버전 경로와 SW 목록에 포함됨을 시험한다.
- **완료 확인 명령:** G 및 아래 명령. `OUT`은 오케스트레이터가 지정한 워크스페이스 내부의 새 디렉터리다.

  ```sh
  node scripts/stage-release.mjs --id p2-check --out "$OUT"
  node scripts/check-release.mjs "$OUT"
  ```

- **예상 함정:** 현재 `app/**/*.js`와 `app/i18n/*.json` 허용 규칙이면 새 파일 종류는 필요 없다. 허브 설정을 별도 JSON으로 만들면 허용 목록 확장이 필요하므로 이 과제는 JS 설정을 사용한다. 현재 기록된 GitHub Pages는 `_headers`를 적용하지 않으므로 로컬 검사 성공을 배포 CSP 성공으로 선언하지 않는다.

## P2-21 — P1·P2 통합 및 개인정보 회귀

- **목적:** 실제 구성 경계에서 주요 실패 조합을 재현한다.
- **만들 파일 4개:** `tests/p2-integration.test.mjs`, `tests/privacy.test.mjs`, `tests/fixtures/p2-scenarios.mjs`, `docs/p2-review.md`.
- **의존 과제:** P2-18·19·20.
- **완료 기준:** 순차→직접→허브→순차, goAway·429·503·단절·미확정 종료·음성 overflow·키 삭제·업데이트 경쟁 시험. 소켓 최대 1, 취소 후 재생 0, 중복 낭독 0. URL·로그·저장소·오류·DOM에 테스트 비밀 없음.
- **완료 확인 명령:** G.
- **예상 함정:** 모듈별 fake 성공만 검사, 실제 조합에서 busy 콜백 누락, 모의 통과를 실기기 검증으로 기록.

## P2-22 — 규모 시험 도구와 운영 문서

- **목적:** 목표 수치를 하드코딩하지 않은 오프라인 시험·현장 기록 틀을 만든다.
- **만들 파일 5개:** `scripts/p2-load.mjs`, `tests/p2-load.test.mjs`, `docs/p2-capacity.md`, `docs/venue-runbook.md`, `docs/device-matrix.md`.
- **의존 과제:** P2-21.
- **완료 기준:** 모의 다수 청중·다언어 partial/final·느린 소비자·재접속 replay를 생성하고 큐 상한·중복·메모리 객체 수를 검사한다. N/L/T 필수 파라미터 검증. 현 서버의 3언어·150분·송신 큐 제약과 실제 시험 절차 기록.
- **완료 확인 명령:** G 및 다음 명령. 숫자는 테스트용 작은 사례이며 목표 규모가 아니다.

  ```sh
  node scripts/p2-load.mjs --mode mock --listeners 4 --languages 2 --duration-seconds 10
  ```

- **예상 함정:** 가짜 다중 청중을 실제 AP·허브 부하 시험으로 간주, 오프라인 기본 명령에서 실서버 접속, 방 코드·키를 명령 인자로 요구.

## P2-23 — 실기기·실키 기능 시험 기록

- **목적:** 직접 Live·허브·브라우저/PWA의 지원 조합을 판정한다.
- **만들 파일 3개:** `docs/p2-device-results.md`, `docs/device-matrix.md`, `docs/release-checklist.md`.
- **의존 과제:** P2-22.
- **완료 기준:** **오케스트레이터/오너 입력 필요.** Android Chrome·iPhone Safari·설치 PWA에서 10분 예비 시험, 6방향 발화, 기본·폴백 모델, 이어폰·권한·소리 켜기·중지·복귀·첫 로드·업데이트를 확인한다. 허브 최근 30개·기기 TTS·중복·접근 거부도 확인한다. 공용 직접 Live는 실제 모델별 내부/외부·회선 이동·폐기를 별도 시험한다.
- **완료 확인 명령:** G. 수동 완료 확인은 기기·OS·브라우저·릴리스·모델·표본 수·결과가 기록된 증거표다.
- **예상 함정:** P1 REST/voice 검증을 P2 live로 확대, Safari 수정 후 모의 테스트만으로 지원 선언, 실키를 exec 인자·fixture에 넣음.

자료가 없으면 해당 행은 `미검증 — 입력 대기`다. 한 번의 오프라인 exec는 전달된 증거를 정리하며 실제 네트워크·기기 시험을 실행했다고 기록하지 않는다.

## P2-24 — 목표 규모·전체 예배 시험과 운영 판정

- **목적:** 확정한 규모에서 운영 가능한 범위를 결정한다.
- **만들 파일 4개:** `docs/p2-capacity-results.md`, `docs/p2-capacity.md`, `docs/venue-runbook.md`, `docs/release-checklist.md`.
- **의존 과제:** P2-23.
- **완료 기준:** **오케스트레이터/오너 입력 필요.** N/L/T·경로별 인원·합격선 확정 후 최대 인원·전체 길이 시험. 좌석·AP·배터리·발열·메모리·누적 지연·허브 느린 수신자·quota·단절·방송 종료를 확인한다. 검증한 조건만 정원·지원 언어·운영 길이로 공개한다.
- **완료 확인 명령:** G. 수동 완료 확인은 확정 파라미터와 실측표·장애 조치·운영 가능 범위의 대응이다.
- **예상 함정:** 10분 예비 시험을 전체 길이 시험으로 대체, 목표 150분 초과를 서버 자동 종료와 무관하게 합격, 실패 시 청중 전체를 공용 Live로 자동 전환.

증거가 없거나 목표 수치가 미확정이면 규모 합격은 보류한다. 구현 검증과 개인 직접 모드 검증은 별도로 진행할 수 있다.

---

# 3. 오너 결정·입력이 필요한 항목

| 필요한 입력·결정 | 추천안 |
|---|---|
| 최대 동시 인원 `N_max`, 언어별 인원, 동시 언어 `L_active`, 전체 길이 `T_service_minutes` | 개인 직접·허브 인원을 나눠 확정. 현재 허브의 최대 3언어·150분 자동 종료와 대조 |
| 자막·음성 지연, 실패율·누락의 운영 합격선 | 10분 예비 시험의 p50·p95·최대·정확도를 보고 전체 시험 전에 확정 |
| 실제 허브 WSS 주소·DNS·인증서·행사장 접근 조건·서버 리비전 | 기존 안전한 인프라의 고정 주소를 코드 등록. 확보 전 허브 목록은 비워 둠 |
| 현재 허브 제약을 넘는 행사 운영 방식 | 서버 수정 없는 P2에서는 운영 구간 분리·명시적 재참가 또는 해당 규모 보류. 무중단 지원으로 표시하지 않음 |
| 시험 기기·이어폰·좌석·행사장 회선·개인 키·공용 프로젝트 검사 접근 | 오너가 브라우저에서 직접 키 입력. 명령 인자·보고서·fixture에는 키를 전달하지 않음 |
| 기본·flash-live 후보의 실제 지원·음성 설정 검사 결과 | 기본과 각 후보를 독립 검사하고, 실패한 경로는 사용 가능 표시에서 제외 |
| 목표 규모 시험의 청중·기기·시간·허브/AP 관측 자료 | 10분 예비 시험 후 최대 인원·전체 예배 길이 시험 예약 |
| 허브를 포함한 배포에서 실제 CSP 헤더를 적용할 호스트 | 기존 설계의 Cloudflare Pages 등 헤더 적용 가능한 정적 호스트 권장. 현재 GitHub Pages의 `_headers` 미적용 상태와 구분 |
| 공개 대상·지역·개인/공용/허브 운영에 적용되는 이용 조건 확인 자료 | 확인일·근거·허용 범위를 남기고 그 범위에서만 공개 지원 선언 |

맥 허브 사용 허용, 개인 키 기본, 유료 자동 전환 금지, 웹/PWA 범위는 이미 확정된 결정이므로 다시 승인받지 않는다.