/* Member identity foundation. Load after Firebase 10 compat app/auth/firestore.
 * Restoration never creates an account. Only an explicit action signs in.
 * Cloud settings remain opt-in and use the isolated member authentication.
 */
(function (root) {
  'use strict';
  const APP_NAME = 'member-sync';
  const HELL_LEVELS = Object.freeze(['90', '95', '100', '150', '200', '250']);
  const SETTINGS_FIELDS = ['schemaVersion', 'hellTimesSec', 'intervalSec', 'revision', 'createdAt', 'updatedAt', 'updatedByDeviceId'];
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const validHellSeconds = value => Number.isInteger(value) && value >= 0 && value <= 3599;
  const validInterval = value => typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= 15 && value === Math.round(value * 10) / 10;
  function validateSpeedValues(data) {
    if (!exactKeys(data.hellTimesSec, HELL_LEVELS)
        || !HELL_LEVELS.every(level => validHellSeconds(data.hellTimesSec[level]))
        || !validInterval(data.intervalSec)) throw new Error('INVALID_SETTINGS');
  }
  function validateSpeedSettings(data, Timestamp) {
    if (!exactKeys(data, SETTINGS_FIELDS) || data.schemaVersion !== 1
        || !Number.isSafeInteger(data.revision) || data.revision < 1
        || !(data.createdAt instanceof Timestamp) || !(data.updatedAt instanceof Timestamp)
        || !validId(data.updatedByDeviceId)) throw new Error('INVALID_SETTINGS');
    validateSpeedValues(data);
    return Object.freeze({...data, hellTimesSec: Object.freeze({...data.hellTimesSec})});
  }

  const HISTORY_READ_FIELDS = ['schemaVersion', 'seenIds', 'revision', 'createdAt', 'updatedAt', 'updatedByDeviceId'];
  // Match the Rules RE2 bound of 512 Unicode code points, including emoji.
  const validHistoryId = value => typeof value === 'string' && value.length > 0 && [...value].length <= 512;
  function validateHistoryIds(seenIds, maximum = 256) {
    if (!Array.isArray(seenIds) || seenIds.length > maximum
        || !Array.from(seenIds).every(validHistoryId) || new Set(seenIds).size !== seenIds.length) {
      throw new Error('INVALID_SETTINGS');
    }
  }
  function validateHistoryReadState(data, Timestamp) {
    if (!exactKeys(data, HISTORY_READ_FIELDS) || data.schemaVersion !== 1
        || !Number.isSafeInteger(data.revision) || data.revision < 1
        || !(data.createdAt instanceof Timestamp) || !(data.updatedAt instanceof Timestamp)
        || !validId(data.updatedByDeviceId)) throw new Error('INVALID_SETTINGS');
    validateHistoryIds(data.seenIds);
    return Object.freeze({...data, seenIds: Object.freeze([...data.seenIds])});
  }

  const ARTIFACT_SETTINGS_FIELDS = ['schemaVersion', 'catalogVersion', 'resetEpoch', 'items',
    'revision', 'createdAt', 'updatedAt', 'updatedByDeviceId'];
  function artifactCatalog() {
    // Existing pages need not load the catalog until an Artifact API is used.
    // Loading this member client never starts another script or network request.
    const catalog = typeof module === 'object' && module.exports
      ? require('./artifact-catalog') : root.ArtifactCatalog;
    if (!catalog || catalog.ARTIFACT_CATALOG_VERSION !== 1
        || !Array.isArray(catalog.ARTIFACT_CATALOG)) throw new Error('SETTINGS_UNAVAILABLE');
    return catalog;
  }
  function artifactDocument(mode) {
    if (mode === 'gw') return 'awakeningGw';
    if (mode === 'high') return 'awakeningHigh';
    throw new Error('INVALID_SETTINGS');
  }
  function copyArtifactGuard(guard, allowed) {
    if (guard === undefined) return undefined;
    if (!guard || typeof guard !== 'object' || Array.isArray(guard)
        || !Reflect.ownKeys(guard).every(key => allowed.includes(key))) throw new Error('INVALID_SETTINGS');
    const copy = {};
    for (const key of Reflect.ownKeys(guard)) {
      const value = guard[key];
      if (key === 'expectedProfileId' ? !validId(value)
        : key === 'expectedResetEpoch' ? !Number.isSafeInteger(value) || value < 0
          : typeof value !== 'boolean') throw new Error('INVALID_SETTINGS');
      copy[key] = value;
    }
    return Object.freeze(copy);
  }
  function copyArtifactItems(items, catalog) {
    const definitions = catalog.ARTIFACT_CATALOG;
    if (!exactKeys(items, definitions.map(item => item.effectId))) throw new Error('INVALID_SETTINGS');
    return Object.fromEntries(definitions.map(item => {
      const value = items[item.effectId];
      const fields = item.values ? ['needed', 'selectedValue'] : ['needed'];
      if (!exactKeys(value, fields) || typeof value.needed !== 'boolean'
          || (item.values && (typeof value.selectedValue !== 'string'
            || !item.values.includes(value.selectedValue)))) throw new Error('INVALID_SETTINGS');
      return [item.effectId, item.values
        ? {needed: value.needed, selectedValue: value.selectedValue} : {needed: value.needed}];
    }));
  }
  function copyArtifactProjection(projection) {
    const catalog = artifactCatalog();
    if (!exactKeys(projection, ['catalogVersion', 'items'])
        || projection.catalogVersion !== catalog.ARTIFACT_CATALOG_VERSION) throw new Error('INVALID_SETTINGS');
    return {catalogVersion: catalog.ARTIFACT_CATALOG_VERSION, items: copyArtifactItems(projection.items, catalog)};
  }
  function copyArtifactTimestamp(value, Timestamp) {
    if (!(value instanceof Timestamp) || !Number.isSafeInteger(value.seconds)
        || !Number.isInteger(value.nanoseconds) || value.nanoseconds < 0 || value.nanoseconds >= 1000000000) {
      throw new Error('INVALID_SETTINGS');
    }
    try { return Object.freeze(new Timestamp(value.seconds, value.nanoseconds)); }
    catch (_) { throw new Error('INVALID_SETTINGS'); }
  }
  function validateArtifactSettings(data, Timestamp) {
    const catalog = artifactCatalog();
    if (!exactKeys(data, ARTIFACT_SETTINGS_FIELDS) || data.schemaVersion !== 1
        || data.catalogVersion !== catalog.ARTIFACT_CATALOG_VERSION
        || !Number.isSafeInteger(data.resetEpoch) || data.resetEpoch < 0
        || !Number.isSafeInteger(data.revision) || data.revision < 1
        || !validId(data.updatedByDeviceId)) throw new Error('INVALID_SETTINGS');
    const items = copyArtifactItems(data.items, catalog);
    Object.values(items).forEach(Object.freeze);
    return Object.freeze({...data, items: Object.freeze(items),
      createdAt: copyArtifactTimestamp(data.createdAt, Timestamp),
      updatedAt: copyArtifactTimestamp(data.updatedAt, Timestamp)});
  }

  function createMemberSync(firebase, config, options = {}) {
    let connection;
    let starting;
    let signingIn;

    async function restoreAuthentication() {
      if (starting) return starting;
      starting = (async () => {
        if (!connection) {
          const existing = firebase.apps.find(app => app.name === APP_NAME);
          if (existing && (existing.options.projectId !== config.projectId
              || existing.options.apiKey !== config.apiKey
              || existing.options.appId !== config.appId)) {
            throw new Error('member-sync Firebase configuration mismatch');
          }
          const app = existing || firebase.initializeApp(config, APP_NAME);
          connection = { app, auth: app.auth(), db: app.firestore() };
          if (!existing && options.connectEmulators) options.connectEmulators(connection);
        }
        const { auth } = connection;
        await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
        // Wait for persisted credentials before deciding to create an account.
        await new Promise((resolve, reject) => {
          let unsubscribe;
          unsubscribe = auth.onAuthStateChanged(() => {
            Promise.resolve().then(() => { unsubscribe(); resolve(); });
          }, error => {
            Promise.resolve().then(() => { unsubscribe(); reject(error); });
          });
        });
        if (auth.currentUser && !auth.currentUser.isAnonymous) {
          throw new Error('member-sync requires its own anonymous authentication');
        }
        return auth.currentUser;
      })();
      try { return await starting; }
      finally { starting = null; }
    }

    async function startAuthentication() {
      await restoreAuthentication();
      if (!connection.auth.currentUser) {
        if (!signingIn) signingIn = connection.auth.signInAnonymously();
        try { await signingIn; } finally { signingIn = null; }
      }
      if (!connection.auth.currentUser?.isAnonymous) throw new Error('UNAUTHENTICATED');
      return connection.auth.currentUser;
    }

    async function request(path, body) {
      const user = connection?.auth.currentUser;
      if (!user?.isAnonymous) throw new Error('UNAUTHENTICATED');
      let token;
      try { token = await user.getIdToken(); }
      catch (error) {
        if (['auth/user-disabled', 'auth/user-token-expired', 'auth/invalid-user-token', 'auth/user-not-found'].includes(error.code)) {
          throw new Error('UNAUTHENTICATED');
        }
        throw error;
      }
      if (connection.auth.currentUser !== user) throw new Error('UNAUTHENTICATED');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await (options.fetch || root.fetch)(options.apiBase + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal
        });
        const data = await response.json();
        if (connection.auth.currentUser !== user) throw new Error('UNAUTHENTICATED');
        if (!response.ok) throw new Error(data?.error?.code || 'NETWORK');
        return data;
      } finally { clearTimeout(timeout); }
    }

    async function getIdentity() {
      const user = connection?.auth.currentUser;
      if (!user?.isAnonymous) throw new Error('Start member authentication first');
      // Server read avoids treating a revoked, cached membership as current.
      const snapshot = await connection.db.doc('memberIdentities/' + user.uid)
        .get({ source: 'server' });
      return snapshot.exists ? snapshot.data() : null;
    }

    function assertSettingsUser(user) {
      if (!user?.isAnonymous || connection?.auth.currentUser !== user) throw new Error('UNAUTHENTICATED');
    }
    function assertSettingsIdentity(identity, expected) {
      if (!identity || identity.active !== true || !validId(identity.profileId) || !validId(identity.deviceId)
          || (expected && (identity.profileId !== expected.profileId || identity.deviceId !== expected.deviceId))) {
        throw new Error('MEMBERSHIP_REQUIRED');
      }
    }
    async function settingsContext() {
      const user = connection?.auth.currentUser;
      assertSettingsUser(user);
      const identity = await getIdentity();
      assertSettingsUser(user);
      assertSettingsIdentity(identity);
      return {user, identity,
        identityRef: connection.db.doc('memberIdentities/' + user.uid),
        ref: connection.db.doc('memberProfiles/' + identity.profileId + '/settings/speedCalculator')};
    }
    const validatedSettings = snapshot => snapshot.exists
      ? validateSpeedSettings(snapshot.data(), firebase.firestore.Timestamp) : null;

    async function getSpeedCalculatorSettings() {
      const context = await settingsContext();
      const snapshot = await context.ref.get({source: 'server'});
      assertSettingsUser(context.user);
      return validatedSettings(snapshot);
    }

    async function initializeSpeedCalculatorSettings(initialSettings) {
      if (!exactKeys(initialSettings, ['hellTimesSec', 'intervalSec'])) throw new Error('INVALID_SETTINGS');
      validateSpeedValues(initialSettings);
      // Copy before awaiting so callers cannot mutate transaction inputs.
      const initial = {hellTimesSec: {...initialSettings.hellTimesSec}, intervalSec: initialSettings.intervalSec};
      const context = await settingsContext();
      const existing = await connection.db.runTransaction(async transaction => {
        assertSettingsUser(context.user);
        const identity = await transaction.get(context.identityRef);
        assertSettingsIdentity(identity.data(), context.identity);
        const snapshot = await transaction.get(context.ref);
        assertSettingsUser(context.user);
        if (snapshot.exists) return validatedSettings(snapshot);
        transaction.set(context.ref, {schemaVersion: 1, ...initial, revision: 1,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedByDeviceId: context.identity.deviceId});
        return null;
      });
      assertSettingsUser(context.user);
      // Resolve server timestamps; never return an optimistic/pending document.
      if (existing) return existing;
      const snapshot = await context.ref.get({source: 'server'});
      assertSettingsUser(context.user);
      return validatedSettings(snapshot);
    }

    async function updateSpeedCalculatorField(field, value) {
      if (field === 'intervalSec') {
        if (!validInterval(value)) throw new Error('INVALID_SETTINGS');
      } else if (!HELL_LEVELS.some(level => field === 'hellTimesSec.' + level) || !validHellSeconds(value)) {
        throw new Error('INVALID_SETTINGS');
      }
      const context = await settingsContext();
      const revision = await connection.db.runTransaction(async transaction => {
        assertSettingsUser(context.user);
        const identity = await transaction.get(context.identityRef);
        assertSettingsIdentity(identity.data(), context.identity);
        const snapshot = await transaction.get(context.ref);
        const latest = validatedSettings(snapshot);
        if (!latest) throw new Error('SETTINGS_NOT_INITIALIZED');
        if (latest.revision === Number.MAX_SAFE_INTEGER) throw new Error('INVALID_SETTINGS');
        assertSettingsUser(context.user);
        const nextRevision = latest.revision + 1;
        // The server-side transform also satisfies revision +1 during concurrent
        // rule evaluation; the transaction read precondition still forces retry.
        transaction.update(context.ref, {[field]: value, revision: firebase.firestore.FieldValue.increment(1),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedByDeviceId: context.identity.deviceId});
        return nextRevision;
      });
      assertSettingsUser(context.user);
      return revision;
    }

    // Returns unsubscribe immediately, including while identity lookup is pending.
    // callback receives validated, server-confirmed data (or null for absence).
    function subscribeSpeedCalculatorSettings(callback, onError = () => {}) {
      if (typeof callback !== 'function' || typeof onError !== 'function') throw new TypeError('Callbacks required');
      let stopped = false, watchingSettings = false;
      const stops = [];
      const unsubscribe = () => { if (!stopped) { stopped = true; stops.splice(0).forEach(stop => stop()); } };
      const track = stop => { if (stopped) stop(); else stops.push(stop); };
      const fail = error => {
        if (stopped) return;
        unsubscribe();
        const code = ['UNAUTHENTICATED','MEMBERSHIP_REQUIRED','INVALID_SETTINGS'].includes(error?.message)
          ? error.message : 'SETTINGS_UNAVAILABLE';
        onError(new Error(code));
      };
      (async () => {
        try {
          const context = await settingsContext();
          if (stopped) return;
          track(connection.auth.onAuthStateChanged(user => {
            if (user !== context.user || !user?.isAnonymous) fail(new Error('UNAUTHENTICATED'));
          }, fail));
          track(context.identityRef.onSnapshot({includeMetadataChanges: true}, snapshot => {
            if (stopped) return;
            try {
              assertSettingsUser(context.user);
              if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
              assertSettingsIdentity(snapshot.data(), context.identity);
              if (watchingSettings) return;
              watchingSettings = true;
              track(context.ref.onSnapshot({includeMetadataChanges: true}, settings => {
                if (stopped) return;
                let data;
                try {
                  assertSettingsUser(context.user);
                  if (settings.metadata.fromCache || settings.metadata.hasPendingWrites) return;
                  data = validatedSettings(settings);
                } catch (error) { fail(error); return; }
                callback(data);
              }, fail));
            } catch (error) { fail(error); }
          }, fail));
        } catch (error) { fail(error); }
      })();
      return unsubscribe;
    }

    function assertHistoryMembership(profile, device) {
      if (!profile.exists || profile.data()?.status !== 'active'
          || !device.exists || device.data()?.status !== 'active') throw new Error('MEMBERSHIP_REQUIRED');
    }
    // Controllers bind pending to one membership. A stale operation must never
    // derive a different destination from credentials that changed meanwhile.
    function expectedHistoryMembership(expectedIdentity) {
      if (expectedIdentity === undefined) return undefined;
      if (!expectedIdentity || !validId(expectedIdentity.profileId) || !validId(expectedIdentity.deviceId)) {
        throw new Error('MEMBERSHIP_REQUIRED');
      }
      return {identity: Object.freeze({profileId: expectedIdentity.profileId, deviceId: expectedIdentity.deviceId})};
    }
    async function historyReadContext(expected) {
      const user = connection?.auth.currentUser;
      assertSettingsUser(user);
      if (expected?.user) assertSettingsUser(expected.user);
      const identity = await getIdentity();
      assertSettingsUser(user);
      assertSettingsIdentity(identity, expected?.identity);
      const base = 'memberProfiles/' + identity.profileId;
      const context = {user, identity,
        identityRef: connection.db.doc('memberIdentities/' + user.uid),
        profileRef: connection.db.doc(base),
        deviceRef: connection.db.doc(base + '/devices/' + identity.deviceId),
        ref: connection.db.doc(base + '/settings/historyReadState')};
      const [profile, device] = await Promise.all([
        context.profileRef.get({source: 'server'}), context.deviceRef.get({source: 'server'})
      ]);
      assertSettingsUser(user);
      assertHistoryMembership(profile, device);
      return context;
    }
    async function assertHistoryTransaction(transaction, context) {
      assertSettingsUser(context.user);
      const [identity, profile, device] = await Promise.all([
        transaction.get(context.identityRef), transaction.get(context.profileRef), transaction.get(context.deviceRef)
      ]);
      assertSettingsUser(context.user);
      assertSettingsIdentity(identity.data(), context.identity);
      assertHistoryMembership(profile, device);
    }
    const validatedHistory = snapshot => snapshot.exists
      ? validateHistoryReadState(snapshot.data(), firebase.firestore.Timestamp) : null;
    const newHistoryReadState = (seenIds, deviceId) => ({schemaVersion: 1, seenIds, revision: 1,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedByDeviceId: deviceId});

    async function historyTransaction(context, operation) {
      // Rules can reject a stale transform before Firestore reports the read
      // conflict. Retry only proven revision progress within this membership;
      // genuine denials and offline failures must remain failures.
      for (let attempt = 0; ; attempt++) {
        let observedRevision;
        try {
          return await connection.db.runTransaction(async transaction => {
            observedRevision = undefined;
            await assertHistoryTransaction(transaction, context);
            const snapshot = await transaction.get(context.ref);
            assertSettingsUser(context.user);
            const latest = validatedHistory(snapshot);
            observedRevision = latest?.revision ?? 0;
            return operation(transaction, latest);
          });
        } catch (error) {
          if (error?.code !== 'permission-denied' || observedRevision === undefined || attempt >= 2) throw error;
          const fresh = await historyReadContext(context);
          const snapshot = await fresh.ref.get({source: 'server'});
          assertSettingsUser(context.user);
          const latest = validatedHistory(snapshot);
          if (!latest || latest.revision <= observedRevision) throw error;
        }
      }
    }

    async function getHistoryReadState(expectedIdentity) {
      const context = await historyReadContext(expectedHistoryMembership(expectedIdentity));
      const snapshot = await context.ref.get({source: 'server'});
      assertSettingsUser(context.user);
      return validatedHistory(snapshot);
    }

    async function initializeHistoryReadState(initialSeenIds, expectedIdentity) {
      validateHistoryIds(initialSeenIds, 1);
      const initial = [...initialSeenIds];
      const context = await historyReadContext(expectedHistoryMembership(expectedIdentity));
      const existing = await historyTransaction(context, (transaction, latest) => {
        if (latest) return latest;
        transaction.set(context.ref, newHistoryReadState(initial, context.identity.deviceId));
        return null;
      });
      assertSettingsUser(context.user);
      if (existing) return existing;
      // Resolve server timestamps rather than returning a pending local write.
      const snapshot = await context.ref.get({source: 'server'});
      assertSettingsUser(context.user);
      return validatedHistory(snapshot);
    }

    async function markHistorySeen(historyId, expectedIdentity) {
      if (!validHistoryId(historyId)) throw new Error('INVALID_SETTINGS');
      const context = await historyReadContext(expectedHistoryMembership(expectedIdentity));
      const revision = await historyTransaction(context, (transaction, latest) => {
        if (!latest) {
          transaction.set(context.ref, newHistoryReadState([historyId], context.identity.deviceId));
          return 1;
        }
        // An existing ID remains a complete no-op, even at either upper limit.
        if (latest.seenIds.includes(historyId)) return latest.revision;
        if (latest.seenIds.length === 256) throw new Error('HISTORY_READ_LIMIT');
        if (latest.revision === Number.MAX_SAFE_INTEGER) throw new Error('INVALID_SETTINGS');
        // Apply the union to the server's current array during Rules evaluation;
        // the transaction read precondition still retries concurrent writers.
        transaction.update(context.ref, {seenIds: firebase.firestore.FieldValue.arrayUnion(historyId),
          revision: firebase.firestore.FieldValue.increment(1),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedByDeviceId: context.identity.deviceId});
        return latest.revision + 1;
      });
      assertSettingsUser(context.user);
      return revision;
    }

    function subscribeHistoryReadState(callback, onError = () => {}, expectedIdentity) {
      if (typeof callback !== 'function' || typeof onError !== 'function') throw new TypeError('Callbacks required');
      const expected = expectedHistoryMembership(expectedIdentity);
      let stopped = false, watchingSettings = false;
      const stops = [], confirmed = new Set();
      const unsubscribe = () => { if (!stopped) { stopped = true; stops.splice(0).forEach(stop => stop()); } };
      const track = stop => { if (stopped) stop(); else stops.push(stop); };
      const fail = error => {
        if (stopped) return;
        unsubscribe();
        const code = ['UNAUTHENTICATED', 'MEMBERSHIP_REQUIRED', 'INVALID_SETTINGS'].includes(error?.message)
          ? error.message : 'SETTINGS_UNAVAILABLE';
        onError(new Error(code));
      };
      // Dispatch outside listener registration and validation catches. Exceptions
      // thrown by consumer callbacks must not be reported as malformed documents.
      const dispatch = handler => value => queueMicrotask(() => { if (!stopped) handler(value); });
      (async () => {
        try {
          const context = await historyReadContext(expected);
          if (stopped) return;
          track(connection.auth.onAuthStateChanged(dispatch(user => {
            if (user !== context.user || !user?.isAnonymous) fail(new Error('UNAUTHENTICATED'));
          }), dispatch(fail)));
          const watchMembership = (key, ref, validate) => {
            track(ref.onSnapshot({includeMetadataChanges: true}, dispatch(snapshot => {
              try {
                assertSettingsUser(context.user);
                if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
                validate(snapshot);
              } catch (error) { fail(error); return; }
              confirmed.add(key);
              if (watchingSettings || confirmed.size !== 3) return;
              watchingSettings = true;
              try {
                track(context.ref.onSnapshot({includeMetadataChanges: true}, dispatch(settings => {
                  let data;
                  try {
                    assertSettingsUser(context.user);
                    if (settings.metadata.fromCache || settings.metadata.hasPendingWrites) return;
                    data = validatedHistory(settings);
                  } catch (error) { fail(error); return; }
                  callback(data);
                }), dispatch(fail)));
              } catch (error) { fail(error); }
            }), dispatch(fail)));
          };
          watchMembership('identity', context.identityRef, snapshot => assertSettingsIdentity(snapshot.data(), context.identity));
          const active = snapshot => {
            if (!snapshot.exists || snapshot.data()?.status !== 'active') throw new Error('MEMBERSHIP_REQUIRED');
          };
          watchMembership('profile', context.profileRef, active);
          watchMembership('device', context.deviceRef, active);
        } catch (error) { fail(error); }
      })();
      return unsubscribe;
    }

    async function artifactSettingsContext(mode, expected, guard = expected?.artifactGuard) {
      const document = artifactDocument(mode);
      // Reuse the same server-confirmed active membership as History without
      // reading its settings document. Callers can select only these two modes.
      const context = await historyReadContext(expected);
      if (guard?.expectedProfileId !== undefined && context.identity.profileId !== guard.expectedProfileId) {
        throw new Error('MEMBERSHIP_REQUIRED');
      }
      return {...context, artifactMode: mode, artifactGuard: guard,
        ref: connection.db.doc('memberProfiles/' + context.identity.profileId + '/settings/' + document)};
    }
    const validatedArtifact = snapshot => snapshot.exists
      ? validateArtifactSettings(snapshot.data(), firebase.firestore.Timestamp) : null;

    async function artifactTransaction(context, operation) {
      for (let attempt = 0; ; attempt++) {
        let observedRevision;
        try {
          return await connection.db.runTransaction(async transaction => {
            observedRevision = undefined;
            await assertHistoryTransaction(transaction, context);
            const snapshot = await transaction.get(context.ref);
            assertSettingsUser(context.user);
            const latest = validatedArtifact(snapshot);
            observedRevision = latest?.revision ?? 0;
            return operation(transaction, latest);
          });
        } catch (error) {
          // Recover only a proven concurrent commit, never an actual denial.
          if (error?.code !== 'permission-denied' || observedRevision === undefined || attempt >= 2) throw error;
          const fresh = await artifactSettingsContext(context.artifactMode, context);
          const snapshot = await fresh.ref.get({source: 'server'});
          assertSettingsUser(context.user);
          const latest = validatedArtifact(snapshot);
          if (!latest || latest.revision <= observedRevision) throw error;
        }
      }
    }

    async function getArtifactSettings(mode, guard) {
      artifactDocument(mode);
      const expected = copyArtifactGuard(guard, ['expectedProfileId']);
      const context = await artifactSettingsContext(mode, undefined, expected);
      const snapshot = await context.ref.get({source: 'server'});
      assertSettingsUser(context.user);
      return validatedArtifact(snapshot);
    }

    async function initializeArtifactSettings(mode, projection, guard) {
      artifactDocument(mode);
      const expected = copyArtifactGuard(guard, ['expectedProfileId']);
      // Validate and copy all caller input before authentication or any await.
      const initial = copyArtifactProjection(projection);
      const context = await artifactSettingsContext(mode, undefined, expected);
      const existing = await artifactTransaction(context, (transaction, latest) => {
        if (latest) return latest;
        transaction.set(context.ref, {schemaVersion: 1, ...initial, resetEpoch: 0, revision: 1,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedByDeviceId: context.identity.deviceId});
        return null;
      });
      assertSettingsUser(context.user);
      if (existing) return existing;
      const snapshot = await context.ref.get({source: 'server'});
      assertSettingsUser(context.user);
      return validatedArtifact(snapshot);
    }

    async function updateArtifactSetting(mode, effectId, patch, guard) {
      artifactDocument(mode);
      const expected = copyArtifactGuard(guard, ['expectedProfileId', 'expectedResetEpoch']);
      const item = artifactCatalog().ARTIFACT_CATALOG.find(item => item.effectId === effectId);
      const fields = patch && typeof patch === 'object' && !Array.isArray(patch) ? Reflect.ownKeys(patch) : [];
      const field = fields[0], value = patch?.[field];
      if (!item || fields.length !== 1
          || (field === 'needed' ? typeof value !== 'boolean'
            : field !== 'selectedValue' || !item.values || typeof value !== 'string' || !item.values.includes(value))) {
        throw new Error('INVALID_SETTINGS');
      }
      const context = await artifactSettingsContext(mode, undefined, expected);
      const revision = await artifactTransaction(context, (transaction, latest) => {
        if (!latest) throw new Error('SETTINGS_NOT_INITIALIZED');
        // This comparison also runs on every transaction retry, before no-op.
        if (expected?.expectedResetEpoch !== undefined && latest.resetEpoch !== expected.expectedResetEpoch) {
          throw new Error('ARTIFACT_RESET_EPOCH_MISMATCH');
        }
        if (latest.items[effectId][field] === value) return latest.revision;
        if (latest.revision === Number.MAX_SAFE_INTEGER) throw new Error('INVALID_SETTINGS');
        transaction.update(context.ref, {['items.' + effectId + '.' + field]: value,
          revision: firebase.firestore.FieldValue.increment(1),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedByDeviceId: context.identity.deviceId});
        return latest.revision + 1;
      });
      assertSettingsUser(context.user);
      return revision;
    }

    async function resetArtifactSettings(mode, guard) {
      artifactDocument(mode);
      const expected = copyArtifactGuard(guard, ['expectedProfileId', 'returnState']);
      const defaults = copyArtifactProjection(artifactCatalog().createDefaultArtifactProjection());
      const context = await artifactSettingsContext(mode, undefined, expected);
      const result = await artifactTransaction(context, (transaction, latest) => {
        if (!latest) throw new Error('SETTINGS_NOT_INITIALIZED');
        if (latest.revision === Number.MAX_SAFE_INTEGER || latest.resetEpoch === Number.MAX_SAFE_INTEGER) {
          throw new Error('INVALID_SETTINGS');
        }
        transaction.update(context.ref, {items: defaults.items,
          resetEpoch: firebase.firestore.FieldValue.increment(1),
          revision: firebase.firestore.FieldValue.increment(1),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedByDeviceId: context.identity.deviceId});
        // Capture this reset's committed epoch, rather than a later get which
        // could already contain another device's subsequent reset boundary.
        return Object.freeze({revision: latest.revision + 1, resetEpoch: latest.resetEpoch + 1});
      });
      assertSettingsUser(context.user);
      return expected?.returnState ? result : result.revision;
    }

    function subscribeArtifactSettings(mode, callback, onError = () => {}, guard) {
      artifactDocument(mode);
      const expected = copyArtifactGuard(guard, ['expectedProfileId']);
      if (typeof callback !== 'function' || typeof onError !== 'function') throw new TypeError('Callbacks required');
      let stopped = false, watchingSettings = false;
      const stops = [], confirmed = new Set();
      const unsubscribe = () => { if (!stopped) { stopped = true; stops.splice(0).forEach(stop => stop()); } };
      const track = stop => { if (stopped) stop(); else stops.push(stop); };
      const fail = error => {
        if (stopped) return;
        unsubscribe();
        const code = ['UNAUTHENTICATED', 'MEMBERSHIP_REQUIRED', 'INVALID_SETTINGS'].includes(error?.message)
          ? error.message : 'SETTINGS_UNAVAILABLE';
        onError(new Error(code));
      };
      const dispatch = handler => value => queueMicrotask(() => { if (!stopped) handler(value); });
      (async () => {
        try {
          const context = await artifactSettingsContext(mode, undefined, expected);
          if (stopped) return;
          track(connection.auth.onAuthStateChanged(dispatch(user => {
            if (user !== context.user || !user?.isAnonymous) fail(new Error('UNAUTHENTICATED'));
          }), dispatch(fail)));
          const watchMembership = (key, ref, validate) => {
            track(ref.onSnapshot({includeMetadataChanges: true}, dispatch(snapshot => {
              try {
                assertSettingsUser(context.user);
                if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
                validate(snapshot);
              } catch (error) { fail(error); return; }
              confirmed.add(key);
              if (watchingSettings || confirmed.size !== 3) return;
              watchingSettings = true;
              try {
                track(context.ref.onSnapshot({includeMetadataChanges: true}, dispatch(settings => {
                  let data;
                  try {
                    assertSettingsUser(context.user);
                    if (settings.metadata.fromCache || settings.metadata.hasPendingWrites) return;
                    data = validatedArtifact(settings);
                  } catch (error) { fail(error); return; }
                  callback(data);
                }), dispatch(fail)));
              } catch (error) { fail(error); }
            }), dispatch(fail)));
          };
          watchMembership('identity', context.identityRef, snapshot => assertSettingsIdentity(snapshot.data(), context.identity));
          const active = snapshot => {
            if (!snapshot.exists || snapshot.data()?.status !== 'active') throw new Error('MEMBERSHIP_REQUIRED');
          };
          watchMembership('profile', context.profileRef, active);
          watchMembership('device', context.deviceRef, active);
        } catch (error) { fail(error); }
      })();
      return unsubscribe;
    }

    return Object.freeze({ startAuthentication, restoreAuthentication, getIdentity, request,
      getSpeedCalculatorSettings, initializeSpeedCalculatorSettings, updateSpeedCalculatorField,
      subscribeSpeedCalculatorSettings, getHistoryReadState, initializeHistoryReadState,
      markHistorySeen, subscribeHistoryReadState, getArtifactSettings, initializeArtifactSettings,
      updateArtifactSetting, resetArtifactSettings, subscribeArtifactSettings });
  }

  // One controller per calculator; only explicit input events queue writes.
  // pendingIO = { load: () => Object, save: (field, value) => void, remove: (field) => void }
  // All pendingIO methods are optional; calculator manages the localStorage key.
  function createSpeedCalculatorSync(client, readLocal, applyRemote, pendingIO = {}) {
    const VALID_PENDING_FIELDS = new Set(
      ['intervalSec', ...HELL_LEVELS.map(l => 'hellTimesSec.' + l)]
    );
    let cloudSyncReady = false, isApplyingRemoteSettings = false, isReplayingPending = false;
    let lastCloudSettings = null, cloudSubscription, starting = false, generation = 0;
    const pending = new Map(), inFlight = new Map(), acknowledged = new Map();
    // persistedPending: field → value loaded from / saved to localStorage via pendingIO.
    // It is NOT cleared on stop() so it survives temporary sync interruptions.
    const persistedPending = new Map();
    const fieldValue = (settings, field) => field === 'intervalSec'
      ? settings?.intervalSec : settings?.hellTimesSec[field.split('.')[1]];
    function stop() {
      generation++; starting = false; cloudSyncReady = false; isReplayingPending = false;
      cloudSubscription?.(); cloudSubscription = null;
      pending.forEach(entry => clearTimeout(entry.timer)); pending.clear();
      inFlight.clear(); acknowledged.clear(); lastCloudSettings = null;
      // persistedPending is intentionally preserved across stop().
    }
    function receive(settings) {
      if (!settings) { stop(); return; }
      if (lastCloudSettings && settings.revision < lastCloudSettings.revision) return;
      isApplyingRemoteSettings = true;
      try {
        // Keep unsubmitted edits visible when another field's snapshot arrives.
        const visible = {...settings, hellTimesSec: {...settings.hellTimesSec}};
        // Overlay persisted pending (lower priority) for fields not in in-memory pending.
        persistedPending.forEach((value, field) => {
          if (!pending.has(field)) {
            if (field === 'intervalSec') visible.intervalSec = value;
            else visible.hellTimesSec[field.split('.')[1]] = value;
          }
        });
        // Overlay in-memory pending (higher priority) — takes precedence over persistedPending.
        pending.forEach((entry, field) => {
          if (field === 'intervalSec') visible.intervalSec = entry.value;
          else visible.hellTimesSec[field.split('.')[1]] = entry.value;
        });
        applyRemote(visible);
        lastCloudSettings = settings;
        acknowledged.forEach((write, field) => {
          if (settings.revision >= write.revision) acknowledged.delete(field);
        });
      } finally { isApplyingRemoteSettings = false; }
    }
    // Load persisted pending from localStorage and populate persistedPending Map.
    function loadPersistedPending() {
      let loaded;
      try { loaded = pendingIO.load?.(); } catch { return; }
      if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) return;
      for (const [field, value] of Object.entries(loaded)) {
        if (!VALID_PENDING_FIELDS.has(field)) continue;
        const valid = field === 'intervalSec' ? validInterval(value) : validHellSeconds(value);
        if (!valid) continue;
        persistedPending.set(field, value);
      }
    }
    // Replay all persistedPending fields to the cloud, field by field (section 17).
    // Concurrent fields are submitted in parallel; same field is never replayed twice at once.
    async function replayPending() {
      if (!cloudSyncReady || isReplayingPending) return;
      if (persistedPending.size === 0) return;
      isReplayingPending = true;
      const epoch = generation;
      try {
        const replays = [];
        persistedPending.forEach((value, field) => {
          // Skip fields that have an active in-flight write to avoid concurrent writes.
          if (inFlight.has(field)) return;
          replays.push((async () => {
            let retries = 3;
            while (retries > 0) {
              if (epoch !== generation) return;
              try {
                await client.updateSpeedCalculatorField(field, value);
                if (epoch !== generation) return;
                // Delete only if persistedPending still holds the exact replayed value (section 19).
                if (persistedPending.get(field) === value) {
                  persistedPending.delete(field);
                  try { pendingIO.remove?.(field); } catch {}
                }
                return;
              } catch {
                retries--;
                if (retries === 0) return; // failure: keep field in persistedPending
                await new Promise(r => setTimeout(r, 2000));
              }
            }
          })());
        });
        await Promise.all(replays);
      } finally {
        if (epoch === generation) isReplayingPending = false;
      }
    }
    async function start() {
      if (starting || cloudSyncReady) return;
      starting = true;
      const epoch = generation;
      // Load persisted pending from localStorage before fetching cloud settings.
      loadPersistedPending();
      try {
        let settings = await client.getSpeedCalculatorSettings();
        if (epoch !== generation) return;
        if (!settings) settings = await client.initializeSpeedCalculatorSettings(readLocal());
        if (epoch !== generation) return;
        // Remove persistedPending entries whose values already match the cloud (section 16).
        persistedPending.forEach((value, field) => {
          if (fieldValue(settings, field) === value) {
            persistedPending.delete(field);
            try { pendingIO.remove?.(field); } catch {}
          }
        });
        receive(settings);
        if (epoch !== generation) return;
        cloudSyncReady = true;
        cloudSubscription = client.subscribeSpeedCalculatorSettings(settings => {
          if (epoch === generation) receive(settings);
        }, () => { if (epoch === generation) stop(); });
        // Replay any persisted pending after cloud sync is established (section 14).
        replayPending();
      } catch { if (epoch === generation) stop(); }
      finally { if (epoch === generation) starting = false; }
    }
    function change(field, value) {
      if (!cloudSyncReady || isApplyingRemoteSettings) return;
      if (field === 'intervalSec' ? !validInterval(value)
          : !HELL_LEVELS.some(level => field === 'hellTimesSec.' + level) || !validHellSeconds(value)) return;
      const previous = pending.get(field);
      if (previous?.value === value) return;
      if (previous) clearTimeout(previous.timer);
      pending.delete(field);
      const knownValue = () => acknowledged.has(field)
        ? acknowledged.get(field).value : fieldValue(lastCloudSettings, field);
      if (!inFlight.has(field) && knownValue() === value) return;
      const epoch = generation;
      const entry = {value};
      pending.set(field, entry);
      entry.timer = setTimeout(async () => {
        // Keep the in-flight write separate from the replaceable debounce entry.
        await inFlight.get(field);
        if (epoch !== generation || pending.get(field) !== entry) return;
        if (knownValue() === value) { pending.delete(field); return; }
        entry.sending = true;
        const sending = (async () => {
          let committedRevision;
          try {
            const revision = await client.updateSpeedCalculatorField(field, value);
            committedRevision = revision;
            if (epoch !== generation) return;
            if (!lastCloudSettings || lastCloudSettings.revision < revision) acknowledged.set(field, {value, revision});
            // Clear persistedPending on success (section 20):
            // Safe to delete if this entry is still current (no newer write happened),
            // or if persistedPending still has the same value we just committed.
            const isCurrent = pending.get(field) === entry;
            if (isCurrent || persistedPending.get(field) === value) {
              if (persistedPending.has(field)) {
                persistedPending.delete(field);
                try { pendingIO.remove?.(field); } catch {}
              }
            }
          } catch {
            // Write failed: save to persistedPending so it survives reload (section 7).
            if (epoch === generation) {
              persistedPending.set(field, value);
              try { pendingIO.save?.(field, value); } catch {}
            }
          } finally {
            if (epoch === generation) {
              inFlight.delete(field);
              if (pending.get(field) === entry) {
                pending.delete(field);
                // A newer same-field snapshot may have arrived before commit resolved.
                if (committedRevision && lastCloudSettings?.revision >= committedRevision
                    && fieldValue(lastCloudSettings, field) !== value) receive(lastCloudSettings);
              }
            }
          }
        })();
        inFlight.set(field, sending);
        await sending;
      }, 800);
    }

    function flushPending() {
      if (!cloudSyncReady || isApplyingRemoteSettings) return;
      if (pending.size === 0) return;
      pending.forEach((entry, field) => {
        // An older entry may be in flight while this newer entry is still unsent.
        if (!entry.sending) {
          persistedPending.set(field, entry.value);
          try { pendingIO.save?.(field, entry.value); } catch {}
        }
      });
    }

    return Object.freeze({start, stop, change, replayPending, flushPending});
  }

  // The page owns synchronous local-first persistence. This controller only
  // transports its profile-bound pending IDs and consumes confirmed server IDs.
  function createHistoryReadSync(client, io) {
    let generation = 0, ready = false, membership, subscription, starting, replaying, replayRequested = false;
    let remoteIds = new Set();
    const current = epoch => epoch === generation;
    const snapshot = () => {
      const state = io.snapshot();
      if (!state || state.profileId !== membership?.profileId
          || !Array.isArray(state.pendingIds) || !Array.isArray(state.seenIds)
          || !Array.isArray(state.limitedIds)) throw new Error('MEMBERSHIP_REQUIRED');
      return state;
    };
    function stop() {
      generation++; ready = false; membership = undefined;
      starting = undefined; replaying = undefined; replayRequested = false; remoteIds = new Set();
      const previous = subscription; subscription = undefined;
      if (previous) previous();
    }
    function receive(settings, epoch) {
      if (!current(epoch) || !settings) return;
      validateHistoryIds(settings.seenIds);
      remoteIds = new Set(settings.seenIds);
      if (io.applyRemote(settings.seenIds, membership.profileId) === false) {
        throw new Error('LOCAL_STORAGE_UNAVAILABLE');
      }
    }
    function replayPending() {
      if (!ready) return Promise.resolve(false);
      if (replaying) { replayRequested = true; return replaying; }
      replayRequested = false;
      const epoch = generation, expected = membership;
      const task = (async () => {
        // An ID is never submitted unless local + pending are already durable.
        if (io.flush() !== true) return false;
        const attempted = new Set();
        while (current(epoch) && ready) {
          const local = snapshot();
          const id = local.pendingIds.find(value => !attempted.has(value) && !local.limitedIds.includes(value));
          if (id === undefined) return true;
          if (!validHistoryId(id)) throw new Error('INVALID_SETTINGS');
          attempted.add(id);
          if (remoteIds.has(id)) {
            if (io.ack(id, expected.profileId) === false) return false;
            continue;
          }
          if (io.flush() !== true) return false;
          try {
            await client.markHistorySeen(id, expected);
            if (!current(epoch)) return false;
            // mark returns a revision, not a server document. Only a confirmed
            // read/snapshot can ACK; an optimistic write must retain pending.
            const confirmed = await client.getHistoryReadState(expected);
            if (!current(epoch)) return false;
            receive(confirmed, epoch);
            if (!remoteIds.has(id)) return false;
          } catch (error) {
            if (!current(epoch)) return false;
            if (error?.message === 'HISTORY_READ_LIMIT') {
              // The set is monotonic, so a full document cannot gain capacity.
              // Keep unsent local reads in a separate terminal local set.
              for (const pendingId of snapshot().pendingIds) {
                if (!remoteIds.has(pendingId)) io.limit(pendingId, expected.profileId);
              }
              io.flush();
              return false;
            }
            throw error;
          }
        }
        return false;
      })().catch(() => { if (current(epoch)) stop(); return false; });
      replaying = task;
      task.finally(() => {
        if (current(epoch) && replaying === task) {
          replaying = undefined;
          if (ready && replayRequested) queueMicrotask(replayPending);
        }
      });
      return task;
    }
    function start() {
      if (starting) return starting;
      if (ready) return replayPending();
      const epoch = generation;
      const task = (async () => {
        const identity = await client.getIdentity();
        if (!current(epoch)) return false;
        if (!identity || identity.active !== true || !validId(identity.profileId) || !validId(identity.deviceId)) return false;
        membership = Object.freeze({profileId: identity.profileId, deviceId: identity.deviceId});
        if (io.bindProfile(membership.profileId) !== true || io.flush() !== true) return false;
        let settings = await client.getHistoryReadState(membership);
        if (!current(epoch)) return false;
        if (!settings) {
          const local = snapshot();
          const initial = local.pendingIds.find(validHistoryId) || local.seenIds.find(validHistoryId);
          settings = await client.initializeHistoryReadState(initial === undefined ? [] : [initial], membership);
          if (!current(epoch)) return false;
        }
        receive(settings, epoch);
        ready = true;
        subscription = client.subscribeHistoryReadState(settings => {
          if (!current(epoch)) return;
          try { receive(settings, epoch); }
          catch { stop(); return; }
          // Remote IDs are ACKed by applyRemote, never queued as local edits.
          replayPending();
        }, () => { if (current(epoch)) stop(); }, membership);
        return await replayPending();
      })().catch(() => { if (current(epoch)) stop(); return false; });
      starting = task;
      task.finally(() => { if (current(epoch) && starting === task) starting = undefined; });
      return task;
    }
    return Object.freeze({start, stop, replayPending});
  }

  const messages = Object.freeze({
    UNAUTHENTICATED: '認証を確認できません。再読み込みしてください',
    MEMBERSHIP_REQUIRED: 'この端末は接続されていません',
    INVITE_UNAVAILABLE: 'このコードは使用できません',
    INVALID_INPUT: 'コードが正しくありません',
    DEVICE_LIMIT: '端末数の上限に達しています',
    RATE_LIMITED: 'しばらく待ってからお試しください',
    NOT_READY: '現在、端末同期は利用できません'
  });
  const errorText = error => Object.hasOwn(messages, error?.message) ? messages[error.message] : '通信に失敗しました';
  function normalizeCode(value) {
    const code = value.trim().replace(/-/g, '').toUpperCase();
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/.test(code)) throw new Error('INVALID_INPUT');
    return code;
  }

  // Loopback pages must explicitly opt into fixtures; never fall back to production.
  function localOptions(settings, location) {
    if (!settings || !['localhost', '127.0.0.1'].includes(location.hostname)) throw new Error('NOT_READY');
    const url = new URL(settings.apiBase, location.href);
    if (url.origin !== location.origin || url.pathname !== '/api/member-sync'
        || url.search || url.hash || url.username || url.password
        || url.protocol !== 'http:') throw new Error('NOT_READY');
    if (settings.firebaseConfig?.projectId !== 'gbf-meron-portal'
        || settings.firebaseConfig.apiKey !== 'local-only') throw new Error('NOT_READY');
    return {
      apiBase: url.href,
      connectEmulators({auth, db}) {
        auth.useEmulator('http://127.0.0.1:9099', {disableWarnings: true});
        db.useEmulator('127.0.0.1', 8080);
      }
    };
  }

  function environmentOptions(scope) {
    const local = ['localhost', '127.0.0.1'].includes(scope.location.hostname);
    if (local) return {firebaseConfig: scope.MEMBER_SYNC_LOCAL?.firebaseConfig,
      options: localOptions(scope.MEMBER_SYNC_LOCAL, scope.location), sdkBase: '/sdk/'};
    const config = scope.firebaseConfig;
    if (scope.location.protocol !== 'https:' || scope.MEMBER_SYNC_LOCAL
        || config?.projectId !== 'gbf-meron-portal' || !config.apiKey
        || config.apiKey === 'local-only' || !config.appId) throw new Error('NOT_READY');
    let url;
    try { url = new URL(scope.API_BASE_URL); } catch { throw new Error('NOT_READY'); }
    if (url.protocol !== 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname)
        || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('NOT_READY');
    return {firebaseConfig: config, options: {apiBase: url.origin + '/api/member-sync'},
      sdkBase: 'https://www.gstatic.com/firebasejs/10.8.0/'};
  }

  function createPairing(client, publish, lifecycle = {}) {
    let state = {status: 'unconfigured', busy: false, message: '', invite: null, requests: []};
    let timer, polling, disposed = false, inFlight = false, failures = 0;
    const visible = lifecycle.visible || (() => true);
    const later = lifecycle.setTimeout || setTimeout;
    const cancel = lifecycle.clearTimeout || clearTimeout;
    const emit = patch => { state = {...state, ...patch}; if (!disposed) publish({...state}); };
    const schedule = () => {
      cancel(timer);
      if (!disposed && ['ready', 'pending', 'recovering'].includes(state.status)) {
        timer = later(poll, Math.min(60000, 10000 * (2 ** failures)));
      }
    };
    function failure(error) {
      const denied = ['UNAUTHENTICATED', 'MEMBERSHIP_REQUIRED'].includes(error.message);
      emit({message: errorText(error), error: true,
        ...(denied ? {status: 'denied', invite: null, requests: []} : {})});
      failures = Math.min(failures + 1, 3);
    }
    async function refresh() {
      const result = await client.request('/status');
      if (!['ready','pending','unconfigured','expired','rejected','revoked'].includes(result.status)) throw new Error('NETWORK');
      const previous = state.status;
      const terminal = {expired:'コードの有効期限が切れています', rejected:'追加申請が拒否されました', revoked:'このコードは使用できません'};
      emit({status: result.status, error: false,
        message: terminal[result.status] || (previous === 'pending' && result.status === 'ready' ? '同期設定が完了しました' : ''),
        ...(result.status !== 'ready' ? {invite: null, requests: []} : {})});
      if (result.status === 'ready') {
        const pending = await client.request('/invites/pending');
        emit({requests: pending.requests});
      }
      if (state.invite && Date.parse(state.invite.expiresAt) <= Date.now()) emit({invite: null, message: 'コードの有効期限が切れています'});
      failures = 0;
    }
    async function poll() {
      if (disposed || inFlight || !['ready', 'pending', 'recovering'].includes(state.status)) return;
      if (!visible()) { schedule(); return; }
      inFlight = true;
      polling = (async () => {
        try { await refresh(); } catch (error) { failure(error); }
        finally { inFlight = false; schedule(); }
      })();
      try { await polling; } finally { polling = null; }
    }
    async function action(operation) {
      // A click during background refresh must not be silently discarded.
      if (polling) await polling;
      if (disposed || inFlight) return;
      inFlight = true; cancel(timer); emit({busy: true, message: '', error: false});
      try { await operation(); failures = 0; }
      catch (error) { failure(error); }
      finally { inFlight = false; emit({busy: false}); schedule(); }
    }
    return Object.freeze({
      async restore() {
        return action(async () => {
          const user = await client.restoreAuthentication();
          if (user) { emit({status: 'recovering'}); await refresh(); }
        });
      },
      start: () => action(async () => {
        await client.startAuthentication();
        emit({status: 'recovering'});
        await client.request('/profile', {});
        emit({status: 'ready', message: '同期設定が完了しました'});
      }),
      issue: () => action(async () => {
        if (state.status !== 'ready') throw new Error('MEMBERSHIP_REQUIRED');
        // A failed reissue may already have invalidated the old code on the server.
        emit({invite: null});
        const invite = await client.request('/invites', {});
        emit({invite});
      }),
      claim: value => action(async () => {
        const code = normalizeCode(value);
        await client.startAuthentication();
        emit({status: 'recovering'});
        await client.request('/invites/claim', {code});
        emit({status: 'pending', invite: null, requests: []});
      }),
      decide: (requestId, decision) => action(async () => {
        if (!['approve','reject'].includes(decision) || !/^[a-f0-9]{32}$/.test(requestId)) throw new Error('INVALID_INPUT');
        await client.request('/invites/' + requestId + '/' + decision, {});
        emit({requests: state.requests.filter(r => r.requestId !== requestId), invite: null,
          message: decision === 'approve' ? '端末を追加しました' : '追加申請を拒否しました'});
      }),
      poll,
      dispose() { disposed = true; cancel(timer); },
      resume() { disposed = false; schedule(); },
      snapshot: () => ({...state})
    });
  }

  function mount(element) {
    const $ = id => element.querySelector('[data-sync="' + id + '"]');
    let pairing, loading, current, client, showInput = false;
    const render = state => {
      const previousStatus = current?.status;
      current = state;
      if (state.status !== previousStatus) root.dispatchEvent(new CustomEvent('member-sync-connection', {
        detail: {ready: state.status === 'ready', client}
      }));
      const ready = state.status === 'ready', pending = state.status === 'pending';
      $('status').textContent = state.error ? 'エラー' : ready ? '接続済み' : pending ? '承認待ち' : state.status === 'recovering' ? '確認中' : '未設定';
      $('choices').hidden = ready || pending || ['denied','recovering'].includes(state.status);
      $('join-form').hidden = $('choices').hidden || !showInput;
      $('add').hidden = !ready;
      $('waiting').hidden = !pending;
      $('message').textContent = state.message;
      $('invite').hidden = !state.invite;
      $('code').textContent = state.invite ? state.invite.code.match(/.{1,4}/g).join('-') : '';
      $('add').textContent = state.invite ? '新しいコードを発行' : '別の端末を追加';
      $('requests').replaceChildren();
      for (const request of state.requests) {
        const row = document.createElement('div'); row.className = 'member-sync-request';
        const text = document.createElement('p'); text.textContent = '新しい端末から追加申請があります'; row.append(text);
        const actions = document.createElement('div'); actions.className = 'member-sync-actions';
        for (const [label, decision] of [['承認','approve'], ['拒否','reject']]) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
          button.disabled = state.busy; button.className = decision === 'approve' ? 'member-sync-primary' : '';
          button.addEventListener('click', () => pairing.decide(request.requestId, decision)); actions.append(button);
        }
        row.append(actions); $('requests').append(row);
      }
      $('notice').textContent = state.requests.length ? '追加申請があります' : '';
      element.querySelectorAll('button, input').forEach(control => { control.disabled = state.busy; });
      element.setAttribute('aria-busy', String(state.busy));
    };
    const getPairing = async () => {
      if (pairing) return pairing;
      if (loading) return loading;
      loading = (async () => {
        const settings = environmentOptions(root);
        for (const part of ['app','auth','firestore']) {
          if (part === 'app' ? root.firebase?.initializeApp : root.firebase?.[part]) continue;
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = settings.sdkBase + 'firebase-' + part + '-compat.js';
            script.onload = resolve; script.onerror = () => reject(new Error('NOT_READY'));
            document.head.append(script);
          });
        }
        client = createMemberSync(root.firebase, settings.firebaseConfig, settings.options);
        pairing = createPairing(client, render, {visible: () => !document.hidden});
        return pairing;
      })();
      try { return await loading; } finally { loading = null; }
    };
    const invoke = async fn => {
      try { await fn(await getPairing()); }
      catch (error) { render({...current, error: true, message: errorText(error), busy: false}); }
    };
    render({status:'unconfigured', busy:false, message:'', invite:null, requests:[]});
    $('start').onclick = () => invoke(p => p.start());
    $('join').onclick = () => { showInput = true; render(current); $('input').focus(); };
    $('join-form').onsubmit = event => { event.preventDefault(); invoke(p => p.claim($('input').value)); };
    $('add').onclick = () => invoke(p => p.issue());
    $('copy').onclick = async () => {
      try { await navigator.clipboard.writeText($('code').textContent); $('message').textContent = 'コードをコピーしました'; }
      catch { $('message').textContent = 'コピーできませんでした。コードを選択してコピーしてください'; }
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pairing?.poll(); });
    root.addEventListener('pagehide', () => pairing?.dispose());
    root.addEventListener('pageshow', () => pairing?.resume());
    // Persisted named-app credentials may restore; only start/claim can sign in.
    invoke(p => p.restore());
  }

  // Headless index integration. No account is created and no pairing/status API
  // is requested; an absent persisted member login leaves the page local-only.
  function mountHistoryReadSync(io, scope = root) {
    let client, controller, loading, generation = 0, disposed = false, suspended = false, pendingResume = false;
    const document = scope.document;
    const stops = [];
    const listen = (target, type, handler) => {
      target?.addEventListener(type, handler);
      stops.push(() => target?.removeEventListener(type, handler));
    };
    function stop() {
      generation++; loading = undefined; pendingResume = false;
      controller?.stop();
    }
    function start() {
      if (disposed || suspended || scope.navigator?.onLine === false || document?.hidden) return Promise.resolve(false);
      if (loading) return loading;
      pendingResume = false;
      const epoch = generation;
      const task = (async () => {
        if (!client) {
          const settings = environmentOptions(scope);
          for (const part of ['app', 'auth', 'firestore']) {
            if (part === 'app' ? scope.firebase?.initializeApp : scope.firebase?.[part]) continue;
            await new Promise((resolve, reject) => {
              const script = document.createElement('script');
              script.src = settings.sdkBase + 'firebase-' + part + '-compat.js';
              script.onload = resolve; script.onerror = () => reject(new Error('NOT_READY'));
              document.head.append(script);
            });
            if (disposed || epoch !== generation) return false;
          }
          client = createMemberSync(scope.firebase, settings.firebaseConfig, settings.options);
        }
        const user = await client.restoreAuthentication();
        if (disposed || epoch !== generation || !user) return false;
        if (!controller) controller = createHistoryReadSync(client, io);
        return await controller.start();
      })().catch(() => false);
      loading = task;
      task.finally(() => {
        if (epoch === generation && loading === task) {
          loading = undefined;
          if (pendingResume) { pendingResume = false; start(); }
        }
      });
      return task;
    }
    listen(scope, 'pagehide', () => { suspended = true; stop(); });
    listen(scope, 'pageshow', () => { suspended = false; start(); });
    listen(scope, 'offline', stop);
    listen(scope, 'online', start);
    listen(document, 'visibilitychange', () => { if (!document.hidden) start(); });
    let observedPending = new Set(io.snapshot().pendingIds);
    const unsubscribe = io.subscribe?.(() => {
      const ids = io.snapshot().pendingIds;
      const added = ids.some(id => !observedPending.has(id));
      observedPending = new Set(ids);
      // Retry after an explicit new read even if a previous transient failure
      // stopped transport. Remote ACKs/removals cannot trigger a retry loop.
      const epoch = generation;
      if (added) queueMicrotask(() => {
        if (disposed || suspended || epoch !== generation || scope.navigator?.onLine === false) return;
        if (loading) pendingResume = true;
        start();
      });
    });
    if (typeof unsubscribe === 'function') stops.push(unsubscribe);
    const handle = Object.freeze({start, stop,
      replayPending: () => controller?.replayPending() || Promise.resolve(false),
      dispose() { disposed = true; stop(); stops.splice(0).forEach(unsubscribe => unsubscribe()); }
    });
    start();
    return handle;
  }

  const api = Object.freeze({ APP_NAME, createMemberSync, createSpeedCalculatorSync, createHistoryReadSync,
    mountHistoryReadSync, createPairing, normalizeCode, errorText, localOptions, environmentOptions, mount });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.MemberSync = api;
    const element = document.querySelector('[data-member-sync]');
    if (element) mount(element);
  }
})(globalThis);
