/* Input and lifecycle tests. Firebase is mocked; no network is opened. */
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const {normalizeFeedback, createSubmission, connection, mountPublic} = require('../portal-feedback');
const input = (extra = {}) => ({type: 'bug', message: '日本語の報告\n2行目 😀', name: '', target: '', ...extra});
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; }
function fixture(write = () => Promise.resolve()) {
  const dom = new JSDOM(fs.readFileSync('feedback.html', 'utf8'), {url: 'https://portal.example.test/feedback.html', runScripts: 'outside-only'});
  const scope = dom.window, saved = [], reads = [], creates = [];
  let serial = 0;
  const db = {collection(name) {
    assert.equal(name, 'portalFeedback');
    return {doc(id) { return {id: id || 'report-' + (++serial), set(data) { saved.push({id, data}); return write(data); },
      get() { reads.push(id); throw Error('public read forbidden'); }}; }};
  }};
  scope.firebaseConfig = {projectId: 'fixture', apiKey: 'fixture', appId: 'fixture'};
  scope.firebase = {apps: [], firestore: {FieldValue: {serverTimestamp: () => 'server-time'}},
    initializeApp(config, name) { creates.push(name); return {name, firestore: () => db, auth() { throw Error('public Auth forbidden'); }}; }};
  const sender = mountPublic(scope), doc = scope.document;
  const field = name => doc.getElementById('feedback-' + name);
  function fill(data = input()) { for (const name of ['type', 'message', 'name', 'target']) field(name).value = data[name]; }
  function submit() { doc.getElementById('feedback-form').dispatchEvent(new scope.Event('submit', {bubbles: true, cancelable: true})); }
  return {dom, scope, doc, field, sender, saved, reads, creates, fill, submit};
}
for (const type of ['bug', 'request', 'other']) test(type + ' accepts anonymous names without mutating input', () => {
  const source = input({type, name: '  ', target: '  '}), before = {...source}, normalized = normalizeFeedback(source);
  assert.deepEqual(normalized, {schemaVersion: 1, type, message: source.message, name: '', target: ''});
  assert.deepEqual(source, before); assert(Object.isFrozen(normalized));
});
test('normalization preserves Japanese emoji LF and tabs and normalizes CRLF', () => {
  assert.deepEqual(normalizeFeedback(input({message: ' \r\n報告\t😀\r続き \r\n', name: ' 団員 ', target: ' 周回効率計算機 '})),
    {schemaVersion: 1, type: 'bug', message: '報告\t😀\n続き', name: '団員', target: '周回効率計算機'});
});
test('missing required values, whitespace-only messages and wrong types reject', () => {
  for (const type of ['', 'unknown', null, true]) assert.throws(() => normalizeFeedback(input({type})), {field: 'type'});
  for (const message of ['', ' \t\n\u3000\u00a0\u1680\u2000\u2028\u202f\u205f\ufeff']) assert.throws(() => normalizeFeedback(input({message})), {field: 'message'});
  for (const field of ['message', 'name', 'target']) for (const value of [null, [], {}, 12]) assert.throws(() => normalizeFeedback(input({[field]: value})), {field});
});
test('exact codepoint limits accept Japanese/emoji boundaries and reject the next character', () => {
  for (const [field, limit] of [['message', 4000], ['name', 40], ['target', 100]]) for (const character of ['あ', '😀']) {
    assert.equal(Array.from(normalizeFeedback(input({[field]: character.repeat(limit)}))[field]).length, limit);
    assert.throws(() => normalizeFeedback(input({[field]: character.repeat(limit + 1)})), {field});
  }
});
test('invalid controls and single-line separators are rejected', () => {
  for (const field of ['message', 'name', 'target']) for (const character of ['\u0000', '\u000b', '\u001f', '\u007f', '\u0085']) assert.throws(() => normalizeFeedback(input({[field]: 'a' + character + 'b'})), {field});
  for (const field of ['name', 'target']) for (const character of ['\n', '\r', '\u2028', '\u2029']) assert.throws(() => normalizeFeedback(input({[field]: 'a' + character + 'b'})), {field});
});
test('multiple submits share one write and only the actual ACK is success', async () => {
  const hold = deferred(), calls = [], states = [];
  const sender = createSubmission({makeId: () => 'one-id', write: (...args) => { calls.push(args); return hold.promise; }, onState: state => states.push(state.status)});
  const pending = sender.submit(input());
  assert.equal(await sender.submit(input()), false); assert.equal(calls.length, 1);
  assert.equal(sender.snapshot().status, 'sending'); assert.equal(sender.reset(), false);
  hold.resolve(); assert.equal(await pending, true);
  assert.equal(await sender.submit(input()), false); assert.equal(calls.length, 1); assert.deepEqual(states, ['sending', 'success']);
  assert.equal(sender.reset(), true); assert.equal(sender.snapshot().status, 'idle');
});
test('rejected unchanged retries reuse the ID and a new report gets a new ID', async () => {
  let ids = 0, fail = true; const calls = [];
  const sender = createSubmission({makeId: () => 'id-' + (++ids), write: async (id, data) => { calls.push({id, data}); if (fail) throw Error('unavailable'); }});
  assert.equal(await sender.submit(input()), false); assert.equal(sender.snapshot().status, 'error');
  fail = false; assert.equal(await sender.submit(input()), true); assert.equal(ids, 1); assert.equal(calls[0].id, calls[1].id);
  sender.reset(); await sender.submit(input({message: '次の報告'})); assert.equal(ids, 2);
});
test('invalid input and offline state cause zero writes and zero document IDs', async () => {
  let writes = 0, ids = 0;
  const sender = createSubmission({makeId: () => { ids++; }, write: () => { writes++; }, isOnline: () => false});
  await sender.submit(input({message: ''})); await sender.submit(input());
  assert.equal(writes, 0); assert.equal(ids, 0); assert.equal(sender.snapshot().status, 'error');
});
test('loopback cannot accidentally select production Firebase', () => {
  assert.throws(() => connection({location: {hostname: 'localhost'}}), /LOCAL_CONFIGURATION_REQUIRED/);
  assert.throws(() => connection({location: {hostname: 'portal.example'}, PORTAL_FEEDBACK_LOCAL: {}}), /LOCAL_CONFIGURATION_REQUIRED/);
  assert.throws(() => connection({location: {hostname: 'localhost'}, PORTAL_FEEDBACK_LOCAL: {firebaseConfig: {projectId: 'production'}}}), /INVALID_LOCAL_CONFIGURATION/);
  for (const protocol of ['file:', 'http:', 'data:']) {
    let initialized = false;
    assert.throws(() => connection({location: {hostname: '', protocol}, firebase: {initializeApp() { initialized = true; }}}), /HTTPS_REQUIRED/);
    assert.equal(initialized, false);
  }
});
test('DOM submit writes six fields and never reads reports or starts Auth', async () => {
  const f = fixture(); try {
    f.fill(); f.submit(); f.submit(); await tick(); assert.equal(f.saved.length, 1);
    assert.deepEqual(Object.keys(f.saved[0].data).sort(), ['schemaVersion', 'type', 'message', 'name', 'target', 'createdAt'].sort());
    assert.equal(f.saved[0].data.createdAt, 'server-time'); assert.deepEqual(f.reads, []); assert.deepEqual(f.creates, ['portal-feedback-public']);
    assert.equal(f.field('status').textContent, '送信しました。ご報告ありがとうございます。'); assert.equal(f.field('submit').disabled, true);
    assert.equal(f.field('new').hidden, false); f.field('new').click(); assert.equal(f.field('message').value, ''); assert.equal(f.field('submit').disabled, false);
  } finally { f.dom.window.close(); }
});
test('DOM failure preserves every input and unlocks the original nodes', async () => {
  const f = fixture(() => Promise.reject(Error('denied'))); try {
    const data = input({name: '報告者', target: '計算機'}); f.fill(data); const message = f.field('message'); f.submit(); await tick();
    for (const field of ['type', 'message', 'name', 'target']) assert.equal(f.field(field).value, data[field]);
    assert.equal(f.field('message'), message); assert.equal(message.readOnly, false); assert.equal(f.field('submit').disabled, false); assert.equal(f.field('error').hidden, false);
  } finally { f.dom.window.close(); }
});
test('input counters do not replace fields, focus, caret, selection or scroll', () => {
  const f = fixture(); try {
    f.fill(); const element = f.field('message'); element.focus(); element.setSelectionRange(2, 4); element.scrollTop = 40;
    element.dispatchEvent(new f.scope.Event('input', {bubbles: true}));
    assert.equal(f.field('message'), element); assert.equal(f.doc.activeElement, element); assert.equal(element.selectionStart, 2); assert.equal(element.selectionEnd, 4); assert.equal(element.scrollTop, 40);
    assert.equal(f.field('message-count').textContent, Array.from(element.value).length + ' / 4000');
  } finally { f.dom.window.close(); }
});
test('editing a rejected field clears its stale error without moving focus or caret', async () => {
  const f = fixture(); try {
    f.fill(input({message: 'あ'.repeat(4001)})); f.submit(); await tick();
    assert.equal(f.field('message').getAttribute('aria-invalid'), 'true');
    const element = f.field('message'); element.value = '修正した報告'; element.focus(); element.setSelectionRange(2, 2);
    element.dispatchEvent(new f.scope.Event('input', {bubbles: true}));
    assert.equal(f.field('error').hidden, true); assert.equal(element.hasAttribute('aria-invalid'), false);
    assert.equal(f.doc.activeElement, element); assert.equal(element.selectionStart, 2); assert.equal(f.saved.length, 0);
  } finally { f.dom.window.close(); }
});
test('IME confirmation is not cancelled and cannot submit after compositionend', async () => {
  const f = fixture(); try {
    f.fill(); const element = f.field('name'); element.dispatchEvent(new f.scope.CompositionEvent('compositionstart', {bubbles: true}));
    const key = new f.scope.KeyboardEvent('keydown', {key: 'Enter', isComposing: true, bubbles: true, cancelable: true});
    element.dispatchEvent(key); assert.equal(key.defaultPrevented, false); element.dispatchEvent(new f.scope.CompositionEvent('compositionend', {bubbles: true}));
    f.submit(); await tick(); assert.equal(f.saved.length, 0); await new Promise(resolve => f.scope.setTimeout(resolve, 0));
    f.submit(); await tick(); assert.equal(f.saved.length, 1);
  } finally { f.dom.window.close(); }
});
