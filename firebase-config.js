// ==========================================================
//  Firebase 設定ファイル (めろ～ん王国 ポータル)
// ==========================================================
// Firebase Console (https://console.firebase.google.com/) でプロジェクトを作成し、
// 以下の設定値を貼り付けてください。
// ※ 未設定の場合は自動的にローカル保存（localStorage）モードで動作します。

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// Web Push 証明書（VAPID公開鍵）
// Firebase Console > プロジェクト設定 > クラウドメッセージング > ウェブ設定 > 「鍵ペアの生成」で取得した公開鍵
const FIREBASE_VAPID_KEY = "YOUR_VAPID_PUBLIC_KEY";

// Firebaseが有効に設定されているか判定
const isFirebaseConfigured = () => {
  return firebaseConfig.apiKey && firebaseConfig.apiKey !== "YOUR_API_KEY";
};
