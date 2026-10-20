const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createMemberSync} = require('../member-sync');
const {ARTIFACT_CATALOG, createDefaultArtifactProjection} = require('../artifact-catalog');

const selectable = ARTIFACT_CATALOG.find(item => item.values && item.values.length > 1);
const fixed = ARTIFACT_CATALOG.find(item => !item.values);
const paths = {
  identity: 'memberIdentities/memberA', profile: 'memberProfiles/profileA',
  device: 'memberProfiles/profileA/devices/deviceA',
  gw: 'memberProfiles/profileA/settings/awakeningGw',
  high: 'memberProfiles/profileA/settings/awakeningHigh'
};
class Timestamp {
  constructor(seconds, nanoseconds = 0) {
    if (seconds < -62135596800 || seconds > 253402300799) throw Error('Timestamp range');
    this.seconds = seconds; this.nanoseconds = nanoseconds;
  }
}
const document = (extra = {}) => ({schemaVersion: 1, catalogVersion: 1, resetEpoch: 0,
  items: createDefaultArtifactProjection().items, revision: 1,
  createdAt: new Timestamp(100), updatedAt: new Timestamp(100), updatedByDeviceId: 'deviceA', ...extra});
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const denied = () => Object.assign(Error('permission denied'), {code: 'permission-denied'});

function fixture(gw = null, high = null) {
  const documents = new Map([
    [paths.identity, {active: true, profileId: 'profileA', deviceId: 'deviceA'}],
    [paths.profile, {status: 'active'}], [paths.device, {status: 'active'}]
  ]);
  if (gw !== null) documents.set(paths.gw, gw);
  if (high !== null) documents.set(paths.high, high);
  const reads = [], writes = [], listeners = new Map(), authListeners = new Set(), initialMetadata = new Map();
  let transactions = 0, time = 100, beforeTransaction, beforeCommit, beforeGet;
  const snapshot = (path, metadata = {}) => ({exists: documents.has(path), data: () => documents.get(path),
    metadata: {fromCache: false, hasPendingWrites: false, ...metadata}});
  const emit = (path, metadata) => {
    for (const listener of listeners.get(path) || []) listener.next(snapshot(path, metadata));
  };
  const auth = {currentUser: {uid: 'memberA', isAnonymous: true}, setPersistence: async () => {},
    onAuthStateChanged(next) {
      authListeners.add(next);
      queueMicrotask(() => { if (authListeners.has(next)) next(auth.currentUser); });
      return () => authListeners.delete(next);
    }, signInAnonymously() { throw Error('Unexpected account creation'); }};
  const resolve = (value, previous) => {
    if (value?.serverTimestamp) return new Timestamp(++time);
    if (value?.increment) return previous + value.increment;
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
        const old = documents.get(path) || {}, next = kind === 'set' ? {} : {...old};
        for (const [key, value] of Object.entries(data)) {
          if (!key.startsWith('items.')) next[key] = resolve(value, old[key]);
          else {
            const [, effectId, field] = key.split('.');
            next.items = {...next.items, [effectId]: {...next.items[effectId], [field]: value}};
          }
        }
        documents.set(path, next); writes.push([kind, path, data]); emit(path);
      }
      return result;
    }
  };
  const sdk = {apps: [], auth: {Auth: {Persistence: {LOCAL: 'local'}}},
    firestore: {Timestamp, FieldValue: {serverTimestamp: () => ({serverTimestamp: true}),
      increment: value => ({increment: value})}},
    initializeApp: () => ({auth: () => auth, firestore: () => db})};
  const api = createMemberSync(sdk, {});
  return {api, documents, reads, writes, listeners, authListeners, initialMetadata, emit,
    restore: () => api.restoreAuthentication(), transactions: () => transactions,
    transactionHook: hook => { beforeTransaction = hook; }, commitHook: hook => { beforeCommit = hook; },
    getHook: hook => { beforeGet = hook; }, data: (mode = 'gw') => documents.get(paths[mode]),
    set(path, data, metadata) { if (data === null) documents.delete(path); else documents.set(path, data); emit(path, metadata); },
    error(path, error) { for (const listener of listeners.get(path) || []) listener.error(error); },
    changeUser(user) { auth.currentUser = user; for (const listener of authListeners) listener(user); },
    listenerCount: () => [...listeners.values()].reduce((sum, values) => sum + values.size, authListeners.size)};
}

test('Artifact APIs are dedicated frozen exports and never create authentication', async () => {
  const f = fixture();
  for (const name of ['getArtifactSettings', 'initializeArtifactSettings', 'updateArtifactSetting',
    'resetArtifactSettings', 'subscribeArtifactSettings']) assert.equal(typeof f.api[name], 'function');
  assert(Object.isFrozen(f.api));
  await assert.rejects(f.api.getArtifactSettings('gw'), /UNAUTHENTICATED/);
  assert.equal(f.reads.length, 0);
});

test('member client loads without a browser catalog and starts no catalog fetch', () => {
  const context = vm.createContext({document: {querySelector: () => null}});
  vm.runInContext(fs.readFileSync(require.resolve('../member-sync'), 'utf8'), context);
  assert.equal(typeof context.MemberSync.createMemberSync, 'function');
});

for (const mode of ['gw', 'high']) {
  test(mode + ' get returns null for missing document and an isolated deeply frozen full state', async () => {
    const f = fixture(); await f.restore();
    assert.equal(await f.api.getArtifactSettings(mode), null);
    f.set(paths[mode], document());
    const result = await f.api.getArtifactSettings(mode);
    assert.deepEqual(result, f.data(mode));
    for (const value of [result, result.items, ...Object.values(result.items), result.createdAt, result.updatedAt]) {
      assert(Object.isFrozen(value));
    }
    assert.notEqual(result.items, f.data(mode).items);
    assert.notEqual(result.items[selectable.effectId], f.data(mode).items[selectable.effectId]);
    assert.notEqual(result.createdAt, f.data(mode).createdAt);
    assert.equal(Object.keys(result.items).length, 63);
    assert(!f.reads.some(path => path.includes('historyReadState')));
    assert(!f.reads.includes(paths[mode === 'gw' ? 'high' : 'gw']));
  });

  test(mode + ' initialize creates exact versioned metadata and server timestamps', async () => {
    const f = fixture(); await f.restore();
    const projection = createDefaultArtifactProjection(); projection.items[selectable.effectId].needed = true;
    const result = await f.api.initializeArtifactSettings(mode, projection);
    assert.deepEqual(result.items, projection.items); assert.equal(result.schemaVersion, 1);
    assert.equal(result.catalogVersion, 1); assert.equal(result.resetEpoch, 0); assert.equal(result.revision, 1);
    assert(result.createdAt instanceof Timestamp); assert(result.updatedAt instanceof Timestamp);
    assert.equal(result.updatedByDeviceId, 'deviceA'); assert.equal(f.writes.length, 1);
    assert.deepEqual(Object.keys(result).sort(), ['schemaVersion', 'catalogVersion', 'resetEpoch', 'items',
      'revision', 'createdAt', 'updatedAt', 'updatedByDeviceId'].sort());
    assert.equal(f.writes[0][1], paths[mode]);
  });

  test(mode + ' subscribe delivers server absence and immutable states without touching the other mode', async () => {
    const f = fixture(); await f.restore(); const received = [], errors = [];
    const stop = f.api.subscribeArtifactSettings(mode, value => received.push(value), error => errors.push(error.message));
    await settle(); assert.deepEqual(received, [null]);
    f.set(paths[mode], document()); await settle();
    assert(Object.isFrozen(received.at(-1).items[fixed.effectId]));
    f.set(paths[mode === 'gw' ? 'high' : 'gw'], document({revision: 2})); await settle();
    assert.equal(received.length, 2); stop(); stop(); assert.equal(f.listenerCount(), 0); assert.deepEqual(errors, []);
    f.set(paths[mode], document({revision: 3})); await settle(); assert.equal(received.length, 2);
  });
}

test('all APIs reject invalid modes and arbitrary paths before any Firestore access', async () => {
  const f = fixture();
  for (const mode of [undefined, null, '', 'GW', 'artifact', 'awakeningGw', 'settings/foo', '../gw', {}, 1]) {
    await assert.rejects(f.api.getArtifactSettings(mode), /INVALID_SETTINGS/);
    await assert.rejects(f.api.initializeArtifactSettings(mode, createDefaultArtifactProjection()), /INVALID_SETTINGS/);
    await assert.rejects(f.api.updateArtifactSetting(mode, selectable.effectId, {needed: true}), /INVALID_SETTINGS/);
    await assert.rejects(f.api.resetArtifactSettings(mode), /INVALID_SETTINGS/);
    assert.throws(() => f.api.subscribeArtifactSettings(mode, () => {}), /INVALID_SETTINGS/);
  }
  assert.equal(f.reads.length, 0); assert.equal(f.transactions(), 0);
});

test('initialization rejects missing/unknown IDs, sparse projection, unknown metadata and bad versions', async () => {
  const f = fixture(); const valid = createDefaultArtifactProjection();
  const missing = createDefaultArtifactProjection(); delete missing.items[fixed.effectId];
  for (const projection of [null, {}, [], {catalogVersion: 1, items: {}}, missing,
    {...valid, catalogVersion: 2}, {...valid, catalogVersion: '1'}, {...valid, memo: 'private'},
    {...valid, items: {...valid.items, unknown: {needed: false}}}]) {
    await assert.rejects(f.api.initializeArtifactSettings('gw', projection), /INVALID_SETTINGS/);
  }
  assert.equal(f.reads.length, 0);
});

test('every item requires boolean needed and its exact selectable or fixed schema', async () => {
  const f = fixture();
  for (const item of ARTIFACT_CATALOG) {
    const invalid = [null, {}, {needed: 'true'}, {needed: 1}, {needed: null},
      {needed: false, extra: true}, item.values ? {needed: false} : {needed: false, selectedValue: '3%'}];
    if (item.values) invalid.push({needed: false, selectedValue: 20}, {needed: false, selectedValue: 'invalid'});
    for (const value of invalid) {
      const projection = createDefaultArtifactProjection(); projection.items[item.effectId] = value;
      await assert.rejects(f.api.initializeArtifactSettings('gw', projection), /INVALID_SETTINGS/);
    }
  }
  assert.equal(f.reads.length, 0);
});

test('initialize clones caller data before awaiting and never overwrites an existing winner', async () => {
  const f = fixture(); await f.restore(); const projection = createDefaultArtifactProjection();
  const pending = f.api.initializeArtifactSettings('gw', projection);
  projection.items[selectable.effectId].needed = true;
  assert.equal((await pending).items[selectable.effectId].needed, false);
  const original = f.data();
  assert.deepEqual(await f.api.initializeArtifactSettings('gw', projection), original);
  assert.equal(f.data(), original); assert.equal(f.writes.length, 1);
});

test('transaction initialization adopts a concurrent winner rather than stale absence', async () => {
  const f = fixture(); await f.restore(); const winner = document({revision: 4, resetEpoch: 2});
  f.transactionHook(() => f.set(paths.gw, winner));
  assert.deepEqual(await f.api.initializeArtifactSettings('gw', createDefaultArtifactProjection()), winner);
  assert.equal(f.writes.length, 0);
});

test('remote metadata rejects exact-key, version, safe integer, timestamp and device violations', async () => {
  const f = fixture(); await f.restore(); const valid = document();
  const invalid = [null, [], {}, {...valid, extra: true}, {...valid, schemaVersion: 2},
    {...valid, catalogVersion: 2}, {...valid, catalogVersion: '1'}, {...valid, revision: 0},
    {...valid, resetEpoch: -1}, {...valid, resetEpoch: Number.MAX_SAFE_INTEGER + 1},
    {...valid, revision: Number.MAX_SAFE_INTEGER + 1}, {...valid, resetEpoch: 0.5},
    {...valid, revision: Infinity}, {...valid, resetEpoch: NaN}, {...valid, revision: '1'},
    {...valid, createdAt: new Date()}, {...valid, updatedAt: null},
    {...valid, createdAt: new Timestamp(1, 1000000000)}, {...valid, updatedAt: new Timestamp(NaN)},
    {...valid, updatedByDeviceId: ''}, {...valid, updatedByDeviceId: 'other/path'}];
  for (const field of Object.keys(valid)) { const missing = {...valid}; delete missing[field]; invalid.push(missing); }
  for (const data of invalid) {
    f.documents.set(paths.gw, data); await assert.rejects(f.api.getArtifactSettings('gw'), /INVALID_SETTINGS/);
  }
});

test('remote full items are validated without allowing invalid documents into get', async () => {
  const f = fixture(); await f.restore();
  for (const mutate of [data => { delete data.items[fixed.effectId]; },
    data => { data.items.unknown = {needed: false}; },
    data => { data.items[fixed.effectId].selectedValue = '3%'; },
    data => { data.items[selectable.effectId].selectedValue = 'invalid'; },
    data => { data.items[selectable.effectId].needed = 'true'; }]) {
    const data = document(); mutate(data); f.set(paths.gw, data);
    await assert.rejects(f.api.getArtifactSettings('gw'), /INVALID_SETTINGS/);
  }
});

test('needed true and false update only one field and preserve all other items and metadata', async () => {
  const f = fixture(document()); await f.restore(); const before = await f.api.getArtifactSettings('gw');
  assert.equal(await f.api.updateArtifactSetting('gw', fixed.effectId, {needed: true}), 2);
  assert.equal(f.data().items[fixed.effectId].needed, true);
  assert.equal(await f.api.updateArtifactSetting('gw', fixed.effectId, {needed: false}), 3);
  assert.deepEqual(f.data().items, before.items); assert.deepEqual(f.data().createdAt, before.createdAt);
  assert.equal(f.data().resetEpoch, 0); assert.deepEqual(Object.keys(f.writes[0][2]).sort(),
    ['items.' + fixed.effectId + '.needed', 'revision', 'updatedAt', 'updatedByDeviceId'].sort());
});

test('selectedValue accepts every exact catalog enum without coercion', async () => {
  const f = fixture(document()); await f.restore();
  for (const item of ARTIFACT_CATALOG.filter(item => item.values)) {
    for (const value of item.values) {
      await f.api.updateArtifactSetting('gw', item.effectId, {selectedValue: value});
      assert.equal(f.data().items[item.effectId].selectedValue, value);
    }
  }
});

test('invalid update IDs and patches are rejected before authentication or reads', async () => {
  const f = fixture();
  for (const [id, patch] of [[undefined, {needed: true}], ['unknown', {needed: true}],
    ['../' + fixed.effectId, {needed: true}], [fixed.effectId, {selectedValue: '3%'}],
    [selectable.effectId, {selectedValue: 1800}], [selectable.effectId, {selectedValue: '1800 '}],
    [selectable.effectId, null], [selectable.effectId, []], [selectable.effectId, {}],
    [selectable.effectId, {needed: 'true'}], [selectable.effectId, {needed: 1}],
    [selectable.effectId, {needed: null}], [selectable.effectId, {memo: 'private'}],
    [selectable.effectId, {needed: true, selectedValue: selectable.values[0]}],
    [selectable.effectId, Object.create({needed: true})],
    [selectable.effectId, {needed: true, [Symbol('extra')]: true}]]) {
    await assert.rejects(f.api.updateArtifactSetting('gw', id, patch), /INVALID_SETTINGS/);
  }
  assert.equal(f.reads.length, 0); assert.equal(f.transactions(), 0);
});

test('update captures the primitive patch value before awaiting', async () => {
  const f = fixture(document()); await f.restore(); const patch = {needed: true};
  const result = f.api.updateArtifactSetting('gw', selectable.effectId, patch); patch.needed = false;
  assert.equal(await result, 2); assert.equal(f.data().items[selectable.effectId].needed, true);
});

test('same-value update is a transaction-confirmed complete no-op, including max revision', async () => {
  const f = fixture(document({revision: Number.MAX_SAFE_INTEGER})); await f.restore(); const original = f.data();
  assert.equal(await f.api.updateArtifactSetting('gw', fixed.effectId, {needed: false}), Number.MAX_SAFE_INTEGER);
  assert.equal(f.data(), original); assert.equal(f.writes.length, 0); assert.equal(f.transactions(), 1);
  await assert.rejects(f.api.updateArtifactSetting('gw', fixed.effectId, {needed: true}), /INVALID_SETTINGS/);
  assert.equal(f.writes.length, 0);
});

test('update and reset reject a missing document without implicitly initializing it', async () => {
  const f = fixture(); await f.restore();
  await assert.rejects(f.api.updateArtifactSetting('gw', fixed.effectId, {needed: true}), /SETTINGS_NOT_INITIALIZED/);
  await assert.rejects(f.api.resetArtifactSettings('gw'), /SETTINGS_NOT_INITIALIZED/);
  assert.equal(f.writes.length, 0);
});

test('reset restores all defaults and advances epoch/revision even when already default', async () => {
  const initial = document({resetEpoch: 3, revision: 7}); initial.items[fixed.effectId].needed = true;
  initial.items[selectable.effectId].selectedValue = selectable.values[0];
  const f = fixture(initial, document({revision: 4})); await f.restore(); const high = f.data('high');
  assert.equal(await f.api.resetArtifactSettings('gw'), 8);
  assert.deepEqual(f.data().items, createDefaultArtifactProjection().items);
  assert.equal(f.data().resetEpoch, 4); assert.equal(f.data().revision, 8);
  assert.equal(f.data().createdAt, initial.createdAt); assert.equal(f.data('high'), high);
  assert.equal(await f.api.resetArtifactSettings('gw'), 9); assert.equal(f.data().resetEpoch, 5);
  assert.equal(f.writes.length, 2);
});

test('reset refuses safe integer overflow for epoch or revision without writing', async () => {
  for (const extra of [{resetEpoch: Number.MAX_SAFE_INTEGER}, {revision: Number.MAX_SAFE_INTEGER}]) {
    const f = fixture(document(extra)); await f.restore();
    await assert.rejects(f.api.resetArtifactSettings('gw'), /INVALID_SETTINGS/); assert.equal(f.writes.length, 0);
  }
});

test('normal update reads the latest item state and preserves concurrent changes to other effects', async () => {
  const f = fixture(document()); await f.restore();
  f.transactionHook(() => {
    const next = document({revision: 2}); next.items[fixed.effectId].needed = true; f.set(paths.gw, next);
  });
  assert.equal(await f.api.updateArtifactSetting('gw', selectable.effectId, {needed: true}), 3);
  assert.equal(f.data().items[fixed.effectId].needed, true);
  assert.equal(f.data().items[selectable.effectId].needed, true);
});

test('proved transaction conflict retries only the same mode and preserves reset boundary', async () => {
  const initial = document(); initial.items[fixed.effectId].needed = true;
  const f = fixture(initial, document({revision: 50})); await f.restore(); const high = f.data('high');
  f.commitHook((staged, attempt) => {
    if (attempt !== 1) return;
    f.set(paths.gw, document({resetEpoch: 1, revision: 2})); throw denied();
  });
  assert.equal(await f.api.updateArtifactSetting('gw', selectable.effectId, {needed: true}), 3);
  assert.equal(f.data().resetEpoch, 1); assert.equal(f.data().items[fixed.effectId].needed, false);
  assert.equal(f.data().items[selectable.effectId].needed, true); assert.equal(f.data('high'), high);
  assert.equal(f.transactions(), 2); assert.equal(f.writes.length, 1);
  assert(!f.reads.some(path => path.includes('historyReadState')));
});

test('absent initialize conflict adopts the server winner without overwriting', async () => {
  const f = fixture(); await f.restore(); const winner = document({resetEpoch: 2, revision: 5});
  f.commitHook((staged, attempt) => { if (attempt === 1) { f.set(paths.high, winner); throw denied(); } });
  assert.deepEqual(await f.api.initializeArtifactSettings('high', createDefaultArtifactProjection()), winner);
  assert.equal(f.transactions(), 2); assert.equal(f.writes.length, 0); assert.equal(f.data('high'), winner);
});

test('true permission failures, unknown errors and pre-read failures never retry', async () => {
  for (const phase of ['same-revision', 'missing', 'unknown', 'pre-read']) {
    const f = fixture(document()); await f.restore();
    const error = phase === 'unknown' ? Object.assign(Error('offline'), {code: 'unavailable'}) : denied();
    if (phase === 'pre-read') f.transactionHook(() => { throw error; });
    else f.commitHook(() => { if (phase === 'missing') f.set(paths.gw, null); throw error; });
    await assert.rejects(f.api.updateArtifactSetting('gw', fixed.effectId, {needed: true}), value => value === error);
    assert.equal(f.transactions(), 1); assert.equal(f.writes.length, 0);
  }
});

test('transaction conflict recovery is bounded even under continuing revision progress', async () => {
  const f = fixture(document()); await f.restore(); const error = denied();
  f.commitHook((staged, attempt) => { f.set(paths.gw, document({revision: attempt + 1})); throw error; });
  await assert.rejects(f.api.resetArtifactSettings('gw'), value => value === error);
  assert.equal(f.transactions(), 3); assert.equal(f.writes.length, 0);
});

test('Artifact reads and writes require an active valid identity, profile and device', async () => {
  for (const [path, data] of [[paths.identity, null], [paths.identity, {active: false}],
    [paths.identity, {active: true, profileId: 'other/path', deviceId: 'deviceA'}],
    [paths.profile, null], [paths.profile, {status: 'inactive'}], [paths.device, null], [paths.device, {status: 'inactive'}]]) {
    const f = fixture(document()); await f.restore(); f.set(path, data);
    for (const operation of [() => f.api.getArtifactSettings('gw'),
      () => f.api.initializeArtifactSettings('gw', createDefaultArtifactProjection()),
      () => f.api.updateArtifactSetting('gw', fixed.effectId, {needed: true}), () => f.api.resetArtifactSettings('gw')]) {
      await assert.rejects(operation(), /MEMBERSHIP_REQUIRED/);
    }
    assert.equal(f.writes.length, 0);
  }
});

test('transactions recheck membership changes and never redirect to another profile', async () => {
  for (const [path, data] of [[paths.identity, {active: true, profileId: 'profileB', deviceId: 'deviceA'}],
    [paths.identity, {active: true, profileId: 'profileA', deviceId: 'deviceB'}],
    [paths.profile, {status: 'inactive'}], [paths.device, {status: 'inactive'}]]) {
    const f = fixture(document()); await f.restore(); f.transactionHook(() => f.set(path, data));
    await assert.rejects(f.api.updateArtifactSetting('gw', fixed.effectId, {needed: true}), /MEMBERSHIP_REQUIRED/);
    assert.equal(f.writes.length, 0); assert(!f.reads.some(value => value.includes('memberProfiles/profileB/settings')));
  }
});

test('conflict recovery refuses changed membership or authentication rather than leaking the profile', async () => {
  for (const revoke of [f => f.set(paths.identity, {active: true, profileId: 'profileB', deviceId: 'deviceA'}),
    f => f.set(paths.device, {status: 'inactive'}), f => f.changeUser(null)]) {
    const f = fixture(document()); await f.restore();
    f.commitHook(() => { f.set(paths.gw, document({revision: 2})); revoke(f); throw denied(); });
    await assert.rejects(f.api.resetArtifactSettings('gw'), /MEMBERSHIP_REQUIRED|UNAUTHENTICATED/);
    assert.equal(f.transactions(), 1); assert.equal(f.writes.length, 0);
  }
});

test('authentication loss during context or transaction aborts without writing', async () => {
  for (const phase of ['context', 'transaction']) {
    const f = fixture(document()); await f.restore();
    if (phase === 'context') f.getHook(path => { if (path === paths.profile) f.changeUser(null); });
    else f.transactionHook(() => f.changeUser(null));
    await assert.rejects(f.api.resetArtifactSettings('gw'), /UNAUTHENTICATED/); assert.equal(f.writes.length, 0);
  }
});

test('subscription waits for all membership server snapshots and ignores cached/pending settings', async () => {
  const f = fixture(document()); await f.restore(); const received = [], errors = [];
  for (const path of [paths.identity, paths.profile, paths.device]) f.initialMetadata.set(path, {fromCache: true});
  const stop = f.api.subscribeArtifactSettings('gw', value => received.push(value), error => errors.push(error));
  await settle(); assert.equal(received.length, 0); assert(!f.listeners.has(paths.gw));
  f.emit(paths.identity); f.emit(paths.profile); await settle(); assert.equal(received.length, 0);
  f.emit(paths.device); await settle(); assert.equal(received.length, 1);
  for (const metadata of [{fromCache: true}, {hasPendingWrites: true}, {fromCache: true, hasPendingWrites: true}]) {
    f.set(paths.gw, document({revision: 2}), metadata); await settle(); assert.equal(received.length, 1);
  }
  f.emit(paths.gw); await settle(); assert.equal(received.at(-1).revision, 2); assert.deepEqual(errors, []); stop();
});

test('unsubscribe during pending context creates no later watchers or callbacks', async () => {
  const f = fixture(document()); await f.restore(); const received = [], errors = []; let release;
  f.getHook(path => path === paths.profile ? new Promise(resolve => { release = resolve; }) : undefined);
  const stop = f.api.subscribeArtifactSettings('gw', value => received.push(value), error => errors.push(error));
  await settle(); assert.equal(typeof release, 'function'); stop(); release(); await settle();
  assert.equal(f.listenerCount(), 0); assert.deepEqual(received, []); assert.deepEqual(errors, []);
});

for (const [name, path, data] of [['identity revoked', paths.identity, {active: false}],
  ['profile inactive', paths.profile, {status: 'inactive'}], ['device inactive', paths.device, {status: 'inactive'}],
  ['identity profile changed', paths.identity, {active: true, profileId: 'profileB', deviceId: 'deviceA'}],
  ['identity device changed', paths.identity, {active: true, profileId: 'profileA', deviceId: 'deviceB'}]]) {
  test('subscription closes all listeners when ' + name, async () => {
    const f = fixture(document()); await f.restore(); const received = [], errors = [];
    f.api.subscribeArtifactSettings('gw', value => received.push(value), error => errors.push(error.message)); await settle();
    f.set(path, data); await settle(); assert.deepEqual(errors, ['MEMBERSHIP_REQUIRED']); assert.equal(f.listenerCount(), 0);
    f.set(paths.gw, document({revision: 3})); await settle(); assert.equal(received.length, 1);
  });
}

test('cached membership revocation waits for server confirmation', async () => {
  const f = fixture(document()); await f.restore(); const errors = [];
  f.api.subscribeArtifactSettings('gw', () => {}, error => errors.push(error.message)); await settle();
  f.set(paths.device, {status: 'inactive'}, {fromCache: true}); await settle(); assert.deepEqual(errors, []);
  f.emit(paths.device); await settle(); assert.deepEqual(errors, ['MEMBERSHIP_REQUIRED']); assert.equal(f.listenerCount(), 0);
});

test('subscription auth replacement stops before a queued settings result is delivered', async () => {
  for (const user of [null, {uid: 'other', isAnonymous: true}, {uid: 'memberA', isAnonymous: false}]) {
    const f = fixture(document()); await f.restore(); const received = [], errors = [];
    f.api.subscribeArtifactSettings('gw', value => received.push(value), error => errors.push(error.message)); await settle();
    f.set(paths.gw, document({revision: 2})); f.changeUser(user); await settle();
    assert.deepEqual(errors, ['UNAUTHENTICATED']); assert.equal(received.length, 1); assert.equal(f.listenerCount(), 0);
  }
});

test('invalid remote schema stops subscription exactly once with a redacted validation error', async () => {
  const f = fixture(document()); await f.restore(); const received = [], errors = [];
  f.api.subscribeArtifactSettings('gw', value => received.push(value), error => errors.push(error.message)); await settle();
  f.set(paths.gw, document({catalogVersion: 2})); await settle();
  assert.deepEqual(errors, ['INVALID_SETTINGS']); assert.equal(received.length, 1); assert.equal(f.listenerCount(), 0);
});

test('unknown SDK errors close subscription and redact internal details', async () => {
  const f = fixture(document()); await f.restore(); const errors = [];
  f.api.subscribeArtifactSettings('gw', () => {}, error => errors.push(error.message)); await settle();
  f.error(paths.gw, Error('secret profile stack token')); await settle();
  assert.deepEqual(errors, ['SETTINGS_UNAVAILABLE']); assert.equal(f.listenerCount(), 0);
});

test('consumer callback exceptions are not relabeled as schema failures', async t => {
  const original = globalThis.queueMicrotask, thrown = [], errors = [], consumerError = Error('consumer');
  t.mock.method(globalThis, 'queueMicrotask', callback => original(() => { try { callback(); } catch (error) { thrown.push(error); } }));
  const f = fixture(document()); await f.restore();
  const stop = f.api.subscribeArtifactSettings('gw', () => { throw consumerError; }, error => errors.push(error)); await settle();
  assert.deepEqual(thrown, [consumerError]); assert.deepEqual(errors, []); assert(f.listenerCount() > 0); stop();
});

test('subscription validates callback arguments synchronously', () => {
  const f = fixture();
  assert.throws(() => f.api.subscribeArtifactSettings('gw', null), TypeError);
  assert.throws(() => f.api.subscribeArtifactSettings('gw', () => {}, null), TypeError);
});
