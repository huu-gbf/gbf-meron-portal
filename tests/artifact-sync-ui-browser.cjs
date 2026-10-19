/* Real browser/Firestore fixture. SDK assets are local and all service traffic is loopback. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {initializeTestEnvironment} = require('@firebase/rules-unit-testing');
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');
const {createDefaultArtifactProjection} = require('../artifact-catalog');
const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'http://127.0.0.1:18864';
const URL = ORIGIN + '/awakening-manager.html';
const CONFIG = {apiKey:'local-only',projectId:'gbf-meron-portal',appId:'artifact-ui-browser'};
const GW = 'gbf_awakening_data_gw', HIGH = 'gbf_awakening_data_high';
const OWNER = 'gbf_artifact_sync_owner_v1', PREFIX = 'gbf_artifact_sync_state_v1:';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function installFixture({seed, faults}) {
  if (location.origin === 'null') return;
  if (!sessionStorage.getItem('__artifact_ui_seeded')) {
    for (const [key,value] of Object.entries(seed)) localStorage.setItem(key,value);
    sessionStorage.setItem('__artifact_ui_seeded','1');
  }
  globalThis.MEMBER_SYNC_LOCAL = {apiBase:'/api/member-sync',firebaseConfig:{
    apiKey:'local-only',projectId:'gbf-meron-portal',appId:'artifact-ui-browser'}};
  const state = globalThis.__artifactUiFixture = {faults:{...faults},authCreates:0,reads:[],
    transactions:[],subscriptions:[],holdNext:false,held:false,release:null,
    offline:localStorage.getItem('__artifact_ui_offline')==='1'};
  Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>!state.offline});
  const isArtifact = value => /\/settings\/awakening(?:Gw|High)$/.test(value);
  const failure = () => Object.assign(Error('fixture unavailable'),{code:'unavailable'});
  const persisted = () => Object.fromEntries(Object.keys(localStorage)
    .filter(key=>key.startsWith('gbf_artifact_sync_state_v1:')).map(key=>[key,localStorage.getItem(key)]));
  const wrapped = new WeakSet();
  const hook = () => {
    const sdk=globalThis.firebase;
    if (!sdk?.initializeApp || sdk.__artifactUiHook) return;
    const initialize=sdk.initializeApp.bind(sdk);
    sdk.initializeApp=(...args)=>{
      const app=initialize(...args);
      if(app.name!=='member-sync'||wrapped.has(app))return app;
      wrapped.add(app);
      const auth=app.auth(),signin=auth.signInAnonymously.bind(auth),persistence=auth.setPersistence.bind(auth);
      auth.signInAnonymously=(...values)=>{state.authCreates++;return signin(...values);};
      auth.setPersistence=(...values)=>state.faults.auth?Promise.reject(failure()):persistence(...values);
      const db=app.firestore(),doc=db.doc.bind(db),run=db.runTransaction.bind(db);
      db.doc=key=>{
        const ref=doc(key),get=ref.get.bind(ref),listen=ref.onSnapshot.bind(ref);
        ref.get=(...values)=>{
          state.reads.push(key);
          return isArtifact(key)&&state.faults.get?Promise.reject(failure()):get(...values);
        };
        ref.onSnapshot=(...values)=>{
          state.subscriptions.push(key);
          if(isArtifact(key)&&state.faults.subscribe){
            const error=values.filter(value=>typeof value==='function')[1];
            queueMicrotask(()=>error?.(failure()));return()=>{};
          }
          return listen(...values);
        };
        return ref;
      };
      db.runTransaction=async callback=>{
        const observed={pending:persisted(),writes:[],completed:false};
        state.transactions.push(observed);
        const result=await run(async transaction=>{
          const writes=[];
          const proxy={get:ref=>transaction.get(ref),
            set(ref,data){writes.push({path:ref.path,kind:'set',keys:Object.keys(data)});transaction.set(ref,data);return proxy;},
            update(ref,data){writes.push({path:ref.path,kind:'update',keys:Object.keys(data)});transaction.update(ref,data);return proxy;}};
          const value=await callback(proxy);
          observed.writes=writes;
          if(state.faults.update&&writes.some(write=>isArtifact(write.path)))throw failure();
          return value;
        });
        observed.completed=true;
        if(state.holdNext&&observed.writes.some(write=>isArtifact(write.path))){
          state.holdNext=false;state.held=true;
          await new Promise(resolve=>{state.release=()=>{state.held=false;state.release=null;resolve();};});
        }
        return result;
      };
      return app;
    };
    Object.defineProperty(sdk,'__artifactUiHook',{value:true});
  };
  // Capture runs before the SDK loader's target onload handler continues mounting.
  document.addEventListener('load',event=>{if(event.target?.tagName==='SCRIPT')hook();},true);
  globalThis.__artifactUiHook=hook;
}

async function createFixture(browser) {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8080');
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:9099');
  const env=await initializeTestEnvironment({projectId:'gbf-meron-portal',
    firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync(path.join(ROOT,'firestore.rules'),'utf8')}});
  const devices=[];
  const admin=async operation=>{
    let result;
    await env.withSecurityRulesDisabled(async context=>{result=await operation(context.firestore());});
    return result;
  };
  const cloudPath=(profile,mode='gw')=>'memberProfiles/'+profile+'/settings/'+(mode==='gw'?'awakeningGw':'awakeningHigh');
  const cloud=(profile,mode='gw')=>admin(async db=>{const snapshot=await db.doc(cloudPath(profile,mode)).get();return snapshot.exists?snapshot.data():null;});
  const profile=async()=>{const id=randomUUID();await admin(db=>db.doc('memberProfiles/'+id).set({status:'active'}));return id;};
  const seedCloud=(owner,mode='gw',projection=createDefaultArtifactProjection(),extra={})=>admin(db=>db.doc(cloudPath(owner,mode)).set({
    schemaVersion:1,catalogVersion:1,resetEpoch:0,items:projection.items,revision:1,
    createdAt:firebase.firestore.FieldValue.serverTimestamp(),updatedAt:firebase.firestore.FieldValue.serverTimestamp(),
    updatedByDeviceId:'fixture-seed',...extra}));
  const changeIdentity=(device,owner)=>admin(async db=>{
    const id='fixture-'+randomUUID();
    await db.doc('memberProfiles/'+owner+'/devices/'+id).set({status:'active'});
    await db.doc('memberIdentities/'+device.uid).set({active:true,profileId:owner,deviceId:id});
    device.profile=owner;device.deviceId=id;
  });
  const bootstrap=`<!doctype html><html><head><meta charset="utf-8"></head><body>
    <script src="/sdk/firebase-app-compat.js"></script><script src="/sdk/firebase-auth-compat.js"></script>
    <script src="/sdk/firebase-firestore-compat.js"></script><script>
      __artifactUiHook();firebase.initializeApp(${JSON.stringify(CONFIG)},'member-sync');
      firebase.app('member-sync').auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
      firebase.app('member-sync').firestore().useEmulator('127.0.0.1',8080);
      window.__bootstrapReady=true;
    </script></body></html>`;
  const html=()=>fs.readFileSync(path.join(ROOT,'awakening-manager.html'),'utf8')
    .replace(/<link\b[^>]*\brel="preconnect"[^>]*>/gi,'')
    .replace(/<script\s+src="firebase-config\.js"[^>]*><\/script>/gi,'');
  // The document must really originate on loopback: Edge's local-network access
  // checks treat a route.fulfilled synthetic document as an unknown address space.
  const server=http.createServer((request,response)=>{
    const pathname=new globalThis.URL(request.url,ORIGIN).pathname;
    if(!['/bootstrap.html','/awakening-manager.html'].includes(pathname)){response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    response.end(pathname==='/bootstrap.html'?bootstrap:html());
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(18864,'127.0.0.1',resolve);});
  async function open({owner=null,viewport={width:1440,height:1000},seed={},faults={},unconfigured=false}={}) {
    const context=await browser.newContext({viewport,serviceWorkers:'block'});
    const device={context,page:null,uid:null,profile:owner,requests:[],external:[],pageErrors:[],consoleErrors:[],failures:[],responses:[],responseReads:[],offline:false,inTool:false,
      expectedFaults:{...faults},wasOffline:false};
    devices.push(device);
    await context.addInitScript(installFixture,{seed,faults});
    await context.route('**/*',async route=>{
      const url=new globalThis.URL(route.request().url());device.requests.push(url.href);
      if(url.origin===ORIGIN){
        if(['/bootstrap.html','/awakening-manager.html'].includes(url.pathname))return route.continue();
        if(url.pathname==='/member-sync.js'&&device.inTool&&faults.memberScript)return route.fulfill({status:503,contentType:'application/javascript',body:'/* fixture unavailable */'});
        if(url.pathname.startsWith('/sdk/')){
          const name=url.pathname.slice(5);
          if(!['firebase-app-compat.js','firebase-auth-compat.js','firebase-firestore-compat.js'].includes(name))return route.abort();
          if(device.inTool&&faults.sdk)return route.fulfill({status:503,contentType:'application/javascript',body:'/* fixture unavailable */'});
          return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(ROOT,'node_modules/firebase',name))});
        }
        if(['/artifact-catalog.js','/artifact-sync.js','/member-sync.js'].includes(url.pathname))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(ROOT,url.pathname.slice(1)))});
        if(url.pathname==='/firebase-config.js')return route.fulfill({contentType:'application/javascript',body:''});
        if(url.pathname==='/css/tailwind.min.css')return route.fulfill({contentType:'text/css',body:fs.readFileSync(path.join(ROOT,'css/tailwind.min.css'))});
        if(url.pathname==='/manifest.webmanifest')return route.fulfill({contentType:'application/manifest+json',body:'{}'});
        if(['/favicon.ico','/icons/apple-touch-icon.png'].includes(url.pathname))return route.fulfill({status:204,body:''});
      }
      if(url.hostname==='cdn.tailwindcss.com')return route.fulfill({contentType:'application/javascript',body:'window.tailwind={};document.write(\'<link rel="stylesheet" href="/css/tailwind.min.css">\');'});
      if(url.hostname==='fonts.googleapis.com')return route.fulfill({contentType:'text/css',body:''});
      if(url.hostname==='www.google.com'&&url.pathname==='/images/cleardot.gif')return route.fulfill({status:204,body:''});
      if(['127.0.0.1','localhost'].includes(url.hostname)&&['8080','9099'].includes(url.port))return route.continue();
      device.external.push(url.href);return route.abort();
    });
    const page=device.page=await context.newPage();
    page.on('pageerror',error=>device.pageErrors.push(error.message));
    page.on('requestfailed',request=>device.failures.push({url:request.url(),error:request.failure()?.errorText}));
    page.on('response',response=>{
      if(response.status()<400)return;
      device.responseReads.push((async()=>{let code;try{code=(await response.json())?.error?.status;}catch{}
        device.responses.push({url:response.url(),status:response.status(),code});})());
    });
    page.on('console',message=>{if(message.type()==='error')device.consoleErrors.push({text:message.text(),url:message.location().url});});
    if(!unconfigured){
      await page.goto(ORIGIN+'/bootstrap.html');await page.waitForFunction(()=>globalThis.__bootstrapReady);
      try {device.uid=await page.evaluate(async()=>{const result=await firebase.app('member-sync').auth().signInAnonymously();return result.user.uid;});}
      catch(error){error.message+='\nFixture requests: '+JSON.stringify(device.requests.slice(-8))+'\nBlocked: '+JSON.stringify(device.external)
        +'\nFailures: '+JSON.stringify(device.failures)+'\nConsole: '+JSON.stringify(device.consoleErrors);throw error;}
      if(!owner)device.profile=await profile();
      await changeIdentity(device,device.profile);
    }
    device.inTool=true;
    await page.goto(URL,{waitUntil:'load'});
    await page.waitForFunction(()=>document.querySelectorAll('.item-card').length===63);
    return device;
  }
  return {env,devices,admin,profile,cloud,cloudPath,seedCloud,open,changeIdentity,
    async close(){for(const device of devices)await device.context.close();server.closeAllConnections();
      await new Promise(resolve=>server.close(resolve));await env.cleanup();}};
}

async function waitCloud(fixture,owner,predicate,mode='gw') {
  for(let attempt=0;attempt<160;attempt++){const value=await fixture.cloud(owner,mode);if(predicate(value))return value;await pause(50);}
  throw Error('Artifact cloud did not converge for '+mode);
}
async function waitLocal(device,key,field,value,mode='gw') {
  await device.page.waitForFunction(({key,field,value,mode})=>{
    const saved=JSON.parse(localStorage.getItem(mode==='gw'?'gbf_awakening_data_gw':'gbf_awakening_data_high')||'{}');
    return saved[key]?.[field]===value;
  },{key,field,value,mode},{timeout:12000});
}
async function needed(device,key,value,mode='gw') {
  const [prefix,index]=key.split('_'),tab={s12:'slot12',s3:'slot3',s4:'slot4'}[prefix],list={s12:'list-slot12',s3:'list-slot3',s4:'list-slot4'}[prefix];
  await device.page.locator('#mode-btn-'+mode).click();await device.page.locator('#nav-'+tab).click();
  await device.page.locator('#'+list+' input[type=checkbox]').nth(Number(index)).setChecked(value,{force:true});
}
async function selected(device,key,value,mode='gw') {
  const [prefix,index]=key.split('_'),tab={s12:'slot12',s3:'slot3'}[prefix],list={s12:'list-slot12',s3:'list-slot3'}[prefix];
  await device.page.locator('#mode-btn-'+mode).click();await device.page.locator('#nav-'+tab).click();
  await device.page.locator('#'+list+' select').nth(Number(index)).selectOption(value);
}
async function memo(device,text,mode='gw') {
  await device.page.locator('#mode-btn-'+mode).click();await device.page.locator('#nav-summary').click();
  await device.page.locator('#memo-container > div').first().locator('input').nth(1).fill(text);
}
async function reset(device,mode='gw') {
  await device.page.locator('#mode-btn-'+mode).click();
  const dialog=new Promise(resolve=>device.page.once('dialog',async dialog=>{assert.equal(dialog.type(),'confirm');await dialog.accept();resolve();}));
  await device.page.locator('button[onclick="resetAllData()"]').click();await dialog;
}
const storage=device=>device.page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)])));
const fixtureState=device=>device.page.evaluate(()=>({authCreates:__artifactUiFixture.authCreates,reads:__artifactUiFixture.reads,
  transactions:__artifactUiFixture.transactions,subscriptions:__artifactUiFixture.subscriptions,held:__artifactUiFixture.held}));
const syncState=device=>device.page.evaluate(()=>typeof artifactSync!=='undefined'?artifactSync?.snapshot():null);
async function idle(device,mode='gw'){
  await device.page.waitForFunction(mode=>typeof artifactSync!=='undefined'&&artifactSync?.snapshot()?.modes?.[mode]
    &&artifactSync.snapshot().modes[mode].pending.length===0,mode,{timeout:12000});
}
async function offline(device,value){
  device.offline=value;device.wasOffline ||= value;
  // Partition the real Firestore transport, while the fixture document stays
  // reloadable. Hosting/cache availability is outside this sync regression.
  await device.page.evaluate(async value=>{
    __artifactUiFixture.offline=value;
    if(value)localStorage.setItem('__artifact_ui_offline','1');else localStorage.removeItem('__artifact_ui_offline');
    for(const app of globalThis.firebase?.apps||[]){
      if(app.name==='member-sync'&&typeof app.firestore==='function')await app.firestore()[value?'disableNetwork':'enableNetwork']();
    }
    dispatchEvent(new Event(value?'offline':'online'));
  },value);
}
async function resume(device){await device.page.evaluate(()=>{dispatchEvent(new Event('online'));dispatchEvent(new Event('pageshow'));});}
module.exports={createFixture,waitCloud,waitLocal,needed,selected,memo,reset,storage,fixtureState,syncState,idle,offline,resume,pause,
  GW,HIGH,OWNER,PREFIX,URL,ORIGIN};
