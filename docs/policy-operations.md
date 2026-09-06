# 정책 운영 문서

사이트 정책(`policy.json`)의 조회·갱신·만료 규칙과 발행 절차를 기록한다. 기준은
[design-p3.md](design-p3.md) §1.3·§1.5와 [architecture.md](architecture.md) "정책 모듈"이다.
여러 과제(P3-06·33·39)가 이 문서를 나눠 쓰므로 과제 ID 절을 추가하고 기존 절은 덮어쓰지 않는다.

## P3-06 정책 로더·갱신·만료 (`app/policy/client.js`)

### 조회 위치

앱은 문서의 배포 루트에 있는 `policy.json` 하나만 요청한다. 배포 루트는
`location.pathname`의 마지막 `/`까지다.

| 문서 위치 | 정책 URL |
|---|---|
| `https://gai-cmd.github.io/interp-app/` | `https://gai-cmd.github.io/interp-app/policy.json` |
| `https://gai-cmd.github.io/interp-app/index.html?x#y` | 같음 |
| `http://localhost:8080/interp-app/` | `http://localhost:8080/interp-app/policy.json` |
| `file:` · `about:blank` 등 | 없음. 모든 조회가 `POLICY_FETCH_ORIGIN`으로 실패 |

모듈 자신의 URL(`releases/<id>/app/policy/client.js`)은 기준으로 쓰지 않는다. 관리자 페이지
(`/interp-app/admin/`)는 이 클라이언트를 만들지 않는다.

### 요청 규칙

- `GET`, `mode: 'same-origin'`, `credentials: 'omit'`, `redirect: 'error'`, `cache: 'no-store'`, `Accept: application/json`.
- 응답 검사 순서: `redirected`·`opaqueredirect` → 응답 유형이 같은 origin이 아님(`cors`·`opaque`·`error`) →
  최종 URL의 origin 불일치 → 최종 URL의 경로 불일치 → HTTP 상태가 200이 아님.
- 본문은 스트림으로 읽으며 64KiB(65,536바이트)를 넘는 순간 읽기를 중단한다. `Content-Length`가 더 크다고
  선언되면 읽기 전에 거부하지만, 작다고 선언돼도 실제 바이트 수로 판정한다.
- 제한 시간은 요청 시작부터 본문 읽기 완료까지 5초다. 초과하면 요청을 abort하고 `POLICY_FETCH_TIMEOUT`으로 기록한다.
- 본문은 UTF-8(엄격)로 해석한 뒤 `validatePolicy`로 검증하고, 통과한 정책 객체만 한 번에 교체한다.
- 정책 본문·URL은 스냅샷·오류·로그에 남기지 않는다. 오류는 코드 문자열 하나다.

### 상태와 스냅샷

`snapshot()`은 `{ status, policy, revision, fetchedAt, error }`다. 상태는 호출 시각 기준으로 계산한다.

| status | policy | 뜻 | 런타임 게이트(P3-07) |
|---|---|---|---|
| `loading` | null | 첫 조회가 끝나기 전 | `POLICY_LOADING` |
| `ready` | 검증된 정책 | 마지막 검증 성공 후 5분 이내, 유효기간 이내 | 허용 |
| `stale` | 마지막 정책 | 5분 이내이지만 최근 조회가 실패 | 허용(마지막 정책 유지) |
| `failed` | null | 첫 조회 실패, 또는 마지막 검증 성공 후 5분 초과 | `POLICY_UNAVAILABLE` |
| `expired` | 마지막 정책 | `validUntil` 경과(정책은 유지해 차단 이유를 표시) | `POLICY_EXPIRED` |

- `revision`은 마지막으로 수락한 revision이며 `failed`가 돼도 배너 표시를 위해 남는다.
- 5분은 마지막 검증 성공 시각(`fetchedAt`) 기준이다. 조회 실패 여부와 무관하게 5분이 지나면 권한이 아니다.
  백그라운드에서 타이머가 멈춘 채 돌아온 경우에도 같다. 조회 오류 없이 나이만 넘긴 경우 `error`는 `POLICY_STALE`이다.
- 나이 초과와 `validUntil` 경과가 겹치면 나이 초과(`failed`)가 우선한다. 검증되지 않은 정책의 만료 사유는 신뢰하지 않는다.
- `subscribe(fn)`은 스냅샷이 바뀔 때만 호출한다. 재검증으로 `fetchedAt`만 바뀐 경우도 호출하되, 내용이 같으면
  `policy` 객체 참조를 유지하므로 구독자는 `prev.policy === next.policy`로 재계산을 생략할 수 있다.
  5분 경과·`validUntil` 도달은 타이머로 통지한다(`stop()` 뒤에는 타이머가 없으므로 `snapshot()`으로만 보인다).

### 오류 코드

| error | 원인 |
|---|---|
| `POLICY_FETCH_ORIGIN` | http(s) 위치가 아님, 응답 유형이 같은 origin이 아님, 최종 URL origin 불일치 |
| `POLICY_FETCH_REDIRECT` | 리다이렉트됨, 또는 최종 URL 경로가 고정 경로와 다름 |
| `POLICY_FETCH_STATUS` | HTTP 상태가 200이 아님 |
| `POLICY_FETCH_TIMEOUT` | 5초 초과 |
| `POLICY_FETCH_NETWORK` | fetch 예외, 응답 객체 아님, 스트림 오류, fetch 없음 |
| `POLICY_TOO_LARGE` | 본문 64KiB 초과 |
| `POLICY_INVALID` | UTF-8 해석 실패 |
| `POLICY_SCHEMA` 등 `POLICY_ISSUE_CODES` | `validatePolicy`의 첫 번째 이슈 코드(`POLICY_SCHEMA`, `POLICY_FIELD`, `POLICY_RANGE`, `POLICY_TEXT`, `POLICY_REFERENCE`, `POLICY_CONFLICT`, `POLICY_UNKNOWN_KEY`) |
| `POLICY_REVISION_CONFLICT` | 같은 revision인데 내용이 다름 |
| `POLICY_REVISION_ROLLBACK` | 수락한 revision보다 낮음 |
| `POLICY_STALE` | 조회 오류 없이 마지막 검증 후 5분 초과 |

이 코드들은 사전 키가 아니다. 화면은 `policy.status.<status>`를 표시하고, 실행 차단 사유는 런타임의
`PolicyError` 코드(`error.POLICY_*`)로 표시한다.

### 갱신 주기

| 시점 | 호출 |
|---|---|
| 앱 시작 | `start()` (첫 조회 + 60초 타이머) |
| 전경 복귀 | `refresh({ reason: 'foreground' })` |
| 전경에서 60초마다 | 타이머가 `refresh({ reason: 'timer' })` |
| 시작 직전 | `snapshot()`으로 상태 확인, 필요하면 `refresh({ reason: 'preflight' })` |
| 다시 확인 버튼 | `refresh({ reason: 'manual' })` |
| 백그라운드·페이지 종료 | `stop()` (타이머·진행 중 요청 취소) |

- 진행 중인 요청이 있으면 `refresh()`는 새 요청을 열지 않고 그 결과를 돌려준다.
- 60초 간격은 요청 완료 시각부터 잰다. 수동 갱신도 간격을 다시 시작한다.
- 요청마다 세대 번호를 둔다. `stop()` 이후나 더 새로운 요청 뒤에 도착한 응답은 전송 계층이 abort를 무시했더라도 버린다.
- `refresh()`·`start()`는 거부(reject)하지 않고 항상 스냅샷으로 해결된다.

### revision 규칙

1. 첫 수락 뒤에는 더 낮은 revision을 롤백으로 거부한다(`POLICY_REVISION_ROLLBACK`).
2. 같은 revision인데 검증 후 정규화한 내용이 다르면 충돌로 거부한다(`POLICY_REVISION_CONFLICT`).
   내용 식별값은 `validatePolicy` 결과의 `JSON.stringify`다(정규 키 순서).
3. 같은 revision·같은 내용은 재검증 성공으로 처리해 `fetchedAt`만 갱신한다.
4. 더 높은 revision은 새 정책으로 교체한다.
5. 거부된 응답은 조회 실패와 같이 취급한다. 현재 정책은 5분 안에서 `stale`로 유지된다.
6. 규칙 1·2는 정책이 나이 초과로 권한을 잃은 뒤에도 클라이언트 수명 동안 유지된다.

### 발행 절차(요약)

1. 관리자 콘솔(P3-32~33)에서 정책을 편집·검증·다운로드한다.
2. `revision`을 반드시 1 이상 올린다. 이전 내용으로 되돌릴 때도 새 revision으로 발행한다.
3. 저장소 루트의 `policy.json`을 교체해 커밋·배포한다(발행 권한은 저장소 커밋·배포 권한이다).
4. 배포 뒤 앱에서 "다시 확인"을 눌러 배너·설정의 revision이 바뀌었는지 확인한다.
   정적 CDN 반영 지연 동안은 이전 revision이 보일 수 있다.

### 검증

- 자동: `node --test tests/policy-client.test.mjs` (`tests/fixtures/policy-fetch.mjs`의 오프라인 fetch·시계 사용).
- 미검증(브라우저 실측 필요): 실제 GitHub Pages에서 `redirect: 'error'`·`cache: 'no-store'` 동작, 응답 헤더,
  CDN 반영 지연, 백그라운드 타이머 정지 뒤 전경 복귀 시 `failed` → `ready` 전환. `docs/p3-verification.md` V23 참조.
