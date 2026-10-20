const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createMemberSync} = require('../member-sync');

const paths = {
  identity: 'memberIdentities/memberA', profile: 'memberProfiles/profileA',
  device: 'memberProfiles/profileA/devices/deviceA',
  history: 'memberProfiles/profileA/settings/historyReadState'
};
class Timestamp {
  constructor(value) { this.value = value; }
}
const document = (seenIds = ['2026/10/19|更新'], extra = {}) => ({schemaVersion: 1, seenIds,
  revision: 1, createdAt: new Timestamp(100), updatedAt: new Timestamp(100),
  updatedByDeviceId: 'deviceA', ...extra});
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function fixture(initial = null) {
  const documents = new Map([
    [paths.identity, {active: true, profileId: 'profileA', deviceId: 'deviceA'}],
    [paths.profile, {status: 'active'}], [paths.device, {status: 'active'}]
  ]);
  if (initial !== null) documents.set(paths.history, initial);
  const reads = [], writes = [], listeners = new Map(), authListeners = new Set(), initialMetadata = new Map();
  let transactions = 0, time = 100, beforeTransaction, beforeCommit, beforeGet;
  const snapshot = (path, metadata = {}) => ({exists: documents.has(path),
    data: () => documents.get(path), metadata: {fromCache: false, hasPendingWrites: false, ...metadata}});
  const emit = (path, metadata) => {
    for (const listener of listeners.get(path) || []) listener.next(snapshot(path, metadata));
  };
  const auth = {currentUser: {uid: 'memberA', isAnonymous: true}, setPersistence: async () => {},
    onAuthStateChanged(next) {
      authListeners.add(next);
      queueMicrotask(() => { if (authListeners.has(next)) next(auth.currentUser); });
      return () => authListeners.delete(next);
    }};
  const resolve = (value, previous) => {
    if (value?.serverTimestamp) return new Timestamp(++time);
    if (value?.increment) return previous + value.increment;
    if (value?.arrayUnion) return [...new Set([...previous, ...value.arrayUnion])];
    return value;
  };
  const db = {
    doc(path) { return {path,
      async get(options) {
        assert.deepEqual(options, {source: 'server'}); reads.push(path);
        if (beforeGet) await beforeGet(path);
        return snapshot(path);
      },
      onSnapshot(options, next, error) {
        assert.deepEqual(options, {includeMetadataChanges: true});
        if (!listeners.has(path)) listeners.set(path, new Set());
        const listener = {next, error}; listeners.get(path).add(listener);
        queueMicrotask(() => { if (listeners.get(path).has(listener)) next(snapshot(path, initialMetadata.get(path))); });
        return () => listeners.get(path).delete(listener);
      }
    }; },
    async runTransaction(operation) {
      transactions++;
      if (beforeTransaction) await beforeTransaction();
      const staged = [];
      const result = await operation({
        async get(ref) { reads.push('transaction:' + ref.path); return snapshot(ref.path); },
        set(ref, data) { staged.push(['set', ref.path, data]); },
        update(ref, data) { staged.push(['update', ref.path, data]); }
      });
      if (beforeCommit) await beforeCommit(staged, transactions);
      for (const [kind, path, data] of staged) {
        const old = documents.get(path) || {};
        const next = kind === 'set' ? {} : {...old};
        for (const [key, value] of Object.entries(data)) next[key] = resolve(value, old[key]);
        documents.set(path, next); writes.push([kind, path, data]); emit(path);
      }
      return result;
    }
  };
  const sdk = {apps: [], auth: {Auth: {Persistence: {LOCAL: 'local'}}},
    firestore: {Timestamp, FieldValue: {serverTimestamp: () => ({serverTimestamp: true}),
      increment: value => ({increment: value}), arrayUnion: (...values) => ({arrayUnion: values})}},
    initializeApp: () => ({auth: () => auth, firestore: () => db})};
  const api = createMemberSync(sdk, {});
  return {api, auth, documents, reads, writes, listeners, authListeners, initialMetadata, emit,
    transactions: () => transactions, restore: () => api.restoreAuthentication(),
    transactionHook: value => { beforeTransaction = value; }, getHook: value => { beforeGet = value; },
    commitHook: value => { beforeCommit = value; },
    data: () => documents.get(paths.history),
    set(path, data, metadata) { if (data === null) documents.delete(path); else documents.set(path, data); emit(path, metadata); },
    error(path, error) { for (const listener of listeners.get(path) || []) listener.error(error); },
    changeUser(user) { auth.currentUser = user; for (const next of authListeners) next(user); },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, authListeners.size)};
}

test('history APIs are dedicated, frozen exports and do not create authentication', async () => {
  const f = fixture();
  for (const name of ['getHistoryReadState', 'initializeHistoryReadState', 'markHistorySeen', 'subscribeHistoryReadState']) {
    assert.equal(typeof f.api[name], 'function');
  }
  assert(Object.isFrozen(f.api));
  await assert.rejects(f.api.getHistoryReadState(), /UNAUTHENTICATED/);
  assert.equal(f.reads.length, 0);
});

test('history get returns server-confirmed null or a validated frozen copy', async () => {
  const f = fixture(); await f.restore();
  assert.equal(await f.api.getHistoryReadState(), null);
  f.set(paths.history, document());
  const state = await f.api.getHistoryReadState();
  assert(Object.isFrozen(state)); assert(Object.isFrozen(state.seenIds));
  assert.notEqual(state.seenIds, f.data().seenIds);
  assert.deepEqual(state, f.data());
  assert(f.reads.includes(paths.identity)); assert(f.reads.includes(paths.profile)); assert(f.reads.includes(paths.device));
});

test('history get rejects every missing/extra schema field and malformed metadata', async () => {
  const f = fixture(); await f.restore(); const valid = document();
  const invalid = [null, [], {}, {...valid, extra: true}, {...valid, schemaVersion: '1'},
    {...valid, schemaVersion: 2}, {...valid, revision: 0}, {...valid, revision: 1.5},
    {...valid, revision: NaN}, {...valid, revision: Infinity}, {...valid, revision: Number.MAX_SAFE_INTEGER + 1},
    {...valid, createdAt: new Date()}, {...valid, updatedAt: null},
    {...valid, updatedByDeviceId: ''}, {...valid, updatedByDeviceId: 'other/path'}];
  for (const field of Object.keys(valid)) { const missing = {...valid}; delete missing[field]; invalid.push(missing); }
  for (const data of invalid) {
    f.documents.set(paths.history, data);
    await assert.rejects(f.api.getHistoryReadState(), /INVALID_SETTINGS/);
  }
});

test('history get rejects invalid ID lists, duplicates, sparse arrays and count overflow', async () => {
  const f = fixture(); await f.restore();
  for (const seenIds of [null, {}, 'ID', 1, [''], [null], [1], [true], [undefined], [new String('ID')],
    ['a'.repeat(513)], ['same', 'same'], Array(1), Array.from({length: 257}, (_, i) => 'id' + i)]) {
    f.set(paths.history, document(seenIds));
    await assert.rejects(f.api.getHistoryReadState(), /INVALID_SETTINGS/);
  }
});

test('history ID boundaries include Japanese titles, whitespace, separators and 512 Unicode code points', async () => {
  const f = fixture(); await f.restore();
  for (const id of ['2026/10/19|更新履歴', 'x', ' ', '|', 'a'.repeat(512), '履'.repeat(512), '😀'.repeat(512)]) {
    f.set(paths.history, document([id]));
    assert.deepEqual((await f.api.getHistoryReadState()).seenIds, [id]);
  }
  f.set(paths.history, document(['😀'.repeat(513)]));
  await assert.rejects(f.api.getHistoryReadState(), /INVALID_SETTINGS/);
});

test('history invalid initialization and mark input fail before Firestore access', async () => {
  const f = fixture();
  for (const seenIds of [undefined, null, {}, 'id', ['one', 'two'], [''], [1], ['x'.repeat(513)], Array(1)]) {
    await assert.rejects(f.api.initializeHistoryReadState(seenIds), /INVALID_SETTINGS/);
  }
  for (const id of [undefined, null, {}, [], 1, true, '', 'x'.repeat(513), '😀'.repeat(513)]) {
    await assert.rejects(f.api.markHistorySeen(id), /INVALID_SETTINGS/);
  }
  assert.equal(f.reads.length, 0); assert.equal(f.transactions(), 0);
});

for (const initial of [[], ['2026/10/19|更新']]) {
  test('history initialize creates revision 1 with ' + initial.length + ' IDs and resolved timestamps', async () => {
    const f = fixture(); await f.restore();
    const result = await f.api.initializeHistoryReadState(initial);
    assert.deepEqual(result.seenIds, initial); assert.equal(result.revision, 1);
    assert(result.createdAt instanceof Timestamp); assert(result.updatedAt instanceof Timestamp);
    assert.equal(result.updatedByDeviceId, 'deviceA'); assert(Object.isFrozen(result.seenIds));
    assert.deepEqual(Object.keys(result).sort(), ['schemaVersion', 'seenIds', 'revision', 'createdAt', 'updatedAt', 'updatedByDeviceId'].sort());
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0][0], 'set');
  });
}

test('history initialization copies input before awaiting and preserves the existing winner', async () => {
  const f = fixture(); await f.restore(); const initial = ['original'];
  const pending = f.api.initializeHistoryReadState(initial); initial[0] = 'mutated';
  assert.deepEqual((await pending).seenIds, ['original']);
  const before = f.data();
  assert.deepEqual(await f.api.initializeHistoryReadState(['stale']), before);
  assert.equal(f.data(), before); assert.equal(f.writes.length, 1);
});

test('history initialization re-reads a transaction winner instead of overwriting stale absence', async () => {
  const f = fixture(); await f.restore(); const winner = document(['other-device'], {revision: 5});
  f.transactionHook(() => f.set(paths.history, winner));
  assert.deepEqual(await f.api.initializeHistoryReadState(['stale']), winner);
  assert.equal(f.writes.length, 0);
});

test('history mark creates an absent document with the one validated ID', async () => {
  const f = fixture(); await f.restore();
  assert.equal(await f.api.markHistorySeen('new'), 1);
  assert.deepEqual(f.data().seenIds, ['new']); assert.equal(f.data().revision, 1);
});

test('history mark unions against the transaction latest set and increments revision once', async () => {
  const f = fixture(document(['old'])); await f.restore();
  f.transactionHook(() => f.set(paths.history, document(['old', 'remote'], {revision: 8})));
  assert.equal(await f.api.markHistorySeen('new'), 9);
  assert.deepEqual(f.data().seenIds, ['old', 'remote', 'new']);
  assert.equal(f.data().revision, 9); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0][0], 'update');
  assert.deepEqual(f.writes[0][2].seenIds, {arrayUnion: ['new']});
});

test('history duplicate mark is a complete no-op including all metadata', async () => {
  const f = fixture(document(['seen'], {revision: 12})); await f.restore(); const before = f.data();
  assert.equal(await f.api.markHistorySeen('seen'), 12);
  assert.equal(f.data(), before); assert.equal(f.writes.length, 0);
});

test('history 256th ID succeeds; 257th gives the dedicated error and preserves all IDs', async () => {
  const f = fixture(document(Array.from({length: 255}, (_, i) => 'id' + i))); await f.restore();
  assert.equal(await f.api.markHistorySeen('last'), 2); assert.equal(f.data().seenIds.length, 256);
  const before = f.data();
  await assert.rejects(f.api.markHistorySeen('overflow'), /^Error: HISTORY_READ_LIMIT$/);
  assert.equal(f.data(), before); assert.equal(f.writes.length, 1);
  assert.equal(await f.api.markHistorySeen('last'), 2); assert.equal(f.writes.length, 1);
});

test('history maximum safe revision rejects an addition but still permits existing-ID no-op', async () => {
  const f = fixture(document(['seen'], {revision: Number.MAX_SAFE_INTEGER})); await f.restore();
  assert.equal(await f.api.markHistorySeen('seen'), Number.MAX_SAFE_INTEGER);
  await assert.rejects(f.api.markHistorySeen('new'), /INVALID_SETTINGS/); assert.equal(f.writes.length, 0);
});

test('history malformed transaction documents never initialize, update or overwrite', async () => {
  const f = fixture(document(['valid'])); await f.restore();
  f.transactionHook(() => f.set(paths.history, document(['invalid', 'invalid'])));
  await assert.rejects(f.api.markHistorySeen('new'), /INVALID_SETTINGS/);
  await assert.rejects(f.api.initializeHistoryReadState([]), /INVALID_SETTINGS/);
  assert.equal(f.writes.length, 0);
});

const permissionDenied = () => Object.assign(Error('Permission denied'), {code: 'permission-denied'});

test('history retries a proven concurrent same-ID denial as a complete no-op', async () => {
  const f = fixture(document(['base'])); await f.restore(); const winner = document(['base', 'same'], {revision: 2});
  f.commitHook((staged, attempt) => {
    if (attempt === 1) { f.set(paths.history, winner); throw permissionDenied(); }
  });
  assert.equal(await f.api.markHistorySeen('same'), 2);
  assert.equal(f.transactions(), 2); assert.equal(f.data(), winner); assert.equal(f.writes.length, 0);
});

test('history retries proven revision progress and unions a different concurrent ID', async () => {
  const f = fixture(document(['base'])); await f.restore();
  f.commitHook((staged, attempt) => {
    if (attempt === 1) { f.set(paths.history, document(['base', 'remote'], {revision: 2})); throw permissionDenied(); }
  });
  assert.equal(await f.api.markHistorySeen('local'), 3);
  assert.deepEqual(f.data().seenIds, ['base', 'remote', 'local']); assert.equal(f.transactions(), 2); assert.equal(f.writes.length, 1);
});

test('history limit race re-reads the winning 256 IDs and returns HISTORY_READ_LIMIT', async () => {
  const ids = Array.from({length: 255}, (_, i) => 'id' + i);
  const f = fixture(document(ids)); await f.restore(); const winner = document([...ids, 'remote'], {revision: 2});
  f.commitHook(() => { f.set(paths.history, winner); throw permissionDenied(); });
  await assert.rejects(f.api.markHistorySeen('local'), /HISTORY_READ_LIMIT/);
  assert.equal(f.transactions(), 2); assert.equal(f.data(), winner); assert.equal(f.writes.length, 0);
});

test('history initialize recovers an absent-document create race by returning the winner', async () => {
  const f = fixture(); await f.restore(); const winner = document(['remote']);
  f.commitHook((staged, attempt) => {
    if (attempt === 1) { f.set(paths.history, winner); throw permissionDenied(); }
  });
  const result = await f.api.initializeHistoryReadState(['local']);
  assert.deepEqual(result, winner); assert(Object.isFrozen(result.seenIds));
  assert.equal(f.transactions(), 2); assert.equal(f.data(), winner); assert.equal(f.writes.length, 0);
});

test('history mark recovers a competing create then unions into the new document', async () => {
  const f = fixture(); await f.restore();
  f.commitHook((staged, attempt) => {
    if (attempt === 1) { f.set(paths.history, document(['remote'])); throw permissionDenied(); }
  });
  assert.equal(await f.api.markHistorySeen('local'), 2);
  assert.deepEqual(f.data().seenIds, ['remote', 'local']); assert.equal(f.transactions(), 2); assert.equal(f.writes.length, 1);
});

test('history genuine permission denial without revision progress is rethrown without retry', async () => {
  for (const remove of [false, true]) {
    const f = fixture(document(['base'])); await f.restore(); const denied = permissionDenied();
    f.commitHook(() => { if (remove) f.set(paths.history, null); throw denied; });
    await assert.rejects(f.api.markHistorySeen('local'), error => error === denied);
    assert.equal(f.transactions(), 1); assert.equal(f.writes.length, 0);
  }
});

test('history unknown transaction errors do not trigger membership refresh or retries', async () => {
  const f = fixture(document()); await f.restore(); const offline = Object.assign(Error('Offline'), {code: 'unavailable'});
  f.commitHook(() => { throw offline; });
  await assert.rejects(f.api.markHistorySeen('local'), error => error === offline);
  assert.equal(f.transactions(), 1); assert.equal(f.reads.filter(path => path === paths.identity).length, 1);
});

test('history permission failure before observing settings does not trigger a retry', async () => {
  const f = fixture(document()); await f.restore(); const denied = permissionDenied();
  f.transactionHook(() => { throw denied; });
  await assert.rejects(f.api.markHistorySeen('local'), error => error === denied);
  assert.equal(f.transactions(), 1); assert.equal(f.reads.filter(path => path === paths.identity).length, 1);
});

test('history conflict recovery rejects revoked or changed membership before retrying', async () => {
  for (const [path, value] of [[paths.identity, {active: false}], [paths.profile, {status: 'inactive'}],
    [paths.device, {status: 'inactive'}], [paths.identity, {active: true, profileId: 'profileB', deviceId: 'deviceA'}],
    [paths.identity, {active: true, profileId: 'profileA', deviceId: 'deviceB'}]]) {
    const f = fixture(document(['base'])); await f.restore();
    f.commitHook(() => {
      f.set(paths.history, document(['base', 'remote'], {revision: 2})); f.set(path, value); throw permissionDenied();
    });
    await assert.rejects(f.api.markHistorySeen('local'), /MEMBERSHIP_REQUIRED/);
    assert.equal(f.transactions(), 1); assert.equal(f.writes.length, 0);
  }
});

test('history conflict recovery rejects authentication loss before retrying', async () => {
  const f = fixture(document(['base'])); await f.restore();
  f.commitHook(() => {
    f.set(paths.history, document(['base', 'remote'], {revision: 2})); f.changeUser(null); throw permissionDenied();
  });
  await assert.rejects(f.api.markHistorySeen('local'), /UNAUTHENTICATED/);
  assert.equal(f.transactions(), 1); assert.equal(f.writes.length, 0);
});

test('history conflict recovery is bounded to three transaction attempts', async () => {
  const f = fixture(document(['base'])); await f.restore(); const denied = permissionDenied();
  f.commitHook((staged, attempt) => {
    f.set(paths.history, document([...f.data().seenIds, 'remote' + attempt], {revision: attempt + 1})); throw denied;
  });
  await assert.rejects(f.api.markHistorySeen('local'), error => error === denied);
  assert.equal(f.transactions(), 3); assert.equal(f.writes.length, 0);
});

test('history reads and writes require the active identity, profile and device', async () => {
  for (const [path, data] of [[paths.identity, null], [paths.identity, {active: false, profileId: 'profileA', deviceId: 'deviceA'}],
    [paths.identity, {active: true, profileId: 'other/path', deviceId: 'deviceA'}],
    [paths.profile, null], [paths.profile, {status: 'inactive'}], [paths.device, null], [paths.device, {status: 'inactive'}]]) {
    const f = fixture(); await f.restore(); f.set(path, data);
    for (const operation of [() => f.api.getHistoryReadState(), () => f.api.initializeHistoryReadState([]), () => f.api.markHistorySeen('id')]) {
      await assert.rejects(operation(), /MEMBERSHIP_REQUIRED/);
    }
    assert.equal(f.writes.length, 0);
  }
});

test('history transaction rechecks all membership records and rejects profile/device identity changes', async () => {
  for (const [path, data] of [[paths.identity, {active: true, profileId: 'profileB', deviceId: 'deviceA'}],
    [paths.identity, {active: true, profileId: 'profileA', deviceId: 'deviceB'}],
    [paths.identity, {active: false, profileId: 'profileA', deviceId: 'deviceA'}],
    [paths.profile, {status: 'inactive'}], [paths.device, {status: 'inactive'}]]) {
    for (const operation of ['initialize', 'mark']) {
      const f = fixture(); await f.restore(); f.transactionHook(() => f.set(path, data));
      await assert.rejects(operation === 'initialize' ? f.api.initializeHistoryReadState([]) : f.api.markHistorySeen('id'), /MEMBERSHIP_REQUIRED/);
      assert.equal(f.writes.length, 0);
    }
  }
});

test('history authentication loss during context or transaction aborts without writing', async () => {
  for (const phase of ['context', 'transaction']) {
    const f = fixture(); await f.restore();
    if (phase === 'context') f.getHook(path => { if (path === paths.profile) f.changeUser(null); });
    else f.transactionHook(() => f.changeUser(null));
    await assert.rejects(f.api.markHistorySeen('id'), /UNAUTHENTICATED/); assert.equal(f.writes.length, 0);
  }
});

test('history subscribe delivers validated server absence and updates; unsubscribe stops everything', async () => {
  const f = fixture(); await f.restore(); const received = [], errors = [];
  const stop = f.api.subscribeHistoryReadState(value => received.push(value), error => errors.push(error.message));
  assert.equal(typeof stop, 'function'); await settle(); assert.deepEqual(received, [null]);
  f.set(paths.history, document(['new'])); await settle();
  assert.deepEqual(received.at(-1).seenIds, ['new']); assert(Object.isFrozen(received.at(-1).seenIds));
  stop(); stop(); assert.equal(f.listenerCount(), 0);
  f.set(paths.history, document(['ignored'])); await settle(); assert.equal(received.length, 2); assert.deepEqual(errors, []);
});

test('history subscribe ignores cache/pending snapshots until server confirmation', async () => {
  const f = fixture(document(['first'])); await f.restore(); const received = [];
  const stop = f.api.subscribeHistoryReadState(value => received.push(value)); await settle();
  for (const metadata of [{fromCache: true}, {hasPendingWrites: true}, {fromCache: true, hasPendingWrites: true}]) {
    f.set(paths.history, document(['pending']), metadata); await settle(); assert.equal(received.length, 1);
  }
  f.emit(paths.history); await settle(); assert.deepEqual(received.at(-1).seenIds, ['pending']); stop();
});

test('history subscription waits for all three membership server snapshots', async () => {
  const f = fixture(document()); await f.restore(); const received = [], errors = [];
  f.initialMetadata.set(paths.identity, {fromCache: true});
  f.initialMetadata.set(paths.profile, {hasPendingWrites: true});
  f.initialMetadata.set(paths.device, {fromCache: true, hasPendingWrites: true});
  const stop = f.api.subscribeHistoryReadState(value => received.push(value), error => errors.push(error));
  await settle(); assert.equal(received.length, 0); assert(!f.listeners.has(paths.history));
  f.emit(paths.identity); f.emit(paths.profile); await settle(); assert.equal(received.length, 0);
  f.emit(paths.device); await settle(); assert.equal(received.length, 1); assert.deepEqual(errors, []); stop();
});

test('history cached membership revocation is ignored until the server confirms it', async () => {
  const f = fixture(document()); await f.restore(); const errors = [];
  f.api.subscribeHistoryReadState(() => {}, error => errors.push(error.message)); await settle();
  f.set(paths.device, {status: 'inactive'}, {fromCache: true}); await settle(); assert.deepEqual(errors, []);
  f.emit(paths.device); await settle(); assert.deepEqual(errors, ['MEMBERSHIP_REQUIRED']); assert.equal(f.listenerCount(), 0);
});

test('history unsubscribe while context is pending installs no later listeners or callbacks', async () => {
  const f = fixture(document()); await f.restore(); const received = [], errors = []; let release;
  f.getHook(path => path === paths.profile ? new Promise(resolve => { release = resolve; }) : undefined);
  const stop = f.api.subscribeHistoryReadState(value => received.push(value), error => errors.push(error));
  await settle(); assert.equal(typeof release, 'function'); stop(); release(); await settle();
  assert.equal(f.listenerCount(), 0); assert.deepEqual(received, []); assert.deepEqual(errors, []);
});

for (const [label, path, data] of [['identity revocation', paths.identity, {active: false}],
  ['profile revocation', paths.profile, {status: 'inactive'}], ['device revocation', paths.device, {status: 'inactive'}],
  ['identity profile change', paths.identity, {active: true, profileId: 'profileB', deviceId: 'deviceA'}],
  ['identity device change', paths.identity, {active: true, profileId: 'profileA', deviceId: 'deviceB'}]]) {
  test('history subscription stops on ' + label + ' with a fixed membership error', async () => {
    const f = fixture(document()); await f.restore(); const received = [], errors = [];
    f.api.subscribeHistoryReadState(value => received.push(value), error => errors.push(error.message)); await settle();
    f.set(path, data); await settle(); assert.deepEqual(errors, ['MEMBERSHIP_REQUIRED']); assert.equal(f.listenerCount(), 0);
    const count = received.length; f.set(paths.history, document(['ignored'])); await settle(); assert.equal(received.length, count);
  });
}

test('history subscription stops on auth loss or replacement before delivering queued settings', async () => {
  for (const next of [null, {uid: 'other-user', isAnonymous: true}, {uid: 'memberA', isAnonymous: false}]) {
    const f = fixture(document()); await f.restore(); const received = [], errors = [];
    f.api.subscribeHistoryReadState(value => received.push(value), error => errors.push(error.message)); await settle();
    f.set(paths.history, document(['queued'])); f.changeUser(next); await settle();
    assert.deepEqual(errors, ['UNAUTHENTICATED']); assert.equal(received.length, 1); assert.equal(f.listenerCount(), 0);
  }
});

test('history invalid remote documents stop once and expose only INVALID_SETTINGS', async () => {
  const f = fixture(document()); await f.restore(); const errors = [];
  f.api.subscribeHistoryReadState(() => {}, error => errors.push(error.message)); await settle();
  f.set(paths.history, document(['', 'secret'])); await settle();
  assert.deepEqual(errors, ['INVALID_SETTINGS']); assert.equal(f.listenerCount(), 0);
});

test('history subscription unknown SDK errors are redacted and stop all listeners', async () => {
  const f = fixture(document()); await f.restore(); const errors = [];
  f.api.subscribeHistoryReadState(() => {}, error => errors.push(error.message)); await settle();
  f.error(paths.history, Error('secret token profile internal stack')); await settle();
  assert.deepEqual(errors, ['SETTINGS_UNAVAILABLE']); assert.equal(f.listenerCount(), 0);
});

test('history consumer callback exceptions are not relabeled as validation failures', async t => {
  const original = globalThis.queueMicrotask; const thrown = [], errors = []; const consumerError = Error('consumer failure');
  t.mock.method(globalThis, 'queueMicrotask', callback => original(() => { try { callback(); } catch (error) { thrown.push(error); } }));
  const f = fixture(document()); await f.restore();
  const stop = f.api.subscribeHistoryReadState(() => { throw consumerError; }, error => errors.push(error)); await settle();
  assert.deepEqual(thrown, [consumerError]); assert.deepEqual(errors, []); assert(f.listenerCount() > 0); stop();
});

test('history subscription rejects missing callbacks synchronously', () => {
  const f = fixture();
  assert.throws(() => f.api.subscribeHistoryReadState(null), TypeError);
  assert.throws(() => f.api.subscribeHistoryReadState(() => {}, null), TypeError);
});
