/* Real Firestore emulator transactions/Rules. Auth events are controlled locally;
 * existing real Auth + browser pairing suites run separately as regressions. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const {initializeTestEnvironment, assertSucceeds, assertFails} = require('@firebase/rules-unit-testing');
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');
const {createMemberSync} = require('../member-sync');
const stamp = () => firebase.firestore.FieldValue.serverTimestamp();
const initial = () => ({hellTimesSec:{90:10,95:20,100:45,150:70,200:90,250:240},intervalSec:3});
const document = device => ({schemaVersion:1,...initial(),revision:1,createdAt:stamp(),updatedAt:stamp(),updatedByDeviceId:device});
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate) {
  for(let i=0;i<200;i++){if(predicate())return;await pause(25);}
  throw Error('Expected subscription state was not received');
}
async function fixture() {
  const env=await initializeTestEnvironment({projectId:'demo-gbf-meron-portal-rules',firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore.rules','utf8')}});
  const profileA=randomUUID(), profileB=randomUUID(), prefix=randomUUID();
  const members=[['A1',profileA,'deviceA1'],['A2',profileA,'deviceA2'],['B1',profileB,'deviceB1'],['inactive',profileA,'deviceInactive']];
  const identities={};const dbs={};
  await env.withSecurityRulesDisabled(async ctx=>{
    const db=ctx.firestore();
    for(const p of [profileA,profileB])await db.doc('memberProfiles/'+p).set({status:'active'});
    for(const [name,profileId,deviceId] of members){
      const uid=prefix+name;identities[name]={uid,profileId,deviceId,active:name!=='inactive'};
      await db.doc('memberIdentities/'+uid).set({profileId,deviceId,active:name!=='inactive'});
      await db.doc('memberProfiles/'+profileId+'/devices/'+deviceId).set({status:'active'});
      dbs[name]=env.authenticatedContext(uid).firestore();
    }
  });
  dbs.guest=env.unauthenticatedContext().firestore();
  const path=p=>'memberProfiles/'+p+'/settings/speedCalculator';
  const admin=operation=>env.withSecurityRulesDisabled(ctx=>operation(ctx.firestore()));
  return {env,profileA,profileB,identities,dbs,path,admin};
}
async function client(f,name) {
  const watchers=new Set();
  const auth={currentUser:{uid:f.identities[name].uid,isAnonymous:true},setPersistence:async()=>{},
    onAuthStateChanged(callback){watchers.add(callback);queueMicrotask(()=>{if(watchers.has(callback))callback(auth.currentUser);});return ()=>watchers.delete(callback);},
    signInAnonymously:async()=>{throw Error('Unexpected account creation');}};
  const sdk={apps:[],auth:{Auth:{Persistence:{LOCAL:'local'}}},firestore:firebase.firestore,
    initializeApp:()=>({auth:()=>auth,firestore:()=>f.dbs[name]})};
  const api=createMemberSync(sdk,{});await api.restoreAuthentication();
  return {api,signOut(){auth.currentUser=null;watchers.forEach(callback=>callback(null));},watchers};
}

test('speedCalculator Rules: exact schema, ownership, timestamps, revisions and numeric boundaries',async t=>{
  const f=await fixture();const {dbs,path,profileA,profileB,admin}=f;
  const ref=dbs.A1.doc(path(profileA));
  const reset=()=>admin(db=>db.doc(path(profileA)).delete());
  try {
    await t.test('A1 and A2 read; other profile, guest, inactive/missing identity and profile denied',async()=>{
      await ref.set(document('deviceA1'));
      for(const name of ['A1','A2'])await assertSucceeds(dbs[name].doc(path(profileA)).get());
      for(const name of ['B1','guest','inactive'])await assertFails(dbs[name].doc(path(profileA)).get());
      await assertFails(dbs.A1.doc(path(profileB)).get());
      await assertFails(f.env.authenticatedContext('no-identity').firestore().doc(path(profileA)).get());
      await admin(db=>db.doc('memberProfiles/'+profileA).update({status:'inactive'}));
      await assertFails(ref.get());await assertFails(ref.update({intervalSec:4,revision:2,updatedAt:stamp()}));
      await admin(db=>db.doc('memberProfiles/'+profileA).update({status:'active'}));
      await reset();
    });
    await t.test('create accepts exactly six HELL integer boundaries and server timestamps',async()=>{
      for(const value of [0,999,1000,3599]){
        const data=document('deviceA1');for(const key of Object.keys(data.hellTimesSec))data.hellTimesSec[key]=value;
        await assertSucceeds(ref.set(data));await reset();
      }
    });
    await t.test('create denies missing/extra fields, wrong schema/revision/device and client timestamps',async()=>{
      const changes=[{revision:0},{revision:2},{revision:1.5},{revision:'1'}, {schemaVersion:2},{schemaVersion:true},
        {updatedByDeviceId:'deviceA2'},{updatedByDeviceId:1},{extra:'no'},
        {createdAt:new Date(0)},{updatedAt:new Date(0)},{createdAt:null}];
      for(const change of changes)await assertFails(ref.set({...document('deviceA1'),...change}));
      for(const key of Object.keys(document('deviceA1'))){const data=document('deviceA1');delete data[key];await assertFails(ref.set(data));}
      for(const name of ['B1','guest','inactive'])await assertFails(dbs[name].doc(path(profileA)).set(document(f.identities[name]?.deviceId || 'fake')));
    });
    await t.test('create denies missing/extra HELL keys and all invalid types/ranges',async()=>{
      for(const level of Object.keys(initial().hellTimesSec)){
        const missing=document('deviceA1');delete missing.hellTimesSec[level];await assertFails(ref.set(missing));
        for(const value of [-1,3600,1.5,'12',null,true,NaN,Infinity]){
          const data=document('deviceA1');data.hellTimesSec[level]=value;await assertFails(ref.set(data));
        }
      }
      await assertFails(ref.set({...document('deviceA1'),hellTimesSec:{...initial().hellTimesSec,300:10}}));
      for(const value of [null,[],12,'bad'])await assertFails(ref.set({...document('deviceA1'),hellTimesSec:value}));
    });
    await t.test('all 151 canonical tenths from 0 to 15 are accepted; off-grid values are denied',async()=>{
      await ref.set(document('deviceA1'));
      for(let tenth=0;tenth<=150;tenth++)await assertSucceeds(ref.update({intervalSec:tenth/10,revision:tenth+2,updatedAt:stamp()}));
      await reset();
      for(const intervalSec of [-0.1,15.1,0.01,3.05,0.30000000000000004,NaN,Infinity,'3',null,true]){
        await assertFails(ref.set({...document('deviceA1'),intervalSec}));
      }
    });
    await t.test('update accepts A2 attribution and revision +1 while preserving createdAt',async()=>{
      await ref.set(document('deviceA1'));
      const before=(await ref.get()).data();
      await assertSucceeds(dbs.A2.doc(path(profileA)).update({'hellTimesSec.90':3599,intervalSec:3.5,revision:2,updatedAt:stamp(),updatedByDeviceId:'deviceA2'}));
      const after=(await ref.get()).data();assert(after.createdAt.isEqual(before.createdAt));assert.equal(after.revision,2);
    });
    await t.test('update rejects invalid revisions, immutables, attribution, schema, values and ownership',async()=>{
      const valid={revision:3,updatedAt:stamp(),updatedByDeviceId:'deviceA1'};
      for(const change of [{revision:2},{revision:4},{revision:3.5},{revision:'3'}, {schemaVersion:2},
        {createdAt:stamp()},{updatedAt:new Date(0)},{updatedByDeviceId:'deviceA2'}, {extra:1},
        {'hellTimesSec.90':-1},{'hellTimesSec.250':3600},{'hellTimesSec.95':1.5},
        {'hellTimesSec.300':10},{'hellTimesSec.100':firebase.firestore.FieldValue.delete()},
        {intervalSec:-1},{intervalSec:16},{intervalSec:3.05},{intervalSec:NaN},{hellTimesSec:[]},
        {intervalSec:firebase.firestore.FieldValue.delete()}])await assertFails(ref.update({...valid,...change}));
      for(const name of ['B1','guest','inactive'])await assertFails(dbs[name].doc(path(profileA)).update({...valid,updatedByDeviceId:f.identities[name]?.deviceId || 'fake'}));
      await assertFails(dbs.A1.doc(path(profileB)).set(document('deviceA1')));
    });
    await t.test('delete, collection listing, sibling settings and nested paths are denied',async()=>{
      for(const name of ['A1','A2','B1','guest','inactive'])await assertFails(dbs[name].doc(path(profileA)).delete());
      await assertFails(dbs.A1.collection('memberProfiles/'+profileA+'/settings').get());
      await assertFails(dbs.A1.doc('memberProfiles/'+profileA+'/settings/anotherTool').set(document('deviceA1')));
      await assertFails(dbs.A1.doc(path(profileA)+'/nested/child').set({value:1}));
    });
  } finally {await f.env.cleanup();}
});

test('speedCalculator client: real transactions, concurrent writers and subscription lifecycle',async t=>{
  const f=await fixture();const a=await client(f,'A1'),b=await client(f,'A2');
  const ref=f.dbs.A1.doc(f.path(f.profileA));const cleanup=[];
  try {
    await t.test('missing get is null; simultaneous initialize creates revision 1 only',async()=>{
      assert.equal(await a.api.getSpeedCalculatorSettings(),null);
      await assert.rejects(a.api.updateSpeedCalculatorField('intervalSec',3),/SETTINGS_NOT_INITIALIZED/);
      const absent=[];const stop=a.api.subscribeSpeedCalculatorSettings(data=>absent.push(data));cleanup.push(stop);
      await until(()=>absent.length);stop();assert.deepEqual(absent,[null]);
      const other={...initial(),intervalSec:5};
      const results=await Promise.all([a.api.initializeSpeedCalculatorSettings(initial()),b.api.initializeSpeedCalculatorSettings(other)]);
      assert.equal(results[0].revision,1);assert.equal(results[1].revision,1);
      assert.equal(results[0].intervalSec,results[1].intervalSec);
      assert.equal((await ref.get()).data().revision,1);
    });
    await t.test('initialize existing document never overwrites it, including timestamps',async()=>{
      const before=(await ref.get()).data();
      const received=await a.api.initializeSpeedCalculatorSettings({hellTimesSec:{90:3599,95:3599,100:3599,150:3599,200:3599,250:3599},intervalSec:15});
      assert.deepEqual(received,before);assert.deepEqual((await ref.get()).data(),before);
      assert(Object.isFrozen(received));assert(Object.isFrozen(received.hellTimesSec));
    });
    await t.test('get validates; one HELL update preserves other HELLs; interval preserves all HELLs',async()=>{
      const before=await a.api.getSpeedCalculatorSettings();
      assert.equal(await a.api.updateSpeedCalculatorField('hellTimesSec.90',20),2);
      const hell=await a.api.getSpeedCalculatorSettings();assert.deepEqual(hell.hellTimesSec,{...before.hellTimesSec,90:20});
      assert.equal(hell.intervalSec,before.intervalSec);assert.equal(hell.updatedByDeviceId,'deviceA1');
      assert.equal(await b.api.updateSpeedCalculatorField('intervalSec',4.1),3);
      const interval=await a.api.getSpeedCalculatorSettings();assert.deepEqual(interval.hellTimesSec,hell.hellTimesSec);assert.equal(interval.updatedByDeviceId,'deviceA2');
    });
    await t.test('simultaneous different fields both survive and revision advances twice',async()=>{
      const before=await a.api.getSpeedCalculatorSettings();
      const revisions=await Promise.all([a.api.updateSpeedCalculatorField('hellTimesSec.90',12),b.api.updateSpeedCalculatorField('hellTimesSec.250',220)]);
      const after=await a.api.getSpeedCalculatorSettings();
      assert.equal(after.hellTimesSec['90'],12);assert.equal(after.hellTimesSec['250'],220);
      assert.deepEqual(revisions.slice().sort((x,y)=>x-y),[before.revision+1,before.revision+2]);assert.equal(after.revision,before.revision+2);
    });
    await t.test('same field conflict resolves by final successful transaction, not device time',async()=>{
      const before=await a.api.getSpeedCalculatorSettings();
      const revisions=await Promise.all([a.api.updateSpeedCalculatorField('hellTimesSec.90',12),b.api.updateSpeedCalculatorField('hellTimesSec.90',15)]);
      const after=await a.api.getSpeedCalculatorSettings();
      assert.equal(after.revision,before.revision+2);assert.equal(after.hellTimesSec['90'],revisions[0]>revisions[1]?12:15);
      assert.equal(after.updatedByDeviceId,revisions[0]>revisions[1]?'deviceA1':'deviceA2');
    });
    await t.test('A1 write is received by A2 as validated server data; unsubscribe stops callbacks',async()=>{
      const received=[],errors=[];const stop=b.api.subscribeSpeedCalculatorSettings(data=>received.push(data),error=>errors.push(error.message));cleanup.push(stop);
      assert.equal(typeof stop,'function');await until(()=>received.length);
      const revision=await a.api.updateSpeedCalculatorField('hellTimesSec.95',25);
      await until(()=>received.some(data=>data?.revision===revision));
      assert.equal(received.at(-1).hellTimesSec['95'],25);assert.deepEqual(errors,[]);
      stop();stop();const count=received.length;await a.api.updateSpeedCalculatorField('hellTimesSec.95',26);await pause(150);assert.equal(received.length,count);
    });
    await t.test('unsubscribe before asynchronous setup does not install listeners or deliver data',async()=>{
      let calls=0;const stop=a.api.subscribeSpeedCalculatorSettings(()=>calls++,()=>calls++);stop();await pause(150);
      assert.equal(calls,0);assert.equal(a.watchers.size,0);
    });
    await t.test('invalid server documents fail get/initialize/update and never reach subscribers',async()=>{
      const valid=(await ref.get()).data();
      const bad=[{...valid,schemaVersion:2},{...valid,revision:0},{...valid,extra:1},
        {...valid,hellTimesSec:{...valid.hellTimesSec,90:3600}},{...valid,intervalSec:3.05},
        {...valid,createdAt:'yesterday'},{...valid,updatedByDeviceId:null}];
      const missing={...valid};delete missing.intervalSec;bad.push(missing);
      for(const value of bad){
        await f.admin(db=>db.doc(f.path(f.profileA)).set(value));
        await assert.rejects(a.api.getSpeedCalculatorSettings(),/INVALID_SETTINGS/);
        await assert.rejects(a.api.initializeSpeedCalculatorSettings(initial()),/INVALID_SETTINGS/);
        await assert.rejects(a.api.updateSpeedCalculatorField('intervalSec',3),/INVALID_SETTINGS/);
      }
      const received=[],errors=[];const stop=b.api.subscribeSpeedCalculatorSettings(data=>received.push(data),error=>errors.push(error.message));cleanup.push(stop);
      await until(()=>errors.length);assert.deepEqual(received,[]);assert.deepEqual(errors,['INVALID_SETTINGS']);
      await f.admin(db=>db.doc(f.path(f.profileA)).set(valid));await pause(150);assert.deepEqual(received,[]);
      const live=[],liveErrors=[];const stopLive=b.api.subscribeSpeedCalculatorSettings(data=>live.push(data),error=>liveErrors.push(error.message));cleanup.push(stopLive);
      await until(()=>live.length);const count=live.length;
      await f.admin(db=>db.doc(f.path(f.profileA)).set({...valid,intervalSec:3.05}));
      await until(()=>liveErrors.length);assert.deepEqual(liveErrors,['INVALID_SETTINGS']);assert.equal(live.length,count);
      await f.admin(db=>db.doc(f.path(f.profileA)).set(valid));
    });
    await t.test('identity revocation stops subscription without requiring a settings change',async()=>{
      const received=[],errors=[];const stop=b.api.subscribeSpeedCalculatorSettings(data=>received.push(data),error=>errors.push(error.message));cleanup.push(stop);
      await until(()=>received.length);
      await f.admin(db=>db.doc('memberIdentities/'+f.identities.A2.uid).update({active:false}));
      await until(()=>errors.length);const count=received.length;
      await a.api.updateSpeedCalculatorField('intervalSec',6);await pause(150);assert.equal(received.length,count);
      await assert.rejects(b.api.getSpeedCalculatorSettings());await assert.rejects(b.api.updateSpeedCalculatorField('intervalSec',7));
      assert.equal(b.watchers.size,0);
    });
    await t.test('auth disappearance stops subscription and rejects subsequent get/write',async()=>{
      const received=[],errors=[];const stop=a.api.subscribeSpeedCalculatorSettings(data=>received.push(data),error=>errors.push(error.message));cleanup.push(stop);
      await until(()=>received.length);a.signOut();await until(()=>errors.length);
      assert.deepEqual(errors,['UNAUTHENTICATED']);assert.equal(a.watchers.size,0);
      await assert.rejects(a.api.getSpeedCalculatorSettings(),/UNAUTHENTICATED/);
      await assert.rejects(a.api.initializeSpeedCalculatorSettings(initial()),/UNAUTHENTICATED/);
      await assert.rejects(a.api.updateSpeedCalculatorField('intervalSec',7),/UNAUTHENTICATED/);
    });
  } finally {cleanup.forEach(stop=>stop());await f.env.cleanup();}
});
