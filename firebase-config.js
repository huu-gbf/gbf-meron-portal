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
const defaultVapidKey = "YOUR_VAPID_PUBLIC_KEY";

// ローカルストレージに保存された設定があれば優先
function getActiveFirebaseConfig() {
  try {
    const saved = localStorage.getItem('gbf_custom_firebase_config');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.apiKey && parsed.apiKey !== "YOUR_API_KEY" && parsed.projectId && parsed.projectId !== "YOUR_PROJECT_ID") {
        return parsed;
      }
    }
  } catch (e) {}
  return defaultFirebaseConfig;
}

function getActiveVapidKey() {
  try {
    const saved = localStorage.getItem('gbf_custom_vapid_key');
    if (saved && saved !== "YOUR_VAPID_PUBLIC_KEY") {
      return saved;
    }
  } catch (e) {}
  return defaultVapidKey;
}

// グローバル展開
window.firebaseConfig = getActiveFirebaseConfig();
window.FIREBASE_VAPID_KEY = getActiveVapidKey();

// Firebaseが有効に設定されているか判定
window.isFirebaseConfigured = function() {
  const cfg = window.firebaseConfig || getActiveFirebaseConfig();
  return Boolean(
    cfg &&
    cfg.apiKey &&
    cfg.apiKey !== "YOUR_API_KEY" &&
    cfg.projectId &&
    cfg.projectId !== "YOUR_PROJECT_ID"
  );
};
