/* Strict Artifact storage Rules. All traffic is local Firestore Emulator only. */
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const {initializeTestEnvironment, assertSucceeds, assertFails} = require('@firebase/rules-unit-testing');
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');
const {ARTIFACT_CATALOG, createDefaultArtifactProjection} = require('../artifact-catalog.js');
const {replaceBlock} = require('../scripts/generate-artifact-rules.cjs');
const selected = ARTIFACT_CATALOG.filter(item => Array.isArray(item.values));
const fixed = ARTIFACT_CATALOG.filter(item => !Array.isArray(item.values));
const first = selected[0].effectId;
const lastSelected = selected.at(-1).effectId;
const lastFixed = fixed.at(-1).effectId;
const stamp = () => firebase.firestore.FieldValue.serverTimestamp();
const document = (extra = {}) => ({schemaVersion:1,catalogVersion:1,resetEpoch:0,
  items:createDefaultArtifactProjection().items,revision:1,createdAt:stamp(),updatedAt:stamp(),updatedByDeviceId:'pc',...extra});

test('Artifact Rules generation matches its catalog and preserves every unrelated Rules byte', () => {
  const source = fs.readFileSync('firestore.rules', 'utf8');
  const strip = value => value.replace(/\r?\n      \/\/ BEGIN GENERATED ARTIFACT SETTINGS RULES[\s\S]*?      \/\/ END GENERATED ARTIFACT SETTINGS RULES/, '');
  assert.equal(replaceBlock(source),source);
  // Exercise both first insertion and replacement without a Git checkout dependency.
  assert.equal(replaceBlock(strip(source)),source);
  const changed = source.replace('        function artifactDocument()', '        function staleArtifactDocument()');
  assert.equal(replaceBlock(changed),source);
  assert.equal(strip(replaceBlock(changed)),strip(changed));
  assert.equal(ARTIFACT_CATALOG.length,63);assert.equal(selected.length,34);assert.equal(fixed.length,29);
});

async function fixture() {
  const env = await initializeTestEnvironment({projectId:'demo-gbf-meron-portal-rules',
    firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore.rules','utf8')}});
  const profileA=randomUUID(), profileB=randomUUID(), prefix=randomUUID(), dbs={};
  const path=(mode='gw',profile=profileA)=>'memberProfiles/'+profile+'/settings/'+(mode==='gw'?'awakeningGw':'awakeningHigh');
  const admin=fn=>env.withSecurityRulesDisabled(ctx=>fn(ctx.firestore()));
  const members=[['owner',profileA,'pc',true,'active'],['second',profileA,'phone',true,'active'],
    ['other',profileB,'other',true,'active'],['inactiveIdentity',profileA,'inactive-identity',false,'active'],
    ['inactiveDevice',profileA,'inactive-device',true,'revoked'],['missingDevice',profileA,'missing-device',true,null],
    ['malformedDevice',profileA,'malformed-device',true,{}]];
  await admin(async db=>{
    for(const p of [profileA,profileB])await db.doc('memberProfiles/'+p).set({status:'active'});
    for(const [name,profileId,deviceId,active,status] of members){
      await db.doc('memberIdentities/'+prefix+name).set({profileId,deviceId,active});
      if(status!==null)await db.doc('memberProfiles/'+profileId+'/devices/'+deviceId).set(typeof status==='string'?{status}:status);
      dbs[name]=env.authenticatedContext(prefix+name).firestore();
    }
    for(const [name,data] of [['missingDeviceId',{profileId:profileA,active:true}],['nonStringDeviceId',{profileId:profileA,active:true,deviceId:7}],
      ['missingProfile',{profileId:randomUUID(),active:true,deviceId:'pc'}],['malformedIdentity',{active:true}]]){
      await db.doc('memberIdentities/'+prefix+name).set(data);dbs[name]=env.authenticatedContext(prefix+name).firestore();
    }
  });
  dbs.missingIdentity=env.authenticatedContext(prefix+'unknown').firestore();dbs.guest=env.unauthenticatedContext().firestore();
  const ref=(mode='gw',name='owner',profile=profileA)=>dbs[name].doc(path(mode,profile));
  const clear=()=>admin(async db=>{for(const mode of ['gw','high'])await db.doc(path(mode)).delete();});
  const seed=(extra={},mode='gw')=>admin(db=>db.doc(path(mode)).set(document(extra)));
  const update=(patch={},mode='gw',name='owner')=>ref(mode,name).update({revision:2,updatedAt:stamp(),...patch});
  return {env,profileA,profileB,dbs,path,admin,ref,clear,seed,update};
}

test('Artifact Rules: complete strict schema, active ownership, single-field writes and reset boundary',async t=>{
  const f=await fixture();const {profileA,profileB,dbs,path,admin,ref,clear,seed,update}=f;
  const check=async(name,fn)=>t.test(name,async()=>{await clear();await fn();});
  try {
    await check('A owner get gw and missing gw document succeeds',async()=>{
      assert.equal((await assertSucceeds(ref().get())).exists,false);await seed();assert.equal((await assertSucceeds(ref().get())).exists,true);
    });
    await check('B owner get high succeeds independently',async()=>{await seed({},'high');assert.equal((await assertSucceeds(ref('high').get())).exists,true);});
    await check('C other profile, guest and missing identity cannot read/create/update',async()=>{
      await seed();for(const name of ['other','guest','missingIdentity']){await assertFails(ref('gw',name).get());await assertFails(update({['items.'+first+'.needed']:true},'gw',name));}
      await assertFails(ref('gw','owner',profileB).get());await assertFails(ref('gw','owner',profileB).set(document()));
      await clear();for(const name of ['other','guest','missingIdentity'])await assertFails(ref('gw',name).set(document()));
    });
    await check('D inactive profile rejects get/create/update',async()=>{
      await seed();await admin(db=>db.doc('memberProfiles/'+profileA).update({status:'inactive'}));
      try {await assertFails(ref().get());await assertFails(update({['items.'+first+'.needed']:true}));await clear();await assertFails(ref().set(document()));}
      finally {await admin(db=>db.doc('memberProfiles/'+profileA).update({status:'active'}));}
    });
    await check('E inactive identity rejects get/create/update',async()=>{
      await seed();await assertFails(ref('gw','inactiveIdentity').get());await assertFails(update({['items.'+first+'.needed']:true,updatedByDeviceId:'inactive-identity'},'gw','inactiveIdentity'));
      await clear();await assertFails(ref('gw','inactiveIdentity').set(document({updatedByDeviceId:'inactive-identity'})));
    });
    await check('F inactive device rejects get/create/update',async()=>{
      await seed();await assertFails(ref('gw','inactiveDevice').get());await assertFails(update({['items.'+first+'.needed']:true,updatedByDeviceId:'inactive-device'},'gw','inactiveDevice'));
      await clear();await assertFails(ref('gw','inactiveDevice').set(document({updatedByDeviceId:'inactive-device'})));
    });
    await check('missing and malformed identity/profile/device fail closed',async()=>{
      for(const name of ['missingDevice','malformedDevice','missingDeviceId','nonStringDeviceId','missingProfile','malformedIdentity']){
        await assertFails(ref('gw',name).get());await assertFails(ref('gw',name).set(document()));await seed();
        await assertFails(update({['items.'+first+'.needed']:true},'gw',name));await clear();
      }
    });
    await check('G valid gw complete create with server timestamps succeeds',async()=>{
      await assertSucceeds(ref().set(document()));const data=(await ref().get()).data();assert.equal(data.revision,1);assert.equal(data.resetEpoch,0);
      assert.equal(Object.keys(data).length,8);assert.equal(Object.keys(data.items).length,63);assert(data.createdAt.isEqual(data.updatedAt));
    });
    await check('H valid high create and second active device succeed',async()=>{
      await assertSucceeds(ref('high','second').set(document({updatedByDeviceId:'phone'})));
      assert.equal((await ref('high').get()).data().updatedByDeviceId,'phone');assert.equal((await ref().get()).exists,false);
    });
    await check('I unknown and missing top fields rejected on create and update',async()=>{
      await assertFails(ref().set(document({extra:true})));
      for(const key of Object.keys(document())){const data=document();delete data[key];await assertFails(ref().set(data));}
      await seed();await assertFails(update({['items.'+first+'.needed']:true,extra:true}));
      for(const key of Object.keys(document()))await assertFails(update({['items.'+first+'.needed']:true,[key]:firebase.firestore.FieldValue.delete()}));
    });
    await check('J invalid schemaVersion rejected',async()=>{for(const value of [0,2,'1',true,null])await assertFails(ref().set(document({schemaVersion:value})));});
    await check('K invalid catalogVersion rejected',async()=>{for(const value of [0,2,'1',true,null])await assertFails(ref().set(document({catalogVersion:value})));});
    await check('L create resetEpoch must be exact integer zero',async()=>{for(const value of [-1,1,0.5,'0',null,true,9007199254740992])await assertFails(ref().set(document({resetEpoch:value})));});
    await check('M create revision must be exact integer one',async()=>{for(const value of [0,2,1.5,'1',null,true,9007199254740992])await assertFails(ref().set(document({revision:value})));});
    await check('N timestamps must be server timestamps',async()=>{
      for(const key of ['createdAt','updatedAt'])for(const value of [new Date(0),null,'now',1])await assertFails(ref().set(document({[key]:value})));
      await seed();await assertFails(update({['items.'+first+'.needed']:true,updatedAt:new Date(0)}));
    });
    await check('O updatedByDeviceId must match the active identity device',async()=>{
      for(const value of ['phone','other','',null,7])await assertFails(ref().set(document({updatedByDeviceId:value})));
      await seed();await assertFails(update({['items.'+first+'.needed']:true,updatedByDeviceId:'phone'}));
    });
    await check('P missing any known effect ID is rejected',async()=>{
      for(const item of ARTIFACT_CATALOG){const data=document();delete data.items[item.effectId];await assertFails(ref().set(data));}
    });
    await check('Q unknown effect IDs and non-map items are rejected',async()=>{
      const data=document();data.items.unknown={needed:false};await assertFails(ref().set(data));
      delete data.items[first];await assertFails(ref().set(data));
      for(const items of [null,[],true,7,'items',{}])await assertFails(ref().set(document({items})));
    });
    await check('R every effect requires a boolean needed and exact map shape',async()=>{
      for(const item of ARTIFACT_CATALOG){const data=document();data.items[item.effectId].needed='false';await assertFails(ref().set(data));
        delete data.items[item.effectId].needed;await assertFails(ref().set(data));
        data.items[item.effectId]={...createDefaultArtifactProjection().items[item.effectId],memo:'private'};await assertFails(ref().set(data));}
      for(const value of [null,0,1,{},[]]){const data=document();data.items[first].needed=value;await assertFails(ref().set(data));}
    });
    await check('S every selected item requires selectedValue',async()=>{
      for(const item of selected){const data=document();delete data.items[item.effectId].selectedValue;await assertFails(ref().set(data));}
    });
    await check('T every selected enum rejects invalid/coerced values',async()=>{
      for(const item of selected){const data=document();data.items[item.effectId].selectedValue='invalid';await assertFails(ref().set(data));}
      for(const value of [1800,null,true,{},[],selected[0].values[0]+' ']){const data=document();data.items[first].selectedValue=value;await assertFails(ref().set(data));}
      // Generated regex branches must preserve exact enum equality, including metacharacters.
      for(const item of selected){const value=item.values[0];const variants=[' '+value,value+' ',value+'\n','x'+value,value+'x',value.replace('.', 'x')];
        for(const invalid of new Set(variants.filter(candidate=>candidate!==value))){const data=document();data.items[item.effectId].selectedValue=invalid;await assertFails(ref().set(data));}}
    });
    await check('all 34 selected items accept every catalog enum including single-value items',async()=>{
      for(let index=0;index<10;index+=1){const data=document();for(const item of selected){data.items[item.effectId].selectedValue=item.values[Math.floor(index/2)%item.values.length];data.items[item.effectId].needed=index%2===0;}
        await assertSucceeds(ref().set(data));await clear();}
    });
    await check('U every fixed item forbids selectedValue',async()=>{
      for(const item of fixed){const data=document();data.items[item.effectId].selectedValue=item.value;await assertFails(ref().set(data));}
    });
    await check('V needed can change on every one of the 63 effects without expression limit failures',async()=>{
      await assertSucceeds(ref().set(document()));let revision=1;
      for(const item of ARTIFACT_CATALOG){try {await assertSucceeds(ref().update({['items.'+item.effectId+'.needed']:true,revision:++revision,updatedAt:stamp()}));}
        catch(error){error.message=item.effectId+': '+error.message;throw error;}}
      const data=(await ref().get()).data();assert.equal(data.revision,64);assert(ARTIFACT_CATALOG.every(item=>data.items[item.effectId].needed===true));
      await assertSucceeds(ref().update({['items.'+lastFixed+'.needed']:false,revision:65,updatedAt:stamp()}));
    });
    await check('W valid selectedValue-only update succeeds including last mutable selection',async()=>{
      await seed();await assertSucceeds(update({['items.'+first+'.selectedValue']:selected[0].values[0]}));
      const lastMutable=selected.filter(item=>item.values.length>1).at(-1);
      await assertSucceeds(ref().update({['items.'+lastMutable.effectId+'.selectedValue']:lastMutable.values[0],revision:3,updatedAt:stamp()}));
    });
    await check('X schemaVersion cannot change on normal update or reset',async()=>{
      await seed();await assertFails(update({['items.'+first+'.needed']:true,schemaVersion:2}));await assertFails(update({resetEpoch:1,items:createDefaultArtifactProjection().items,schemaVersion:2}));
    });
    await check('Y catalogVersion cannot change on normal update or reset',async()=>{
      await seed();await assertFails(update({['items.'+first+'.needed']:true,catalogVersion:2}));await assertFails(update({resetEpoch:1,items:createDefaultArtifactProjection().items,catalogVersion:2}));
    });
    await check('Z createdAt is immutable',async()=>{
      await seed();await assertFails(update({['items.'+first+'.needed']:true,createdAt:new Date(0)}));
      await assertFails(update({resetEpoch:1,items:createDefaultArtifactProjection().items,createdAt:new Date(0)}));
    });
    await check('AA resetEpoch cannot change on a non-default normal update',async()=>{
      await seed();await assertFails(update({['items.'+first+'.needed']:true,resetEpoch:1}));
      await assertFails(update({['items.'+first+'.needed']:true,resetEpoch:-1}));
    });
    await check('AB revision skip, unsafe and malformed revisions rejected',async()=>{
      await seed();for(const revision of [0,1,3,2.5,'2',null,9007199254740992])await assertFails(update({['items.'+first+'.needed']:true,revision}));
      await seed({revision:9007199254740990});await assertSucceeds(update({['items.'+first+'.needed']:true,revision:9007199254740991}));
      await assertFails(update({['items.'+lastFixed+'.needed']:true,revision:9007199254740992}));
    });
    await check('AC arbitrary multi-effect bulk updates rejected',async()=>{
      await seed();await assertFails(update({['items.'+first+'.needed']:true,['items.'+lastFixed+'.needed']:true}));
      await assertFails(update({['items.'+first+'.selectedValue']:selected[0].values[0],['items.'+lastSelected+'.needed']:true}));
    });
    await check('one selected effect cannot change needed and selectedValue together',async()=>{
      await seed();for(const item of selected.filter(item=>item.values.length>1))await assertFails(update({['items.'+item.effectId+'.needed']:true,['items.'+item.effectId+'.selectedValue']:item.values[0]}));
    });
    await check('normal updates cannot delete effects, add fields, remove required fields or alter fixed selection',async()=>{
      await seed();for(const patch of [{['items.'+first]:firebase.firestore.FieldValue.delete()},{'items.unknown':{needed:true}},
        {['items.'+first+'.memo']:'local'},{['items.'+first+'.needed']:firebase.firestore.FieldValue.delete()},
        {['items.'+lastFixed+'.selectedValue']:'-'}])await assertFails(update(patch));
    });
    await check('AD valid reset restores all defaults and increments revision/epoch',async()=>{
      const data=document();for(const item of ARTIFACT_CATALOG)data.items[item.effectId].needed=true;
      for(const item of selected)data.items[item.effectId].selectedValue=item.values[0];await seed({items:data.items});
      const before=(await ref().get()).data();await assertSucceeds(update({items:createDefaultArtifactProjection().items,resetEpoch:1}));
      const after=(await ref().get()).data();assert.deepEqual(after.items,createDefaultArtifactProjection().items);assert.equal(after.resetEpoch,1);assert.equal(after.revision,2);assert(before.createdAt.isEqual(after.createdAt));
    });
    await check('reset already-default state remains a valid epoch boundary and high is independent',async()=>{
      await seed();await seed({},'high');await assertSucceeds(update({items:createDefaultArtifactProjection().items,resetEpoch:1}));
      await assertSucceeds(ref().update({resetEpoch:2,items:createDefaultArtifactProjection().items,revision:3,updatedAt:stamp()}));
      assert.equal((await ref().get()).data().resetEpoch,2);assert.equal((await ref('high').get()).data().resetEpoch,0);
    });
    await check('AE resetEpoch +2, malformed and overflow rejected',async()=>{
      await seed();for(const resetEpoch of [2,-1,0.5,'1',null,9007199254740992])await assertFails(update({items:createDefaultArtifactProjection().items,resetEpoch}));
      await seed({resetEpoch:9007199254740990});await assertSucceeds(update({items:createDefaultArtifactProjection().items,resetEpoch:9007199254740991}));
      await assertFails(ref().update({items:createDefaultArtifactProjection().items,resetEpoch:9007199254740992,revision:3,updatedAt:stamp()}));
    });
    await check('AF reset rejects any non-default needed or selectedValue and malformed full state',async()=>{
      await seed();for(const item of ARTIFACT_CATALOG){const items=createDefaultArtifactProjection().items;items[item.effectId].needed=true;await assertFails(update({items,resetEpoch:1}));}
      for(const item of selected.filter(item=>item.values.length>1)){const items=createDefaultArtifactProjection().items;items[item.effectId].selectedValue=item.values[0];await assertFails(update({items,resetEpoch:1}));}
      const items=createDefaultArtifactProjection().items;delete items[lastFixed];await assertFails(update({items,resetEpoch:1}));
    });
    await check('metadata-only writes and same-value normal writes rejected',async()=>{
      await seed();await assertFails(update());await assertFails(update({['items.'+first+'.needed']:false}));
      await assertFails(update({['items.'+first+'.selectedValue']:selected[0].values.at(-1)}));
    });
    await check('AG delete denied to every client',async()=>{
      await seed();await seed({},'high');for(const mode of ['gw','high'])for(const name of ['owner','second','other','guest','inactiveIdentity','inactiveDevice'])await assertFails(ref(mode,name).delete());
    });
    await check('AH list, collection group and arbitrary document IDs denied',async()=>{
      await seed();await assertFails(dbs.owner.collection('memberProfiles/'+profileA+'/settings').get());await assertFails(dbs.owner.collectionGroup('settings').get());
      for(const name of ['awakening','awakeninggw','artifact','foo']){const target=dbs.owner.doc('memberProfiles/'+profileA+'/settings/'+name);await assertFails(target.get());await assertFails(target.set(document()));}
    });
    await check('AI nested unknown paths denied',async()=>{
      for(const mode of ['gw','high']){const nested=path(mode)+'/nested/child';await admin(db=>db.doc(nested).set({value:1}));
        const target=dbs.owner.doc(nested);await assertFails(target.get());await assertFails(target.set({value:2}));await assertFails(target.delete());}
    });
  } finally {await f.env.cleanup();}
});
