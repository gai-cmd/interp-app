# Live Interpreter Chrome 확장 — 설치와 업데이트 / インストールと更新 / Install and update

**멤버에게는 이 주소만 보내면 됩니다 / メンバーにはこのアドレスだけ送れば十分です / Just send members this link:**
https://kc-live-interpreter.vercel.app

그 페이지에 zip 내려받기 버튼, Windows·Mac 설치 순서, 사용법, 업데이트 방법, 문제 해결이 한국어·日本語·English로 있고, 같은 내용의 PDF 설명서 6종(Windows/Mac × KO/JA/EN)도 있습니다. zip 안에도 PDF 설명서와 README.txt가 들어 있습니다.

そのページに zip のダウンロードボタン、Windows・Mac のインストール手順、使い方、更新方法、トラブル対処が 한국어・日本語・English であり、同じ内容の PDF マニュアル 6 種（Windows/Mac × KO/JA/EN）もあります。zip の中にも PDF マニュアルと README.txt が入っています。

The page has the zip download, Windows and Mac install steps, usage, updating and troubleshooting in Korean, Japanese and English, plus the same content as six PDF manuals (Windows/Mac × KO/JA/EN). The zip also contains the PDFs and a README.txt.

> 웹스토어에는 올리지 않았습니다. 폴더를 직접 불러오는 방식(압축해제된 확장)이라 Chrome이 자동으로 업데이트하지 않고, 확장이 새 버전을 알려 주면 사람이 덮어씁니다.
> ウェブストアには公開していません。フォルダを直接読み込む方式のため Chrome は自動更新せず、拡張機能が新しいバージョンを知らせたら手動で上書きします。
> Not on the Chrome Web Store. It is loaded as an unpacked folder, so Chrome does not update it; the extension announces a new version and the member replaces the folder.

## 요약 / 要約 / Summary

| | 한국어 | 日本語 | English |
|---|---|---|---|
| 설치 | zip 받기 → 압축 풀기 → `live-interpreter` 폴더를 문서 폴더로 → `chrome://extensions` → **개발자 모드** → **압축해제된 확장 프로그램 로드** → `LiveInterpreter` 폴더를 **한 번 클릭**해 선택 | zip を保存 → 展開 → `live-interpreter` フォルダをドキュメント（Mac は書類）へ → `chrome://extensions` → **デベロッパー モード** → **パッケージ化されていない拡張機能を読み込む** → `LiveInterpreter` フォルダを**1回クリック**して選択 | Save the zip → extract → move `live-interpreter` to Documents → `chrome://extensions` → **Developer mode** → **Load unpacked** → click the `LiveInterpreter` folder **once** |
| 흔한 실수 | 그 안의 `extension` 폴더를 고르면 “매니페스트 파일이 없거나 읽을 수 없습니다” | 中の `extension` フォルダを選ぶとマニフェストのエラー | Picking the inner `extension` folder gives “Manifest file is missing or unreadable” |
| 키 | 기본 키 포함(입력 불필요). 옵션에서 개인 키를 저장하면 그 키가 먼저 쓰임 | 既定のキー入り（入力不要）。オプションで個人キーを保存するとそちらが優先 | Default key included (nothing to enter). A personal key saved in Options is used first |
| 업데이트 | 패널에 새 버전 안내 → **새 버전 받기** → 같은 자리에 `LiveInterpreter` 폴더 교체 → **다시 불러오기** | パネルにお知らせ → **新しいバージョンを入手** → 同じ場所の `LiveInterpreter` を置き換え → **再読み込み** | Panel notice → **Get the new version** → replace `LiveInterpreter` in the same place → **Reload** |

## 알아 둘 점 / 注意 / Notes

- 기본 키는 여러 사람이 함께 쓰는 무료 키입니다. zip을 가진 사람은 누구나 키를 꺼낼 수 있고(웹앱에도 같은 키가 공개돼 있음), Google이 입력과 결과를 서비스 개선에 쓰고 사람이 검토할 수 있습니다. 기밀 통화·회의에는 쓰지 말고, 필요하면 결제 계정이 연결된 개인 키를 옵션에 넣으세요.
  既定のキーは共有の無料キーです。zip を持つ人は誰でもキーを取り出せ（ウェブアプリでも同じキーが公開済み）、Google が入力と結果をサービス改善に使い、人が確認する場合があります。機密の通話・会議には使わず、必要なら請求先アカウントの個人キーをオプションに入力してください。
  The default key is a shared free key. Anyone with the zip can extract it (the web app already exposes the same keys), and Google may use inputs and outputs to improve its services with human review. Do not use it for confidential calls; enter a billing-enabled personal key in Options if needed.
- 휴대폰에서는 웹앱을 쓰세요 / スマートフォンはウェブアプリ / On phones use the web app: https://interp-app.vercel.app

## 새 버전 내보내기 (개발자) / 新バージョンの公開（開発者） / Publishing a new version (developer)

1. `extension/manifest.json`의 `version`을 올립니다. 확장은 사이트의 `latest.json`과 자기 버전을 비교해 새 버전 안내를 띄웁니다.
2. `npm run package:extension` (= `node scripts/package-extension.mjs [--builtin-key-file <path>] [--chrome <path>] [--released YYYY-MM-DD]`)
   - 기본 키 파일 `~/.config/interp-app/builtin-key`로 **키를 넣은 빌드**를 `dist/extension-package/LiveInterpreter`에 만들고, 안내 페이지를 헤드리스 Chrome으로 인쇄해 PDF 6종을 만든 뒤, `dist/extension-site/`(배포 루트: 페이지, `latest.json`, `live-interpreter.zip`, `manuals/`, `vercel.json`)를 채웁니다.
   - 끝에 `PACKAGE_OK version=… keys=… zip=… pdfs=6`이 나와야 합니다. 키 파일이 없거나 비어 있으면 실패합니다(이 배포는 키 포함이 정책).
   - **실제 Chrome 부팅 점검(필수, Node 가짜로는 못 잡는 오류용)**: `node scripts/boot-test-package.mjs dist/extension-package/LiveInterpreter <새 빈 폴더> --old <이전 릴리스를 푼 LiveInterpreter 폴더> --expect-tab-model <기본 모델>` — 소리 없이 헤드리스 Chrome for Testing에서 새 설치와 `chrome.runtime.reload()` 업그레이드(자동 업데이트와 같은 경로)를 돌려, 모든 확장 페이지가 오류 0으로 뜨고 일회성 이전(migration)이 실행되는지 봅니다. 모두 통과해야 배포합니다.
   - **Real-Chrome boot test (required; it catches what Node fakes cannot):** the command above runs a fresh install and a `chrome.runtime.reload()` upgrade (the self-updater's path) in muted headless Chrome for Testing; every check must pass before the deploy.
3. 확인 후 **승인을 받고** `dist/extension-site`에서 `vercel deploy --prod`(프로젝트 `kc-live-interpreter`)로 올립니다. 키가 든 zip이므로 **git에는 절대 커밋하지 않습니다**(`dist/`는 gitignore). CLI로 직접 올립니다.

소스: 페이지와 설명서 내용은 `extension-site/content.js` 한 곳에 있습니다(한·일·영 × Windows·Mac). 테스트: `tests/extension-package.test.mjs`.
Sources: the page and manual text live in `extension-site/content.js` (ko/ja/en × Windows/Mac). Tests: `tests/extension-package.test.mjs`.

개발 문서 / 開発ドキュメント / Developer docs: [docs/extension.md](extension.md) (§13 수동 확인 목록 / 手動確認リスト / manual checks)
