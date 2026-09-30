# Gemini Live API 동시통역 활용 검토

- 구현 상태 (2026-09-30): P1 중 goAway 교체를 예산·대기 없이 즉시(60초 미만 연결 제외), `timeLeft` 동안 출력 수신(입력도 계속, 턴 경계에서 교체), `usageMetadata` 기록, `sessionResumption` + `contextWindowCompression`(trigger 12000 / target 6000, 지시문 경로만)을 구현했어요. '일시 오류 때 모델을 바꾸지 않기'는 아직이에요(핸들을 실은 setup이 거부된 경우만 같은 모델로 다시 열어요). 3.8-live·native-audio가 두 setup 필드를 받아들이는지는 실제 키로 확인하기 전이에요(미검증). 자세한 규칙은 `docs/design-p2.md` §9에 있어요.
- 작성일: 2026-09-30
- 대상 저장소: `/Users/gai/work/interp-app`. 읽기만 했고 수정하지 않았어요.
- 방법: 문서를 읽고 코드를 판독했어요. 어떤 키로도 API를 호출하지 않았어요. 그래서 "실제로 받아들여지는지"는 모두 실측이 필요해요.
- 검증: 2026-09-30에 인용한 URL을 다시 가져와 주장과 대조했고, 파일:줄도 다시 열어 확인했어요. 틀리거나 근거가 약한 곳은 본문에서 고쳤어요. 가장 큰 수정은 과금 방식이에요. Live 세션은 턴마다 쌓인 컨텍스트 전체가 다시 과금돼요 [D20][C7].
- 전제 (오너 확인, 2026-09-30)
  - 앱의 설계 전제는 바뀌지 않았어요. 서버 없는 브라우저 앱이고, Developer API 엔드포인트에서 무료 등급 키나 개인 키로 동작해야 해요.
  - 사이트 기본 키 칸에 유료 키를 넣은 건 오너의 운영 선택이에요. 새 전제가 아니에요.
  - 그래서 아래 권고는 모두 무료 키에서 동작해야 해요. 이득이 유료 키에서만 생기는 항목에는 **유료 키에서만 이득**이라고 표시했어요. 유료 기능을 중심으로 다시 설계하지 않아요.
- 표기
  - `[코드]`: 저장소의 파일:줄을 직접 읽어 확인한 내용
  - `[미검증]`: 추정, 계산, 또는 문서에 없는 내용
  - `[D1]`, `[C5]`, `[G1]` 같은 표시는 출처 링크예요. URL은 5)에 모아 두었어요. D는 Gemini Developer API(ai.google.dev), C는 Agent Platform(docs.cloud.google.com), G는 Google Cloud 공통(결제·쿼터) 문서예요.

---

## 0) 한 줄 결론

오너가 링크한 문서의 권장 모델 `gemini-3.8-live`는 이미 앱의 기본 모델이고, Developer API로 연결돼 있어요. Cloud 엔드포인트로 옮기려면 토큰 서버와 결제 프로젝트가 필요하고, 무료 키로는 쓸 수 없게 돼요. 그래서 옮기지 않는 게 맞아요. 지금 구조에서 효과가 큰 건 세 가지예요.

1. 약 10분마다 오는 연결 교체를 매끄럽게 하기: goAway 처리, 재시도 예산, 세션 재개와 압축. 단, 압축 한도는 낮게 잡아요. 턴마다 쌓인 컨텍스트 전체가 다시 과금되기 때문이에요 [D20]
2. 이어지는 발화에서 통역이 잘리지 않게 하기: `activityHandling`과 VAD
3. 자막 품질 높이기: 전사 옵션과 중간 전사

비용과 한도 소진은 분당 단가가 아니라 턴 수와 컨텍스트 길이에 따라 커져요. 그래서 세션 재개처럼 컨텍스트를 늘리는 기능을 켜기 전에 `usageMetadata`로 턴당 토큰부터 재요.

---

## 1) 'Cloud Live API를 기본으로 연결'의 실제 의미와 현재 상태

### 1.1 지금 코드가 실제로 하는 일 `[코드]`

| 항목 | 현재 값 | 위치 |
|---|---|---|
| WebSocket 엔드포인트 | `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` (Developer API) | `app/providers/gemini/live-client.js:14` |
| 인증 | API 키를 `?key=` 쿼리로 붙여요. 브라우저 WebSocket은 헤더를 붙일 수 없다는 주석이 있어요 | `live-client.js:231-233` |
| 모델 이름 형식 | `models/<id>`이고, 정규식 `^models/...`로 검사해요 | `live-config.js:219`, `live-client.js:52` |
| 기본 모델 | `gemini-3.8-live` (2026-09-24 오너 결정) | `live-config.js:14-16` |
| 폴백 순서 | 3.8-live → 3.5-live-translate-preview → 2.5-flash-native-audio-latest | `live-config.js:27-28`, `app/providers/gemini/index.js:23-26, :34-45` |
| 확장 기본값 | 탭 레인은 번역 전용 모델, 마이크 레인은 3.8-live | `extension/lib/settings.js:39-43` |
| CSP와 허용 목록 | `connect-src`에는 generativelanguage 호스트만 있어요. Vercel 배포도 이 파일에서 헤더를 만들어요(`scripts/vercel-json.mjs:15`) | `_headers:8`, `app/config.js:16-17` |
| Agent Platform 참조 | `app/`, `extension/`, `docs/`에 `aiplatform` 참조가 없어요 | grep 결과 (검증 단계에서 다시 확인) |

정리하면, 오너가 링크한 한국어 개요 페이지가 권장하는 모델(`gemini-3.8-live`, GA)은 이미 기본값이에요 [C1]. 다만 그 페이지가 설명하는 **제품**인 Agent Platform(`aiplatform.googleapis.com`)에는 연결돼 있지 않아요. 같은 이름의 모델을 Developer API 쪽에서 부르고 있어요. 두 제품은 엔드포인트, 인증, 과금, 데이터 약관이 모두 달라요 [C18][D16].

앱이 부르는 곳은 generativelanguage뿐이에요(`live-client.js:14`, `_headers:8`). 따라서 오너가 기본 키 칸에 넣은 유료 키도 Developer API 유료 등급 키예요. 유료 등급의 이점은 Cloud로 옮기지 않아도 이미 기본 키 사용분에 적용되고 있어요. 제품 개선에 쓰지 않는다는 점은 문서로 확인했어요 [D10][D12]. 한도가 더 높다는 점은 추정이에요 [D11] `[미검증]`.

그 개요 페이지에는 엔드포인트, 세션 한도, goAway, 재개, 필드명이 나오지 않아요 [C1]. 그래서 설계 판단은 하위 페이지와 레퍼런스를 근거로 했어요.

### 1.2 Cloud(Agent Platform)로 바꾸려면 필요한 것

| 필요한 것 | 근거 |
|---|---|
| 엔드포인트를 `wss://{LOCATION}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`로 교체 | [C5] |
| 모델별 리전 확인. 번역 전용 모델은 모델 페이지상 global만 돼요 [C4]. 3.8-live는 모델 페이지에 us·eu 멀티리전과 us-central1만 있고 global이 없지만 [C3], 위치 페이지에는 global 목록에도 올라 있어요 [C17]. 문서끼리 달라서 엔드포인트가 하나로 되는지 둘이 필요한지는 `[미검증]`이에요 | [C3][C4][C17] |
| 모델 이름을 `projects/{p}/locations/{l}/publishers/google/models/{id}` 형식으로 바꾸고, `live-client.js:52`의 정규식을 완화 | [C6], `[코드]` |
| 인증을 OAuth 2.0 Bearer 토큰(`Authorization` 헤더, ADC)으로 교체. 토큰을 발급할 서버가 필요해요 | [C5][C12] |
| 결제가 활성화된 Google Cloud 프로젝트와 Agent Platform API 활성화 | [C13] |
| CSP(`_headers:8`), `ENDPOINT_ALLOWLIST`(`app/config.js:16-17`), REST 모델 탐색(`app/providers/gemini/model-discovery.js`) 교체 | `[코드]` |
| 2.5 모델 ID 변경. Cloud 쪽 ID는 `gemini-live-2.5-flash-native-audio`예요 | [C21] |
| 필드 표기 확인. 레퍼런스는 snake_case로 적혀 있고, camelCase JSON도 받는지는 문서에 없어요 `[미검증]` | [C6] |

### 1.3 서버 없는 브라우저 앱이 Cloud Live에 인증할 수 있나요?

**문서 기준으로는 안 돼요.**

- Agent Platform Live 레퍼런스의 Limitations 항목을 보면, 이 API는 서버 간 인증만 제공하고 클라이언트에서 직접 쓰는 건 권하지 않아요. 클라이언트 입력은 중간 애플리케이션 서버를 거치라고 해요 [C6].
- WebSocket 인증 예시는 `Authorization: Bearer` 헤더뿐이에요 [C5]. 브라우저 `WebSocket`은 커스텀 헤더를 붙일 수 없어요(`live-client.js:231` 주석).
- `access_token` 쿼리 파라미터, API 키, ephemeral token을 Cloud Live WebSocket에 쓰는 방법은 레퍼런스에 없어요 [C6]. 쿼리 토큰을 실제로 받는지는 확인하지 못했어요 `[미검증]`.
- 공식 WebSocket 튜토리얼도 Python 백엔드(`server.py`)가 인증과 프록시를 맡는 구조예요 [C12].
- ephemeral token은 Developer API의 Live 문서에서만 설명하고, Cloud Live 레퍼런스에는 나오지 않아요 [D7][C6]. 어느 쪽이든 발급하려면 API 키를 가진 서버가 필요해요 [D7].
- Express mode API 레퍼런스에는 `generateContent`, `streamGenerateContent`, `countTokens`만 있고 `BidiGenerateContent`는 없어요 [C15]. Express mode 무료 체험은 Google Cloud를 처음 쓰는 @gmail.com 계정에만 최대 90일 동안 주어지고, 지원 모델 목록에 Live 모델이 없어요 [C14]. 개요 페이지에 Gemini 2.0 모델은 콘솔이 아니라 API나 SDK로 Live를 쓰라는 메모가 있지만, 3.8-live와 번역 전용 모델은 목록에 없어서 결론은 같아요 [C14].
- AI Studio(Developer API) 키가 aiplatform에서 통한다는 문서는 없어요. 통하지 않을 것으로 봐요 `[미검증]` [D16][C18].

결론적으로 Cloud로 가려면 **토큰 서버나 프록시**가 반드시 필요해요. "서버 없음" 전제와 충돌해요.

참고로 Developer API 문서도 클라이언트 앱에서는 API 키를 코드에 넣지 말고 서버가 발급한 ephemeral token이나 백엔드 프록시를 쓰라고 권해요 [D6][D7][D17]. 지금 구조(브라우저가 키로 직접 연결)는 이 권고와 다르지만, 오너가 이미 정한 운영 방식이라 여기서 다시 논의하지 않아요.

### 1.4 비용, 데이터, 키 운영

**키 종류별 비교**

| | 무료 등급 키 (Developer API, 사용자 개인 키) | 유료 키 (Developer API, 지금 사이트 기본 키) | Agent Platform (Cloud) |
|---|---|---|---|
| 요금 | 3.8-live와 3.5-live-translate-preview 모두 무료 등급의 입출력이 'Free of charge'예요 [D10] | 3.8-live: 오디오 입력 $3.00/1M(약 $0.005/분), 출력 $12.00/1M(약 $0.018/분). translate: 입력 $3.50/1M(약 $0.0053/분), 출력 $21.00/1M(약 $0.0315/분) [D10]. 단, 턴마다 쌓인 컨텍스트 전체가 다시 과금돼서 실제 비용은 분당 단가보다 커요 [D20][C7] | 결제가 필수예요 [C13]. 가격 페이지는 본문이 잘려 확인하지 못했어요 [C19] `[미검증]`. 번역 전용 모델은 스펙표에서 PayGo를 포함한 과금 방식이 모두 'Not supported'로 표기돼 있어요 [C4] |
| 데이터 사용 | 제품 개선에 쓰이고 사람이 검토할 수 있어요. 민감정보, 기밀, 개인정보를 넣지 말라고 해요. EEA, 스위스, 영국 사용자에게 제공할 때는 유료 서비스만 써야 해요 [D12] (약관 최종 수정 2026-04-28). 약관상 '유료'는 결제가 켜진 Cloud 프로젝트를 통해 쓰는 경우라서, 결제가 켜진 프로젝트의 키는 여기 해당하지 않아요 [D12] | 제품 개선에 쓰지 않아요 [D10][D12] | 제품 개선에 쓰지 않아요 [C18] |
| 한도 | 한도는 키가 아니라 프로젝트 단위로 걸려요. 무료 등급 수치는 AI Studio에서 확인하라고만 하고, Live 동시 세션 수는 문서에 없어요 [D11]. 포럼 답변은 Live 한도가 동시 세션이 아니라 분당 토큰(TPM) 기준이라고 해요 [D19] | Tier 1부터 결제 계정 연결이 필요해요 [D11]. 등급마다 결제 계정 단위 월 지출 상한이 있어요(Tier 1 $250, Tier 2 $2,000). 상한에 닿으면 연결된 프로젝트가 다음 청구 주기까지 멈춰요 [D11][D18]. 무료 등급보다 한도가 높을 것으로 보지만, 수치는 AI Studio에서 확인해야 해요 `[미검증]` | PayGo 기준 프로젝트당 동시 세션 1,000개 [C5]. 레퍼런스에는 5,000개와 4M TPM으로 적혀 있어 서로 달라요 [C6] |
| 서버 | 필요 없어요 | 필요 없어요 | 토큰 서버가 필요해요 (1.3) |

**참고 계산** `[미검증]`

- 하한: 분당 단가 × 60분, 세션 하나 기준이에요. 유료 키로 한 시간 통역하면 3.8-live는 입력 약 $0.30에 출력은 모델이 말한 시간만큼 최대 약 $1.08이에요. translate는 입력 약 $0.32에 출력 최대 약 $1.89예요.
- 이 계산은 **하한**이에요. Developer API 문서는 턴(사용자 입력 하나와 모델 응답)마다 세션 컨텍스트에 쌓인 토큰 전체를 다시 과금하고, 쌓인 오디오 토큰도 턴마다 오디오 입력 단가로 매긴다고 적고 있어요 [D20]. Cloud 문서도 같은 내용이에요 [C7]. 오디오는 초당 약 25토큰씩 쌓여요 [D10][D20][C7].
- 지금 앱은 약 10분마다 새 연결을 열어서 컨텍스트가 연결당 약 10분 분량(입력만 약 15,000토큰)으로 묶여 있어요. 그래도 400ms VAD로 턴이 자주 닫히면 같은 오디오가 여러 번 과금돼요.
- 예를 들어 5초마다 턴이 닫힌다고 가정하고 입력 오디오만 세면, 10분 연결 하나에 과금 입력이 약 90만 토큰(약 $2.7)이 돼요. 한 시간이면 약 $16이에요. 출력 오디오도 컨텍스트에 쌓이면 더 커져요. 모두 가정이라 `[미검증]`이에요.
- 턴 없이 연속으로 번역하는 번역 전용 모델에 같은 방식이 적용되는지는 문서에 없어요 `[미검증]`.
- 전사 텍스트 토큰은 텍스트 출력 단가로 따로 붙어요 [D20][C7].
- 확장에서 탭 레인과 마이크 레인을 함께 켜면 세션이 둘이라 대략 두 배예요.
- 정확한 값은 `usageMetadata`를 기록해서 재야 해요(2의 P1).

**유료 키 관련 사실 (한 번만 적어요)**

사이트 기본 키 칸의 유료 키는 공개 페이지에 실려 나가요. 그래서 누구든 꺼내 쓸 수 있고, 그렇게 쓴 요금은 오너 결제 계정으로 청구돼요. Gemini API 키 문서도 키가 새면 남이 프로젝트 쿼터를 쓰고 예상하지 못한 요금이 생길 수 있다고 적고 있어요 [D17]. 위 참고 계산처럼 비용이 턴 수에 따라 커지므로 안전장치가 더 중요해요. 키를 넣기로 한 결정은 다시 논의하지 않아요. 아래는 추가 비용 없이 걸 수 있는 안전장치예요.

- **예산 알림(Cloud Billing budget)**: 실제 비용이나 예측 비용이 기준을 넘으면 메일을 보내요. 기본 기준은 50%, 90%, 100%예요. 알림만 보내고 지출을 막지는 않아요 [G1] (최종 업데이트 2026-09-24).
- **지출 상한 예산(spend cap budget, preview)**: 지원 서비스 목록에 Gemini API가 있어요. 상한을 넘으면 사용을 멈추고, 오너가 직접 풀 때까지 멈춰 있어요. 집행이 즉시 되지 않아서 넘친 금액은 그대로 청구돼요 [G2] (2026-09-24). Gemini API 결제 문서에도 프로젝트 단위 월 지출 상한이 있는데, 실험 기능이고 약 10분 늦게 집행된다고 적혀 있어요 [D18]. 두 문서 모두 이 기능 자체의 요금은 언급하지 않아요.
- **등급별 월 상한**: 결제 계정 등급마다 월 지출 상한이 따로 있어요(Tier 1 $250). 다만 지출과 기간 조건을 채우면 상위 등급과 더 높은 상한이 적용될 수 있어요(Tier 2: $100 이상 지출과 3일 경과) [D11][D18]. 자동으로 올라가는지는 `[미검증]`이에요.
- **API 제한**: AI Studio에서 키를 "Gemini API만"으로 제한할 수 있어요. 2026-05-07부터 오래 쓰지 않은 무제한 키는 차단되고, 2026-05-28부터 새 키는 기본적으로 Gemini API로 제한된 auth key로 만들어져요 [D17]. 요청 출처 제한은 문서에 IP 주소 예시만 나와요. 웹사이트 제한이 가능한지, Live WebSocket 연결에 적용되는지는 문서로 확인하지 못했어요 `[미검증]`.
- **쿼터 상한**: Cloud 콘솔의 Quotas에서 프로젝트 단위로 한도를 낮출 수 있어요. 키 단위가 아니에요. 문서는 설정 요금을 언급하지 않고, 한도를 넘은 뒤 집행되기까지 약간 지연이 있다고 해요 [G3] (2026-09-24).

**무료 키 사용자의 데이터**

사용자가 결제가 꺼진 프로젝트의 무료 키를 넣으면 통역 음성과 전사가 무료 등급 약관을 따라요 [D12]. 앱은 이 경우에도 동작해야 하므로 설계는 그대로 두고, 필요하면 안내 문구만 검토하면 돼요(4의 오너 결정 참고).

---

## 2) 지금 구조(Developer API)에서 바로 효과가 큰 개선

파일 경로는 저장소 루트 기준이에요. 공수는 S(하루 이내), M(며칠), L(그 이상)이에요. "무료 키" 칸은 무료 등급 키에서의 동작 여부예요. Live API 필드를 바꾸는 항목은 모두 실제 음성으로 A/B해야 해요. 실제 키 호출은 오너 승인이 필요해요.

| 우선 | 기능 | 동시통역에 주는 효과 | 현재 상태 | 필요한 변경 | 위험 | 공수 | 무료 키 | 출처 |
|---|---|---|---|---|---|---|---|---|
| P1 | goAway를 재시도 예산에서 빼고 곧바로 재연결 | 연결 교체(약 10분마다) 때 공백이 줄어요. 음성 출력도 자막도 없는 긴 구간에서 세션이 갑자기 끝나는 위험이 사라져요 | goAway 재연결도 예산 4회 중 1회를 써요(`live-recovery.js:17`). 예산은 연결 뒤 음성이나 자막(원문 전사 포함) 이벤트가 나오고 60초 안정일 때만 다시 채워져요(`live-recovery.js:35-39, :57-63`, `sim.js:128, :134`). 재시도 정책에도 3회 상한과 1·2·4초 백오프가 따로 있어요(`app/engine/retry.js:147-149`). goAway는 UNAVAILABLE로 스케줄돼서(`live-recovery.js:65-66`) 창 안의 첫 재연결은 1~1.25초, 이어지면 2~2.5초, 4~5초를 기다려요. 음성도 자막도 없이 goAway가 네 번 오면(약 40분) `BUDGET_EXHAUSTED`로 끝날 수 있어요 `[미검증]` 코드 추론 | goAway는 `live-recovery.js` 예산과 `retry.js` 재시도 상한 둘 다에서 빼고, 따로 세는 상한(짧은 간격으로 연달아 오는 goAway 대비)을 둬요. 대기 없이 재연결해요 | 코드 위험은 낮아요. 다만 design-p2 §9가 "계획 교체도 추가 연결 예산에 포함한다"고 정해 두었어서(`docs/design-p2.md:238`) 오너 결정이 필요해요 | S | 동작 | [D5], `[코드]` |
| P1 | 일시 오류 때 모델을 바꾸지 않기 | 회선이 잠깐 흔들릴 때 통역 경로(지시문 통역, 번역 전용, 답변 가능한 모델)가 바뀌지 않아요 | `UNAVAILABLE`이나 `NETWORK_ERROR` 한 번에 재시도보다 다음 모델 교체가 먼저예요(`live-recovery.js:7, :54-56`, `app/providers/gemini/index.js:23-26`). 송신 버퍼가 12 KiB를 넘어도 UNAVAILABLE로 끊어서(`live-client.js:17, :124-128`) 같은 교체 경로를 타요 | 일시 오류는 같은 모델로 먼저 재시도하고, 모델 교체는 `MODEL_UNSUPPORTED`/`SETTINGS_UNSUPPORTED`일 때만 해요 | 낮아요. 폴백 정책이라 오너 결정이 필요해요 | S | 동작 | `[코드]` |
| P1 | `usageMetadata` 기록 (재개·압축보다 먼저) | 세션별, 턴별 토큰을 알 수 있어요. 턴마다 컨텍스트 전체가 과금되므로 [D20], 재개·압축을 켜기 전후를 비교하는 기준이 돼요. 무료 키에서는 TPM 한도 소진을 예측하고, 기본 유료 키에서는 비용을 볼 수 있어요 | 무시해요(`live-client.js:169`) | 세션별 토큰 합계와 턴당 프롬프트 토큰을 metrics에 남겨요 | 낮아요 | S | 동작 (비용 가시화 이득은 **유료 키에서만**) | [D1][D20][C7] |
| P1 | `sessionResumption` + `contextWindowCompression` | 재연결 뒤에도 이름, 용어, 양방향 방향 판단 같은 맥락이 이어져요. 압축이 없으면 오디오 세션은 15분에서 끝나고, 압축을 켜면 길이 제한이 사실상 없어요 | 둘 다 보내지 않아요(`live-config.js:219-221`). `sessionResumptionUpdate`는 무시해요(`live-client.js:169`). goAway 때마다 맥락 없는 새 세션을 열어요(`sim.js:113-120`, `:173-187`) | setup에 `sessionResumption: { handle }`을 넣고, `resumable`일 때 `newHandle`을 저장해 재연결에 넘겨요. `contextWindowCompression: { slidingWindow: { targetTokens }, triggerTokens }`도 함께 켜요. `triggerTokens` 기본값(컨텍스트 창의 80%, 약 10만 토큰)은 쓰지 말고 낮게 잡아요. 턴마다 컨텍스트 전체가 다시 과금되기 때문이에요 [D1][D20]. 값은 `usageMetadata`로 재면서 정해요 `[미검증]` | 재개로 컨텍스트가 연결을 넘어 이어지면 턴당 과금 토큰이 늘어요. 유료 키에서는 비용이 늘고, 무료 키에서는 TPM 한도에 닿아 429(`RATE_LIMITED`)로 작업이 끝날 수 있어요(`sim.js:34, :214`) `[미검증]`. 반대로 압축을 낮은 한도로 켜면 지금보다 턴당 토큰이 줄 수도 있어요 `[미검증]`. Developer API의 `SessionResumptionConfig`에는 `handle`만 있어서 transparent 재전송이 없어요. 재접속 중 입력 손실은 그대로예요 [D1]. 번역 전용 모델이 두 기능을 지원하는지는 문서에 없어요 `[미검증]` | M | 동작하지만 토큰 사용량이 늘 수 있어요(낮은 압축 한도와 실측 전제) | [D1][D5][D20] |
| P1 | goAway의 `timeLeft` 동안 출력 받기 | 교체 직전에 나오던 통역 음성과 자막을 버리지 않아요 | goAway를 받으면 `timeLeft`를 기다리지 않고 바로 닫아요(`live.js:124-130`). 재생 큐와 진행 중 자막도 버려요(`sim.js:113-120`) | 입력은 멈추되 현재 턴의 `turnComplete`나 `timeLeft` 직전까지는 수신하고, 그다음 닫아요 | 낮아요. design-p2 §9(`docs/design-p2.md:236`, goAway를 받으면 이전 연결을 닫음)를 바꾸는 일이라 오너 결정이 필요해요 | S~M | 동작 | [D1][D5][C5] |
| P2 | `realtimeInputConfig.activityHandling: NO_INTERRUPTION` | 화자가 짧게 쉬었다 이어 말할 때 이미 나오던 통역 음성이 잘리지 않아요 | 보내지 않아서 기본값 `START_OF_ACTIVITY_INTERRUPTS`(끼어들기)가 적용돼요. `interrupted`가 오면 재생 큐와 진행 중 자막을 버려요(`live-config.js:221`, `live.js:134-139`, `sim.js:164`) | flash 경로 setup에 필드 하나 추가 | 통역이 밀리며 지연이 쌓일 수 있어요. 재생기는 8초를 넘으면 따라잡기로 버려요(`stream-player.js:21-24, :136-142`). 번역 전용 모델이 받아들이는지는 `[미검증]`이에요. 거부(1007)되면 폴백이 발동해요 | S | 동작 | [D1] |
| P2 | VAD `silenceDurationMs` 조정 | 문장 중간에서 턴이 쪼개지는 현상과 첫 음성 지연 사이의 균형이 맞춰져요. 턴이 덜 쪼개지면 턴당 컨텍스트 재과금 횟수도 줄 수 있어요 `[미검증]` | 400ms, prefix 100ms, START_HIGH, END_LOW예요. 주석상 측정값이 아니라 정책값이에요(`live-config.js:33-38`) | 400/600ms를 A/B해서 `speechEndToFirstAudioMs`, interrupted 수, `repliesSkipped`를 비교해요(`listen-metrics.js:5-11`). `interrupted` 카운터는 이름만 있고 `sim.js:164`가 세지 않으니, caption-store 통계(`caption-store.js:79`)를 쓰거나 기록을 추가해요 | 값을 늘리면 지연이 커져요 | S | 동작 | [D4] |
| P2 | 전사 옵션(`languageCodes`, `customVocabulary`)과 `interimInputTranscription` | 원문 자막이 더 빨리 뜨고(중간 전사), 고유명사 인식이 좋아져요 | `inputAudioTranscription: {}`이라 하위 옵션이 없어요(`live-config.js:220`). 중간 전사는 파싱하지 않아요(`live.js:140-144`) | 원문 언어나 언어쌍을 힌트로 넣고, 고유명사 목록 설정을 추가해요. 중간 전사는 설정 없이 서버가 보내는 필드라 [D1] partial 자막으로 보여 줘요 | 하위 옵션이 번역 전용 모델과 3.8-live에서 받아들여지는지 `[미검증]`이에요(과거 1007 전례가 있어요). Cloud 문서는 `custom_vocabulary`를 3.8-live에 새로 생긴 기능으로 적어요 [C10]. 전사 개선이 통역 음성 품질까지 올리는지도 `[미검증]`. 전사를 켜면 토큰이 추가돼요 [D20][C7] | M | 동작 | [D1][C7][C10] |
| P2 | 번역 전용 경로만 100ms 청크 | 번역 전용 모델 문서의 권장값에 맞춰요. 초당 메시지가 31건에서 10건으로 줄어서, 확장 offscreen의 타이머 부담도 줄어들 것으로 봐요 `[미검증]` | 모든 경로가 32ms, 1024B예요(`uplink-queue.js:4-5`, `live-config.js:39-40`, `stream-capture.js:14`, `live-client.js:17`). 에이전트 모델 권장값은 20~40ms라서 3.8-live 경로는 이미 맞아요 | 번역 경로만 3200B/100ms로 분기하고 A/B해요. 네 곳의 상수와 송신 버퍼 상한을 함께 바꿔야 해요 | 첫 음성이 약 70ms 늦어질 수 있어요 `[미검증]` | M | 동작 | [D2][C7][C4] |
| P2 | 세 번째 폴백 모델 재검토 | 폴백이 실제로 열리는 모델로 채워져요 | `gemini-2.5-flash-native-audio-latest`(`live-config.js:27-28`)는 Developer API 모델 목록에 없어요. 목록에 있는 2.5 Live 모델은 `gemini-2.5-flash-native-audio-preview-12-2025`이고, 2.5 모델 접근은 2026-09-18부터 과거에 쓰던 사용자로 제한됐어요 [D13][D14] | 오너 키(무료 키와 유료 키 모두)에서 모델 탐색으로 열리는지 확인하고, 교체하거나 뺄지 정해요. 후보는 `gemini-3.8-live-extended-thinking`(Stable, 지연 `[미검증]`)과 `gemini-3.1-flash-live-preview`(레거시이고 3.8로 이전하라고 권하는 모델)예요 | 낮아요 | S | 확인 필요 | [D13][D14] |
| P3 | 입력 설정 반영과 에코 | 사용자 필터와 감도 설정이 Live에도 적용돼요 | 마이크는 EC, NS, AGC가 켜져 있어요(`stream-capture.js:95-97`). 번역 경로는 `echoTargetLanguage:false`예요(`live-config.js:246`). 이 설정이면 입력이 이미 목표 언어일 때 모델이 침묵해요 [D2]. 하지만 Live 캡처는 worklet `configure`를 보내지 않아서 사용자 필터·감도 설정 대신 worklet 기본값이 쓰여요(`capture.js:201-202`와 비교) | `stream-capture`에서도 `configure`를 보내요. 스피커 모드의 ducking(재생 중 입력 줄이기)은 따로 검토해요 | ducking을 넣으면 재생 중 화자의 말을 놓칠 수 있어요 | S | 동작 | [D2], `[코드]` |
| P3 | 모델 탐색 버그 | 설정에서 고른 모델로 시작이 실패하지 않아요 | 탐색된 모델을 `setModel`은 받는데(`sim.js:315-318`), `start`는 `LIVE_MODELS`에 없는 모델을 `MODEL_UNSUPPORTED`로 거부해요(`sim.js:270`, `live-config.js:203`) | 선택지를 `LIVE_MODELS`로 제한하거나, 탐색된 모델의 경로를 등록해요 | 낮아요 | S | 동작 | `[코드]` |
| 실험 | 번역 전용 모델로 양방향(방향별 세션 둘) | 연속 번역 모델로 양방향 대화를 할 수 있어요 | 양방향이면 3.8-live로 보내요(`sim.js:265-269`) | 목표 언어를 A와 B로 각각 준 세션 둘에 같은 마이크 입력을 넣고 `echoTargetLanguage:false`로 둬요 | 문서에 없는 방식이에요 `[미검증]`. 세션과 비용이 두 배예요. 무료 키의 동시 세션 한도가 문서에 없어요 [D11] | L | 확인 필요 (동시 세션 여유는 **유료 키에서만** 확실) | [D2] |

### 항목별 메모

- **재연결 항목은 한 묶음이에요.** 지금은 약 10분마다 연결이 교체될 때 이런 일이 생겨요 [D5].
  1. 진행 중 출력을 버려요.
  2. 1초 넘게 기다려요.
  3. 맥락 없는 새 세션을 열어요.
  4. 그동안 들어온 입력은 버퍼에 쌓지 않아요(`sim.js:287-291`).

  위 P1 항목으로 1, 2, 3을 줄일 수 있어요. 4는 Developer API에 transparent 재개가 없어서 [D1] 앱 쪽에서 재연결 중 입력을 몇 초 버퍼에 두었다가 새 세션에 다시 보내야만 줄어요. design-p2 §9는 "최근 발화를 다시 보내지 않는다"로 정해져 있어서 오너 결정이 필요해요 `[코드]` (`docs/design-p2.md:232-243`). 같은 절이 goAway를 받으면 이전 연결을 닫고(`:236`), 계획 교체도 예산에 포함한다고(`:238`) 정해 두었으므로, goAway 예산과 `timeLeft` 항목도 같은 오너 결정에 묶여요.
- **새 세션을 미리 여는 방식은 권하지 않아요.** goAway 뒤 새 세션을 먼저 열고 옛 세션을 닫으면 공백이 가장 작아요. 하지만 잠깐이라도 세션이 둘이 돼요. 무료 키의 동시 세션 한도는 공식 문서에 없고 [D11], 포럼에서 Google 측으로 보이는 답변자가 동시 세션은 보장하지 않고 한도는 분당 토큰 기준이라고 답했어요 [D19]. 그래서 기본 설계로는 넣지 않아요. 여유가 확실한 건 **유료 키에서만**이에요.
- **재개와 압축은 함께 켜야 해요.** 지금은 goAway마다 새 세션을 열어서 15분 한도에 닿지 않아요. 재개만 켜면 세션이 이어지므로 15분에서 끝나요 [D5]. 오디오는 초당 약 25토큰씩 쌓여요 [D20][C7]. 컨텍스트 창은 128k 토큰(3.8-live는 131,072)이에요 [C3][D3]. 입력 오디오만으로 채우면 약 85분, 기본 압축 기준(80%)까지는 약 68분이라는 계산이에요. 출력 오디오도 쌓이면 더 빨라요 `[미검증]`. 턴마다 이 컨텍스트 전체가 다시 과금되므로 [D20], 압축 기준을 기본값에 두면 턴당 토큰이 수만 개가 될 수 있어요. 낮은 기준에서 시작해요.
- **activityHandling과 VAD는 2×2로 시험해요.** 끼어들기가 켜진 지금은 400ms 쉼마다 턴이 닫힐 수 있고, 화자가 다시 말하면 통역 음성이 잘릴 수 있어요 [D1] `[코드]`. A/B는 끼어들기 on/off × 400/600ms로 권해요. VAD 문서는 서버 VAD 기준으로 500~800ms를 권장하고 기본값을 약 800ms로 적어요. 100~200ms처럼 짧으면 자연스러운 쉼에서 발화가 쪼개지고, 2000ms를 넘으면 지연이 눈에 띈다고 해요. prefix 기본값은 20ms예요 [D4]. 번역 전용 모델은 턴을 기다리지 않고 연속으로 번역하는 방식이라 [D2] VAD 값이 영향을 주는지 `[미검증]`이에요.
- **번역 전용 모델에서 문서가 말하는 설정**은 `translationConfig`의 `targetLanguageCode`와 `echoTargetLanguage`뿐이에요. 문서는 100ms 청크를 권장해요 [D2]. 우리 코드는 이 경로에도 VAD와 `prebuiltVoiceConfig`를 보내는데(`live-config.js:217-221`), 적용되는지는 `[미검증]`이에요. 문서는 긴 멈춤 사이나 여러 화자일 때 목소리가 일정하지 않을 수 있다고 적고 있어요 [D2]. 이 경로에서는 UI가 "선택한 목소리"를 약속하지 않는 편이 안전해요.
- **경로별 모델**: 한 사람이 길게 말하는 경우(탭 영상, 강연)에는 턴을 기다리지 않는 번역 전용 모델이 지연 면에서 유리할 것으로 봐요 `[미검증]` [D2][C4]. 확장 탭 레인은 이미 그렇게 돼 있어요(`extension/lib/settings.js:39-43`). 웹앱 기본은 2026-09-24 오너 결정으로 3.8-live예요. 이 결정은 그대로 두고, 측정 결과만 참고 자료로 드릴게요.
- **전사 설정 위치**: 번역 전용 모델 문서 예시는 전사 설정을 `generationConfig` 안에 두고 [D2], API 레퍼런스는 setup 최상위 필드로 적어요 [D1]. 코드는 2026-09-07 실측에서 `generationConfig` 안에 둔 설정이 1007로 거부됐다는 기록에 따라 최상위에 둬요(`live-config.js:240-246`). 실측 기록이 있으니 지금 배치를 유지해요.
- **오래된 주석과 문서**: 기본 모델이 번역 전용이라고 적힌 곳이 남아 있어요. `live-config.js:126-129`, `sim.js:51-53, :217-218, :261-262`, `docs/design-p2.md:83-97`이에요. 2026-09-24 이후 기본은 3.8-live예요 `[코드]`.

### 해당 없음, 또는 하지 말 것

| 기능 | 판단 | 근거 |
|---|---|---|
| Proactive audio | 3.8-live에서는 항상 켜져 있고, `false`로 보내면 오류가 나요. 끌 수 없으니 설정하지 않아요. 관련 없는 소리에 모델이 침묵하는 데는 도움이 될 수 있어요. 다만 우리 프롬프트가 "이 음성은 너에게 하는 말이 아니다"라고 지시하므로(`live-config.js:251`), 모델이 통역할 발화까지 건너뛰는지 누락률을 재 봐야 해요 `[미검증]`. 답변 감지(`live-config.js:132-173`)는 그대로 둬요. Cloud 문서에 따르면 모델이 침묵하는 동안 출력 오디오 토큰은 과금되지 않아요 [C9]. 입력 컨텍스트는 턴마다 그대로 과금돼요 [D20] | [D3][C9] |
| Affective dialog | 3.8-live에서는 API에서 제거됐어요. 설정하지 않아요 | [D3] |
| Thinking | 3.8-live는 thinking 설정을 받지 않아서 빼야 해요. 코드는 보내지 않아요(`live-config.js:24-25`). `-extended-thinking` 변형(Stable)은 지연이 늘 것으로 봐서 통역 기본값으로는 권하지 않아요 `[미검증]` | [D3][D13] |
| `speechConfig.languageCode` | Developer API의 native audio 모델은 언어를 스스로 고르고 이 값을 지원하지 않아요. 언어는 system instruction으로 제한하라고 해요. 지금 코드가 그렇게 하고 있어요(`live-config.js:222-260`). Cloud 문서는 반대로 `language_code`와 system instruction을 함께 쓰라고 하는데 [C8][C7], 제품마다 다른 부분이라 우리는 보내지 않아요 | [D4] |
| `turnCoverage` | 기본값이 모델마다 달라요. 오디오만 보내는 통역에서는 바꿀 근거가 약해요 | [D1] |
| tools, Google Search | 통역에는 필요 없어요. 번역 전용 모델은 아예 지원하지 않아요 | [C4][D2] |
| `audioStreamEnd` | 클라이언트 VAD가 발화 끝을 감지했을 때 서버의 무음 대기 없이 바로 마무리하게 하는 신호예요 [D4]. 지금은 게이트가 닫혀도 0으로 채운 무음을 계속 보내서(`capture-worklet.js:68-73`) 서버 VAD가 끝을 잡아요. 구현은 있지만 호출하는 곳이 없어요(`live.js:180-187`). 이득이 불확실해서 보류해요 `[미검증]` | [D4] |
| 새 세션 미리 열기 | 위 메모대로 기본 설계에는 넣지 않아요. 여유가 확실한 건 **유료 키에서만**이에요 | [D11][D19] |

---

## 3) Cloud로 옮길 경우의 장단점과 조건

Cloud 전환만 따로 떼어 따져 봐도, 이 앱에는 **지금은 할 수 없고 할 이유도 약해요.** 1.2~1.3에 적은 대로 토큰 서버와 결제 프로젝트가 필요하고, 사용자가 자기 무료 키로 쓰는 경로가 사라져요.

| | 내용 | 근거 |
|---|---|---|
| 장점 | 재개 핸들이 24시간 유효해요(Developer API는 2시간). transparent 모드에서는 컨텍스트 스냅숏에 해당하는 클라이언트 메시지 인덱스를 돌려줘서 다시 보낼 메시지를 알 수 있고, 재접속 중 입력 손실을 줄일 수 있어요. 그 필드 이름은 문서에서 확인하지 못했어요 `[미검증]`. 통역에는 이게 유일하게 의미 있는 기능 차이예요 | [C5][D5] |
| 장점 | 동시 세션 수치가 문서에 있어요(PayGo 1,000개). Provisioned Throughput도 있어요 | [C5] |
| 장점 | 스트리밍 전사 전용 모델(`gemini-3.5-transcribe-live-preview`)이 있어요. 화자 분리 최대 8명과 custom vocabulary를 지원하고, global 전용이에요. 다만 번역 전용 모델처럼 과금 방식이 모두 'Not supported'로 표기돼 있어 호출할 수 있는지 불분명해요 | [C20] |
| 장점 | 프롬프트와 응답을 제품 개선에 쓰지 않아요. 다만 Developer API 유료 키도 마찬가지라 Cloud만의 차이는 아니에요 | [C18][D12] |
| 단점 | 결제가 필수이고, 가격표를 확인하지 못했어요. 턴마다 컨텍스트 전체를 과금하는 방식은 같아요 | [C13][C19][C7] |
| 단점 | 클라이언트 직접 연결을 권하지 않아서 서버가 필요해요 | [C6][C12] |
| 단점 | 사용자 개인 무료 키(AI Studio 키)를 쓸 수 없어요. 모든 사용량이 오너 프로젝트로 청구돼요 `[미검증]` 추론 | [D16][C18] |
| 단점 | 모델 페이지 기준으로는 3.8-live와 번역 전용 모델의 리전이 달라 엔드포인트가 둘 필요해요. 위치 페이지는 3.8-live를 global에도 올려 두어 문서끼리 달라요 `[미검증]` | [C3][C4][C17] |
| 단점 | 번역 전용 모델은 과금 방식이 모두 'Not supported'로 표기돼 있어 호출할 수 있는지 불분명해요 | [C4] |
| 단점 | 문서끼리 충돌해요. 동시 세션(1,000 vs 5,000), 전사에 text 모달리티가 필요한지, 3.8-live의 global 지원 여부 등이 페이지마다 달라요 | [C3][C5][C6][C17] |

전환이 의미 있어지는 조건은 두 가지가 겹칠 때예요.
1. 재접속 중 입력 손실을 서버 쪽 transparent 재개로 없애야 할 만큼 중요하다.
2. 데이터 레지던시나 기업 계약처럼 Developer API 유료 키로 채울 수 없는 요구가 있다.

그때 필요한 구성은 세 가지예요.
- 서비스 계정으로 OAuth 토큰을 발급하거나 WebSocket을 프록시하는 서버
- 결제 프로젝트
- 모델별 리전 라우팅

셋 다 새 인프라이자 새 비용이라 오너 승인이 필요해요. 1번은 서버 없이도 앱 쪽 입력 버퍼링(2의 메모)으로 일부 흉내 낼 수 있어요 `[미검증]`.

---

## 4) 추천 실행 순서

1. **(선택, 코드 변경 없음) 유료 키 안전장치.** 예산 알림 [G1], 지출 상한 [G2][D18], Gemini API 전용 제한 [D17], 쿼터 상한 [G3] 중 필요한 것을 콘솔에서 걸어요. 오너가 직접 하는 설정이에요. 비용이 턴 수에 따라 커지므로(1.4) 지출 상한을 우선 권해요.
2. **코드만 고치는 저위험 수정.** API로 보내는 설정은 바꾸지 않아요. 무료 키에서 그대로 동작해요.
   - `usageMetadata` 기록 (세션별, 턴당 토큰)
   - 모델 탐색 버그, Live 캡처에 `configure` 전달
   - `interrupted` 지표 기록 (A/B 준비)
   - 오래된 주석과 문서 정리
   - 오너 결정 뒤: goAway를 예산에서 빼고 곧바로 재연결, goAway `timeLeft` 동안 출력 받기 (design-p2 §9 변경), 일시 오류 때 모델 교체 안 하기 (폴백 정책)

   프로젝트 테스트를 로컬에서 돌려 확인한 뒤 로컬 커밋까지만 해요.
3. **실제 키 A/B 1차 (오너 승인 필요).** 무료 키 호환을 확인하려고 **개인 무료 키로 먼저** 해요. 3.8-live에서 `activityHandling` 끼어들기 on/off × silence 400/600ms를 비교해요. 같은 자리에서 번역 전용 모델과 3.8-live가 `activityHandling`과 전사 하위 옵션을 받아들이는지(1007 여부)도 확인해요. 지표는 `speechEndToFirstAudioMs`, interrupted 수, `repliesSkipped`, 누락 발화 수, 그리고 `usageMetadata`의 턴당 토큰이에요.
4. **세션 연속성.** 먼저 지금 구조의 턴당 토큰을 `usageMetadata`로 재요. 그다음 `contextWindowCompression`을 낮은 `triggerTokens`로 켜고, `sessionResumption`을 더해요(3.8-live 경로 먼저, 번역 전용 모델은 지원 여부 확인 후). 20~30분 연속 음성으로 끊김 간격, 손실 폭, 턴당 토큰과 무료 키의 429 여부를 재요. 재연결 중 입력 버퍼링과 재전송은 design-p2 §9를 바꾸는 일이라 오너 결정 뒤에 해요.
5. **자막과 번역 경로.** 중간 전사, `languageCodes`, `customVocabulary`, 번역 경로 100ms 청크 A/B, 세 번째 폴백 교체 순서로 해요. 방향별 세션 둘로 하는 양방향은 선택 실험이에요.

### 오너가 정해야 할 것

- **"기본 연결"의 뜻.** 모델이라면 이미 완료예요. Cloud 엔드포인트라면 서버와 결제가 필요해요. 권장은 **모델만 쓰고 Developer API 유지**예요.
- **실제 키 A/B 호출 허용 여부와 어떤 키로 할지.** 권장은 개인 무료 키예요. 무료 키이면 음성이 무료 등급 약관을 따라요 [D12].
- **폴백 정책.** 일시 오류 때 모델을 바꿀지, 같은 모델로 재시도할지요.
- **goAway 설계 변경.** design-p2 §9의 세 가지를 바꿔도 되는지요. goAway를 재연결 예산에서 빼기(`docs/design-p2.md:238`), `timeLeft` 동안 출력 받은 뒤 닫기(`:236`), 재개 핸들과 입력 버퍼링으로 재전송하기(`:243`)예요.
- **압축 한도.** 턴당 과금 토큰과 맥락 유지 사이에서 `triggerTokens`를 어디에 둘지요. 실측 뒤에 정해요.
- **무료 키 사용자 안내 문구.** 무료 등급은 제품 개선에 쓰이고 사람이 검토할 수 있으며, EEA·스위스·영국 사용자에게는 유료만 제공할 수 있다는 점 [D12]을 앱에 안내할지요.
- **(선택) 유료 키 안전장치** 중 무엇을 걸지요.

---

## 5) 출처

- "재확인": 2026-09-30에 직접 다시 가져와 확인한 페이지예요. 검증 단계에서 아래 D·C·G 링크를 모두 다시 가져왔어요. 단, [C19]는 본문이 잘려 가격을 확인하지 못했어요.
- docs.cloud.google.com의 HTML 페이지는 본문이 잘려서, 같은 경로의 `.md.txt` 판으로 읽었어요.
- 날짜를 확인한 페이지는 다음과 같아요. 나머지 md 판에는 날짜 표시가 없었어요.
  - 약관: 최종 수정 2026-04-28
  - 3.8 Live 모델 페이지: 2026-09 (앞 단계 기록 2026-09-15)
  - live-translate: 2026-09-16 (앞 단계 기록, md 판에는 날짜 없음)
  - live-session: 2026-09-15
  - api/live HTML 판: 2026-09-04 (IMPL 기준)
  - 결제·쿼터 문서 [G1][G2][G3]: 2026-09-24
  - changelog: 2.5 접근 제한 2026-09-18, 3.8 Live 출시 2026-09-15

**Gemini Developer API (ai.google.dev)**
- [D1] https://ai.google.dev/api/live.md.txt (HTML 판 https://ai.google.dev/api/live)
- [D2] https://ai.google.dev/gemini-api/docs/live-api/live-translate.md.txt (HTML 판 https://ai.google.dev/gemini-api/docs/live-api/live-translate)
- [D3] https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live.md.txt
- [D4] https://ai.google.dev/gemini-api/docs/live-api/capabilities.md.txt
- [D5] https://ai.google.dev/gemini-api/docs/live-api/session-management.md.txt, https://ai.google.dev/gemini-api/docs/live-session
- [D6] https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket.md.txt
- [D7] https://ai.google.dev/gemini-api/docs/ephemeral-tokens.md.txt
- [D10] https://ai.google.dev/gemini-api/docs/pricing.md.txt
- [D11] https://ai.google.dev/gemini-api/docs/rate-limits.md.txt
- [D12] https://ai.google.dev/gemini-api/terms
- [D13] https://ai.google.dev/gemini-api/docs/models.md.txt
- [D14] https://ai.google.dev/gemini-api/docs/changelog.md.txt
- [D16] https://ai.google.dev/gemini-api/docs/migrate-to-cloud.md.txt
- [D17] https://ai.google.dev/gemini-api/docs/api-key.md.txt
- [D18] https://ai.google.dev/gemini-api/docs/billing.md.txt
- [D19] https://discuss.ai.google.dev/t/official-concurrent-session-rps-limits-for-gemini-live-api-where-are-they-documented/174664 (포럼 글이라 공식 문서가 아니에요. 2026-07-14 답변)
- [D20] https://ai.google.dev/gemini-api/docs/live-api/best-practices.md.txt (검증 단계에서 추가. "Pricing and billing" 절: 턴마다 컨텍스트 전체 과금, 전사는 텍스트 출력 단가)

**Gemini Enterprise Agent Platform (docs.cloud.google.com)**
- [C1] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api?hl=ko (오너가 준 링크, 본문 잘림)
- [C2] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api.md.txt
- [C3] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-live.md.txt
- [C4] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-live-translate.md.txt
- [C5] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/start-manage-session.md.txt
- [C6] https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/multimodal-live.md.txt
- [C7] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/best-practices.md.txt
- [C8] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/configure-language-voice.md.txt
- [C9] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/configure-gemini-capabilities.md.txt
- [C10] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/migrate-from-gemini-2-5-to-gemini-3-8-live.md.txt
- [C12] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/get-started-websocket.md.txt
- [C13] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start.md.txt
- [C14] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/express-mode/overview.md.txt
- [C15] https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/express-mode/api-reference.md.txt
- [C17] https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations.md.txt
- [C18] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate/migrate-google-ai.md.txt
- [C19] https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing (본문이 잘려서 가격은 확인하지 못했어요)
- [C20] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-transcribe.md.txt
- [C21] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-live-api.md.txt

**Google Cloud 결제와 쿼터 (재확인, 모두 최종 업데이트 2026-09-24)**
- [G1] https://docs.cloud.google.com/billing/docs/how-to/budgets
- [G2] https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps
- [G3] https://docs.cloud.google.com/apis/docs/capping-api-usage

**저장소 (읽기 전용으로 확인)**
- `app/providers/gemini/live-config.js`, `app/providers/gemini/live-client.js`, `app/providers/gemini/live.js`, `app/providers/gemini/index.js`, `app/providers/gemini/model-discovery.js`
- `app/engine/sim.js`, `app/engine/live-recovery.js`, `app/engine/retry.js`, `app/engine/listen-metrics.js`, `app/engine/caption-store.js`
- `app/audio/uplink-queue.js`, `app/audio/stream-capture.js`, `app/audio/stream-player.js`, `app/audio/capture-worklet.js`, `app/audio/capture.js`
- `extension/lib/settings.js`, `_headers`, `scripts/vercel-json.mjs`, `app/config.js`, `app/main.js`, `docs/design-p2.md`

[D1]: https://ai.google.dev/api/live.md.txt
[D2]: https://ai.google.dev/gemini-api/docs/live-api/live-translate.md.txt
[D3]: https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live.md.txt
[D4]: https://ai.google.dev/gemini-api/docs/live-api/capabilities.md.txt
[D5]: https://ai.google.dev/gemini-api/docs/live-api/session-management.md.txt
[D6]: https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket.md.txt
[D7]: https://ai.google.dev/gemini-api/docs/ephemeral-tokens.md.txt
[D10]: https://ai.google.dev/gemini-api/docs/pricing.md.txt
[D11]: https://ai.google.dev/gemini-api/docs/rate-limits.md.txt
[D12]: https://ai.google.dev/gemini-api/terms
[D13]: https://ai.google.dev/gemini-api/docs/models.md.txt
[D14]: https://ai.google.dev/gemini-api/docs/changelog.md.txt
[D16]: https://ai.google.dev/gemini-api/docs/migrate-to-cloud.md.txt
[D17]: https://ai.google.dev/gemini-api/docs/api-key.md.txt
[D18]: https://ai.google.dev/gemini-api/docs/billing.md.txt
[D19]: https://discuss.ai.google.dev/t/official-concurrent-session-rps-limits-for-gemini-live-api-where-are-they-documented/174664
[D20]: https://ai.google.dev/gemini-api/docs/live-api/best-practices.md.txt
[C1]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api?hl=ko
[C2]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api.md.txt
[C3]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-live.md.txt
[C4]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-live-translate.md.txt
[C5]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/start-manage-session.md.txt
[C6]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/multimodal-live.md.txt
[C7]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/best-practices.md.txt
[C8]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/configure-language-voice.md.txt
[C9]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/configure-gemini-capabilities.md.txt
[C10]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/migrate-from-gemini-2-5-to-gemini-3-8-live.md.txt
[C12]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/get-started-websocket.md.txt
[C13]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start.md.txt
[C14]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/express-mode/overview.md.txt
[C15]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/express-mode/api-reference.md.txt
[C17]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations.md.txt
[C18]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate/migrate-google-ai.md.txt
[C19]: https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
[C20]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-transcribe.md.txt
[C21]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-live-api.md.txt
[G1]: https://docs.cloud.google.com/billing/docs/how-to/budgets
[G2]: https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps
[G3]: https://docs.cloud.google.com/apis/docs/capping-api-usage
