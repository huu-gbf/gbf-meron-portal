// ==========================================================
//  Firebase 設定ファイル (めろ～ん王国 ポータル)
// ==========================================================

const defaultFirebaseConfig = {
  apiKey: "AIzaSyDAm8ErbLhn1cvy1Y7NwG04dXmRHPtsblE",
  authDomain: "gbf-meron-portal.firebaseapp.com",
  projectId: "gbf-meron-portal",
  storageBucket: "gbf-meron-portal.firebasestorage.app",
  messagingSenderId: "1074585998388",
  appId: "1:1074585998388:web:5236158360dab1bd0e6661"
};

// Web Push 証明書（VAPID公開鍵）
const defaultVapidKey = "BEVMN9HhBl6aQkt-Xy-pnd549MOYLkKQf-sgW4Ktuvmu4vQ8ael1POpBThe7LkTq5VjhZnEVVmOj0Q-JeVGAyug";

// グローバル展開
globalThis.firebaseConfig = defaultFirebaseConfig;
globalThis.FIREBASE_VAPID_KEY = defaultVapidKey;
globalThis.API_BASE_URL = "https://meron-ai-api-281908486591.asia-northeast1.run.app";

// Firebaseが有効に設定されているか判定
globalThis.isFirebaseConfigured = function() {
  const cfg = globalThis.firebaseConfig;
  return Boolean(
    cfg &&
    cfg.apiKey &&
    cfg.apiKey !== "YOUR_API_KEY" &&
    cfg.projectId &&
    cfg.projectId !== "YOUR_PROJECT_ID"
  );
};
