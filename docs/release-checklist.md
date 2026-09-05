# 릴리스 체크리스트 (P1-21)

기준 설계: `design-v0.6.md` §11.2(배포 산출물의 비밀 검사), §13(정적 배포·서비스 워커·업데이트), §16(P1 완료 상태), §17.4, §19(출시 보류 조건). 도구: `scripts/stage-release.mjs`, `scripts/check-release.mjs`, `scripts/check-i18n.mjs`.

**현재 상태(2026-09-05):** 구현 완료. 로컬 스테이징(`p1-review`)과 `check-release`는 통과했다. **공개 HTTPS 배포는 아직 없고**, 개인 모드·PWA·공용 검증은 미완료다(`device-matrix.md` §6). 출시 판정은 §6의 보류 조건에 따른다.

## 1. 원칙

- 정적 파일만 배포한다. 번들러·런타임 npm·서버 함수·새 유료 서비스를 쓰지 않는다(§13.1). 기본 대상은 Cloudflare Pages 무료 정적 호스팅이다.
- 릴리스 디렉터리 `releases/<id>/`는 **절대 덮어쓰거나 삭제하지 않는다**(§13.2). 진입 파일(`index.html`, `sw.js`)만 현재 릴리스를 가리킨다.
- 배포 루트는 여러 릴리스를 누적해 보관하는 **한 곳의 로컬 디렉터리**로 유지한다(저장소 밖 권장, 예 `~/deploy/interp-app`). 저장소 안 `./release`는 검토용 임시 경로다(`.gitignore` 포함). 같은 `--id`를 다시 스테이징하면 `RELEASE_EXISTS`로 거부된다.
- 배포·롤백은 외부 효력 행위다. 실행 전에 무엇을·왜·영향 범위·되돌리는 법을 요약해 오너 승인을 받는다.
- 배포 산출물·명령 인자·기록에 실제 키를 넣지 않는다(§17.4).

## 2. 릴리스 ID

- 형식: `RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/` (설정 화면의 버전 표시와 `app/pwa.js` `VERSION_PATTERN`도 같은 형식).
- 권장: `p1-YYYYMMDD` 또는 `p1-YYYYMMDD-n`. 검토용은 `p1-review`처럼 배포 ID와 구분한다.
- ID는 캐시 이름(`interp-shell-<id>`)·경로(`releases/<id>/`)·설정의 버전 표시에 그대로 쓰인다. 한 번 배포한 ID는 재사용하지 않는다.

## 3. 출시 전 자동 게이트

저장소 루트에서 순서대로 실행하고 출력을 기록한다. 하나라도 실패하면 진행하지 않는다.

| # | 명령 | 기대 출력 | 2026-09-05 결과 |
|---|---|---|---|
| 1 | `git status --short` / `git log -1 --format=%h` | 작업 트리 깨끗함, 커밋 해시 기록 | `c31bfb1` |
| 2 | `node --test tests/*.test.mjs` | `pass N, fail 0, todo 0` | 337 통과 / 0 / 0 |
| 3 | `node scripts/check-i18n.mjs` | `I18N_OK languages=3 keys=… files=…` | `I18N_OK languages=3 keys=205 files=39` |
| 4 | `git diff --check` | 출력 없음 | 통과(P1-20b) |
| 5 | `node scripts/stage-release.mjs --id <id> --out <배포 루트>` | `RELEASE_STAGED id=<id> files=52` | `p1-review` → 52 |
| 6 | `node scripts/check-release.mjs <배포 루트>` | `RELEASE_OK current=<id> releases=<n> files=<m>` | `RELEASE_OK current=p1-review releases=1 files=52` |

`check-release`가 검사하는 것(§11.2, §17.4): 허용 목록 밖 파일 거부, 심볼릭 링크 거부, 비밀 패턴(`AIza…`, `sk-…`, JWT, PEM, `#shared=` payload 등), `release.json` SHA-256 일치, `index.html`이 한 릴리스의 모듈만 참조, `sw.js`의 RELEASE 줄과 셸 목록 일치, `_headers`의 CSP `connect-src`가 `'self'` + `ENDPOINT_ORIGINS`(현재 `https://generativelanguage.googleapis.com`, `wss://generativelanguage.googleapis.com`)와 정확히 일치, `Permissions-Policy: microphone=(self)`, `/sw.js` `no-cache`.

주의:

- 비밀 검사는 패턴 기반이며 부재 증명이 아니다. 릴리스 검토와 제공자 측 키 관리는 별도로 유지한다.
- 배포 루트에 `.DS_Store` 등 허용 목록 밖 파일이 있으면 `RELEASE_UNEXPECTED_FILE`로 실패한다(의도된 동작).
- `--out`은 저장소 자신이나 상위 디렉터리를 가리킬 수 없다(`RELEASE_OUT_INVALID`).
- 릴리스에 들어가는 파일: 루트 `index.html`, `sw.js`, `_headers`, `manifest.{ko,en,ja}.webmanifest`, `icons/icon-192.png`, `icons/icon-512.png`; 버전 경로 `releases/<id>/styles.css`, `releases/<id>/app/**/*.js`, `releases/<id>/app/i18n/*.json`, `releases/<id>/release.json`. 테스트·문서·스크립트는 제외된다.

## 4. 출시 전 수동 게이트

`device-matrix.md`의 절차와 판정을 참조한다. 각 항목의 상태를 릴리스 기록(§8)에 옮긴다.

| 항목 | 요구 | 현재 |
|---|---|---|
| 헤드리스/데스크톱 브라우저 스모크 | 콜드 로드 부팅, 44px, SW 등록, 설정, 키 저장 정책, 언어 전환, fragment 제거, 콘솔 0, 잘못된 키 처리 | 검증(Chrome 152, 2026-09-05) |
| 개인 모드 실키(절차 1) | Android Chrome·iPhone Safari 6방향×10발화, 지연 측정 | 미검증 |
| PWA(절차 2) | 설치·캡처·재생·중단·복귀·업데이트 | 미검증 |
| 공용 제한(절차 3·4) | 행사 회선 내부 허용·외부 거부, 이동, 폐기 | 미검증 |
| 키 잔존(절차 5) | 실기기 개발자 도구 확인 | 부분(헤드리스 모의만) |
| 이용 조건(절차 6) | 확인일·근거·공개 대상 | 미확인 |

개인 모드가 미검증인 채로 배포하면 "테스트 배포"로만 표시하고 공개 안내·홍보를 하지 않는다. 공용 경로가 미검증이어도 개인 경로의 검증과 배포 준비는 계속한다(§16).

## 5. 배포

### 5.1 배포 루트 준비

1. 누적 배포 루트(예 `~/deploy/interp-app`)에 이전 릴리스 디렉터리가 그대로 있는지 확인한다. 처음이면 빈 디렉터리로 시작한다.
2. `node scripts/stage-release.mjs --id <id> --out <배포 루트>` 실행. 새 `releases/<id>/`가 추가되고 루트 진입 파일이 새 ID로 다시 쓰인다.
3. `node scripts/check-release.mjs <배포 루트>` → `RELEASE_OK current=<id> releases=<n>` 확인. `n`은 누적 릴리스 수다.

### 5.2 정적 호스트 업로드 (승인 필요)

- 배포 루트 **전체**(이전 `releases/*` 포함)를 Cloudflare Pages 프로젝트에 올린다. 이전 릴리스 디렉터리를 빼면 아직 그 버전을 가리키는 열린 탭·캐시가 깨진다(§13.2).
- `_headers`가 그대로 올라가는지 확인한다(Pages는 루트의 `_headers`를 적용한다). 다른 호스트를 쓰면 같은 헤더를 호스트 설정으로 재현하고 §5.3에서 확인한다.
- 배포 전 요약: 릴리스 ID, 커밋, 자동 게이트 결과, 바뀐 점, 롤백 대상 ID. 오너 동의 후 실행한다.
- 배포 시점의 무료 제공 조건과 헤더 적용을 확인한다(§13.1). 커스텀 도메인 구매·유료 기능은 도입하지 않는다.

## 6. 배포 후 확인

배포 URL을 `<origin>`이라 한다. 확인 전에는 "배포 완료"라고 하지 않는다.

| # | 확인 | 방법 | 기대 |
|---|---|---|---|
| 1 | 진입 파일 | `curl -sI <origin>/` , `curl -sI <origin>/sw.js` | 200, `Cache-Control: no-cache` |
| 2 | CSP·권한 헤더 | `curl -sI <origin>/` | `Content-Security-Policy`에 `connect-src 'self' https://generativelanguage.googleapis.com wss://generativelanguage.googleapis.com`, `Permissions-Policy: microphone=(self)`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'` |
| 3 | 릴리스 경로 | `curl -sI <origin>/releases/<id>/release.json` | 200, `Cache-Control: public, max-age=31536000, immutable` |
| 4 | MIME | `curl -sI <origin>/releases/<id>/app/i18n/ko.json`, `<origin>/manifest.ko.webmanifest`, `<origin>/releases/<id>/app/main.js` | `application/json`, `application/manifest+json`, `text/javascript` 계열. JSON MIME이 틀리면 `app/main.js`의 JSON 모듈 import가 실패해 앱이 뜨지 않는다 |
| 5 | 진입 HTML | `curl -s <origin>/ \| grep releases/` | 모든 버전 경로가 `./releases/<id>/…` |
| 6 | 브라우저 콜드 로드 | 데스크톱 브라우저 새 프로필로 `<origin>/` | 셸 렌더, 콘솔 0건, 설정 → 앱 → 버전이 `<id>` |
| 7 | 서비스 워커 | 개발자 도구 Application → Service Workers / Cache Storage | 활성 worker 1개, 캐시 `interp-shell-<id>`에 셸 파일만 |
| 8 | 실키 텍스트 통역 | 개인 키 입력(저장 안 함) → 텍스트 1회 | 결과 표시. 실키가 없으면 "미확인"으로 기록 |
| 9 | 업데이트 흐름 | 이전 릴리스를 열어 둔 기기에서 새로고침 | "새 버전이 있어요" → 통역 종료 후 "업데이트" → 창 1개일 때 reload → 버전이 `<id>`. 창이 2개면 "다른 탭을 닫은 뒤 업데이트하세요" |
| 10 | 키 잔존 | `device-matrix.md` 절차 5 | URL·콘솔·저장소·캐시에 키 없음 |
| 11 | 실기기 | `device-matrix.md` 절차 1·2 중 가능한 범위 | 결과와 미검증 항목을 기록 |

확인 결과는 §8 양식에 적는다. 4·6·7이 실패하면 §7로 즉시 롤백한다.

## 7. 롤백 (§13.2)

잘못된 배포는 이전 릴리스를 가리키는 진입 파일로 복구한다. 릴리스 디렉터리는 건드리지 않는다.

1. 되돌릴 이전 ID `<prev>`가 배포 루트의 `releases/<prev>/release.json`에 있는지 확인한다.
2. `node scripts/stage-release.mjs --point <prev> --out <배포 루트>` → `RELEASE_POINTED id=<prev> files=…`. 루트 `index.html`·`sw.js`·복사 파일만 다시 쓴다.
3. `node scripts/check-release.mjs <배포 루트>` → `RELEASE_OK current=<prev>`.
4. 배포 루트 전체를 다시 업로드한다(승인 필요).
5. §6의 1·3·5·6·7을 다시 확인한다. `/`와 `/sw.js`가 `no-cache`이므로 새 방문은 즉시 이전 릴리스를 받는다.
6. 이미 새 버전을 쓰던 기기는 `sw.js` 변경을 업데이트로 인식한다. 자동 적용은 없으므로 사용자가 통역을 마친 뒤 "업데이트"를 눌러야 하며, 그 전까지 열린 탭은 기존 릴리스 파일을 계속 사용한다(디렉터리를 지우지 않았으므로 깨지지 않는다).
7. 롤백 사유·시각·대상 ID를 §8에 기록하고, 문제 릴리스 ID는 재사용하지 않는다.

`--point`는 스테이징된 릴리스가 없으면 `RELEASE_NOT_FOUND`, 매니페스트 파일이 빠졌으면 `RELEASE_MANIFEST_INVALID`로 거부된다.

## 8. 출시 보류 조건과 판정 (§19)

| 위험 | 처리·보류 범위 | 2026-09-05 판정 |
|---|---|---|
| 특정 능력에서 IP 제한 미검증·실패 | 해당 공용 직접 경로 보류 | **보류** — 공용 경로 전체 미검증 |
| 물리적 위치 절대 제한 불가 | 승인된 한계로 정확히 고지 | 고지 문구 확정(`venue-runbook.md` §1) |
| 공용 무료 한도 부족 | 정원 축소·개인 키·허브. 유료 자동 전환 없음 | 정원 미확정(P2) |
| iOS PWA 불안정 | 해당 조합의 음성 지원 제한, Safari 안내 | **미검증** — iOS 홈 화면 앱 음성은 지원 범위 밖 |
| 미리보기 모델 변경 | 기능 검사·명시적 설정·검증된 폴백 | 폴백 등록됨, 실제 응답 미확인 |
| 생성형 목소리 누락·첨가 | 자막 기준·정확도 시험·기기 음성 선택 | 정확도 시험 미실행 |
| 좌석 음질 부족 | 좌석·입력 개선 또는 믹서 허브 | P2 |
| 현장 HTTPS·Wi-Fi 격리 실패 | 허브 지원 보류, 개인 직접 경로 유지 | P2 |
| 제공자 이용 조건 미확인 | 해당 공개 대상·운영 방식 출시 주장 보류 | **보류** — `terms.status = unreviewed` |
| 브라우저 키 노출 | 메모리 기본·배포 보안·폐기 절차 | 구현·문서화됨, 실기기 잔존 확인 미완 |
| 직접 호출 불가 제공자 | 검증된 허브 없으면 사용 불가 | 해당 없음(P1 Gemini만) |
| 다른 제공자의 비용·한도·조건 미검증 | 등록·활성화 보류 | 등록 없음 |
| 실키·실기기 시험 자료 없음 | 구현 완료와 출시 검증 완료를 분리 | **분리 기록** — 구현 완료, 출시 검증 미완료 |

판정 규칙:

- **공개 출시**: 개인 모드 검증 완료 + 이용 조건 확인 + 배포 후 확인 통과. 현재 **불가**.
- **테스트 배포**(오너·스태프만, 홍보 없음): 자동 게이트 + §6 확인 통과면 가능. 실키·실기기 시험을 진행하기 위한 단계다.
- **공용 키 운영**: 위에 더해 행사별 제한 시험 통과. 현재 **불가**.
- **대규모 설교 운영**: P2 용량 시험 후. P1 결과로 확대 선언하지 않는다.

## 9. 출시 기록 양식

| 항목 | 값 |
|---|---|
| 릴리스 ID | |
| 날짜·시각 | |
| 소스 커밋 | |
| 배포 URL·호스트 | |
| 자동 게이트(§3) 출력 요약 | |
| 수동 게이트(§4) 상태 | |
| 배포 후 확인(§6) 결과 | |
| 배포 구분 | 테스트 배포 / 공개 출시 / 공용 운영 |
| 승인자·승인 시각 | |
| 롤백 대상 ID | |
| 미검증·보류 항목 | |

### 2026-09-05 기록

| 항목 | 값 |
|---|---|
| 릴리스 ID | `p1-review` (로컬 검토용, 미배포) |
| 소스 커밋 | `c31bfb1` |
| 자동 게이트 | 337 통과 / I18N_OK 205키 / RELEASE_STAGED 52 / RELEASE_OK 52 |
| 수동 게이트 | 헤드리스 Chrome 152 스모크 통과. 나머지 미검증 |
| 배포 구분 | 없음(배포 미실행) |
| 미검증·보류 | 개인 모드 실키, PWA, 공용 제한, 이용 조건, 실기기 키 잔존 |

## 출시 기록 (추가)

| 날짜 | 릴리스 ID | 호스트 | URL | 검사 | 비고 |
|---|---|---|---|---|---|
| 2026-09-05 21:37 JST | p1-20260905 | GitHub Pages (`gai-cmd/interp-app`, 브랜치 `gh-pages`) | https://gai-cmd.github.io/interp-app/ | check-release RELEASE_OK 52 · 배포 후 curl: `/`, `sw.js`, manifest, `releases/…/app/main.js`, `i18n/ko.json` 모두 200·정확한 MIME · 헤드리스 Chrome 152 콜드 로드 스모크 통과(셸·SW 등록·설정·키 비저장·콘솔 0) | **테스트 배포**(§19 판정: 공개 출시 아님). GitHub Pages는 `_headers`(CSP·Permissions-Policy)를 적용하지 않음 → 헤더까지 필요하면 Cloudflare Pages로 이전. manifest `id`는 `/interp-app/`로 고정. 실기기(Android/iOS)·실키 검증은 미실시 |
