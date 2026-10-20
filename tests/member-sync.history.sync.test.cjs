const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHistoryReadSync, mountHistoryReadSync, createMemberSync} = require('../member-sync');

const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const identity = (profileId = 'profileA', deviceId = 'deviceA') => ({active: true, profileId, deviceId});

function localIO(seenIds = [], extra = {}) {
  let state = {profileId: null, seenIds: [...seenIds], pendingIds: [...seenIds], limitedIds: [], ...extra};
  let durable = true;
  const archive = new Map(), listeners = new Set(), events = [];
  const save = name => { events.push([name, JSON.parse(JSON.stringify(state))]); for (const callback of listeners) callback(); return durable; };
  const io = {
    snapshot: () => JSON.parse(JSON.stringify(state)),
    bindProfile(profileId) {
      if (state.profileId && state.profileId !== profileId) {
        archive.set(state.profileId, io.snapshot());
        state = archive.get(profileId) || {profileId, seenIds: [], pendingIds: [], limitedIds: []};
      }
      state.profileId = profileId;
      return save('bind');
    },
    applyRemote(ids, profileId) {
      if (state.profileId !== profileId) return false;
      state.seenIds = [...new Set([...state.seenIds, ...ids])];
      state.pendingIds = state.pendingIds.filter(id => !ids.includes(id));
      state.limitedIds = state.limitedIds.filter(id => !ids.includes(id));
      return save('remote');
    },
    ack(id, profileId) {
      if (state.profileId !== profileId) return false;
      state.pendingIds = state.pendingIds.filter(value => value !== id);
      return save('ack:' + id);
    },
    limit(id, profileId) {
      if (state.profileId !== profileId) return false;
      state.pendingIds = state.pendingIds.filter(value => value !== id);
      state.limitedIds = [...new Set([...state.limitedIds, id])];
      return save('limit:' + id);
    },
    flush: () => { events.push(['flush']); return durable; },
    mark(id) {
      state.seenIds = [...new Set([...state.seenIds, id])];
      if (!state.limitedIds.includes(id)) state.pendingIds = [...new Set([...state.pendingIds, id])];
      return save('mark:' + id);
    },
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); }
  };
  return {io, events, archive, durability: value => { durable = value; }};
}

function transport(initial = [], member = identity()) {
  let data = initial === null ? null : {seenIds: [...initial], revision: 1};
  let currentIdentity = member, getHook, markHook, initHook;
  const calls = [], listeners = new Set();
  const guard = expected => {
    if (!currentIdentity?.active || (expected && (expected.profileId !== currentIdentity.profileId || expected.deviceId !== currentIdentity.deviceId))) {
      throw new Error('MEMBERSHIP_REQUIRED');
    }
  };
  const client = {
    async getIdentity() { calls.push(['identity']); return currentIdentity && {...currentIdentity}; },
    async getHistoryReadState(expected) {
      calls.push(['get', expected]); guard(expected); if (getHook) await getHook(); guard(expected);
      return data && {seenIds: [...data.seenIds], revision: data.revision};
    },
    async initializeHistoryReadState(ids, expected) {
      calls.push(['initialize', [...ids], expected]); guard(expected); assert(ids.length <= 1);
      if (initHook) await initHook(); guard(expected);
      if (!data) data = {seenIds: [...ids], revision: 1};
      return {seenIds: [...data.seenIds], revision: data.revision};
    },
    async markHistorySeen(id, expected) {
      calls.push(['mark', id, expected]); guard(expected); if (markHook) await markHook(id); guard(expected);
      if (!data) data = {seenIds: [], revision: 0};
      if (!data.seenIds.includes(id)) {
        if (data.seenIds.length === 256) throw new Error('HISTORY_READ_LIMIT');
        data = {seenIds: [...data.seenIds, id], revision: data.revision + 1};
      }
      return data.revision;
    },
    subscribeHistoryReadState(next, error, expected) {
      calls.push(['subscribe', expected]); guard(expected);
      const record = {next, error}; listeners.add(record);
      return () => { calls.push(['unsubscribe']); listeners.delete(record); };
    }
  };
  return {client, calls, listeners, data: () => data, identity: value => { currentIdentity = value; },
    getHook: value => { getHook = value; }, markHook: value => { markHook = value; }, initHook: value => { initHook = value; },
    emit(ids) { data = {seenIds: [...ids], revision: (data?.revision || 0) + 1}; for (const listener of listeners) listener.next(data); },
    fail() { for (const listener of [...listeners]) listener.error(new Error('SETTINGS_UNAVAILABLE')); }
  };
}

test('history controller unions cloud and local without losing either side', async () => {
  const f = localIO(['A']), cloud = transport(['B']), sync = createHistoryReadSync(cloud.client, f.io);
  assert.equal(await sync.start(), true);
  assert.deepEqual(new Set(f.io.snapshot().seenIds), new Set(['A', 'B']));
  assert.deepEqual(new Set(cloud.data().seenIds), new Set(['A', 'B']));
  assert.deepEqual(f.io.snapshot().pendingIds, []); sync.stop();
});

test('history initial creation uses at most one ID then sequentially replays the remainder', async () => {
  const f = localIO(['A', 'B', 'C']), cloud = transport(null), sync = createHistoryReadSync(cloud.client, f.io);
  await sync.start();
  assert.deepEqual(cloud.calls.find(call => call[0] === 'initialize')[1], ['A']);
  assert.deepEqual(cloud.calls.filter(call => call[0] === 'mark').map(call => call[1]), ['B', 'C']);
  assert.deepEqual(cloud.data().seenIds, ['A', 'B', 'C']); sync.stop();
});

test('history empty first device creates a zero-ID document', async () => {
  const f = localIO(), cloud = transport(null), sync = createHistoryReadSync(cloud.client, f.io);
  await sync.start(); assert.deepEqual(cloud.data().seenIds, []);
  assert.deepEqual(cloud.calls.find(call => call[0] === 'initialize')[1], []); sync.stop();
});

test('history remote snapshots add local seen IDs without echoing remote IDs', async () => {
  const f = localIO(), cloud = transport(['A']), sync = createHistoryReadSync(cloud.client, f.io);
  await sync.start(); cloud.emit(['A', 'B']); await settle();
  assert.deepEqual(f.io.snapshot().seenIds, ['A', 'B']);
  assert.equal(cloud.calls.filter(call => call[0] === 'mark').length, 0); sync.stop();
});

test('history server-existing ID ACKs pending without calling mark', async () => {
  const f = localIO(['A']), cloud = transport(['A']), sync = createHistoryReadSync(cloud.client, f.io);
  await sync.start(); assert.deepEqual(f.io.snapshot().pendingIds, []);
  assert.equal(cloud.calls.filter(call => call[0] === 'mark').length, 0); sync.stop();
});

test('history pending is synchronously durable before the first network mark', async () => {
  const f = localIO(), cloud = transport(), sync = createHistoryReadSync(cloud.client, f.io);
  await sync.start(); cloud.markHook(id => {
    assert(f.io.snapshot().pendingIds.includes(id));
    assert.equal(f.events.at(-1)[0], 'flush');
    assert(f.events.some(event => event[0] === 'mark:A'));
  });
  f.io.mark('A'); await sync.replayPending();
  assert.deepEqual(f.io.snapshot().pendingIds, []); sync.stop();
});

test('history local durability failure prevents cloud read, initialize and writes', async () => {
  const f = localIO(['A']), cloud = transport(null), sync = createHistoryReadSync(cloud.client, f.io);
  f.durability(false); assert.equal(await sync.start(), false);
  assert.deepEqual(cloud.calls.map(call => call[0]), ['identity']);
  assert.deepEqual(f.io.snapshot().pendingIds, ['A']); sync.stop();
});

test('history a later storage failure prevents submitting newly marked pending', async () => {
  const f = localIO(), cloud = transport(), sync = createHistoryReadSync(cloud.client, f.io);
  await sync.start(); f.io.mark('A'); f.durability(false);
  assert.equal(await sync.replayPending(), false);
  assert.deepEqual(f.io.snapshot().pendingIds, ['A']);
  assert.equal(cloud.calls.filter(call => call[0] === 'mark').length, 0); sync.stop();
});

test('history failed write retains local and pending for reload replay', async () => {
  const f = localIO(['A']), cloud = transport();
  cloud.markHook(() => { throw new Error('offline'); });
  const first = createHistoryReadSync(cloud.client, f.io);
  assert.equal(await first.start(), false);
  assert.deepEqual(f.io.snapshot().seenIds, ['A']); assert.deepEqual(f.io.snapshot().pendingIds, ['A']);
  cloud.markHook(null);
  const reloaded = createHistoryReadSync(cloud.client, f.io);
  await reloaded.start(); assert.deepEqual(f.io.snapshot().pendingIds, []);
  assert.deepEqual(cloud.data().seenIds, ['A']); reloaded.stop();
});

test('history reconnect start recovers an offline get without losing pending', async () => {
  const f = localIO(['A']), cloud = transport(), sync = createHistoryReadSync(cloud.client, f.io);
  cloud.getHook(() => { throw new Error('offline'); });
  assert.equal(await sync.start(), false); assert.deepEqual(f.io.snapshot().pendingIds, ['A']);
  cloud.getHook(null); assert.equal(await sync.start(), true);
  assert.deepEqual(f.io.snapshot().pendingIds, []); sync.stop();
});

test('history mark return alone does not ACK an unconfirmed server ID', async () => {
  const f = localIO(['A']), cloud = transport();
  cloud.client.markHistorySeen = async () => 2;
  const sync = createHistoryReadSync(cloud.client, f.io);
  assert.equal(await sync.start(), false); assert.deepEqual(f.io.snapshot().pendingIds, ['A']); sync.stop();
});

test('history failed confirmation read retains pending after a committed mark', async () => {
  const f = localIO(['A']), cloud = transport(); let reads = 0;
  cloud.getHook(() => { if (++reads === 2) throw new Error('offline'); });
  const sync = createHistoryReadSync(cloud.client, f.io);
  assert.equal(await sync.start(), false); assert.deepEqual(cloud.data().seenIds, ['A']);
  assert.deepEqual(f.io.snapshot().pendingIds, ['A']);
  cloud.getHook(null); await sync.start(); assert.deepEqual(f.io.snapshot().pendingIds, []); sync.stop();
});

test('history confirmed remote snapshot can ACK an in-flight ID', async () => {
  const f = localIO(), cloud = transport(), wait = deferred();
  const sync = createHistoryReadSync(cloud.client, f.io); await sync.start();
  cloud.markHook(() => wait.promise); f.io.mark('A'); const sending = sync.replayPending(); await settle();
  cloud.emit(['A']); assert.deepEqual(f.io.snapshot().pendingIds, []);
  wait.resolve(); await sending; sync.stop();
});

test('history A in flight then B mark and pagehide preserves both pending IDs', async () => {
  const f = localIO(), cloud = transport(), wait = deferred();
  const sync = createHistoryReadSync(cloud.client, f.io); await sync.start();
  cloud.markHook(() => wait.promise); f.io.mark('A'); const sending = sync.replayPending(); await settle();
  f.io.mark('B'); sync.stop(); wait.resolve(); await sending;
  assert.deepEqual(f.io.snapshot().seenIds, ['A', 'B']); assert.deepEqual(f.io.snapshot().pendingIds, ['A', 'B']);
  assert.deepEqual(cloud.calls.filter(call => call[0] === 'mark').map(call => call[1]), ['A']);
});

test('history A confirmation cannot ACK B while B starts its own write', async () => {
  const f = localIO(), cloud = transport(), first = deferred(), second = deferred();
  const sync = createHistoryReadSync(cloud.client, f.io); await sync.start();
  cloud.markHook(id => id === 'A' ? first.promise : second.promise);
  f.io.mark('A'); const sending = sync.replayPending(); await settle(); f.io.mark('B'); first.resolve(); await settle();
  assert.deepEqual(f.io.snapshot().pendingIds, ['B']);
  assert.deepEqual(cloud.calls.filter(call => call[0] === 'mark').map(call => call[1]), ['A', 'B']);
  second.resolve(); await sending; assert.deepEqual(f.io.snapshot().pendingIds, []); sync.stop();
});

test('history repeated local ID is submitted once even under concurrent replay calls', async () => {
  const f = localIO(), cloud = transport(), wait = deferred();
  const sync = createHistoryReadSync(cloud.client, f.io); await sync.start();
  cloud.markHook(() => wait.promise); f.io.mark('A'); f.io.mark('A');
  const one = sync.replayPending(), two = sync.replayPending(); assert.equal(one, two);
  wait.resolve(); await one;
  assert.equal(cloud.calls.filter(call => call[0] === 'mark').length, 1); sync.stop();
});

test('history a new pending ID at replay completion is not lost behind the old promise', async () => {
  const f = localIO(), cloud = transport(), sync = createHistoryReadSync(cloud.client, f.io);
  await sync.start();
  const originalSnapshot = f.io.snapshot; let inject = false;
  f.io.snapshot = () => {
    const result = originalSnapshot();
    if (inject && result.pendingIds.length === 0) {
      inject = false;
      queueMicrotask(() => { f.io.mark('B'); sync.replayPending(); });
    }
    return result;
  };
  f.io.mark('A'); inject = true; await sync.replayPending(); await settle();
  assert.deepEqual(cloud.data().seenIds, ['A', 'B']);
  assert.deepEqual(f.io.snapshot().pendingIds, []); sync.stop();
});

test('history limit moves every unsent ID to terminal local state without retry loops', async () => {
  const full = Array.from({length: 256}, (_, i) => 'server-' + i);
  const f = localIO(['A', 'B']), cloud = transport(full), sync = createHistoryReadSync(cloud.client, f.io);
  assert.equal(await sync.start(), false);
  assert.deepEqual(f.io.snapshot().pendingIds, []); assert.deepEqual(f.io.snapshot().limitedIds, ['A', 'B']);
  assert(f.io.snapshot().seenIds.includes('A')); assert.equal(cloud.data().seenIds.length, 256);
  for (let i = 0; i < 5; i++) { await sync.replayPending(); sync.stop(); await sync.start(); }
  assert.equal(cloud.calls.filter(call => call[0] === 'mark').length, 1); sync.stop();
});

test('history remotely confirmed formerly limited ID clears only that terminal entry', async () => {
  const f = localIO(['A', 'B'], {pendingIds: [], limitedIds: ['A', 'B']}), cloud = transport(['A']);
  const sync = createHistoryReadSync(cloud.client, f.io); await sync.start();
  assert.deepEqual(f.io.snapshot().limitedIds, ['B']); assert.deepEqual(f.io.snapshot().pendingIds, []); sync.stop();
});

for (const member of [null, {...identity(), active: false}, {...identity(), profileId: 'bad/path'}, {...identity(), deviceId: ''}]) {
  test('history inactive or missing identity leaves local-only state: ' + JSON.stringify(member), async () => {
    const f = localIO(['A']), cloud = transport([], member), sync = createHistoryReadSync(cloud.client, f.io);
    assert.equal(await sync.start(), false); assert.deepEqual(cloud.calls.map(call => call[0]), ['identity']);
    assert.deepEqual(f.io.snapshot().pendingIds, ['A']); sync.stop();
  });
}

test('history switched profile archives old pending and sends only new profile local IDs', async () => {
  const f = localIO(['A']), cloud = transport(), sync = createHistoryReadSync(cloud.client, f.io);
  cloud.getHook(() => { throw new Error('offline'); }); await sync.start();
  cloud.identity(identity('profileB', 'deviceB')); cloud.getHook(null); await sync.start();
  assert.deepEqual(f.archive.get('profileA').pendingIds, ['A']);
  assert.equal(cloud.calls.filter(call => call[0] === 'mark').length, 0);
  f.io.mark('B'); await sync.replayPending();
  assert.deepEqual(cloud.calls.filter(call => call[0] === 'mark').map(call => [call[1], call[2].profileId]), [['B', 'profileB']]); sync.stop();
});

test('history identity change between controller lookup and API call is guarded', async () => {
  const f = localIO(['A']), cloud = transport();
  const originalBind = f.io.bindProfile;
  f.io.bindProfile = profileId => { const result = originalBind(profileId); cloud.identity(identity('profileB', 'deviceB')); return result; };
  const sync = createHistoryReadSync(cloud.client, f.io);
  assert.equal(await sync.start(), false); assert.deepEqual(cloud.data().seenIds, []);
  assert.deepEqual(f.io.snapshot().pendingIds, ['A']);
  assert.equal(cloud.calls.filter(call => call[0] === 'mark').length, 0); sync.stop();
});

test('history late old-profile mark result cannot ACK the newly bound profile', async () => {
  const f = localIO(), cloud = transport(), wait = deferred(), sync = createHistoryReadSync(cloud.client, f.io);
  await sync.start(); cloud.markHook(() => wait.promise); f.io.mark('A'); const sending = sync.replayPending(); await settle();
  sync.stop(); cloud.identity(identity('profileB', 'deviceB')); cloud.markHook(null); await sync.start();
  f.io.mark('B'); wait.resolve(); await sending;
  assert.equal(f.io.snapshot().profileId, 'profileB'); assert.deepEqual(f.io.snapshot().pendingIds, ['B']);
  assert.deepEqual(f.archive.get('profileA').pendingIds, ['A']); sync.stop();
});

test('history stop during initial get prevents late initialization and subscription', async () => {
  const f = localIO(['A']), cloud = transport(null), wait = deferred(), sync = createHistoryReadSync(cloud.client, f.io);
  cloud.getHook(() => wait.promise); const starting = sync.start(); await settle(); sync.stop(); wait.resolve();
  assert.equal(await starting, false); assert.equal(cloud.calls.filter(call => ['initialize', 'subscribe', 'mark'].includes(call[0])).length, 0);
  assert.deepEqual(f.io.snapshot().pendingIds, ['A']);
});

test('history subscribe failure stops listeners and retains unsent local reads', async () => {
  const f = localIO(), cloud = transport(), sync = createHistoryReadSync(cloud.client, f.io);
  await sync.start(); cloud.fail(); f.io.mark('A'); await sync.replayPending();
  assert.equal(cloud.listeners.size, 0); assert.deepEqual(f.io.snapshot().pendingIds, ['A']);
  await sync.start(); assert.deepEqual(f.io.snapshot().pendingIds, []); sync.stop();
});

function eventTarget() {
  const listeners = new Map();
  return {addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatch(type) { for (const callback of [...(listeners.get(type) || [])]) callback({type}); },
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0)};
}

function bootstrap(member = identity()) {
  class Timestamp {}
  const authListeners = new Set(), listeners = new Map(), calls = []; let transactionHook;
  const docs = new Map();
  if (member) {
    docs.set('memberIdentities/memberA', {...member});
    docs.set('memberProfiles/' + member.profileId, {status: 'active'});
    docs.set('memberProfiles/' + member.profileId + '/devices/' + member.deviceId, {status: 'active'});
    docs.set('memberProfiles/' + member.profileId + '/settings/historyReadState', {
      schemaVersion: 1, seenIds: [], revision: 1, createdAt: new Timestamp(), updatedAt: new Timestamp(), updatedByDeviceId: member.deviceId});
  }
  const snapshot = path => ({exists: docs.has(path), data: () => docs.get(path), metadata: {fromCache: false, hasPendingWrites: false}});
  const auth = {currentUser: member ? {uid: 'memberA', isAnonymous: true} : null,
    setPersistence: async value => { calls.push(['persistence', value]); },
    onAuthStateChanged(next) { authListeners.add(next); queueMicrotask(() => { if (authListeners.has(next)) next(auth.currentUser); }); return () => authListeners.delete(next); },
    signInAnonymously() { calls.push(['anonymous']); throw new Error('anonymous creation forbidden'); },
    useEmulator() { calls.push(['auth-emulator']); }
  };
  const db = {useEmulator() { calls.push(['firestore-emulator']); },
    doc(path) { return {path,
      async get() { calls.push(['get', path]); return snapshot(path); },
      onSnapshot(options, next) { calls.push(['subscribe', path]); if (!listeners.has(path)) listeners.set(path, new Set()); listeners.get(path).add(next);
        queueMicrotask(() => { if (listeners.get(path).has(next)) next(snapshot(path)); }); return () => listeners.get(path).delete(next); }
    }; },
    async runTransaction(operation) {
      calls.push(['transaction']);
      if (transactionHook) await transactionHook();
      const staged = [];
      const result = await operation({get: async ref => snapshot(ref.path),
        set(ref, data) { staged.push(['set', ref.path, data]); }, update(ref, data) { staged.push(['update', ref.path, data]); }});
      for (const [kind, path, data] of staged) {
        const previous = docs.get(path) || {}, next = kind === 'set' ? {} : {...previous};
        for (const [key, value] of Object.entries(data)) {
          next[key] = value?.serverTimestamp ? new Timestamp() : value?.increment ? previous[key] + value.increment
            : value?.arrayUnion ? [...new Set([...(previous[key] || []), ...value.arrayUnion])] : value;
        }
        docs.set(path, next); calls.push(['write', path]);
        for (const callback of listeners.get(path) || []) callback(snapshot(path));
      }
      return result;
    }
  };
  const sdk = {apps: [], auth: {Auth: {Persistence: {LOCAL: 'local'}}}, firestore: {Timestamp,
    FieldValue: {serverTimestamp: () => ({serverTimestamp: true}), increment: value => ({increment: value}), arrayUnion: (...values) => ({arrayUnion: values})}},
    initializeApp() { calls.push(['initialize']); return {auth: () => auth, firestore: () => db}; }};
  const scope = {...eventTarget(), document: {...eventTarget(), hidden: false}, navigator: {onLine: true},
    location: {hostname: 'localhost', href: 'http://localhost:8000/', origin: 'http://localhost:8000', protocol: 'http:'},
    MEMBER_SYNC_LOCAL: {firebaseConfig: {projectId: 'gbf-meron-portal', apiKey: 'local-only'}, apiBase: '/api/member-sync'}, firebase: sdk};
  return {scope, calls, docs, auth, sdk, listeners,
    transactionHook: hook => { transactionHook = hook; },
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    emit(path) { for (const callback of listeners.get(path) || []) callback(snapshot(path)); }};
}

test('history headless mount restores absent auth without anonymous creation or data/API reads', async () => {
  const f = localIO(['A']), b = bootstrap(null), handle = mountHistoryReadSync(f.io, b.scope);
  await handle.start(); await settle();
  assert(b.calls.some(call => call[0] === 'persistence'));
  assert.equal(b.calls.filter(call => ['get', 'anonymous', 'transaction'].includes(call[0])).length, 0);
  assert.deepEqual(f.io.snapshot().pendingIds, ['A']); handle.dispose();
});

test('history headless mount restores existing membership without pairing/status requests', async () => {
  const f = localIO(), b = bootstrap(), handle = mountHistoryReadSync(f.io, b.scope);
  await handle.start(); await settle();
  assert.equal(f.io.snapshot().profileId, 'profileA'); assert.equal(b.count(), 4);
  assert.equal(b.calls.filter(call => call[0] === 'anonymous').length, 0);
  assert(!b.calls.some(call => call[1]?.includes('/api/'))); handle.dispose(); assert.equal(b.count(), 0);
});

test('history headless no-profile auth performs identity lookup and leaves local only', async () => {
  const f = localIO(['A']), b = bootstrap(); b.docs.delete('memberIdentities/memberA');
  const handle = mountHistoryReadSync(f.io, b.scope); await handle.start();
  assert.deepEqual(b.calls.filter(call => call[0] === 'get').map(call => call[1]), ['memberIdentities/memberA']);
  assert.equal(f.io.snapshot().profileId, null); handle.dispose();
});

test('history headless SDK failure and configuration failure preserve usable local IO', async () => {
  for (const invalidConfig of [false, true]) {
    const f = localIO(), b = bootstrap();
    if (invalidConfig) b.scope.MEMBER_SYNC_LOCAL = null;
    else {
      delete b.scope.firebase;
      b.scope.document.createElement = () => ({});
      b.scope.document.head = {append(script) { queueMicrotask(() => script.onerror()); }};
    }
    const handle = mountHistoryReadSync(f.io, b.scope); assert.equal(await handle.start(), false);
    f.io.mark('A'); assert.deepEqual(f.io.snapshot().seenIds, ['A']); assert.deepEqual(f.io.snapshot().pendingIds, ['A']);
    assert.equal(b.calls.length, 0); handle.dispose();
  }
});

test('history headless offline startup and online resume obey lifecycle without new accounts', async () => {
  const f = localIO(), b = bootstrap(); b.scope.navigator.onLine = false;
  const handle = mountHistoryReadSync(f.io, b.scope); await settle(); assert.equal(b.calls.length, 0);
  b.scope.navigator.onLine = true; b.scope.dispatch('online'); await handle.start(); await settle(); assert.equal(b.count(), 4);
  b.scope.dispatch('pagehide'); const callCount = b.calls.length; await settle(); assert.equal(b.count(), 0); assert.equal(b.calls.length, callCount);
  b.scope.dispatch('pageshow'); await handle.start(); await settle(); assert.equal(b.count(), 4);
  handle.dispose(); assert.equal(b.scope.count(), 0); assert.equal(b.scope.document.count(), 0);
});

test('history headless pagehide during authentication restore prevents late identity reads', async () => {
  const f = localIO(['A']), b = bootstrap();
  let next;
  b.auth.onAuthStateChanged = callback => { next = callback; return () => {}; };
  const handle = mountHistoryReadSync(f.io, b.scope); await settle(); b.scope.dispatch('pagehide'); next(b.auth.currentUser);
  await settle(); assert.equal(b.calls.filter(call => call[0] === 'get').length, 0);
  assert.deepEqual(f.io.snapshot().pendingIds, ['A']); handle.dispose();
});

test('history headless queued B start and late callbacks cannot restart transport after pagehide', async () => {
  const f = localIO(), b = bootstrap(), wait = deferred(), handle = mountHistoryReadSync(f.io, b.scope);
  await handle.start(); await settle();
  b.transactionHook(() => wait.promise); f.io.mark('A'); await settle();
  assert.equal(b.calls.filter(call => call[0] === 'transaction').length, 1);
  // mark synchronously queues a mount callback, then pagehide runs before that
  // microtask. document.hidden intentionally stays false to model BFCache too.
  f.io.mark('B'); b.scope.dispatch('pagehide');
  const atHide = b.calls.length;
  await settle(); assert.equal(b.calls.length, atHide);
  wait.resolve(); await settle();
  assert.deepEqual(b.docs.get('memberProfiles/profileA/settings/historyReadState').seenIds, ['A']);
  assert.deepEqual(f.io.snapshot().pendingIds, ['A', 'B']);
  assert.equal(b.calls.filter(call => call[0] === 'transaction').length, 1);
  // Neither late local callbacks nor unrelated resume-like events may reopen
  // this page lifecycle; only pageshow releases its suspension.
  f.io.mark('C'); b.scope.dispatch('online'); b.scope.document.dispatch('visibilitychange');
  assert.equal(await handle.start(), false); await settle();
  assert.equal(b.calls.filter(call => call[0] === 'transaction').length, 1);
  assert.deepEqual(f.io.snapshot().pendingIds, ['A', 'B', 'C']);
  b.transactionHook(null); b.scope.dispatch('pageshow'); await handle.start(); await settle();
  assert.deepEqual(b.docs.get('memberProfiles/profileA/settings/historyReadState').seenIds, ['A', 'B', 'C']);
  assert.deepEqual(f.io.snapshot().pendingIds, []); handle.dispose();
});

test('history headless a new local read retries after a transient failure without an online event', async () => {
  const f = localIO(), b = bootstrap(), handle = mountHistoryReadSync(f.io, b.scope);
  await handle.start(); await settle();
  b.transactionHook(() => { throw new Error('offline'); }); f.io.mark('A'); await settle();
  assert.deepEqual(f.io.snapshot().pendingIds, ['A']);
  assert.equal(b.calls.filter(call => call[0] === 'transaction').length, 1);
  b.transactionHook(null); f.io.mark('B'); await settle(); await handle.start(); await settle();
  assert.deepEqual(b.docs.get('memberProfiles/profileA/settings/historyReadState').seenIds, ['A', 'B']);
  assert.deepEqual(f.io.snapshot().pendingIds, []); handle.dispose();
});

test('history headless authentication failure leaves local marking and pending available', async () => {
  const f = localIO(), b = bootstrap();
  b.auth.setPersistence = async () => { throw new Error('auth unavailable'); };
  const handle = mountHistoryReadSync(f.io, b.scope); assert.equal(await handle.start(), false);
  f.io.mark('A'); await settle(); assert.deepEqual(f.io.snapshot().pendingIds, ['A']);
  assert.equal(b.calls.filter(call => call[0] === 'get' || call[0] === 'anonymous').length, 0); handle.dispose();
});

test('history optional expected membership rejects stale profiles and devices in every API', async () => {
  const b = bootstrap(), client = createMemberSync(b.sdk, {}); await client.restoreAuthentication();
  for (const expected of [{profileId: 'profileB', deviceId: 'deviceA'}, {profileId: 'profileA', deviceId: 'deviceB'}, {}, null]) {
    await assert.rejects(client.getHistoryReadState(expected), /MEMBERSHIP_REQUIRED/);
    await assert.rejects(client.initializeHistoryReadState([], expected), /MEMBERSHIP_REQUIRED/);
    await assert.rejects(client.markHistorySeen('A', expected), /MEMBERSHIP_REQUIRED/);
    if (expected && expected.profileId && expected.deviceId) {
      const errors = []; const stop = client.subscribeHistoryReadState(() => assert.fail('must not receive foreign state'), error => errors.push(error.message), expected);
      await settle(); assert.deepEqual(errors, ['MEMBERSHIP_REQUIRED']); stop();
    } else assert.throws(() => client.subscribeHistoryReadState(() => {}, () => {}, expected), /MEMBERSHIP_REQUIRED/);
  }
  assert.equal(b.calls.filter(call => call[0] === 'transaction').length, 0);
  assert(!b.calls.some(call => call[1]?.startsWith('memberProfiles/profileB')));
});

test('history optional expected membership is copied before asynchronous lookup', async () => {
  const b = bootstrap(), client = createMemberSync(b.sdk, {}); await client.restoreAuthentication();
  const expected = {profileId: 'profileA', deviceId: 'deviceA'};
  const read = client.getHistoryReadState(expected); expected.profileId = 'profileB'; expected.deviceId = 'deviceB';
  assert.deepEqual((await read).seenIds, []);
});

test('history guarded transaction rechecks identity changes after the initial context read', async () => {
  const b = bootstrap(), client = createMemberSync(b.sdk, {}); await client.restoreAuthentication();
  // The call starts with A, then the transaction sees a new B membership.
  const app = b.sdk.initializeApp(); const original = app.firestore().runTransaction;
  app.firestore().runTransaction = operation => {
    b.docs.set('memberIdentities/memberA', identity('profileB', 'deviceB'));
    return original(operation);
  };
  await assert.rejects(client.markHistorySeen('A', {profileId: 'profileA', deviceId: 'deviceA'}), /MEMBERSHIP_REQUIRED/);
  assert.deepEqual(b.docs.get('memberProfiles/profileA/settings/historyReadState').seenIds, []);
  assert(!b.calls.some(call => call[1]?.startsWith('memberProfiles/profileB')));
});
