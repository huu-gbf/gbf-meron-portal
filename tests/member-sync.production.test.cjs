// Production host simulation: every browser request is fulfilled or aborted locally.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {environmentOptions} = require('../member-sync');
const config = {};
vm.runInNewContext(fs.readFileSync('firebase-config.js','utf8'), config);
const production = {...config, location:new URL('https://huu-gbf.github.io/gbf-crew-portal/speed-calculator-folder/speed-calculator.html')};

test('production reuses shared config and HTTPS API, pinned SDK without fixture',()=>{
  const result=environmentOptions(production);
  assert.equal(result.firebaseConfig,config.firebaseConfig);
  assert.equal(result.options.apiBase,config.API_BASE_URL+'/api/member-sync');
  assert.equal(result.sdkBase,'https://www.gstatic.com/firebasejs/10.8.0/');
  assert.equal(result.options.connectEmulators,undefined);
});
test('both loopback hosts require explicit fixture and cannot inherit production',()=>{
  for(const host of ['localhost','127.0.0.1']) {
    const scope={...production,location:new URL('http://'+host+':18765/')};
    assert.throws(()=>environmentOptions(scope),/NOT_READY/);
    scope.MEMBER_SYNC_LOCAL={apiBase:'/api/member-sync',firebaseConfig:{projectId:'gbf-meron-portal',apiKey:'local-only'}};
    assert.equal(environmentOptions(scope).sdkBase,'/sdk/');
    assert.equal(typeof environmentOptions(scope).options.connectEmulators,'function');
  }
});
test('production rejects fixture, insecure API and malformed configuration',()=>{
  assert.throws(()=>environmentOptions({...production,MEMBER_SYNC_LOCAL:{}}),/NOT_READY/);
  for(const API_BASE_URL of ['http://example.com','https://localhost','https://a.test/path','https://u:p@a.test','https://a.test/?q=1','/api'])
    assert.throws(()=>environmentOptions({...production,API_BASE_URL}),/NOT_READY/);
  assert.throws(()=>environmentOptions({...production,firebaseConfig:undefined}),/NOT_READY/);
});

for(const persisted of [false,true]) test('mock production page restores '+(persisted?'existing identity':'no account')+' and keeps calculator usable',async()=>{
  const {chromium}=require('playwright');
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
    const requests=[];
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());requests.push(url.href);
      if(url.href===production.location.href) return route.fulfill({contentType:'text/html',body:fs.readFileSync('speed-calculator-folder/speed-calculator.html','utf8').replace(/<link[^>]+href="https:\/\/fonts\.[^>]+>/g,'')});
      const name=url.pathname.split('/').pop();
      if(url.origin===production.location.origin && ['member-sync.js','member-sync.css','firebase-config.js','favicon.svg'].includes(name))
        return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'image/svg+xml',body:fs.readFileSync(name,'utf8')});
      return route.abort();
    });
    await context.addInitScript(persisted=>{
      window.calls=[];
      const user=persisted?{uid:'mock-member',isAnonymous:true,getIdToken:async()=> 'mock-token'}:null;
      const auth={currentUser:user,setPersistence:async()=>{},onAuthStateChanged:cb=>{queueMicrotask(()=>cb(user));return ()=>{};},signInAnonymously:async()=>{calls.push('SIGN_IN');throw Error('forbidden');}};
      const identity={active:true,profileId:'mock-profile',deviceId:'mock-device'};
      const data={schemaVersion:1,hellTimesSec:Object.fromEntries(['90','95','100','150','200','250'].map(k=>[k,10])),intervalSec:1,revision:1,updatedByDeviceId:'mock-device'};
      class Timestamp {}
      data.createdAt=data.updatedAt=new Timestamp();
      const snap={exists:true,data:()=>data,metadata:{hasPendingWrites:false,fromCache:false}};
      const ref={get:async()=>snap,onSnapshot:(...args)=>{queueMicrotask(()=>args.find(v=>typeof v==='function')(snap));return ()=>{};}};
      const db={doc:path=>{calls.push(path);return path.startsWith('memberIdentities/')?{get:async()=>({exists:true,data:()=>identity})}:ref;}};
      const forbidden=()=>{throw Error('manager/default auth touched');};
      window.firebase={apps:[{name:'[DEFAULT]',auth:forbidden},{name:'yosen-shared',auth:forbidden}],
        initializeApp:(cfg,name)=>{calls.push(name);const app={name,options:cfg,auth:()=>auth,firestore:()=>db};firebase.apps.push(app);return app;},
        auth:{Auth:{Persistence:{LOCAL:'local'}}},firestore:{Timestamp}};
      window.fetch=async(url,options)=>{
        calls.push(url);
        if(!url.startsWith('https://meron-ai-api-281908486591.asia-northeast1.run.app/api/member-sync/'))throw Error('unexpected API');
        if(options.headers.Authorization!=='Bearer mock-token')throw Error('missing token');
        return {ok:true,json:async()=>url.endsWith('/status')?{status:'ready'}:{requests:[]}};
      };
    },persisted);
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(production.location.href);
    await page.waitForFunction(()=>document.querySelector('[data-member-sync]').getAttribute('aria-busy')==='false');
    if(persisted) {
      await page.waitForFunction(()=>calls.includes('memberProfiles/mock-profile/settings/speedCalculator'));
      await page.waitForFunction(()=>document.querySelector('.table-time-input[data-hell="200"]').value==='10');
      assert.equal(await page.locator('#inputInterval').inputValue(),'1');
    }
    const calls=await page.evaluate(()=>window.calls);
    assert(calls.includes('member-sync'));assert(!calls.includes('SIGN_IN'));
    assert.equal(calls.some(v=>v.endsWith('/status')),persisted);
    assert(!requests.some(v=>v.includes('/sdk/')));
    assert(!requests.some(v=>v.includes('www.gstatic.com')),'existing compat SDK must be reused');
    assert(!calls.some(v=>v.endsWith('/profile')),'restore must not create a profile');
    assert.equal(await page.locator('[data-sync="status"]').textContent(),persisted?'接続済み':'未設定');
    await page.locator('#inputMinutes').fill('2');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});

test('production loads pinned SDK asynchronously and calculator works before SDK completion',async()=>{
  const {chromium}=require('playwright');
  const browser=await chromium.launch({channel:'msedge',headless:true});
  let release;
  try {
    const context=await browser.newContext({serviceWorkers:'block'});
    const sdkRequests=[];
    const held=new Promise(resolve=>{release=resolve;});
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.href===production.location.href)return route.fulfill({contentType:'text/html',body:fs.readFileSync('speed-calculator-folder/speed-calculator.html','utf8').replace(/<link[^>]+href="https:\/\/fonts\.[^>]+>/g,'')});
      const name=url.pathname.split('/').pop();
      if(url.origin===production.location.origin && ['member-sync.js','firebase-config.js','member-sync.css'].includes(name))
        return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':'text/css',body:fs.readFileSync(name,'utf8')});
      if(url.hostname==='www.gstatic.com'){sdkRequests.push(url.href);await held;}
      return route.abort();
    });
    const page=await context.newPage();
    await page.goto(production.location.href,{waitUntil:'domcontentloaded'});
    await page.locator('#inputMinutes').fill('3');
    assert.equal(await page.locator('#inputMinutes').inputValue(),'3');
    assert.deepEqual(sdkRequests,['https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js']);
    release();
    await page.waitForFunction(()=>document.querySelector('[data-sync="message"]').textContent.includes('利用できません'));
    assert.equal(await page.evaluate(()=>typeof firebase),'undefined');
  } finally {release?.();await browser.close();}
});
