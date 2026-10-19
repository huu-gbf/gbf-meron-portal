const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { mount, dateJst } = require('../portal-feedback-admin.js');

const ADMIN_UID = 'wJRZibao8FgMDqDDQ3csPdVuGkx1';
const html = fs.readFileSync(path.join(__dirname, '../feedback-admin.html'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { await tick(); await tick(); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/feedback-admin.html' });
  const scope = dom.window;
  let observer;
  const trace = { queries: [], deletes: [], tokens: [], signIns: [], signOuts: 0, confirms: 0, connections: [] };
  const responses = [];
  const deleteResponses = [];
  let signOutResponse = null;
  const auth = {
    currentUser: null,
    onIdTokenChanged(callback) { observer = callback; queueMicrotask(() => callback(this.currentUser)); return () => { observer = null; }; },
    async signInWithEmailAndPassword(email, password) {
      trace.signIns.push({ email, password });
      const user = account(ADMIN_UID, email);
      this.currentUser = user;
      observer(user);
      return { user };
    },
    async signOut() {
      trace.signOuts++;
      if (signOutResponse) await signOutResponse;
      this.currentUser = null;
      if (observer) observer(null);
    },
    setPersistence() { throw new Error('Changing existing Auth persistence is forbidden'); }
  };
  function account(uid = ADMIN_UID, email = 'admin@example.test', tokenResponse) {
    return { uid, email, getIdToken(force) { trace.tokens.push(force); return tokenResponse || Promise.resolve('mock-token'); } };
  }
  const db = {
    collection(name) {
      const query = { collection: name };
      const chain = {
        orderBy(field, order) { query.orderBy = [field, order]; return this; },
        limit(number) { query.limit = number; return this; },
        startAfter(snapshot) { query.cursor = snapshot; return this; },
        get(options) {
          trace.queries.push({ ...query, options });
          return responses.length ? responses.shift() : Promise.resolve({ docs: [] });
        }
      };
      return chain;
    }
  };
  function doc(id, extra = {}) {
    const value = { schemaVersion: 1, type: 'bug', message: '表示がずれています', name: '', target: '', createdAt: { toDate: () => new Date('2026-10-19T15:00:00Z') }, ...extra };
    return {
      id, data: () => value,
      ref: { delete() { trace.deletes.push(id); return deleteResponses.length ? deleteResponses.shift() : Promise.resolve(); } }
    };
  }
  scope.PortalFeedback = {
    ADMIN_UID, COLLECTION: 'portalFeedback',
    connection(root, needsAuth) { trace.connections.push([root === scope, needsAuth]); return { auth, db, app: {} }; }
  };
  scope.confirm = () => { trace.confirms++; return true; };
  const controller = mount(scope);
  const el = id => scope.document.getElementById('feedback-admin-' + id);
  const signIn = user => { auth.currentUser = user; if (observer) observer(user); };
  t.after(() => { controller.destroy(); dom.window.close(); });
  return {
    scope, auth, trace, controller, account, doc, el, signIn,
    respond(docs) { responses.push(Promise.resolve({ docs })); },
    pending() { const d = deferred(); responses.push(d.promise); return d; },
    fail(error) { responses.push(Promise.reject(error)); },
    pendingDelete() { const d = deferred(); deleteResponses.push(d.promise); return d; },
    pendingSignOut() { const d = deferred(); signOutResponse = d.promise; return d; },
    cards() { return [...el('list').querySelectorAll('[data-feedback-id]')]; },
    deleteButton(id) { return el('list').querySelector('[data-feedback-delete="' + id + '"]'); }
  };
}

test('admin document is noindex and includes shared default-app SDKs in dependency order', () => {
  assert.match(html, /name="robots" content="noindex,nofollow"/);
  const paths = [...html.matchAll(/<script defer src="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(paths, [
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth-compat.js',
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-compat.js',
    'firebase-config.js', 'portal-feedback.js', 'portal-feedback-admin.js'
  ]);
});

test('anonymous and non-admin accounts cannot query; login input elements stay mounted', async t => {
  const f = fixture(t);
  const input = f.el('email');
  await settle();
  assert.equal(f.trace.queries.length, 0);
  assert.equal(f.el('auth-panel').hidden, false);
  f.signIn(f.account('ordinary-user'));
  await settle();
  assert.equal(f.trace.queries.length, 0);
  assert.equal(f.el('panel').hidden, true);
  assert.equal(f.el('account').hidden, false);
  assert.match(f.el('status').textContent, /管理権限がありません/);
  assert.equal(f.el('email'), input);
  assert.deepEqual(f.trace.connections, [[true, true]]);
});

test('email/password login uses existing Auth and leaves password blank', async t => {
  const f = fixture(t);
  await settle();
  const password = f.el('password');
  f.el('email').value = 'admin@example.test';
  password.value = 'mock-password';
  f.el('form').dispatchEvent(new f.scope.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(f.trace.signIns, [{ email: 'admin@example.test', password: 'mock-password' }]);
  assert.equal(f.el('password'), password);
  assert.equal(password.value, '');
  assert.equal(f.el('panel').hidden, false);
  assert.equal(f.trace.queries.length, 1);
});

test('queries use newest-first server reads, 30-row snapshot cursors and refresh resets pagination', async t => {
  const f = fixture(t);
  await settle();
  const first = Array.from({ length: 30 }, (_, index) => f.doc('page1-' + index));
  f.respond(first);
  f.signIn(f.account());
  await settle();
  assert.equal(f.cards().length, 30);
  assert.equal(f.el('next').hidden, false);
  assert.deepEqual(f.trace.queries[0], { collection: 'portalFeedback', orderBy: ['createdAt', 'desc'], limit: 30, options: { source: 'server' } });
  f.respond([f.doc('page2')]);
  f.el('next').click();
  await settle();
  assert.equal(f.trace.queries[1].cursor, first[29]);
  assert.equal(f.cards().length, 31);
  assert.equal(f.el('next').hidden, true);
  f.respond([f.doc('latest')]);
  f.el('refresh').click();
  await settle();
  assert.equal(f.trace.queries[2].cursor, undefined);
  assert.deepEqual(f.cards().map(card => card.dataset.feedbackId), ['latest']);
  assert.ok(f.trace.queries.every(query => query.options.source === 'server'));
});

test('message, name and target render as text, with anonymous/default labels and JST', async t => {
  const f = fixture(t);
  await settle();
  const attack = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  f.respond([f.doc('xss', { message: attack, name: attack, target: attack }), f.doc('empty')]);
  f.signIn(f.account());
  await settle();
  assert.equal(f.el('list').querySelector('img, script'), null);
  assert.equal(f.cards()[0].querySelector('.feedback-message').textContent, attack);
  assert.ok(f.cards()[0].textContent.includes('お名前: ' + attack));
  assert.ok(f.cards()[0].textContent.includes('対象: ' + attack));
  assert.match(f.cards()[1].textContent, /お名前: 匿名/);
  assert.match(f.cards()[1].textContent, /対象: 未指定/);
  assert.match(f.cards()[0].textContent, /2026\/10\/20 00:00:00 JST/);
  assert.equal(dateJst(null), '日時未指定');
});

test('delete requires confirmation and removes a row only after server acknowledgement', async t => {
  const f = fixture(t);
  await settle();
  f.respond([f.doc('delete-me')]);
  f.signIn(f.account());
  await settle();
  f.scope.confirm = () => false;
  f.deleteButton('delete-me').click();
  assert.deepEqual(f.trace.deletes, []);
  f.scope.confirm = () => true;
  const pending = f.pendingDelete();
  f.deleteButton('delete-me').click();
  assert.equal(f.cards().length, 1);
  assert.equal(f.deleteButton('delete-me').disabled, true);
  assert.deepEqual(f.trace.deletes, ['delete-me']);
  pending.resolve();
  await settle();
  assert.equal(f.cards().length, 0);
  assert.match(f.el('status').textContent, /削除しました/);
});

test('failed delete preserves the row and enables retry', async t => {
  const f = fixture(t);
  await settle();
  f.respond([f.doc('keep-me')]);
  f.signIn(f.account());
  await settle();
  const pending = f.pendingDelete();
  f.deleteButton('keep-me').click();
  pending.reject({ code: 'unavailable' });
  await settle();
  assert.equal(f.cards().length, 1);
  assert.equal(f.deleteButton('keep-me').disabled, false);
  assert.match(f.el('status').textContent, /投稿は残っています/);
});

test('logout clears visible data before signOut ACK and discards pending server reads', async t => {
  const f = fixture(t);
  await settle();
  f.respond([f.doc('secret')]);
  f.signIn(f.account());
  await settle();
  const read = f.pending();
  f.el('refresh').click();
  const signOut = f.pendingSignOut();
  f.el('logout').click();
  assert.equal(f.cards().length, 0);
  assert.equal(f.el('panel').hidden, true);
  assert.equal(f.el('user').textContent, '');
  read.resolve({ docs: [f.doc('stale-secret')] });
  await settle();
  assert.equal(f.cards().length, 0);
  signOut.resolve();
  await settle();
  assert.equal(f.trace.signOuts, 1);
  assert.equal(f.el('auth-panel').hidden, false);
});

test('an old account response cannot replace data after logout and new authentication', async t => {
  const f = fixture(t);
  await settle();
  const stale = f.pending();
  f.signIn(f.account());
  await settle();
  f.signIn(null);
  f.respond([f.doc('fresh')]);
  f.signIn(f.account());
  await settle();
  stale.resolve({ docs: [f.doc('stale')] });
  await settle();
  assert.deepEqual(f.cards().map(card => card.dataset.feedbackId), ['fresh']);
});

test('permission loss clears all records and prevents additional reads or deletes', async t => {
  const f = fixture(t);
  await settle();
  f.respond([f.doc('private')]);
  f.signIn(f.account());
  await settle();
  const pending = f.pending();
  f.el('refresh').click();
  pending.reject({ code: 'permission-denied' });
  await settle();
  assert.equal(f.cards().length, 0);
  assert.equal(f.el('panel').hidden, true);
  assert.match(f.el('status').textContent, /認証が失効/);
  f.el('refresh').click();
  assert.equal(f.trace.queries.length, 2);
});

test('a transient refresh failure preserves existing records', async t => {
  const f = fixture(t);
  await settle();
  f.respond([f.doc('preserved')]);
  f.signIn(f.account());
  await settle();
  const pending = f.pending();
  f.el('refresh').click();
  pending.reject({ code: 'unavailable' });
  await settle();
  assert.deepEqual(f.cards().map(card => card.dataset.feedbackId), ['preserved']);
  assert.equal(f.el('refresh').disabled, false);
});

test('pagehide clears private DOM; pageshow revalidates token and restarts the first page', async t => {
  const f = fixture(t);
  await settle();
  const first = Array.from({ length: 30 }, (_, index) => f.doc('old-' + index));
  f.respond(first);
  f.signIn(f.account());
  await settle();
  const stale = f.pending();
  f.el('next').click();
  f.el('password').value = 'sensitive';
  f.scope.dispatchEvent(new f.scope.Event('pagehide'));
  assert.equal(f.cards().length, 0);
  assert.equal(f.el('password').value, '');
  assert.equal(f.el('panel').hidden, true);
  f.respond([f.doc('revalidated')]);
  f.scope.dispatchEvent(new f.scope.Event('pageshow'));
  await settle();
  stale.resolve({ docs: [f.doc('stale-next-page')] });
  await settle();
  assert.equal(f.trace.tokens.at(-1), true);
  assert.equal(f.trace.queries.at(-1).cursor, undefined);
  assert.deepEqual(f.cards().map(card => card.dataset.feedbackId), ['revalidated']);
});

test('a pending deletion cannot change a new session after signout', async t => {
  const f = fixture(t);
  await settle();
  f.respond([f.doc('same-id')]);
  f.signIn(f.account());
  await settle();
  const pending = f.pendingDelete();
  f.deleteButton('same-id').click();
  f.signIn(null);
  f.respond([f.doc('same-id', { message: 'new session data' })]);
  f.signIn(f.account());
  await settle();
  pending.resolve();
  await settle();
  assert.equal(f.cards().length, 1);
  assert.match(f.cards()[0].textContent, /new session data/);
});

test('token rejection blocks admin reads, and pending token validation cannot restore a logged-out session', async t => {
  const f = fixture(t);
  await settle();
  const token = deferred();
  f.signIn(f.account(ADMIN_UID, 'admin@example.test', token.promise));
  f.signIn(null);
  token.resolve('late-token');
  await settle();
  assert.equal(f.trace.queries.length, 0);
  const rejected = deferred();
  f.signIn(f.account(ADMIN_UID, 'admin@example.test', rejected.promise));
  rejected.reject({ code: 'auth/user-token-expired' });
  await settle();
  assert.equal(f.trace.queries.length, 0);
  assert.equal(f.el('panel').hidden, true);
  assert.match(f.el('status').textContent, /認証が失効/);
});
