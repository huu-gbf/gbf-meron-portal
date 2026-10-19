(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.PortalFeedbackAdmin = api;
    const boot = function () { api.mount(root); };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const PAGE_SIZE = 30;
  const TYPE_LABELS = { bug: '不具合', request: '要望', other: 'その他' };
  const AUTH_ERRORS = new Set([
    'permission-denied', 'unauthenticated', 'auth/user-token-expired',
    'auth/invalid-user-token', 'auth/user-disabled', 'auth/id-token-revoked',
    'auth/user-not-found'
  ]);
  const mounts = new WeakMap();

  function dateJst(value) {
    try {
      const date = value && typeof value.toDate === 'function' ? value.toDate() : null;
      if (!date || !Number.isFinite(date.getTime())) return '日時未指定';
      return new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).format(date) + ' JST';
    } catch (_) { return '日時未指定'; }
  }

  function mount(scope) {
    if (mounts.has(scope.document)) return mounts.get(scope.document);
    const document = scope.document;
    const el = id => document.getElementById('feedback-admin-' + id);
    const ui = {
      status: el('status'), authPanel: el('auth-panel'), form: el('form'),
      email: el('email'), password: el('password'), login: el('login'),
      account: el('account'), user: el('user'), logout: el('logout'), panel: el('panel'),
      refresh: el('refresh'), next: el('next'), list: el('list'), empty: el('empty')
    };
    if (Object.values(ui).some(value => !value)) return null;
    let connection;
    try { connection = scope.PortalFeedback.connection(scope, true); }
    catch (_) {
      ui.status.textContent = '接続の準備ができませんでした。設定を確認して再読み込みしてください。';
      ui.status.dataset.state = 'error';
      return null;
    }
    const { auth, db } = connection;
    const shared = scope.PortalFeedback;
    let generation = 0;
    let requestNumber = 0;
    let activeUser = null;
    let validatingUser = null;
    let suspended = false;
    let destroyed = false;
    let loginBusy = false;
    let logoutBusy = false;
    let loadBusy = false;
    let cursor = null;
    let hasMore = false;
    let unsubscribe = null;
    const entries = new Map();
    const deleting = new Set();

    function status(message, error) {
      ui.status.textContent = message;
      ui.status.dataset.state = error ? 'error' : 'info';
    }
    function permitted() {
      return !destroyed && !suspended && activeUser && activeUser.uid === shared.ADMIN_UID &&
        auth.currentUser && auth.currentUser.uid === shared.ADMIN_UID;
    }
    function current(epoch) { return generation === epoch && permitted(); }
    function controls() {
      const busy = loadBusy || deleting.size > 0;
      ui.refresh.disabled = !permitted() || busy;
      ui.next.disabled = !permitted() || busy;
      ui.next.hidden = !permitted() || !hasMore;
      ui.login.disabled = loginBusy || logoutBusy;
      ui.logout.disabled = logoutBusy;
    }
    function clearPrivate() {
      generation++;
      requestNumber++;
      activeUser = null;
      validatingUser = null;
      cursor = null;
      hasMore = false;
      loadBusy = false;
      entries.clear();
      deleting.clear();
      ui.list.replaceChildren();
      ui.list.removeAttribute('aria-busy');
      ui.empty.hidden = true;
      ui.panel.hidden = true;
      ui.account.hidden = true;
      ui.user.textContent = '';
      ui.password.value = '';
      controls();
    }
    function expired() {
      clearPrivate();
      ui.authPanel.hidden = suspended;
      status('認証が失効したか、管理権限を確認できませんでした。再度ログインしてください。', true);
    }
    function authorizationFailure(error) {
      return error && AUTH_ERRORS.has(String(error.code || '').replace(/^firestore\//, ''));
    }
    function makeText(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = text;
      return node;
    }
    function append(snapshot) {
      if (entries.has(snapshot.id)) return;
      const data = snapshot.data();
      const card = document.createElement('article');
      card.className = 'feedback-card';
      card.dataset.feedbackId = snapshot.id;
      const meta = document.createElement('div');
      meta.className = 'feedback-card-meta';
      meta.append(
        makeText('span', 'feedback-tag', TYPE_LABELS[data.type] || 'その他'),
        makeText('time', 'feedback-muted', dateJst(data.createdAt))
      );
      card.append(meta);
      card.append(makeText('p', 'feedback-message', typeof data.message === 'string' ? data.message : ''));
      card.append(makeText('p', 'feedback-muted', 'お名前: ' + (typeof data.name === 'string' && data.name.trim() ? data.name : '匿名')));
      card.append(makeText('p', 'feedback-muted', '対象: ' + (typeof data.target === 'string' && data.target.trim() ? data.target : '未指定')));
      const actions = document.createElement('div');
      actions.className = 'feedback-actions';
      const button = makeText('button', 'feedback-button feedback-button-danger', '削除');
      button.type = 'button';
      button.dataset.feedbackDelete = snapshot.id;
      const entry = { snapshot, card, button };
      button.addEventListener('click', function () { remove(entry); });
      actions.append(button);
      card.append(actions);
      entries.set(snapshot.id, entry);
      ui.list.append(card);
    }
    async function load(firstPage) {
      if (!permitted() || loadBusy || deleting.size || (!firstPage && !hasMore)) return;
      const epoch = generation;
      const request = ++requestNumber;
      loadBusy = true;
      controls();
      ui.list.setAttribute('aria-busy', 'true');
      status('投稿を読み込んでいます…');
      try {
        let query = db.collection(shared.COLLECTION).orderBy('createdAt', 'desc').limit(PAGE_SIZE);
        if (!firstPage && cursor) query = query.startAfter(cursor);
        const result = await query.get({ source: 'server' });
        if (!current(epoch) || request !== requestNumber) return;
        if (firstPage) {
          entries.clear();
          ui.list.replaceChildren();
        }
        result.docs.forEach(append);
        cursor = result.docs.length ? result.docs[result.docs.length - 1] : (firstPage ? null : cursor);
        hasMore = result.docs.length === PAGE_SIZE;
        ui.empty.hidden = entries.size !== 0;
        status(entries.size ? entries.size + '件の投稿を表示しています。' : '投稿はまだありません。');
      } catch (error) {
        if (!current(epoch) || request !== requestNumber) return;
        if (authorizationFailure(error)) expired();
        else status('読み込めませんでした。通信状態を確認して、再度お試しください。', true);
      } finally {
        if (generation === epoch && request === requestNumber) {
          loadBusy = false;
          ui.list.removeAttribute('aria-busy');
          controls();
        }
      }
    }
    async function remove(entry) {
      if (!permitted() || loadBusy || deleting.has(entry.snapshot.id)) return;
      if (!scope.confirm('この投稿を削除しますか？\n削除した投稿は元に戻せません。')) return;
      if (!permitted() || entries.get(entry.snapshot.id) !== entry) return;
      const epoch = generation;
      const id = entry.snapshot.id;
      deleting.add(id);
      entry.button.disabled = true;
      entry.button.textContent = '削除中…';
      controls();
      status('投稿を削除しています…');
      try {
        await entry.snapshot.ref.delete();
        if (!current(epoch) || entries.get(id) !== entry) return;
        entries.delete(id);
        entry.card.remove();
        ui.empty.hidden = entries.size !== 0 || hasMore;
        status('投稿を削除しました。');
      } catch (error) {
        if (!current(epoch) || entries.get(id) !== entry) return;
        if (authorizationFailure(error)) expired();
        else status('削除できませんでした。投稿は残っています。再度お試しください。', true);
      } finally {
        if (current(epoch)) {
          deleting.delete(id);
          entry.button.disabled = false;
          entry.button.textContent = '削除';
          controls();
        }
      }
    }
    async function authorize(user, forceRefresh) {
      if (suspended || destroyed || logoutBusy) return;
      if (validatingUser === user && user) return;
      clearPrivate();
      ui.authPanel.hidden = false;
      if (!user) {
        status('管理者アカウントでログインしてください。');
        return;
      }
      ui.account.hidden = false;
      ui.user.textContent = user.email || 'ログイン中';
      if (user.uid !== shared.ADMIN_UID) {
        status('このアカウントには管理権限がありません。管理者アカウントでログインしてください。', true);
        return;
      }
      const epoch = generation;
      validatingUser = user;
      status('管理権限を確認しています…');
      try {
        await user.getIdToken(Boolean(forceRefresh));
        if (generation !== epoch || suspended || destroyed || !auth.currentUser || auth.currentUser.uid !== user.uid) return;
        activeUser = user;
        ui.authPanel.hidden = true;
        ui.panel.hidden = false;
        controls();
        await load(true);
      } catch (_) {
        if (generation === epoch && !suspended && !destroyed) expired();
      } finally {
        if (validatingUser === user) validatingUser = null;
      }
    }
    function onUser(user) { authorize(user, false); }
    async function login(event) {
      event.preventDefault();
      if (loginBusy || logoutBusy || suspended || destroyed || !ui.form.reportValidity()) return;
      const email = ui.email.value.trim();
      let password = ui.password.value;
      clearPrivate();
      ui.authPanel.hidden = false;
      loginBusy = true;
      controls();
      const epoch = generation;
      status('ログインしています…');
      try {
        const result = await auth.signInWithEmailAndPassword(email, password);
        password = '';
        if (generation === epoch && !suspended && !destroyed) await authorize(result.user, false);
      } catch (_) {
        if (generation === epoch && !suspended && !destroyed) status('ログインできませんでした。メールアドレスとパスワードをご確認ください。', true);
      } finally {
        password = '';
        loginBusy = false;
        ui.password.value = '';
        controls();
      }
    }
    async function logout() {
      if (logoutBusy || destroyed) return;
      logoutBusy = true;
      clearPrivate();
      ui.authPanel.hidden = suspended;
      controls();
      status('ログアウトしています…');
      const epoch = generation;
      try {
        await auth.signOut();
        if (generation === epoch && !suspended && !destroyed) status('ログアウトしました。');
      } catch (_) {
        if (generation === epoch && !suspended && !destroyed) status('ログアウトできませんでした。再読み込みして、認証状態を確認してください。', true);
      } finally {
        logoutBusy = false;
        controls();
      }
    }
    function pagehide() {
      suspended = true;
      clearPrivate();
      ui.authPanel.hidden = true;
      status('認証状態を確認しています…');
    }
    function pageshow() {
      if (!suspended || destroyed) return;
      suspended = false;
      authorize(auth.currentUser, true);
    }
    function destroy() {
      destroyed = true;
      clearPrivate();
      ui.authPanel.hidden = true;
      if (unsubscribe) unsubscribe();
      ui.form.removeEventListener('submit', login);
      ui.logout.removeEventListener('click', logout);
      ui.refresh.removeEventListener('click', refresh);
      ui.next.removeEventListener('click', next);
      scope.removeEventListener('pagehide', pagehide);
      scope.removeEventListener('pageshow', pageshow);
      mounts.delete(document);
    }
    function refresh() { load(true); }
    function next() { load(false); }
    ui.form.addEventListener('submit', login);
    ui.logout.addEventListener('click', logout);
    ui.refresh.addEventListener('click', refresh);
    ui.next.addEventListener('click', next);
    scope.addEventListener('pagehide', pagehide);
    scope.addEventListener('pageshow', pageshow);
    const controller = { destroy };
    mounts.set(document, controller);
    controls();
    try {
      const observe = typeof auth.onIdTokenChanged === 'function' ? auth.onIdTokenChanged : auth.onAuthStateChanged;
      unsubscribe = observe.call(auth, onUser, expired);
    } catch (_) { expired(); }
    return controller;
  }
  return { mount, dateJst };
});
