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
test('calculator executable scripts and root calculator are unchanged from Block 3A',()=>{
  const path='speed-calculator-folder/speed-calculator.html';
  const before=execFileSync('git',['show','b3b2ed6:'+path],{encoding:'utf8'});
  const scripts=html=>[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1].replace(/\r\n/g,'\n')).filter(Boolean);
  assert.deepEqual(scripts(fs.readFileSync(path,'utf8')),scripts(before));
  assert.equal(fs.readFileSync('speed-calculator.html','utf8').replace(/\r\n/g,'\n'),execFileSync('git',['show','b3b2ed6:speed-calculator.html'],{encoding:'utf8'}).replace(/\r\n/g,'\n'));
  assert(!fs.readFileSync('member-sync.js','utf8').includes('gbf_unf_speed_calc'));
});
