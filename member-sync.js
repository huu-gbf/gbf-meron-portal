/* Member identity foundation. Load after Firebase 10 compat app/auth/firestore.
 * Restoration never creates an account. Only an explicit action signs in.
 * Calculator settings are never read or uploaded by this module.
 */
(function (root) {
  'use strict';
  const APP_NAME = 'member-sync';

  function createMemberSync(firebase, config, options = {}) {
    let connection;
    let starting;
    let signingIn;

    async function restoreAuthentication() {
      if (starting) return starting;
      starting = (async () => {
        if (!connection) {
          const existing = firebase.apps.find(app => app.name === APP_NAME);
          if (existing && (existing.options.projectId !== config.projectId
              || existing.options.apiKey !== config.apiKey
              || existing.options.appId !== config.appId)) {
            throw new Error('member-sync Firebase configuration mismatch');
          }
          const app = existing || firebase.initializeApp(config, APP_NAME);
          connection = { app, auth: app.auth(), db: app.firestore() };
          if (!existing && options.connectEmulators) options.connectEmulators(connection);
        }
        const { auth } = connection;
        await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
        // Wait for persisted credentials before deciding to create an account.
        await new Promise((resolve, reject) => {
          let unsubscribe;
          unsubscribe = auth.onAuthStateChanged(() => {
            Promise.resolve().then(() => { unsubscribe(); resolve(); });
          }, error => {
            Promise.resolve().then(() => { unsubscribe(); reject(error); });
          });
        });
        if (auth.currentUser && !auth.currentUser.isAnonymous) {
          throw new Error('member-sync requires its own anonymous authentication');
        }
        return auth.currentUser;
      })();
      try { return await starting; }
      finally { starting = null; }
    }

    async function startAuthentication() {
      await restoreAuthentication();
      if (!connection.auth.currentUser) {
        if (!signingIn) signingIn = connection.auth.signInAnonymously();
        try { await signingIn; } finally { signingIn = null; }
      }
      if (!connection.auth.currentUser?.isAnonymous) throw new Error('UNAUTHENTICATED');
      return connection.auth.currentUser;
    }

    async function request(path, body) {
      const user = connection?.auth.currentUser;
      if (!user?.isAnonymous) throw new Error('UNAUTHENTICATED');
      let token;
      try { token = await user.getIdToken(); }
      catch (error) {
        if (['auth/user-disabled', 'auth/user-token-expired', 'auth/invalid-user-token', 'auth/user-not-found'].includes(error.code)) {
          throw new Error('UNAUTHENTICATED');
        }
        throw error;
      }
      if (connection.auth.currentUser !== user) throw new Error('UNAUTHENTICATED');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await (options.fetch || root.fetch)(options.apiBase + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal
        });
        const data = await response.json();
        if (connection.auth.currentUser !== user) throw new Error('UNAUTHENTICATED');
        if (!response.ok) throw new Error(data?.error?.code || 'NETWORK');
        return data;
      } finally { clearTimeout(timeout); }
    }

    async function getIdentity() {
      const user = connection?.auth.currentUser;
      if (!user?.isAnonymous) throw new Error('Start member authentication first');
      // Server read avoids treating a revoked, cached membership as current.
      const snapshot = await connection.db.doc('memberIdentities/' + user.uid)
        .get({ source: 'server' });
      return snapshot.exists ? snapshot.data() : null;
    }

    return Object.freeze({ startAuthentication, restoreAuthentication, getIdentity, request });
  }

  const messages = Object.freeze({
    UNAUTHENTICATED: '認証を確認できません。再読み込みしてください',
    MEMBERSHIP_REQUIRED: 'この端末は接続されていません',
    INVITE_UNAVAILABLE: 'このコードは使用できません',
    INVALID_INPUT: 'コードが正しくありません',
    DEVICE_LIMIT: '端末数の上限に達しています',
    RATE_LIMITED: 'しばらく待ってからお試しください',
    NOT_READY: '現在、端末同期は利用できません'
  });
  const errorText = error => Object.hasOwn(messages, error?.message) ? messages[error.message] : '通信に失敗しました';
  function normalizeCode(value) {
    const code = value.trim().replace(/-/g, '').toUpperCase();
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/.test(code)) throw new Error('INVALID_INPUT');
    return code;
  }

  // Block 3B intentionally has no production fallback, including API_BASE_URL.
  function localOptions(settings, location) {
    if (!settings || !['localhost', '127.0.0.1'].includes(location.hostname)) throw new Error('NOT_READY');
    const url = new URL(settings.apiBase, location.href);
    if (url.origin !== location.origin || url.pathname !== '/api/member-sync'
        || url.search || url.hash || url.username || url.password
        || url.protocol !== 'http:') throw new Error('NOT_READY');
    if (settings.firebaseConfig?.projectId !== 'gbf-meron-portal'
        || settings.firebaseConfig.apiKey !== 'local-only') throw new Error('NOT_READY');
    return {
      apiBase: url.href,
      connectEmulators({auth, db}) {
        auth.useEmulator('http://127.0.0.1:9099', {disableWarnings: true});
        db.useEmulator('127.0.0.1', 8080);
      }
    };
  }

  function createPairing(client, publish, lifecycle = {}) {
    let state = {status: 'unconfigured', busy: false, message: '', invite: null, requests: []};
    let timer, polling, disposed = false, inFlight = false, failures = 0;
    const visible = lifecycle.visible || (() => true);
    const later = lifecycle.setTimeout || setTimeout;
    const cancel = lifecycle.clearTimeout || clearTimeout;
    const emit = patch => { state = {...state, ...patch}; if (!disposed) publish({...state}); };
    const schedule = () => {
      cancel(timer);
      if (!disposed && ['ready', 'pending', 'recovering'].includes(state.status)) {
        timer = later(poll, Math.min(60000, 10000 * (2 ** failures)));
      }
    };
    function failure(error) {
      const denied = ['UNAUTHENTICATED', 'MEMBERSHIP_REQUIRED'].includes(error.message);
      emit({message: errorText(error), error: true,
        ...(denied ? {status: 'denied', invite: null, requests: []} : {})});
      failures = Math.min(failures + 1, 3);
    }
    async function refresh() {
      const result = await client.request('/status');
      if (!['ready','pending','unconfigured','expired','rejected','revoked'].includes(result.status)) throw new Error('NETWORK');
      const previous = state.status;
      const terminal = {expired:'コードの有効期限が切れています', rejected:'追加申請が拒否されました', revoked:'このコードは使用できません'};
      emit({status: result.status, error: false,
        message: terminal[result.status] || (previous === 'pending' && result.status === 'ready' ? '同期設定が完了しました' : ''),
        ...(result.status !== 'ready' ? {invite: null, requests: []} : {})});
      if (result.status === 'ready') {
        const pending = await client.request('/invites/pending');
        emit({requests: pending.requests});
      }
      if (state.invite && Date.parse(state.invite.expiresAt) <= Date.now()) emit({invite: null, message: 'コードの有効期限が切れています'});
      failures = 0;
    }
    async function poll() {
      if (disposed || inFlight || !['ready', 'pending', 'recovering'].includes(state.status)) return;
      if (!visible()) { schedule(); return; }
      inFlight = true;
      polling = (async () => {
        try { await refresh(); } catch (error) { failure(error); }
        finally { inFlight = false; schedule(); }
      })();
      try { await polling; } finally { polling = null; }
    }
    async function action(operation) {
      // A click during background refresh must not be silently discarded.
      if (polling) await polling;
      if (disposed || inFlight) return;
      inFlight = true; cancel(timer); emit({busy: true, message: '', error: false});
      try { await operation(); failures = 0; }
      catch (error) { failure(error); }
      finally { inFlight = false; emit({busy: false}); schedule(); }
    }
    return Object.freeze({
      async restore() {
        return action(async () => {
          const user = await client.restoreAuthentication();
          if (user) { emit({status: 'recovering'}); await refresh(); }
        });
      },
      start: () => action(async () => {
        await client.startAuthentication();
        emit({status: 'recovering'});
        await client.request('/profile', {});
        emit({status: 'ready', message: '同期設定が完了しました'});
      }),
      issue: () => action(async () => {
        if (state.status !== 'ready') throw new Error('MEMBERSHIP_REQUIRED');
        // A failed reissue may already have invalidated the old code on the server.
        emit({invite: null});
        const invite = await client.request('/invites', {});
        emit({invite});
      }),
      claim: value => action(async () => {
        const code = normalizeCode(value);
        await client.startAuthentication();
        emit({status: 'recovering'});
        await client.request('/invites/claim', {code});
        emit({status: 'pending', invite: null, requests: []});
      }),
      decide: (requestId, decision) => action(async () => {
        if (!['approve','reject'].includes(decision) || !/^[a-f0-9]{32}$/.test(requestId)) throw new Error('INVALID_INPUT');
        await client.request('/invites/' + requestId + '/' + decision, {});
        emit({requests: state.requests.filter(r => r.requestId !== requestId), invite: null,
          message: decision === 'approve' ? '端末を追加しました' : '追加申請を拒否しました'});
      }),
      poll,
      dispose() { disposed = true; cancel(timer); },
      resume() { disposed = false; schedule(); },
      snapshot: () => ({...state})
    });
  }

  function mount(element) {
    const $ = id => element.querySelector('[data-sync="' + id + '"]');
    let pairing, loading, current, showInput = false;
    const render = state => {
      current = state;
      const ready = state.status === 'ready', pending = state.status === 'pending';
      $('status').textContent = state.error ? 'エラー' : ready ? '接続済み' : pending ? '承認待ち' : state.status === 'recovering' ? '確認中' : '未設定';
      $('choices').hidden = ready || pending || ['denied','recovering'].includes(state.status);
      $('join-form').hidden = $('choices').hidden || !showInput;
      $('add').hidden = !ready;
      $('waiting').hidden = !pending;
      $('message').textContent = state.message;
      $('invite').hidden = !state.invite;
      $('code').textContent = state.invite ? state.invite.code.match(/.{1,4}/g).join('-') : '';
      $('add').textContent = state.invite ? '新しいコードを発行' : '別の端末を追加';
      $('requests').replaceChildren();
      for (const request of state.requests) {
        const row = document.createElement('div'); row.className = 'member-sync-request';
        const text = document.createElement('p'); text.textContent = '新しい端末から追加申請があります'; row.append(text);
        const actions = document.createElement('div'); actions.className = 'member-sync-actions';
        for (const [label, decision] of [['承認','approve'], ['拒否','reject']]) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
          button.disabled = state.busy; button.className = decision === 'approve' ? 'member-sync-primary' : '';
          button.addEventListener('click', () => pairing.decide(request.requestId, decision)); actions.append(button);
        }
        row.append(actions); $('requests').append(row);
      }
      $('notice').textContent = state.requests.length ? '追加申請があります' : '';
      element.querySelectorAll('button, input').forEach(control => { control.disabled = state.busy; });
      element.setAttribute('aria-busy', String(state.busy));
    };
    const getPairing = async () => {
      if (pairing) return pairing;
      if (loading) return loading;
      loading = (async () => {
        const settings = root.MEMBER_SYNC_LOCAL;
        const options = localOptions(settings, root.location);
        for (const part of ['app','auth','firestore']) {
          if (part === 'app' ? root.firebase?.initializeApp : root.firebase?.[part]) continue;
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/sdk/firebase-' + part + '-compat.js';
            script.onload = resolve; script.onerror = () => reject(new Error('NOT_READY'));
            document.head.append(script);
          });
        }
        const client = createMemberSync(root.firebase, settings.firebaseConfig, options);
        pairing = createPairing(client, render, {visible: () => !document.hidden});
        return pairing;
      })();
      try { return await loading; } finally { loading = null; }
    };
    const invoke = async fn => {
      try { await fn(await getPairing()); }
      catch (error) { render({...current, error: true, message: errorText(error), busy: false}); }
    };
    render({status:'unconfigured', busy:false, message:'', invite:null, requests:[]});
    $('start').onclick = () => invoke(p => p.start());
    $('join').onclick = () => { showInput = true; render(current); $('input').focus(); };
    $('join-form').onsubmit = event => { event.preventDefault(); invoke(p => p.claim($('input').value)); };
    $('add').onclick = () => invoke(p => p.issue());
    $('copy').onclick = async () => {
      try { await navigator.clipboard.writeText($('code').textContent); $('message').textContent = 'コードをコピーしました'; }
      catch { $('message').textContent = 'コピーできませんでした。コードを選択してコピーしてください'; }
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pairing?.poll(); });
    root.addEventListener('pagehide', () => pairing?.dispose());
    root.addEventListener('pageshow', () => pairing?.resume());
    // Restore only in the explicitly configured local fixture; never sign in here.
    if (root.MEMBER_SYNC_LOCAL) invoke(p => p.restore());
  }

  const api = Object.freeze({ APP_NAME, createMemberSync, createPairing, normalizeCode, errorText, localOptions, mount });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.MemberSync = api;
    const element = document.querySelector('[data-member-sync]');
    if (element) mount(element);
  }
})(globalThis);
