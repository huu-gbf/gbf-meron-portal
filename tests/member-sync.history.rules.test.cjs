/* Local Firestore emulator only. Existing identity and speed rules are separate regressions. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const {initializeTestEnvironment, assertSucceeds, assertFails} = require('@firebase/rules-unit-testing');
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');

const stamp = () => firebase.firestore.FieldValue.serverTimestamp();
const document = (seenIds = [], device = 'pc') => ({schemaVersion:1,seenIds,revision:1,
  createdAt:stamp(),updatedAt:stamp(),updatedByDeviceId:device});

async function fixture() {
  const env = await initializeTestEnvironment({projectId:'demo-gbf-meron-portal-rules',
    firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore.rules','utf8')}});
  const profileA=randomUUID(), profileB=randomUUID(), prefix=randomUUID();
  const dbs={};
  const members=[['owner',profileA,'pc',true,'active'],['second',profileA,'phone',true,'active'],
    ['other',profileB,'other',true,'active'],['inactiveIdentity',profileA,'inactive-identity',false,'active'],
    ['inactiveDevice',profileA,'inactive-device',true,'revoked'],['missingDevice',profileA,'missing-device',true,null],
    ['malformedDevice',profileA,'malformed-device',true,{}]];
  const path=p=>'memberProfiles/'+p+'/settings/historyReadState';
  const admin=fn=>env.withSecurityRulesDisabled(ctx=>fn(ctx.firestore()));
  await admin(async db=>{
    for(const p of [profileA,profileB])await db.doc('memberProfiles/'+p).set({status:'active'});
    for(const [name,profileId,deviceId,active,status] of members){
      const uid=prefix+name;
      await db.doc('memberIdentities/'+uid).set({profileId,deviceId,active});
      if(status!==null)await db.doc('memberProfiles/'+profileId+'/devices/'+deviceId).set(typeof status==='string'?{status}:status);
      dbs[name]=env.authenticatedContext(uid).firestore();
    }
    for(const [name,data] of [['missingDeviceId',{profileId:profileA,active:true}],
      ['nonStringDeviceId',{profileId:profileA,active:true,deviceId:7}],
      ['missingProfile',{profileId:randomUUID(),active:true,deviceId:'pc'}],
      ['malformedIdentity',{active:true}]]){
      await db.doc('memberIdentities/'+prefix+name).set(data);
      dbs[name]=env.authenticatedContext(prefix+name).firestore();
    }
  });
  dbs.missingIdentity=env.authenticatedContext(prefix+'unknown').firestore();
  dbs.guest=env.unauthenticatedContext().firestore();
  const ref=dbs.owner.doc(path(profileA));
  const clear=()=>admin(db=>db.doc(path(profileA)).delete());
  const seed=(seenIds=['A'],extra={})=>admin(db=>db.doc(path(profileA)).set({...document(seenIds),...extra}));
  const append=(seenIds,extra={})=>ref.update({seenIds,revision:2,updatedAt:stamp(),...extra});
  return {env,profileA,profileB,dbs,path,admin,ref,clear,seed,append};
}

test('historyReadState Rules: strict schema, active ownership and monotonic append',async t=>{
  const f=await fixture();const {dbs,profileA,profileB,path,ref,admin,clear,seed,append}=f;
  try {
    await t.test('A active owner and second active device can get their history',async()=>{
      await seed();
      for(const name of ['owner','second'])assert.equal((await assertSucceeds(dbs[name].doc(path(profileA)).get())).exists,true);
    });
    await t.test('B other profile, anonymous guest and missing identity cannot read or write',async()=>{
      for(const name of ['other','guest','missingIdentity']){
        const target=dbs[name].doc(path(profileA));
        await assertFails(target.get());await assertFails(target.update({seenIds:['A','B'],revision:2,updatedAt:stamp()}));
      }
      await assertFails(dbs.owner.doc(path(profileB)).get());
      await assertFails(dbs.owner.doc(path(profileB)).set(document()));
    });
    await t.test('C inactive identity cannot get/create/update',async()=>{
      const target=dbs.inactiveIdentity.doc(path(profileA));await assertFails(target.get());
      await assertFails(target.update({seenIds:['A','B'],revision:2,updatedAt:stamp(),updatedByDeviceId:'inactive-identity'}));
      await clear();await assertFails(target.set(document([],'inactive-identity')));
    });
    await t.test('D inactive profile cannot get/create/update',async()=>{
      await seed();await admin(db=>db.doc('memberProfiles/'+profileA).update({status:'inactive'}));
      await assertFails(ref.get());await assertFails(append(['A','B']));
      await clear();await assertFails(ref.set(document()));
      await admin(db=>db.doc('memberProfiles/'+profileA).update({status:'active'}));
    });
    await t.test('E inactive device cannot get/create/update',async()=>{
      const target=dbs.inactiveDevice.doc(path(profileA));await seed();await assertFails(target.get());
      await assertFails(target.update({seenIds:['A','B'],revision:2,updatedAt:stamp(),updatedByDeviceId:'inactive-device'}));
      await clear();await assertFails(target.set(document([],'inactive-device')));
    });
    await t.test('missing/malformed identity, profile and device fail closed',async()=>{
      for(const name of ['missingDevice','malformedDevice','missingDeviceId','nonStringDeviceId','missingProfile','malformedIdentity']){
        const target=dbs[name].doc(path(profileA));
        await assertFails(target.get());await assertFails(target.set(document()));
        await seed();await assertFails(target.update({seenIds:['A','B'],revision:2,updatedAt:stamp()}));await clear();
      }
    });
    await t.test('F create [] succeeds with exactly six fields and server timestamps',async()=>{
      await assertSucceeds(ref.set(document()));
      const received=(await ref.get()).data();assert.deepEqual(received.seenIds,[]);assert.equal(received.revision,1);
      assert(received.createdAt.isEqual(received.updatedAt));await clear();
    });
    await t.test('G create one real date/title ID succeeds without enforcing an ID format',async()=>{
      for(const id of ['2026年10月19日|更新履歴の既読同期','future-id-format']){
        await assertSucceeds(ref.set(document([id])));assert.deepEqual((await ref.get()).data().seenIds,[id]);await clear();
      }
    });
    await t.test('H initial create with two or more IDs is denied',async()=>{
      for(const seenIds of [['A','B'],Array.from({length:256},(_,i)=>'id-'+i)])await assertFails(ref.set(document(seenIds)));
    });
    await t.test('I invalid initial/update revisions and unsafe integer overflow are denied',async()=>{
      for(const revision of [0,2,1.5,'1',null,9007199254740992])await assertFails(ref.set({...document(),revision}));
      await seed();
      for(const revision of [0,1,3,2.5,'2',null,9007199254740992])await assertFails(append(['A','B'],{revision}));
      await seed(['A'],{revision:9007199254740991});await assertFails(append(['A','B'],{revision:9007199254740992}));await clear();
    });
    await t.test('J client-created createdAt is denied',async()=>{
      for(const createdAt of [new Date(0),null,'today',1])await assertFails(ref.set({...document(),createdAt}));
    });
    await t.test('K client-created updatedAt is denied on create and update',async()=>{
      for(const updatedAt of [new Date(0),null,'today',1])await assertFails(ref.set({...document(),updatedAt}));
      await seed();await assertFails(append(['A','B'],{updatedAt:new Date(0)}));await clear();
    });
    await t.test('L another or malformed updatedByDeviceId is denied',async()=>{
      for(const updatedByDeviceId of ['phone','missing-device','',null,7])await assertFails(ref.set({...document(),updatedByDeviceId}));
      await seed();await assertFails(append(['A','B'],{updatedByDeviceId:'phone'}));await clear();
    });
    await t.test('M unknown and missing required fields are denied on create and update',async()=>{
      await assertFails(ref.set({...document(),extra:true}));
      for(const key of Object.keys(document())){const data=document();delete data[key];await assertFails(ref.set(data));}
      await seed();await assertFails(append(['A','B'],{extra:true}));
      for(const key of Object.keys(document()))await assertFails(append(['A','B'],{[key]:firebase.firestore.FieldValue.delete()}));
      await clear();
    });
    await t.test('N non-list seenIds and non-string members are denied',async()=>{
      for(const seenIds of [null,{},'A',1,true,[null],[{}],[1],[true]])await assertFails(ref.set(document(seenIds)));
      // Nested arrays never reach Rules: the SDK rejects their wire encoding synchronously.
      assert.throws(()=>ref.set(document([['A']])),/Nested arrays/);
      await seed();for(const value of [null,{},1,true])await assertFails(append(['A',value]));
      assert.throws(()=>append(['A',['B']]),/Nested arrays/);await clear();
    });
    await t.test('O empty IDs are denied on create and append',async()=>{
      await assertFails(ref.set(document([''])));await seed();await assertFails(append(['A','']));await clear();
    });
    await t.test('P ASCII, Japanese, emoji and newline IDs accept 512 Unicode characters and reject 513',async p=>{
      for(const character of ['x','履','😀','\n']){
        const maximum=character.repeat(512),tooLong=character.repeat(513);
        p.diagnostic('create boundary character '+JSON.stringify(character));
        await assertSucceeds(ref.set(document([maximum])));await clear();
        await assertFails(ref.set(document([tooLong])));
        p.diagnostic('append boundary character '+JSON.stringify(character));
        await seed();await assertSucceeds(append(['A',maximum]));await clear();
        await seed();await assertFails(append(['A',tooLong]));await clear();
      }
    });
    await t.test('Q duplicate IDs are denied on create and append',async()=>{
      await assertFails(ref.set(document(['A','A'])));await seed();await assertFails(append(['A','A']));await clear();
    });
    await t.test('R 256 IDs are retained and the 257th ID is denied',async()=>{
      const ids=Array.from({length:256},(_,i)=>'history-'+i);
      await assertFails(ref.set(document([...ids,'too-many'])));
      await seed(ids.slice(0,255));await assertSucceeds(append(ids));
      await assertFails(ref.update({seenIds:[...ids,'too-many'],revision:3,updatedAt:stamp()}));
      assert.deepEqual((await ref.get()).data().seenIds,ids);await clear();
    });
    await t.test('S deletion or replacement of existing IDs is denied',async()=>{
      await seed(['A','B','C']);
      for(const seenIds of [[],['A'],['A','B'],['A','B','D'],['A','B','D','E']])await assertFails(append(seenIds));
      assert.deepEqual((await ref.get()).data().seenIds,['A','B','C']);await clear();
    });
    await t.test('T adding two IDs in one update is denied',async()=>{
      await seed();await assertFails(append(['A','B','C']));await clear();
    });
    await t.test('U exactly one appended ID succeeds and another active device can write',async()=>{
      await assertSucceeds(ref.set(document()));await assertSucceeds(append(['A']));
      const before=(await ref.get()).data();
      await assertSucceeds(dbs.second.doc(path(profileA)).update({seenIds:['A','B'],revision:3,updatedAt:stamp(),updatedByDeviceId:'phone'}));
      const after=(await ref.get()).data();assert.deepEqual(after.seenIds,['A','B']);assert.equal(after.revision,3);
      assert(after.createdAt.isEqual(before.createdAt));assert.equal(after.updatedByDeviceId,'phone');await clear();
    });
    await t.test('V unsupported initial schema and schemaVersion update are denied',async()=>{
      for(const schemaVersion of [0,2,'1',true,null])await assertFails(ref.set({...document(),schemaVersion}));
      await seed();await assertFails(append(['A','B'],{schemaVersion:2}));await clear();
    });
    await t.test('W createdAt cannot change during append',async()=>{
      await seed();await assertFails(append(['A','B'],{createdAt:new Date(0)}));
      await new Promise(resolve=>setTimeout(resolve,5));await assertFails(append(['A','B'],{createdAt:stamp()}));await clear();
    });
    await t.test('X document delete is denied to every client including the owner',async()=>{
      await seed();for(const name of ['owner','second','other','guest','inactiveIdentity','inactiveDevice'])await assertFails(dbs[name].doc(path(profileA)).delete());
    });
    await t.test('zero-add writes and reordered union arrays are denied',async()=>{
      await seed(['A','B']);await assertFails(append(['A','B']));await assertFails(append(['B','A','C']));
      await assertFails(append(['C','A','B']));await assertFails(append(['A','C','B']));await clear();
    });
    await t.test('settings list, collection group and nested document access are denied',async()=>{
      await seed();await admin(db=>db.doc(path(profileA)+'/nested/child').set({value:1}));
      await assertFails(dbs.owner.collection('memberProfiles/'+profileA+'/settings').get());
      await assertFails(dbs.owner.collectionGroup('settings').get());
      const child=dbs.owner.doc(path(profileA)+'/nested/child');await assertFails(child.get());
      await assertFails(child.set({value:2}));await assertFails(child.delete());
      await assertFails(dbs.owner.doc('memberProfiles/'+profileA+'/settings/otherHistory').set(document()));
    });
  } finally {await f.env.cleanup();}
});
