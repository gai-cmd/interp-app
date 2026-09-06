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

## P3-10 통제 상태와 재접속 (`app/hub/control.js`)

### 책임 경계

- P3-09 파서는 **텍스트 한 건**을 정규화하고, 이 모듈은 그 정규화된 snapshot이 **무엇을 바꿔도 되는지**를 정한다.
  소켓·행사 참가·재접속 시도는 P3-11(`app/hub/client.js`, `app/main.js`)이 맡는다.
- 이 모듈은 네트워크·저장소·DOM에 접근하지 않는다. 주입받는 것은 `now`·`setTimeout`·`clearTimeout` 셋뿐이고,
  시각은 **앱의 단조 시계**(`performance.now()`)를 쓴다. 허브가 보낸 `issuedAt`은 표시·기록용이며 만료 계산에 쓰지 않는다
  (기기 시계가 틀려도 중지가 조기 해제되면 안 된다).
- 이 상태는 **제한만 만든다**. 사이트 정책과의 교집합은 `app/policy/resolve.js`가 계산한다
  (`코드 지원 ∩ 사이트 정책 ∩ 행사 ∩ 허브 통제`). 허브는 사이트 정책이 끈 기능을 다시 켤 수 없다.

계약(architecture.md "허브 통제"):

```
createHubControl({ now, setTimeout, clearTimeout })
  -> { negotiate(control|null), receive(controlEvent), disconnected(), reset(), snapshot(), subscribe(fn), close() }
snapshot() -> frozen { supported, eventId, epoch, revision, stopped, disabledFeatures, notice, heartbeatLost, expiresAt }
```

`supported`는 hello 전에는 `null`, 확장 없는 허브에는 `false`다. `expiresAt`은 `now()` 눈금이거나 `null`이다.

### 순서 규칙 (epoch × revision)

| 들어온 것 | 판정 | 이유 |
|---|---|---|
| 협상 전 snapshot | 거부 | 신뢰 근거가 없다 |
| 다른 `eventId`·`epoch` | 무시 | 다른 방송의 통제다 |
| `revision <` 현재 | 무시 | **역순 도착이 해제로 둔갑하지 않는다** |
| `revision ==` 현재 | 상태 불변 + TTL 재무장 | 중복 = heartbeat |
| `revision >` 현재 | 적용 | 유일한 상태 변경 경로 |
| 새 epoch의 첫 snapshot | revision 무관하게 적용 | 방송 재시작은 번호가 1부터다 |

`negotiate()`가 같은 행사·같은 epoch를 답하면 revision 순서를 **이어간다**(재접속). epoch나 행사가 바뀌면
revision을 `null`로 되돌려 다음 snapshot을 무조건 받는다. `receive()`는 상태를 바꿨을 때만 `true`를 낸다
(heartbeat는 `false`).

### TTL과 중지 latch

- TTL은 **수신 시각부터** `ttlSeconds`(10~120초) 동안이며, 협상 직후에는 첫 snapshot을 기다리느라 최대치(120초)를 준다.
- 만료와 `disconnected()`는 `heartbeatLost = true`만 만든다. **`stopped`·`disabledFeatures`·`notice`는 건드리지 않는다.**
  `resolve.js`가 `heartbeatLost`를 `HUB_CONTROL_LOST` 차단으로 바꾸므로, 통제를 확인할 수 없는 동안은 시작이 막힌다.
- 중지 latch를 푸는 것은 **더 높은 revision의 새 snapshot**과 `reset()`(행사에서 나감) 둘뿐이다.
  단절·TTL 만료·확장 없는 허브로의 재접속·epoch 교체·`close()` 중 어느 것도 해제가 아니다.
- `close()` 이후에는 모든 호출이 무시되고 타이머가 해제된다. 마지막 상태는 그대로 남는다.

### 예상 함정과 대응

| 함정 | 대응 |
|---|---|
| 단절·TTL 만료가 긴급 중지를 해제 | 해제 경로를 `revision >` 와 `reset()` 둘로 한정, 해당 회귀 테스트 4건 |
| 허브 시계를 믿어 조기 해제 | `issuedAt` 미사용, 앱 단조 시계만 사용 |
| 재접속이 revision을 0으로 되돌림 | `negotiate()`가 같은 epoch면 revision 유지, client.js가 마지막 epoch·revision을 hello에 실음 |
| 확장 없는 허브로 재접속해 통제 소멸 | `supported=false`로 표시하되 latch 유지, 이후 snapshot 전부 거부 |
| 허브가 사이트 정책보다 넓은 권한 부여 | 이 모듈은 제한만 표현, 교집합은 `resolve.js`, 회귀 테스트가 `open`/`released` 기능 집합 동일성을 단언 |

### fixture와 검증

`tests/fixtures/hub-control.mjs`는 `tests/fixtures/hub.mjs`의 §1.8 예시 봉투를 **파서 출력 형태**(`type: 'control'`)로
바꾸고 결정적 시계(`createClock`)를 얹은 것이다. 실제 허브 주소·방 코드·키·QR payload는 없다.
`node --test tests/hub-control.test.mjs`가 생성·협상·순서(역순·중복·새 epoch)·TTL·단절·재협상·확장 없는 허브·
`reset`/`close`/구독 해제·구독자 예외 격리·사이트 정책 교집합을 검증한다(9건).
`app/hub/client.js`는 이 모듈을 **재수출**하므로 `app/main.js`의 import 경로는 그대로다.
V29(실제 허브 왕복)는 서버가 확장을 구현할 때까지 여전히 fixture 검증까지만 완료다.
