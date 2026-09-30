// Content of the Live Interpreter download and guide page (docs/extension-install.md). One source renders both the
// page and the six PDF manuals (scripts/package-extension.mjs prints it per language and OS). Pure data: no DOM, no
// globals, so tests/extension-package.test.mjs can import it under node.
//
// Inline markup inside any string (rendered by site.js with textContent/createElement only):
//   **bold**  `code`  [btn:Label]  [toggle:Label]  [kbd:Key]  [folder:Name]  [link:https://...]
//   [puzzle]  [pin]  [reload]  [ext]
// A step or bullet is a string, `{ win, mac }` (per OS; null skips it on that OS) or `{ text, note }`.
// A FAQ entry is `{ q, a }`, optionally `os: 'win' | 'mac'` to show it on one OS only.

export const LANGS = Object.freeze(['ko', 'ja', 'en']);
export const OSES = Object.freeze(['win', 'mac']);

export const SITE = Object.freeze({
  origin: 'https://kc-live-interpreter.vercel.app',
  zip: 'live-interpreter.zip',
  latest: 'latest.json',
  webApp: 'https://interp-app.vercel.app',
});

/** Manual file name for an OS and language; the same names the package script prints and zips. */
export function manualFile(os, lang) {
  return `Manual-${os === 'mac' ? 'Mac' : 'Windows'}-${lang.toUpperCase()}.pdf`;
}

export const CONTENT = Object.freeze({
  ko: {
    name: '한국어',
    ui: {
      tagline: 'Chrome에서 탭 소리와 내 목소리를 실시간으로 통역하는 확장 프로그램',
      languageLabel: '언어',
      osLabel: '컴퓨터',
      os: { win: 'Windows', mac: 'Mac' },
      download: 'zip 내려받기',
      versionLine: '버전 {version} · {date}',
      versionUnknown: '최신 버전',
      downloadNote: '받은 zip에는 확장 프로그램 폴더와 Windows·Mac 설명서(한국어·日本語·English)가 함께 들어 있어요.',
      manualPdf: '이 설명서 PDF ({os})',
      allManuals: 'PDF 설명서',
      manualTitle: '설치·사용 설명서 ({os})',
      printSource: '최신 버전과 설명서: {url}',
      webApp: '휴대폰에서는 웹앱을 쓰세요',
      icons: { puzzle: '퍼즐 조각 아이콘', pin: '핀 아이콘', reload: '새로고침 아이콘' },
    },
    sections: [
      {
        id: 'about',
        title: '어떤 프로그램인가요?',
        paras: [
          'Chrome 사이드패널에서 **지금 보고 있는 탭의 소리**(화상회의·영상)와 **내 마이크**를 Gemini Live로 동시통역하고, 페이지 위에 자막을 띄워요. 한국어·일본어·영어를 지원하고, 두 언어를 서로 통역하는 **양방 통역**도 돼요.',
          '**PC의 Chrome 116 이상**(Windows·Mac)에서 써요. 휴대폰에서는 웹앱 [link:https://interp-app.vercel.app]을 쓰세요.',
          '**기본 키가 들어 있어서** API 키를 따로 넣지 않아도 바로 쓸 수 있어요.',
        ],
      },
      {
        id: 'install',
        title: '설치하기',
        intro: { win: 'Windows 기준이에요. 처음 한 번만 하면 돼요.', mac: 'Mac 기준이에요. 처음 한 번만 하면 돼요.' },
        steps: {
          win: [
            '다운로드 페이지의 [btn:zip 내려받기]를 눌러 `live-interpreter.zip`을 받으세요.',
            '받은 zip 파일을 마우스 오른쪽 버튼으로 누르고 **모두 압축 풀기** → [btn:압축 풀기]를 누르세요. zip을 더블클릭해서 안을 보기만 하면 Chrome이 불러오지 못하니 꼭 압축을 풀어 주세요.',
            '풀린 `live-interpreter` 폴더를 **문서** 폴더처럼 오래 둘 곳으로 옮기세요. Chrome은 이 폴더에서 직접 읽어 오기 때문에, 나중에 지우거나 옮기면 확장이 사라져요.',
            'Chrome 주소창에 `chrome://extensions`를 입력하고 Enter를 누르세요.',
            '오른쪽 위의 [toggle:개발자 모드]를 켜세요.',
            '왼쪽 위에 생긴 [btn:압축해제된 확장 프로그램 로드]를 누르세요.',
            '폴더 선택 창에서 `live-interpreter` 폴더를 연 다음, 그 안의 [folder:LiveInterpreter] 폴더를 **한 번만 클릭**해 선택하고 [btn:폴더 선택]을 누르세요. 더블클릭해서 안으로 들어가지 마세요.',
            '목록에 **Live Interpreter** 카드가 나타나면 설치 끝이에요.',
            '주소창 오른쪽의 [puzzle] 퍼즐 조각 아이콘을 누르고, Live Interpreter 옆의 [pin] 핀을 눌러 툴바에 고정하세요.',
          ],
          mac: [
            '다운로드 페이지의 [btn:zip 내려받기]를 눌러 `live-interpreter.zip`을 받으세요.',
            '**다운로드** 폴더에서 `live-interpreter.zip`을 더블클릭하세요. 같은 자리에 `live-interpreter` 폴더가 풀려요.',
            '그 폴더를 **문서**(Documents) 폴더처럼 오래 둘 곳으로 옮기세요. Chrome은 이 폴더에서 직접 읽어 오기 때문에, 나중에 지우거나 옮기면 확장이 사라져요.',
            'Chrome 주소창에 `chrome://extensions`를 입력하고 Enter를 누르세요.',
            '오른쪽 위의 [toggle:개발자 모드]를 켜세요.',
            '왼쪽 위에 생긴 [btn:압축해제된 확장 프로그램 로드]를 누르세요.',
            {
              text: '파일 창에서 `live-interpreter` 폴더를 연 다음, 그 안의 [folder:LiveInterpreter] 폴더를 **한 번만 클릭**해 선택하고 [btn:선택]을 누르세요. 더블클릭해서 안으로 들어가지 마세요.',
              note: '폴더를 찾기 어려우면 파일 창에서 [kbd:⌘][kbd:Shift][kbd:G]를 누르고 `~/Documents/live-interpreter`를 붙여 넣은 뒤 Enter를 누르세요.',
            },
            '목록에 **Live Interpreter** 카드가 나타나면 설치 끝이에요.',
            '주소창 오른쪽의 [puzzle] 퍼즐 조각 아이콘을 누르고, Live Interpreter 옆의 [pin] 핀을 눌러 툴바에 고정하세요.',
          ],
        },
      },
      {
        id: 'first-use',
        title: '처음 쓸 때',
        steps: [
          '통역할 탭(화상회의·영상)에서 툴바의 [ext] Live Interpreter 아이콘을 **먼저** 누르세요. Chrome은 이렇게 해야만 그 탭의 소리를 가져가도록 허락해 줘요. 오른쪽에 사이드패널이 열려요.',
          '**탭 오디오**를 켜고 **도착 언어**(통역해서 들을 언어)를 고른 다음 [btn:시작]을 누르세요.',
          '내 말도 통역하려면 **마이크**를 켜세요. 처음 한 번은 [btn:마이크 허용]을 눌러 권한을 허락해야 해요.',
          '두 언어가 오가는 대화라면 **양방 통역**을 켜고 **상대 언어**를 고르세요. 들리는 언어에 따라 통역 방향이 정해져요.',
        ],
        bullets: [
          '사이드패널을 닫으면 통역도 멈춰요. 통역하는 동안에는 열어 두세요.',
          '통역 음성을 스피커로 들으면 마이크가 그 소리를 다시 받아 되울릴 수 있어요. 헤드폰을 권장해요.',
          { win: '단축키 [kbd:Alt][kbd:Shift][kbd:Y]로도 패널을 열 수 있어요.', mac: '단축키 [kbd:Option][kbd:Shift][kbd:Y]로도 패널을 열 수 있어요.' },
        ],
      },
      {
        id: 'language',
        title: '화면 언어 바꾸기',
        paras: [
          '패널 위쪽의 **한국어 · 日本語 · English** 버튼을 누르면 패널과 옵션 화면의 언어가 바로 바뀌어요. 옵션의 **표시 언어**에서도 바꿀 수 있어요.',
        ],
      },
      {
        id: 'key',
        title: 'API 키',
        paras: [
          '기본 키가 들어 있어서 따로 할 일은 없어요. 옵션의 API 키 칸 아래에 “이 빌드에는 기본 키가 들어 있어요.”라고 나오면 정상이에요.',
          '내 키를 쓰고 싶으면 툴바 아이콘을 오른쪽 클릭 → **옵션** → **API 키**에 넣고 [btn:저장]을 누르세요. 저장한 개인 키가 기본 키보다 먼저 쓰여요. 키는 [link:https://aistudio.google.com/apikey]에서 만들 수 있어요.',
        ],
      },
      {
        id: 'update',
        title: '업데이트하기',
        intro: '패널 위쪽에 새 버전 안내가 뜨면 이렇게 업데이트하세요.',
        steps: {
          win: [
            '안내의 [btn:새 버전 받기]를 눌러 zip을 받으세요.',
            'zip을 오른쪽 클릭 → **모두 압축 풀기**. 풀 위치를 처음 설치한 폴더(예: `문서\\live-interpreter`)로 바꾸고 [btn:압축 풀기]를 누르세요. 같은 이름의 파일이 있다고 물으면 바꾸기를 고르세요.',
            '패널의 [btn:다시 불러오기]를 누르세요. `chrome://extensions`의 Live Interpreter 카드에 있는 [reload] 버튼을 눌러도 돼요.',
          ],
          mac: [
            '안내의 [btn:새 버전 받기]를 눌러 zip을 받으세요.',
            '받은 zip을 더블클릭해 풀고, 새로 나온 [folder:LiveInterpreter] 폴더를 처음 설치한 자리(예: `문서/live-interpreter`)로 끌어다 놓은 다음 [btn:대치]를 누르세요.',
            '패널의 [btn:다시 불러오기]를 누르세요. `chrome://extensions`의 Live Interpreter 카드에 있는 [reload] 버튼을 눌러도 돼요.',
          ],
        },
        bullets: [
          '**같은 자리**에 두면 설정과 개인 키가 그대로 남아요. 다른 곳에 풀어서 다시 불러오면 별개의 확장으로 추가되니, 예전 카드는 [btn:삭제]하세요.',
        ],
      },
      {
        id: 'notes',
        title: '알아 둘 점',
        bullets: [
          '음성은 Google Gemini로 전송돼요. 기본 키는 여러 사람이 함께 쓰는 무료 키라서, Google이 입력과 결과를 서비스 개선에 쓰고 사람이 검토할 수도 있어요. **기밀 통화나 회의에는 쓰지 마세요.** 꼭 필요하면 결제 계정이 연결된 개인 키를 옵션에 넣으세요.',
          '함께 쓰는 무료 한도라서 사람이 몰리는 시간에는 잠시 막힐 수 있어요.',
          '탭 오디오와 마이크를 함께 켜면 사용량이 약 두 배예요.',
          '`chrome://` 페이지, Chrome 웹 스토어, PDF 뷰어에서는 소리를 가져오거나 자막을 띄울 수 없어요.',
        ],
      },
      {
        id: 'trouble',
        title: '문제가 생기면',
        faq: [
          {
            q: '“매니페스트 파일이 없거나 읽을 수 없습니다” 오류가 나요.',
            a: '폴더를 잘못 고른 거예요. `manifest.json`이 바로 들어 있는 [folder:LiveInterpreter] 폴더를 고르세요. 그 안의 `extension` 폴더를 고르면 이 오류가 나요.',
          },
          {
            os: 'win',
            q: '폴더 선택 창에서 zip 안만 보이고 고를 수가 없어요.',
            a: '압축을 풀지 않은 거예요. 설치 2단계를 다시 해 주세요.',
          },
          {
            q: '확장이 갑자기 사라졌어요.',
            a: '폴더를 옮기거나 지웠을 거예요. 폴더를 제자리에 돌려놓거나, [btn:압축해제된 확장 프로그램 로드]로 다시 불러오세요.',
          },
          {
            q: '[toggle:개발자 모드]나 [btn:압축해제된 확장 프로그램 로드]가 안 보이거나 눌리지 않아요.',
            a: '회사가 관리하는 Chrome이면 정책으로 막혀 있을 수 있어요. 관리자에게 문의하세요.',
          },
          {
            q: '탭 소리가 통역되지 않아요.',
            a: '통역할 탭에서 툴바 아이콘을 먼저 누른 뒤 [btn:시작]을 누르세요.',
          },
          {
            q: '툴바에 아이콘이 없어요.',
            a: '[puzzle] 메뉴에서 Live Interpreter를 [pin] 핀으로 고정하세요.',
          },
        ],
      },
    ],
  },

  ja: {
    name: '日本語',
    ui: {
      tagline: 'Chrome でタブの音声と自分の声をリアルタイムに通訳する拡張機能',
      languageLabel: '言語',
      osLabel: 'パソコン',
      os: { win: 'Windows', mac: 'Mac' },
      download: 'zip をダウンロード',
      versionLine: 'バージョン {version} · {date}',
      versionUnknown: '最新バージョン',
      downloadNote: 'zip には拡張機能のフォルダと、Windows・Mac 用のマニュアル（한국어・日本語・English）が入っています。',
      manualPdf: 'このマニュアルの PDF（{os}）',
      allManuals: 'PDF マニュアル',
      manualTitle: 'インストール・使い方マニュアル（{os}）',
      printSource: '最新版とマニュアル: {url}',
      webApp: 'スマートフォンではウェブアプリをお使いください',
      icons: { puzzle: 'パズルのアイコン', pin: 'ピンのアイコン', reload: '再読み込みのアイコン' },
    },
    sections: [
      {
        id: 'about',
        title: 'どんなものですか？',
        paras: [
          'Chrome のサイドパネルで、**いま見ているタブの音声**（Web 会議・動画）と**自分のマイク**を Gemini Live で同時通訳し、ページ上に字幕を表示します。韓国語・日本語・英語に対応し、2つの言語を相互に通訳する**双方向通訳**もできます。',
          '**パソコンの Chrome 116 以上**（Windows・Mac）で使います。スマートフォンではウェブアプリ [link:https://interp-app.vercel.app] をお使いください。',
          '**既定のキーが入っている**ので、API キーを入力しなくてもすぐに使えます。',
        ],
      },
      {
        id: 'install',
        title: 'インストール',
        intro: { win: 'Windows の手順です。最初に一度だけ行います。', mac: 'Mac の手順です。最初に一度だけ行います。' },
        steps: {
          win: [
            'ダウンロードページの [btn:zip をダウンロード] を押して `live-interpreter.zip` を保存します。',
            '保存した zip ファイルを右クリックし、**すべて展開** → [btn:展開] を押します。zip をダブルクリックして中を見るだけでは Chrome から読み込めないので、必ず展開してください。',
            '展開された `live-interpreter` フォルダを、**ドキュメント**など長く置いておける場所に移します。Chrome はこのフォルダから直接読み込むため、あとで削除したり移動したりすると拡張機能が消えます。',
            'Chrome のアドレスバーに `chrome://extensions` と入力して Enter を押します。',
            '右上の [toggle:デベロッパー モード] をオンにします。',
            '左上に表示される [btn:パッケージ化されていない拡張機能を読み込む] を押します。',
            'フォルダの選択画面で `live-interpreter` フォルダを開き、その中の [folder:LiveInterpreter] フォルダを**1回だけクリック**して選び、[btn:フォルダーの選択] を押します。ダブルクリックして中に入らないでください。',
            '一覧に **Live Interpreter** のカードが表示されたらインストール完了です。',
            'アドレスバー右側の [puzzle] パズルのアイコンを押し、Live Interpreter の横の [pin] ピンを押してツールバーに固定します。',
          ],
          mac: [
            'ダウンロードページの [btn:zip をダウンロード] を押して `live-interpreter.zip` を保存します。',
            '**ダウンロード** フォルダの `live-interpreter.zip` をダブルクリックします。同じ場所に `live-interpreter` フォルダが展開されます。',
            'そのフォルダを**書類**（Documents）など長く置いておける場所に移します。Chrome はこのフォルダから直接読み込むため、あとで削除したり移動したりすると拡張機能が消えます。',
            'Chrome のアドレスバーに `chrome://extensions` と入力して Enter を押します。',
            '右上の [toggle:デベロッパー モード] をオンにします。',
            '左上に表示される [btn:パッケージ化されていない拡張機能を読み込む] を押します。',
            {
              text: 'ファイルの選択画面で `live-interpreter` フォルダを開き、その中の [folder:LiveInterpreter] フォルダを**1回だけクリック**して選び、[btn:選択] を押します。ダブルクリックして中に入らないでください。',
              note: 'フォルダが見つけにくいときは、選択画面で [kbd:⌘][kbd:Shift][kbd:G] を押し、`~/Documents/live-interpreter` を貼り付けて Enter を押します。',
            },
            '一覧に **Live Interpreter** のカードが表示されたらインストール完了です。',
            'アドレスバー右側の [puzzle] パズルのアイコンを押し、Live Interpreter の横の [pin] ピンを押してツールバーに固定します。',
          ],
        },
      },
      {
        id: 'first-use',
        title: 'はじめて使うとき',
        steps: [
          '通訳したいタブ（Web 会議・動画）で、ツールバーの [ext] Live Interpreter アイコンを**先に**押します。Chrome はこの操作をしたときだけ、そのタブの音声の取得を許可します。右側にサイドパネルが開きます。',
          '**タブの音声** をオンにして **通訳先の言語** を選び、[btn:開始] を押します。',
          '自分の話も通訳するときは **マイク** をオンにします。最初の1回だけ [btn:マイクを許可] を押して権限を許可してください。',
          '2つの言語が行き交う会話では **双方向通訳** をオンにして **相手の言語** を選びます。聞こえた言語によって通訳の向きが決まります。',
        ],
        bullets: [
          'サイドパネルを閉じると通訳も止まります。通訳中は開いたままにしてください。',
          '通訳音声をスピーカーで流すと、マイクがその音を拾って反響することがあります。ヘッドホンをおすすめします。',
          { win: 'ショートカット [kbd:Alt][kbd:Shift][kbd:Y] でもパネルを開けます。', mac: 'ショートカット [kbd:Option][kbd:Shift][kbd:Y] でもパネルを開けます。' },
        ],
      },
      {
        id: 'language',
        title: '表示言語を変える',
        paras: [
          'パネル上部の **한국어 · 日本語 · English** ボタンを押すと、パネルとオプション画面の言語がすぐに切り替わります。オプションの **表示言語** でも変更できます。',
        ],
      },
      {
        id: 'key',
        title: 'API キー',
        paras: [
          '既定のキーが入っているので、特に設定は不要です。オプションの API キー欄の下に「このビルドには既定のキーが含まれています。」と表示されていれば正常です。',
          '自分のキーを使いたいときは、ツールバーのアイコンを右クリック → **オプション** → **APIキー** に入力して [btn:保存] を押します。保存した個人キーが既定のキーより優先されます。キーは [link:https://aistudio.google.com/apikey] で作成できます。',
        ],
      },
      {
        id: 'update',
        title: 'アップデート',
        intro: 'パネル上部に新しいバージョンのお知らせが表示されたら、次の手順で更新します。',
        steps: {
          win: [
            'お知らせの [btn:新しいバージョンを入手] を押して zip を保存します。',
            'zip を右クリック → **すべて展開**。展開先を最初にインストールしたフォルダ（例: `ドキュメント\\live-interpreter`）に変えて [btn:展開] を押します。同じ名前のファイルがあると聞かれたら、置き換えを選びます。',
            'パネルの [btn:再読み込み] を押します。`chrome://extensions` の Live Interpreter カードにある [reload] ボタンでもかまいません。',
          ],
          mac: [
            'お知らせの [btn:新しいバージョンを入手] を押して zip を保存します。',
            'zip をダブルクリックして展開し、新しい [folder:LiveInterpreter] フォルダを最初にインストールした場所（例: `書類/live-interpreter`）にドラッグして [btn:置き換える] を押します。',
            'パネルの [btn:再読み込み] を押します。`chrome://extensions` の Live Interpreter カードにある [reload] ボタンでもかまいません。',
          ],
        },
        bullets: [
          '**同じ場所**に置けば、設定や個人キーはそのまま残ります。別の場所に展開して読み込むと別の拡張機能として追加されるので、古いカードは [btn:削除] してください。',
        ],
      },
      {
        id: 'notes',
        title: '知っておいてほしいこと',
        bullets: [
          '音声は Google Gemini に送信されます。既定のキーはみんなで共有する無料のキーのため、Google が入力と結果をサービス改善に利用し、人が確認する場合があります。**機密の通話や会議には使わないでください。** 必要な場合は、請求先アカウントに紐づいた個人キーをオプションに入力してください。',
          '共有の無料枠なので、利用が集中する時間帯は一時的に使えないことがあります。',
          'タブの音声とマイクを同時にオンにすると、使用量はおよそ2倍になります。',
          '`chrome://` のページ、Chrome ウェブストア、PDF ビューアでは音声の取得や字幕の表示ができません。',
        ],
      },
      {
        id: 'trouble',
        title: '困ったときは',
        faq: [
          {
            q: '「マニフェスト ファイル」が見つからない、または読み取れないというエラーが出ます。',
            a: '選んだフォルダが違います。`manifest.json` が直接入っている [folder:LiveInterpreter] フォルダを選んでください。その中の `extension` フォルダを選ぶとこのエラーになります。',
          },
          {
            os: 'win',
            q: 'フォルダの選択画面で zip の中しか見えず、選べません。',
            a: 'zip を展開していません。インストールの手順 2 をやり直してください。',
          },
          {
            q: '拡張機能が急に消えました。',
            a: 'フォルダを移動したか削除した可能性があります。フォルダを元の場所に戻すか、[btn:パッケージ化されていない拡張機能を読み込む] でもう一度読み込んでください。',
          },
          {
            q: '[toggle:デベロッパー モード] や [btn:パッケージ化されていない拡張機能を読み込む] が見当たらない、または押せません。',
            a: '会社が管理している Chrome では、ポリシーで制限されていることがあります。管理者に問い合わせてください。',
          },
          {
            q: 'タブの音声が通訳されません。',
            a: '通訳したいタブでツールバーのアイコンを先に押してから [btn:開始] を押してください。',
          },
          {
            q: 'ツールバーにアイコンがありません。',
            a: '[puzzle] メニューから Live Interpreter を [pin] ピンで固定してください。',
          },
        ],
      },
    ],
  },

  en: {
    name: 'English',
    ui: {
      tagline: 'A Chrome extension that interprets tab audio and your voice in real time',
      languageLabel: 'Language',
      osLabel: 'Computer',
      os: { win: 'Windows', mac: 'Mac' },
      download: 'Download zip',
      versionLine: 'Version {version} · {date}',
      versionUnknown: 'Latest version',
      downloadNote: 'The zip contains the extension folder and the Windows and Mac manuals (한국어 · 日本語 · English).',
      manualPdf: 'This manual as PDF ({os})',
      allManuals: 'PDF manuals',
      manualTitle: 'Installation and user guide ({os})',
      printSource: 'Latest version and manuals: {url}',
      webApp: 'On a phone, use the web app',
      icons: { puzzle: 'puzzle-piece icon', pin: 'pin icon', reload: 'reload icon' },
    },
    sections: [
      {
        id: 'about',
        title: 'What is it?',
        paras: [
          'In Chrome’s side panel, Live Interpreter interprets **the audio of the tab you are watching** (video calls, videos) and **your microphone** with Gemini Live, and shows captions on the page. It supports Korean, Japanese and English, including **two-way interpretation** between two languages.',
          'It runs in **Chrome 116 or later on a computer** (Windows or Mac). On a phone, use the web app at [link:https://interp-app.vercel.app].',
          '**A default key is included**, so you can start without entering an API key.',
        ],
      },
      {
        id: 'install',
        title: 'Install',
        intro: { win: 'These are the steps for Windows. You only do this once.', mac: 'These are the steps for Mac. You only do this once.' },
        steps: {
          win: [
            'On the download page, press [btn:Download zip] to save `live-interpreter.zip`.',
            'Right-click the zip file and choose **Extract All** → [btn:Extract]. Double-clicking the zip only shows what is inside; Chrome cannot load from there, so do extract it.',
            'Move the extracted `live-interpreter` folder somewhere it can stay, such as **Documents**. Chrome reads the extension straight from this folder, so deleting or moving it later removes the extension.',
            'Type `chrome://extensions` in Chrome’s address bar and press Enter.',
            'Turn on [toggle:Developer mode] at the top right.',
            'Press [btn:Load unpacked] at the top left.',
            'In the folder dialog, open the `live-interpreter` folder, click the [folder:LiveInterpreter] folder inside it **once** to select it, and press [btn:Select Folder]. Do not double-click into it.',
            'When a **Live Interpreter** card appears in the list, the install is done.',
            'Press the [puzzle] puzzle-piece icon to the right of the address bar, then the [pin] pin next to Live Interpreter to keep it on the toolbar.',
          ],
          mac: [
            'On the download page, press [btn:Download zip] to save `live-interpreter.zip`.',
            'In **Downloads**, double-click `live-interpreter.zip`. A `live-interpreter` folder appears next to it.',
            'Move that folder somewhere it can stay, such as **Documents**. Chrome reads the extension straight from this folder, so deleting or moving it later removes the extension.',
            'Type `chrome://extensions` in Chrome’s address bar and press Enter.',
            'Turn on [toggle:Developer mode] at the top right.',
            'Press [btn:Load unpacked] at the top left.',
            {
              text: 'In the file dialog, open the `live-interpreter` folder, click the [folder:LiveInterpreter] folder inside it **once** to select it, and press [btn:Select]. Do not double-click into it.',
              note: 'If the folder is hard to find, press [kbd:⌘][kbd:Shift][kbd:G] in the dialog, paste `~/Documents/live-interpreter` and press Enter.',
            },
            'When a **Live Interpreter** card appears in the list, the install is done.',
            'Press the [puzzle] puzzle-piece icon to the right of the address bar, then the [pin] pin next to Live Interpreter to keep it on the toolbar.',
          ],
        },
      },
      {
        id: 'first-use',
        title: 'First use',
        steps: [
          'On the tab you want to interpret (a video call or a video), press the [ext] Live Interpreter icon in the toolbar **first**. That is the only way Chrome lets the extension take that tab’s audio. The side panel opens on the right.',
          'Turn on **Tab audio**, choose a language under **Interpret into**, and press [btn:Start].',
          'To interpret your own speech too, turn on **Microphone**. The first time, press [btn:Allow microphone] to grant permission.',
          'For a conversation in two languages, turn on **Two-way interpretation** and choose the **Other language**. The direction follows the language it hears.',
        ],
        bullets: [
          'Closing the side panel stops interpretation. Keep it open while interpreting.',
          'If interpreted speech plays through speakers, the microphone can pick it up again and echo. Headphones are recommended.',
          { win: 'You can also open the panel with [kbd:Alt][kbd:Shift][kbd:Y].', mac: 'You can also open the panel with [kbd:Option][kbd:Shift][kbd:Y].' },
        ],
      },
      {
        id: 'language',
        title: 'Change the display language',
        paras: [
          'The **한국어 · 日本語 · English** buttons at the top of the panel switch the language of the panel and the options page right away. You can also change it under **Display language** in Options.',
        ],
      },
      {
        id: 'key',
        title: 'API key',
        paras: [
          'A default key is included, so there is nothing to set up. If Options shows “This build includes a default key.” under the API key field, all is well.',
          'To use your own key, right-click the toolbar icon → **Options**, enter it under **API key** and press [btn:Save]. A personal key you save is used before the default key. You can create one at [link:https://aistudio.google.com/apikey].',
        ],
      },
      {
        id: 'update',
        title: 'Update',
        intro: 'When the panel shows a new-version notice at the top, update like this.',
        steps: {
          win: [
            'Press [btn:Get the new version] in the notice to save the zip.',
            'Right-click the zip → **Extract All**. Change the destination to the folder you installed into (for example `Documents\\live-interpreter`) and press [btn:Extract]. If Windows asks about files with the same name, choose to replace them.',
            'Press [btn:Reload] in the panel. The [reload] button on the Live Interpreter card in `chrome://extensions` works too.',
          ],
          mac: [
            'Press [btn:Get the new version] in the notice to save the zip.',
            'Double-click the zip, then drag the new [folder:LiveInterpreter] folder to where you installed it (for example `Documents/live-interpreter`) and press [btn:Replace].',
            'Press [btn:Reload] in the panel. The [reload] button on the Live Interpreter card in `chrome://extensions` works too.',
          ],
        },
        bullets: [
          'Keeping it in **the same place** keeps your settings and personal key. If you extract it somewhere else and load it again, it is added as a separate extension, so [btn:Remove] the old card.',
        ],
      },
      {
        id: 'notes',
        title: 'Good to know',
        bullets: [
          'Audio is sent to Google Gemini. The default key is a free key everyone shares, so Google may use inputs and outputs to improve its services, and people may review them. **Do not use it for confidential calls or meetings.** If you need to, enter a personal key from a billing-enabled account in Options.',
          'Because the free quota is shared, it can run out for a while at busy times.',
          'Turning on tab audio and the microphone together roughly doubles usage.',
          'Audio cannot be captured and captions cannot be shown on `chrome://` pages, the Chrome Web Store or the PDF viewer.',
        ],
      },
      {
        id: 'trouble',
        title: 'Troubleshooting',
        faq: [
          {
            q: 'I get “Manifest file is missing or unreadable”.',
            a: 'The wrong folder was selected. Select the [folder:LiveInterpreter] folder, the one that directly contains `manifest.json`. Selecting the `extension` folder inside it causes this error.',
          },
          {
            os: 'win',
            q: 'The folder dialog only shows the inside of the zip and I cannot select it.',
            a: 'The zip was not extracted. Repeat install step 2.',
          },
          {
            q: 'The extension suddenly disappeared.',
            a: 'The folder was probably moved or deleted. Put it back, or load it again with [btn:Load unpacked].',
          },
          {
            q: '[toggle:Developer mode] or [btn:Load unpacked] is missing or greyed out.',
            a: 'On a Chrome managed by your company, a policy may block it. Ask your administrator.',
          },
          {
            q: 'Tab audio is not interpreted.',
            a: 'On that tab, press the toolbar icon first, then press [btn:Start].',
          },
          {
            q: 'The icon is not on the toolbar.',
            a: 'Pin Live Interpreter with the [pin] pin in the [puzzle] menu.',
          },
        ],
      },
    ],
  },
});
