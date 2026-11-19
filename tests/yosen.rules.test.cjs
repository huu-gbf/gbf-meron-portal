const {createRequire}=require('module');const req=createRequire(require('path').resolve('package.json'));
const {initializeTestEnvironment,assertFails,assertSucceeds}=req('@firebase/rules-unit-testing');
const {doc,getDoc,setDoc,deleteDoc,serverTimestamp,collection,getDocs}=req('firebase/firestore');
const fs=require('fs');const {test}=require('node:test');
const assert=require('node:assert/strict');
test('Shared predictor permissions and data validation',async()=>{
 const env=await initializeTestEnvironment({projectId:'demo-gbf-meron-portal-rules',firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore.rules','utf8')}});
 try{
 const admin=env.authenticatedContext('wJRZibao8FgMDqDDQ3csPdVuGkx1').firestore(),viewer=env.unauthenticatedContext().firestore(),member=env.authenticatedContext('member').firestore();
 const path='publicTools/yosenPredictor',valid=()=>({schemaVersion:1,eventDate:'2026-09-17',dayType:'weekday',score12:100000000000,score18:160000000000,score20:null,updatedAt:serverTimestamp()});
 await assertSucceeds(getDoc(doc(viewer,path)));await assertFails(setDoc(doc(viewer,path),valid()));await assertFails(setDoc(doc(member,path),valid()));await assertSucceeds(setDoc(doc(admin,path),valid()));await assertSucceeds(getDoc(doc(viewer,path)));await assertSucceeds(setDoc(doc(admin,path),{...valid(),score20:200000000000}));
 await assertSucceeds(setDoc(doc(admin,path),{...valid(),earlyAvgSpeed:50000,score18:null}));
 await assertSucceeds(setDoc(doc(admin,path),{...valid(),earlyAvgSpeed:50000,score18:160000000000}));
 for (const score12 of [9000000000, 9000000001]) {
   const exact = {...valid(), score7:6000000000, score12, score18:null};
   await assertSucceeds(setDoc(doc(admin,path),exact));
   for (const reader of [viewer,member]) {
     const saved = (await assertSucceeds(getDoc(doc(reader,path)))).data();
     assert.equal(saved.score7,exact.score7);
     assert.equal(saved.score12,score12);
     assert.equal(Object.hasOwn(saved,'earlyAvgSpeed'),false);
     await assertFails(setDoc(doc(reader,path),{...exact,score7:exact.score7+1}));
   }
 }
 for (const score7 of [null,-1,1.5,'6000000000',9000000000,9000000001,9007199254740992]) {
   await assertFails(setDoc(doc(admin,path),{...valid(),score7,score12:9000000000,score18:null}));
 }
 await assertSucceeds(setDoc(doc(admin,path),{...valid(),score7:0,score12:1,score18:null}));
 for(const change of [{earlyAvgSpeed:-1},{earlyAvgSpeed:0},{earlyAvgSpeed:1.5},{earlyAvgSpeed:'50000'},{score18:null,score20:200000000000}])await assertFails(setDoc(doc(admin,path),{...valid(),...change}));
 for(const change of [{extra:'no'},{schemaVersion:2},{dayType:'other'},{eventDate:'bad'},{score12:-1},{score12:1.5},{score12:9007199254740992},{score18:1},{score20:100},{updatedAt:new Date(0)},{score20:'2000億'}])await assertFails(setDoc(doc(admin,path),{...valid(),...change}));
 const missing=valid();delete missing.score20;await assertFails(setDoc(doc(admin,path),missing));
 await assertFails(deleteDoc(doc(admin,path)));await assertFails(setDoc(doc(admin,'publicTools/other'),valid()));await assertFails(getDocs(collection(viewer,'publicTools')));
 console.log('PASS: public get; admin create/update; anonymous/member writes denied; invalid fields/types/range/time denied; other paths and delete denied');
 }finally{await env.cleanup();}
});
