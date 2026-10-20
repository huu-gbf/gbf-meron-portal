/* Browser-only Firebase compat fixture. Every HTTP request is fulfilled locally;
 * Firestore calls use an in-memory transport, never an emulator or production. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'http://127.0.0.1:18862';
const V1 = 'gbf_portal_history_seen_v1';
const V2 = 'gbf_portal_history_seen_ids_v2';
const PENDING = 'gbf_portal_history_seen_sync_pending_v1';
const STATE = 'gbf_portal_history_seen_sync_state_v1';
const RECORD_PREFIX = 'gbf_portal_history_seen_sync_record_v1:';
const IDENTITY = '__history_fixture_identity';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function installCompat({identity, seed, missingSdk}) {
  if (location.origin === 'null') return;
  if (!localStorage.getItem('__history_fixture_seeded')) {
    for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
    if (identity) localStorage.setItem('__history_fixture_identity', JSON.stringify(identity));
    localStorage.setItem('__history_fixture_seeded', '1');
  }
  globalThis.MEMBER_SYNC_LOCAL = {apiBase:'/api/member-sync', firebaseConfig:{
    apiKey:'local-only', projectId:'gbf-meron-portal', appId:'history-browser-fixture'}};
  globalThis.__historyFixture = {authCreates:0, listeners:new Map(), nextListener:0,
    blocked:false, failed:false, subscriptionsFailed:false, authListeners:new Set()};
  if (missingSdk) return;
  const fixture = globalThis.__historyFixture;
  const currentIdentity = () => JSON.parse(localStorage.getItem('__history_fixture_identity') || 'null');
  const transport = async (operation, data = {}) => {
    if (!navigator.onLine || fixture.blocked || fixture.failed) throw Error('NETWORK');
    const result = await globalThis.__historyTransport({operation, ...data,
      pending:localStorage.getItem('gbf_portal_history_seen_sync_pending_v1')});
    if (result?.error) { const error = Error(result.error); error.code = result.code; throw error; }
    return result;
  };
  class Timestamp { constructor(value) { this.value = value; } toMillis() { return this.value; } }
  const revive = value => {
    if (value && typeof value === 'object' && '__timestamp' in value) return new Timestamp(value.__timestamp);
    if (Array.isArray(value)) return value.map(revive);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,revive(v)]));
    return value;
  };
  const snapshot = value => ({exists:value !== null, data:() => revive(value),
    metadata:{fromCache:false,hasPendingWrites:false}});
  const makeUser = identity => identity && ({uid:identity.uid, isAnonymous:true,
    getIdToken:async () => 'fixture-member-token'});
  let memberUser = makeUser(currentIdentity());
  globalThis.__historySwitchIdentity = identity => {
    if (identity) localStorage.setItem('__history_fixture_identity', JSON.stringify(identity));
    else localStorage.removeItem('__history_fixture_identity');
    memberUser = makeUser(identity);
    for (const fn of fixture.authListeners) queueMicrotask(() => fn(memberUser));
  };
  globalThis.__historyDeliver = async changed => {
    for (const listener of [...fixture.listeners.values()]) {
      if (changed && !changed.includes(listener.path)) continue;
      try { listener.success(snapshot(await transport('get', {path:listener.path}))); }
      catch (error) { listener.failure?.(error); }
    }
  };
  const apps = [];
  const makeAuth = name => ({
    get currentUser() { return name === 'member-sync' ? memberUser : null; },
    setPersistence:async () => {}, useEmulator() {},
    onAuthStateChanged(success) {
      if (name === 'member-sync') fixture.authListeners.add(success);
      queueMicrotask(() => success(name === 'member-sync' ? memberUser : null));
      return () => fixture.authListeners.delete(success);
    },
    async signInAnonymously() { fixture.authCreates++; throw Error('FIXTURE_AUTH_CREATION_FORBIDDEN'); }
  });
  const makeDb = name => {
    const doc = key => ({path:key,
      async get() { return snapshot(await transport('get', {path:key})); },
      onSnapshot(...args) {
        const success = args.find(value => typeof value === 'function');
        const failure = args.filter(value => typeof value === 'function')[1];
        const id = ++fixture.nextListener;
        const listener = {path:key,success,failure};
        fixture.listeners.set(id, listener);
        queueMicrotask(async () => {
          if (!fixture.listeners.has(id)) return;
          try {
            if (fixture.subscriptionsFailed) throw Error('SUBSCRIPTION_FAILED');
            success(snapshot(await transport('get', {path:key})));
          } catch (error) { failure?.(error); }
        });
        return () => fixture.listeners.delete(id);
      }
    });
    return {doc,useEmulator() {}, async runTransaction(operation) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await transport('begin');
        const reads = {}, writes = [];
        const result = await operation({
          async get(ref) { const raw = await transport('get',{path:ref.path}); reads[ref.path] = raw; return snapshot(raw); },
          set(ref,data) { writes.push({type:'set',path:ref.path,data}); },
          update(ref,data) { writes.push({type:'update',path:ref.path,data}); }
        });
        const committed = await transport('commit',{reads,writes});
        if (committed.retry) continue;
        return result;
      }
      throw Error('FIXTURE_TRANSACTION_RETRY_EXHAUSTED');
    }};
  };
  const firebase = globalThis.firebase = {apps,
    initializeApp(options, name = '[DEFAULT]') {
      const auth = makeAuth(name), db = makeDb(name);
      const app = {name,options,auth:() => auth,firestore:() => db}; apps.push(app); return app;
    },
    app(name = '[DEFAULT]') { return apps.find(app => app.name === name); },
    auth() { return firebase.app().auth(); }, firestore() { return firebase.app().firestore(); }
  };
  firebase.auth.Auth = {Persistence:{LOCAL:'local'}};
  firebase.firestore.Timestamp = Timestamp;
  firebase.firestore.FieldValue = {serverTimestamp:() => ({__operation:'timestamp'}),
    increment:value => ({__operation:'increment',value}),
    arrayUnion:(...value) => ({__operation:'union',value})};
}

function createHistoryFixture(browser) {
  const docs = new Map([['portalConfig/recruitment',{text:'ローカル試験の募集文'}]]);
  const devices = [], requests = [], transactions = [], writes = [], reads = [];
  const errors = [], consoleErrors = [], warnings = [];
  let now = 1000, hold, heldResolve;
  const historyPath = profile => `memberProfiles/${profile}/settings/historyReadState`;
  const doc = (profile, ids) => ({schemaVersion:1,seenIds:[...ids],revision:1,
    createdAt:{__timestamp:++now},updatedAt:{__timestamp:++now},updatedByDeviceId:'fixture-seed'});
  function register(identity) {
    if (!identity) return;
    docs.set('memberIdentities/'+identity.uid, {active:true,profileId:identity.profileId,deviceId:identity.deviceId});
    docs.set('memberProfiles/'+identity.profileId,{status:'active'});
    docs.set('memberProfiles/'+identity.profileId+'/devices/'+identity.deviceId,{status:'active'});
  }
  async function broadcast(changed) {
    await Promise.all(devices.flatMap(device => device.context.pages()).filter(page => !page.isClosed())
      .map(page => page.evaluate(changed => globalThis.__historyDeliver?.(changed),changed).catch(error => {
        if (!/Execution context was destroyed|Target page|closed|navigation/i.test(error.message)) throw error;
      })));
  }
  async function transport(device, request) {
    if (request.operation === 'get') {
      reads.push({device:device.name,path:request.path,pending:request.pending});
      return clone(docs.get(request.path) ?? null);
    }
    if (request.operation === 'begin') { transactions.push(device.name); return {}; }
    assert.equal(request.operation, 'commit');
    if (hold && request.writes.some(write => write.path.endsWith('/settings/historyReadState'))) {
      const pending = hold; hold = null; heldResolve?.(); await pending;
    }
    for (const [key,value] of Object.entries(request.reads)) {
      if (JSON.stringify(docs.get(key) ?? null) !== JSON.stringify(value)) return {retry:true};
    }
    const changed = [];
    for (const write of request.writes) {
      const old = docs.get(write.path), value = write.type === 'set' ? {} : clone(old);
      for (const [key,input] of Object.entries(write.data)) {
        value[key] = input?.__operation === 'timestamp' ? {__timestamp:++now}
          : input?.__operation === 'increment' ? value[key] + input.value
          : input?.__operation === 'union' ? [...new Set([...value[key],...input.value])] : clone(input);
      }
      if (value.seenIds.length > 256) return {error:'HISTORY_READ_LIMIT'};
      docs.set(write.path,value); writes.push({...clone(write),device:device.name,pending:request.pending});
      changed.push(write.path);
    }
    if (changed.length) setImmediate(() => broadcast(changed).catch(error => errors.push(error.message)));
    return {};
  }
  async function device(name, {viewport={width:1440,height:1000}, identity=null, seed={}, missingSdk=false} = {}) {
    register(identity);
    const context = await browser.newContext({viewport,serviceWorkers:'block'});
    const entry = {name,context}; devices.push(entry);
    await context.exposeBinding('__historyTransport', (_source,request) => transport(entry,request));
    await context.addInitScript(installCompat,{identity,seed,missingSdk});
    await context.route('**/*', async route => {
      const url = new URL(route.request().url()); requests.push(url.href);
      const allowed = {'/index.html':'index.html','/':'index.html','/member-sync.js':'member-sync.js',
        '/firebase-config.js':'firebase-config.js','/css/tailwind.min.css':'css/tailwind.min.css','/favicon.svg':'favicon.svg'};
      if (url.origin === ORIGIN && allowed[url.pathname]) {
        const file = allowed[url.pathname];
        return route.fulfill({status:200,contentType:file.endsWith('.js')?'application/javascript':
          file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html',body:fs.readFileSync(path.join(ROOT,file))});
      }
      // Original SDK tags, fonts and Visitor analytics are all inert local replies.
      if (url.hostname === 'www.gstatic.com' || url.pathname.startsWith('/sdk/'))
        return route.fulfill({status:200,contentType:'application/javascript',body:'/* In-memory browser fixture; no remote SDK. */'});
      if (url.hostname === 'fonts.googleapis.com') return route.fulfill({status:200,contentType:'text/css',body:''});
      if (url.pathname === '/api/visit') return route.fulfill({status:200,contentType:'application/json',body:'{}',headers:{'access-control-allow-origin':'*'}});
      errors.push('Unexpected browser request: '+url.href);
      return route.abort();
    });
    context.on('page',page => {
      page.on('pageerror',error => errors.push(error.message));
      page.on('console',message => {
        if (message.type() === 'error') consoleErrors.push(message.text());
        if (message.type() === 'warning') warnings.push(message.text());
      });
    });
    const page = await context.newPage(); entry.page = page;
    await page.goto(ORIGIN+'/index.html');
    await page.waitForFunction(() => document.getElementById('portalScreen')?.classList.contains('hidden') === false);
    return entry;
  }
  return {device,docs,devices,requests,writes,reads,transactions,errors,consoleErrors,warnings,historyPath,
    seed(profile,ids) { docs.set(historyPath(profile),doc(profile,ids)); },
    cloud(profile) { return clone(docs.get(historyPath(profile)) ?? null); },
    async remote(profile,ids) { const key = historyPath(profile); docs.set(key,doc(profile,ids)); await broadcast([key]); },
    holdNextWrite() {
      let release; hold = new Promise(resolve => { release = resolve; });
      const entered = new Promise(resolve => { heldResolve = resolve; });
      return {entered,release};
    },
    register,broadcast,
    async close() { for (const entry of devices) await entry.context.close(); }
  };
}

module.exports = {createHistoryFixture,ORIGIN,V1,V2,PENDING,STATE,RECORD_PREFIX,IDENTITY};
