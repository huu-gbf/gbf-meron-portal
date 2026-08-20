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
4. セキュリティルールは **「テストモードで開始」** を選択して作成します。
   > **【重要】セキュリティルールの確認**
   > Firestore の「ルール」タブで、誰でも読み書きできるように以下になっていることを確認してください：
   > ```javascript
   > rules_version = '2';
   > service cloud.firestore {
   >   match /databases/{database}/documents {
   >     match /{document=**} {
   >       allow read, write: if true;
   >     }
   >   }
   > }
   > ```

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
- **「🔔 新着通知をONにする」** を押しておけば、ブラウザを閉じていてもプッシュ通知が届きます。
