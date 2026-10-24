/* Independent portal reports. Public pages create documents and never read them. */
(function (root) {
  'use strict';
  const COLLECTION = 'portalFeedback';
  const ADMIN_UID = 'wJRZibao8FgMDqDDQ3csPdVuGkx1';
  const LIMITS = Object.freeze({message: 4000, name: 40, target: 100});
  const connections = new WeakMap();
  const count = value => Array.from(value).length;
  const IMAGE_LIMITS = Object.freeze({count: 5, file: 5 * 1024 * 1024, total: 20 * 1024 * 1024});
  function validateImages(files) {
    if (files.length > IMAGE_LIMITS.count) throw new Error('画像は最大5枚です。');
    let total = 0;
    for (const file of files) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('PNG・JPEG・WebPの画像を選んでください。');
      if (!file.size || file.size > IMAGE_LIMITS.file) throw new Error('画像は1枚5MB以内にしてください。');
      total += file.size;
    }
    if (total > IMAGE_LIMITS.total) throw new Error('画像の合計は20MB以内にしてください。');
  }
  function apiUrl(scope, path = '') {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(scope.location?.hostname);
    const base = local ? scope.PORTAL_FEEDBACK_LOCAL?.apiBaseUrl : scope.API_BASE_URL;
    const url = new URL(base);
    if (local ? !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) : url.protocol !== 'https:') throw Error('Invalid API configuration');
    return url.href.replace(/\/$/, '') + '/api/portal-feedback' + path;
  }
  async function apiRequest(scope, path, options = {}) {
    const response = await scope.fetch(apiUrl(scope, path), {...options, credentials: 'omit', cache: 'no-store'});
    if (!response.ok) throw Object.assign(Error('Request failed'), {code: response.status === 403 ? 'permission-denied' : 'request-failed'});
    return response;
  }
  function inputError(field, message) { return Object.assign(new Error(message), {field}); }
  function normalizeFeedback(input) {
    if (!input || !['bug', 'request', 'other'].includes(input.type)) {
      throw inputError('type', '種別を選んでください。');
    }
    const data = {schemaVersion: 1, type: input.type};
    for (const field of ['message', 'name', 'target']) {
      if (typeof input[field] !== 'string') throw inputError(field, '入力内容を確認してください。');
      const raw = field === 'message' ? input[field].replace(/\r\n?/g, '\n') : input[field];
      const forbidden = field === 'message' ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
        : /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/;
      if (forbidden.test(raw)) throw inputError(field, '使用できない文字が含まれています。');
      const value = raw.trim();
      if (field === 'message' && !value) throw inputError(field, '内容を入力してください。');
      if (count(value) > LIMITS[field]) {
        throw inputError(field, `${field === 'message' ? '内容' : field === 'name' ? '名前' : '対象ページ・機能'}は${LIMITS[field]}文字以内で入力してください。`);
      }
      data[field] = value;
    }
    return Object.freeze(data);
  }
  function connection(scope = root, needsAuth = false) {
    const key = needsAuth ? 'admin' : 'public';
    const cached = connections.get(scope);
    if (cached?.[key]) return cached[key];
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(scope.location?.hostname);
    const local = scope.PORTAL_FEEDBACK_LOCAL;
    if ((loopback && !local) || (!loopback && local)) throw new Error('LOCAL_CONFIGURATION_REQUIRED');
    if (!loopback && scope.location?.protocol !== 'https:') throw new Error('HTTPS_REQUIRED');
    if (local && (!/^demo-/.test(local.firebaseConfig?.projectId || '')
        || local.firestoreHost !== '127.0.0.1' || local.firestorePort !== 8080
        || local.authEmulatorUrl !== 'http://127.0.0.1:9099')) throw new Error('INVALID_LOCAL_CONFIGURATION');
    const config = local ? local.firebaseConfig : scope.firebaseConfig;
    if (!scope.firebase?.initializeApp || !config?.projectId || !config?.apiKey || !config?.appId) {
      throw new Error('SERVICE_UNAVAILABLE');
    }
    const name = needsAuth ? '[DEFAULT]' : 'portal-feedback-public';
    const app = scope.firebase.apps.find(value => value.name === name)
      || (needsAuth ? scope.firebase.initializeApp(config) : scope.firebase.initializeApp(config, name));
    const db = app.firestore();
    if (local) db.useEmulator(local.firestoreHost, local.firestorePort);
    const auth = needsAuth ? app.auth() : undefined;
    if (local && auth) auth.useEmulator(local.authEmulatorUrl, {disableWarnings: true});
    const value = Object.freeze({app, db, auth});
    connections.set(scope, {...cached, [key]: value});
    return value;
  }
  function createSubmission({write, makeId, isOnline = () => true, onState = () => {}}) {
    let state = {status: 'idle'}, attempt;
    const publish = next => { state = next; onState({...state}); };
    return Object.freeze({
      snapshot: () => ({...state}),
      async submit(input) {
        if (state.status === 'sending' || state.status === 'success') return false;
        let data;
        try {
          data = normalizeFeedback(input);
          if (input.attachments?.length) {
            validateImages(input.attachments.map(item => item.file));
            data = {...data, attachments: input.attachments};
          }
        }
        catch (error) { publish({status: 'error', field: error.field, message: error.message}); return false; }
        if (!isOnline()) {
          publish({status: 'error', message: '通信できません。接続を確認して、もう一度送信してください。'});
          return false;
        }
        // Lock before initializing the SDK or awaiting transport. Repeated submit
        // events share one logical attempt, including after a rejected write.
        publish({status: 'sending'});
        try {
          const signature = JSON.stringify(data);
          if (!attempt || attempt.signature !== signature) attempt = {id: makeId(data), signature, data};
          await write(attempt.id, attempt.data);
          publish({status: 'success'});
          return true;
        } catch (_) {
          publish({status: 'error', message: '送信を完了できませんでした。入力内容は残っています。接続を確認して再試行してください。'});
          return false;
        }
      },
      reset() {
        if (state.status === 'sending') return false;
        attempt = undefined; publish({status: 'idle'}); return true;
      }
    });
  }
  function mountPublic(scope = root) {
    const doc = scope.document, form = doc.getElementById('feedback-form');
    if (!form || form.dataset.mounted) return;
    form.dataset.mounted = 'true';
    const fields = Object.fromEntries(['type', 'message', 'name', 'target'].map(field =>
      [field, doc.getElementById('feedback-' + field)]));
    const button = doc.getElementById('feedback-submit'), status = doc.getElementById('feedback-status');
    const error = doc.getElementById('feedback-error'), again = doc.getElementById('feedback-new');
    const picker = doc.getElementById('feedback-images'), previews = doc.getElementById('feedback-previews');
    const dropzone = doc.getElementById('feedback-dropzone');
    let selected = [], imageKey = 0;
    const releaseImages = () => { selected.forEach(item => scope.URL.revokeObjectURL(item.url)); selected = []; previews?.replaceChildren(); };
    function renderImages() {
      previews.replaceChildren();
      selected.forEach(item => {
        const card = doc.createElement('div'), img = doc.createElement('img'), remove = doc.createElement('button');
        img.src = item.url; img.alt = item.file.name || '添付画像';
        remove.type = 'button'; remove.className = 'feedback-button feedback-button-secondary';
        remove.textContent = '削除'; remove.setAttribute('aria-label', img.alt + 'を削除');
        remove.addEventListener('click', () => {
          if (['sending', 'success'].includes(sender.snapshot().status)) return;
          selected = selected.filter(value => value !== item); scope.URL.revokeObjectURL(item.url); renderImages();
        });
        card.append(img, remove); previews.append(card);
      });
    }
    function addImages(files) {
      if (['sending', 'success'].includes(sender.snapshot().status)) return;
      try {
        const incoming = Array.from(files);
        validateImages([...selected.map(item => item.file), ...incoming]);
        selected.push(...incoming.map(file => ({file, key: ++imageKey, url: scope.URL.createObjectURL(file)})));
        renderImages(); error.hidden = true; error.textContent = '';
      } catch (failure) { error.hidden = false; error.textContent = failure.message; }
    }
    let timer, composing = false, imeEnter = false;
    const counters = () => {
      for (const field of ['message', 'name', 'target']) {
        doc.getElementById('feedback-' + field + '-count').textContent = `${count(fields[field].value)} / ${LIMITS[field]}`;
      }
    };
    const sender = createSubmission({
      makeId: data => data.attachments ? scope.crypto.randomUUID() : connection(scope).db.collection(COLLECTION).doc().id,
      async write(id, data) {
        if (data.attachments) {
          const attachments = await Promise.all(data.attachments.map(item => new Promise((resolve, reject) => {
            const reader = new scope.FileReader();
            reader.onerror = reject;
            reader.onload = () => resolve({contentType: item.file.type, data: reader.result.split(',')[1]});
            reader.readAsDataURL(item.file);
          })));
          const {schemaVersion, attachments: ignored, ...fields} = data;
          await apiRequest(scope, '', {method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({...fields, requestId: id, attachments})});
          return;
        }
        const {db} = connection(scope);
        return db.collection(COLLECTION).doc(id).set({...data,
          createdAt: scope.firebase.firestore.FieldValue.serverTimestamp()});
      },
      isOnline: () => scope.navigator?.onLine !== false,
      onState(state) {
        scope.clearTimeout(timer);
        const locked = state.status === 'sending' || state.status === 'success';
        for (const [field, element] of Object.entries(fields)) {
          if (field === 'type') element.disabled = locked;
          else element.readOnly = locked;
          element.removeAttribute('aria-invalid');
        }
        button.disabled = locked;
        if (picker) picker.disabled = locked;
        previews?.querySelectorAll('button').forEach(item => { item.disabled = locked; });
        button.textContent = state.status === 'sending' ? '送信中…' : '送信する';
        again.hidden = state.status !== 'success';
        form.setAttribute('aria-busy', String(state.status === 'sending'));
        error.textContent = state.status === 'error' ? state.message : '';
        error.hidden = state.status !== 'error';
        status.textContent = state.status === 'success' ? '送信しました。ご報告ありがとうございます。'
          : state.status === 'sending' ? '送信中…' : '';
        if (state.field && fields[state.field]) fields[state.field].setAttribute('aria-invalid', 'true');
        if (state.status === 'sending') timer = scope.setTimeout(() => {
          status.textContent = '通信を待っています。接続が戻ると送信を続けます。入力内容は保持しています。';
        }, 15000);
      }
    });
    picker?.addEventListener('change', () => { addImages(picker.files); picker.value = ''; });
    form.addEventListener('paste', event => {
      const files = Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
      if (files.length) { event.preventDefault(); addImages(files); }
    });
    dropzone?.addEventListener('dragover', event => { event.preventDefault(); });
    dropzone?.addEventListener('drop', event => { event.preventDefault(); addImages(event.dataTransfer.files); });
    form.addEventListener('input', event => {
      counters();
      const state = sender.snapshot();
      if (state.status === 'error' && state.field && event.target === fields[state.field]) {
        event.target.removeAttribute('aria-invalid');
        error.textContent = ''; error.hidden = true;
      }
    });
    form.addEventListener('compositionstart', () => { composing = true; });
    form.addEventListener('compositionend', () => { composing = false; });
    form.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        if (composing || event.isComposing || event.keyCode === 229) {
          // Allow the IME to commit, but not to implicitly submit even if
          // compositionend arrives before the browser's default action.
          imeEnter = true;
          scope.setTimeout(() => { imeEnter = false; }, 0);
        } else if (event.target.tagName === 'INPUT') event.preventDefault();
      }
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (composing || imeEnter || event.isComposing) return;
      sender.submit({...Object.fromEntries(Object.entries(fields).map(([field, element]) => [field, element.value])), attachments: [...selected]});
    });
    again.addEventListener('click', () => {
      if (!sender.reset()) return;
      releaseImages(); form.reset(); counters(); fields.type.focus();
    });
    scope.addEventListener('beforeunload', event => {
      if (sender.snapshot().status === 'sending') { event.preventDefault(); event.returnValue = ''; }
    });
    counters();
    return sender;
  }
  const api = Object.freeze({COLLECTION, ADMIN_UID, LIMITS, count, normalizeFeedback,
    connection, createSubmission, mountPublic, IMAGE_LIMITS, validateImages, apiRequest});
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.PortalFeedback = api;
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', () => mountPublic(root), {once: true});
    else mountPublic(root);
  }
})(globalThis);
