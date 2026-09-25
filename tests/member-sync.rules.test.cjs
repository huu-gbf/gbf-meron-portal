const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const {initializeTestEnvironment, assertSucceeds, assertFails} = require('@firebase/rules-unit-testing');

test('member identity/profile/device isolation and client privilege escalation denial', async t => {
  const env = await initializeTestEnvironment({projectId:'demo-gbf-meron-portal-rules',
    firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore.rules','utf8')}});
  const profileA = randomUUID(), profileB = randomUUID();
  const stamp = new Date();
  const profile = {schemaVersion:1,status:'active',createdAt:stamp};
  const identity = p => ({schemaVersion:1,profileId:p,deviceId:'pc',active:true,linkedAt:stamp,revokedAt:null});
  const device = {schemaVersion:1,label:null,status:'active',linkedAt:stamp,lastSeenAt:stamp};
  const a = env.authenticatedContext('uidA').firestore();
  const b = env.authenticatedContext('uidB').firestore();
  const guest = env.unauthenticatedContext().firestore();
  const path = p => 'memberProfiles/' + p;
  try {
    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      for (const p of [profileA,profileB]) {
        await db.doc(path(p)).set(profile);
        await db.doc(path(p)+'/devices/pc').set(device);
        await db.doc(path(p)+'/settings/speedCalculator').set({schemaVersion:1});
      }
      for (const [uid,data] of [['uidA',identity(profileA)],['uidB',identity(profileB)],
        ['inactive',{...identity(profileA),active:false}],['null-profile',{...identity(profileA),profileId:null}],
        ['missing-fields',{schemaVersion:1}],['missing-profile',identity('absent')]]) {
        await db.doc('memberIdentities/'+uid).set(data);
      }
    });
    await t.test('A/B own get succeeds; guessed other profile and unauthenticated get fail',async()=>{
      for (const [db,own,other] of [[a,profileA,profileB],[b,profileB,profileA]]) {
        assert.equal((await assertSucceeds(db.doc(path(own)).get())).exists,true);
        await assertFails(db.doc(path(other)).get());
        await assertFails(db.collection('memberProfiles').get());
      }
      await assertFails(guest.doc(path(profileA)).get());
    });
    await t.test('identity own get only; list, forged membership and all client writes denied',async()=>{
      await assertSucceeds(a.doc('memberIdentities/uidA').get());
      await assertFails(a.doc('memberIdentities/uidB').get());
      await assertFails(guest.doc('memberIdentities/uidA').get());
      await assertFails(a.collection('memberIdentities').get());
      await assertFails(a.doc('memberIdentities/uidA').update({profileId:profileB}));
      await assertFails(a.doc('memberIdentities/uidA').delete());
      const fresh = env.authenticatedContext('new-uid').firestore();
      await assertFails(fresh.doc('memberIdentities/new-uid').set(identity(profileB)));
      await assertFails(a.doc('memberIdentities/forged').set(identity(profileB)));
    });
    await t.test('profile create/update/delete denied even to owner',async()=>{
      await assertFails(a.doc(path(randomUUID())).set(profile));
      await assertFails(a.doc(path(profileA)).update({status:'inactive'}));
      await assertFails(a.doc(path(profileA)).delete());
    });
    await t.test('devices own get/list allowed; other/guest read and all writes denied',async()=>{
      for (const [db,own,other] of [[a,profileA,profileB],[b,profileB,profileA]]) {
        await assertSucceeds(db.doc(path(own)+'/devices/pc').get());
        await assertSucceeds(db.collection(path(own)+'/devices').get());
        await assertFails(db.doc(path(other)+'/devices/pc').get());
        await assertFails(db.collection(path(other)+'/devices').get());
        await assertFails(db.doc(path(own)+'/devices/new').set(device));
        await assertFails(db.doc(path(own)+'/devices/pc').update({status:'revoked'}));
        await assertFails(db.doc(path(own)+'/devices/pc').delete());
      }
      await assertFails(guest.doc(path(profileA)+'/devices/pc').get());
      await assertFails(a.collectionGroup('devices').get());
    });
    await t.test('missing, malformed, inactive and mismatched identities fail closed',async()=>{
      for (const uid of ['unknown','inactive','null-profile','missing-fields','missing-profile']) {
        const db = env.authenticatedContext(uid).firestore();
        await assertFails(db.doc(path(profileA)).get());
        await assertFails(db.doc(path(profileA)+'/devices/pc').get());
      }
    });
    await t.test('settings and future paths are denied, including existing administrator',async()=>{
      for (const db of [a,b,guest,env.authenticatedContext('wJRZibao8FgMDqDDQ3csPdVuGkx1').firestore()]) {
        const ref = db.doc(path(profileA)+'/settings/speedCalculator');
        await assertFails(ref.get()); await assertFails(ref.set({schemaVersion:1}));
        await assertFails(ref.delete());
        await assertFails(db.doc(path(profileA)+'/presets/example').set({value:1}));
      }
    });
    await t.test('server revocation and inactive profile remove profile/device access',async()=>{
      await env.withSecurityRulesDisabled(ctx=>ctx.firestore().doc('memberIdentities/uidA').update({active:false,revokedAt:stamp}));
      await assertFails(a.doc(path(profileA)).get());
      await assertFails(a.doc(path(profileA)+'/devices/pc').get());
      await assertSucceeds(a.doc('memberIdentities/uidA').get());
      await env.withSecurityRulesDisabled(ctx=>ctx.firestore().doc(path(profileB)).update({status:'inactive'}));
      await assertFails(b.doc(path(profileB)).get());
      await assertFails(b.doc(path(profileB)+'/devices/pc').get());
    });
    await t.test('pairing API collections deny every client read and write',async()=>{
      for (const db of [a,b,guest,env.authenticatedContext('wJRZibao8FgMDqDDQ3csPdVuGkx1').firestore()]) {
        for (const collection of ['memberSyncInvites','memberSyncRequests','memberSyncIssuers','memberSyncLimits',
          'memberSyncPending/'+profileA+'/requests']) {
          const ref=db.collection(collection).doc('example');
          await env.withSecurityRulesDisabled(ctx=>ctx.firestore().doc(ref.path).set({status:'pending'}));
          await assertFails(ref.get());await assertFails(db.collection(collection).get());
          await assertFails(db.collection(collection).doc('new').set({status:'issued'}));
          await assertFails(ref.update({status:'consumed'}));await assertFails(ref.delete());
        }
      }
    });
  } finally { await env.cleanup(); }
});
