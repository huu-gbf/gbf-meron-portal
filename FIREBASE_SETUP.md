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
   > - `formations_gw`, `formations_multi`, `formations_high` の3コレクションのみパブリックリードを許可。
   > - ブラウザからの直接の書き込みはすべて禁止（すべてCloud RunのAPIを経由）。
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
