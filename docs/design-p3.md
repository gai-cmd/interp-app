# 1. P3 상세 설계

기준일: 2026-09-06.

이번 P3는 **관리자 정책·반응형 디자인·다국어·키 안내·화면 설정·설정 화면 개선**의 여섯 요구를 대상으로 한다. 기존 `design-v0.6.md`의 P3였던 IndexedDB 기록·xlsx 내보내기는 별도 후속 백로그로 이관한다. 현재 기록 저장 OFF와 공용 모드의 영구 저장 금지는 유지한다.

파일 수정·테스트 실행·배포는 하지 않았다. 아래 명령은 구현 후 실행할 완료 확인 명령이다. 603개 통과는 기존 보고 기준이며, P2의 현장 규모·장시간 실측 보류 항목을 이번 설계로 완료 처리하지 않는다.

## 1.1 변경 경계와 기존 계약

- 정적 호스팅·서버 없음·외부 npm 패키지 없음·빌드 도구 없음을 유지한다.
- 제공자·모델·네트워크 endpoint는 코드 검토로 등록한다. 정책이나 QR에서 임의 endpoint를 추가하지 못한다.
- 개인 키와 공용 키는 기존 `(providerId, keySource)` 경계를 유지한다.
- Live 단일 소유권, 실제 소켓 종료 확인, 늦은 결과 폐기, 자동 개인/공용 전환 금지를 유지한다.
- 허브 청취에는 API 키와 마이크 권한이 필요 없다.
- P2-25의 사이트 공유 QR은 재구현하지 않는다. P3에서는 헤더 위치와 공통 시트 스타일만 정리한다.
- 관리자 콘솔에서 만드는 **공용 키 payload**는 사이트 공유 QR과 별도 기능이다.

`P2-25.last.md`에는 공유 UI 구현과 603개 통과, 공유 회귀 단언·브라우저 검증의 후속 필요가 기록되어 있다. 해당 작업의 최종 인계 상태를 확인하고 P3 회귀 검증에 연결한다.

## 1.2 관리자 권한의 의미

정책 편집기는 누구나 열 수 있다. **편집·검증·다운로드는 관리 권한이 아니며, 저장소 커밋과 배포 권한이 실제 발행 권한**이다.

관리자 콘솔에는 로그인 흉내, 관리자 비밀번호, GitHub 토큰, 배포 API 호출을 넣지 않는다. 버튼 이름은 다음과 같다.

- 현재 정책 불러오기
- JSON 가져오기
- 검증
- 변경 미리보기
- 정책 JSON 다운로드
- 정책 JSON 복사
- 발행 절차 보기

“발행 완료”는 콘솔에서 표시하지 않는다. 다시 불러온 정책의 revision이 바뀌어야 배포 반영을 확인할 수 있다.

정책은 정상 앱의 동작을 통제한다. 사용자가 수정한 클라이언트, 과거 P1/P2 클라이언트, 복사한 API 키까지 강제 통제하는 보안 경계는 아니다. 실제 키 폐기는 제공자 콘솔에서 한다.

## 1.3 정책 위치와 신뢰 경계

배포 기준 주소는 다음과 같다.

```text
https://gai-cmd.github.io/interp-app/policy.json
https://gai-cmd.github.io/interp-app/admin/
```

`/admin/`은 **앱 배포 루트 아래**를 뜻한다. GitHub Pages의 `/interp-app/` 접두사를 빠뜨리지 않는다.

앱은 문서의 배포 루트를 기준으로 고정된 `policy.json`만 요청한다. `import.meta.url`의 `releases/<id>/` 아래에서 찾지 않는다.

검증 규칙:

1. 요청 URL과 최종 응답 URL이 앱과 같은 origin이어야 한다.
2. 경로는 정해진 배포 루트의 `policy.json`이어야 한다.
3. `redirect: 'error'`, `cache: 'no-store'`, 제한 시간 5초를 적용한다.
4. JSON 본문은 최대 64KiB로 제한한다. `Content-Length`만 믿지 않는다.
5. 스키마·필드·문자열 길이·범위·참조 무결성을 검증한 뒤 전체를 원자적으로 적용한다.
6. 외부 URL, HTML, 스크립트, API 키, 방 코드 등 허용하지 않은 필드는 거부한다.
7. 동일 revision의 다른 내용은 충돌로 거부한다. 더 낮은 revision은 롤백으로 거부한다.

같은 origin은 배포 주체를 신뢰하는 기준이지 전자서명은 아니다. GitHub Pages의 같은 origin을 공유하는 다른 저장소까지 포함한 배포 계정 보안이 전제다.

## 1.4 정책 스키마 v1

다음은 유효 정책의 기본 예시다. 단가와 행사 목록은 미확정 상태에서 빈 배열로 배포한다.

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "publishedAt": "2026-09-06T00:00:00Z",
  "validUntil": null,
  "minAppVersion": "0.7.0",
  "emergency": {
    "stopped": false,
    "reason": null
  },
  "features": {
    "sequential": true,
    "simultaneousDirect": true,
    "hubListen": true,
    "diagnostics": true,
    "sharedKeys": false,
    "rememberPersonalKey": true
  },
  "settings": {
    "ui.mode": {
      "default": "system",
      "allowed": ["system", "light", "dark"],
      "locked": false
    },
    "ui.tone": {
      "default": "navy",
      "allowed": ["navy", "warm", "forest", "mono"],
      "locked": false
    },
    "ui.text": {
      "default": "m",
      "allowed": ["s", "m", "l", "xl"],
      "locked": false
    },
    "captions.size": {
      "default": 1.5,
      "min": 1,
      "max": 2,
      "step": 0.125,
      "locked": false
    },
    "interpretation.sourceLanguage": {
      "default": "ko",
      "allowed": ["auto", "ko", "en", "ja"],
      "locked": false
    },
    "interpretation.targetLanguage": {
      "default": "ja",
      "allowed": ["ko", "en", "ja"],
      "locked": false
    },
    "voice.output": {
      "default": "provider",
      "allowed": ["provider", "device", "off"],
      "locked": false
    },
    "billing.plan": {
      "default": "free",
      "allowed": ["free", "paid"],
      "locked": false
    }
  },
  "notices": [],
  "sharedEvents": [],
  "hubControl": {
    "enabled": false,
    "allowedHubIds": [],
    "allowDirectSubscription": false
  },
  "pricing": {
    "revision": 1,
    "updatedAt": "2026-09-06T00:00:00Z",
    "currency": "USD",
    "allowLocalOverride": true,
    "rates": []
  }
}
```

### フィールド契約

| 項目 | 規則 |
|---|---|
| `schemaVersion` | v1のみ受理。未知版は部分適用しない |
| `revision` | 正の安全整数。発行ごとに増加 |
| `publishedAt` | タイムゾーン付きUTC日時。版の順序判定には使わない |
| `validUntil` | UTC日時またはnull。期限到達後は新規開始不可 |
| `minAppVersion` | `major.minor.patch`。文字列比較せず数値比較 |
| `emergency.reason` | nullまたは必須三言語の短い理由 |
| `features` | 既知機能のbooleanのみ。実装能力を新しく付与しない |
| `settings` | 登録済み設定名だけ受理。任意パスへのdeep mergeは禁止 |
| `notices` | 最大10件。ID・重要度・掲載期間・三言語本文 |
| `sharedEvents` | 最大100件。公開メタデータのみ |
| `allowedHubIds` | コード登録済みハブIDの部分集合 |
| `pricing.rates` | モデル・能力・単位・金額・根拠日・確度を検証 |

追加規則:

- `default`は`allowed`内、数値は範囲内かつ刻みに一致すること。
- `locked: true`は`default`を強制する。選択肢が一つの場合も実質ロックとして表示する。
- 原語・目標語が同じになる組合せや、許可機能と使用可能な設定が矛盾する政策は拒否する。
- 文面は`{ "ko": "...", "en": "...", "ja": "..." }`形式。欠落・空文を拒否する。
- 通常本文は言語ごとに1,000文字、緊急理由は300文字まで。
- `__proto__`等を含む未知キーを拒否し、検証済みフィールドを新しいオブジェクトにコピーする。
- UI言語はアクセス手段なので管理者のロック対象にしない。KO・EN・JAを常に選べる。

### 公用キー行事

```json
{
  "id": "service-20260906",
  "providerId": "gemini",
  "eventName": "2026-09-06",
  "label": {
    "ko": "9월 6일 예배",
    "en": "September 6 service",
    "ja": "9月6日の礼拝"
  },
  "startsAt": "2026-09-06T00:00:00Z",
  "expiresAt": "2026-09-06T03:00:00Z",
  "enabled": false,
  "allowedCapabilities": ["translate", "stt", "voice"]
}
```

행사 목록에 키, QR 원문, 참가 방 코드, 임의 허브 주소를 넣지 않는다. `enabled`는 운영자의 허용 선언이며 IP 제한 검증 완료의 증거가 아니다.

현재 직접 동시통역의 개인 키 전용 계약은 유지한다. 행사 정책만으로 공용 Live를 활성화하지 않는다.

## 1.5 정책 적용·실패·갱신 규칙

실효 설정은 다음 순서로 계산한다.

```text
코드의 지원 범위·보안 제한
  ∩ 사이트 정책의 기능·허용 범위
  ∩ 현재 참가 행사의 제한
  ∩ 허브 실시간 제한
  → 강제값
  → 허용되는 개인 선택
  → 정책 기본값
  → 앱 기본값
```

개인 선택과 실효값은 별도로 보관한다. 관리자가 제한했다가 해제한 경우 이전 개인 선택을 복원할 수 있으며, 적용 중인 연결은 자동 재시작하지 않는다.

| 상황 | 처리 |
|---|---|
| 첫 실행에서 정책 조회 중 | 설정·안내는 열고 통역 시작은 대기 |
| 첫 조회 실패·잘못된 정책 | 시작·진단 차단, 재시도 제공 |
| 정상 정책 수신 | 검증 후 한 번에 적용 |
| 실행 중 일시적 조회 실패 | 마지막 메모리 정책을 최대 5분까지 유지 |
| 5분 동안 재검증 불가 | 새 실행 차단, 진행 작업 정리 |
| 긴급 중지 | 즉시 시작 게이트 차단 후 모든 활성 작업 취소 |
| 기능·언어·키 허용 범위 축소 | 영향을 받는 작업 종료, 변경 이유 표시 |
| 톤·글자 크기·UI언어 변경 | 연결 유지, 화면만 갱신 |
| 가격표 변경 | 이후 사용 구간부터 새 요율 적용 |
| 최소 버전 미달 | 통역 차단, 설정·안내·업데이트는 사용 가능 |
| 허용 범위 확대·중지 해제 | 시작 버튼 활성화, 자동 시작하지 않음 |

갱신은 시작 시, 전경 복귀 시, 전경에서 60초마다 수행한다. 시작 직전에도 유효기간을 검사한다. 타이머는 중복 조회를 막고, 오래된 응답이 최신 정책을 덮지 못하도록 요청 세대를 둔다.

정책 본문은 영구 저장하지 않는다. 짧은 메모리 유효기간만 인정한다. localStorage에는 표시용 실효 테마와 정책 revision·내용 식별값을 보관할 수 있지만, 이를 새 실행의 권한 근거로 쓰지 않는다.

revision을 낮추는 롤백 대신 **이전 내용으로 새 revision을 발행**한다. 릴리스 롤백도 정책 revision을 되돌리지 않는다.

정적 CDN 갱신, 오프라인, 백그라운드 타이머 정지 때문에 모든 폰의 즉시 중지를 보장하지 않는다. 실시간 경로의 적용 범위는 다음 절과 같다.

## 1.6 실행 게이트와 잠금 UI

버튼을 비활성화하는 것만으로 끝내지 않는다.

- 중앙 정책 서비스가 `snapshot()`, `subscribe()`, `assertAction()`을 제공한다.
- 순차 시작·재시도·재생·진단·직접 Live·허브 참가 전에 검사한다.
- 제공자 router 경계에서도 허용 능력·키 출처를 검사한다.
- 정책 변경 시 기존 `stopWork()`와 activity/session-manager 정리 경로를 사용한다.
- 중지 시 마이크 트랙·REST 요청·Live 연결·PCM·기기 TTS를 정리하고 늦은 결과를 폐기한다.
- 소켓 종료 확인 실패를 성공으로 처리하거나 Live 점유를 강제로 해제하지 않는다.

설정에는 다음 출처를 표시한다.

| 출처 | 표시 |
|---|---|
| 개인 선택 | 일반 컨트롤 |
| 정책 기본값 | “관리자가 정한 기본값” |
| 강제값 | 잠금 아이콘 + “관리자가 정한 값” |
| 선택 범위 제한 | “관리자가 허용한 항목만 선택할 수 있어요” |
| 실행 차단 | 이유·정책 revision·다시 확인 버튼 |

잠금 이유는 비활성 입력과 별도의 읽을 수 있는 설명으로 제공한다. `aria-describedby`를 연결하고 색만으로 구분하지 않는다.

긴급 중지·정책 오류·최소 버전 미달은 **지속 배너**다. `DESIGN.md`의 8초 자동 소거는 일반 알림에 적용하며, 실행을 막는 이유를 자동으로 지우지 않는다.

## 1.7 관리자 콘솔

`admin/index.html`은 공통 디자인 토큰과 세 언어 사전을 사용한다. 동작 코드는 `app/admin/`에 두어 기존 ES 모듈 배포 구조를 활용한다.

화면 순서:

1. **현재 배포 정책** — revision, 발행일, 최소 앱 버전, 불러온 상태.
2. **운영 통제** — 긴급 중지, 이유, 기능 토글, 공지.
3. **개인 설정 범위** — 기본값, 허용값, 잠금.
4. **공용 키 행사** — 공개 행사 메타데이터 편집.
5. **가격표** — 단위·통화·적용 모델·확인일·추정 여부.
6. **검증·변경 미리보기** — 기존 정책과 달라지는 값, 잠기는 항목, 중지되는 기능.
7. **내보내기·발행 절차** — JSON 다운로드/복사, 저장소 반영 안내.
8. **공용 키 payload 생성** — 정책 편집 상태와 분리된 임시 도구.

가져온 JSON도 앱과 같은 validator로 검사한다. 검증 실패 시 내보내기를 막고 필드 경로와 세 언어 오류를 표시한다. 편집 중 정책을 현재 앱의 운영 정책으로 적용하지 않는다.

정책 다운로드는 `Blob`과 object URL을 사용하고 사용 후 해제한다. 클립보드 실패 시 선택 가능한 읽기 전용 텍스트를 제공한다.

### 공용 키 payload

현재 v1 파서는 `eventId`를 허용하지 않으므로 v2를 명시적으로 추가한다.

```text
{
  version: 2,
  providerId,
  eventId,
  eventName,
  key,
  expiresAt
}
```

- 기존 `#shared=<encodeURIComponent(JSON.stringify(payload))>` 형식과 길이 상한을 유지한다.
- v2는 현재 정책의 행사 ID·제공자·행사명·만료 시각과 대조한다.
- 기존 v1은 파싱 호환을 유지하되, 활성 행사와 제공자·행사명·만료가 유일하게 일치하는 경우에만 정책하에서 사용한다.
- 행사 목록 변경·만료·중지 시 현재 사용 중인 공용 경로에도 적용한다.
- QR의 행사 ID는 서명이 아니며 관리자 신원을 증명하지 않는다.

관리자 도구는 수동 입력한 키만 메모리에서 다룬다. 일반 앱의 저장 키를 읽어오지 않는다. 키·payload는 정책 JSON·localStorage·로그에 포함하지 않는다.

생성 결과는 명시적으로 복사하거나 다운로드할 수 있지만 자동 URL 이동은 하지 않는다. 닫기·페이지 이탈 시 입력과 결과를 지운다. **P3 필수 범위는 QR에 넣을 payload/링크 생성이며 동적 QR 이미지 인코더 도입은 제외**한다.

## 1.8 허브 실시간 통제 프로토콜

허브 서버 수정은 범위 밖이다. 앱에는 파서·수신·적용 경로와 fixture를 구현하고 서버가 따를 프로토콜을 문서화한다.

신뢰 대상은 코드 등록 WSS 허브 중 사이트 정책이 허용한 허브다. 임의 WebSocket, QR, `window.postMessage`로 받은 제어는 적용하지 않는다.

### 협상

기존 `hello`에 선택 필드를 추가한다.

```json
{
  "type": "hello",
  "sessionId": "existing-session",
  "settings": {},
  "control": {
    "version": 1,
    "eventId": "service-20260906",
    "epoch": "broadcast-epoch",
    "revision": 12
  }
}
```

협상 후 서버는 현재 통제 상태의 **전체 snapshot**을 보낸다.

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
    "text": {
      "ko": "잠시 통역을 중지합니다.",
      "en": "Interpretation is temporarily paused.",
      "ja": "通訳を一時停止します。"
    }
  }
}
```

규칙:

- `eventId`·epoch는 현재 협상한 값과 일치해야 한다.
- 같은 epoch에서는 revision이 증가해야 한다. 중복·역순은 무시한다.
- 새 epoch는 새 `hello` 이후에만 수락한다.
- 메시지는 최대 16KiB, TTL은 10~120초로 제한한다.
- TTL은 수신 후 단조 시계로 계산한다. 서버 시각을 지연 측정에 사용하지 않는다.
- 허브는 제한을 추가할 수 있지만 사이트 정책의 금지를 해제하지 못한다.
- 허브는 API 키·endpoint·모델·가격표·개인 설정을 변경하지 못한다.
- 중지 해제는 더 높은 revision의 유효 snapshot으로만 인정한다.
- 중지 상태에서 단절·TTL 만료가 발생해도 자동 해제하지 않는다.
- 협상한 제어의 heartbeat가 끊기면 행사 실행을 중지하고 “현장 통제 연결을 확인할 수 없음”을 표시한다.
- 기존 허브의 `cast.stopped` 등은 그대로 처리한다.
- 제어 확장을 지원하지 않는 허브에는 “실시간 관리 미지원”을 표시한다.

기존 허브 청취 소켓이 있으면 재사용한다. 내 폰 직접 모드도 통제받으려면 사용자가 등록된 행사에 명시적으로 참가하고 **제어 전용 청중 연결**을 유지해야 한다. 이 연결은 마이크·제공자 API·자막 낭독을 시작하지 않는다.

허브 중지는 해당 행사에 연결된 클라이언트에 적용된다. 행사에 참가하지 않은 폰이나 다른 사이트 방문자까지 통제하지 않는다. 중지 수신 뒤에도 제어 소켓은 유지해 해제 공지를 받을 수 있도록 오디오 작업 수명주기와 분리한다.

## 1.9 반응형 구현

`docs/DESIGN.md`를 시각 기준으로 사용한다.

| 구간 | 구현 |
|---|---|
| `<40rem` | 1열, 좌우 1rem, 탭 별도 줄, 전체 화면 시트, safe-area |
| `≥40rem` | 본문 최대 40rem, 설정 언어·키 2열, 중앙 모달 최대 640px |
| `≥64rem` | 본문 최대 60rem, 순차 좌 24rem 컨트롤 + 우 가변 기록 |
| 동시통역 | 태블릿 자막·측면 컨트롤, 데스크톱 넓은 자막 영역·우 상태 패널 |

구현 세부:

- `.btn`, `.card`, `.badge`, `.sheet`, `.tabs`를 공통 클래스 계약으로 정리한다.
- 기존 `--translation-bg`는 `--accent-soft` 별칭으로 점진 전환한다.
- 비활성 버튼 opacity를 제거하고 지정 토큰을 적용한다.
- 포커스 링은 2px·offset 2px.
- 모든 입력·버튼의 터치 영역은 최소 44px. S 글자에서도 줄어들지 않는다.
- PTT는 모바일 최소 64px, 데스크톱 최소 56px이며 콘텐츠 확대 시 늘어난다.
- 그리드 자식에 `min-width: 0`, 긴 텍스트에 줄바꿈을 적용한다.
- 모바일 시트는 내부 내용 스크롤과 sticky 행동 영역을 사용한다.
- 모달 배경은 `inert`, 포커스 트랩·Escape·트리거 복귀를 유지한다.
- 설정·화면·공유 시트는 상호 배타적으로 연다.
- DOM 순서와 시각적 탐색 순서를 맞춘다.
- 부분 자막마다 스크린리더가 읽지 않도록 기존 확정 자막 중심 규칙을 유지한다.

헤더 배치:

```text
데스크톱: 앱 이름 | 통역 탭 | 상태 배지 | KO EN JA | 화면 | 공유 | 설정
모바일:   앱 이름·상태
          KO EN JA · 화면 · 공유 · 설정
          통역 탭
```

언어 선택은 overflow 메뉴 안에 숨기지 않는다. XL·일본어·200% 확대에서는 자연스럽게 줄바꿈한다.

430/768/1280px 스크린샷 검증은 오케스트레이터 담당이다. Node의 DOM/CSS 검사는 실제 배치 검증을 대체하지 않는다.

## 1.10 테마·글자·첫 페인트

저장 키는 `DESIGN.md`를 따른다.

```text
interp-app.ui.v1.mode
interp-app.ui.v1.tone
interp-app.ui.v1.text
```

- mode: `system | light | dark`
- tone: `navy | warm | forest | mono`
- text: `s | m | l | xl`
- 자막 크기: 별도 `interp-app.ui.v1.captionSize`

시스템 모드에서는 `data-mode`를 제거하고 미디어 쿼리를 따른다. 강제 모드는 시스템 다크 규칙보다 우선한다.

글자 크기는 87.5% / 100% / 112.5% / 125%. 자막은 별도 1~2rem 슬라이더와 가−/가+를 동일 저장값에 연결한다. 전체 글자 확대도 존중하므로 자막의 rem은 전체 확대 위에 추가로 적용된다.

### 첫 페인트 계약 보완

현재 `main.js`는 ES 모듈이며 사전 로딩도 비동기다. **모듈 최상단에서 설정하는 것만으로 첫 페인트 전 적용을 보장할 수 없다.**

따라서 `DESIGN.md` §10의 목적을 충족하도록 외부 동기 스크립트 `app/ui/appearance-boot.js`를 `<head>`의 스타일시트보다 앞에 둔다.

- 네트워크 요청·키 접근 없이 검증된 표시 설정만 읽는다.
- 저장소 실패 시 system/navy/m으로 안전하게 진행한다.
- inline script와 `unsafe-inline`을 추가하지 않는다.
- 기존 “모듈 스크립트 하나” 릴리스 검사 계약을 **지정된 동기 부트 스크립트 하나 + main 모듈 하나**로 변경한다.
- 관리자 페이지에도 같은 부트 스크립트를 적용한다.

첫 방문의 아직 받지 않은 정책이나 새 정책의 테마까지 최초 페인트에 반영하는 것은 보장하지 않는다. 저장된 설정은 첫 페인트 전에 적용하고, 새 정책은 검증 후 반영한다. 화면 전체를 네트워크 응답까지 숨기지 않는다.

## 1.11 다국어

기존 `interp-app.ui.v1.language`, `selectLanguage()`, `shell.setLanguage()`를 재사용한다.

1. 유효한 저장 언어.
2. `navigator.languages`의 첫 지원 언어.
3. English 폴백.

헤더와 설정의 언어 선택은 하나의 변경 경로를 호출한다. 변경 시 문구·문서 언어·제목·manifest를 갱신하지만 통역 언어와 활성 연결은 유지한다.

`check-i18n`은 다음을 검사한다.

- 세 언어 키 집합·비어 있지 않은 문구·placeholder 일치.
- `app/admin/`과 `admin/*.html`을 포함한 사용 키.
- 동적으로 조합하는 enum 키의 명시 목록.
- 정책의 공지·행사명은 정책 validator에서 세 언어 완전성 검사.

자연스러움은 정적 검사로 보장하지 않는다. 전체 문구를 한국어·영어·일본어별로 한 번씩 검토하고 용어·행동 문구·존댓말을 정리한다.

## 1.12 키 안내와 설정 화면

### 설정 섹션 재배치

| 순서 | 섹션 | 기존 구조와의 관계 |
|---|---|---|
| 1 | 표시·언어 | UI언어, 모드·톤·글자, 자막 크기 |
| 2 | 통역 | 기존 원어·목표어, 음성 출력·보이스 |
| 3 | 제공자·API 키 | 단일 제공자 제목, 개인 키, 발급·이용 안내 |
| 4 | 현장 공용 키 | 행사·임시 보관, 개인/공용 명시 선택 |
| 5 | 요금제·사용량 | Free/Paid, 사용 시간, 추정 비용·단가 |
| 6 | 마이크·오디오 장치 | 권한, 입력·출력 장치 |
| 7 | 연결 진단 | 기존 능력 표·개별 검사·허브 상태 |
| 8 | 기록 | 저장 OFF·현재 내용 지우기 유지 |
| 9 | 앱·관리 정책 | 설치·업데이트·앱 버전·정책 버전·잠금 이유 |
| 10 | 이용 안내 | 기존 데이터 처리·지원 조건 |

섹션 이동 시 기존 공개 `elements` 참조와 PWA 삽입 지점을 유지한다. `settings-view.js`에 모두 누적하지 않고 표시·키 안내·오디오·요금제 컴포넌트를 분리한다.

각 섹션에 한두 문장의 설명을 둔다. 예: “마이크를 선택하면 주변 소음을 줄이는 데 도움이 돼요”, “요금제 선택은 사용량 표시 방식을 정하며 Google의 결제 설정을 바꾸지 않아요.”

### 키 발급 안내

공통 안내 카드 하나를 다음 세 위치에서 재사용한다.

- 설정의 개인 키 섹션.
- 첫 실행 안내.
- 직접 통역 경로에서 키가 없는 빈 화면.

허브 청취의 빈 자막판에는 키가 필요하다고 표시하지 않는다.

발급 링크는 [Google AI Studio API 키 페이지](https://aistudio.google.com/apikey), 사용 안내는 [Google의 키 사용 문서](https://ai.google.dev/gemini-api/docs/api-key)로 고정한다. 새 탭은 `target="_blank" rel="noopener noreferrer"`로 열고 “새 탭”을 접근성 문구에 포함한다.

| 언어 | 3단계 안내 |
|---|---|
| 한국어 | Google 계정으로 로그인 → “API 키 만들기” 선택 → 키를 복사해 이곳에 붙여넣기 |
| English | Sign in with Google → Select “Create API key” → Copy the key and paste it here |
| 日本語 | Google アカウントでログイン →「API キーを作成」を選択 → キーをコピーしてここに貼り付け |

보조 문구:

- KO: “키 발급은 무료이며 결제 등록 없이 시작할 수 있어요. 모델별 무료 제공 여부와 한도는 다릅니다.”
- EN: “Creating a key is free, and you can get started without setting up billing. Free access and limits vary by model.”
- JA: “キーは無料で作成でき、支払い情報を登録せずに始められます。無料で使えるモデルや利用上限は異なります。”

Google의 무료/유료 구분이 있으므로 모든 모델의 통역 사용까지 무료라고 단정하지 않는다. [Google 결제 안내](https://ai.google.dev/gemini-api/docs/billing?hl=en)

“Gemini API만 허용하도록 제한을 확인하세요”를 세 언어로 제공한다. 공식 문서는 제한되지 않은 표준 키의 거부와 새 키 유형 전환도 안내하므로, 단순한 선택적 보안 권장으로만 표현하지 않는다. [Google 키 제한 안내](https://ai.google.dev/gemini-api/docs/api-key)

### 키 표시·숨김과 저장 상태

- 입력 중인 키에 표시/숨김 토글을 제공한다.
- 기존 저장 키를 자동으로 입력란에 다시 채우지 않는다.
- 저장 성공 후 입력란을 비우고 숨김 상태로 복귀한다.
- `remembered: true`일 때만 “키를 이 브라우저에 저장했습니다”.
- 메모리만 저장했으면 “키를 이번 실행 동안만 사용합니다”.
- 저장 실패 시 성공 문구를 표시하지 않는다.
- 공용 키는 표시·영구 저장 대상이 아니다.

이는 기존 “전체 보기 기본 미제공” 계약을 **개인 키의 입력 중 명시적 표시 허용**으로 좁게 변경하는 것이다.

## 1.13 요금제·사용량·추정 비용

`Free / Paid`는 사용자가 지정하는 **표시 설정**이다. API 권한·실제 청구·quota·재시도 예산을 변경하지 않는다.

- 개인 설정은 제공자별로 저장한다. 키 교체 시 선택을 다시 확인하도록 안내한다.
- Free: 사용 시간만 표시.
- Paid: 사용 시간과 추정 비용, 계산 범위·단가 출처·확인일 표시.
- 허브 청취: 청중의 Gemini 호출 비용으로 계산하지 않는다.
- 알 수 없는 비용을 0으로 표시하지 않는다.
- 개인 키와 공용 행사 사용량은 합산하지 않는다.
- 이번 P3의 사용량은 현재 실행의 관측값이며, Google 프로젝트 전체 청구 내역이 아니다.

단가는 코드 상수가 아닌 정책 또는 허용된 개인 설정에서 가져온다.

P3 기본 계산은 **모델·능력별 활성 사용 분당 운영 추정 단가**를 사용한다.

```text
추정 비용 = Σ(해당 단가가 적용된 활성 사용 시간 / 60 × 분당 추정 단가)
```

이 값은 Google의 토큰 단가를 분당 공식 단가로 바꿨다는 뜻이 아니다. 운영자가 확인한 추정 요율이며 항상 “추정”으로 표시한다. 단가 항목에는 `basis: "activeMinuteEstimate"`를 명시한다.

단가 미설정·미확인 모델은 “추정 불가”로 표시한다. 일부 구간만 계산 가능하면 합계 대신 “계산 가능한 구간의 추정액”으로 표시한다. 실제 토큰 기반 계산은 사용량 메타데이터 수집을 추가하는 별도 범위로 둔다.

가격표 변경 시 이전 사용 구간의 요율을 고정한다. reconnect·중복 종료·중지 후 콜백에서 시간을 중복 합산하지 않는다.

## 1.14 마이크 권한과 오디오 장치

### 권한

“자동 설정”은 **사용자 제스처에서 권한 요청을 시작하는 것**이다. 브라우저 권한을 앱이 자동 허용하거나 거부를 해제하지 않는다.

- 직접 통역을 위한 첫 설정 저장·시작에서 요청한다.
- 헤더 언어·화면·공유 버튼에서는 요청하지 않는다.
- 허브 청취와 관리자 콘솔에서는 요청하지 않는다.
- 저장에서는 권한 확보 후 모든 임시 트랙을 즉시 중지한다.
- 시작에서는 확보한 스트림을 캡처 경로에 넘겨 중복 요청을 피한다.
- 권한 대기 중 취소되면 늦게 도착한 스트림도 중지한다.
- 거부 시 자동 재요청 루프를 만들지 않는다.

표시 상태는 허용됨/거부됨/미요청을 기본으로 하고, 조회 미지원·장치 없음·장치 사용 중은 별도 설명으로 구분한다. `NotReadableError`를 권한 거부로 표시하지 않는다.

`navigator.permissions.query({name: 'microphone'})`는 기능 탐지와 예외 처리를 하고, 지원하면 `change` 이벤트를 구독한다. 미지원 브라우저는 실제 요청 결과와 복귀 후 확인을 사용한다. 과거 저장값을 현재 권한의 증거로 쓰지 않는다.

거부 안내에는 iOS Safari의 사이트/OS 마이크 설정, Android Chrome의 사이트 권한, 데스크톱의 주소창 사이트 권한·OS 개인정보 설정 경로를 구분해 넣는다. 정확한 메뉴 문구는 오케스트레이터가 실제 지원 버전에서 확인한다.

### 장치

- 시스템 기본값을 항상 제공한다.
- 마이크 권한 후 `enumerateDevices()`로 입력 목록을 갱신한다.
- 권한 전에는 숨겨진 장치 라벨을 추측해 표시하지 않는다.
- `devicechange`·전경 복귀에서 갱신하고 사라진 장치는 기본값으로 복귀한다.
- 입력 변경은 현재 녹음·직접 Live를 종료한 뒤 다음 사용자 시작에 적용한다.
- 장치 ID는 로컬 설정에만 보관하고 정책·로그·진단 내보내기에 넣지 않는다.

장치 열람과 선택에는 권한·브라우저 정책의 제한이 있으므로 장치 목록이 항상 완전하다고 가정하지 않는다. [Media Capture 명세](https://www.w3.org/TR/mediacapture-streams/)

현재 PCM 재생은 `AudioContext`를 사용하므로 **실제 context의 `setSinkId` 지원 여부**를 검사한다. `HTMLMediaElement.setSinkId`만 보고 출력 선택을 노출하지 않는다.

출력 선택은 PCM 경로에 적용한다. 기기 `speechSynthesis`에는 같은 출력 장치 강제 기능을 약속하지 않고 “기기 음성은 시스템 출력 사용”을 표시한다. 출력 장치 권한이 필요한 브라우저에서는 사용자 제스처에서 지원 API를 사용한다. [Audio Output Devices 명세](https://w3c.github.io/mediacapture-output/)

## 1.15 릴리스·서비스 워커

현재 릴리스 구조를 유지하면서 다음을 추가한다.

- 배포 루트: `policy.json`, `admin/index.html`.
- 버전 경로: `app/policy/`, `app/admin/`, 새 UI·오디오 모듈.
- 초기 표시 스크립트도 버전 경로로 배포.
- 관리자 HTML의 상대 참조는 `/interp-app/admin/` 기준으로 재작성·검증.
- 정책과 관리자 진입 HTML은 서비스 워커 precache에서 제외.
- 관리자 정적 JS/CSS는 비밀 없는 코드 자산으로 캐시 가능.
- 정책 요청은 캐시 조회보다 먼저 network-only 처리한다.
- 정책 오류가 새 앱 셸 설치 실패로 이어지지 않게 한다.

`check-release`에 다음 검사를 추가한다.

1. 정책·관리자 진입점 존재와 허용 목록.
2. 정책 스키마와 등록 ID 참조.
3. 최소 앱 버전과 배포 앱 버전의 호환.
4. 관리자·앱 HTML의 허용 스크립트 및 자산 참조.
5. 정책이 SW 셸 목록에 없다는 단언.
6. 정책·관리자 자산을 포함한 비밀 검사.
7. 이전 릴리스 보존과 롤백 후 정책 유지.

앱 버전은 임의 문자열인 release ID와 구분한다. P3 앱 버전은 `0.7.0`을 추천하며, 코드의 버전 상수와 `package.json` 일치를 검사한다.

현재 `_headers`에도 명시되어 있듯 GitHub Pages는 이 파일을 적용하지 않는다. `check-release` 통과를 실제 응답 헤더 적용 증거로 사용하지 않는다. 정책의 `no-store` 요청과 SW 제외를 구현하고, CDN 반영·실제 헤더는 배포 검증에서 별도로 확인한다.

---

# 2. P3 과제 목록

모든 과제는 Node 24, 네트워크 없는 단일 `codex exec`에서 완료할 범위로 나눈다. 외부 API·실기기·스크린샷 검증 결과를 만들어내지 않는다.

`app/i18n/{ko,en,ja}.json`은 **3개 파일**로 계산한다. 각 과제의 파일 수는 테스트·문서까지 포함한다. 보고서는 stdout으로 출력하므로 별도 파일로 계산하지 않는다.

공통 완료 확인 명령 **G**:

```sh
node --test tests/*.test.mjs
node scripts/check-i18n.mjs
git diff --check
```

각 과제는 개별 검사와 G를 모두 실행한다. 기존 테스트 기대값이 설계 변경으로 정당하게 무효가 된 경우 해당 단언을 수정할 수 있다. 삭제·skip으로 우회하지 않으며 변경 파일·단언·이유를 보고한다. 계획상 6개를 넘는 변경은 후속 과제로 분리한다.

## P3-01 — P3 계약·범위·검증 기준 고정

- **목적:** 구현자가 공유할 정책·UI·운영 경계를 확정한다.
- **만들 파일 3개:** `docs/design-p3.md`, `docs/architecture.md`, `docs/p3-verification.md`.
- **의존 과제:** 없음.
- **완료 기준:** 본 설계, 기록/xlsx 이관, 공통 인터페이스, 수동 검증 구분, P2-25 인계점을 기록한다.
- **완료 확인 명령:** G.
- **예상 함정:** 기존 P2 현장 실측 보류를 자동 검사 통과로 완료 처리.

## P3-02 — 정책·관리자 공통 문구

- **목적:** 뒤의 정책 UI가 사전 수정 없이 구현되도록 한다.
- **만들 파일 4개:** `app/i18n/{ko,en,ja}.json`, `tests/i18n.test.mjs`.
- **의존 과제:** P3-01.
- **완료 기준:** 정책 상태·잠금·공지·관리자 편집·검증·내보내기·행사 문구와 동적 키 목록을 세 언어로 추가한다.
- **완료 확인 명령:** `node --test tests/i18n.test.mjs`; G.
- **예상 함정:** 관리자 페이지 문구를 한국어로 하드코딩.

## P3-03 — 표시·키 안내·오디오·요금제 문구

- **목적:** 사용자 설정 확장 문구를 준비한다.
- **만들 파일 4개:** `app/i18n/{ko,en,ja}.json`, `tests/i18n.test.mjs`.
- **의존 과제:** P3-02.
- **완료 기준:** 테마·크기·키 3단계·저장 상태·권한·장치·Free/Paid·추정 비용·섹션 설명을 추가한다.
- **완료 확인 명령:** `node --test tests/i18n.test.mjs`; G.
- **예상 함정:** 무료 키 발급을 모든 통역 모델의 무료 사용으로 표현.

## P3-04 — 정책 스키마와 앱 버전

- **목적:** 브라우저·관리자·릴리스가 같은 validator를 사용한다.
- **만들 파일 6개:** `app/policy/schema.js`, `app/version.js`, `policy.json`, `package.json`, `tests/policy-schema.test.mjs`, `tests/fixtures/policy.mjs`.
- **의존 과제:** P3-01.
- **완료 기준:** 예시 정책 검증, 상한·未知 필드·교차 조건·세 언어·가격표·행사 검증, 앱 버전 일치를 구현한다.
- **완료 확인 명령:** `node --test tests/policy-schema.test.mjs`; G.
- **예상 함정:** 문자열 버전 비교, `Object.assign`으로 검증 전 JSON 병합.

## P3-05 — 개인 설정 저장소와 실효 정책 계산

- **목적:** 개인 선택과 관리자 강제값을 분리한다.
- **만들 파일 4개:** `app/preferences.js`, `app/policy/resolve.js`, `tests/preferences.test.mjs`, `tests/policy-resolve.test.mjs`.
- **의존 과제:** P3-04.
- **완료 기준:** 허용 범위·강제값·기본값·출처·잠금 이유를 순수 함수로 계산한다. 저장소 거부·오염값·기존 UI언어 키를 처리한다.
- **완료 확인 명령:** `node --test tests/preferences.test.mjs tests/policy-resolve.test.mjs`; G.
- **예상 함정:** 정책 적용 때문에 개인 선택 원본을 덮어씀.

## P3-06 — 정책 로더·갱신·만료

- **목적:** 검증된 최신 정책만 실행 권한으로 사용한다.
- **만들 파일 4개:** `app/policy/client.js`, `tests/policy-client.test.mjs`, `tests/fixtures/policy-fetch.mjs`, `docs/policy-operations.md`.
- **의존 과제:** P3-04·05.
- **완료 기준:** 고정 URL·동일 origin·redirect 거부·64KiB·5초 timeout·60초 갱신·5분 유효기간·revision 충돌·오래된 응답 폐기를 구현한다.
- **완료 확인 명령:** `node --test tests/policy-client.test.mjs`; G.
- **예상 함정:** `releases/<id>/policy.json` 조회, fetch 취소를 무시하는 응답의 뒤늦은 적용.

## P3-07 — 실행 게이트와 정책 중지 연결

- **목적:** UI 밖 실행 경로까지 정책을 적용한다.
- **만들 파일 6개:** `app/policy/runtime.js`, `app/config.js`, `app/providers/router.js`, `app/main.js`, `tests/policy-runtime.test.mjs`, `tests/app-lifecycle.test.mjs`.
- **의존 과제:** P3-02·06.
- **완료 기준:** 시작·재생·재시도·진단·허브 참가를 검사하고 정책 변경을 기존 정리 경로에 연결한다. 최소 버전·만료·긴급 중지에서 늦은 결과와 자동 재개를 막는다.
- **완료 확인 명령:** `node --test tests/policy-runtime.test.mjs tests/app-lifecycle.test.mjs`; G.
- **예상 함정:** 버튼만 잠금, 종료 timeout 후 Live 점유 해제.

## P3-08 — 행사 정책과 공용 payload v2

- **목적:** 공용 키 사용을 활성 행사 목록과 연결한다.
- **만들 파일 5개:** `app/security/shared-key.js`, `app/security/key-store.js`, `app/policy/resolve.js`, `tests/security.test.mjs`, `tests/policy-shared.test.mjs`.
- **의존 과제:** P3-07.
- **완료 기준:** v2 eventId 검증, v1 유일 매칭, 행사 만료·중지·능력 제한을 적용한다. 개인 키 우선·공용 메모리 보관을 유지한다.
- **완료 확인 명령:** `node --test tests/security.test.mjs tests/policy-shared.test.mjs`; G.
- **예상 함정:** eventId를 서명으로 취급, 공용 Live를 새로 허용.

## P3-09 — 허브 통제 메시지 파서

- **목적:** 기존 메시지와 호환되는 제어 확장을 정의한다.
- **만들 파일 4개:** `app/hub/protocol.js`, `tests/hub-protocol.test.mjs`, `tests/fixtures/hub.mjs`, `docs/hub-control-protocol.md`.
- **의존 과제:** P3-04.
- **완료 기준:** hello 협상·snapshot 정규화·16KiB·TTL·필드 제한을 검증하고 미지원 서버를 구분한다.
- **완료 확인 명령:** `node --test tests/hub-protocol.test.mjs`; G.
- **예상 함정:** 기존 `settings` 메시지에 관리자 전체 권한 부여.

## P3-10 — 허브 통제 상태와 재접속

- **목적:** event/epoch/revision에 따라 제한을 안전하게 유지한다.
- **만들 파일 4개:** `app/hub/control.js`, `tests/hub-control.test.mjs`, `tests/fixtures/hub-control.mjs`, `docs/hub-control-protocol.md`.
- **의존 과제:** P3-05·09.
- **완료 기준:** 역순·중복·새 epoch·TTL·중지 latch·재협상·사이트 정책과 제한 교집합을 구현한다.
- **완료 확인 명령:** `node --test tests/hub-control.test.mjs`; G.
- **예상 함정:** 단절이나 TTL 만료가 긴급 중지를 해제.

## P3-11 — 허브 제어 수신과 앱 연결

- **목적:** 청취 소켓 재사용 및 직접 모드의 명시적 행사 참가를 연결한다.
- **만들 파일 5개:** `app/hub/client.js`, `app/main.js`, `app/ui/sim-view.js`, `tests/hub-control-integration.test.mjs`, `tests/hub-client.test.mjs`.
- **의존 과제:** P3-03·07·10.
- **완료 기준:** 제어 전용 연결에서 키·마이크·낭독 호출 0회, 중지 후 제어 연결 유지, 행사 이탈 정리, 미지원 상태 표시를 검증한다.
- **완료 확인 명령:** `node --test tests/hub-control-integration.test.mjs tests/hub-client.test.mjs`; G.
- **예상 함정:** `stopWork()`가 제어 연결까지 끊어 해제 공지를 못 받음.

## P3-12 — 디자인 토큰·네 가지 톤

- **목적:** DESIGN.md의 기본 시각 규칙을 구현한다.
- **만들 파일 3개:** `styles.css`, `tests/design-tokens.test.mjs`, `docs/p3-verification.md`.
- **의존 과제:** P3-01.
- **완료 기준:** 모든 모드·톤 토큰, 글자 4단계, 공통 컴포넌트, 비활성·포커스·reduced-motion을 구현한다. 텍스트 대비를 계산 검사한다.
- **완료 확인 명령:** `node --test tests/design-tokens.test.mjs`; G.
- **예상 함정:** warm/forest/mono 악센트 위 글자 대비 저하, S에서 터치 영역 축소.

## P3-13 — 첫 페인트 전 표시 설정 적용

- **목적:** 저장된 표시 설정의 초기 깜빡임을 방지한다.
- **만들 파일 6개:** `app/ui/appearance-boot.js`, `index.html`, `scripts/stage-release.mjs`, `scripts/check-release.mjs`, `tests/appearance-boot.test.mjs`, `tests/release.test.mjs`.
- **의존 과제:** P3-05·12.
- **완료 기준:** 지정 동기 스크립트가 CSS 전에 실행되고 저장소 실패를 처리한다. 릴리스 검사는 정확한 두 스크립트만 허용한다.
- **완료 확인 명령:** `node --test tests/appearance-boot.test.mjs tests/release.test.mjs`; G.
- **예상 함정:** 일반 스크립트 무제한 허용으로 기존 HTML 검사를 약화.

## P3-14 — 표시 설정의 런타임 동기화

- **목적:** 개인 설정·정책·시스템 모드를 한 경로에서 적용한다.
- **만들 파일 4개:** `app/ui/appearance.js`, `app/main.js`, `app/preferences.js`, `tests/appearance.test.mjs`.
- **의존 과제:** P3-07·13.
- **완료 기준:** 시스템 변화·정책 제한·저장 실패·다른 탭 변경을 반영하고 부트 스크립트와 값 해석이 일치한다.
- **완료 확인 명령:** `node --test tests/appearance.test.mjs`; G.
- **예상 함정:** 강제 라이트 모드가 시스템 다크 CSS에 덮임.

## P3-15 — 헤더 언어 토글과 공유 배치

- **목적:** 세 언어를 항상 노출하고 P2-25 공유 진입점을 배치한다.
- **만들 파일 4개:** `app/ui/shell.js`, `app/main.js`, `styles.css`, `tests/ui-format.test.mjs`.
- **의존 과제:** P3-03·12, P2-25 인계.
- **완료 기준:** KO·EN·JA·화면·공유·설정의 헤더 구조와 저장 언어 복원, 문서/manifest 갱신, 연결 유지가 검증된다.
- **완료 확인 명령:** `node --test tests/ui-format.test.mjs`; G.
- **예상 함정:** UI언어 변경을 통역 목표어 변경으로 처리.

## P3-16 — 공통 모바일 시트·데스크톱 모달

- **목적:** 설정·공유·화면 창의 접근성 동작을 통일한다.
- **만들 파일 4개:** `app/ui/sheet.js`, `app/ui/shell.js`, `styles.css`, `tests/sheet.test.mjs`.
- **의존 과제:** P3-15.
- **완료 기준:** 상호 배타적 열기, inert, Tab/Shift+Tab, Escape, 포커스 복귀, 내용 스크롤·sticky 행동 영역을 구현한다.
- **완료 확인 명령:** `node --test tests/sheet.test.mjs`; G.
- **예상 함정:** 공유 동작 재구현, 시트를 열며 통역 중지, 닫힌 뒤 inert 잔존.

## P3-17 — 순차통역 반응형 화면

- **목적:** 모바일 PTT와 데스크톱 2열을 구현한다.
- **만들 파일 4개:** `app/ui/seq-view.js`, `styles.css`, `tests/ui-format.test.mjs`, `docs/p3-verification.md`.
- **의존 과제:** P3-12·16.
- **완료 기준:** 40/64rem, 좌 24rem·우 가변, 말풍선·상태·PTT 크기·DOM 순서를 반영한다.
- **완료 확인 명령:** `node --test tests/ui-format.test.mjs`; G.
- **예상 함정:** CSS order로 시각·키보드 순서 불일치, 긴 번역문 가로 넘침.

## P3-18 — 동시통역 자막판과 크기 상태

- **목적:** 자막판 디자인과 독립 크기 조절을 구현한다.
- **만들 파일 4개:** `app/ui/sim-view.js`, `app/preferences.js`, `styles.css`, `tests/sim-view.test.mjs`.
- **의존 과제:** P3-03·14·16.
- **완료 기준:** 가−/가+, 1~2rem, 고대비 옵션, partial/final/gap 구분, 최신 자막 동작·100개 상한을 유지한다.
- **완료 확인 명령:** `node --test tests/sim-view.test.mjs`; G.
- **예상 함정:** 글자 변경 시 스크롤 위치 초기화, 부분 토큰 낭독.

## P3-19 — 설정 섹션 재배치와 정책 잠금

- **목적:** P1-16 기능을 유지하며 새 설정 구조를 만든다.
- **만들 파일 4개:** `app/ui/settings-view.js`, `app/ui/policy-view.js`, `styles.css`, `tests/settings.test.mjs`.
- **의존 과제:** P3-02·03·07·16.
- **완료 기준:** 섹션 순서·설명·정책 버전·잠금 이유를 표시하고 기존 elements·PWA 삽입점·개별 진단을 보존한다.
- **완료 확인 명령:** `node --test tests/settings.test.mjs`; G.
- **예상 함정:** DOM 이동으로 PWA 버튼이나 diagnosticsView 참조 단절.

## P3-20 — 화면 버튼과 표시 설정 공통 컨트롤

- **목적:** 두 진입점이 동일한 표시 상태를 조작하게 한다.
- **만들 파일 5개:** `app/ui/display-view.js`, `app/ui/shell.js`, `app/ui/settings-view.js`, `app/main.js`, `tests/display-view.test.mjs`.
- **의존 과제:** P3-14·18·19.
- **완료 기준:** 모드·톤·글자·미리보기, 설정의 자막 슬라이더, 정책 잠금과 양쪽 즉시 동기화를 구현한다.
- **완료 확인 명령:** `node --test tests/display-view.test.mjs`; G.
- **예상 함정:** 각 컨트롤에 별도 저장 상태를 만들어 값 불일치.

## P3-21 — 공통 키 발급 안내 카드

- **목적:** 설정·첫 실행·키 없는 직접 통역 화면에 같은 안내를 제공한다.
- **만들 파일 5개:** `app/ui/key-guide.js`, `app/ui/settings-view.js`, `app/ui/shell.js`, `app/main.js`, `tests/key-guide.test.mjs`.
- **의존 과제:** P3-03·19.
- **완료 기준:** 고정 링크·새 탭 속성·3단계·첫 실행 표시와 허브 예외를 검증한다.
- **완료 확인 명령:** `node --test tests/key-guide.test.mjs`; G.
- **예상 함정:** 키 없는 허브 청취자를 가입 안내로 막음.

## P3-22 — 개인 키 표시·숨김과 저장 결과

- **목적:** 키 입력의 확인 가능성과 저장 상태를 개선한다.
- **만들 파일 3개:** `app/ui/settings-view.js`, `tests/settings.test.mjs`, `tests/privacy.test.mjs`.
- **의존 과제:** P3-21.
- **완료 기준:** 입력 중 토글·접근성 이름·저장 후 비움·닫기 후 숨김·remembered/메모리/실패 상태를 검증한다.
- **완료 확인 명령:** `node --test tests/settings.test.mjs tests/privacy.test.mjs`; G.
- **예상 함정:** 저장 키 자동 재노출, 공용 키 보기 허용, 저장 실패에도 성공 문구.

## P3-23 — 마이크 권한 서비스

- **목적:** 권한 요청·조회·스트림 소유권을 한곳에 모은다.
- **만들 파일 3개:** `app/audio/permissions.js`, `tests/audio-permissions.test.mjs`, `tests/fixtures/permissions.mjs`.
- **의존 과제:** P3-01.
- **완료 기준:** Permissions API 지원/미지원, 상태 change, 중복 요청, 거부·장치 오류 구분, 취소 후 늦은 스트림 정리를 검증한다.
- **완료 확인 명령:** `node --test tests/audio-permissions.test.mjs`; G.
- **예상 함정:** 조회 실패를 거부로 표시, 권한 요청 스트림 방치.

## P3-24 — 사용자 제스처와 마이크 상태 UI

- **목적:** 설정 저장·시작에 권한 사전 요청을 연결한다.
- **만들 파일 6개:** `app/platform.js`, `app/main.js`, `app/ui/audio-settings.js`, `app/ui/settings-view.js`, `tests/audio-settings.test.mjs`, `tests/app-lifecycle.test.mjs`.
- **의존 과제:** P3-03·19·23.
- **완료 기준:** 저장 시 probe 후 종료, 시작 시 스트림 인계, 허브·헤더에서 요청 0회, 거부 안내와 상태 갱신을 구현한다.
- **완료 확인 명령:** `node --test tests/audio-settings.test.mjs tests/app-lifecycle.test.mjs`; G.
- **예상 함정:** P1의 “키 저장 시 API 진단 금지”를 깨거나 이중 getUserMedia 호출.

## P3-25 — 장치 목록과 선택 저장

- **목적:** 장치 열람·기본값·장치 소실을 처리한다.
- **만들 파일 3개:** `app/audio/devices.js`, `app/preferences.js`, `tests/audio-devices.test.mjs`.
- **의존 과제:** P3-05·23.
- **완료 기준:** 권한 후 라벨, 입력/출력 목록, devicechange, 중복 제거, 사라진 ID 복구, 저장소 실패를 처리한다.
- **완료 확인 명령:** `node --test tests/audio-devices.test.mjs`; G.
- **예상 함정:** 장치 ID를 안정적인 영구 ID로 가정.

## P3-26 — 순차·직접 Live 입력 장치 적용

- **목적:** 선택한 마이크를 두 캡처 경로에 적용한다.
- **만들 파일 5개:** `app/platform.js`, `app/main.js`, `tests/capture.test.mjs`, `tests/stream-capture.test.mjs`, `tests/app-lifecycle.test.mjs`.
- **의존 과제:** P3-24·25.
- **완료 기준:** 공통 platform에서 audio constraints를 안전하게 병합하고, 장치 변경 시 종료 후 수동 시작을 요구한다. 사전 확보 스트림도 같은 선택을 따른다.
- **완료 확인 명령:** `node --test tests/capture.test.mjs tests/stream-capture.test.mjs tests/app-lifecycle.test.mjs`; G.
- **예상 함정:** mono·sample rate 설정 손실, 장치 변경 뒤 옛 스트림 재사용.

## P3-27 — PCM 출력 장치 라우팅

- **목적:** 지원 브라우저에서 실제 재생 context에 출력 선택을 적용한다.
- **만들 파일 4개:** `app/audio/output-device.js`, `app/main.js`, `tests/output-device.test.mjs`, `tests/app-lifecycle.test.mjs`.
- **의존 과제:** P3-25·26.
- **완료 기준:** context 생성·재생 전 sink 적용, 미지원·거부·장치 소실·늦은 전환 완료를 처리한다.
- **완료 확인 명령:** `node --test tests/output-device.test.mjs tests/app-lifecycle.test.mjs`; G.
- **예상 함정:** HTMLMediaElement 지원만 검사, speechSynthesis까지 출력이 바뀐다고 표시.

## P3-28 — 오디오 장치 설정 UI

- **목적:** 권한 상태와 입력·출력 선택을 사용자가 이해할 수 있게 연결한다.
- **만들 파일 4개:** `app/ui/audio-settings.js`, `app/main.js`, `styles.css`, `tests/audio-settings.test.mjs`.
- **의존 과제:** P3-24·26·27.
- **완료 기준:** 시스템 기본값, 라벨 갱신, PCM 지원 시 출력 노출, 기기 음성의 시스템 출력 안내, 변경 결과 표시를 구현한다.
- **완료 확인 명령:** `node --test tests/audio-settings.test.mjs`; G.
- **예상 함정:** 출력 선택을 적용하기 전에 성공 표시.

## P3-29 — 사용 시간·추정 비용 모델

- **목적:** UI와 분리된 사용량·가격표 계산을 구현한다.
- **만들 파일 4개:** `app/engine/usage.js`, `app/preferences.js`, `tests/usage.test.mjs`, `tests/fixtures/usage.mjs`.
- **의존 과제:** P3-04·05.
- **완료 기준:** Free/Paid, 능력·모델별 구간, 정책/개인 요율, 요율 revision 고정, 미측정·부분 추정, 중복 종료를 검증한다.
- **완료 확인 명령:** `node --test tests/usage.test.mjs`; G.
- **예상 함정:** 초·분 단위 혼동, 미확정 단가를 0으로 처리.

## P3-30 — 실행 경로별 사용량 연결

- **목적:** 실제 실행 구간을 추정 모델에 전달한다.
- **만들 파일 5개:** `app/providers/router.js`, `app/main.js`, `app/engine/usage.js`, `tests/usage-integration.test.mjs`, `tests/providers.test.mjs`.
- **의존 과제:** P3-07·29.
- **완료 기준:** 순차·Live·진단 구간의 시작/종료·실패·모델을 관측하고 재연결 중복을 방지한다. 허브 청중 비용은 제외한다.
- **완료 확인 명령:** `node --test tests/usage-integration.test.mjs tests/providers.test.mjs`; G.
- **예상 함정:** key·원문·오디오를 계측 이벤트에 전달, 페이지 열린 시간을 사용 시간으로 계산.

## P3-31 — 요금제·사용량·단가 설정 UI

- **목적:** 사용자가 Free/Paid와 허용된 추정 단가를 지정한다.
- **만들 파일 4개:** `app/ui/billing-view.js`, `app/ui/settings-view.js`, `app/main.js`, `tests/billing-view.test.mjs`.
- **의존 과제:** P3-03·19·30.
- **완료 기준:** Free 비용 숨김, Paid 추정/미설정/부분값, 가격표 출처·날짜, local override 잠금, 저장 결과를 표시한다.
- **완료 확인 명령:** `node --test tests/billing-view.test.mjs`; G.
- **예상 함정:** Paid 선택이 Google 결제를 활성화한다는 문구.

## P3-32 — 관리자 정책 편집 화면

- **목적:** 비밀 없는 정적 정책 편집기를 구현한다.
- **만들 파일 5개:** `admin/index.html`, `app/admin/main.js`, `app/admin/policy-editor.js`, `tests/admin-editor.test.mjs`, `scripts/check-i18n.mjs`.
- **의존 과제:** P3-02·04·12·13.
- **완료 기준:** 세 언어 부팅, 필드 편집·JSON 가져오기·검증·오류 위치·변경 미리보기와 관리자 HTML 검사 범위를 구현한다.
- **완료 확인 명령:** `node --test tests/admin-editor.test.mjs tests/i18n.test.mjs`; G.
- **예상 함정:** 가져온 JSON을 운영 정책으로 즉시 적용, HTML에 문구 하드코딩.

## P3-33 — 관리자 내보내기·발행 안내

- **목적:** 검증된 정책을 저장소에 반영할 산출물로 만든다.
- **만들 파일 4개:** `app/admin/export.js`, `app/admin/policy-editor.js`, `tests/admin-export.test.mjs`, `docs/policy-operations.md`.
- **의존 과제:** P3-32.
- **완료 기준:** JSON 다운로드·복사·수동 복사 fallback·object URL 정리·revision 증가·재조회 확인을 구현한다. 배포 호출은 없다.
- **완료 확인 명령:** `node --test tests/admin-export.test.mjs`; G.
- **예상 함정:** 다운로드를 발행 완료로 표시, 현재 revision 그대로 다른 내용 내보내기.

## P3-34 — 관리자 공용 키 payload 생성기

- **목적:** 정책 편집과 분리된 행사 payload 생성 기능을 제공한다.
- **만들 파일 4개:** `app/admin/shared-payload.js`, `app/admin/main.js`, `tests/admin-shared-payload.test.mjs`, `tests/privacy.test.mjs`.
- **의존 과제:** P3-08·33.
- **완료 기준:** 활성 행사 선택·v2 생성·기존 parser 왕복·길이 제한·만료 제한·명시적 복사·닫기 정리를 검증한다. 정책 내보내기에 키가 포함되지 않는다.
- **완료 확인 명령:** `node --test tests/admin-shared-payload.test.mjs tests/privacy.test.mjs`; G.
- **예상 함정:** P2-25 사이트 QR과 혼합, 테스트 키를 로그에 출력.

## P3-35 — 정책·관리자 릴리스 포장과 캐시 분리

- **목적:** 새 정적 자산을 배포하되 정책은 셸 캐시에서 제외한다.
- **만들 파일 6개:** `scripts/stage-release.mjs`, `scripts/check-release.mjs`, `sw.js`, `_headers`, `tests/release.test.mjs`, `tests/sw.test.mjs`.
- **의존 과제:** P3-13·32·34.
- **완료 기준:** root 정책·admin HTML 포장, 상대 참조, 관리자 앱 모듈 해시, 정책 network-only, 관리자 진입 캐시 제외, rollback 시 정책 보존을 구현한다.
- **완료 확인 명령:** `node --test tests/release.test.mjs tests/sw.test.mjs`; G.
- **예상 함정:** ROOT_FILES에 추가한 정책을 shellFor가 자동 precache, rollback으로 정책을 덮음.

## P3-36 — 배포 정책 검사와 릴리스 회귀

- **목적:** 유효하지 않은 정책·비밀 포함 산출물의 배포를 막는다.
- **만들 파일 4개:** `scripts/check-release.mjs`, `tests/release.test.mjs`, `tests/pwa-policy.test.mjs`, `docs/release-checklist.md`.
- **의존 과제:** P3-35.
- **완료 기준:** 스키마·등록 ID·최소 버전·정책 비밀·불필요 파일·두 HTML 진입점·이전 릴리스 호환을 검증한다.
- **완료 확인 명령:** `node --test tests/release.test.mjs tests/pwa-policy.test.mjs`; G. 임시 디렉터리에 `stage-release --id p3-check --out <임시경로>` 후 `check-release <임시경로>`.
- **예상 함정:** `_headers` 검사 통과를 GitHub Pages 실제 CSP·캐시 헤더 적용으로 기록.

## P3-37 — 세 언어 전체 문구 검토

- **목적:** 키 완전성뿐 아니라 자연스러운 문장을 확인한다.
- **만들 파일 5개:** `app/i18n/{ko,en,ja}.json`, `tests/i18n.test.mjs`, `docs/p3-language-review.md`.
- **의존 과제:** P3-20·21·22·28·31·34.
- **완료 기준:** 한국어·영어·일본어별 전체 검토를 기록하고 직역·용어 불일치·불명확한 버튼·무료/저장/권한 표현을 수정한다.
- **완료 확인 명령:** `node --test tests/i18n.test.mjs`; G.
- **예상 함정:** 키 수 일치만으로 번역 검토 완료 선언, 제공자 UI의 현재 문구를 검증 없이 단정.

## P3-38 — P3 통합·보안·접근성 회귀

- **목적:** 기능 조합에서 기존 P1/P2 계약을 보존한다.
- **만들 파일 4개:** `tests/p3-integration.test.mjs`, `tests/fixtures/p3-scenarios.mjs`, `tests/privacy.test.mjs`, `docs/p3-verification.md`.
- **의존 과제:** P3-11·17·18·20·22·28·31·36·37.
- **완료 기준:** 정책 실패·중지·복귀·키 교체·마이크 취소·장치 소실·시트 전환·언어 전환·업데이트 보류를 조합 검증한다. 비밀과 원문이 저장·로그·정책에 새로 흐르지 않는다.
- **완료 확인 명령:** `node --test tests/p3-integration.test.mjs tests/privacy.test.mjs`; G.
- **예상 함정:** 모의 DOM 결과로 430/768/1280px 화면 합격을 주장.

## P3-39 — 오케스트레이터 검수 인계와 운영 문서

- **목적:** 구현 완료와 실기기·배포 검증을 구분해 인계한다.
- **만들 파일 3개:** `docs/p3-verification.md`, `docs/policy-operations.md`, `docs/release-checklist.md`.
- **의존 과제:** P3-38.
- **완료 기준:** 세 폭·다크·톤·XL·200% 확대·키보드·마이크·출력 장치·첫 페인트·정책 CDN 반영·관리자 URL 검증표를 작성한다. 없는 증거는 미검증으로 남긴다.
- **완료 확인 명령:** G.
- **예상 함정:** 허브 서버가 확장 프로토콜을 보내지 않는데 실시간 통제 운영 완료로 표시.

오케스트레이터의 필수 실검증:

- 430/768/1280px에서 가로 스크롤·44px·포커스·시트·2열 배치.
- 네 톤의 라이트/다크, 시스템 변경, XL·200% 확대.
- 저장된 설정의 첫 페인트와 저장소 차단.
- iOS Safari·Android Chrome·데스크톱의 권한 거부/재허용.
- 실제 마이크 변경과 지원 브라우저의 PCM 출력 변경.
- `/interp-app/admin/` 직접 접근과 JSON 다운로드.
- 정책 배포·재조회·revision 표시·오프라인 제한.
- 허브 서버 확장 구현 전에는 fixture 검증까지만 완료 표시.

---

# 3. 오너 결정 항목

| 항목 | 추천안 |
|---|---|
| 기존 기록/xlsx P3의 처리 | 이번 P3에서 제외하고 별도 후속 백로그로 이관 |
| 앱 버전 | P3는 `0.7.0`, release ID와 별도 관리 |
| 정책 조회 실패 | 첫 실행은 통역 차단, 실행 중 마지막 정상 정책은 최대 5분 유지 |
| 정적 정책 확인 주기 | 전경 60초·전경 복귀·시작 직전 유효성 확인 |
| UI언어·접근성 잠금 | UI언어는 잠금 금지. 전체 글자·자막 크기도 기본적으로 사용자 선택 유지 |
| 첫 페인트 구현 | DESIGN.md의 main 최상단 방식을 외부 동기 부트 스크립트로 보완 |
| 공용 키 활성화 | 기본 OFF. 검증된 행사만 개별 활성화 |
| 관리자 QR 범위 | P3에서는 payload/링크 생성. 동적 QR 이미지 생성은 후속 |
| 직접 모드의 허브 통제 | 사용자 명시적 행사 참가 시 제어 전용 연결. 일반 개인 사용에는 강제 연결하지 않음 |
| Free/Paid 기본 | Free. 실제 프로젝트 요금제와 다를 수 있음을 표시하고 키 교체 시 확인 안내 |
| 비용 추정 방식 | 우선 운영 분당 추정 요율. 실제 토큰 기반 청구 추정이 필요하면 별도 어댑터 과제 추가 |
| 초기 단가 | 확인 전 빈 가격표. 임의 금액을 넣지 않고 Paid에서 “단가 미설정” |
| 키 표시 범위 | 입력 중 개인 키만 표시 허용. 저장 키 재조회·공용 키 보기는 제외 |
| 마이크 자동 요청 범위 | 직접 통역의 설정 저장·시작 제스처. 화면/언어/공유·허브 청취는 제외 |
| 미지원 허브 운영 | 기존 청취 유지 + 실시간 관리 미지원 표시. 지원하지 않는 통제를 지원한다고 표시하지 않음 |

위 추천안을 기본 구현 기준으로 삼으면 P3-01부터 진행할 수 있다. 실제 행사 허브 ID·활성 행사·초기 가격표는 검증된 운영 입력이 들어올 때 정책으로 발행한다.