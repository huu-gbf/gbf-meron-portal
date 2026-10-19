/* Real Firestore emulator transactions and subscription lifecycle. Authentication
 * events are controlled locally; no production service or browser is used. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const {initializeTestEnvironment, assertFails} = require('@firebase/rules-unit-testing');
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');
const {createMemberSync} = require('../member-sync');

const stamp = () => firebase.firestore.FieldValue.serverTimestamp();
const document = (deviceId, seenIds = [], revision = 1) => ({
  schemaVersion: 1, seenIds: [...seenIds], revision,
  createdAt: stamp(), updatedAt: stamp(), updatedByDeviceId: deviceId
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await pause(25);
  }
  throw Error('Expected history subscription state was not received');
}

async function fixture() {
  const env = await initializeTestEnvironment({
    projectId: 'demo-gbf-meron-portal-rules',
    firestore: {host: '127.0.0.1', port: 8080, rules: fs.readFileSync('firestore.rules', 'utf8')}
  });
  const profileA = randomUUID(), profileB = randomUUID(), prefix = randomUUID();
  const identities = {}, dbs = {};
  const members = [
    ['A1', profileA, 'deviceA1', true, 'active'],
    ['A2', profileA, 'deviceA2', true, 'active'],
    ['B1', profileB, 'deviceB1', true, 'active'],
    ['inactiveIdentity', profileA, 'inactiveIdentityDevice', false, 'active'],
    ['inactiveDevice', profileA, 'inactiveDevice', true, 'inactive'],
    ['missingDevice', profileA, 'missingDevice', true, null]
  ];
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const profileId of [profileA, profileB]) {
      await db.doc('memberProfiles/' + profileId).set({status: 'active'});
    }
    for (const [name, profileId, deviceId, active, deviceStatus] of members) {
      const uid = prefix + name;
      identities[name] = {uid, profileId, deviceId, active};
      await db.doc('memberIdentities/' + uid).set({profileId, deviceId, active});
      if (deviceStatus) {
        await db.doc('memberProfiles/' + profileId + '/devices/' + deviceId).set({status: deviceStatus});
      }
      dbs[name] = env.authenticatedContext(uid).firestore();
    }
  });
  identities.missingIdentity = {uid: prefix + 'missingIdentity'};
  dbs.missingIdentity = env.authenticatedContext(identities.missingIdentity.uid).firestore();
  dbs.guest = env.unauthenticatedContext().firestore();
  const path = profileId => 'memberProfiles/' + profileId + '/settings/historyReadState';
  const admin = operation => env.withSecurityRulesDisabled(context => operation(context.firestore()));
  const seed = (seenIds = [], revision = 1) => admin(db =>
    db.doc(path(profileA)).set(document('deviceA1', seenIds, revision)));
  const clear = () => admin(db => db.doc(path(profileA)).delete());
  return {env, profileA, profileB, identities, dbs, path, admin, seed, clear};
}

async function client(f, name) {
  const watchers = new Set();
  const auth = {
    currentUser: name === 'guest' ? null : {uid: f.identities[name].uid, isAnonymous: true},
    setPersistence: async () => {},
    onAuthStateChanged(callback) {
      watchers.add(callback);
      queueMicrotask(() => { if (watchers.has(callback)) callback(auth.currentUser); });
      return () => watchers.delete(callback);
    },
    signInAnonymously: async () => { throw Error('Unexpected account creation'); }
  };
  // Instrument the real listener delivery so public callbacks can be checked for
  // server confirmation; transaction reads/writes still use real DocumentRefs.
  const observed = {latestHistoryDelivery: null, listenerCount: 0};
  const realDb = f.dbs[name];
  const db = {
    doc(path) {
      const ref = realDb.doc(path);
      const listen = ref.onSnapshot.bind(ref);
      ref.onSnapshot = (...args) => {
        const callbackIndex = typeof args[0] === 'function' ? 0 : 1;
        const callback = args[callbackIndex];
        args[callbackIndex] = snapshot => {
          if (path === f.path(f.profileA)) {
            observed.latestHistoryDelivery = {
              path, fromCache: snapshot.metadata.fromCache,
              hasPendingWrites: snapshot.metadata.hasPendingWrites
            };
          }
          callback(snapshot);
        };
        let active = true;
        observed.listenerCount++;
        const stop = listen(...args);
        return () => {
          if (!active) return;
          active = false;
          observed.listenerCount--;
          stop();
        };
      };
      return ref;
    },
    runTransaction: callback => realDb.runTransaction(callback)
  };
  const sdk = {
    apps: [], auth: {Auth: {Persistence: {LOCAL: 'local'}}}, firestore: firebase.firestore,
    initializeApp: () => ({auth: () => auth, firestore: () => db})
  };
  const api = createMemberSync(sdk, {});
  await api.restoreAuthentication();
  return {
    api, watchers, observed,
    signOut() { auth.currentUser = null; watchers.forEach(callback => callback(null)); }
  };
}

test('historyReadState client: real transactions, monotonic union and subscription lifecycle', async t => {
  const f = await fixture();
  const a = await client(f, 'A1'), b = await client(f, 'A2');
  const ref = f.dbs.A1.doc(f.path(f.profileA));
  const cleanup = [];
  try {
    await t.test('missing get is null and a missing subscription reports null', async () => {
      await f.clear();
      assert.equal(await a.api.getHistoryReadState(), null);
      const received = [], errors = [];
      const stop = a.api.subscribeHistoryReadState(value => received.push(value), error => errors.push(error.message));
      cleanup.push(stop);
      await until(() => received.length);
      stop();
      assert.deepEqual(received, [null]);
      assert.deepEqual(errors, []);
      assert.equal(a.watchers.size, 0);
      assert.equal(a.observed.listenerCount, 0);
    });

    await t.test('initialize empty creates a frozen server-confirmed revision 1 document', async () => {
      await f.clear();
      const result = await a.api.initializeHistoryReadState([]);
      assert.deepEqual(result.seenIds, []);
      assert.equal(result.revision, 1);
      assert.equal(result.updatedByDeviceId, 'deviceA1');
      assert(result.createdAt instanceof firebase.firestore.Timestamp);
      assert(result.updatedAt instanceof firebase.firestore.Timestamp);
      assert(Object.isFrozen(result));
      assert(Object.isFrozen(result.seenIds));
      assert.deepEqual((await ref.get()).data(), result);
    });

    await t.test('initialize accepts one current Japanese history ID without changing it', async () => {
      await f.clear();
      const historyId = '2026/10/19|更新履歴の既読同期';
      const result = await b.api.initializeHistoryReadState([historyId]);
      assert.deepEqual(result.seenIds, [historyId]);
      assert.equal(result.revision, 1);
      assert.equal(result.updatedByDeviceId, 'deviceA2');
    });

    await t.test('simultaneous initialization adopts the winner and writes only revision 1', async () => {
      await f.clear();
      const results = await Promise.all([
        a.api.initializeHistoryReadState(['initial-A']),
        b.api.initializeHistoryReadState(['initial-B'])
      ]);
      assert.deepEqual(results[0], results[1]);
      assert.equal(results[0].revision, 1);
      assert.equal(results[0].seenIds.length, 1);
      assert.deepEqual((await ref.get()).data(), results[0]);
    });

    await t.test('initialize existing never overwrites the set, revision or timestamps', async () => {
      await f.seed(['A', 'B', 'C'], 3);
      const before = (await ref.get()).data();
      const result = await a.api.initializeHistoryReadState(['stale-local-A']);
      assert.deepEqual(result, before);
      assert.deepEqual((await ref.get()).data(), before);
      assert(Object.isFrozen(result));
      assert(Object.isFrozen(result.seenIds));
    });

    await t.test('mark on a missing document safely creates one ID at revision 1', async () => {
      await f.clear();
      assert.equal(await a.api.markHistorySeen('created-by-mark'), 1);
      const result = await a.api.getHistoryReadState();
      assert.deepEqual(result.seenIds, ['created-by-mark']);
      assert.equal(result.revision, 1);
      assert.equal(result.updatedByDeviceId, 'deviceA1');
    });

    await t.test('concurrent different IDs on a missing document both survive at revision 2', async () => {
      await f.clear();
      const revisions = await Promise.all([
        a.api.markHistorySeen('first-from-A'), b.api.markHistorySeen('first-from-B')
      ]);
      const result = await a.api.getHistoryReadState();
      assert.deepEqual(new Set(result.seenIds), new Set(['first-from-A', 'first-from-B']));
      assert.equal(result.seenIds.length, 2);
      assert.equal(result.revision, 2);
      assert.deepEqual(revisions.sort((x, y) => x - y), [1, 2]);
    });

    await t.test('one-ID additions preserve the old set and createdAt, and increment revision', async () => {
      await f.seed(['A']);
      const before = await a.api.getHistoryReadState();
      assert.equal(await b.api.markHistorySeen('B'), 2);
      const second = await a.api.getHistoryReadState();
      assert.deepEqual(second.seenIds, ['A', 'B']);
      assert(second.createdAt.isEqual(before.createdAt));
      assert.equal(second.updatedByDeviceId, 'deviceA2');
      assert.equal(await a.api.markHistorySeen('C'), 3);
      assert.deepEqual((await a.api.getHistoryReadState()).seenIds, ['A', 'B', 'C']);
    });

    await t.test('marking an existing ID is a complete no-op, including revision and timestamps', async () => {
      await f.seed(['A', 'B'], 2);
      const before = (await ref.get()).data();
      assert.equal(await b.api.markHistorySeen('A'), 2);
      assert.deepEqual((await ref.get()).data(), before);
    });

    await t.test('concurrent different IDs from two devices survive as a union', async () => {
      await f.seed(['A']);
      const revisions = await Promise.all([a.api.markHistorySeen('B'), b.api.markHistorySeen('C')]);
      const result = await a.api.getHistoryReadState();
      assert.deepEqual(new Set(result.seenIds), new Set(['A', 'B', 'C']));
      assert.equal(result.seenIds.length, 3);
      assert.equal(result.revision, 3);
      assert.deepEqual(revisions.sort((x, y) => x - y), [2, 3]);
    });

    await t.test('concurrent same ID writes once and does not duplicate or increment twice', async () => {
      await f.seed(['A']);
      const revisions = await Promise.all([a.api.markHistorySeen('B'), b.api.markHistorySeen('B')]);
      const result = await a.api.getHistoryReadState();
      assert.deepEqual(result.seenIds, ['A', 'B']);
      assert.deepEqual(revisions, [2, 2]);
      assert.equal(result.revision, 2);
    });

    await t.test('an old device cannot roll a newer cloud set back during initialize or mark', async () => {
      await f.seed(['A']);
      const old = await b.api.getHistoryReadState();
      await a.api.markHistorySeen('B');
      await a.api.markHistorySeen('C');
      const before = await a.api.getHistoryReadState();
      assert.deepEqual(await b.api.initializeHistoryReadState(old.seenIds), before);
      assert.equal(await b.api.markHistorySeen('A'), before.revision);
      assert.deepEqual(await a.api.getHistoryReadState(), before);
      assert.equal(await b.api.markHistorySeen('D'), 4);
      assert.deepEqual((await a.api.getHistoryReadState()).seenIds, ['A', 'B', 'C', 'D']);
    });

    await t.test('the 256th ID succeeds; 257th is HISTORY_READ_LIMIT; existing ID is still no-op', async () => {
      const ids = Array.from({length: 255}, (_, index) => 'history-' + index);
      await f.seed(ids, 255);
      assert.equal(await a.api.markHistorySeen('history-255'), 256);
      const full = (await ref.get()).data();
      assert.equal(full.seenIds.length, 256);
      await assert.rejects(b.api.markHistorySeen('history-256'), {message: 'HISTORY_READ_LIMIT'});
      assert.deepEqual((await ref.get()).data(), full);
      assert.equal(await b.api.markHistorySeen('history-0'), 256);
      assert.deepEqual((await ref.get()).data(), full);
    });

    await t.test('concurrent additions at 255 preserve the first 256 and identify the losing limit error', async () => {
      const ids = Array.from({length: 255}, (_, index) => 'limit-history-' + index);
      await f.seed(ids, 255);
      const before = await a.api.getHistoryReadState();
      const candidates = ['limit-from-A', 'limit-from-B'];
      const results = await Promise.allSettled([
        a.api.markHistorySeen(candidates[0]), b.api.markHistorySeen(candidates[1])
      ]);
      const successes = results.filter(result => result.status === 'fulfilled');
      const failures = results.filter(result => result.status === 'rejected');
      assert.equal(successes.length, 1);
      assert.equal(successes[0].value, 256);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].reason.message, 'HISTORY_READ_LIMIT');
      const winner = results.findIndex(result => result.status === 'fulfilled');
      const full = await a.api.getHistoryReadState();
      assert.equal(full.revision, 256);
      assert.equal(full.seenIds.length, 256);
      assert.deepEqual(new Set(full.seenIds), new Set([...ids, candidates[winner]]));
      assert.equal(full.updatedByDeviceId, winner === 0 ? 'deviceA1' : 'deviceA2');
      assert(full.createdAt.isEqual(before.createdAt));
      assert.equal(await b.api.markHistorySeen(ids[0]), 256);
      await assert.rejects(a.api.markHistorySeen(candidates[1 - winner]), {message: 'HISTORY_READ_LIMIT'});
      assert.deepEqual(await a.api.getHistoryReadState(), full);
    });

    await t.test('invalid mark IDs and invalid initial arrays fail without creating or changing data', async () => {
      await f.clear();
      for (const value of ['', 'x'.repeat(513), null, undefined, 123, true, {}, [], ['A']]) {
        await assert.rejects(a.api.markHistorySeen(value), {message: 'INVALID_SETTINGS'});
      }
      for (const value of [null, undefined, {}, 'A', 1, [null], [1], [''], ['x'.repeat(513)], ['A', 'B'], ['A', 'A']]) {
        await assert.rejects(a.api.initializeHistoryReadState(value), {message: 'INVALID_SETTINGS'});
      }
      assert.equal((await ref.get()).exists, false);
      const result = await a.api.initializeHistoryReadState(['x'.repeat(512)]);
      assert.equal(result.seenIds[0].length, 512);
      const before = (await ref.get()).data();
      await assert.rejects(b.api.markHistorySeen(''), {message: 'INVALID_SETTINGS'});
      assert.deepEqual((await ref.get()).data(), before);
    });

    await t.test('Japanese and emoji IDs accept 512 Unicode characters and reject 513', async () => {
      for (const symbol of ['履', '🦊']) {
        await f.clear();
        const accepted = symbol.repeat(512), rejected = symbol.repeat(513);
        await assert.rejects(a.api.initializeHistoryReadState([rejected]), {message: 'INVALID_SETTINGS'});
        await assert.rejects(b.api.markHistorySeen(rejected), {message: 'INVALID_SETTINGS'});
        assert.equal((await ref.get()).exists, false);
        const initial = await a.api.initializeHistoryReadState([accepted]);
        assert.deepEqual(initial.seenIds, [accepted]);
        assert.equal([...initial.seenIds[0]].length, 512);
        const anotherAccepted = symbol.repeat(511) + 'x';
        assert.equal(await b.api.markHistorySeen(anotherAccepted), 2);
        const before = await a.api.getHistoryReadState();
        assert.deepEqual(before.seenIds, [accepted, anotherAccepted]);
        await assert.rejects(a.api.initializeHistoryReadState([rejected]), {message: 'INVALID_SETTINGS'});
        await assert.rejects(b.api.markHistorySeen(rejected), {message: 'INVALID_SETTINGS'});
        assert.deepEqual(await a.api.getHistoryReadState(), before);
      }
    });

    await t.test('server schema validation fails get/initialize/mark and subscribers stop on corruption', async () => {
      await f.seed(['A']);
      const valid = (await ref.get()).data();
      const missing = {...valid};
      delete missing.seenIds;
      const bad = [
        {...valid, schemaVersion: 2}, {...valid, revision: 0}, {...valid, revision: 1.5},
        {...valid, revision: Number.MAX_SAFE_INTEGER + 1}, {...valid, extra: true}, missing,
        {...valid, seenIds: null}, {...valid, seenIds: {}}, {...valid, seenIds: [1]},
        {...valid, seenIds: ['']}, {...valid, seenIds: ['A', 'A']},
        {...valid, seenIds: ['x'.repeat(513)]},
        {...valid, seenIds: Array.from({length: 257}, (_, index) => String(index))},
        {...valid, createdAt: 'yesterday'}, {...valid, updatedAt: null},
        {...valid, updatedByDeviceId: null}
      ];
      for (const value of bad) {
        await f.admin(db => db.doc(f.path(f.profileA)).set(value));
        await assert.rejects(a.api.getHistoryReadState(), {message: 'INVALID_SETTINGS'});
        await assert.rejects(a.api.initializeHistoryReadState([]), {message: 'INVALID_SETTINGS'});
        await assert.rejects(a.api.markHistorySeen('B'), {message: 'INVALID_SETTINGS'});
      }
      const received = [], errors = [];
      const stop = b.api.subscribeHistoryReadState(value => received.push(value), error => errors.push(error.message));
      cleanup.push(stop);
      await until(() => errors.length);
      assert.deepEqual(received, []);
      assert.deepEqual(errors, ['INVALID_SETTINGS']);
      assert.equal(b.watchers.size, 0);
      assert.equal(b.observed.listenerCount, 0);
      await f.admin(db => db.doc(f.path(f.profileA)).set(valid));
      await pause(100);
      assert.deepEqual(received, []);
    });

    await t.test('remote subscription exposes frozen server data and filters cache/pending snapshots', async () => {
      await f.seed(['A']);
      const received = [], deliveries = [], errors = [];
      const stop = b.api.subscribeHistoryReadState(value => {
        received.push(value);
        deliveries.push({...b.observed.latestHistoryDelivery});
      }, error => errors.push(error.message));
      cleanup.push(stop);
      await until(() => received.length);
      const revision = await a.api.markHistorySeen('B');
      await until(() => received.some(value => value?.revision === revision));
      assert.deepEqual(received.at(-1).seenIds, ['A', 'B']);
      for (const value of received) {
        assert(Object.isFrozen(value));
        assert(Object.isFrozen(value.seenIds));
        assert(value.updatedAt instanceof firebase.firestore.Timestamp);
      }
      for (const delivery of deliveries) {
        assert.equal(delivery.path, f.path(f.profileA));
        assert.equal(delivery.fromCache, false);
        assert.equal(delivery.hasPendingWrites, false);
      }
      assert.deepEqual(errors, []);
      stop(); stop();
      assert.equal(b.watchers.size, 0);
      assert.equal(b.observed.listenerCount, 0);
      const count = received.length;
      await a.api.markHistorySeen('C');
      await pause(100);
      assert.equal(received.length, count);
    });

    await t.test('unsubscribe before asynchronous setup installs no listeners or auth watchers', async () => {
      let callbacks = 0;
      const stop = a.api.subscribeHistoryReadState(() => callbacks++, () => callbacks++);
      stop(); stop();
      await pause(100);
      assert.equal(callbacks, 0);
      assert.equal(a.watchers.size, 0);
      assert.equal(a.observed.listenerCount, 0);
    });

    await t.test('other profile API stays isolated and raw access to owner data is denied', async () => {
      await f.seed(['private-to-profile-A']);
      const other = await client(f, 'B1');
      assert.equal(await other.api.getHistoryReadState(), null);
      await assertFails(f.dbs.B1.doc(f.path(f.profileA)).get());
      await assertFails(f.dbs.B1.doc(f.path(f.profileA)).set(document('deviceB1', ['forged'])));
      await other.api.initializeHistoryReadState(['private-to-profile-B']);
      assert.deepEqual((await other.api.getHistoryReadState()).seenIds, ['private-to-profile-B']);
      assert.deepEqual((await a.api.getHistoryReadState()).seenIds, ['private-to-profile-A']);
    });

    await t.test('missing/inactive identity and missing/inactive device cannot read, initialize or mark', async () => {
      await f.seed(['A']);
      const before = (await ref.get()).data();
      for (const name of ['inactiveIdentity', 'missingIdentity', 'inactiveDevice', 'missingDevice']) {
        const rejected = await client(f, name);
        await assert.rejects(rejected.api.getHistoryReadState());
        await assert.rejects(rejected.api.initializeHistoryReadState([]));
        await assert.rejects(rejected.api.markHistorySeen('forged'));
        assert.equal(rejected.watchers.size, 0);
      }
      assert.deepEqual((await ref.get()).data(), before);
    });

    await t.test('inactive profile cannot read/write and its live subscription stops', async () => {
      await f.seed(['A']);
      const received = [], errors = [];
      const stop = b.api.subscribeHistoryReadState(value => received.push(value), error => errors.push(error.message));
      cleanup.push(stop);
      await until(() => received.length);
      try {
        await f.admin(db => db.doc('memberProfiles/' + f.profileA).update({status: 'inactive'}));
        await until(() => errors.length);
        const count = received.length;
        await assert.rejects(b.api.getHistoryReadState());
        await assert.rejects(b.api.initializeHistoryReadState([]));
        await assert.rejects(b.api.markHistorySeen('forged'));
        assert.equal(b.watchers.size, 0);
        assert.equal(b.observed.listenerCount, 0);
        await pause(100);
        assert.equal(received.length, count);
      } finally {
        await f.admin(db => db.doc('memberProfiles/' + f.profileA).update({status: 'active'}));
      }
    });

    await t.test('device revocation stops subscription without a history document change', async () => {
      await f.seed(['A']);
      const received = [], errors = [];
      const stop = b.api.subscribeHistoryReadState(value => received.push(value), error => errors.push(error.message));
      cleanup.push(stop);
      await until(() => received.length);
      const devicePath = 'memberProfiles/' + f.profileA + '/devices/deviceA2';
      try {
        await f.admin(db => db.doc(devicePath).update({status: 'inactive'}));
        await until(() => errors.length);
        const count = received.length;
        await a.api.markHistorySeen('B');
        await pause(100);
        assert.equal(received.length, count);
        await assert.rejects(b.api.getHistoryReadState());
        await assert.rejects(b.api.markHistorySeen('forged'));
        assert.equal(b.watchers.size, 0);
        assert.equal(b.observed.listenerCount, 0);
      } finally {
        await f.admin(db => db.doc(devicePath).update({status: 'active'}));
      }
    });

    await t.test('identity revocation stops subscription without a history document change', async () => {
      await f.seed(['A']);
      const received = [], errors = [];
      const stop = b.api.subscribeHistoryReadState(value => received.push(value), error => errors.push(error.message));
      cleanup.push(stop);
      await until(() => received.length);
      const identityPath = 'memberIdentities/' + f.identities.A2.uid;
      try {
        await f.admin(db => db.doc(identityPath).update({active: false}));
        await until(() => errors.length);
        const count = received.length;
        await a.api.markHistorySeen('B');
        await pause(100);
        assert.equal(received.length, count);
        await assert.rejects(b.api.getHistoryReadState());
        await assert.rejects(b.api.initializeHistoryReadState([]));
        await assert.rejects(b.api.markHistorySeen('forged'));
        assert.equal(b.watchers.size, 0);
        assert.equal(b.observed.listenerCount, 0);
      } finally {
        await f.admin(db => db.doc(identityPath).update({active: true}));
      }
    });

    await t.test('auth disappearance stops all listeners and future operations require authentication', async () => {
      await f.seed(['A']);
      const received = [], errors = [];
      const stop = a.api.subscribeHistoryReadState(value => received.push(value), error => errors.push(error.message));
      cleanup.push(stop);
      await until(() => received.length);
      a.signOut();
      await until(() => errors.length);
      assert.deepEqual(errors, ['UNAUTHENTICATED']);
      assert.equal(a.watchers.size, 0);
      assert.equal(a.observed.listenerCount, 0);
      const count = received.length;
      await b.api.markHistorySeen('after-signout');
      await pause(100);
      assert.equal(received.length, count);
      await assert.rejects(a.api.getHistoryReadState(), {message: 'UNAUTHENTICATED'});
      await assert.rejects(a.api.initializeHistoryReadState([]), {message: 'UNAUTHENTICATED'});
      await assert.rejects(a.api.markHistorySeen('forged'), {message: 'UNAUTHENTICATED'});
      const guest = await client(f, 'guest');
      await assert.rejects(guest.api.getHistoryReadState(), {message: 'UNAUTHENTICATED'});
      await assert.rejects(guest.api.initializeHistoryReadState([]), {message: 'UNAUTHENTICATED'});
      await assert.rejects(guest.api.markHistorySeen('forged'), {message: 'UNAUTHENTICATED'});
    });
  } finally {
    cleanup.forEach(stop => stop());
    await f.env.cleanup();
  }
});
