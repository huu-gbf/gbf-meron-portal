/* Pure and deterministic Artifact controller tests. All transport is in-memory;
 * this suite never creates Firebase clients or opens network connections. */
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ARTIFACT_CATALOG, ARTIFACT_LEGACY_EFFECT_IDS, createDefaultArtifactProjection} = require('../artifact-catalog');
const {STATE_KEY_PREFIX, OWNER_KEY, fullProjection, mergeProjection, validateProjection,
  createArtifactSync, mountArtifactSync} = require('../artifact-sync');

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const defaults = () => createDefaultArtifactProjection();
const selected = ARTIFACT_CATALOG.filter(item => item.values);
const fixed = ARTIFACT_CATALOG.filter(item => !item.values);
const X = selected[0].effectId, Y = selected[1].effectId, F = fixed[0].effectId;
const byId = new Map(ARTIFACT_CATALOG.map(item => [item.effectId, item]));
const legacyKeys = new Map(Object.entries(ARTIFACT_LEGACY_EFFECT_IDS).map(([key, id]) => [id, key]));
const key = mode => 'gbf_awakening_data_' + mode;
const alternate = id => byId.get(id).values.find(value => value !== defaults().items[id].selectedValue);
const identity = (profileId = 'profileA', deviceId = 'deviceA') => ({active: true, profileId, deviceId});
const settle = async () => { for (let i = 0; i < 140; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return {promise, resolve, reject};
}
function stateDoc(projection = defaults(), resetEpoch = 0, revision = 1, deviceId = 'deviceA') {
  return {schemaVersion: 1, catalogVersion: 1, resetEpoch, items: clone(projection.items), revision,
    createdAt: {seconds: 100, nanoseconds: 0}, updatedAt: {seconds: 100 + revision, nanoseconds: 0},
    updatedByDeviceId: deviceId};
}
function legacy(projection = defaults(), memo = 'device memo') {
  return {...Object.fromEntries(ARTIFACT_CATALOG.map(item => [legacyKeys.get(item.effectId), {
    ...clone(projection.items[item.effectId]), ...(!item.values ? {selectedValue: item.value} : {})
  }])), memos: [{name: memo, value: 'local only'}]};
}
function ioFixture(gw = legacy(), high = legacy(defaults(), 'high memo'), persisted = {}) {
  const values = new Map(Object.entries({[key('gw')]: JSON.stringify(gw), [key('high')]: JSON.stringify(high), ...persisted}));
  const events = [], timers = new Map();
  let failInternal = false, failLegacy = false, timerId = 0, nextId = 0, writeHook;
  const storage = {
    getItem: name => values.has(name) ? values.get(name) : null,
    setItem(name, value) {
      if (failInternal && !name.startsWith('gbf_awakening_data_')) throw Error('quota');
      values.set(name, String(value)); events.push(['persist', name, String(value)]);
    }
  };
  const io = {storage,
    readLegacy(mode) { return JSON.parse(values.get(key(mode)) || '{}'); },
    writeLegacy(mode, value) {
      events.push(['legacy', mode, clone(value)]);
      if (failLegacy) return false;
      storage.setItem(key(mode), JSON.stringify(value));
      if (writeHook) writeHook(mode, clone(value));
      return true;
    }
  };
  const options = {retryDelay: 10,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }, makeId: () => 'operation-' + (++nextId)};
  return {io, options, values, events, timers,
    failInternal: value => { failInternal = value; }, failLegacy: value => { failLegacy = value; },
    writeHook: hook => { writeHook = hook; },
    runTimers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); }};
}
function serverFixture(initial = {gw: stateDoc(), high: stateDoc()}) {
  const profiles = new Map([['profileA', clone(initial)]]), listeners = new Set();
  const ensure = profile => {
    if (!profiles.has(profile)) profiles.set(profile, {gw: null, high: null});
    return profiles.get(profile);
  };
  const emit = (profile, mode) => {
    for (const record of [...listeners]) {
      if (record.profile === profile && record.mode === mode) {
        const snapshot = clone(ensure(profile)[mode]);
        queueMicrotask(() => { if (listeners.has(record)) record.next(snapshot); });
      }
    }
  };
  return {profiles, listeners, ensure, emit,
    data: (mode = 'gw', profile = 'profileA') => clone(ensure(profile)[mode]),
    replace(mode, document, profile = 'profileA') { ensure(profile)[mode] = clone(document); emit(profile, mode); },
    remoteField(mode, effectId, field, value, profile = 'profileA') {
      const data = ensure(profile)[mode]; data.items[effectId][field] = value; data.revision++; emit(profile, mode);
    },
    remoteReset(mode = 'gw', profile = 'profileA') {
      const data = ensure(profile)[mode]; data.items = defaults().items; data.resetEpoch++; data.revision++; emit(profile, mode);
    }};
}
function transport(server = serverFixture(), member = identity()) {
  let currentIdentity = member, getHook, updateHook, resetHook, initHook;
  const calls = [];
  function guard(expected) {
    if (!currentIdentity?.active || (expected?.expectedProfileId && expected.expectedProfileId !== currentIdentity.profileId)) {
      throw Error('MEMBERSHIP_REQUIRED');
    }
  }
  const client = {
    async getIdentity() { calls.push(['identity']); return clone(currentIdentity); },
    async getArtifactSettings(mode, expected) {
      calls.push(['get', mode, clone(expected)]); guard(expected);
      if (getHook) await getHook(mode, expected);
      guard(expected); return server.data(mode, currentIdentity.profileId);
    },
    async initializeArtifactSettings(mode, projection, expected) {
      calls.push(['initialize', mode, clone(projection), clone(expected)]); guard(expected);
      if (initHook) await initHook(mode, projection, expected);
      guard(expected);
      const state = server.ensure(currentIdentity.profileId);
      if (!state[mode]) { state[mode] = stateDoc(projection, 0, 1, currentIdentity.deviceId); server.emit(currentIdentity.profileId, mode); }
      return clone(state[mode]);
    },
    async updateArtifactSetting(mode, effectId, patch, expected) {
      calls.push(['update', mode, effectId, clone(patch), clone(expected)]); guard(expected);
      if (updateHook) await updateHook(mode, effectId, patch, expected);
      guard(expected);
      const data = server.ensure(currentIdentity.profileId)[mode];
      if (!data) throw Error('SETTINGS_NOT_INITIALIZED');
      if (expected?.expectedResetEpoch !== undefined && expected.expectedResetEpoch !== data.resetEpoch) {
        throw Error('ARTIFACT_RESET_EPOCH_MISMATCH');
      }
      const field = Object.keys(patch)[0];
      if (data.items[effectId][field] !== patch[field]) {
        data.items[effectId][field] = patch[field]; data.revision++;
        data.updatedByDeviceId = currentIdentity.deviceId;
        server.emit(currentIdentity.profileId, mode);
      }
      return data.revision;
    },
    async resetArtifactSettings(mode, expected) {
      calls.push(['reset', mode, clone(expected)]); guard(expected);
      if (resetHook) await resetHook(mode, expected);
      guard(expected);
      const data = server.ensure(currentIdentity.profileId)[mode];
      if (!data) throw Error('SETTINGS_NOT_INITIALIZED');
      data.items = defaults().items; data.resetEpoch++; data.revision++;
      data.updatedByDeviceId = currentIdentity.deviceId;
      const result = {revision: data.revision, resetEpoch: data.resetEpoch};
      server.emit(currentIdentity.profileId, mode);
      return expected?.returnState ? result : result.revision;
    },
    subscribeArtifactSettings(mode, next, error, expected) {
      calls.push(['subscribe', mode, clone(expected)]); guard(expected);
      const record = {profile: currentIdentity.profileId, mode, next, error}; server.listeners.add(record);
      return () => { calls.push(['unsubscribe', mode]); server.listeners.delete(record); };
    }
  };
  return {client, server, calls,
    identity: member => { currentIdentity = member; }, getHook: hook => { getHook = hook; },
    updateHook: hook => { updateHook = hook; }, resetHook: hook => { resetHook = hook; }, initHook: hook => { initHook = hook; },
    fail(mode = 'gw') { for (const listener of [...server.listeners]) if (listener.mode === mode) listener.error(Error('SETTINGS_UNAVAILABLE')); }};
}
function setup(options = {}) {
  const f = ioFixture(options.gw, options.high, options.persisted);
  const cloud = transport(options.server || serverFixture(options.initial), options.member === undefined ? identity() : options.member);
  const sync = createArtifactSync(cloud.client, f.io, f.options);
  return {...f, cloud, sync};
}
function eventTarget() {
  const listeners = new Map();
  return {addEventListener(type, callback) {
    if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback);
  }, removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
  emit(type) { for (const callback of [...(listeners.get(type) || [])]) callback({type}); }};
}
function mountScope(f, online = false) {
  let sdkCreations = 0;
  const document = {...eventTarget(), hidden: false,
    createElement() { throw Error('the installed fixture SDK must not load remote scripts'); },
    head: {append() { throw Error('unexpected SDK request'); }}};
  const scope = {...eventTarget(), document, navigator: {onLine: online},
    firebase: {initializeApp() {}, auth() {}, firestore() {}},
    MemberSync: {
      environmentOptions() { return {sdkBase: '/sdk/', firebaseConfig: {}, options: {}}; },
      createMemberSync() { sdkCreations++; return {...f.cloud.client,
        restoreAuthentication: async () => ({uid: 'memberA', isAnonymous: true})}; }
    }};
  return {scope, creations: () => sdkCreations};
}
function userChange(f, mode, effectId, field, value) {
  const data = f.io.readLegacy(mode), catalogItem = byId.get(effectId), old = data[legacyKeys.get(effectId)] || {
    needed: false, selectedValue: catalogItem.values ? catalogItem.values.at(-1) : catalogItem.value
  };
  data[legacyKeys.get(effectId)] = {...old, [field]: value};
  f.io.writeLegacy(mode, data);
  return f.sync.change(mode, effectId, field, value);
}
function userReset(f, mode = 'gw') { f.io.writeLegacy(mode, {}); return f.sync.reset(mode); }
const pending = (f, mode = 'gw') => f.sync.snapshot()?.modes?.[mode]?.pending || [];
const writes = f => f.cloud.calls.filter(call => ['initialize', 'update', 'reset'].includes(call[0]));
async function drain(f) { await f.sync.replayPending(); await settle(); }

test('[local] fullProjection fills missing fields from exact catalog defaults without changing legacy', () => {
  const input = {s12_0: {needed: true, selectedValue: alternate(X)}, memos: [{name: 'private'}], other: 'kept'};
  const before = clone(input), projected = fullProjection(input), expected = defaults();
  expected.items[X] = {needed: true, selectedValue: alternate(X)};
  assert.deepEqual(projected, expected); assert.deepEqual(input, before);
  projected.items[X].needed = false; assert.equal(input.s12_0.needed, true);
});
test('[local] invalid legacy fields use safe defaults and never become pending-shaped data', () => {
  for (const input of [null, [], 'bad', {s12_0: {needed: 'true', selectedValue: alternate(X)}},
    {s12_0: {needed: true, selectedValue: 'invalid'}}, {s4_0: {needed: 1}}, {unknown: {needed: true}}]) {
    assert.deepEqual(fullProjection(input), defaults());
  }
});
test('[local] mergeProjection changes only synchronized fields and retains memos and unrelated legacy data', () => {
  const input = legacy(); input.extra = {private: true}; const before = clone(input), remote = defaults();
  remote.items[X] = {needed: true, selectedValue: alternate(X)}; remote.items[F].needed = true;
  const merged = mergeProjection(input, remote);
  assert.deepEqual(input, before); assert.deepEqual(merged.memos, before.memos); assert.deepEqual(merged.extra, before.extra);
  assert.deepEqual(merged[legacyKeys.get(X)], remote.items[X]);
  assert.deepEqual(merged[legacyKeys.get(F)], {needed: true, selectedValue: byId.get(F).value});
  merged.memos[0].name = 'detached'; assert.equal(input.memos[0].name, 'device memo');
});
test('[local] validateProjection rejects catalog mismatch, sparse/unknown IDs and fixed selectedValue', () => {
  const sparse = defaults(); delete sparse.items[X];
  const unknown = defaults(); unknown.items.unknown = {needed: false};
  const badFixed = defaults(); badFixed.items[F].selectedValue = '3%';
  for (const value of [null, {}, {catalogVersion: 2, items: defaults().items}, sparse, unknown, badFixed]) {
    assert.throws(() => validateProjection(value));
  }
});
test('[local] no restored member keeps legacy working and creates no persistent sync state', async () => {
  const f = setup({member: null}); await f.sync.start(); userChange(f, 'gw', X, 'needed', true); await settle();
  assert.equal(f.io.readLegacy('gw').s12_0.needed, true); assert.equal(writes(f).length, 0);
  assert(![...f.values.keys()].some(name => name.startsWith(STATE_KEY_PREFIX))); f.sync.dispose();
});
test('[local] no implicit account creation is part of the controller contract', async () => {
  const f = setup({member: null}); f.cloud.client.startAuthentication = () => { throw Error('account creation'); };
  f.cloud.client.restoreAuthentication = () => { throw Error('controller must consume the existing member client'); };
  await f.sync.start(); assert.deepEqual(f.cloud.calls, [['identity']]); f.sync.dispose();
});
test('[local] internal persistence failure leaves local controls usable and prevents cloud writes', async () => {
  const f = setup(); f.failInternal(true); await f.sync.start(); userChange(f, 'gw', X, 'needed', true); await drain(f);
  assert.equal(f.io.readLegacy('gw').s12_0.needed, true); assert.equal(writes(f).length, 0); f.sync.dispose();
});

for (const mode of ['gw', 'high']) {
  test('[initial] missing ' + mode + ' creates the current complete local projection', async () => {
    const projection = defaults(); projection.items[X].needed = true; projection.items[Y].selectedValue = alternate(Y);
    const f = setup({[mode]: legacy(projection, mode + ' private'), initial: {gw: null, high: null}});
    await f.sync.start(); assert.deepEqual(f.cloud.server.data(mode).items, projection.items);
    const call = f.cloud.calls.find(call => call[0] === 'initialize' && call[1] === mode);
    assert.deepEqual(call[2], projection); assert.equal(call[3].expectedProfileId, 'profileA');
    assert(!JSON.stringify(call).includes('private')); f.sync.dispose();
  });
}
test('[initial] an existing cloud overrides old legacy fields without uploading them or touching memo', async () => {
  const old = defaults(); old.items[X].needed = true;
  const f = setup({gw: legacy(old, 'PC private')}); await f.sync.start();
  assert.equal(f.io.readLegacy('gw').s12_0.needed, false);
  assert.equal(f.io.readLegacy('gw').memos[0].name, 'PC private'); assert.equal(writes(f).length, 0); f.sync.dispose();
});
test('[initial] failure before the first remote result preserves later explicit operations for an existing cloud', async () => {
  const old = defaults(); old.items[Y].needed = true; const f = setup({gw: legacy(old)});
  f.cloud.getHook(mode => { if (mode === 'gw') throw Error('offline'); }); await f.sync.start();
  userChange(f, 'gw', X, 'needed', true); await settle(); f.cloud.getHook(null); await f.sync.start(); await drain(f);
  assert.equal(f.cloud.server.data().items[X].needed, true); assert.equal(f.cloud.server.data().items[Y].needed, false);
  assert.equal(f.io.readLegacy('gw').s12_0.needed, true); assert.deepEqual(pending(f), []); f.sync.dispose();
});
test('[initial] offline changes seed the newest local state when the cloud is still absent on reconnect', async () => {
  const f = setup({initial: {gw: null, high: null}});
  f.cloud.getHook(() => { throw Error('offline'); }); await f.sync.start(); userChange(f, 'gw', X, 'needed', true);
  userChange(f, 'high', Y, 'selectedValue', alternate(Y)); f.cloud.getHook(null); await f.sync.start(); await drain(f);
  assert.equal(f.cloud.server.data('gw').items[X].needed, true);
  assert.equal(f.cloud.server.data('high').items[Y].selectedValue, alternate(Y)); f.sync.dispose();
});
test('[initial] an explicit edit during an outstanding first get survives the remote baseline', async () => {
  const f = setup(), wait = deferred(); f.cloud.getHook(mode => mode === 'gw' ? wait.promise : undefined);
  const starting = f.sync.start(); await settle(); userChange(f, 'gw', X, 'needed', true);
  wait.resolve(); await starting; await drain(f); assert.equal(f.cloud.server.data().items[X].needed, true);
  assert.equal(f.io.readLegacy('gw').s12_0.needed, true); f.sync.dispose();
});
test('[initial] remote subscribe applies both modes without echoing writes or sharing memos', async () => {
  const f = setup(); await f.sync.start(); f.cloud.server.remoteField('gw', X, 'needed', true);
  f.cloud.server.remoteField('high', Y, 'selectedValue', alternate(Y)); await settle();
  assert.equal(f.io.readLegacy('gw').s12_0.needed, true);
  assert.equal(f.io.readLegacy('high').s12_1.selectedValue, alternate(Y));
  assert.equal(f.io.readLegacy('high').memos[0].name, 'high memo'); assert.equal(writes(f).length, 0); f.sync.dispose();
});
test('[initial] invalid remote schema or catalog never repairs or overwrites the cloud', async () => {
  for (const bad of [{...stateDoc(), catalogVersion: 2}, {...stateDoc(), items: {unknown: {needed: true}}}]) {
    const f = setup({initial: {gw: bad, high: stateDoc()}}); const memo = f.io.readLegacy('gw').memos;
    await f.sync.start(); await settle(); assert.deepEqual(f.cloud.server.data(), bad);
    assert.deepEqual(f.io.readLegacy('gw').memos, memo); assert.equal(writes(f).length, 0); f.sync.dispose();
  }
});

test('[pending] the operation is synchronously durable before its network update starts', async () => {
  const f = setup(); await f.sync.start(); let checked = false;
  f.cloud.updateHook((mode, id, patch) => {
    const saved = JSON.parse(f.values.get(STATE_KEY_PREFIX + 'profileA'));
    assert(saved.modes[mode].pending.some(op => op.type === 'field' && op.effectId === id && op.value === patch[op.field]));
    assert.equal(f.io.readLegacy(mode)[legacyKeys.get(id)].needed, true); checked = true;
  });
  userChange(f, 'gw', X, 'needed', true); await drain(f); assert(checked); assert.deepEqual(pending(f), []); f.sync.dispose();
});
test('[pending] same-field unsent edits compact to one final value without growing an operation log', async () => {
  const f = setup(); await f.sync.start(); f.sync.stop();
  for (let i = 0; i < 101; i++) userChange(f, 'gw', X, 'needed', i % 2 === 0);
  assert.equal(pending(f).length, 1); assert.equal(pending(f)[0].value, true);
  await f.sync.start(); await drain(f); assert.equal(f.cloud.server.data().items[X].needed, true); f.sync.dispose();
});
test('[pending] different effects, fields and modes never replace one another', async () => {
  const f = setup(); await f.sync.start(); f.sync.stop();
  userChange(f, 'gw', X, 'needed', true); userChange(f, 'gw', X, 'selectedValue', alternate(X));
  userChange(f, 'gw', Y, 'needed', true); userChange(f, 'high', X, 'needed', true);
  assert.equal(pending(f).length, 3); assert.equal(pending(f, 'high').length, 1);
  await f.sync.start(); await drain(f);
  assert.deepEqual(f.cloud.server.data().items[X], {needed: true, selectedValue: alternate(X)});
  assert.equal(f.cloud.server.data('high').items[X].needed, true); f.sync.dispose();
});
test('[pending] all 63 needed and 34 selected fields replay independently in each mode', async () => {
  const f = setup(); await f.sync.start(); f.sync.stop();
  for (const mode of ['gw', 'high']) {
    for (const item of ARTIFACT_CATALOG) {
      userChange(f, mode, item.effectId, 'needed', true);
      if (item.values) userChange(f, mode, item.effectId, 'selectedValue', item.values[0]);
    }
    assert.equal(pending(f, mode).length, 97);
  }
  await f.sync.start(); await drain(f);
  for (const mode of ['gw', 'high']) {
    for (const item of ARTIFACT_CATALOG) {
      assert.equal(f.cloud.server.data(mode).items[item.effectId].needed, true);
      if (item.values) assert.equal(f.cloud.server.data(mode).items[item.effectId].selectedValue, item.values[0]);
      else assert(!Object.hasOwn(f.cloud.server.data(mode).items[item.effectId], 'selectedValue'));
    }
    assert.deepEqual(pending(f, mode), []);
  }
  f.sync.dispose();
});
test('[pending] unchanged cloud values acknowledge an operation without changing its revision', async () => {
  const f = setup(); await f.sync.start(); const before = f.cloud.server.data().revision;
  userChange(f, 'gw', X, 'needed', false); await drain(f);
  assert.deepEqual(pending(f), []); assert.equal(f.cloud.server.data().revision, before); f.sync.dispose();
});
test('[pending] a later local-storage failure stops newly queued cloud writes', async () => {
  const f = setup(); await f.sync.start(); f.failInternal(true);
  userChange(f, 'gw', X, 'needed', true); await drain(f);
  assert.equal(f.io.readLegacy('gw').s12_0.needed, true); assert.equal(f.cloud.server.data().items[X].needed, false); f.sync.dispose();
});
test('[pending] a failed gw write does not starve independently queued high edits', async () => {
  const f = setup(); await f.sync.start(); f.sync.stop();
  userChange(f, 'gw', X, 'needed', true); userChange(f, 'high', Y, 'needed', true);
  f.cloud.updateHook(mode => { if (mode === 'gw') throw Error('offline gw'); });
  await f.sync.start(); await drain(f);
  assert.equal(f.cloud.server.data('gw').items[X].needed, false);
  assert.equal(f.cloud.server.data('high').items[Y].needed, true);
  assert.equal(pending(f).length, 1); assert.deepEqual(pending(f, 'high'), []); f.sync.dispose();
});
test('[pending] A acknowledgment cannot delete a same-field B created while A is in flight', async () => {
  const f = setup(), waitA = deferred(), waitB = deferred(); await f.sync.start();
  let count = 0; f.cloud.updateHook(() => ++count === 1 ? waitA.promise : waitB.promise);
  userChange(f, 'gw', X, 'needed', true); const sending = f.sync.replayPending(); await settle();
  const firstId = pending(f)[0].id; userChange(f, 'gw', X, 'needed', false);
  assert.equal(pending(f).length, 2); assert.notEqual(pending(f).at(-1).id, firstId);
  waitA.resolve(); await settle(); assert(pending(f).some(op => op.value === false));
  assert.equal(f.io.readLegacy('gw').s12_0.needed, false);
  waitB.resolve(); await sending; await drain(f); assert.equal(f.cloud.server.data().items[X].needed, false); f.sync.dispose();
});
test('[pending] a gw acknowledgment cannot remove the high queue', async () => {
  const f = setup(), wait = deferred(); await f.sync.start();
  f.cloud.updateHook(mode => mode === 'gw' ? wait.promise : undefined);
  userChange(f, 'gw', X, 'needed', true); const sending = f.sync.replayPending(); await settle();
  f.sync.stop(); userChange(f, 'high', Y, 'needed', true); wait.resolve(); await sending;
  assert(pending(f, 'high').some(op => op.effectId === Y)); assert.equal(f.io.readLegacy('high').s12_1.needed, true);
  await f.sync.start(); await drain(f); assert.equal(f.cloud.server.data('high').items[Y].needed, true); f.sync.dispose();
});
test('[pending] a gw edit added during a high flight drains after high finishes without another external wake', async () => {
  const f = setup(), wait = deferred(); await f.sync.start();
  f.cloud.updateHook(mode => mode === 'high' ? wait.promise : undefined);
  userChange(f, 'high', X, 'needed', true); const sending = f.sync.replayPending(); await settle();
  assert(f.cloud.calls.some(call => call[0] === 'update' && call[1] === 'high'));
  userChange(f, 'gw', Y, 'needed', true); wait.resolve(); await sending; await settle();
  assert.equal(f.cloud.server.data('gw').items[Y].needed, true);
  assert.deepEqual(pending(f), []); assert.deepEqual(pending(f, 'high'), []); f.sync.dispose();
});
test('[pending] remote snapshots preserve explicit pending fields while applying other remote fields', async () => {
  const f = setup(), wait = deferred(); await f.sync.start(); f.cloud.updateHook(() => wait.promise);
  userChange(f, 'gw', X, 'needed', true); const sending = f.sync.replayPending(); await settle();
  f.cloud.server.remoteField('gw', Y, 'needed', true); await settle();
  assert.equal(f.io.readLegacy('gw').s12_0.needed, true); assert.equal(f.io.readLegacy('gw').s12_1.needed, true);
  wait.resolve(); await sending; await drain(f); f.sync.dispose();
});
test('[pending] a user edit during remote legacy application survives the remainder of that receive', async () => {
  const f = setup(); await f.sync.start(); let injected = false;
  f.writeHook(mode => {
    if (mode !== 'gw' || injected) return;
    injected = true; userChange(f, 'gw', X, 'needed', true);
  });
  f.cloud.server.remoteField('gw', Y, 'needed', true); await settle(); await drain(f);
  assert(injected); assert.equal(f.io.readLegacy('gw').s12_0.needed, true);
  assert.equal(f.io.readLegacy('gw').s12_1.needed, true); assert.equal(f.cloud.server.data().items[X].needed, true); f.sync.dispose();
});
test('[pending] local memo saves create no cloud operation', async () => {
  const f = setup(); await f.sync.start(); const data = f.io.readLegacy('gw');
  data.memos.push({name: 'memo edit', value: 'private'}); f.io.writeLegacy('gw', data); await drain(f);
  assert.equal(writes(f).length, 0); assert.deepEqual(pending(f), []);
  assert.equal(f.io.readLegacy('gw').memos.at(-1).name, 'memo edit'); f.sync.dispose();
});
test('[pending] field writes always carry both expected profile and known reset epoch', async () => {
  const f = setup({initial: {gw: stateDoc(defaults(), 7), high: stateDoc(defaults(), 2)}}); await f.sync.start();
  userChange(f, 'gw', X, 'needed', true); await drain(f);
  const call = f.cloud.calls.find(call => call[0] === 'update');
  assert.equal(call[4].expectedProfileId, 'profileA'); assert.equal(call[4].expectedResetEpoch, 7); f.sync.dispose();
});
test('[pending] invalid edit IDs fields and values cannot create an unsafe network operation', async () => {
  const f = setup(); await f.sync.start();
  for (const args of [['gw', 'unknown', 'needed', true], ['gw', X, 'needed', 'true'], ['gw', X, 'selectedValue', 'invalid'],
    ['gw', F, 'selectedValue', '3%'], ['gw', X, 'memos', 'private'], ['other', X, 'needed', true]]) {
    try { f.sync.change(...args); } catch (_) {}
  }
  await drain(f); assert.equal(writes(f).length, 0); assert.deepEqual(pending(f), []); f.sync.dispose();
});
test('[pending] malformed persisted pending is never sent and does not break the local tool', async () => {
  const good = {version: 1, catalogVersion: 1, ownerProfileId: 'profileA', modes: {
    gw: {lastKnownResetEpoch: 0, terminal: null, pending: []}, high: {lastKnownResetEpoch: 0, terminal: null, pending: []}}};
  const mutations = [state => { state.ownerProfileId = '../profile'; }, state => { state.catalogVersion = 2; },
    state => { state.modes.gw.lastKnownResetEpoch = -1; }, state => { state.modes.other = clone(state.modes.gw); },
    state => { state.modes.gw.pending = [{id: 'bad', type: 'field', effectId: 'unknown', field: 'needed', value: true, baseResetEpoch: 0, afterResetId: null}]; },
    state => { state.modes.gw.pending = [{id: 'bad', type: 'field', effectId: X, field: 'needed', value: 'true', baseResetEpoch: 0, afterResetId: null}]; },
    state => { state.modes.gw.pending = [{id: 'bad', type: 'field', effectId: F, field: 'selectedValue', value: '3%', baseResetEpoch: 0, afterResetId: null}]; },
    state => { state.modes.gw.pending = [{id: 'bad', type: 'field', effectId: X, field: 'needed', value: true, baseResetEpoch: 0.5, afterResetId: null}]; }];
  for (const raw of ['{broken', ...mutations.map(mutate => { const state = clone(good); mutate(state); return JSON.stringify(state); })]) {
    const f = setup({persisted: {[OWNER_KEY]: JSON.stringify({version: 1, ownerProfileId: 'profileA'}),
      [STATE_KEY_PREFIX + 'profileA']: raw}});
    await f.sync.start(); await settle(); assert.equal(writes(f).length, 0);
    assert.equal(f.io.readLegacy('gw').memos[0].name, 'device memo'); f.sync.dispose();
  }
});
test('[pending] a future durable epoch is terminal when a fresh server read is older and never loops or writes', async () => {
  const projection = defaults(); projection.items[X].needed = true;
  const saved = {version: 1, catalogVersion: 1, ownerProfileId: 'profileA', modes: {
    gw: {lastKnownResetEpoch: 5, terminal: null, pending: [{id: 'future-operation', type: 'field',
      effectId: X, field: 'needed', value: true, baseResetEpoch: 5, afterResetId: null}]},
    high: {lastKnownResetEpoch: null, terminal: null, pending: []}}};
  const f = setup({gw: legacy(projection, 'future epoch memo'), persisted: {
    [OWNER_KEY]: JSON.stringify({version: 1, ownerProfileId: 'profileA'}),
    [STATE_KEY_PREFIX + 'profileA']: JSON.stringify(saved)}});
  const local = f.io.readLegacy('gw'); await f.sync.start(); await settle();
  assert.equal(f.sync.snapshot().modes.gw.terminal, 'INVALID_SETTINGS');
  assert.equal(f.cloud.calls.filter(call => call[0] === 'get' && call[1] === 'gw').length, 1);
  assert.equal(writes(f).length, 0); assert.deepEqual(f.io.readLegacy('gw'), local);
  assert.equal(f.cloud.server.data().resetEpoch, 0); assert.equal(f.cloud.server.data().items[X].needed, false); f.sync.dispose();
});

test('[reset] local reset drops old pending and keeps only post-reset edits for replay', async () => {
  const f = setup({initial: {gw: stateDoc(defaults(), 5), high: stateDoc()}}); await f.sync.start(); f.sync.stop();
  userChange(f, 'gw', X, 'needed', true); userReset(f); userChange(f, 'gw', Y, 'needed', true);
  const queue = pending(f), reset = queue.find(op => op.type === 'reset');
  assert(reset); assert(!queue.some(op => op.type === 'field' && op.effectId === X));
  assert.equal(queue.find(op => op.type === 'field').afterResetId, reset.id);
  assert(!f.io.readLegacy('gw').memos); await f.sync.start(); await drain(f);
  const result = f.cloud.server.data(); assert.equal(result.resetEpoch, 6);
  assert.equal(result.items[X].needed, false); assert.equal(result.items[Y].needed, true); assert.deepEqual(pending(f), []); f.sync.dispose();
});
test('[reset] remote reset removes pre-reset field pending and preserves this device memo', async () => {
  const f = setup({initial: {gw: stateDoc(defaults(), 3), high: stateDoc()}}); await f.sync.start(); f.sync.stop();
  userChange(f, 'gw', X, 'needed', true); f.cloud.server.remoteReset(); await f.sync.start(); await drain(f);
  assert.equal(f.cloud.server.data().items[X].needed, false); assert.equal(f.io.readLegacy('gw').s12_0.needed, false);
  assert.equal(f.io.readLegacy('gw').memos[0].name, 'device memo'); assert.deepEqual(pending(f), []); f.sync.dispose();
});
test('[reset] an explicit offline reset survives a concurrent remote reset and rebases only its own children', async () => {
  const f = setup({initial: {gw: stateDoc(defaults(), 3), high: stateDoc()}}); await f.sync.start(); f.sync.stop();
  userChange(f, 'gw', X, 'needed', true); userReset(f); userChange(f, 'gw', Y, 'needed', true);
  f.cloud.server.remoteReset(); f.cloud.server.remoteField('gw', X, 'needed', true);
  await f.sync.start(); await drain(f); const result = f.cloud.server.data();
  assert.equal(result.resetEpoch, 5); assert.equal(result.items[X].needed, false); assert.equal(result.items[Y].needed, true);
  const resets = f.cloud.calls.filter(call => call[0] === 'reset'); assert.equal(resets.length, 1);
  assert.equal(resets[0][2].returnState, true); f.sync.dispose();
});
test('[reset] reset acknowledgment binds a queued child to the transaction receipt epoch', async () => {
  const f = setup(), wait = deferred(); await f.sync.start(); f.cloud.resetHook(() => wait.promise);
  userReset(f); const sending = f.sync.replayPending(); await settle(); userChange(f, 'gw', X, 'needed', true);
  wait.resolve(); await sending; await drain(f);
  const update = f.cloud.calls.find(call => call[0] === 'update'); assert.equal(update[4].expectedResetEpoch, 1);
  assert.equal(f.cloud.server.data().items[X].needed, true); assert.equal(f.cloud.server.data().resetEpoch, 1); f.sync.dispose();
});
test('[reset] an old reset ACK cannot rebind or remove children of a newer local reset', async () => {
  const f = setup(), wait = deferred(); await f.sync.start(); let count = 0;
  f.cloud.resetHook(() => ++count === 1 ? wait.promise : undefined);
  userReset(f); const sending = f.sync.replayPending(); await settle();
  userChange(f, 'gw', X, 'needed', true); userReset(f); userChange(f, 'gw', Y, 'needed', true);
  wait.resolve(); await sending; await drain(f); const result = f.cloud.server.data();
  assert.equal(result.resetEpoch, 2); assert.equal(result.items[X].needed, false); assert.equal(result.items[Y].needed, true);
  assert.deepEqual(pending(f), []); f.sync.dispose();
});
test('[reset] a reset race after fetching remote causes an epoch mismatch without stale replay', async () => {
  const f = setup(); await f.sync.start(); let once = true;
  f.cloud.updateHook(() => { if (once) { once = false; f.cloud.server.remoteReset(); } });
  userChange(f, 'gw', X, 'needed', true); await drain(f);
  assert.equal(f.cloud.server.data().resetEpoch, 1); assert.equal(f.cloud.server.data().items[X].needed, false);
  assert.deepEqual(pending(f), []); assert.equal(f.io.readLegacy('gw').s12_0.needed, false); f.sync.dispose();
});
test('[reset] reset at default remains an explicit cloud epoch boundary', async () => {
  const f = setup(); await f.sync.start(); userReset(f); await drain(f);
  assert.equal(f.cloud.server.data().resetEpoch, 1); assert.equal(f.cloud.server.data().revision, 2); f.sync.dispose();
});
test('[reset] resetting gw does not change high fields, epoch, pending or memo', async () => {
  const f = setup(); await f.sync.start(); f.sync.stop(); userChange(f, 'high', X, 'needed', true);
  const highPending = clone(pending(f, 'high')), highLegacy = f.io.readLegacy('high'); userReset(f, 'gw');
  assert.deepEqual(pending(f, 'high'), highPending); assert.deepEqual(f.io.readLegacy('high'), highLegacy);
  await f.sync.start(); await drain(f); assert.equal(f.cloud.server.data('high').resetEpoch, 0);
  assert.equal(f.cloud.server.data('high').items[X].needed, true); f.sync.dispose();
});
test('[reset] repeated unsent reset segments stay bounded and retain only the final local intent', async () => {
  const f = setup(); await f.sync.start(); f.sync.stop();
  for (let i = 0; i < 50; i++) { userReset(f); userChange(f, 'gw', X, 'needed', true); }
  assert(pending(f).length <= 3); await f.sync.start(); await drain(f);
  assert.equal(f.cloud.server.data().items[X].needed, true); assert.deepEqual(pending(f), []); f.sync.dispose();
});

test('[offline] failed field writes preserve local and durable pending across a controller reload', async () => {
  const f = setup(); await f.sync.start(); f.cloud.updateHook(() => { throw Error('offline'); });
  userChange(f, 'gw', X, 'needed', true); await drain(f); assert.equal(pending(f).length, 1);
  assert.equal(f.io.readLegacy('gw').s12_0.needed, true); f.sync.dispose();
  f.cloud.updateHook(null); const reloaded = createArtifactSync(f.cloud.client, f.io, f.options);
  await reloaded.start(); await reloaded.replayPending(); assert.equal(f.cloud.server.data().items[X].needed, true);
  assert.deepEqual(reloaded.snapshot().modes.gw.pending, []); reloaded.dispose();
});
test('[offline] a cached owner field edit is durable after reload before any start or network call', async () => {
  const f = setup(); await f.sync.start(); f.sync.dispose(); const count = f.cloud.calls.length;
  const offline = {...f, sync: createArtifactSync(f.cloud.client, f.io, f.options)};
  userChange(offline, 'gw', X, 'needed', true);
  const saved = JSON.parse(f.values.get(STATE_KEY_PREFIX + 'profileA'));
  assert(saved.modes.gw.pending.some(op => op.effectId === X && op.value === true));
  assert.equal(f.cloud.calls.length, count); offline.sync.dispose();
  const resumed = createArtifactSync(f.cloud.client, f.io, f.options); await resumed.start(); await resumed.replayPending();
  assert.equal(f.cloud.server.data().items[X].needed, true); assert.deepEqual(resumed.snapshot().modes.gw.pending, []); resumed.dispose();
});
test('[offline] a cached owner reset and its later edit survive two reloads before authentication resumes', async () => {
  const f = setup(); await f.sync.start(); f.sync.dispose(); const count = f.cloud.calls.length;
  const first = {...f, sync: createArtifactSync(f.cloud.client, f.io, f.options)};
  userChange(first, 'gw', X, 'needed', true); first.sync.dispose();
  const second = {...f, sync: createArtifactSync(f.cloud.client, f.io, f.options)};
  userReset(second); userChange(second, 'gw', Y, 'needed', true);
  const saved = JSON.parse(f.values.get(STATE_KEY_PREFIX + 'profileA'));
  const reset = saved.modes.gw.pending.find(op => op.type === 'reset'); assert(reset);
  assert(saved.modes.gw.pending.some(op => op.effectId === Y && op.afterResetId === reset.id));
  assert(!saved.modes.gw.pending.some(op => op.effectId === X)); assert.equal(f.cloud.calls.length, count); second.sync.dispose();
  const resumed = createArtifactSync(f.cloud.client, f.io, f.options); await resumed.start(); await resumed.replayPending();
  assert.equal(f.cloud.server.data().resetEpoch, 1); assert.equal(f.cloud.server.data().items[X].needed, false);
  assert.equal(f.cloud.server.data().items[Y].needed, true); resumed.dispose();
});
test('[offline] an offline mount persists cached-owner edits without loading SDK or restoring Auth', async () => {
  const f = setup(); await f.sync.start(); f.sync.dispose(); const count = f.cloud.calls.length;
  const firstScope = mountScope(f), first = mountArtifactSync(f.io, firstScope.scope);
  userChange({...f, sync: first}, 'gw', X, 'needed', true); await settle();
  let saved = JSON.parse(f.values.get(STATE_KEY_PREFIX + 'profileA'));
  assert(saved.modes.gw.pending.some(op => op.effectId === X)); assert.equal(firstScope.creations(), 0);
  assert.equal(f.cloud.calls.length, count); first.dispose();
  const nextScope = mountScope(f), next = mountArtifactSync(f.io, nextScope.scope);
  userReset({...f, sync: next}); userChange({...f, sync: next}, 'gw', Y, 'needed', true);
  saved = JSON.parse(f.values.get(STATE_KEY_PREFIX + 'profileA')); assert(saved.modes.gw.pending.some(op => op.type === 'reset'));
  assert.equal(nextScope.creations(), 0); nextScope.scope.navigator.onLine = true;
  await next.start(); await next.replayPending(); await settle();
  assert.equal(nextScope.creations(), 1); assert.equal(f.cloud.server.data().resetEpoch, 1);
  assert.equal(f.cloud.server.data().items[X].needed, false); assert.equal(f.cloud.server.data().items[Y].needed, true); next.dispose();
});
test('[offline] a corrupt owner marker leaves local edits available but blocks missing-cloud initialization', async () => {
  for (const raw of ['{broken', JSON.stringify({version: 2, ownerProfileId: 'profileA'}),
    JSON.stringify({version: 1, ownerProfileId: '../profile'})]) {
    const f = setup({initial: {gw: null, high: null}, persisted: {[OWNER_KEY]: raw}});
    await f.sync.start(); userChange(f, 'gw', X, 'needed', true); await drain(f);
    assert.equal(f.io.readLegacy('gw').s12_0.needed, true); assert.equal(writes(f).length, 0); f.sync.dispose();
  }
});
test('[offline] pagehide stop leaves B durable while A resolves and starts no new send', async () => {
  const f = setup(), wait = deferred(); await f.sync.start(); f.cloud.updateHook(() => wait.promise);
  userChange(f, 'gw', X, 'needed', true); const sending = f.sync.replayPending(); await settle();
  userChange(f, 'gw', Y, 'needed', true); f.sync.stop(); wait.resolve(); await sending; await settle(); f.runTimers(); await settle();
  assert.equal(f.cloud.calls.filter(call => call[0] === 'update').length, 1);
  assert(pending(f).some(op => op.effectId === Y)); assert.equal(f.io.readLegacy('gw').s12_1.needed, true);
  f.cloud.updateHook(null); await f.sync.start(); await drain(f); assert.equal(f.cloud.server.data().items[Y].needed, true); f.sync.dispose();
});
test('[offline] pageshow waits for an unresolved old flight before replaying later same-field intent', async () => {
  const f = setup(), wait = deferred(); await f.sync.start(); f.cloud.updateHook(() => wait.promise);
  userChange(f, 'gw', X, 'needed', true); const sending = f.sync.replayPending(); await settle();
  userChange(f, 'gw', X, 'needed', false); f.sync.stop(); const resumed = f.sync.start(); await settle();
  assert.equal(f.cloud.calls.filter(call => call[0] === 'update').length, 1);
  f.cloud.updateHook(null); wait.resolve(); await sending; await resumed; await drain(f);
  assert.equal(f.cloud.server.data().items[X].needed, false); assert.deepEqual(pending(f), []); f.sync.dispose();
});
test('[offline] subscribe failure leaves local edits available for explicit reconnect', async () => {
  const f = setup(); await f.sync.start(); f.cloud.fail(); f.cloud.getHook(() => { throw Error('offline'); });
  userChange(f, 'gw', X, 'needed', true); await settle(); assert.equal(f.io.readLegacy('gw').s12_0.needed, true);
  f.cloud.getHook(null); await f.sync.start(); await drain(f); assert.equal(f.cloud.server.data().items[X].needed, true); f.sync.dispose();
});
test('[offline] profile switching archives A pending and cannot seed a missing B document from A legacy', async () => {
  const f = setup(); await f.sync.start(); f.sync.stop(); userChange(f, 'gw', X, 'needed', true);
  const savedA = f.values.get(STATE_KEY_PREFIX + 'profileA'); f.cloud.identity(identity('profileB', 'deviceB'));
  await f.sync.start(); await drain(f); const profileB = f.cloud.server.data('gw', 'profileB');
  assert.equal(profileB.items[X].needed, false); assert.equal(f.values.get(STATE_KEY_PREFIX + 'profileA'), savedA);
  assert.equal(f.sync.snapshot().ownerProfileId, 'profileB');
  assert(!f.cloud.calls.some(call => call[0] === 'update' && call[4].expectedProfileId === 'profileB')); f.sync.dispose();
});
test('[offline] profile A edits after a failed first get cannot seed a missing profile B document', async () => {
  const f = setup(); f.cloud.getHook(() => { throw Error('offline'); }); await f.sync.start();
  userChange(f, 'gw', X, 'needed', true); f.sync.stop(); f.cloud.getHook(null);
  f.cloud.identity(identity('profileB', 'deviceB')); await f.sync.start(); await drain(f);
  assert.equal(f.cloud.server.data('gw', 'profileB').items[X].needed, false);
  const recordA = JSON.parse(f.values.get(STATE_KEY_PREFIX + 'profileA'));
  assert(recordA.modes.gw.pending.some(op => op.effectId === X)); f.sync.dispose();
});
test('[offline] a failed final owner-marker save after B hydration cannot seed B legacy into missing A cloud', async () => {
  const a = defaults(); a.items[X].needed = true;
  const b = defaults(); b.items[Y].needed = true;
  const f = setup({initial: {gw: stateDoc(a), high: stateDoc(a)}}); await f.sync.start(); f.sync.stop();
  f.cloud.server.profiles.set('profileB', {gw: stateDoc(b), high: stateDoc(b)});
  f.cloud.identity(identity('profileB', 'deviceB')); let failed = false;
  f.writeHook(mode => { if (mode === 'gw' && !failed) { failed = true; f.failInternal(true); } });
  await f.sync.start(); assert(failed); assert.equal(f.io.readLegacy('gw').s12_1.needed, true); f.sync.dispose();
  f.failInternal(false); f.writeHook(null); f.cloud.identity(identity());
  f.cloud.server.ensure('profileA').gw = null;
  const resumed = createArtifactSync(f.cloud.client, f.io, f.options); await resumed.start(); await resumed.replayPending();
  assert.equal(f.cloud.server.data().items[Y].needed, false);
  assert.equal(f.cloud.server.data().items[X].needed, false); resumed.dispose();
});
test('[offline] a failed A legacy hydration after visiting B leaves provenance unsafe across reload', async () => {
  const a = defaults(); a.items[X].needed = true;
  const b = defaults(); b.items[Y].needed = true;
  const f = setup({initial: {gw: stateDoc(a), high: stateDoc(a)}}); await f.sync.start(); f.sync.stop();
  f.cloud.server.profiles.set('profileB', {gw: stateDoc(b), high: stateDoc(b)});
  f.cloud.identity(identity('profileB', 'deviceB')); await f.sync.start(); f.sync.stop();
  assert.equal(f.io.readLegacy('gw').s12_1.needed, true); f.cloud.identity(identity()); f.failLegacy(true);
  await f.sync.start(); assert.equal(f.io.readLegacy('gw').s12_1.needed, true); f.sync.dispose();
  f.failLegacy(false); f.cloud.server.ensure('profileA').gw = null;
  const resumed = createArtifactSync(f.cloud.client, f.io, f.options); await resumed.start(); await resumed.replayPending();
  assert.equal(f.cloud.server.data().items[Y].needed, false); resumed.dispose();
});
test('[offline] partial gw hydration and reload cannot seed the previous profile high legacy', async () => {
  const a = defaults(); a.items[X].needed = true;
  const b = defaults(); b.items[Y].needed = true;
  const f = setup({initial: {gw: stateDoc(a), high: stateDoc(a)}}); await f.sync.start(); f.sync.stop();
  f.cloud.server.profiles.set('profileB', {gw: stateDoc(b), high: null}); f.cloud.identity(identity('profileB', 'deviceB'));
  f.cloud.getHook(mode => { if (mode === 'high') throw Error('high offline'); }); await f.sync.start();
  assert.equal(f.io.readLegacy('gw').s12_1.needed, true); assert.equal(f.io.readLegacy('high').s12_0.needed, true); f.sync.dispose();
  f.cloud.getHook(null); const resumed = createArtifactSync(f.cloud.client, f.io, f.options);
  await resumed.start(); await resumed.replayPending();
  assert.equal(f.cloud.server.data('gw', 'profileB').items[Y].needed, true);
  assert.equal(f.cloud.server.data('high', 'profileB').items[X].needed, false);
  assert.equal(f.cloud.server.data('high', 'profileB').items[Y].needed, false); resumed.dispose();
});
test('[offline] identity switching during an outstanding request cannot redirect old pending', async () => {
  const f = setup(), wait = deferred(); await f.sync.start(); f.cloud.updateHook(() => wait.promise);
  userChange(f, 'gw', X, 'needed', true); const sending = f.sync.replayPending(); await settle(); f.sync.stop();
  f.cloud.identity(identity('profileB', 'deviceB')); f.cloud.updateHook(null); wait.resolve(); await sending;
  await f.sync.start(); await drain(f); assert.equal(f.cloud.server.data('gw', 'profileB').items[X].needed, false);
  const recordA = JSON.parse(f.values.get(STATE_KEY_PREFIX + 'profileA'));
  assert(recordA.modes.gw.pending.some(op => op.effectId === X)); f.sync.dispose();
});

test('[two-device] PC to phone and phone to PC updates converge with independent memos', async () => {
  const server = serverFixture(), pc = setup({server}), phone = setup({server, member: identity('profileA', 'deviceB'), gw: legacy(defaults(), 'phone memo')});
  await pc.sync.start(); await phone.sync.start(); userChange(pc, 'gw', X, 'needed', true); await drain(pc); await settle();
  assert.equal(phone.io.readLegacy('gw').s12_0.needed, true);
  userChange(phone, 'gw', Y, 'selectedValue', alternate(Y)); await drain(phone); await settle();
  assert.equal(pc.io.readLegacy('gw').s12_1.selectedValue, alternate(Y));
  assert.equal(pc.io.readLegacy('gw').memos[0].name, 'device memo'); assert.equal(phone.io.readLegacy('gw').memos[0].name, 'phone memo');
  pc.sync.dispose(); phone.sync.dispose();
});
test('[two-device] different effects merge and do not upload complete legacy snapshots', async () => {
  const server = serverFixture(), pc = setup({server}), phone = setup({server, member: identity('profileA', 'deviceB')});
  await pc.sync.start(); await phone.sync.start(); userChange(pc, 'gw', X, 'needed', true); userChange(phone, 'gw', Y, 'needed', true);
  await Promise.all([drain(pc), drain(phone)]); await settle();
  assert.equal(server.data().items[X].needed, true); assert.equal(server.data().items[Y].needed, true);
  for (const call of [...writes(pc), ...writes(phone)]) { assert.equal(call[0], 'update'); assert.equal(Object.keys(call[3]).length, 1); }
  pc.sync.dispose(); phone.sync.dispose();
});
test('[two-device] a phone reset preserves PC memo while clearing the resetting phone memo', async () => {
  const projection = defaults(); projection.items[X].needed = true; const server = serverFixture({gw: stateDoc(projection), high: stateDoc()});
  const pc = setup({server}), phone = setup({server, member: identity('profileA', 'deviceB'), gw: legacy(defaults(), 'phone memo')});
  await pc.sync.start(); await phone.sync.start(); userReset(phone); await drain(phone); await settle();
  assert.equal(pc.io.readLegacy('gw').s12_0.needed, false); assert.equal(pc.io.readLegacy('gw').memos[0].name, 'device memo');
  assert(!phone.io.readLegacy('gw').memos); pc.sync.dispose(); phone.sync.dispose();
});
test('[two-device] an offline PC field from before the phone reset cannot resurrect on reconnect', async () => {
  const server = serverFixture(), pc = setup({server}), phone = setup({server, member: identity('profileA', 'deviceB')});
  await pc.sync.start(); await phone.sync.start(); pc.sync.stop(); userChange(pc, 'gw', X, 'needed', true);
  userReset(phone); await drain(phone); await pc.sync.start(); await drain(pc); await settle();
  assert.equal(server.data().items[X].needed, false); assert.equal(pc.io.readLegacy('gw').s12_0.needed, false);
  assert.deepEqual(pending(pc), []); pc.sync.dispose(); phone.sync.dispose();
});
