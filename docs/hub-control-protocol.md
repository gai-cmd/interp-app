# 허브 실시간 통제 프로토콜

현장 허브(WSS)가 청중 앱에 보내는 **통제 확장**의 서버 규약과 앱 파서의 계약을 기록한다. 기준은
[design-p3.md](design-p3.md) §1.8과 [architecture.md](architecture.md) "허브 통제"다. 허브 서버 수정은 P3 범위
밖이므로 이 문서는 서버가 따를 규약이자 앱 fixture의 근거다. 여러 과제(P3-09·10)가 이 문서를 나눠 쓰므로
과제 ID 절을 추가하고 기존 절은 덮어쓰지 않는다.

## P3-09 허브 통제 메시지 파서 (`app/hub/protocol.js`)

### 범위와 신뢰 경계

- 파서는 **수신 텍스트 한 건을 정규화**할 뿐이다. 시계·상태·순서(epoch/revision)·TTL 계산·중지 latch는
  P3-10(`app/hub/control.js`)이 맡고, 소켓 재사용·행사 참가는 P3-11이 맡는다.
- 신뢰 대상은 코드 등록 허브(`REGISTERED_HUBS`) 중 사이트 정책 `hubControl.allowedHubIds`가 허용한 허브뿐이다.
  임의 WebSocket, QR, `window.postMessage`로 받은 제어는 파서에 넣지 않는다.
- 허브는 **제한만 추가**한다. 통제 메시지에는 API 키·endpoint·모델·가격표·개인 설정·방 코드가 들어갈 자리가 없고,
  허용 목록 밖의 키가 하나라도 있으면 메시지 전체를 거부한다.
- 기존 청취 메시지(`hello`·`settings`·`cast.caption`·`cast.status`·`status`·`cast.stopped`·`closed`·`outside`·`denied`)의
  의미와 상한(1MiB, 자막 16,000자)은 P2-10 그대로다. 특히 `settings`(방 언어 설정) 봉투는 **통제 권한을 갖지 않는다**.
  거기에 `stopped`·`disabledFeatures`·`control` 같은 필드를 실어도 언어 목록 외에는 버린다.

### 협상 (`hello`)

1. 앱이 소켓을 연 뒤 `buildHello(session, control)`로 만든 텍스트를 보낸다. `control`은 앱이 참가한 행사에서
   가져온 값이며 허브·QR·설정에서 받지 않는다. 행사에 참가하지 않았으면 `control` 없이 기존 형식 그대로 보낸다.

   ```json
   { "type": "hello", "sessionId": "existing-session", "settings": {},
     "control": { "version": 1, "eventId": "service-20260906", "epoch": "broadcast-epoch", "revision": 12 } }
   ```

   `revision`은 앱이 마지막으로 적용한 snapshot의 revision이고, 없으면 0이다. 서버는 이 값과 무관하게 전체
   snapshot을 보낸다.
2. 서버는 기존처럼 `hello`(`sessionId`·`settings` 필수)로 응답하되, 확장을 지원하면 같은 형식의 `control`을 붙인다.
   `eventId`·`epoch`는 서버가 이 연결에 대해 수락한 값이다(일치 검사는 P3-10).
3. 기존 서버는 앱의 `hello`를 무시하고 `control` 없는 `hello`를 보낸다. 앱은 이를 **"실시간 관리 미지원"**
   (`hubControl.unsupported`)으로 표시하고 청취는 계속한다.
4. 협상 직후 서버는 현재 통제 상태의 전체 snapshot(`policy.control`)을 보내고, 이후 변경 시마다·TTL 안에 반복해서
   전체 snapshot을 보낸다(heartbeat 겸용). 부분 갱신 메시지는 없다.

파서의 `hello` 결과는 `{ type: 'hello', sessionId, settings: { allowedLangs, defaultLang }, control }`이다.

| 서버 `hello.control` | 파서 결과 `control` | 의미 |
|---|---|---|
| 없음 또는 `null` | `null` | 확장 미지원 허브. 청취 가능, 통제 없음 |
| `version`이 1이 아닌 정수 | `null` | 협상 실패(다른 버전). 미지원과 같이 취급 |
| `version: 1`이고 필드가 정확함 | `{ version: 1, eventId, epoch, revision }` | 협상 성공 |
| `version: 1`인데 필드가 틀리거나 추가 키가 있음, 또는 객체가 아님 | 예외 `INVALID_RESULT` | 잘못된 서버. 연결 종료 대상 |

### 전체 snapshot (`policy.control`)

```json
{
  "type": "policy.control",
  "version": 1,
  "eventId": "service-20260906",
  "epoch": "broadcast-epoch",
  "revision": 13,
  "issuedAt": "2026-09-06T01:00:00Z",
  "ttlSeconds": 60,
  "scope": "event",
  "stopped": true,
  "disabledFeatures": ["simultaneousDirect"],
  "notice": {
    "id": "pause-13",
    "severity": "warning",
    "text": { "ko": "잠시 통역을 중지합니다.", "en": "Interpretation is temporarily paused.", "ja": "通訳を一時停止します。" }
  }
}
```

모든 필드가 필수이며 `notice`만 `null`을 허용한다. 파서 결과는 `type: 'control'`로 바뀌고 나머지 필드는 같은
이름으로 복사된 깊이 동결 객체다. 해제도 **더 높은 revision의 전체 snapshot**(`stopped: false`, 빈
`disabledFeatures`, `notice: null` 등)으로 보낸다.

| 필드 | 규칙 |
|---|---|
| 전체 | UTF-8 **16,384바이트 이하**(`HUB_LIMITS.controlBytes`). 문자 수가 아니라 바이트 수. 초과 시 거부 |
| `version` | 정수 `1`만 |
| `eventId` | `^[a-z0-9-]{1,64}$`. 정책 `sharedEvents[].id`와 같은 형식 |
| `epoch` | `^[A-Za-z0-9._:-]{1,64}$`. 방송 세대 식별자. 새 epoch는 새 `hello` 뒤에만 수락(P3-10) |
| `revision` | 1 이상의 안전 정수. 같은 epoch 안에서 증가. 중복·역순 무시(P3-10) |
| `issuedAt` | `YYYY-MM-DDTHH:mm:ss(.SSS)Z` UTC만. 표시용이며 지연·TTL 계산에 쓰지 않는다 |
| `ttlSeconds` | 정수 **10~120**(양끝 포함). TTL은 수신 후 앱의 단조 시계로 계산(P3-10) |
| `scope` | `"event"`만 |
| `stopped` | boolean |
| `disabledFeatures` | `REGISTERED_FEATURES`(`sequential`·`simultaneousDirect`·`hubListen`·`diagnostics`·`sharedKeys`·`rememberPersonalKey`)의 부분집합. 중복·미등록 이름 거부. 기능을 켜는 방향은 없다 |
| `notice` | `null` 또는 `{ id, severity, text }`. `id`는 `eventId`와 같은 형식, `severity`는 `info`·`warning`·`critical`, `text`는 `{ ko, en, ja }` 세 언어 모두 필수·공백 아님·언어당 1,000자(코드포인트)·제어 문자(탭·줄바꿈 제외)와 태그 모양(`<x`, `</x`) 금지. 다른 언어 키·추가 키 거부 |
| 그 외 키 | 전부 거부(`__proto__`·`constructor` 포함). 허브는 키·endpoint·모델·가격표·설정을 바꾸지 못한다 |

### 파서 계약

- `parseHubMessage(raw)`: 문자열만 받는다. 알 수 없는 `type`은 `null`, 알려진 봉투의 형식 오류는
  `ProviderError('INVALID_RESULT')`(원문·값 없이 코드만). `policy.control`과 유사한 이름(`policy`, `control`,
  `policy.control.v2` 등)은 알 수 없는 봉투다.
- `buildHello(session, control)`: 송신 텍스트를 돌려준다. `session`은 식별자 문자열 또는 `{ sessionId }`(생략 가능),
  `control`은 `{ eventId, epoch, revision? }`(생략하면 기존 형식 `hello`). 잘못된 입력은 `INVALID_REQUEST`.
  `createHubProtocol()`이 돌려주는 객체에도 같은 함수가 `buildHello`로 붙는다.
- 상수: `HUB_LIMITS.controlBytes = 16384`, `ttlMinSeconds = 10`, `ttlMaxSeconds = 120`, `HUB_CONTROL_VERSION = 1`,
  `HUB_CONTROL_SCOPES = ['event']`. 기능 목록·공지 중요도·본문 길이는 `app/policy/schema.js`의
  `REGISTERED_FEATURES`·`NOTICE_SEVERITIES`·`POLICY_LIMITS.textChars`를 그대로 쓴다(사이트 정책과 같은 규칙).
- 파서는 시계·저장소·네트워크에 접근하지 않고 상태를 남기지 않는다. 같은 텍스트는 항상 같은 결과다.

### 서버 구현 점검 목록

- [ ] 청중 소켓에서 앱의 `hello`를 읽고 `control.version === 1`이면 자신의 `hello`에 `control`을 붙인다.
- [ ] 협상 직후와 변경 시, 그리고 `ttlSeconds`보다 짧은 주기로 `policy.control` 전체 snapshot을 보낸다.
- [ ] revision은 epoch 안에서 단조 증가, 해제도 새 revision으로 보낸다. 방송 재시작은 새 epoch다.
- [ ] 메시지는 16KiB 이하, 공지 본문은 언어당 1,000자 이하, 세 언어 모두 채운다.
- [ ] 통제 메시지에 키·endpoint·모델·가격·설정·방 코드를 넣지 않는다. 사이트 정책이 금지한 기능을 허브가 다시 켜지 못한다.
- [ ] 기존 `cast.*`·`closed`·`denied` 메시지와 `settings` 갱신은 그대로 보낸다.

### fixture와 검증

`tests/fixtures/hub.mjs`의 `control()`·`controlHello()`·`snapshot()`·`releaseSnapshot()`·`notice()`·`noticeText()`·
`padded()`는 §1.8 예시를 그대로 옮긴 합성 값이며 실제 허브 주소·방 코드·키를 포함하지 않는다.
`node --test tests/hub-protocol.test.mjs`가 협상 구분·snapshot 정규화·16KiB 경계·TTL 경계·필드 제한·`settings` 봉투의
권한 불부여를 검증한다. 실제 허브 서버는 아직 확장을 구현하지 않았으므로 [p3-verification.md](p3-verification.md)
V29의 협상·중지·해제·heartbeat 상실 표시는 **fixture 검증까지만** 완료다.
