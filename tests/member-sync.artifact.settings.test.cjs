/* Real Firestore emulator transactions and membership listeners. Authentication
 * events are controlled locally. No production service or browser is used. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const {initializeTestEnvironment, assertFails} = require('@firebase/rules-unit-testing');
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');
const {createMemberSync} = require('../member-sync');
const {ARTIFACT_CATALOG, createDefaultArtifactProjection} = require('../artifact-catalog');

const stamp = () => firebase.firestore.FieldValue.serverTimestamp();
const clone = value => JSON.parse(JSON.stringify(value));
const defaults = () => createDefaultArtifactProjection();
const selected = ARTIFACT_CATALOG.filter(item => Array.isArray(item.values));
const fixed = ARTIFACT_CATALOG.filter(item => !Array.isArray(item.values));
const X = selected[0].effectId, Y = selected[1].effectId, F = fixed[0].effectId;
const alternate = item => item.values.find(value => value !== defaults().items[item.effectId].selectedValue);
const document = (deviceId = 'deviceA1', projection = defaults(), extra = {}) => ({
  schemaVersion: 1, catalogVersion: 1, resetEpoch: 0, items: clone(projection.items), revision: 1,
  createdAt: stamp(), updatedAt: stamp(), updatedByDeviceId: deviceId, ...extra
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (predicate()) return;
    await pause(25);
  }
  throw Error('Expected artifact subscription state was not received');
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
function observe(promise) {
  // A failure in the other device must still release this held transaction;
  // retain its rejection for the later assertion without an unhandled event.
  promise.catch(() => {});
  return promise;
}

async function fixture() {
  // An explicit loopback destination is required even though the test SDK also
  // receives a host and port; a forgotten environment cannot select production.
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080');
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
  const path = (profileId, mode = 'gw') => 'memberProfiles/' + profileId + '/settings/'
    + ({gw: 'awakeningGw', high: 'awakeningHigh'})[mode];
  const admin = operation => env.withSecurityRulesDisabled(context => operation(context.firestore()));
  const seed = (projection = defaults(), extra = {}, mode = 'gw') => admin(db =>
    db.doc(path(profileA, mode)).set(document('deviceA1', projection, extra)));
  const clear = () => admin(async db => {
    for (const profileId of [profileA, profileB]) {
      for (const mode of ['gw', 'high']) await db.doc(path(profileId, mode)).delete();
    }
  });
  return {env, profileA, profileB, identities, dbs, path, admin, seed, clear};
}

async function client(f, name) {
  const watchers = new Set(), control = {holdRead: null};
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
  const observed = {latestDelivery: null, listenerCount: 0, attempts: 0, writes: 0};
  const realDb = f.dbs[name];
  const db = {
    doc(path) {
      const ref = realDb.doc(path), listen = ref.onSnapshot.bind(ref);
      ref.onSnapshot = (...args) => {
        const callbackIndex = typeof args[0] === 'function' ? 0 : 1;
        const callback = args[callbackIndex];
        args[callbackIndex] = snapshot => {
          if (/\/settings\/awakening(?:Gw|High)$/.test(path)) {
            observed.latestDelivery = {path, fromCache: snapshot.metadata.fromCache,
              hasPendingWrites: snapshot.metadata.hasPendingWrites};
          }
          callback(snapshot);
        };
        observed.listenerCount++;
        let active = true;
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
    runTransaction(callback) {
      return realDb.runTransaction(async real => {
        observed.attempts++;
        const transaction = {
          async get(ref) {
            const snapshot = await real.get(ref);
            if (/\/settings\/awakening(?:Gw|High)$/.test(ref.path) && control.holdRead) {
              const hold = control.holdRead;
              control.holdRead = null;
              await hold(snapshot);
            }
            return snapshot;
          },
          set(...args) { observed.writes++; real.set(...args); return transaction; },
          update(...args) { observed.writes++; real.update(...args); return transaction; },
          delete(...args) { observed.writes++; real.delete(...args); return transaction; }
        };
        return callback(transaction);
      });
    }
  };
  const sdk = {apps: [], auth: {Auth: {Persistence: {LOCAL: 'local'}}}, firestore: firebase.firestore,
    initializeApp: () => ({auth: () => auth, firestore: () => db})};
  const api = createMemberSync(sdk, {});
  await api.restoreAuthentication();
  return {api, watchers, observed, control,
    signOut() { auth.currentUser = null; watchers.forEach(callback => callback(null)); }};
}

// Hold one genuine emulator transaction after its artifact read. A second
// device commits before release, guaranteeing a stale read and a real retry.
function holdNextRead(client) {
  const ready = deferred(), release = deferred();
  client.control.holdRead = async snapshot => { ready.resolve(snapshot); await release.promise; };
  return {ready: ready.promise, release: release.resolve};
}
function frozenState(value) {
  assert(Object.isFrozen(value));
  assert(Object.isFrozen(value.items));
  for (const item of Object.values(value.items)) assert(Object.isFrozen(item));
  assert(value.createdAt instanceof firebase.firestore.Timestamp);
  assert(value.updatedAt instanceof firebase.firestore.Timestamp);
  assert.equal(Object.keys(value.items).length, 63);
}

test('artifact settings: real transactions, reset epochs and isolated subscription lifecycle', async t => {
  const f = await fixture();
  const a = await client(f, 'A1'), b = await client(f, 'A2');
  const ref = mode => f.dbs.A1.doc(f.path(f.profileA, mode));
  const cleanup = [];
  try {
    await t.test('gw and high missing reads and subscriptions return null', async () => {
      await f.clear();
      for (const mode of ['gw', 'high']) {
        assert.equal(await a.api.getArtifactSettings(mode), null);
        const received = [], errors = [];
        const stop = a.api.subscribeArtifactSettings(mode, value => received.push(value), error => errors.push(error.message));
        cleanup.push(stop);
        await until(() => received.length);
        stop();
        assert.deepEqual(received, [null]);
        assert.deepEqual(errors, []);
        assert.equal(a.watchers.size, 0);
        assert.equal(a.observed.listenerCount, 0);
      }
    });

    for (const mode of ['gw', 'high']) {
      await t.test(mode + ' initialization creates complete frozen server-confirmed epoch 0 revision 1', async () => {
        await f.clear();
        const projection = defaults();
        projection.items[X].needed = true;
        projection.items[X].selectedValue = alternate(selected[0]);
        const result = await a.api.initializeArtifactSettings(mode, projection);
        assert.deepEqual(result.items, projection.items);
        assert.equal(result.catalogVersion, 1);
        assert.equal(result.schemaVersion, 1);
        assert.equal(result.resetEpoch, 0);
        assert.equal(result.revision, 1);
        assert.equal(result.updatedByDeviceId, 'deviceA1');
        frozenState(result);
        assert.deepEqual((await ref(mode).get()).data(), result);
        assert.deepEqual(await a.api.getArtifactSettings(mode), result);
      });
    }

    await t.test('gw and high updates and resets remain isolated', async () => {
      await f.clear();
      await a.api.initializeArtifactSettings('gw', defaults());
      await b.api.initializeArtifactSettings('high', defaults());
      await a.api.updateArtifactSetting('gw', X, {needed: true});
      await b.api.updateArtifactSetting('high', Y, {needed: true});
      assert.equal((await a.api.getArtifactSettings('gw')).items[Y].needed, false);
      const high = await a.api.getArtifactSettings('high');
      assert.equal(high.items[X].needed, false);
      assert.equal(high.items[Y].needed, true);
      await a.api.resetArtifactSettings('gw');
      assert.deepEqual(await a.api.getArtifactSettings('high'), high);
    });

    await t.test('existing initialize does not overwrite any item or metadata', async () => {
      await f.seed();
      await a.api.updateArtifactSetting('gw', Y, {needed: true});
      const before = await a.api.getArtifactSettings('gw');
      const stale = defaults(); stale.items[X].needed = true;
      const writes = b.observed.writes;
      assert.deepEqual(await b.api.initializeArtifactSettings('gw', stale), before);
      assert.deepEqual(await a.api.getArtifactSettings('gw'), before);
      assert.equal(b.observed.writes, writes);
    });

    await t.test('concurrent initialize retries a missing read and adopts the winner at revision 1', async () => {
      await f.clear();
      const hold = holdNextRead(b), attempts = b.observed.attempts;
      const stale = defaults(); stale.items[Y].needed = true;
      const pending = observe(b.api.initializeArtifactSettings('gw', stale));
      await Promise.race([hold.ready, pending]);
      let winner;
      try {
        const projection = defaults(); projection.items[X].needed = true;
        winner = await a.api.initializeArtifactSettings('gw', projection);
      } finally { hold.release(); }
      assert.deepEqual(await pending, winner);
      assert.equal(winner.revision, 1);
      assert.equal(winner.items[X].needed, true);
      assert.equal(winner.items[Y].needed, false);
      assert(b.observed.attempts - attempts >= 2, 'losing initialize must retry its stale read');
    });

    await t.test('needed true and false, selected enum and fixed needed updates preserve all other items', async () => {
      await f.seed();
      const before = await a.api.getArtifactSettings('gw');
      assert.equal(await a.api.updateArtifactSetting('gw', X, {needed: true}), 2);
      assert.equal(await b.api.updateArtifactSetting('gw', X, {selectedValue: alternate(selected[0])}), 3);
      assert.equal(await a.api.updateArtifactSetting('gw', X, {needed: false}), 4);
      assert.equal(await b.api.updateArtifactSetting('gw', F, {needed: true}), 5);
      const after = await a.api.getArtifactSettings('gw');
      assert.equal(after.items[X].needed, false);
      assert.equal(after.items[X].selectedValue, alternate(selected[0]));
      assert.deepEqual(after.items[F], {needed: true});
      for (const id of Object.keys(before.items)) {
        if (id !== X && id !== F) assert.deepEqual(after.items[id], before.items[id]);
      }
      assert(after.createdAt.isEqual(before.createdAt));
      assert.equal(after.resetEpoch, 0);
      assert.equal(after.updatedByDeviceId, 'deviceA2');
    });

    await t.test('same-value update performs a transaction but zero writes and changes no metadata', async () => {
      await f.seed();
      const before = await a.api.getArtifactSettings('gw');
      const attempts = b.observed.attempts, writes = b.observed.writes;
      assert.equal(await b.api.updateArtifactSetting('gw', X, {needed: false}), 1);
      assert.equal(await b.api.updateArtifactSetting('gw', X, {selectedValue: before.items[X].selectedValue}), 1);
      assert.equal(b.observed.attempts - attempts, 2);
      assert.equal(b.observed.writes, writes);
      assert.deepEqual(await a.api.getArtifactSettings('gw'), before);
    });

    await t.test('different effects merge after a forced real transaction retry', async () => {
      await f.seed();
      const hold = holdNextRead(b), attempts = b.observed.attempts;
      const pending = observe(b.api.updateArtifactSetting('gw', Y, {needed: true}));
      await Promise.race([hold.ready, pending]);
      try { assert.equal(await a.api.updateArtifactSetting('gw', X, {needed: true}), 2); }
      finally { hold.release(); }
      assert.equal(await pending, 3);
      const result = await a.api.getArtifactSettings('gw');
      assert.equal(result.items[X].needed, true);
      assert.equal(result.items[Y].needed, true);
      assert.equal(result.revision, 3);
      assert.equal(result.updatedByDeviceId, 'deviceA2');
      assert(b.observed.attempts - attempts >= 2, 'different effects must retry the stale read');
    });

    await t.test('same effect and field takes the last successful commit after conflict', async () => {
      await f.seed();
      const values = selected[0].values.filter(value => value !== defaults().items[X].selectedValue);
      const hold = holdNextRead(b), attempts = b.observed.attempts;
      const pending = observe(b.api.updateArtifactSetting('gw', X, {selectedValue: values[1]}));
      await Promise.race([hold.ready, pending]);
      try { assert.equal(await a.api.updateArtifactSetting('gw', X, {selectedValue: values[0]}), 2); }
      finally { hold.release(); }
      assert.equal(await pending, 3);
      const result = await a.api.getArtifactSettings('gw');
      assert.equal(result.items[X].selectedValue, values[1]);
      assert.equal(result.revision, 3);
      assert(b.observed.attempts - attempts >= 2);
    });

    await t.test('same effect with distinct needed and selectedValue fields retains both changes', async () => {
      await f.seed();
      const hold = holdNextRead(b), attempts = b.observed.attempts;
      const pending = observe(b.api.updateArtifactSetting('gw', X, {selectedValue: alternate(selected[0])}));
      await Promise.race([hold.ready, pending]);
      try { await a.api.updateArtifactSetting('gw', X, {needed: true}); }
      finally { hold.release(); }
      assert.equal(await pending, 3);
      const result = await a.api.getArtifactSettings('gw');
      assert.deepEqual(result.items[X], {needed: true, selectedValue: alternate(selected[0])});
      assert(b.observed.attempts - attempts >= 2);
    });

    await t.test('reset restores catalog defaults while preserving createdAt and increasing epoch/revision', async () => {
      const projection = defaults(); projection.items[X].needed = true;
      projection.items[X].selectedValue = alternate(selected[0]); projection.items[F].needed = true;
      await f.seed(projection, {resetEpoch: 4, revision: 9});
      const before = await a.api.getArtifactSettings('gw');
      assert.equal(await b.api.resetArtifactSettings('gw'), 10);
      const result = await a.api.getArtifactSettings('gw');
      assert.deepEqual(result.items, defaults().items);
      assert.equal(result.resetEpoch, 5);
      assert.equal(result.revision, 10);
      assert.equal(result.updatedByDeviceId, 'deviceA2');
      assert(result.createdAt.isEqual(before.createdAt));
    });

    await t.test('an explicit reset at default still increments resetEpoch and revision', async () => {
      await f.seed();
      assert.equal(await a.api.resetArtifactSettings('gw'), 2);
      assert.equal(await b.api.resetArtifactSettings('gw'), 3);
      const result = await a.api.getArtifactSettings('gw');
      assert.deepEqual(result.items, defaults().items);
      assert.equal(result.resetEpoch, 2);
      assert.equal(result.revision, 3);
    });

    await t.test('a stale pre-reset field transaction retries without restoring other old items', async () => {
      const old = defaults(); old.items[Y].needed = true; old.items[F].needed = true;
      await f.seed(old);
      const hold = holdNextRead(b), attempts = b.observed.attempts;
      const pending = observe(b.api.updateArtifactSetting('gw', X, {needed: true}));
      const stale = await Promise.race([hold.ready, pending]);
      assert.equal(stale.data().items[Y].needed, true);
      try { assert.equal(await a.api.resetArtifactSettings('gw'), 2); }
      finally { hold.release(); }
      assert.equal(await pending, 3);
      const result = await a.api.getArtifactSettings('gw');
      const expected = defaults(); expected.items[X].needed = true;
      assert.deepEqual(result.items, expected.items);
      assert.equal(result.resetEpoch, 1);
      assert.equal(result.revision, 3);
      assert(b.observed.attempts - attempts >= 2, 'the pre-reset snapshot must be retried');
    });

    await t.test('a reset that read before another field commit retries and removes the new field', async () => {
      await f.seed();
      const hold = holdNextRead(b), attempts = b.observed.attempts;
      const pending = observe(b.api.resetArtifactSettings('gw'));
      await Promise.race([hold.ready, pending]);
      try { assert.equal(await a.api.updateArtifactSetting('gw', X, {needed: true}), 2); }
      finally { hold.release(); }
      assert.equal(await pending, 3);
      const result = await a.api.getArtifactSettings('gw');
      assert.deepEqual(result.items, defaults().items);
      assert.equal(result.resetEpoch, 1);
      assert(b.observed.attempts - attempts >= 2);
    });

    await t.test('two concurrent resets both commit once and advance resetEpoch twice', async () => {
      await f.seed();
      const hold = holdNextRead(b), attempts = b.observed.attempts;
      const pending = observe(b.api.resetArtifactSettings('gw'));
      await Promise.race([hold.ready, pending]);
      try { assert.equal(await a.api.resetArtifactSettings('gw'), 2); }
      finally { hold.release(); }
      assert.equal(await pending, 3);
      const result = await a.api.getArtifactSettings('gw');
      assert.equal(result.resetEpoch, 2);
      assert.equal(result.revision, 3);
      assert.deepEqual(result.items, defaults().items);
      assert(b.observed.attempts - attempts >= 2);
    });

    await t.test('updates and resets never create a missing document', async () => {
      await f.clear();
      for (const mode of ['gw', 'high']) {
        await assert.rejects(a.api.updateArtifactSetting(mode, X, {needed: true}), {message: 'SETTINGS_NOT_INITIALIZED'});
        await assert.rejects(a.api.resetArtifactSettings(mode), {message: 'SETTINGS_NOT_INITIALIZED'});
        assert.equal((await ref(mode).get()).exists, false);
      }
    });

    await t.test('invalid modes and injected paths cannot address arbitrary settings', async () => {
      await f.seed();
      const before = await a.api.getArtifactSettings('gw');
      for (const mode of ['', null, undefined, 'GW', 'artifact', 'settings/awakeningGw', '../../speedCalculator', {}, 1]) {
        await assert.rejects(a.api.getArtifactSettings(mode), {message: 'INVALID_SETTINGS'});
        await assert.rejects(a.api.initializeArtifactSettings(mode, defaults()), {message: 'INVALID_SETTINGS'});
        await assert.rejects(a.api.updateArtifactSetting(mode, X, {needed: true}), {message: 'INVALID_SETTINGS'});
        await assert.rejects(a.api.resetArtifactSettings(mode), {message: 'INVALID_SETTINGS'});
      }
      assert.deepEqual(await a.api.getArtifactSettings('gw'), before);
    });

    await t.test('invalid projections and patches do not write or accept fixed selectedValue', async () => {
      await f.seed();
      const before = await a.api.getArtifactSettings('gw');
      const unknown = defaults(); unknown.items.unknown_effect = {needed: false};
      const missing = defaults(); delete missing.items[X];
      const badNeeded = defaults(); badNeeded.items[X].needed = 'true';
      const badSelected = defaults(); badSelected.items[X].selectedValue = 'not-in-catalog';
      const fixedSelected = defaults(); fixedSelected.items[F].selectedValue = 'fixed';
      for (const value of [null, {}, {catalogVersion: 2, items: defaults().items}, unknown, missing, badNeeded, badSelected, fixedSelected]) {
        await assert.rejects(a.api.initializeArtifactSettings('gw', value), {message: 'INVALID_SETTINGS'});
      }
      for (const [id, patch] of [
        ['unknown_effect', {needed: true}], [X, {needed: 'true'}], [X, {needed: 1}], [X, {needed: null}],
        [X, {selectedValue: 'not-in-catalog'}], [X, {selectedValue: 1800}], [F, {selectedValue: 'fixed'}],
        [X, {}], [X, {needed: true, selectedValue: alternate(selected[0])}], [X, {memo: 'local-only'}]
      ]) await assert.rejects(a.api.updateArtifactSetting('gw', id, patch), {message: 'INVALID_SETTINGS'});
      assert.deepEqual(await a.api.getArtifactSettings('gw'), before);
    });

    await t.test('invalid remote schemas reject get initialize update and reset', async () => {
      await f.seed();
      const valid = (await ref('gw').get()).data();
      const missing = {...valid}; delete missing.items;
      const unknown = clone(valid.items); unknown.unknown_effect = {needed: false};
      const sparse = clone(valid.items); delete sparse[X];
      const malformed = clone(valid.items); malformed[X].selectedValue = 'not-in-catalog';
      const bad = [
        {...valid, schemaVersion: 2}, {...valid, catalogVersion: 2}, {...valid, resetEpoch: -1},
        {...valid, resetEpoch: 0.5}, {...valid, resetEpoch: Number.MAX_SAFE_INTEGER + 1},
        {...valid, revision: 0}, {...valid, revision: 1.5}, {...valid, revision: Number.MAX_SAFE_INTEGER + 1},
        {...valid, extra: true}, missing, {...valid, items: unknown}, {...valid, items: sparse},
        {...valid, items: malformed}, {...valid, createdAt: 'yesterday'}, {...valid, updatedAt: null},
        {...valid, updatedByDeviceId: 'invalid/device'}
      ];
      for (const value of bad) {
        await f.admin(db => db.doc(f.path(f.profileA)).set(value));
        await assert.rejects(a.api.getArtifactSettings('gw'), {message: 'INVALID_SETTINGS'});
        await assert.rejects(a.api.initializeArtifactSettings('gw', defaults()), {message: 'INVALID_SETTINGS'});
        await assert.rejects(a.api.updateArtifactSetting('gw', X, {needed: true}), {message: 'INVALID_SETTINGS'});
        await assert.rejects(a.api.resetArtifactSettings('gw'), {message: 'INVALID_SETTINGS'});
      }
      await f.admin(db => db.doc(f.path(f.profileA)).set(valid));
    });

    await t.test('unsafe revision and resetEpoch increments are rejected without writes', async () => {
      await f.seed(defaults(), {revision: Number.MAX_SAFE_INTEGER});
      const before = await a.api.getArtifactSettings('gw');
      assert.equal(await a.api.updateArtifactSetting('gw', X, {needed: false}), Number.MAX_SAFE_INTEGER);
      await assert.rejects(a.api.updateArtifactSetting('gw', X, {needed: true}), {message: 'INVALID_SETTINGS'});
      await assert.rejects(a.api.resetArtifactSettings('gw'), {message: 'INVALID_SETTINGS'});
      assert.deepEqual(await a.api.getArtifactSettings('gw'), before);
      await f.seed(defaults(), {resetEpoch: Number.MAX_SAFE_INTEGER});
      const epochLimit = await a.api.getArtifactSettings('gw');
      await assert.rejects(a.api.resetArtifactSettings('gw'), {message: 'INVALID_SETTINGS'});
      assert.deepEqual(await a.api.getArtifactSettings('gw'), epochLimit);
    });

    for (const mode of ['gw', 'high']) {
      await t.test(mode + ' subscription delivers frozen confirmed snapshots and stops after unsubscribe', async () => {
        await f.seed(defaults(), {}, mode);
        const received = [], deliveries = [], errors = [];
        const stop = b.api.subscribeArtifactSettings(mode, value => {
          received.push(value); deliveries.push({...b.observed.latestDelivery});
        }, error => errors.push(error.message));
        cleanup.push(stop);
        await until(() => received.length);
        const revision = await a.api.updateArtifactSetting(mode, X, {needed: true});
        await until(() => received.some(value => value?.revision === revision));
        assert.equal(received.at(-1).items[X].needed, true);
        for (const value of received) frozenState(value);
        for (const delivery of deliveries) {
          assert.equal(delivery.path, f.path(f.profileA, mode));
          assert.equal(delivery.fromCache, false);
          assert.equal(delivery.hasPendingWrites, false);
        }
        assert.deepEqual(errors, []);
        stop(); stop();
        assert.equal(b.watchers.size, 0);
        assert.equal(b.observed.listenerCount, 0);
        const count = received.length;
        await a.api.resetArtifactSettings(mode);
        await pause(100);
        assert.equal(received.length, count);
      });
    }

    await t.test('unsubscribe before asynchronous setup creates no auth or document listener', async () => {
      let callbacks = 0;
      const stop = a.api.subscribeArtifactSettings('gw', () => callbacks++, () => callbacks++);
      stop(); stop();
      await pause(100);
      assert.equal(callbacks, 0);
      assert.equal(a.watchers.size, 0);
      assert.equal(a.observed.listenerCount, 0);
    });

    await t.test('invalid remote subscription fails once and never resumes after repair', async () => {
      await f.seed();
      await f.admin(db => db.doc(f.path(f.profileA)).update({catalogVersion: 2}));
      const received = [], errors = [];
      const stop = b.api.subscribeArtifactSettings('gw', value => received.push(value), error => errors.push(error.message));
      cleanup.push(stop);
      await until(() => errors.length);
      assert.deepEqual(errors, ['INVALID_SETTINGS']);
      assert.deepEqual(received, []);
      assert.equal(b.watchers.size, 0);
      assert.equal(b.observed.listenerCount, 0);
      await f.seed();
      await pause(100);
      assert.deepEqual(received, []);
      assert.deepEqual(errors, ['INVALID_SETTINGS']);
    });

    await t.test('other profiles remain isolated and raw access to owner documents is denied', async () => {
      await f.clear();
      await a.api.initializeArtifactSettings('gw', defaults());
      await a.api.updateArtifactSetting('gw', X, {needed: true});
      const other = await client(f, 'B1');
      assert.equal(await other.api.getArtifactSettings('gw'), null);
      await assertFails(f.dbs.B1.doc(f.path(f.profileA)).get());
      await assertFails(f.dbs.B1.doc(f.path(f.profileA)).set(document('deviceB1')));
      await other.api.initializeArtifactSettings('gw', defaults());
      await other.api.updateArtifactSetting('gw', Y, {needed: true});
      assert.equal((await a.api.getArtifactSettings('gw')).items[Y].needed, false);
      assert.equal((await other.api.getArtifactSettings('gw')).items[X].needed, false);
    });

    await t.test('missing or inactive identities/devices cannot read initialize update or reset', async () => {
      await f.seed();
      const before = await a.api.getArtifactSettings('gw');
      for (const name of ['inactiveIdentity', 'missingIdentity', 'inactiveDevice', 'missingDevice']) {
        const denied = await client(f, name);
        await assert.rejects(denied.api.getArtifactSettings('gw'));
        await assert.rejects(denied.api.initializeArtifactSettings('gw', defaults()));
        await assert.rejects(denied.api.updateArtifactSetting('gw', X, {needed: true}));
        await assert.rejects(denied.api.resetArtifactSettings('gw'));
        assert.equal(denied.watchers.size, 0);
      }
      assert.deepEqual(await a.api.getArtifactSettings('gw'), before);
    });

    for (const kind of ['profile', 'identity', 'device']) {
      await t.test(kind + ' revocation stops a live subscription without an artifact write', async () => {
        await f.seed();
        const received = [], errors = [];
        const stop = b.api.subscribeArtifactSettings('gw', value => received.push(value), error => errors.push(error.message));
        cleanup.push(stop);
        await until(() => received.length);
        const path = kind === 'profile' ? 'memberProfiles/' + f.profileA
          : kind === 'identity' ? 'memberIdentities/' + f.identities.A2.uid
            : 'memberProfiles/' + f.profileA + '/devices/deviceA2';
        const revoked = kind === 'identity' ? {active: false} : {status: 'inactive'};
        const restored = kind === 'identity' ? {active: true} : {status: 'active'};
        try {
          await f.admin(db => db.doc(path).update(revoked));
          await until(() => errors.length);
          const count = received.length;
          await assert.rejects(b.api.getArtifactSettings('gw'));
          await assert.rejects(b.api.initializeArtifactSettings('gw', defaults()));
          await assert.rejects(b.api.updateArtifactSetting('gw', X, {needed: true}));
          await assert.rejects(b.api.resetArtifactSettings('gw'));
          assert.equal(b.watchers.size, 0);
          assert.equal(b.observed.listenerCount, 0);
          await pause(100);
          assert.equal(received.length, count);
          assert.equal(errors.length, 1);
        } finally { await f.admin(db => db.doc(path).update(restored)); }
      });
    }

    await t.test('identity profile switching during a transaction cannot write either profile', async () => {
      await f.clear(); await f.seed();
      const before = await a.api.getArtifactSettings('gw');
      const hold = holdNextRead(b);
      const pending = observe(b.api.updateArtifactSetting('gw', X, {needed: true}));
      const caught = pending.then(() => null, error => error);
      await Promise.race([hold.ready, pending]);
      const identityPath = 'memberIdentities/' + f.identities.A2.uid;
      try {
        await f.admin(db => db.doc(identityPath).update({profileId: f.profileB, deviceId: 'deviceB1'}));
        hold.release();
        assert(await caught, 'the old identity operation must reject');
        assert.deepEqual(await a.api.getArtifactSettings('gw'), before);
        assert.equal((await f.dbs.B1.doc(f.path(f.profileB)).get()).exists, false);
      } finally {
        hold.release();
        await f.admin(db => db.doc(identityPath).update({profileId: f.profileA, deviceId: 'deviceA2'}));
      }
    });

    await t.test('auth disappearance stops listeners and future APIs require authentication', async () => {
      await f.seed();
      const received = [], errors = [];
      const stop = a.api.subscribeArtifactSettings('gw', value => received.push(value), error => errors.push(error.message));
      cleanup.push(stop);
      await until(() => received.length);
      a.signOut();
      await until(() => errors.length);
      assert.deepEqual(errors, ['UNAUTHENTICATED']);
      assert.equal(a.watchers.size, 0);
      assert.equal(a.observed.listenerCount, 0);
      const count = received.length;
      await b.api.updateArtifactSetting('gw', X, {needed: true});
      await pause(100);
      assert.equal(received.length, count);
      const guest = await client(f, 'guest');
      for (const denied of [a, guest]) {
        await assert.rejects(denied.api.getArtifactSettings('gw'), {message: 'UNAUTHENTICATED'});
        await assert.rejects(denied.api.initializeArtifactSettings('gw', defaults()), {message: 'UNAUTHENTICATED'});
        await assert.rejects(denied.api.updateArtifactSetting('gw', X, {needed: true}), {message: 'UNAUTHENTICATED'});
        await assert.rejects(denied.api.resetArtifactSettings('gw'), {message: 'UNAUTHENTICATED'});
      }
    });
  } finally {
    cleanup.forEach(stop => stop());
    await f.env.cleanup();
  }
});
