# 🔥 Firebase & プッシュ通知 設定手順ガイド

このポータルサイトは、**Google Firebase（完全無料枠）** を利用して、団員全員での編成データ共有および新着Webプッシュ通知を実現できます。

---

## 🚀 3ステップで完了する設定手順

### 1. Firebase プロジェクトの作成（無料）
1. [Firebase Console](https://console.firebase.google.com/) に Google アカウントでログインします。
2. **「プロジェクトを追加」** をクリックし、プロジェクト名（例: `gbf-meron-portal`）を入力して作成します。（Google アナリティクスは任意）

---

### 2. Firestore データベースの有効化
1. 左メニューの **「構築」 > 「Firestore Database」** を選択します。
2. **「データベースの作成」** をクリックします。
3. ロケーションは **`asia-northeast1 (Tokyo)`** を選択します。
4. セキュリティルールは **「テストモードで開始」** を選択して「作成」をクリックします。

---

### 3. 設定キーをコピーして貼り付ける
1. 左上の歯車アイコン ⚙️ > **「プロジェクトの設定」** を開きます。
2. 「全般」タブの一番下にある **「マイアプリ」** で **`</>` (ウェブアプリ)** アイコンをクリックします。
3. アプリのニックネーム（例: `meron-portal`）を入力して「アプリを登録」をクリックします。
4. 表示された `firebaseConfig` の中身を、[`firebase-config.js`](file:///c:/Users/池田直樹/.gemini/antigravity-ide/scratch/gbf-crew-portal/firebase-config.js) に上書き貼り付けします：

```javascript
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "gbf-meron-portal.firebaseapp.com",
  projectId: "gbf-meron-portal",
  storageBucket: "gbf-meron-portal.appspot.com",
  messagingSenderId: "123456789...",
  appId: "1:123456789:web:..."
};
```

5. **Web Push 証明書（VAPIDキー）の取得**:
   - 「プロジェクトの設定」 > **「Cloud Messaging」** タブを開きます。
   - 下部の「ウェブ設定」にある **「鍵ペアの生成」** をクリックします。
   - 生成された公開鍵をコピーし、[`firebase-config.js`](file:///c:/Users/池田直樹/.gemini/antigravity-ide/scratch/gbf-crew-portal/firebase-config.js) の `FIREBASE_VAPID_KEY` に貼り付けます：

```javascript
const FIREBASE_VAPID_KEY = "BEl5...";
```

6. 変更を保存して GitHub へプッシュすれば完了です！🎉

---

## 🔔 団員の使い方
1. 団員がポータルや編成共有ページを開きます。
2. 一覧ヘッダーにある **「🔔 新着プッシュ通知をONにする」** ボタンをクリックし、ブラウザの通知許可ダイアログで **「許可」** を選択します。
3. これで、他の団員が新しい編成を投稿した際に、ブラウザへ即座にプッシュ通知が届くようになります！
