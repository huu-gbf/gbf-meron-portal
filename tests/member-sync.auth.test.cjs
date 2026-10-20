const {test} = require('node:test');
const assert = require('node:assert/strict');
const {APP_NAME,createMemberSync} = require('../member-sync.js');

test('module is opt-in, waits for LOCAL credential restoration and reuses named app',async()=>{
  const config = {projectId:'demo-member',apiKey:'demo',appId:'demo'};
  const calls = [];
  const persisted = {uid:'persisted-member',isAnonymous:true};
  const auth = {currentUser:null,
    async setPersistence(value){calls.push(['persistence',value]);},
    onAuthStateChanged(cb){queueMicrotask(()=>{auth.currentUser=persisted;cb(persisted);});return ()=>calls.push(['unsubscribe']);},
    async signInAnonymously(){throw Error('must restore before signing in');}};
  const admin = {name:'[DEFAULT]',auth:()=>{throw Error('default admin must not be touched');}};
  const yosen = {name:'yosen-shared',auth:()=>{throw Error('yosen admin must not be touched');}};
  const sdk = {apps:[admin,yosen],auth:{Auth:{Persistence:{LOCAL:'local'}}},
    initializeApp(options,name){calls.push(['initialize',name]);const app={name,options,auth:()=>auth,
      firestore:()=>({doc:path=>({get:async options=>{calls.push(['get',path,options]);return {exists:false};}})})};sdk.apps.push(app);return app;}};
  const client = createMemberSync(sdk,config);
  assert.equal(calls.length,0);
  await assert.rejects(client.getIdentity(),/Start member/);
  const [one,two] = await Promise.all([client.startAuthentication(),client.startAuthentication()]);
  assert.equal(one.uid,persisted.uid);assert.equal(two.uid,persisted.uid);
  assert.equal(calls.filter(c=>c[0]==='initialize').length,1);
  assert.equal(calls.filter(c=>c[0]==='persistence').length,1);
  assert.equal(await client.getIdentity(),null);
  assert.deepEqual(calls.find(c=>c[0]==='get'),['get','memberIdentities/persisted-member',{source:'server'}]);
  // A new module instance represents recreation after a page reload.
  assert.equal((await createMemberSync(sdk,config).startAuthentication()).uid,persisted.uid);
  assert.equal(calls.filter(c=>c[0]==='initialize').length,1);
  await assert.rejects(createMemberSync(sdk,{...config,projectId:'wrong'}).startAuthentication(),/mismatch/);
});

test('persistence failure creates no anonymous account and can be retried',async()=>{
  let failed=true, signIns=0;
  const auth={currentUser:null,setPersistence:async()=>{if(failed)throw Error('storage unavailable');},
    onAuthStateChanged(cb){queueMicrotask(()=>cb(auth.currentUser));return ()=>{};},
    async signInAnonymously(){signIns++;auth.currentUser={uid:'new',isAnonymous:true};}};
  const sdk={apps:[],auth:{Auth:{Persistence:{LOCAL:'local'}}},initializeApp:()=>({auth:()=>auth,firestore:()=>({})})};
  const client=createMemberSync(sdk,{});
  await assert.rejects(client.startAuthentication(),/storage unavailable/);assert.equal(signIns,0);
  failed=false;await client.startAuthentication();assert.equal(signIns,1);
});

test('real Auth emulator issues anonymous UID without changing either admin session',async()=>{
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:9099','run with the test emulator config');
  const firebase=require('firebase/compat/app');
  require('firebase/compat/auth');require('firebase/compat/firestore');
  const config={apiKey:'demo-key',projectId:'demo-gbf-meron-portal-rules',appId:'demo-member-sync'};
  const apps=['[DEFAULT]','yosen-shared',APP_NAME].map(name=>firebase.initializeApp(config,name));
  try {
    for(const app of apps) app.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
    const admins=[];
    for(const [i,app] of apps.slice(0,2).entries()) {
      const credential=await app.auth().createUserWithEmailAndPassword('admin-'+i+'-'+Date.now()+'@example.test','local-test-only-password');
      admins.push(credential.user.uid);
    }
    // Node Auth has no browser LOCAL persistence. Only substitute that constant;
    // UID creation, auth observers and app isolation still use the real SDK.
    // The test above verifies LOCAL selection and asynchronous restoration.
    const nodeSdk={apps:firebase.apps,initializeApp:firebase.initializeApp.bind(firebase),
      auth:{Auth:{Persistence:{LOCAL:firebase.auth.Auth.Persistence.NONE}}}};
    const client=createMemberSync(nodeSdk,config);
    const member=await client.startAuthentication();
    assert(member.uid);assert.equal(member.isAnonymous,true);
    assert.equal((await client.startAuthentication()).uid,member.uid);
    assert.equal((await createMemberSync(nodeSdk,config).startAuthentication()).uid,member.uid);
    assert.deepEqual(apps.slice(0,2).map(app=>app.auth().currentUser.uid),admins);
    assert(apps.slice(0,2).every(app=>!app.auth().currentUser.isAnonymous));
    await apps[0].auth().signOut();
    assert.equal(apps[2].auth().currentUser.uid,member.uid);
    assert.equal(apps[1].auth().currentUser.uid,admins[1]);
  } finally {await Promise.all(apps.map(app=>app.delete()));}
});
