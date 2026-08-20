// ==========================================================
//  Firebase Cloud Messaging Service Worker
//  バックグラウンドでのプッシュ通知受信・表示ハンドラ
// ==========================================================

importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');
importScripts('./firebase-config.js');

if (typeof firebaseConfig !== 'undefined' && isFirebaseConfigured()) {
  firebase.initializeApp(firebaseConfig);
  const messaging = firebase.messaging();

  // バックグラウンド通知ハンドラ
  messaging.onBackgroundMessage((payload) => {
    console.log('[firebase-messaging-sw.js] バックグラウンド通知を受信:', payload);

    const notificationTitle = payload.notification?.title || payload.data?.title || '【騎空団ポータル】新着編成';
    const notificationOptions = {
      body: payload.notification?.body || payload.data?.body || '新しい編成が投稿されました！',
      icon: payload.notification?.icon || './favicon.ico',
      badge: './favicon.ico',
      data: {
        url: payload.data?.url || './formations.html'
      },
      vibrate: [200, 100, 200]
    };

    self.registration.showNotification(notificationTitle, notificationOptions);
  });
}

// 通知クリック時にページを開く
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data?.url || './formations.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('formations.html') || client.url.includes('index.html')) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
