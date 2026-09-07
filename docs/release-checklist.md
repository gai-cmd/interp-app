# 릴리스 체크리스트 (P1-21·P2-20·P2-23·P2-24)

기준 설계: `design-v0.6.md` §11.2(배포 산출물의 비밀 검사), §13(정적 배포·서비스 워커·업데이트), §16(P1 완료 상태), §17.4, §19(출시 보류 조건). 도구: `scripts/stage-release.mjs`, `scripts/check-release.mjs`, `scripts/check-i18n.mjs`.

**현재 상태(2026-09-06):** 아래 기록에 GitHub Pages 테스트 배포가 있다. 해당 호스트는 `_headers`를 적용하지 않으므로 로컬 CSP 검사 통과를 배포 CSP 적용 성공으로 판정하지 않는다. 개인 모드·PWA·공용·현장 허브·목표 규모 검증은 별도이며, 출시 판정은 §8의 보류 조건에 따른다.

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
- `_headers`가 그대로 올라가는지 확인한다(Cloudflare Pages용 설정이며 GitHub Pages에는 적용되지 않는다). 다른 호스트를 쓰면 같은 헤더를 호스트 설정으로 재현하고 §6에서 실제 응답을 확인한다.
- 배포 전 요약: 릴리스 ID, 커밋, 자동 게이트 결과, 바뀐 점, 롤백 대상 ID. 오너 동의 후 실행한다.
- 배포 시점의 무료 제공 조건과 헤더 적용을 확인한다(§13.1). 커스텀 도메인 구매·유료 기능은 도입하지 않는다.

## 6. 배포 후 확인

배포 URL을 `<origin>`이라 한다. 확인 전에는 "배포 완료"라고 하지 않는다.

| # | 확인 | 방법 | 기대 |
|---|---|---|---|
| 1 | 진입 파일 | `curl -sI <origin>/` , `curl -sI <origin>/sw.js` | 200, `Cache-Control: no-cache` |
| 2 | CSP·권한 헤더 | `curl -sI <origin>/` | `Content-Security-Policy`에 `connect-src 'self' https://generativelanguage.googleapis.com wss://generativelanguage.googleapis.com`, `Permissions-Policy: microphone=(self)`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'` |
| 3 | 릴리스 경로 | `curl -sI <origin>/releases/<id>/release.json` | 200, `Cache-Control: public, max-age=31536000, immutable` |
| 4 | MIME | `curl -sI <origin>/releases/<id>/app/i18n/ko.json`, `<origin>/manifest.ko.webmanifest`, `<origin>/releases/<id>/app/main.js` | `application/json`, `application/manifest+json`, `text/javascript` 계열. 사전은 fetch로 읽으며 JS 부팅 경로에는 JSON 모듈 import가 없다. worklet도 JavaScript MIME으로 제공되어야 한다 |
| 5 | 진입 HTML | `curl -s <origin>/ \| grep releases/` | 모든 버전 경로가 `./releases/<id>/…` |
| 6 | 브라우저 콜드 로드 | 데스크톱 브라우저 새 프로필로 `<origin>/` | 셸 렌더, 콘솔 0건, 설정 → 앱 → 버전이 `<id>` |
| 7 | 서비스 워커 | 개발자 도구 Application → Service Workers / Cache Storage | 활성 worker 1개, 캐시 `interp-shell-<id>`에 셸 파일만 |
| 8 | 실키 텍스트 통역 | 개인 키 입력(저장 안 함) → 텍스트 1회 | 결과 표시. 실키가 없으면 "미확인"으로 기록 |
| 9 | 업데이트 흐름 | 이전 릴리스를 열어 둔 기기에서 새로고침(또는 앱을 다시 앞으로 가져옴) | **자동 적용**(오너, 2026-09-07): 통역 중이 아니고 창이 1개면 버튼 없이 새 worker가 활성화되고 reload → 버전이 `<id>`. 통역 중이면 끝난 뒤, 창이 2개면 15초 간격으로 재시도하며 그동안 "업데이트" 버튼도 그대로 동작. `sw.js`는 `updateViaCache: 'none'`으로 받아 GitHub Pages의 10분 캐시를 우회 |
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
| 2026-09-06 · P2 | p2-20260906 | GitHub Pages (`gh-pages`) | https://gai-cmd.github.io/interp-app/ | check-release RELEASE_OK 71 · 배포 후 curl `/`, `sw.js`, `releases/p2-20260906/app/main.js`, `i18n/ja.json` 200·MIME 정확 · 헤드리스 Chrome 152 콜드 로드: 셸·SW·설정·동시통역 탭(내 폰 마이크/현장 방송 · 시작/중지/소리/원문/짧게 나눠/최신 자막) 렌더·예외 0 | **테스트 배포** · 실기기·실키·규모 검증 미실시(P2-23·24 보류) · `_headers` 미적용(GitHub Pages) |
| 2026-09-07 10:20 JST · P3-44 | p3-44-20260907 | GitHub Pages (`gh-pages` `985ae95`) | https://gai-cmd.github.io/interp-app/ | 소스 `fe61104` · 1003 테스트 통과 · I18N_OK 805키 · check-release `RELEASE_BUILTIN_KEY` → `RELEASE_OK releases=11 files=941` · 배포 후 curl `/`, `sw.js`, `policy.json`, `releases/p3-44-20260907/{release.json,app/main.js,app/security/builtin-key.js,app/i18n/ko.json}`, manifest 모두 200·MIME 정확 · 진입 HTML·SW RELEASE 줄이 `p3-44-20260907` 하나만 가리킴 | **내장 키 배포** (오너 결정, §내장 키) · 첫 방문 즉시 사용 + 홈 버튼 · 아스트라 P3-44 승인 · 롤백 대상 `p3-43-20260907` · 실기기·헤드리스 렌더·`_headers` 미적용(GitHub Pages) 미검증 · 오너에게 키 회전·예산 상한 권고 |
| 2026-09-07 · P3-45 | p3-45-20260907 | GitHub Pages (`gh-pages` `b0b8e2f`) | https://gai-cmd.github.io/interp-app/ | 소스 `04d233a` · 1004 테스트 · check-release RELEASE_OK releases=12 · 배포 후 curl 진입·SW·`sim-view.js`·`ko.json` 200 | 내장(무료) 키 429 시 "사이트 기본 키 한도" 문구 + 설정 열기 · 롤백 `p3-44-20260907` |
| 2026-09-07 · P3-46 | p3-46-20260907 | GitHub Pages (`gh-pages` `3bc5355`) | https://gai-cmd.github.io/interp-app/ | 소스 `cb291cc` · 1005 테스트 · check-release RELEASE_OK releases=13 files=1123 · 배포 후 curl 진입·SW·`main.js`·`pwa.js` 200, 자동 적용 코드 포함 확인 | **자동 업데이트**(유휴·단일 탭이면 버튼 없이 적용, `updateViaCache: 'none'`) · §6 9행 갱신 · 롤백 `p3-45-20260907` · push는 gai-cmd 토큰 일회 헬퍼 사용(gh 활성 계정이 kc-gai로 바뀌어 403) |


## P2-20 허브 등록과 릴리스 검증

- 실제 현장 주소가 입력되지 않아 등록 목록은 비어 있다. 임의 예시 주소를 제품 목록에 넣지 않는다. 빈 목록에서는 현장 방송 선택·방 코드 UI가 숨겨지고 부팅만으로 소켓이 열리지 않는다.
- 파일 범위와 P2-10·17 계약을 보존하기 위해 `app/hub/config.js`는 기존 `app/hub/protocol.js`의 `REGISTERED_HUBS`를 재사용한다. 현재 등록 원본은 protocol.js이며 config.js에 별도 목록을 만들면 안 된다. 향후 등록 또는 선언 이동은 protocol.js·main.js의 소비 경로를 함께 검토할 수 있는 과제에서 수행한다. 이것이 이번 파일 범위에 따른 설계 조정이며 의존 구현을 대체하지 않았다.
- 등록 항목은 `{ id, labelKey, url }` 형태다. 중복 ID, WSS 이외 프로토콜, 사용자 정보, `/ws` 이외 경로, query·fragment·비정규 URL을 거부한다. 이름은 세 언어 사전에 있는 키로 지정한다. 설정·QR·방 코드로 endpoint를 추가하지 않는다.
- `hubEndpoints()`와 `hubOrigins()`로 검증·중복 제거한 주소를 얻는다. 앱의 `ENDPOINT_ALLOWLIST`는 Gemini와 허브 endpoint를 합치고 `ENDPOINT_ORIGINS`를 도출한다. 허브는 청중 수신 주소이며 제공자 transport·키 정책을 바꾸지 않는다.
- 스테이징은 **선택된 불변 릴리스**의 app/config.js에서 CSP origin을 읽는다. endpoint 선언과 origin이 다르면 `RELEASE_CONFIG_INVALID`로 중단한다. `--point`도 이전 릴리스의 origin으로 헤더를 복원한다. 오래된 최소 구성 릴리스의 origin-only 인터페이스는 유지한다. 기존 check-release는 배포 루트의 모든 릴리스 origin이 같아야 통과한다. 따라서 허브 추가·제거로 origin이 바뀐 버전을 기존 버전과 함께 두면 CSP 불일치로 거부된다. 헤더 롤백 성공도 이 혼재 거부를 해제하지 않는다. 이전 파일 삭제나 CSP 합집합으로 우회하지 말고, 배포 전 별도 origin 이전 등 구버전 탭·롤백을 보존할 전환 계획을 후속 과제에서 검토해야 한다.
- `connect-src`는 `'self'`와 등록 origin만 포함한다. 허브 `/ws` 경로·방 코드는 CSP에 넣지 않는다. 인증서·DNS·게스트 Wi-Fi 접근과 실제 호스트의 CSP 응답은 현장에서 별도 확인한다.
- 허용 목록은 기존 `app/**/*.js`, `app/i18n/*.json`, styles.css 그대로다. P2-06 스트림 캡처는 기존 `capture-worklet.js`를 재사용하므로 새 worklet 파일 종류를 추가하지 않는다. 전체 JS의 상대 import와 `new URL(..., import.meta.url)` 참조가 서브패스 배포에서도 같은 버전 경로·SW 목록 안에 있는지 검사한다. worklet 누락 릴리스는 거부된다.
- 회귀 테스트는 빈 목록 실제 앱 부팅, 유효·무효 등록, 등록 허브 CSP와 기존 check-release 일치, 허브 없는 버전으로 롤백, JS·worklet 그래프, endpoint/origin 불일치를 다룬다. 기존 P1 테스트 단언을 수정하거나 삭제·건너뛰지 않았다. 새 원본 코드는 이식하지 않았다.

검증 명령은 `node --test tests/release.test.mjs`, 공통 G 세 명령, `node --test tests/`, 그리고 워크스페이스 내부의 새 `OUT`에 대한 다음 두 명령이다.

```sh
node scripts/stage-release.mjs --id p2-check --out "$OUT"
node scripts/check-release.mjs "$OUT"
```

로컬 검증과 실제 배포는 구분한다. P2-21 이후에는 실키·실기기·허브 접속·물리적 첫소리 지연·목표 규모를 별도 기록해야 한다. 방 코드는 메모리와 참가 WebSocket URL에서만 사용하며 측정 기록에 넣지 않는다. 이번 작업은 배포·git 커밋을 수행하지 않는다.

### 2026-09-06 P2-20 로컬 실행 결과

| 명령 | 결과 |
|---|---|
| `node --test tests/release.test.mjs` | 14 통과 |
| `node --test tests/*.test.mjs` | 586 통과, fail·todo·skip·취소 0 |
| `node --test tests/` | 내부 585 통과, 디렉터리 진입 1 통과 |
| `node scripts/check-i18n.mjs` | I18N_OK, 3개 언어·301개 키·57개 파일 |
| `git diff --check` | 통과 |
| `node scripts/stage-release.mjs --id p2-check --out /Users/gai/work/interp-app/release/p2-20-check-20260906-1` | RELEASE_STAGED, 71개 파일 |
| `node scripts/check-release.mjs /Users/gai/work/interp-app/release/p2-20-check-20260906-1` | RELEASE_OK, current=p2-check, releases=1, files=71 |

산출물은 git에서 제외되는 `release/` 아래에 보관했다. 변경한 소스·테스트·문서는 과제 지정 6개 파일뿐이다.

## P2-23 실기기·실키 수동 게이트 (2026-09-06)

**문서 정리 완료, 수동 검증 미완료.** 이번 오프라인 실행에서 실제 네트워크·기기 시험을 하지 않았다. [P2 실기기 결과](p2-device-results.md)가 원본 증거표이고 [기기 매트릭스 §9](device-matrix.md)는 환경별 지원 판정이다. 기존 P1/헤드리스/REST/voice 및 P2 모의 성공으로 아래 칸을 통과 처리하지 않는다.

| 게이트 | 해제에 필요한 증거 | 현재 판정·보류 범위 |
|---|---|---|
| 직접 개인 Live | A-W/A-P/I-W/I-P별 10분·6방향·M0/M1/M2 실제 결과, 방향별 표본·오류·정확도·누락·첨가 | 미검증 — 입력 대기. 해당 직접 조합 지원 보류 |
| 기기 수명주기·접근성 | F01~F12: 첫 로드·이어폰·권한·소리 켜기·중지·복귀·세션 소유권·세 언어·접근성·비밀 정리 | 미검증 — 입력 대기 |
| PWA 지원 | Android 설치·iPhone 홈 화면 각각 설치/캡처/재생/복귀, 이전→새 릴리스 업데이트와 활성·정리·다중 창 보류 | 미검증 — 입력 대기. 설치 조합 지원 보류 |
| 허브 수신 | H01~H07: 등록 WSS/서버 리비전·실제 CSP·키/마이크 없는 참가·최근 최대 30개·기기 TTS·중복/revision·접근 거부 | 미검증 — 입력 대기. 운영 허브 지원 보류 |
| 공용 직접 Live 제한 | 모델별·기기/회선별 내부/외부 신규, Wi-Fi→LTE 기존/신규, 제공자 키 폐기 기존/신규와 시각·표본·근거 | 미검증 — 입력 대기. 미확인 폴백을 포함한 해당 공용 경로 보류 |
| 지연·품질 | 내부 계측과 실제 자막/첫소리 분리, p50/p95/최대·표본/분모·실패율·오너 합격선 | 미검증 — 입력 대기. 성능 보장 보류 |
| 공개 대상·배포 | 이용 조건 확인일/근거/허용 대상·운영 방식, 실제 호스트 CSP/MIME·릴리스 검증. 기존 GitHub Pages 테스트 기록과 구분 | 미검증 — 입력 대기. 공개 출시 주장 보류 |
| 목표 규모·전체 길이 | P2-24 확정 N/L/T·언어/경로별 인원·지연/실패/누락 기준·최대 인원 전체 길이 증거 | 미검증 — 입력 대기. 행사 정원·운영 승인 보류 |

증거 접수 시 각 행에 기기·OS·브라우저·실행 형태·릴리스·실제 모델·시험일/담당·표본 수·관측값·근거 ID·제한을 연결한다. 자료 없는 행은 그대로 두고 실패를 기록에서 지우지 않는다. 모델·OS·브라우저·릴리스 변경 후 해당 조합을 재시험한다. 공용이나 PWA가 보류여도 개인 웹 경로는 자체 증거로 독립 판정할 수 있다.

이번 G 세 명령과 `node --test tests/` 결과는 [P2-23 로컬 완료 확인](p2-device-results.md)에 기록한다. 새 릴리스 스테이징·네트워크 확인·배포·커밋은 이번 작업에서 실행하지 않았다. 후속 배포에는 기존 자동/수동/배포 후 게이트를 다시 적용한다.

P2-24 인계: 현재 허브 3언어·150분 자동 종료·서버 송신 상한 부재, TTS ID 보관량 증가, 운영 계측 연결 누락과 허브 등록/CSP origin 변경 문제를 해소하거나 제한 범위에 반영한다. 10분 예비 시험이나 mock N개를 전체 예배·실제 청중 N명 합격으로 바꾸지 않는다.

## P2-24 목표 규모·전체 예배 운영 게이트 (2026-09-06)

**문서 정리 완료, 수동 완료 미충족·규모 합격 보류.** [결과 원장](p2-capacity-results.md)에 확정값·실측·장애 조치·운영 가능 범위를 연결한다. [시험 계획 §8](p2-capacity.md#8-p2-24-확정실측운영-승인-계약)과 [런북 §12](venue-runbook.md#12-p2-24-현장-판정과-장애-인계)를 적용한다. 기존 P1/P2-23 보류 조건은 그대로 유지한다.

| 게이트 | 확인 증거 | 현재 |
|---|---|---|
| 선행 기능 | P2-23 실제 기기·모델·경로·PWA/공용 제한·허브의 해당 조합 통과 | 입력 대기·미검증 |
| 목표·합격선 확정 | 오너·일시·판본, N/L/T·경로×언어 인원 합, 지연/실패/누락·기기/서버 중단선 | 미확정 |
| 최대 인원·전체 길이 | 실제 N_max 유지·전체 T·좌석/AP·기기·모델·서버·릴리스·분포와 C01~C12 | 미실행·미검증 |
| 서버 경계 | 실제 방송 언어 ≤3, 준비+예배+종료 여유와 150분 대조·종료 증거, 느린 수신자 영향 | 미검증 |
| 장시간 안정성 | 후반 누적 지연·배터리·발열·브라우저/허브 메모리·TTS ID 증가·AP·quota 추이 | 미측정 |
| 장애와 종료 | R01~R09 대응·실제 장애 ID·복구/누락·잔여 자원・키 폐기·재시험 | 미실행 |
| 운영 범위 공개 | 오너 승인 ID와 실측 근거에 연결된 정원·언어·음성/기기·좌석/AP·운영 길이·제외 조건 | 공개 보류 |

10분 예비·mock 가상 시간·여러 짧은 회차 합·자동 테스트 성공은 최대 규모 전체 예배 증거를 대체하지 않는다. 150분 초과 무중단 요구는 현 서버로 합격 불가이고 분할 재시작은 중단을 명시한 별도 계획·실측이 필요하다. 허브 실패 시 공용 Live로 청중 전체를 자동 전환하지 않는다.

승인 행이 없는 현재는 지원 정원·동시 언어·운영 시간을 공개하지 않는다. 개인 직접 모드는 P2-23 자체 증거로 독립 판정할 수 있으며 규모 보류가 자동 구현 검증을 막지는 않는다. 실제 출시에는 기존 이용 조건·호스트 CSP/MIME·배포 후 검증도 별도로 통과해야 한다. 이번 과제는 배포를 수행하지 않았다.

N/L/T·언어/경로 분포·좌석/AP·회선·기기·모델·서버·릴리스가 바뀌면 해당 범위를 재검증한다. 허브 등록/CSP 및 origin 변경 시 릴리스 혼재, 운영 계측 연결 누락은 선행 인계대로 남아 있다. 로컬 G와 `node --test tests/` 실행 결과는 [P2-24 로컬 완료 확인](p2-capacity-results.md#로컬-완료-확인)에 기록한다.

## P3-36 배포 정책 검사 (2026-09-06)

`check-release.mjs`가 배포 산출물의 `policy.json`을 **앱과 같은 validator**로 검사한다.
빌드 전용의 느슨한 검사는 없다. 다음 중 하나라도 걸리면 배포가 막힌다.

| 코드 | 뜻 |
|---|---|
| `RELEASE_POLICY_MISSING` | 배포 루트에 정책이 없음 |
| `RELEASE_POLICY_INVALID` | JSON 파싱 실패 또는 스키마 위반 (필드 경로 포함) |
| `RELEASE_POLICY_SECRET` | 공개 파일인 정책에 키·토큰 형태 필드가 있음 |
| `RELEASE_POLICY_VERSION` | `minAppVersion`이 지금 배포하는 앱 버전보다 높음 (자기 사이트에서 잠김) |

두 진입점(`index.html`, `admin/index.html`)이 모두 검사 대상이며, 둘 다 해당 릴리스를 가리켜야 한다.

### 여전히 미검증인 것

- **`_headers` 통과는 실제 응답 헤더가 아니다.** GitHub Pages는 이 파일을 적용하지 않는다.
  CSP·`no-store`·`no-cache`가 실제로 붙는지는 배포 후 `curl -I`로 확인해야 하고,
  그 증거가 없는 한 [p3-verification.md](p3-verification.md) V22·V27은 미검증으로 남는다.
- 정책 `no-store`는 요청 측 구현으로 보완하고 있으나, 그것이 헤더 적용의 증거는 아니다.

## 내장 키 (2026-09-07, 오너 결정)

이 빌드는 `app/security/builtin-key.js`에 Gemini 키를 **하나 담아 배포**한다. 설정한 적 없는 기기가 사이트를 열자마자 통역을 시작할 수 있게 해달라는 오너 요청이며, 오너가 아래 조건을 확인한 뒤 선택한 예외다.

- 키는 사이트를 여는 누구나 읽을 수 있다. 구글 공식 문서(<https://ai.google.dev/gemini-api/docs/api-key>)는 클라이언트 코드에 키를 넣지 말라고 권고하며, Generative Language API는 HTTP 리퍼러 제한이 확실하지 않아 사이트 도메인으로 키를 묶을 수 없다.
- 그 키로 나가는 모든 호출은 오너의 구글 계정에 과금된다. **Google Cloud 프로젝트에 예산 상한을 걸어두고**, 이상 사용이 보이면 즉시 회전한다.

검사와 배포에서의 취급:

- `scripts/check-release.mjs`의 비밀 스캔은 그대로 살아 있다. `SECRET_EXEMPT_FILES`에 적힌 이 파일 **하나만** 예외이고, 다른 파일에서 키가 나오면 여전히 `RELEASE_SECRET_PATTERN`으로 배포가 거부된다.
- 예외는 조용히 통과하지 않는다. 키를 담은 릴리스는 `check-release`가 `RELEASE_OK` 앞줄에 `RELEASE_BUILTIN_KEY releases/<id>/app/security/builtin-key.js`를 찍는다. **§3 게이트 6번의 기대 출력에 이 줄이 포함된다.** 이 줄이 없으면 키 없는 빌드를 배포하는 것이므로 의도한 상태인지 확인한다.
- `tests/privacy.test.mjs`는 이 파일만 예외로 두고 나머지 소스·릴리스 산출물의 키 스캔을 그대로 유지한다.

키 회전 절차:

1. <https://aistudio.google.com/apikey>에서 새 키를 발급하고 이전 키를 삭제한다.
2. `app/security/builtin-key.js`의 `BUILTIN_KEY` 값을 새 키로 바꾼다.
3. `node --test tests/*.test.mjs` → `node scripts/check-i18n.mjs` → 새 `--id`로 `stage-release` → `check-release`(`RELEASE_BUILTIN_KEY` 줄 확인) → §5 배포.

키 없이 배포하려면 `BUILTIN_KEY`를 `''`로 두면 된다. 그러면 앱은 이 파일이 없던 때와 똑같이 동작한다(키 입력 화면이 유일한 입구). 앱 안에서의 우선순위는 **이 기기에 저장된 개인 키 > 공용 이벤트 키 > 내장 키** 순이고, 내장 키는 localStorage에 절대 기록되지 않는다.


### P3-44 기본 키 표시·삭제 계약

설정과 배지는 사이트 기본 키 사용을 별도로 표시한다. 내장 키의 입력란 재노출·표시·삭제는 허용하지 않고, 개인 키 입력은 허용한다. 개인 키 삭제 시 공용 키가 없는 경우 기본 키로 복귀하며 활성 작업은 정리하고 자동 재시작하지 않는다. 공용 키 종료·만료는 자동 개인 전환을 일으키지 않는다. 내장 키가 없는 빌드는 기존 키 없음 동작을 유지한다.

`rememberPersonalKey` 금지는 새 개인 키 저장에 적용하며 기본 키는 항상 메모리에서 사용한다. 요금제 화면은 기본 키 호출의 운영자 계정 청구와 Free/Paid 표시 설정의 차이를 안내한다. Live WebSocket 인증 URL은 기존 자격증명 전달 예외이며 페이지 URL·이력·사이트 공유 QR에는 키가 없어야 한다. 상세 결정은 `docs/design-p3.md`의 P3-44 절을 따른다.
