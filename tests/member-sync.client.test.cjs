const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const {createPairing,createMemberSync,normalizeCode,errorText,localOptions} = require('../member-sync');

function fixture() {
  const calls=[], timers=[];
  let signed=false, status='unconfigured', visible=true, fail;
  const client={
    restoreAuthentication:async()=>signed?{isAnonymous:true}:null,
    startAuthentication:async()=>{signed=true;calls.push('signIn');},
    request:async(path,body)=>{
      calls.push([path,body]); if(fail) throw Error(fail);
      if(path==='/profile'){status='ready';return {status};}
      if(path==='/status')return {status};
      if(path==='/invites/pending')return {requests:[]};
      if(path==='/invites')return {code:'ABCDEFGHJKLM',expiresAt:new Date(Date.now()+600000).toISOString()};
      if(path==='/invites/claim'){status='pending';return {status,requestId:'a'.repeat(32)};}
      return {};
    }
  };
  const pairing=createPairing(client,()=>{}, {visible:()=>visible,setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:()=>{}});
  return {pairing,calls,timers,setStatus:v=>status=v,setVisible:v=>visible=v,setFail:v=>fail=v};
}
test('initial page restore never signs in; explicit start creates profile but no code',async()=>{
  const f=fixture(); await f.pairing.restore();assert.deepEqual(f.calls,[]);
  await f.pairing.poll();assert.deepEqual(f.calls,[]);assert.equal(f.pairing.snapshot().status,'unconfigured');
  await f.pairing.start();assert.equal(f.pairing.snapshot().status,'ready');
  assert.deepEqual(f.calls,['signIn',['/profile',{}]]);assert.equal(f.pairing.snapshot().invite,null);
});
test('restoreAuthentication restores null without creating an account',async()=>{
  let signs=0;const auth={currentUser:null,setPersistence:async()=>{},onAuthStateChanged:cb=>{queueMicrotask(()=>cb(null));return ()=>{};},signInAnonymously:async()=>{signs++;}};
  const sdk={apps:[],initializeApp:()=>({auth:()=>auth,firestore:()=>({})}),auth:{Auth:{Persistence:{LOCAL:'local'}}}};
  assert.equal(await createMemberSync(sdk,{}).restoreAuthentication(),null);assert.equal(signs,0);
});
test('concurrent authentication creates one account',async()=>{
  let signs=0;const auth={currentUser:null,setPersistence:async()=>{},onAuthStateChanged:cb=>{queueMicrotask(()=>cb(auth.currentUser));return ()=>{};},signInAnonymously:async()=>{signs++;await new Promise(r=>setImmediate(r));auth.currentUser={uid:'one',isAnonymous:true};}};
  const sdk={apps:[],initializeApp:()=>({auth:()=>auth,firestore:()=>({})}),auth:{Auth:{Persistence:{LOCAL:'local'}}}};
  const client=createMemberSync(sdk,{});await Promise.all([client.startAuthentication(),client.startAuthentication()]);assert.equal(signs,1);
});
test('normalized display separators, case and surrounding spaces match API contract',()=>{
  assert.equal(normalizeCode(' abcd-efgh-jklm '),'ABCDEFGHJKLM');
  for(const value of ['ABCD EFGH JKLM','ABCD-EFGH-JKLI','ABC','<script>'])assert.throws(()=>normalizeCode(value),/INVALID_INPUT/);
});
test('issue requires ready, reissue retains only latest successful response',async()=>{
  const f=fixture();await f.pairing.issue();assert.equal(f.calls.length,0);
  await f.pairing.start();await f.pairing.issue();assert.equal(f.pairing.snapshot().invite.code,'ABCDEFGHJKLM');
  f.setFail('NETWORK');await f.pairing.issue();assert.equal(f.pairing.snapshot().invite,null);
});
test('claim stays pending until approval; terminal state never implies membership',async()=>{
  for(const result of ['ready','rejected','revoked','expired']){
    const f=fixture();await f.pairing.claim('abcd-efgh-jklm');assert.equal(f.pairing.snapshot().status,'pending');
    assert.deepEqual(f.calls[1],['/invites/claim',{code:'ABCDEFGHJKLM'}]);
    f.setStatus(result);await f.pairing.poll();assert.equal(f.pairing.snapshot().status,result);
  }
});
test('invalid input creates neither authentication nor API traffic',async()=>{
  const f=fixture();await f.pairing.claim('invalid');assert.deepEqual(f.calls,[]);assert.equal(f.pairing.snapshot().message,'コードが正しくありません');
});
test('approve and reject use request ID, a single POST and no extra confirmation',async()=>{
  for(const decision of ['approve','reject']){
    const f=fixture();await f.pairing.start();await f.pairing.decide('a'.repeat(32),decision);
    assert.deepEqual(f.calls.at(-1),['/invites/'+'a'.repeat(32)+'/'+decision,{}]);
  }
});
test('polling pauses while hidden, backs off after rate limits, and stops on auth loss',async()=>{
  const f=fixture();await f.pairing.start();assert.equal(f.timers.at(-1).ms,10000);
  f.setVisible(false);const count=f.calls.length;await f.pairing.poll();assert.equal(f.calls.length,count);
  f.setVisible(true);f.setFail('RATE_LIMITED');await f.pairing.poll();assert.equal(f.timers.at(-1).ms,20000);
  f.setFail('UNAUTHENTICATED');await f.pairing.poll();assert.equal(f.pairing.snapshot().status,'denied');
  const timers=f.timers.length;f.pairing.dispose();await f.pairing.poll();assert.equal(f.timers.length,timers);
});
test('server success with lost response recovers through status, without creating a second profile',async()=>{
  const f=fixture();f.setFail('NETWORK');await f.pairing.start();assert.equal(f.pairing.snapshot().status,'recovering');
  f.setFail(null);f.setStatus('ready');await f.pairing.poll();assert.equal(f.pairing.snapshot().status,'ready');
  assert.equal(f.calls.filter(c=>c[0]==='/profile').length,1);
});
test('approval clicked during background polling waits and is sent once',async()=>{
  let release;const calls=[];
  const client={startAuthentication:async()=>{},request:async(path)=>{
    calls.push(path);
    if(path==='/status'){await new Promise(resolve=>{release=resolve;});return {status:'ready'};}
    return {requests:[]};
  }};
  const pairing=createPairing(client,()=>{}, {setTimeout:()=>0,clearTimeout:()=>{}});
  await pairing.start();calls.length=0;
  const poll=pairing.poll();const approve=pairing.decide('a'.repeat(32),'approve');
  assert.equal(calls.length,1);release();await Promise.all([poll,approve]);
  assert.equal(calls.filter(p=>p.endsWith('/approve')).length,1);pairing.dispose();
});
test('unknown errors never expose internal data',()=>{
  assert.equal(errorText(Error('token UID profileId secret stack')),'通信に失敗しました');
  for(const code of ['INVITE_UNAVAILABLE','DEVICE_LIMIT','RATE_LIMITED','NOT_READY'])assert(!errorText(Error(code)).includes(code));
});
test('production page, external API, credentials and non-local Firebase config fail closed',()=>{
  const settings={apiBase:'/api/member-sync',firebaseConfig:{projectId:'gbf-meron-portal',apiKey:'local-only'}};
  const location=new URL('http://127.0.0.1:18765/test');assert(localOptions(settings,location));
  assert.throws(()=>localOptions(settings,new URL('https://example.com')),/NOT_READY/);
  for(const apiBase of ['https://example.com/api/member-sync','http://127.0.0.1:9999/api/member-sync','http://user:pass@127.0.0.1:18765/api/member-sync','/other'])assert.throws(()=>localOptions({...settings,apiBase},location));
  assert.throws(()=>localOptions({...settings,firebaseConfig:{projectId:'production'}},location));
});
test('API cannot send token when auth disappears during token retrieval',async()=>{
  let calls=0;const user={isAnonymous:true,getIdToken:async()=>{auth.currentUser=null;return 'private';}};
  const auth={currentUser:user,setPersistence:async()=>{},onAuthStateChanged:cb=>{queueMicrotask(()=>cb(user));return ()=>{};}};
  const sdk={apps:[],initializeApp:()=>({auth:()=>auth,firestore:()=>({})}),auth:{Auth:{Persistence:{LOCAL:'local'}}}};
  const client=createMemberSync(sdk,{}, {fetch:async()=>calls++});await client.restoreAuthentication();
  await assert.rejects(client.request('/status'),/UNAUTHENTICATED/);assert.equal(calls,0);
});
test('member-sync keeps calculator localStorage responsibility in calculator code',()=>{
  assert.equal(fs.readFileSync('speed-calculator.html','utf8').replace(/\r\n/g,'\n'),execFileSync('git',['show','b3b2ed6:speed-calculator.html'],{encoding:'utf8'}).replace(/\r\n/g,'\n'));
  const source=fs.readFileSync('member-sync.js','utf8');
  assert(!source.includes('gbf_unf_speed_calc'));
  assert(!source.includes('localStorage'));
  const calculator=fs.readFileSync('speed-calculator-folder/speed-calculator.html','utf8');
  for(const key of ['gbf_unf_speed_calc_times','gbf_unf_speed_calc_interval'])assert(calculator.includes(key));
});

function settingsFixture() {
  const firebase=require('firebase/compat/app');require('firebase/compat/firestore');
  const timestamp=firebase.firestore.Timestamp.fromMillis(1000);
  let data={schemaVersion:1,hellTimesSec:{90:10,95:20,100:45,150:70,200:90,250:240},intervalSec:3,
    revision:1,createdAt:timestamp,updatedAt:timestamp,updatedByDeviceId:'deviceA1'};
  let reads=0,transactions=0;
  const auth={currentUser:{uid:'memberA',isAnonymous:true},setPersistence:async()=>{},
    onAuthStateChanged:callback=>{queueMicrotask(()=>callback(auth.currentUser));return ()=>{};}};
  const db={doc:path=>({get:async options=>{
    reads++;assert.deepEqual(options,{source:'server'});
    return {exists:true,data:()=>path==='memberIdentities/memberA'?{active:true,profileId:'profileA',deviceId:'deviceA1'}:data};
  }}),runTransaction:async()=>{transactions++;throw Error('unexpected transaction');}};
  const sdk={apps:[],firestore:firebase.firestore,auth:{Auth:{Persistence:{LOCAL:'local'}}},initializeApp:()=>({auth:()=>auth,firestore:()=>db})};
  return {api:createMemberSync(sdk,{}),set:value=>data=value,data:()=>data,reads:()=>reads,transactions:()=>transactions};
}
test('settings client rejects malformed stored documents before returning them',async()=>{
  const f=settingsFixture();await f.api.restoreAuthentication();const valid=f.data();
  const invalid=[null,[],{}, {...valid,extra:true}, {...valid,schemaVersion:'1'}, {...valid,schemaVersion:2},
    {...valid,revision:0},{...valid,revision:1.5},{...valid,revision:NaN},{...valid,revision:Infinity},
    {...valid,revision:Number.MAX_SAFE_INTEGER+1},{...valid,createdAt:new Date()},{...valid,updatedAt:null},
    {...valid,updatedByDeviceId:''},{...valid,updatedByDeviceId:'other/path'}];
  for(const key of Object.keys(valid)){const data={...valid};delete data[key];invalid.push(data);}
  for(const level of Object.keys(valid.hellTimesSec)){
    const hell={...valid.hellTimesSec};delete hell[level];invalid.push({...valid,hellTimesSec:hell});
    for(const value of [-1,3600,1.5,'10',null,true,NaN,Infinity])invalid.push({...valid,hellTimesSec:{...valid.hellTimesSec,[level]:value}});
  }
  invalid.push({...valid,hellTimesSec:{...valid.hellTimesSec,300:10}});
  for(const value of [-0.1,15.1,3.05,0.30000000000000004,NaN,Infinity,'3',null,true])invalid.push({...valid,intervalSec:value});
  for(const data of invalid){f.set(data);await assert.rejects(f.api.getSpeedCalculatorSettings(),/INVALID_SETTINGS/);}
});
test('settings client accepts every canonical tenth and full HELL range boundaries',async()=>{
  const f=settingsFixture();await f.api.restoreAuthentication();const valid=f.data();
  for(let tenth=0;tenth<=150;tenth++){
    f.set({...valid,intervalSec:tenth/10,hellTimesSec:{90:0,95:999,100:1000,150:3599,200:90,250:240}});
    assert.equal((await f.api.getSpeedCalculatorSettings()).intervalSec,tenth/10);
  }
});
test('settings update paths and initial payload are allowlisted before any Firestore access',async()=>{
  const f=settingsFixture();const values={hellTimesSec:{...f.data().hellTimesSec},intervalSec:3};
  for(const field of ['profileId','deviceId','revision','schemaVersion','hellTimesSec','hellTimesSec.300','hellTimesSec.90.extra','__proto__',null,{}]){
    await assert.rejects(f.api.updateSpeedCalculatorField(field,1),/INVALID_SETTINGS/);
  }
  for(const value of [-1,3600,1.5,Infinity,NaN,'1',null])await assert.rejects(f.api.updateSpeedCalculatorField('hellTimesSec.90',value),/INVALID_SETTINGS/);
  for(const value of [-1,16,3.05,Infinity,NaN,'3',null])await assert.rejects(f.api.updateSpeedCalculatorField('intervalSec',value),/INVALID_SETTINGS/);
  for(const data of [null,{}, {...values,profileId:'forged'}, {...values,deviceId:'forged'}, {...values,intervalSec:3.05}]){
    await assert.rejects(f.api.initializeSpeedCalculatorSettings(data),/INVALID_SETTINGS/);
  }
  assert.equal(f.reads(),0);assert.equal(f.transactions(),0);
});
test('Block 4B settings sync is connected only to the folder calculator',()=>{
  assert.equal(typeof require('../member-sync').createSpeedCalculatorSync,'function');
  const calculator=fs.readFileSync('speed-calculator-folder/speed-calculator.html','utf8');
  assert(calculator.includes('MemberSync.createSpeedCalculatorSync('));
  assert(calculator.includes("window.addEventListener('member-sync-connection'"));
  assert(fs.readFileSync('member-sync.js','utf8').includes("new CustomEvent('member-sync-connection'"));
  const root=fs.readFileSync('speed-calculator.html','utf8');
  assert(!root.includes('createSpeedCalculatorSync'));
  assert(!root.includes('member-sync-connection'));
});

function syncFixture(t, initial) {
  t.mock.timers.enable({apis:['setTimeout']});
  let remote=initial || {hellTimesSec:{90:10,95:20,100:45,150:70,200:90,250:240},intervalSec:3,revision:1};
  const writes=[], applied=[]; let callback, onError, stops=0, fail=false;
  const client={
    getSpeedCalculatorSettings:async()=>remote,
    initializeSpeedCalculatorSettings:async values=>(remote={...values,revision:1}),
    subscribeSpeedCalculatorSettings(cb,error){callback=cb;onError=error;return ()=>stops++;},
    async updateSpeedCalculatorField(field,value){
      writes.push([field,value]); if(fail)throw Error('offline');
      remote={...remote,hellTimesSec:{...remote.hellTimesSec},revision:remote.revision+1};
      if(field==='intervalSec')remote.intervalSec=value;else remote.hellTimesSec[field.split('.')[1]]=value;
      callback(remote);return remote.revision;
    }
  };
  const sync=require('../member-sync').createSpeedCalculatorSync(client,()=>({hellTimesSec:{90:11,95:21,100:46,150:71,200:91,250:241},intervalSec:4}),settings=>{
    applied.push(settings);sync.change('intervalSec',settings.intervalSec);
  });
  const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
  return {sync,client,writes,applied,settle,remote:()=>remote,receive:value=>callback(value),deny:()=>onError(Error('MEMBERSHIP_REQUIRED')),stops:()=>stops,fail:value=>{fail=value;}};
}
test('sync gates startup, initializes once, and remote apply never loops',async t=>{
  const f=syncFixture(t); f.client.getSpeedCalculatorSettings=async()=>null;
  f.sync.change('intervalSec',8);t.mock.timers.tick(800);await f.settle();assert.equal(f.writes.length,0);
  await f.sync.start();assert.equal(f.remote().revision,1);assert.equal(f.remote().intervalSec,4);
  t.mock.timers.tick(800);await f.settle();assert.equal(f.writes.length,0);
  f.sync.stop();assert.equal(f.stops(),1);
});
test('sync debounces independently, suppresses identical values and preserves pending fields',async t=>{
  const f=syncFixture(t);await f.sync.start();
  f.sync.change('hellTimesSec.90',12);f.sync.change('hellTimesSec.250',260);
  f.sync.change('hellTimesSec.90',13);f.sync.change('intervalSec',3);
  t.mock.timers.tick(799);await f.settle();assert.equal(f.writes.length,0);
  f.receive({...f.remote(),intervalSec:4,revision:2});
  assert.equal(f.applied.at(-1).hellTimesSec[90],13);assert.equal(f.applied.at(-1).hellTimesSec[250],260);
  t.mock.timers.tick(1);await f.settle();assert.equal(f.writes.length,2);
  assert.deepEqual(f.writes.sort(),[['hellTimesSec.250',260],['hellTimesSec.90',13]].sort());
  f.sync.change('hellTimesSec.90',13);t.mock.timers.tick(800);await f.settle();assert.equal(f.writes.length,2);
  f.sync.stop();
});
test('sync failure allows retry and stop cancels pending writes',async t=>{
  const f=syncFixture(t);await f.sync.start();f.fail(true);
  f.sync.change('intervalSec',6);t.mock.timers.tick(800);await f.settle();
  f.fail(false);f.sync.change('intervalSec',6);t.mock.timers.tick(800);await f.settle();
  assert.equal(f.writes.length,2);assert.equal(f.remote().intervalSec,6);
  f.sync.change('intervalSec',7);f.deny();t.mock.timers.tick(800);await f.settle();
  assert.equal(f.writes.length,2);assert.equal(f.stops(),1);
});
test('rapid edits during an in-flight write serialize the final field value',async t=>{
  const f=syncFixture(t);await f.sync.start();let finish;
  f.client.updateSpeedCalculatorField=(field,value)=>{f.writes.push([field,value]);return new Promise(resolve=>{finish=resolve;});};
  f.sync.change('intervalSec',5);t.mock.timers.tick(800);await f.settle();
  f.sync.change('intervalSec',6);f.sync.change('intervalSec',3);
  t.mock.timers.tick(800);await f.settle();assert.equal(f.writes.length,1);
  finish(2);await f.settle();assert.deepEqual(f.writes,[['intervalSec',5],['intervalSec',3]]);
  finish(3);await f.settle();f.sync.stop();
});
test('pagehide during initial read prevents late initialization and subscription',async t=>{
  const f=syncFixture(t);let finish;f.client.getSpeedCalculatorSettings=()=>new Promise(resolve=>{finish=resolve;});
  const started=f.sync.start();f.sync.stop();finish(null);await started;
  assert.equal(f.applied.length,0);assert.equal(f.stops(),0);
});

test('slow cloud read accepts no writes and existing cloud wins over startup input',async t=>{
  const f=syncFixture(t);let resolve;f.client.getSpeedCalculatorSettings=()=>new Promise(done=>{resolve=done;});
  const starting=f.sync.start();f.sync.change('intervalSec',9);t.mock.timers.tick(800);await f.settle();
  assert.equal(f.writes.length,0);resolve(f.remote());await starting;
  assert.equal(f.applied.at(-1).intervalSec,3);f.sync.stop();
});

test('a newer same-field snapshot wins after the pending write completes',async t=>{
  const f=syncFixture(t);await f.sync.start();let finish;
  f.client.updateSpeedCalculatorField=()=>new Promise(resolve=>{finish=resolve;});
  f.sync.change('intervalSec',5);t.mock.timers.tick(800);await f.settle();
  f.receive({...f.remote(),intervalSec:7,revision:3});assert.equal(f.applied.at(-1).intervalSec,5);
  finish(2);await f.settle();assert.equal(f.applied.at(-1).intervalSec,7);f.sync.stop();
});
