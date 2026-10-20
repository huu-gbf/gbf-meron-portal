const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createMemberSync} = require('../member-sync');
const {ARTIFACT_CATALOG, createDefaultArtifactProjection} = require('../artifact-catalog');

const effect = ARTIFACT_CATALOG[0].effectId;
const paths = {identity: 'memberIdentities/memberA', profile: 'memberProfiles/profileA',
  device: 'memberProfiles/profileA/devices/deviceA',
  gw: 'memberProfiles/profileA/settings/awakeningGw', high: 'memberProfiles/profileA/settings/awakeningHigh'};
class Timestamp { constructor(seconds, nanoseconds = 0) { this.seconds = seconds; this.nanoseconds = nanoseconds; } }
const settings = (epoch = 0, revision = 1) => ({schemaVersion: 1, catalogVersion: 1, resetEpoch: epoch,
  items: createDefaultArtifactProjection().items, revision, createdAt: new Timestamp(100),
  updatedAt: new Timestamp(100), updatedByDeviceId: 'deviceA'});
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

function fixture(gw = settings(), high = settings(4)) {
  const records = new Map([[paths.identity, {active: true, profileId: 'profileA', deviceId: 'deviceA'}],
    [paths.profile, {status: 'active'}], [paths.device, {status: 'active'}]]);
  if (gw !== null) records.set(paths.gw, gw);
  if (high !== null) records.set(paths.high, high);
  const reads = [], writes = [], listeners = new Map(), authListeners = new Set();
  let transactions = 0, tick = 100, beforeTransaction, beforeCommit, afterCommit;
  const snapshot = path => ({exists: records.has(path), data: () => records.get(path),
    metadata: {fromCache: false, hasPendingWrites: false}});
  const auth = {currentUser: {uid: 'memberA', isAnonymous: true}, setPersistence: async () => {},
    onAuthStateChanged(callback) {
      authListeners.add(callback); queueMicrotask(() => { if (authListeners.has(callback)) callback(auth.currentUser); });
      return () => authListeners.delete(callback);
    }};
  const db = {
    doc(path) { return {path,
      async get(options) { assert.deepEqual(options, {source: 'server'}); reads.push(path); return snapshot(path); },
      onSnapshot(options, callback) {
        assert.deepEqual(options, {includeMetadataChanges: true});
        if (!listeners.has(path)) listeners.set(path, new Set());
        const set = listeners.get(path); set.add(callback);
        queueMicrotask(() => { if (set.has(callback)) callback(snapshot(path)); });
        return () => set.delete(callback);
      }}; },
    async runTransaction(operation) {
      transactions++; if (beforeTransaction) await beforeTransaction();
      const staged = [];
      const result = await operation({
        async get(ref) { reads.push('transaction:' + ref.path); return snapshot(ref.path); },
        set(ref, data) { staged.push(['set', ref.path, data]); },
        update(ref, data) { staged.push(['update', ref.path, data]); }
      });
      if (beforeCommit) await beforeCommit(staged, transactions);
      for (const [kind, path, data] of staged) {
        const old = records.get(path), next = kind === 'set' ? {} : {...old};
        for (const [key, value] of Object.entries(data)) {
          if (key.startsWith('items.')) {
            const [, id, field] = key.split('.');
            next.items = {...next.items, [id]: {...next.items[id], [field]: value}};
          } else next[key] = value?.stamp ? new Timestamp(++tick) : value?.increment ? old[key] + value.increment : value;
        }
        records.set(path, next); writes.push({kind, path, data});
      }
      if (afterCommit) await afterCommit(staged);
      return result;
    }
  };
  const sdk = {apps: [], auth: {Auth: {Persistence: {LOCAL: 'local'}}},
    firestore: {Timestamp, FieldValue: {serverTimestamp: () => ({stamp: true}), increment: value => ({increment: value})}},
    initializeApp: () => ({auth: () => auth, firestore: () => db})};
  const api = createMemberSync(sdk, {});
  return {api, records, reads, writes, listeners, restore: () => api.restoreAuthentication(),
    transactions: () => transactions, beforeTransaction: callback => { beforeTransaction = callback; },
    beforeCommit: callback => { beforeCommit = callback; }, afterCommit: callback => { afterCommit = callback; },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, authListeners.size)};
}

test('guarded get and initialize preserve the existing full-state API', async () => {
  const f = fixture(null); await f.restore(); const guard = {expectedProfileId: 'profileA'};
  assert.equal(await f.api.getArtifactSettings('gw', guard), null);
  const result = await f.api.initializeArtifactSettings('gw', createDefaultArtifactProjection(), guard);
  assert.equal(result.resetEpoch, 0); assert.equal(result.revision, 1); assert(Object.isFrozen(result));
  assert.deepEqual(await f.api.getArtifactSettings('gw', guard), result);
});

test('all Artifact APIs reject another expected profile without reading its settings or writing', async () => {
  const f = fixture(); await f.restore(); const guard = {expectedProfileId: 'profileB'};
  for (const operation of [() => f.api.getArtifactSettings('gw', guard),
    () => f.api.initializeArtifactSettings('gw', createDefaultArtifactProjection(), guard),
    () => f.api.updateArtifactSetting('gw', effect, {needed: true}, guard),
    () => f.api.resetArtifactSettings('gw', guard)]) await assert.rejects(operation(), /MEMBERSHIP_REQUIRED/);
  const errors = [], received = [];
  f.api.subscribeArtifactSettings('gw', state => received.push(state), error => errors.push(error.message), guard);
  await settle(); assert.deepEqual(errors, ['MEMBERSHIP_REQUIRED']); assert.deepEqual(received, []);
  assert.equal(f.writes.length, 0); assert.equal(f.listenerCount(), 0);
  assert(!f.reads.some(path => path.includes('/settings/')));
});

test('profile guard primitives are captured before asynchronous identity restoration', async () => {
  const f = fixture(); await f.restore(); const guard = {expectedProfileId: 'profileA'};
  const pending = f.api.getArtifactSettings('gw', guard); guard.expectedProfileId = 'profileB';
  assert.equal((await pending).revision, 1);
});

test('guard input is strictly limited to each API and validated before network access', async () => {
  const f = fixture();
  const invalidCommon = [null, [], 'profileA', 1, {unknown: true}, {expectedProfileId: undefined},
    {expectedProfileId: ''}, {expectedProfileId: 'profile/A'}, {[Symbol('unknown')]: true}];
  for (const guard of invalidCommon) {
    await assert.rejects(f.api.getArtifactSettings('gw', guard), /INVALID_SETTINGS/);
    await assert.rejects(f.api.initializeArtifactSettings('gw', createDefaultArtifactProjection(), guard), /INVALID_SETTINGS/);
    await assert.rejects(f.api.updateArtifactSetting('gw', effect, {needed: true}, guard), /INVALID_SETTINGS/);
    await assert.rejects(f.api.resetArtifactSettings('gw', guard), /INVALID_SETTINGS/);
    assert.throws(() => f.api.subscribeArtifactSettings('gw', () => {}, () => {}, guard), /INVALID_SETTINGS/);
  }
  for (const guard of [{expectedResetEpoch: 0}, {returnState: true}, {path: paths.gw}]) {
    await assert.rejects(f.api.getArtifactSettings('gw', guard), /INVALID_SETTINGS/);
    await assert.rejects(f.api.initializeArtifactSettings('gw', createDefaultArtifactProjection(), guard), /INVALID_SETTINGS/);
    assert.throws(() => f.api.subscribeArtifactSettings('gw', () => {}, () => {}, guard), /INVALID_SETTINGS/);
  }
  await assert.rejects(f.api.updateArtifactSetting('gw', effect, {needed: true}, {returnState: true}), /INVALID_SETTINGS/);
  await assert.rejects(f.api.resetArtifactSettings('gw', {expectedResetEpoch: 0}), /INVALID_SETTINGS/);
  for (const value of [undefined, null, -1, 0.5, '0', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.api.updateArtifactSetting('gw', effect, {needed: true}, {expectedResetEpoch: value}), /INVALID_SETTINGS/);
  }
  for (const value of [undefined, null, 1, 'true']) {
    await assert.rejects(f.api.resetArtifactSettings('gw', {returnState: value}), /INVALID_SETTINGS/);
  }
  assert.equal(f.reads.length, 0); assert.equal(f.transactions(), 0);
});

test('matching epoch writes only the requested field and keeps numeric revision return', async () => {
  const f = fixture(); await f.restore();
  assert.equal(await f.api.updateArtifactSetting('gw', effect, {needed: true},
    {expectedProfileId: 'profileA', expectedResetEpoch: 0}), 2);
  assert.equal(f.records.get(paths.gw).items[effect].needed, true);
  assert.equal(f.records.get(paths.gw).resetEpoch, 0); assert.equal(f.writes.length, 1);
});

test('stale and future epochs reject before writes, timestamps or revisions change', async () => {
  const f = fixture(settings(3, 5)); await f.restore(); const before = f.records.get(paths.gw);
  for (const expectedResetEpoch of [0, 2, 4, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(f.api.updateArtifactSetting('gw', effect, {needed: true}, {expectedResetEpoch}),
      /ARTIFACT_RESET_EPOCH_MISMATCH/);
  }
  assert.equal(f.records.get(paths.gw), before); assert.equal(f.writes.length, 0);
});

test('epoch mismatch is rejected even when the requested value is already a no-op', async () => {
  const f = fixture(settings(3, Number.MAX_SAFE_INTEGER)); await f.restore();
  await assert.rejects(f.api.updateArtifactSetting('gw', effect, {needed: false}, {expectedResetEpoch: 2}),
    /ARTIFACT_RESET_EPOCH_MISMATCH/);
  assert.equal(await f.api.updateArtifactSetting('gw', effect, {needed: false}, {expectedResetEpoch: 3}), Number.MAX_SAFE_INTEGER);
  assert.equal(f.writes.length, 0);
});

test('epoch is rechecked on transaction retry after a concurrent remote reset', async () => {
  const f = fixture(); await f.restore(); const error = Object.assign(Error('concurrent reset'), {code: 'permission-denied'});
  f.beforeCommit((staged, attempt) => {
    if (attempt !== 1) return;
    f.records.set(paths.gw, settings(1, 2)); throw error;
  });
  await assert.rejects(f.api.updateArtifactSetting('gw', effect, {needed: true},
    {expectedProfileId: 'profileA', expectedResetEpoch: 0}), /ARTIFACT_RESET_EPOCH_MISMATCH/);
  assert.equal(f.transactions(), 2); assert.equal(f.writes.length, 0);
  assert.equal(f.records.get(paths.gw).resetEpoch, 1); assert.equal(f.records.get(paths.gw).items[effect].needed, false);
});

test('mode epochs are independent and never redirect a pending field to another document', async () => {
  const f = fixture(); await f.restore();
  await f.api.updateArtifactSetting('gw', effect, {needed: true}, {expectedResetEpoch: 0});
  await assert.rejects(f.api.updateArtifactSetting('high', effect, {needed: true}, {expectedResetEpoch: 0}),
    /ARTIFACT_RESET_EPOCH_MISMATCH/);
  await f.api.updateArtifactSetting('high', effect, {needed: true}, {expectedResetEpoch: 4});
  assert.deepEqual(f.writes.map(write => write.path), [paths.gw, paths.high]);
});

test('guarded transaction refuses membership changes after context without writing another profile', async () => {
  const f = fixture(); await f.restore();
  f.records.set('memberProfiles/profileB', {status: 'active'});
  f.records.set('memberProfiles/profileB/devices/deviceA', {status: 'active'});
  f.beforeTransaction(() => f.records.set(paths.identity, {active: true, profileId: 'profileB', deviceId: 'deviceA'}));
  await assert.rejects(f.api.updateArtifactSetting('gw', effect, {needed: true},
    {expectedProfileId: 'profileA', expectedResetEpoch: 0}), /MEMBERSHIP_REQUIRED/);
  assert.equal(f.writes.length, 0);
  assert(!f.reads.some(path => path.includes('memberProfiles/profileB/settings/')));
});

test('mutation of profile or epoch guards after invocation cannot change the queued transaction', async () => {
  const f = fixture(); await f.restore(); const guard = {expectedProfileId: 'profileA', expectedResetEpoch: 0};
  const pending = f.api.updateArtifactSetting('gw', effect, {needed: true}, guard);
  guard.expectedProfileId = 'profileB'; guard.expectedResetEpoch = 4;
  assert.equal(await pending, 2); assert.equal(f.writes[0].path, paths.gw);
});

test('reset returnState returns this successful transaction epoch and immutable numeric metadata', async () => {
  const f = fixture(settings(5, 8)); await f.restore();
  const result = await f.api.resetArtifactSettings('gw', {expectedProfileId: 'profileA', returnState: true});
  assert.deepEqual(result, {revision: 9, resetEpoch: 6}); assert(Object.isFrozen(result));
  assert.equal(f.records.get(paths.gw).resetEpoch, 6);
  assert.equal(await f.api.resetArtifactSettings('gw'), 10);
  assert.equal(await f.api.resetArtifactSettings('gw', {returnState: false}), 11);
});

test('reset metadata cannot accidentally adopt a subsequent device reset epoch', async () => {
  const f = fixture(settings(5, 8)); await f.restore();
  f.afterCommit(() => f.records.set(paths.gw, settings(7, 10)));
  const result = await f.api.resetArtifactSettings('gw', {returnState: true});
  assert.deepEqual(result, {revision: 9, resetEpoch: 6});
  assert.equal(f.records.get(paths.gw).resetEpoch, 7);
  await assert.rejects(f.api.updateArtifactSetting('gw', effect, {needed: true}, {expectedResetEpoch: result.resetEpoch}),
    /ARTIFACT_RESET_EPOCH_MISMATCH/);
});

test('reset retry returns the epoch after the winning remote reset rather than the original read', async () => {
  const f = fixture(settings(5, 8)); await f.restore();
  f.beforeCommit((staged, attempt) => {
    if (attempt !== 1) return;
    f.records.set(paths.gw, settings(6, 9)); throw Object.assign(Error('concurrent'), {code: 'permission-denied'});
  });
  assert.deepEqual(await f.api.resetArtifactSettings('gw', {returnState: true}), {revision: 10, resetEpoch: 7});
  assert.equal(f.transactions(), 2); assert.equal(f.records.get(paths.gw).resetEpoch, 7);
});

test('guarded subscription captures owner, delivers server state and unsubscribes fully', async () => {
  const f = fixture(); await f.restore(); const guard = {expectedProfileId: 'profileA'}, values = [], errors = [];
  const stop = f.api.subscribeArtifactSettings('gw', value => values.push(value), error => errors.push(error), guard);
  guard.expectedProfileId = 'profileB'; await settle();
  assert.equal(values.length, 1); assert.equal(values[0].resetEpoch, 0); assert.deepEqual(errors, []);
  stop(); assert.equal(f.listenerCount(), 0);
});

test('omitted and empty guards retain existing S1-4 unguarded behavior', async () => {
  const f = fixture(); await f.restore();
  assert.equal((await f.api.getArtifactSettings('gw', {})).revision, 1);
  assert.equal(await f.api.updateArtifactSetting('gw', effect, {needed: true}), 2);
  assert.equal(await f.api.resetArtifactSettings('gw', {}), 3);
});
