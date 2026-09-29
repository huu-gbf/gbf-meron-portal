# Block 6C-1 本番接続準備・監査（2026-09-29）

本番公開は行っていない。6C-2は別途明示承認が必要。

## Git / 実装

- 開始HEAD・origin feature: `adb39bdf459f046824b9a4b4f5c5bb7c5159d9d2`。
- fetch後main・origin main: `bd9460e9bcff07cef9f83ded769f1f02b337fa06`。変更なし。
- 開始時blocker: MEMBER_SYNC_LOCAL専用、SDKは `/sdk/` 専用、本番API未選択、本番load時restoreなし。
- `environmentOptions`でloopbackとHTTPSページを分離。localhost/127.0.0.1は明示fixture必須。本番側はlocal設定を拒否する。公開ホスト名の複製は持たず、共有configを必要とする。
- production: 既存`firebase-config.js`のprojectId/authDomain/storageBucket/appId/apiKeyを再利用。設定値の重複なし。
- API: `API_BASE_URL`のHTTPS origin + `/api/member-sync`。path/query/credentials付きbaseやloopbackは拒否。
- SDK: 既存サイト・公開Pages HTMLともcompat 10.8.0を確認。同版gstaticを必要なcomponentだけ順次動的load。local SDKは既存node_modulesのfixtureを維持。
- named app `member-sync` の`app.auth()`のみ使用。default/管理者/yosen-shared/FCMは流用しない。
- LOCAL persistenceのAuth state確定を待ち、既存anonymous userがあればstatus APIでprofile/deviceまで検証。その後connectionイベント→identity→settingsを復元する。
- 未開始端末はuserなしで終了。signInAnonymouslyは同期開始・有効なコード申請の明示操作時のみ。
- calculatorは同期SDKより先に初期化される。SDK待機・失敗時にも計算できる。
- UIは既存パネルへ復元不能条件と最大5台・解除未対応の一段落を追加。JS/CSSに `?v=6c1`。CSS/レイアウト変更なし。
- 変更範囲: member-sync.js、folder calculator HTML、local browser fixture、production mock tests、CORS test、本書とMEMBER_SYNC.md。

## Infrastructure READ ONLY監査

| 対象 | 結果 / 分類 |
| --- | --- |
| Cloud Run | A: `gbf-ai-agent` / `meron-ai-api` / `asia-northeast1`、ingress all |
| URL | A: `https://meron-ai-api-281908486591.asia-northeast1.run.app`。サービス別名 `https://meron-ai-api-55uacuh7bq-an.a.run.app` |
| 稼働revision | A: `meron-ai-api-00072-wcf`、通常traffic 100%。別途既存tagged revisionsあり。これらを勝手に削除しない |
| 実行SA | A: `meron-ai-run@gbf-ai-agent.iam.gserviceaccount.com` |
| Invoker | A: allUsers → roles/run.invoker。Firebase ID tokenはapplication認証でありCloud Run IAM tokenではない |
| Firestore IAM | A: portal projectにroles/datastore.user、roles/datastore.viewerあり |
| Auth IAM | B: portal projectのSA bindingsにuser lookup権限なし。`firebaseauth.users.get`だけのcustom role、または既定のroles/firebaseauth.viewerを承認後に付与する案。Auth adminは不要。継承権限・条件付き権限の実効評価は未実施 |
| HMAC Secret | B: API projectのsecret一覧に該当secretなし。Cloud RunにMEMBER_SYNC_HMAC_SECRETも参照もなし。version/accessとも未準備。portal projectはSecret Manager API無効。API projectで専用secretを作り、そのsecretだけにSA accessorを付ける案 |
| Anonymous provider | B: Auth config取得成功。signIn.anonymous未設定（enabledなし）。Consoleでも確認後、承認された6C-2で有効化が必要 |
| anonymous cleanup | A/C: subtype FIREBASE_AUTH、autodeleteAnonymousUsersフィールド省略。有効化は観測されず。Consoleでdisabledを最終確認。30日自動削除の有効化は長期利用に不適合 |
| CORS | A: 許可originにhttps://huu-gbf.github.io、GET/POST/OPTIONS、Authorization/Content-Typeを含む。mount外側のmiddlewareで有効。ローカルTestClient preflight/GET検証済み |
| Rules | B: 稼働版はmainと一致。featureはmember用53行の追加だけ。既存Rulesを保持。今回Rules変更・deployなし |
| Pages | C/D: gh未認証。Source/branch/folder未確認。自動loginなし。main pushが即公開かは未確定。公開HTMLのSDK10.8.0のみ確認 |
| TTL | A/C: fields ttls listは空。correctnessはコードがexpiresAtを検査するためTTL不要。ただし古い文書は残る。cleanup方針は別途承認 |
| collection衝突 | A: 最上位collection名一覧にmemberProfiles/memberIdentities/memberSync*なし。文書内容の取得・書込みなし |

Cloud Run環境変数名（値は取得・表示しない）:
FIRESTORE_PROJECT_ID, GENERATION_MODEL, SHORT_WINDOW_LIMIT, DAILY_CLIENT_LIMIT,
DAILY_GLOBAL_LIMIT, MAX_MESSAGE_LENGTH, GEMINI_API_KEY, ADMIN_API_KEY,
FEEDBACK_SIGNING_KEY, YOUTUBE_API_KEY, PORTAL_WRITE_ENABLED, PORTAL_PUSH_ENABLED,
PUSH_DISPATCH_AUDIENCE, PUSH_DISPATCH_SERVICE_ACCOUNT。
既存secret参照はgemini-api-key:2 / meron-admin-api-key:2 /
feedback-signing-key:1 / meron-youtube-api-key:2。payloadは取得していない。
MEMBER_SYNC_PROJECT_IDは省略時にportalへ固定される。32byte未満のHMACは503 NOT_READYのまま。

予定path: memberProfiles/{profileId}, memberIdentities/{uid},
memberProfiles/{profileId}/devices/{deviceId},
memberProfiles/{profileId}/settings/speedCalculator,
memberSyncInvites, memberSyncRequests, memberSyncIssuers, memberSyncClaimants,
memberSyncPending/{profileId}/requests/{requestId}, memberSyncLimits。
TTLは親を消してもsubcollectionを掃除しないため、全pathへ一括導入する前提にしない。

rate limitはUID 30/min、IP 100/min、global 1000/minのFirestore transaction。
コードはrequest.client.hostを使用し、Forwarded headerを直接解釈しない。
ただしUvicornのproxy-header処理でhostが変わり得るため、実IPかproxy IPかは未確定。
6C-2で異なる回線の端末を使い、IP共有による過剰429とglobal文書競合を確認する。
安易にforwarded-allow-ips=*へ変更しない。

member_syncの例外処理は固定エラーだけを返し、token/code/secret/bodyやSDK例外をログ出力しない。
親middlewareもmember-syncのbodyをログ出力しない。Cloud Run access logは別管理。
監査中にAuth config出力へhashConfig署名キーを含めてしまった。値を本書・リポジトリへ保存せず、
再掲しない。Secret Manager payloadの取得はゼロ。以後のAuth取得はfield限定を必須とする。

参考: [Auth Config仕様](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/Config)、
[Uvicorn proxy設定](https://www.uvicorn.org/settings/)。

## ロールバック準備

- frontend復元元: 上記main commit。履歴改変せずrevert等で公開元へ戻す。Pages Source確定前は操作を決め打ちしない。
- backend復元先: meron-ai-api-00072-wcfへ通常trafficを戻す。既存tagsを保持。
- Rules: `projects/gbf-meron-portal/rulesets/c14b7982-abbb-4e08-a21d-fa60a91417ea`。
  release更新日時 `2026-09-24T21:00:22.028043Z`。内容はmain:firestore.rulesと改行正規化後一致。
  READ ONLY取得を `%TEMP%/gbf-6c1-production-firestore.rules` に保存済み。mainのGit版も復元元になる。
- Auth: email/password enabled、anonymous未設定。cleanup有効化なし。
- SA/IAM: 上記を開始状態として、6C-2で承認された追加だけを記録。既存管理者権限に触れない。
- データ: rollbackで新profile/identityを自動削除しない。Auth無効化も既存member sessionへ影響するため別途判断。

## ユーザー確認が必要なConsole操作（今回は変更しない）

1. GitHub → huu-gbf/gbf-meron-portal → Settings → Pages。
   Build and deploymentのSource、Branch、folderを確認。main / rootならmain pushが公開操作。
   GitHub Actionsなら該当workflowのtriggerとdeploy手順、別branchなら公開branchを確認する。
2. Firebase Console → gbf-meron-portal → Authentication → Sign-in method。
   Anonymousが無効であることを確認。6C-2承認後の変更予定はAnonymousのみ有効化。
   設定に匿名アカウント自動削除が表示される場合は無効を確認し、今回変更しない。
3. Google Cloud → gbf-ai-agent → Secret Manager。
   6C-2では32byte以上のランダム値を専用secretとして作成し、SAへ当該secretのaccessorのみ付与する予定。
   値をチャットやログへ貼らない。
4. Google Cloud → gbf-meron-portal → IAM。
   実行SAのfirebaseauth.users.get不足を確認し、承認後に最小roleを追加する予定。

## 6C-2の順序と停止条件

1. 明示承認を受け、Pages Sourceを確定。main・revision・Rulesの最新状態を再取得し、rollback手順を確定。
2. 専用HMAC Secret/versionとSA access、Auth lookup IAMを準備。既存環境変数・権限を保持。
3. backendへmember sync対応をdeployしSecret参照を設定。revision readyと構成を確認。
4. Anonymous Authを有効化し、既存ルールを含むfeature Rulesをdeploy。cleanup無効を確認。
5. 承認範囲の本番smoke: Auth→profile→pairing→settings、CORS、別回線のrate limit、管理者Auth。
   token/code/bodyをログへ出さず、テスト端末の扱いを事前確定（5台上限・解除未対応）。
6. 全て成功後にfrontendを最後に公開。main/rootなら承認されたmergeと通常push、
   Actions/別branchなら確認した公開経路を使用。PC/mobile calculatorを確認。

HMAC未準備、backend未ready、予期しない401/403/5xx、CORS失敗、Anonymous不可、
settings Rules/pairing失敗、rate limit異常、管理者Auth/calculator回帰、rollback不明、
Pages Source未確認のいずれかならfrontend公開禁止。今回これらの変更・本番smokeは一切未実施。

## 検証結果

- client既存39/39。production追加6件（config/local分離3 + mock browser3）。
- Emulator browser25/25、Auth3/3、API40/40。
- Rules56/56 = Firestore44 + member9 + Storage2 + yosen Rules1。settings Rules/transaction20/20。
- Python既存467/467を各ファイル別processで実行。CORS追加1/1。
- GW21/21、戦況UI9/9、indexes5/5、予選15/15（shared3/noon8/honsen4）。
- integration/knowledgeのトップレベルassertスクリプトもexit 0。
- 初回のpytest探索はテスト関数なしファイルでexit 5。対象を正式pytest集合に限定して467件を確認。
  対象外のignored backend/test_notifications.pyは旧symbol importで失敗したため変更しない。正式467件には含まれない。
- 初回AuthテストはEmulator環境変数なしで失敗。正式Emulator再実行は3/3。
- PC1440×1000 / mobile390×844をbrowserで検証し、画像も確認。mobile scrollWidth390、横overflow0。
  同期・管理者共存・calculator結果の旧checkpoint比較・offline replayもPASS。
- browserの外部通信はabort。Emulator SDKのcleardot接続試行も遮断。本番Auth/Firestore/Cloud Run通信ゼロ。
- 本番hostnameは全requestをローカルfulfill/abortし、SDK済み/未ロード、Auth有無、復元、計算先行を検証。
- Cloud Run/Rules/Auth/IAM/Secret/Pages変更ゼロ。本番user/profile/pairing作成ゼロ。

最終commit/pushのIDとgit statusは実行後のチャット報告を参照。
