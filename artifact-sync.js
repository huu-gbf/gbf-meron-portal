/* Artifact transport. Legacy values and memos stay owned by the local page. */
(function (root) {
  'use strict';
  const catalog = typeof module === 'object' && module.exports ? require('./artifact-catalog') : root.ArtifactCatalog;
  const STATE_KEY_PREFIX = 'gbf_artifact_sync_state_v1:';
  const OWNER_KEY = 'gbf_artifact_sync_owner_v1';
  const modes = ['gw', 'high'];
  const definitions = new Map(catalog.ARTIFACT_CATALOG.map(item => [item.effectId, item]));
  const legacyIds = catalog.ARTIFACT_LEGACY_EFFECT_IDS;
  const clone = value => JSON.parse(JSON.stringify(value));
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const invalid = () => { throw new Error('INVALID_SETTINGS'); };
  function validField(effectId, field, value) {
    const item = definitions.get(effectId);
    return !!item && (field === 'needed' ? typeof value === 'boolean'
      : field === 'selectedValue' && !!item.values && typeof value === 'string' && item.values.includes(value));
  }
  function validateProjection(value) {
    if (!exact(value, ['catalogVersion', 'items']) || value.catalogVersion !== 1
        || !exact(value.items, [...definitions.keys()])) invalid();
    for (const [effectId, item] of definitions) {
      const entry = value.items[effectId];
      if (!exact(entry, item.values ? ['needed', 'selectedValue'] : ['needed'])
          || !validField(effectId, 'needed', entry.needed)
          || (item.values && !validField(effectId, 'selectedValue', entry.selectedValue))) invalid();
    }
    return clone(value);
  }
  function fullProjection(legacy) {
    const result = catalog.createDefaultArtifactProjection();
    const sparse = catalog.projectArtifactSettings(legacy);
    Object.assign(result.items, sparse.items);
    return result;
  }
  function mergeProjection(legacy, projection) {
    const remote = validateProjection(projection);
    const result = legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? clone(legacy) : {};
    for (const [key, effectId] of Object.entries(legacyIds)) {
      const item = definitions.get(effectId), previous = result[key];
      result[key] = {...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
        needed: remote.items[effectId].needed,
        selectedValue: item.values ? remote.items[effectId].selectedValue : item.value};
    }
    return result;
  }
  function remoteState(value) {
    const timestamp = stamp => stamp && integer(stamp.seconds + 62135596800)
      && Number.isInteger(stamp.nanoseconds) && stamp.nanoseconds >= 0 && stamp.nanoseconds < 1000000000;
    if (!exact(value, ['schemaVersion', 'catalogVersion', 'resetEpoch', 'items', 'revision',
      'createdAt', 'updatedAt', 'updatedByDeviceId']) || value.schemaVersion !== 1
        || !integer(value.resetEpoch) || !integer(value.revision) || value.revision < 1
        || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || !id(value.updatedByDeviceId)) invalid();
    return {...validateProjection({catalogVersion: value.catalogVersion, items: value.items}),
      resetEpoch: value.resetEpoch, revision: value.revision};
  }
  const emptyMode = () => ({lastKnownResetEpoch: null, terminal: null, pending: []});
  const emptyState = ownerProfileId => ({version: 1, catalogVersion: 1, ownerProfileId,
    modes: {gw: emptyMode(), high: emptyMode()}});
  function validateState(value, ownerProfileId) {
    if (!exact(value, ['version', 'catalogVersion', 'ownerProfileId', 'modes'])
        || value.version !== 1 || value.catalogVersion !== 1 || value.ownerProfileId !== ownerProfileId
        || !id(ownerProfileId) || !exact(value.modes, modes)) invalid();
    for (const mode of modes) {
      const state = value.modes[mode], ids = new Set(), resets = new Set();
      if (!exact(state, ['lastKnownResetEpoch', 'terminal', 'pending'])
          || !(state.lastKnownResetEpoch === null || integer(state.lastKnownResetEpoch))
          || ![null, 'INVALID_SETTINGS', 'INVALID_SYNC_STATE'].includes(state.terminal)
          || !Array.isArray(state.pending) || state.pending.length > 100) invalid();
      for (const operation of state.pending) {
        if (!id(operation?.id) || ids.has(operation.id)) invalid();
        ids.add(operation.id);
        if (operation.type === 'reset') {
          if (!exact(operation, ['id', 'type'])) invalid();
          resets.add(operation.id);
        } else {
          if (!exact(operation, ['id', 'type', 'effectId', 'field', 'value', 'baseResetEpoch', 'afterResetId'])
              || operation.type !== 'field' || !validField(operation.effectId, operation.field, operation.value)
              || !(operation.baseResetEpoch === null || integer(operation.baseResetEpoch))
              || !(operation.afterResetId === null || resets.has(operation.afterResetId))
              || (operation.afterResetId !== null && operation.baseResetEpoch !== null)) invalid();
        }
      }
    }
    return clone(value);
  }

  function createArtifactSync(client, io, options = {}) {
    const later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
    let counter = 0;
    const makeId = options.makeId || (() => 'op_' + Date.now().toString(36) + '_'
      + (++counter).toString(36) + '_' + Math.random().toString(36).slice(2, 12));
    const records = new Map(), remote = {}, ready = {}, subscriptions = {};
    let membership, state, starting, working, timer, failures = 0, generation = 0;
    let enabled = false, disposed = false, storageFailed = false;
    let legacyOwners = {gw: null, high: null};
    let unownedLegacy = true;
    let transient = [], flight;
    const allowed = () => enabled && !disposed && !storageFailed && io.canSync?.() !== false;
    const stateKey = owner => STATE_KEY_PREFIX + owner;
    const save = record => {
      try {
        io.storage.setItem(stateKey(record.ownerProfileId), JSON.stringify(record));
        return true;
      } catch (_) { storageFailed = true; return false; }
    };
    function unwatch(mode) {
      const stop = subscriptions[mode]; delete subscriptions[mode]; delete ready[mode];
      if (stop) stop();
    }
    function stop() {
      enabled = false; generation++; cancel(timer); timer = undefined;
      for (const mode of modes) unwatch(mode);
      starting = undefined;
      // working/flight survive suspension: a resumed worker must await A's
      // settlement before it can submit B, even when pagehide occurred in A.
    }
    function retry() {
      if (!allowed() || timer || (state && modes.every(mode => state.modes[mode].terminal))) return;
      timer = later(() => { timer = undefined; if (allowed()) start(); },
        Math.min(30000, (options.retryDelay ?? 1000) * (2 ** Math.min(failures++, 5))));
    }
    function fail(mode, error) {
      unwatch(mode);
      if (error?.message === 'INVALID_SETTINGS') {
        state.modes[mode].terminal = 'INVALID_SETTINGS'; save(state);
      } else retry();
    }
    function readOwners() {
      const raw = io.storage.getItem(OWNER_KEY);
      if (raw === null) return {gw: null, high: null};
      unownedLegacy = false;
      const value = JSON.parse(raw);
      if (value.version !== 1 || !id(value.ownerProfileId)) invalid();
      if (exact(value, ['version', 'ownerProfileId'])) return {gw: value.ownerProfileId, high: value.ownerProfileId};
      if (!exact(value, ['version', 'ownerProfileId', 'modes']) || !exact(value.modes, modes)
          || !modes.every(mode => value.modes[mode] === null || id(value.modes[mode]))) invalid();
      return {...value.modes};
    }
    function bind(identity) {
      if (membership?.profileId !== identity.profileId) {
        for (const mode of modes) { unwatch(mode); delete remote[mode]; }
        try { legacyOwners = readOwners(); }
        catch (error) { storageFailed = true; throw error; }
        if (!records.has(identity.profileId)) {
          const raw = io.storage.getItem(stateKey(identity.profileId));
          try { records.set(identity.profileId, raw === null ? emptyState(identity.profileId)
            : validateState(JSON.parse(raw), identity.profileId)); }
          catch (_) {
            const blocked = emptyState(identity.profileId);
            for (const mode of modes) blocked.modes[mode].terminal = 'INVALID_SYNC_STATE';
            records.set(identity.profileId, blocked);
          }
        }
        state = records.get(identity.profileId);
      }
      membership = {profileId: identity.profileId, deviceId: identity.deviceId};
      // Claim previously unowned legacy data before the first remote request.
      // A failed initial read must not let A's edits seed a later profile B.
      for (const mode of modes) {
        if (unownedLegacy) legacyOwners[mode] = identity.profileId;
        else if (legacyOwners[mode] !== identity.profileId) legacyOwners[mode] = null;
      }
      unownedLegacy = false;
      try {
        io.storage.setItem(OWNER_KEY, JSON.stringify({version: 1, ownerProfileId: identity.profileId, modes: legacyOwners}));
      } catch (_) { storageFailed = true; return false; }
      const waiting = transient; transient = [];
      for (const entry of waiting) {
        if (entry.type === 'reset') enqueueReset(entry.mode);
        else enqueueField(entry.mode, entry.effectId, entry.field, entry.value);
      }
      return save(state);
    }
    function projectionWithPending(mode, projection) {
      let result = validateProjection(projection);
      for (const op of state.modes[mode].pending) {
        if (op.type === 'reset') result = catalog.createDefaultArtifactProjection();
        else result.items[op.effectId][op.field] = op.value;
      }
      return result;
    }
    function receive(mode, data, authoritative = false) {
      const confirmed = remoteState(data), local = state.modes[mode];
      // A stale listener delivery is harmless, but a fresh server read below
      // our durable epoch means the journal cannot be safely replayed.
      if (authoritative && local.lastKnownResetEpoch !== null
          && confirmed.resetEpoch < local.lastKnownResetEpoch) invalid();
      // A delayed subscription must never move an epoch or revision backwards.
      if (remote[mode] && confirmed.revision < remote[mode].revision) return;
      if (local.lastKnownResetEpoch !== null && confirmed.resetEpoch < local.lastKnownResetEpoch) return;
      local.pending = local.pending.filter(op => {
        if (op.type === 'reset' || op.afterResetId !== null) return true;
        if (op.baseResetEpoch === null) { op.baseResetEpoch = confirmed.resetEpoch; return true; }
        return op.baseResetEpoch === confirmed.resetEpoch;
      });
      local.lastKnownResetEpoch = confirmed.resetEpoch;
      remote[mode] = confirmed;
      if (!save(state)) throw new Error('LOCAL_STORAGE_UNAVAILABLE');
      const merged = mergeProjection(io.readLegacy(mode), projectionWithPending(mode,
        {catalogVersion: confirmed.catalogVersion, items: confirmed.items}));
      // Cross-key writes cannot be atomic. Journal unknown provenance first,
      // so a crash or a selective metadata failure can never label B data A.
      legacyOwners[mode] = null;
      io.storage.setItem(OWNER_KEY, JSON.stringify({version: 1, ownerProfileId: membership.profileId, modes: legacyOwners}));
      if (io.writeLegacy(mode, merged) === false) throw new Error('LOCAL_STORAGE_UNAVAILABLE');
      legacyOwners[mode] = membership.profileId;
      try {
        io.storage.setItem(OWNER_KEY, JSON.stringify({version: 1, ownerProfileId: membership.profileId, modes: legacyOwners}));
      } catch (error) { legacyOwners[mode] = null; throw error; }
    }
    async function prepare(mode, epoch, owner) {
      if (!allowed() || state.modes[mode].terminal) return false;
      let data = await client.getArtifactSettings(mode, {expectedProfileId: owner});
      if (!allowed() || epoch !== generation || membership.profileId !== owner) return false;
      if (!data) {
        const foreign = legacyOwners[mode] !== owner;
        let initial = foreign ? catalog.createDefaultArtifactProjection() : fullProjection(io.readLegacy(mode));
        initial = projectionWithPending(mode, initial);
        data = await client.initializeArtifactSettings(mode, initial, {expectedProfileId: owner});
        if (!allowed() || epoch !== generation || membership.profileId !== owner) return false;
      }
      receive(mode, data, true); ready[mode] = true;
      unwatch(mode); ready[mode] = true;
      subscriptions[mode] = client.subscribeArtifactSettings(mode, value => {
        if (!allowed() || epoch !== generation || membership.profileId !== owner) return;
        try {
          if (!value) { unwatch(mode); retry(); return; }
          receive(mode, value);
          replayPending();
        } catch (error) { fail(mode, error); }
      }, error => {
        if (epoch === generation && membership?.profileId === owner) fail(mode, error);
      }, {expectedProfileId: owner});
      return true;
    }
    function enqueueField(mode, effectId, field, value) {
      const local = state.modes[mode];
      if (local.terminal) return false;
      const reset = local.pending.findLast(op => op.type === 'reset');
      const afterResetId = reset?.id ?? null;
      const previous = local.pending.findLast(op => op.type === 'field' && op.effectId === effectId
        && op.field === field && op.afterResetId === afterResetId && op.id !== flight?.id);
      if (previous) previous.value = value;
      else local.pending.push({id: makeId(), type: 'field', effectId, field, value,
        baseResetEpoch: afterResetId ? null : local.lastKnownResetEpoch, afterResetId});
      if (local.pending.length > 100) return false;
      return save(state);
    }
    function enqueueReset(mode) {
      const local = state.modes[mode];
      if (local.terminal) return false;
      local.pending = local.pending.filter(op => op.id === flight?.id);
      local.pending.push({id: makeId(), type: 'reset'});
      return save(state);
    }
    function remember(entry) {
      if (entry.type === 'reset') transient = transient.filter(op => op.mode !== entry.mode);
      else transient = transient.filter(op => op.mode !== entry.mode || op.type !== 'field'
        || op.effectId !== entry.effectId || op.field !== entry.field);
      transient.push(entry);
      return true;
    }
    function change(mode, effectId, field, value) {
      if (!modes.includes(mode) || !validField(effectId, field, value) || disposed) return false;
      const accepted = state ? enqueueField(mode, effectId, field, value)
        : remember({type: 'field', mode, effectId, field, value});
      if (accepted && allowed()) queueMicrotask(() => {
        if (allowed()) { if (ready[mode]) replayPending(); else start(); }
      });
      return accepted;
    }
    function reset(mode) {
      if (!modes.includes(mode) || disposed) return false;
      const accepted = state ? enqueueReset(mode) : remember({type: 'reset', mode});
      if (accepted && allowed()) queueMicrotask(() => {
        if (allowed()) { if (ready[mode]) replayPending(); else start(); }
      });
      return accepted;
    }
    function replayPending() {
      if (!allowed()) return Promise.resolve(false);
      if (working) return working;
      const epoch = generation, owner = membership?.profileId;
      const task = (async () => {
        for (const mode of modes) {
          while (allowed() && epoch === generation && ready[mode] && !state.modes[mode].terminal) {
            const local = state.modes[mode], op = local.pending[0];
            if (!op) break;
            if (!save(state)) return false;
            const record = state;
            flight = {id: op.id, owner, mode};
            let failed = false;
            try {
              if (op.type === 'reset') {
                const result = await client.resetArtifactSettings(mode, {expectedProfileId: owner, returnState: true});
                if (!integer(result?.resetEpoch) || !integer(result?.revision) || result.revision < 1) invalid();
                const queue = record.modes[mode];
                queue.pending = queue.pending.filter(item => item.id !== op.id);
                for (const child of queue.pending) if (child.type === 'field' && child.afterResetId === op.id) {
                  child.afterResetId = null; child.baseResetEpoch = result.resetEpoch;
                }
                queue.lastKnownResetEpoch = Math.max(queue.lastKnownResetEpoch ?? 0, result.resetEpoch);
              } else {
                if (!integer(op.baseResetEpoch) || op.afterResetId !== null) invalid();
                await client.updateArtifactSetting(mode, op.effectId, {[op.field]: op.value},
                  {expectedProfileId: owner, expectedResetEpoch: op.baseResetEpoch});
                record.modes[mode].pending = record.modes[mode].pending.filter(item => item.id !== op.id);
              }
              if (!save(record)) return false;
            } catch (error) {
              if (error?.message === 'ARTIFACT_RESET_EPOCH_MISMATCH') {
                // The fresh read classifies stale fields by their original epoch.
              } else {
                if (epoch === generation) fail(mode, error);
                failed = true;
              }
            } finally { flight = undefined; }
            if (failed) break;
            if (!allowed() || epoch !== generation) return false;
            try {
              const confirmed = await client.getArtifactSettings(mode, {expectedProfileId: owner});
              if (!allowed() || epoch !== generation) return false;
              if (!confirmed) { unwatch(mode); retry(); break; }
              receive(mode, confirmed, true);
            } catch (error) { fail(mode, error); break; }
          }
        }
        return true;
      })().catch(() => { retry(); return false; });
      working = task;
      task.finally(() => {
        if (working !== task) return;
        working = undefined;
        // A gw edit can arrive while high's request is in flight, after gw's
        // turn in this pass. Drain it without relying on another browser event.
        if (allowed() && epoch === generation && modes.some(mode =>
          ready[mode] && !state.modes[mode].terminal && state.modes[mode].pending.length)) {
          queueMicrotask(replayPending);
        }
      });
      return task;
    }
    function start() {
      enabled = true;
      if (!allowed()) return Promise.resolve(false);
      if (starting) return starting;
      cancel(timer); timer = undefined;
      const epoch = generation;
      const task = (async () => {
        if (working) await working;
        if (!allowed() || epoch !== generation) return false;
        const identity = await client.getIdentity();
        if (!allowed() || epoch !== generation) return false;
        if (!identity || identity.active !== true || !id(identity.profileId) || !id(identity.deviceId)) return false;
        if (!bind(identity)) return false;
        const owner = identity.profileId;
        for (const mode of modes) {
          if (!allowed() || epoch !== generation) return false;
          try { await prepare(mode, epoch, owner); }
          catch (error) { fail(mode, error); }
        }
        failures = 0;
        return await replayPending();
      })().catch(() => { retry(); return false; });
      starting = task;
      task.finally(() => { if (starting === task) starting = undefined; });
      return task;
    }
    // Offline reloads still need a durable journal. A cached owner may own
    // local operations, but it never authorizes transport: start rechecks the
    // current server identity and every API uses an expected profile guard.
    try {
      const raw = io.storage.getItem(OWNER_KEY);
      if (raw !== null) {
        const marker = JSON.parse(raw);
        legacyOwners = readOwners();
        const persisted = io.storage.getItem(stateKey(marker.ownerProfileId));
        try { state = persisted === null ? emptyState(marker.ownerProfileId)
          : validateState(JSON.parse(persisted), marker.ownerProfileId); }
        catch (_) {
          state = emptyState(marker.ownerProfileId);
          for (const mode of modes) state.modes[mode].terminal = 'INVALID_SYNC_STATE';
        }
        membership = {profileId: marker.ownerProfileId};
        records.set(marker.ownerProfileId, state);
      }
    } catch (_) { storageFailed = true; }
    return Object.freeze({start, stop, change, reset, replayPending,
      snapshot: () => state ? clone(state) : null,
      dispose() { disposed = true; stop(); }});
  }

  function mountArtifactSync(io, scope = root) {
    let client, loading, generation = 0, disposed = false, suspended = false;
    const stops = [];
    const canSync = () => !disposed && !suspended && scope.navigator?.onLine !== false && !scope.document?.hidden;
    const listen = (target, event, handler) => {
      target?.addEventListener(event, handler);
      stops.push(() => target?.removeEventListener(event, handler));
    };
    const bridge = Object.fromEntries(['getIdentity', 'getArtifactSettings', 'initializeArtifactSettings',
      'updateArtifactSetting', 'resetArtifactSettings', 'subscribeArtifactSettings'].map(method =>
      [method, (...args) => {
        if (!client) throw new Error('SETTINGS_UNAVAILABLE');
        return client[method](...args);
      }]));
    const controller = createArtifactSync(bridge, {...io, canSync});
    async function start() {
      if (!canSync()) return false;
      if (loading) return loading;
      const epoch = generation;
      const task = (async () => {
        const settings = scope.MemberSync.environmentOptions(scope);
        if (!client) {
          for (const part of ['app', 'auth', 'firestore']) {
            if (part === 'app' ? scope.firebase?.initializeApp : scope.firebase?.[part]) continue;
            await new Promise((resolve, reject) => {
              const script = scope.document.createElement('script');
              script.src = settings.sdkBase + 'firebase-' + part + '-compat.js';
              script.onload = resolve; script.onerror = () => reject(new Error('NOT_READY'));
              scope.document.head.append(script);
            });
            if (!canSync() || epoch !== generation) return false;
          }
          client = scope.MemberSync.createMemberSync(scope.firebase, settings.firebaseConfig, settings.options);
        }
        const user = await client.restoreAuthentication();
        if (!canSync() || epoch !== generation || !user) return false;
        return await controller.start();
      })().catch(() => false);
      loading = task;
      task.finally(() => { if (loading === task) loading = undefined; });
      return task;
    }
    function stop() { generation++; loading = undefined; controller?.stop(); }
    function action(method, args) {
      controller[method](...args);
      if (canSync()) queueMicrotask(start);
    }
    listen(scope, 'pagehide', () => { suspended = true; stop(); });
    listen(scope, 'pageshow', () => { suspended = false; start(); });
    listen(scope, 'offline', stop);
    listen(scope, 'online', start);
    listen(scope, 'focus', start);
    listen(scope.document, 'visibilitychange', () => { if (scope.document.hidden) stop(); else start(); });
    const handle = Object.freeze({start, stop, change: (...args) => action('change', args),
      reset: (...args) => action('reset', args),
      replayPending: () => controller?.replayPending() || Promise.resolve(false),
      snapshot: () => controller?.snapshot() ?? null,
      dispose() { disposed = true; stop(); stops.splice(0).forEach(off => off()); }});
    start();
    return handle;
  }
  const api = Object.freeze({STATE_KEY_PREFIX, OWNER_KEY, fullProjection, mergeProjection,
    validateProjection, createArtifactSync, mountArtifactSync});
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ArtifactSync = api;
})(globalThis);
