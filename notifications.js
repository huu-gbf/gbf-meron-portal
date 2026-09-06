(function (global) {
  'use strict';

  const INSTALLATION_KEY = 'gbf_portal_notification_installation_v1';
  const INTENT_KEY = 'gbf_portal_notification_intent_v1';
  const REQUEST_TIMEOUT_MS = 15000;
  const AUTO_SYNC_INTERVAL_MS = 60 * 1000;
  const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  const STATES = Object.freeze({
    OFF: 'OFF', ON: 'ON', PENDING_ON: 'PENDING_ON',
    PENDING_OFF: 'PENDING_OFF', ERROR: 'ERROR', UNSUPPORTED: 'UNSUPPORTED'
  });
  const MESSAGES = Object.freeze({
    ON_FAILED: '通知登録を確認できません。再試行してください',
    OFF_FAILED: '解除待ちです。通信復旧まで通知が届く場合があります',
    STORAGE_FAILED: '端末設定を保存できないため通知登録できません',
    UNSUPPORTED: '通知非対応ブラウザ'
  });

  let messaging = null;
  let registrationPromise = Promise.resolve(null);
  let stateRenderer = function () {};
  let initialized = false;
  let listenersBound = false;
  let lastAutoAttemptAt = 0;
  let retryNotBeforeOn = 0;
  let retryNotBeforeOff = 0;
  let lastRegisteredToken = null;
  let serverState = { enabled: false, revision: 0 };
  let viewState = { state: STATES.OFF, message: '', desired: false, busy: false };

  class PortalNotificationError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = 'PortalNotificationError';
      this.code = code;
      this.status = details && details.status;
      this.retryAfterMs = details && details.retryAfterMs;
      this.timedOut = Boolean(details && details.timedOut);
    }
  }

  function createUuidV4() {
    if (!global.crypto) throw new PortalNotificationError('STORAGE_UNAVAILABLE', MESSAGES.STORAGE_FAILED);
    if (typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID().toLowerCase();
    if (typeof global.crypto.getRandomValues !== 'function') {
      throw new PortalNotificationError('STORAGE_UNAVAILABLE', MESSAGES.STORAGE_FAILED);
    }
    const bytes = global.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  }

  function parseInstallationId(value) {
    return typeof value === 'string' && UUID_V4_PATTERN.test(value) ? value.toLowerCase() : null;
  }

  function readInstallationId() {
    return parseInstallationId(global.localStorage.getItem(INSTALLATION_KEY));
  }

  function getOrCreateInstallationId() {
    try {
      const existing = readInstallationId();
      if (existing) return existing;
      const installationId = createUuidV4();
      global.localStorage.setItem(INSTALLATION_KEY, installationId);
      if (global.localStorage.getItem(INSTALLATION_KEY) !== installationId) throw new Error('verification failed');
      return installationId;
    } catch (_error) {
      throw new PortalNotificationError('STORAGE_UNAVAILABLE', MESSAGES.STORAGE_FAILED);
    }
  }

  function defaultIntent() {
    return { desired: false, operation_id: null, pending: false, last_synced_at: 0 };
  }

  function parseIntent(raw) {
    if (!raw) return defaultIntent();
    const value = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || typeof value.desired !== 'boolean' ||
        typeof value.pending !== 'boolean' || !UUID_V4_PATTERN.test(value.operation_id || '') ||
        typeof value.last_synced_at !== 'number' || !Number.isFinite(value.last_synced_at) || value.last_synced_at < 0) {
      throw new Error('invalid notification intent');
    }
    return {
      desired: value.desired,
      operation_id: value.operation_id.toLowerCase(),
      pending: value.pending,
      last_synced_at: value.last_synced_at
    };
  }

  function readIntent() {
    return parseIntent(global.localStorage.getItem(INTENT_KEY));
  }

  function writeIntent(intent) {
    try {
      global.localStorage.setItem(INTENT_KEY, JSON.stringify(intent));
      const verified = parseIntent(global.localStorage.getItem(INTENT_KEY));
      if (verified.desired !== intent.desired || verified.operation_id !== intent.operation_id ||
          verified.pending !== intent.pending || verified.last_synced_at !== intent.last_synced_at) {
        throw new Error('verification failed');
      }
      return verified;
    } catch (_error) {
      throw new PortalNotificationError('STORAGE_UNAVAILABLE', MESSAGES.STORAGE_FAILED);
    }
  }

  function isCurrentOperation(operationId, desired) {
    try {
      const current = readIntent();
      return current.operation_id === operationId && current.desired === desired;
    } catch (_error) {
      return false;
    }
  }

  function renderNotificationState(state, message, desired, busyOverride) {
    const defaultBusy = state === STATES.PENDING_ON || state === STATES.PENDING_OFF;
    viewState = {
      state,
      message: message || '',
      desired: typeof desired === 'boolean' ? desired : viewState.desired,
      busy: typeof busyOverride === 'boolean' ? busyOverride : defaultBusy
    };
    stateRenderer({
      ...viewState,
      enabled: state === STATES.ON
    });
  }

  function retryAfterMilliseconds(value) {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateValue = Date.parse(value);
    return Number.isFinite(dateValue) ? Math.max(0, dateValue - Date.now()) : 0;
  }

  async function requestJson(path, body) {
    const baseUrl = typeof global.API_BASE_URL === 'string' ? global.API_BASE_URL.replace(/\/$/, '') : '';
    if (!baseUrl) throw new PortalNotificationError('API_UNAVAILABLE', '通知APIが設定されていません');
    const controller = new AbortController();
    const timeoutId = global.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await global.fetch(baseUrl + path, {
        method: 'POST', mode: 'cors', credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new PortalNotificationError('REQUEST_TIMEOUT', '通知APIがタイムアウトしました', { timedOut: true });
      }
      throw new PortalNotificationError('NETWORK_ERROR', '通知APIへ接続できません');
    } finally {
      global.clearTimeout(timeoutId);
    }
    let payload = null;
    try { payload = await response.json(); } catch (_error) { payload = null; }
    if (!response.ok) {
      const code = payload && payload.error && payload.error.code ? payload.error.code : 'API_ERROR';
      const message = payload && payload.error && payload.error.message ? payload.error.message : '通知APIでエラーが発生しました';
      const retryAfterMs = response.status === 429 ? retryAfterMilliseconds(response.headers.get('Retry-After')) : 0;
      if (response.status === 429) {
        if (path === '/api/notifications/unsubscribe') {
          retryNotBeforeOff = Math.max(retryNotBeforeOff, Date.now() + retryAfterMs);
        } else {
          retryNotBeforeOn = Math.max(retryNotBeforeOn, Date.now() + retryAfterMs);
        }
      }
      throw new PortalNotificationError(code, message, { status: response.status, retryAfterMs });
    }
    return payload;
  }

  function validateServerState(payload) {
    if (!payload || typeof payload.enabled !== 'boolean' || !Number.isInteger(payload.revision) || payload.revision < 0) {
      throw new PortalNotificationError('INVALID_RESPONSE', '通知APIの応答が不正です');
    }
    return { enabled: payload.enabled, revision: payload.revision };
  }

  async function readServerState(installationId) {
    const id = installationId || getOrCreateInstallationId();
    const result = validateServerState(await requestJson('/api/notifications/status', { installation_id: id }));
    serverState = result;
    return result;
  }

  async function isMessagingSupported() {
    try {
      if (global.firebase && global.firebase.messaging && typeof global.firebase.messaging.isSupported === 'function') {
        return Boolean(await global.firebase.messaging.isSupported());
      }
      return Boolean(messaging);
    } catch (_error) {
      return false;
    }
  }

  async function markServerOff(intent, response) {
    if (!isCurrentOperation(intent.operation_id, false)) return;
    const confirmed = validateServerState(response);
    if (confirmed.enabled !== false) throw new PortalNotificationError('INVALID_RESPONSE', '通知APIの応答が不正です');
    const completed = writeIntent({
      desired: false, operation_id: intent.operation_id, pending: false, last_synced_at: Date.now()
    });
    serverState = confirmed;
    lastRegisteredToken = null;
    renderNotificationState(STATES.OFF, '', completed.desired);
    if (messaging && typeof messaging.deleteToken === 'function') {
      try { await messaging.deleteToken(); } catch (_error) { /* サーバー側OFFを維持する。 */ }
    }
  }

  async function reconcileOffAfterTimeout(installationId, intent) {
    try {
      const status = await readServerState(installationId);
      if (isCurrentOperation(intent.operation_id, false) && status.enabled === false) {
        await markServerOff(intent, status);
        return true;
      }
    } catch (_error) { /* pendingを維持する。 */ }
    return false;
  }

  async function syncOff(installationId, intent) {
    renderNotificationState(STATES.PENDING_OFF, '通知を解除しています…', false);
    try {
      const response = await requestJson('/api/notifications/unsubscribe', { installation_id: installationId });
      if (!isCurrentOperation(intent.operation_id, false)) return;
      await markServerOff(intent, response);
    } catch (error) {
      if (error && error.timedOut && await reconcileOffAfterTimeout(installationId, intent)) return;
      if (isCurrentOperation(intent.operation_id, false)) {
        renderNotificationState(STATES.PENDING_OFF, MESSAGES.OFF_FAILED, false, false);
      }
    }
  }

  async function subscribeWithConflictRetry(installationId, token, revision, intent) {
    try {
      return await requestJson('/api/notifications/subscribe', {
        installation_id: installationId, token, expected_revision: revision
      });
    } catch (error) {
      if (!error || error.status !== 409 || error.code !== 'REVISION_CONFLICT') throw error;
      if (!isCurrentOperation(intent.operation_id, true)) throw error;
      const refreshed = await readServerState(installationId);
      if (!isCurrentOperation(intent.operation_id, true)) throw error;
      return requestJson('/api/notifications/subscribe', {
        installation_id: installationId, token, expected_revision: refreshed.revision
      });
    }
  }

  async function finishServerOn(intent, response, token) {
    if (!isCurrentOperation(intent.operation_id, true)) return;
    const confirmed = validateServerState(response);
    if (!confirmed.enabled) throw new PortalNotificationError('INVALID_RESPONSE', '通知APIの応答が不正です');
    const completed = writeIntent({
      desired: true, operation_id: intent.operation_id, pending: false, last_synced_at: Date.now()
    });
    serverState = confirmed;
    lastRegisteredToken = token;
    renderNotificationState(STATES.ON, '新着通知を受信します', completed.desired);
  }

  async function reconcileOnAfterTimeout(installationId, token, intent) {
    try {
      const status = await readServerState(installationId);
      if (!isCurrentOperation(intent.operation_id, true)) return true;
      const response = await subscribeWithConflictRetry(installationId, token, status.revision, intent);
      if (!isCurrentOperation(intent.operation_id, true)) return true;
      await finishServerOn(intent, response, token);
      return true;
    } catch (_error) {
      return false;
    }
  }

  async function turnOffAfterPermissionLoss(intent) {
    if (!isCurrentOperation(intent.operation_id, true)) return;
    const offIntent = writeIntent({
      desired: false, operation_id: createUuidV4(), pending: true, last_synced_at: intent.last_synced_at
    });
    const installationId = readInstallationId();
    if (!installationId) {
      renderNotificationState(STATES.OFF, '', false);
      return;
    }
    await syncOff(installationId, offIntent);
  }

  async function syncOn(installationId, intent) {
    renderNotificationState(STATES.PENDING_ON, '通知を登録しています…', true);
    const supported = 'Notification' in global && await isMessagingSupported() && Boolean(messaging);
    if (!isCurrentOperation(intent.operation_id, true)) return;
    if (!supported) {
      if (isCurrentOperation(intent.operation_id, true)) renderNotificationState(STATES.UNSUPPORTED, MESSAGES.UNSUPPORTED, true);
      return;
    }
    if (global.Notification.permission === 'denied') {
      try {
        await turnOffAfterPermissionLoss(intent);
      } catch (_error) {
        if (isCurrentOperation(intent.operation_id, true)) {
          renderNotificationState(STATES.ERROR, MESSAGES.STORAGE_FAILED, true);
        }
      }
      return;
    }
    if (global.Notification.permission !== 'granted') {
      if (isCurrentOperation(intent.operation_id, true)) renderNotificationState(STATES.ERROR, MESSAGES.ON_FAILED, true);
      return;
    }

    let token = null;
    try {
      const registration = await registrationPromise;
      if (!isCurrentOperation(intent.operation_id, true)) return;
      if (!registration || !registration.active) {
        throw new PortalNotificationError('SERVICE_WORKER_UNAVAILABLE', 'Service Workerを利用できません');
      }
      token = await messaging.getToken({
        vapidKey: global.FIREBASE_VAPID_KEY,
        serviceWorkerRegistration: registration
      });
      if (!isCurrentOperation(intent.operation_id, true)) return;
      if (typeof token !== 'string' || token.length === 0) {
        throw new PortalNotificationError('TOKEN_UNAVAILABLE', 'FCM tokenを取得できません');
      }
      const status = await readServerState(installationId);
      if (!isCurrentOperation(intent.operation_id, true)) return;
      const recentlySynced = Date.now() - intent.last_synced_at < REFRESH_INTERVAL_MS;
      if (status.enabled && lastRegisteredToken === token && recentlySynced) {
        serverState = status;
        renderNotificationState(STATES.ON, '新着通知を受信します', true);
        return;
      }
      const response = await subscribeWithConflictRetry(installationId, token, status.revision, intent);
      if (!isCurrentOperation(intent.operation_id, true)) return;
      await finishServerOn(intent, response, token);
    } catch (error) {
      if (error && error.timedOut && token && await reconcileOnAfterTimeout(installationId, token, intent)) return;
      if (isCurrentOperation(intent.operation_id, true)) renderNotificationState(STATES.ERROR, MESSAGES.ON_FAILED, true);
    }
  }

  async function syncNotificationSubscription(reason) {
    let intent;
    let installationId;
    try {
      intent = readIntent();
      installationId = readInstallationId();
    } catch (_error) {
      renderNotificationState(STATES.ERROR, MESSAGES.STORAGE_FAILED, false);
      return;
    }
    if (!installationId) {
      renderNotificationState(intent.desired ? STATES.ERROR : STATES.OFF, intent.desired ? MESSAGES.STORAGE_FAILED : '', intent.desired);
      return;
    }
    const isAutomatic = reason === 'launch' || reason === 'visible' || reason === 'online';
    const activeRetryNotBefore = intent.desired ? retryNotBeforeOn : retryNotBeforeOff;
    if (Date.now() < activeRetryNotBefore) {
      renderNotificationState(intent.desired ? STATES.ERROR : STATES.PENDING_OFF,
        intent.desired ? MESSAGES.ON_FAILED : MESSAGES.OFF_FAILED, intent.desired, false);
      return;
    }
    if (isAutomatic && !(intent.desired === false && intent.pending)) {
      if (Date.now() - lastAutoAttemptAt < AUTO_SYNC_INTERVAL_MS) return;
      lastAutoAttemptAt = Date.now();
    }
    if (!intent.desired) {
      if (intent.pending) await syncOff(installationId, intent);
      else renderNotificationState(STATES.OFF, '', false);
      return;
    }
    await syncOn(installationId, intent);
  }

  async function setDesiredEnabled(desired) {
    if (typeof desired !== 'boolean') throw new TypeError('desired must be boolean');
    let permissionPromise = null;
    if (desired) {
      if (!('Notification' in global)) {
        renderNotificationState(STATES.UNSUPPORTED, MESSAGES.UNSUPPORTED, viewState.desired);
        return;
      }
      try {
        permissionPromise = global.Notification.permission === 'granted'
          ? Promise.resolve('granted') : global.Notification.requestPermission();
      } catch (_error) {
        renderNotificationState(STATES.ERROR, MESSAGES.ON_FAILED, viewState.desired);
        return;
      }
    }

    let installationId;
    let intent;
    try {
      installationId = getOrCreateInstallationId();
      const previous = readIntent();
      intent = writeIntent({
        desired, operation_id: createUuidV4(), pending: true, last_synced_at: previous.last_synced_at
      });
    } catch (_error) {
      renderNotificationState(STATES.ERROR, MESSAGES.STORAGE_FAILED, desired);
      return;
    }
    renderNotificationState(desired ? STATES.PENDING_ON : STATES.PENDING_OFF,
      desired ? '通知を登録しています…' : '通知を解除しています…', desired);

    if (desired) {
      let permission;
      try { permission = await permissionPromise; } catch (_error) { permission = 'default'; }
      if (!isCurrentOperation(intent.operation_id, true)) return;
      if (permission !== 'granted') {
        let offIntent;
        try {
          offIntent = writeIntent({
            desired: false, operation_id: createUuidV4(), pending: true, last_synced_at: intent.last_synced_at
          });
        } catch (_error) {
          renderNotificationState(STATES.ERROR, MESSAGES.STORAGE_FAILED, true);
          return;
        }
        await syncOff(installationId, offIntent);
        return;
      }
    }
    await syncNotificationSubscription('user');
  }

  function bindLifecycleListeners() {
    if (listenersBound) return;
    listenersBound = true;
    global.addEventListener('online', function () { void syncNotificationSubscription('online'); });
    global.document.addEventListener('visibilitychange', function () {
      if (global.document.visibilityState === 'visible') void syncNotificationSubscription('visible');
    });
    global.addEventListener('storage', function (event) {
      if (event.key !== INTENT_KEY) return;
      try {
        const intent = readIntent();
        renderNotificationState(
          intent.desired ? STATES.PENDING_ON : (intent.pending ? STATES.PENDING_OFF : STATES.OFF),
          intent.desired ? '通知を同期しています…' : (intent.pending ? '通知を解除しています…' : ''),
          intent.desired
        );
        void syncNotificationSubscription('user');
      } catch (_error) {
        renderNotificationState(STATES.ERROR, MESSAGES.STORAGE_FAILED, false);
      }
    });
  }

  async function init(options) {
    const settings = options || {};
    messaging = settings.messaging || null;
    registrationPromise = Promise.resolve(settings.registrationPromise || null);
    stateRenderer = typeof settings.renderState === 'function' ? settings.renderState : function () {};
    initialized = true;
    bindLifecycleListeners();
    let intent;
    let installationId;
    try {
      intent = readIntent();
      installationId = readInstallationId();
    } catch (_error) {
      renderNotificationState(STATES.ERROR, MESSAGES.STORAGE_FAILED, false);
      return;
    }
    if (!installationId) {
      const supported = 'Notification' in global && await isMessagingSupported() && Boolean(messaging);
      renderNotificationState(supported ? STATES.OFF : STATES.UNSUPPORTED, supported ? '' : MESSAGES.UNSUPPORTED, false);
      return;
    }
    if (!intent.desired && !intent.pending) {
      const supported = 'Notification' in global && await isMessagingSupported() && Boolean(messaging);
      renderNotificationState(supported ? STATES.OFF : STATES.UNSUPPORTED, supported ? '' : MESSAGES.UNSUPPORTED, false);
      return;
    }
    await syncNotificationSubscription('launch');
  }

  function getState() {
    return { ...viewState, serverEnabled: serverState.enabled, revision: serverState.revision, initialized };
  }

  function shouldShowForegroundNotification() {
    if (viewState.state !== STATES.ON || serverState.enabled !== true) return false;
    try {
      const intent = readIntent();
      return intent.desired === true && intent.pending === false;
    } catch (_error) {
      return false;
    }
  }

  global.PortalNotifications = Object.freeze({
    STATES, init, getOrCreateInstallationId, readServerState, setDesiredEnabled,
    syncNotificationSubscription, renderNotificationState, getState,
    shouldShowForegroundNotification
  });
})(window);
