# 🔥 Firebase & プッシュ通知 設定手順ガイド

このポータルサイトは、**Google Firebase（Firestore データベース & FCMプッシュ通知）** を利用して、PC・スマホ問わず**団員全員でのリアルタイム編成共有＆新着プッシュ通知**を実現します。

---

## 🚀 最短3分で完了する導入手順

### 1. Firebase プロジェクトの作成（完全無料）
1. [Firebase Console](https://console.firebase.google.com/) に Google アカウントでログインします。
2. **「プロジェクトを追加」** をクリックし、プロジェクト名（例: `gbf-meron-portal`）を入力して作成します。（Google アナリティクスは不要または任意）

---

### 2. Firestore Database の作成とルール設定
1. 左メニューの **「構築」 > 「Firestore Database」** を選択します。
2. **「データベースの作成」** をクリックします。
3. ロケーションは **`asia-northeast1 (Tokyo)`** を選択します。
   > **【重要】セキュリティルールとインデックスの設定**
   > 本番では全開放ルール (`allow read, write: if true;`) は使用しません。
   > 以下の制約を持つ `firestore.rules` で管理されています：
   > - `formations_gw`, `formations_multi`, `formations_high` はパブリックリードを許可。公開ツール・募集文の読取は各pathの既存設定を維持します。
   > - 編成投稿のブラウザからの直接書き込みは禁止（Cloud RunのAPIを経由）。募集文・予選・本戦の管理人更新は各pathの既存UID制限を維持します。
   > - 不具合・要望受付 `portalFeedback/{reportId}` だけは、未ログインを含む利用者の新規作成を入力検証付きで許可します。一般利用者のget/list/update/deleteは禁止し、既存Firebase管理UIDだけにget/list/deleteを許可します。管理人でもupdateはできません。
   > - `notification_tokens` やその他の内部コレクションへのブラウザからのアクセスは完全に禁止。
   >
   > **Firestore Composite Indexについて**
   > production dispatcher の recipient クエリ（`enabled == true`, `schema_version == 2`, `updated_at >= 30日前`）実行のため、
   > `firestore.indexes.json` に `notification_tokens` の複合インデックスを定義して管理します。
   > - ルールデプロイ: `firebase deploy --only firestore:rules`
   > - インデックスデプロイ: `firebase deploy --only firestore:indexes`
   >
   > **テスト方法**
   > - ルールテスト（Firestore Emulator）: `npm test`
   >   ※ 本番への接続を防ぐため `demo-` プレフィックスをもつ架空のプロジェクトIDを利用します。
   > - インデックステスト: `node --test tests/firestore.indexes.test.js`
   >
   > **本番適用について**
   > 本番へのデプロイは承認されたリリース手順に従って実施します（※Phase D2作業中には自動デプロイを行いません）。

---

### 3. 設定値をサイトに登録する（2つの方法）

#### 方法A: 画面上の「⚙️ Firebase設定」ボタンから登録（最も簡単！）
1. Firebase Console の ⚙️ > **「プロジェクトの設定」** > 「マイアプリ」の `</>` (ウェブアプリ) を作成。
2. 表示された `apiKey`, `projectId`, `appId` などをコピー。
3. ポータルサイトまたは編成共有ページの **「⚙️ Firebase設定」** ボタンを押し、入力フォームに貼り付けて **「保存して接続」** を押すだけ！

#### 方法B: `firebase-config.js` を直接編集してGitHubへプッシュ
[`firebase-config.js`](file:///c:/Users/池田直樹/.gemini/antigravity-ide/scratch/gbf-crew-portal/firebase-config.js) の該当箇所を書き換えてコミット＆プッシュします：

```javascript
const defaultFirebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "gbf-meron-portal.firebaseapp.com",
  projectId: "gbf-meron-portal",
  storageBucket: "gbf-meron-portal.appspot.com",
  messagingSenderId: "123456789...",
  appId: "1:123456789:web:..."
};
```

---

## 📱 動作確認
- 接続が成功すると、編成一覧の上に **「🟢 Firestore リアルタイム同期中」** と表示されます。
- PCから編成を投稿すると、リロードすることなく**スマホ側の画面にも瞬時にカードが追加**されます！
- **「🔕 新着通知を受信しない設定です」** をクリックして **「🔔 新着通知を受信する設定です」** に切り替えておけば、ブラウザを閉じていてもプッシュ通知が届きます。

## 不具合・要望フォーム（独立MVP・本番反映は別工程）

- 一般用は `feedback.html`、管理人用は `feedback-admin.html`。既存Firebase設定と管理人メール／パスワード認証・UIDを使います。既存Authのpersistenceは変更しません。
- 保存先はポータルprojectの `portalFeedback`。fieldは `schemaVersion: 1`、`type` (`bug/request/other`)、`message`、`name`、`target`、`createdAt` の6個だけ。本文は1～4,000文字、名前0～40文字、対象0～100文字（Unicodeコードポイント）です。改行は本文のみ、名前と対象は任意です。
- 一般側は新規保存の完了だけを待ち、保存後のgetや一覧を実行しません。Anonymous Auth、通知、Storageは使用しません。報告を既存AI評価 `/api/feedback` や編成データへ混ぜません。
- 連続submitは同一処理にまとめ、失敗時は入力を保持します。同じ内容の再試行は同じdocument IDを使用。未確定の通信待ちは成功扱いにせず、新しい書込を増やしません。reloadをまたぐ下書き保存・厳密な重複排除は対象外です。
- 管理画面は管理UID確認後だけserverから新しい順に30件ずつ取得。ログアウト・Auth喪失・ページ離脱時に報告表示を消し、遅延応答も破棄します。Firestoreの永続cacheは有効化しません。
- 新規2ページのnoindexは検索除外用で、データ保護はFirestore Rulesが担います。画像添付は第2段階へ延期し、`storage.rules`は変更しません。

試験手順（本番には接続しない）:

1. `npm run test:feedback:unit` でvalidation・重複抑止・入力保持・管理人認可と遅延応答のmock試験。
2. `npm test` で既存Firestore/Storage Rulesと専用受付RulesのEmulator試験。
3. `npm run test:feedback:browser` は専用 `firebase.feedback-test.json` でAuthを127.0.0.1:9099、Firestoreを127.0.0.1:8080、project `demo-feedback-mvp` として起動・停止します。既存試験同様にPlaywright/Edgeが必要です。fixtureはdemo project・local SDKのみを使用し、外部通信を遮断します。必要なら既存Playwright runtimeを`NODE_PATH`に設定します。既に同じportでEmulatorが動いている場合は、停止してから実行してください。
4. mainの既存Node/Python正式回帰も実行。Pythonは各ファイルを別processで実行し、integration/knowledgeのscript試験も確認します。
5. PCと390pxのスマホ幅で連続入力、Backspace、全選択、copy/paste、文中挿入、改行、caret/focusを確認。合成compositionイベントは人間の日本語IMEや実スマホの操作確認の代わりになりません。公開前に実機で確認します。

loopbackで新規ページを開く場合、通常の本番設定では送信を停止します。専用browser fixtureが `PORTAL_FEEDBACK_LOCAL` にdemo projectと上記loopback Emulatorを指定します。file URLやloopback以外のHTTPでも本番接続を開始しません。一般側にはAuth SDKを読み込みません。

今回のmain基点 (`e8e411b`) には既存回帰の不一致が2件あります。予選の正午グラフ試験は13開催を期待しますが画面データは14開催、履歴既読scriptは9/29の固定IDを期待しますが最新履歴は10/16です。mainの元ファイルだけでも同じ失敗を再現しており、今回は既存試験を変更していません。この2件と実機入力確認を未解決のまま、本番反映可能とは判定しません。

公開前にはPagesの配信元・公開commit、本番Rulesとの差分、既存管理人アカウントを確認します。未公開の端末同期branchをmerge/deployせず、確認済み本番baselineへ今回の差分だけを適用します。Rules先・frontend後の承認済み手順で公開し、失敗時は公開しません。停止時は受付createを拒否して入口を戻し、受信済み報告を自動削除しません。
