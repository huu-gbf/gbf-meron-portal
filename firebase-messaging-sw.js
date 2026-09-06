// ==========================================================
//  Firebase Cloud Messaging Service Worker
//  バックグラウンドでのプッシュ通知受信・表示ハンドラ
// ==========================================================

// 安全なURL検証ヘルパー
function getSafeTargetUrl(rawUrl) {
  const fallbackUrl = 'https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=gw';
  if (!rawUrl || typeof rawUrl !== 'string') {
    return fallbackUrl;
  }
  try {
    const parsed = new URL(rawUrl, 'https://huu-gbf.github.io');
    // origin: https://huu-gbf.github.io のみ許可
    if (parsed.origin !== 'https://huu-gbf.github.io') {
      return fallbackUrl;
    }
    // pathname: /gbf-meron-portal/formations.html 完全一致のみ許可
    if (parsed.pathname !== '/gbf-meron-portal/formations.html') {
      return fallbackUrl;
    }
    // category は必須かつ gw, multi, high のみ許可
    const category = parsed.searchParams.get('category');
    if (!category || !['gw', 'multi', 'high'].includes(category)) {
      return fallbackUrl;
    }
    // post が存在する場合は [A-Za-z0-9_-]{1,64} のみ許可
    const post = parsed.searchParams.get('post');
    if (post && !/^[A-Za-z0-9_-]{1,64}$/.test(post)) {
      return fallbackUrl;
    }
    return parsed.href;
  } catch (e) {
    return fallbackUrl;
  }
}

// 1. 通知クリックイベントリスナー
// Service Worker起動時のイベントロストを防ぐため、importScripts より前に登録する
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = getSafeTargetUrl(event.notification.data?.url);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // 既存formationsタブがあれば遷移してフォーカス
      for (const client of clientList) {
        try {
          const clientUrl = new URL(client.url);
          if (
            clientUrl.origin === 'https://huu-gbf.github.io' &&
            clientUrl.pathname === '/gbf-meron-portal/formations.html'
          ) {
            if ('navigate' in client && client.url !== targetUrl) {
              return client.navigate(targetUrl).then(() => client.focus());
            }
            return client.focus();
          }
        } catch (e) {
          // ignore parsing error
        }
      }
      // 開いているタブがなければ新規ウィンドウで開く
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// 2. Firebase SDKの読み込み
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');
importScripts('./firebase-config.js');

// 3. FCMバックグラウンド受信ハンドラ
if (typeof globalThis.isFirebaseConfigured === 'function' && globalThis.isFirebaseConfigured()) {
  firebase.initializeApp(globalThis.firebaseConfig);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    const data = payload.data;
    if (!data || data.type !== 'formation_created') {
      return;
    }

    const category = data.category;
    const postId = data.post_id;
    if (!category || !['gw', 'multi', 'high'].includes(category)) {
      return;
    }
    if (!postId || !/^[A-Za-z0-9_-]{1,64}$/.test(postId)) {
      return;
    }

    const title = data.title || '【新着編成】';
    const body = data.body || '新しい編成が投稿されました';
    const safeUrl = getSafeTargetUrl(data.url);

    const options = {
      body: body,
      icon: './favicon.svg',
      badge: './favicon.svg',
      tag: data.event_id || `${category}_${postId}`,
      renotify: false,
      data: {
        url: safeUrl
      }
    };

    // Service Worker のライフサイクルを維持するため Promise を return する
    return self.registration.showNotification(title, options);
  });
}
