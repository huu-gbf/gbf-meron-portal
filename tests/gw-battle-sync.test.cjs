const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const {initializeTestEnvironment, assertFails, assertSucceeds} = require('@firebase/rules-unit-testing');
const {serverTimestamp} = require('firebase/firestore');
const html = fs.readFileSync('tools/gw-battle-review.html', 'utf8');
const core = html.slice(html.indexOf('const BATTLE_ADMIN_UID'), html.indexOf('/* END BATTLE SYNC CORE */'));
// Run transport in the SDK's realm: Firestore rejects foreign-realm object literals.
const scope = new Function(core + '\nreturn {Core:BattleSync,date:battleDateJst};')();
const ADMIN = 'wJRZibao8FgMDqDDQ3csPdVuGkx1';
const clone = v => JSON.parse(JSON.stringify(v));
const empty = () => ({base:null, conditions:{dayKey:'day1',dayType:'weekday'}, snapshots:[]});
const record = (time, own=100, enemy=90) => ({time,own,enemy});
const pause = ms => new Promise(r => setTimeout(r,ms));
async function until(fn, message) { for(let i=0;i<250;i++) { if(fn())return; await pause(20); } throw Error(message); }
function client(db, initial=empty(), options={}) {
  let data=clone(initial), journal=options.journal || null;
  const result={applied:0, prompts:[], backups:[], status:'', session:options.session || '2026-09-24_day1', consent:true, online:true, editing:false};
  const io={session:()=>result.session,capture:()=>clone(data),readJournal:()=>journal,
    isEditing:()=>result.editing,
    writeJournal:j=>{journal=clone(j);},timestamp:serverTimestamp,
    status:s=>{result.status=s;},confirm:s=>{result.prompts.push(s);return result.consent;},
    backup:()=>{result.backups.push(clone(data));return true;},
    apply:d=>{data=clone(d);result.applied++;}};
  result.sync=new scope.Core(io);
  result.db=db; result.data=()=>clone(data); result.journal=()=>clone(journal);
  const transport={collection:db.collection.bind(db),runTransaction:fn=>result.online?db.runTransaction(fn):Promise.reject(Error('offline fault injection'))};
  result.login=()=>result.sync.authorize({uid:ADMIN},transport);
  result.edit=(kind,value)=>{const before=clone(data[kind]);data[kind]=clone(value);result.sync.changed(kind,before,value);};
  return result;
}

test('JST date and unchanged prediction/model/recording functions',()=>{
  assert.equal(scope.date(new Date('2026-09-23T14:59:59Z')),'2026-09-23');
  assert.equal(scope.date(new Date('2026-09-23T15:00:00Z')),'2026-09-24');
  const previous=execFileSync('git',['show','HEAD:tools/gw-battle-review.html'],{encoding:'utf8'});
  // Every original function except cache input restoration is byte-for-byte unchanged.
  const normalize=s=>s.replace(/\r\n/g,'\n');
  const before=normalize(previous),after=normalize(html);
  const modelStart=before.indexOf('const MODELS ='), modelEnd=before.indexOf('const StorageManager =');
  assert.equal(after.slice(after.indexOf('const MODELS ='),after.indexOf('const StorageManager =')),before.slice(modelStart,modelEnd));
  for(const name of ['runPrediction','recordSnapshot','saveEditSnap','deleteSnap','drawChart','updateAnalysis','updateRealtimeDisplay','calcSpeedBetween']) {
    const extract=s=>{const begin=s.indexOf('function '+name+'(');const next=s.indexOf('\nfunction ',begin+1);return s.slice(begin,next);};
    assert.equal(extract(after),extract(before),name+' changed');
  }
  const model=source=>{const c={};vm.runInNewContext(source.slice(source.indexOf('const MODELS ='),source.indexOf('const StorageManager ='))+'\nglobalThis.api={calcPrediction,calcReferenceRange,calcRealtimeCorrection,calcRealtimePrediction,calcOvertake};',c);return c.api;};
  const old=model(before),now=model(after);
  for(const day of ['day1','day2','day3','day4'])for(const type of ['weekday','weekend'])for(const m of ['standard','caution']) {
    assert.deepEqual(clone(now.calcPrediction(57300123456,2507151234,day,type,m)),clone(old.calcPrediction(57300123456,2507151234,day,type,m)));
    for(const minute of [720,721,1080,1200,1380,1417,1440]) {
      const args=[57300123456,95000123456,minute,day,type,2507151234];
      assert.deepEqual(clone(now.calcRealtimeCorrection(...args)),clone(old.calcRealtimeCorrection(...args)));
      assert.equal(now.calcRealtimePrediction(95000123456,minute,day,type,2507151234,1.1),old.calcRealtimePrediction(95000123456,minute,day,type,2507151234,1.1));
    }
    assert.deepEqual(clone(now.calcReferenceRange(57300123456,35000000000,day,type)),clone(old.calcReferenceRange(57300123456,35000000000,day,type)));
  }
});

test('legacy storage shape and 06:59/07:00/08:00/11:59/12:00 recording boundaries',()=>{
  const values=new Map(),elements=new Map();
  const base={enemyContrib12:12345678901,enemySpeed:1234567.25,ownContrib12:13345678901,ownSpeed:1334567.75};
  values.set('gw_review_base',JSON.stringify(base));values.set('gw_review_conditions',JSON.stringify({dayKey:'day3',dayType:'weekend'}));
  values.set('gw_review_snapshots',JSON.stringify([{id:42,...record('08:00',100,90)}]));
  const context={console,document:{readyState:'loading',addEventListener(){},querySelector(){return null;},
    getElementById(id){if(!elements.has(id))elements.set(id,{value:'',textContent:'',className:'',classList:{add(){},remove(){}}});return elements.get(id);}},
    localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}};
  const main=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.createContext(context);vm.runInContext(main+`
    globalThis.savedState=state;
    loadFromStorage();
    renderHistory=drawChart=updateAnalysis=updateRealtimeDisplay=()=>{};
    showError=(_id,message)=>{globalThis.error=message;};
    getCurrentTimeStr=()=> '23:59';
    globalThis.record=recordSnapshot;
  `,context);
  assert.equal(elements.get('enemy-contrib12').value,'12345678901');
  assert.equal(elements.get('enemy-speed').value,String(base.enemySpeed/1e4));
  assert.equal(context.savedState.dayKey,'day3');assert.equal(context.savedState.snapshots[0].id,42);
  assert.deepEqual(JSON.parse(values.get('gw_review_base')),base);
  for(const time of ['06:59','07:00','08:00','11:59','12:00']) {
    context.savedState.snapshots=[];
    context.document.getElementById('snap-time').value=time;
    context.document.getElementById('snap-own').value='10億';
    context.document.getElementById('snap-enemy').value='9億';
    context.record();
    assert.equal(context.savedState.snapshots.length,time==='06:59'?0:1,time);
    if(time==='06:59')assert.match(context.error,/7:00/);
    else {const saved=JSON.parse(values.get('gw_review_snapshots'));assert.equal(saved[0].time,time);assert.deepEqual(Object.keys(saved[0]).sort(),['enemy','id','own','time']);}
  }
});

test('emulator: authentication, migration, two clients, CRUD, concurrency, offline, reload and separation',async t=>{
  const env=await initializeTestEnvironment({projectId:'demo-gbf-meron-portal-rules',firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore.rules','utf8')}});
  const clients=[];
  const admin=()=>env.authenticatedContext(ADMIN).firestore();
  const make=(initial,opts)=>{const c=client(admin(),initial,opts);clients.push(c);return c;};
  try {
    await env.clearFirestore();
    await t.test('unauthenticated and non-admin cannot get/list/create/update/delete',async()=>{
      for(const db of [env.unauthenticatedContext().firestore(),env.authenticatedContext('not-admin').firestore()]) {
        const col=db.collection('gwBattleReviews/2026-09-24_day1/entries');
        await assertFails(col.get());await assertFails(col.doc('meta').get());await assertFails(col.doc('0800').get());
        await assertFails(col.doc('0800').set({...record('08:00'),updatedAt:serverTimestamp()}));
        await assertFails(col.doc('0800').update({own:100}));await assertFails(col.doc('0800').delete());
        const c=client(db);await c.sync.authorize(null,db);assert.equal(c.applied,0);assert.equal(c.sync.unsubscribe,null);
      }
    });
    const initial={...empty(),snapshots:[{id:123,...record('08:00')},{id:456,...record('08:17',120,110)}]};
    const pc=make(initial);pc.consent=false;
    await t.test('empty cloud never clears or uploads local data without confirmation',async()=>{
      await pc.login();await until(()=>pc.prompts.length===1,'migration prompt');
      assert.deepEqual(pc.data(),initial);assert.equal((await pc.db.collection('gwBattleReviews/2026-09-24_day1/entries').get()).size,0);
      assert.equal(pc.applied,0);
    });
    await t.test('explicit migration preserves existing records',async()=>{
      pc.consent=true;await pc.sync.connect();await until(()=>pc.status.includes('同期済み'),'migration acknowledgement');
      assert.equal(pc.data().snapshots.length,2);assert.equal(pc.backups.length,1);assert.equal(pc.journal().queue.length,0);
    });
    const phone=make();
    await t.test('new phone obtains shared data without migration prompt',async()=>{
      await phone.login();await until(()=>phone.data().snapshots.length===2,'phone data');assert.equal(phone.prompts.length,0);
    });
    await t.test('PC to phone and phone to PC additions',async()=>{
      pc.edit('snapshots',[...pc.data().snapshots,record('08:20',140,130)]);
      await until(()=>phone.data().snapshots.some(s=>s.time==='08:20'),'PC to phone');
      phone.edit('snapshots',[...phone.data().snapshots,record('08:40',180,170)]);
      await until(()=>pc.data().snapshots.some(s=>s.time==='08:40'),'phone to PC');
    });
    await t.test('edit and delete synchronize',async()=>{
      await until(()=>!phone.sync.busy&&!pc.sync.busy,'idle');
      pc.edit('snapshots',pc.data().snapshots.map(s=>s.time==='08:20'?{...s,own:150}:s));
      await until(()=>phone.data().snapshots.find(s=>s.time==='08:20')?.own===150,'edit');
      phone.edit('snapshots',phone.data().snapshots.filter(s=>s.time!=='08:20'));
      await until(()=>!pc.data().snapshots.some(s=>s.time==='08:20'),'delete');
    });
    await t.test('concurrent different-time additions both survive',async()=>{
      await until(()=>!phone.sync.busy&&!pc.sync.busy,'idle');
      pc.edit('snapshots',[...pc.data().snapshots,record('09:00',200,190)]);
      phone.edit('snapshots',[...phone.data().snapshots,record('09:20',220,210)]);
      await until(()=>[pc,phone].every(c=>c.data().snapshots.some(s=>s.time==='09:00')&&c.data().snapshots.some(s=>s.time==='09:20')),'concurrent additions');
    });
    await t.test('noon data and weekday conditions synchronize without rounding',async()=>{
      await until(()=>!pc.sync.busy&&!phone.sync.busy,'idle');
      const base={enemyContrib12:12345678901,enemySpeed:1234567.25,ownContrib12:13345678901,ownSpeed:1334567.75};
      pc.edit('base',base);pc.edit('conditions',{dayKey:'day1',dayType:'weekend'});
      await until(()=>phone.data().base?.enemySpeed===1234567.25&&phone.data().conditions.dayType==='weekend','base and conditions');
      assert.deepEqual(phone.data().base,base);
    });
    await t.test('reload restores shared cache and no write loop',async()=>{
      await until(()=>!pc.sync.busy&&!phone.sync.busy,'idle');
      const reload=make(pc.data(),{journal:pc.journal()});await reload.login();
      await until(()=>reload.applied>0,'reload');assert.deepEqual(reload.data(),phone.data());
      assert.equal(reload.prompts.length,0);const applied=reload.applied;await pause(100);assert.equal(reload.applied,applied);
      reload.sync.stop();
    });
    await t.test('remote existing plus unrelated local requires confirmation and backup',async()=>{
      const stale=make(initial);stale.consent=false;await stale.login();await until(()=>stale.prompts.length,'remote prompt');
      assert.deepEqual(stale.data(),initial);assert.equal(stale.applied,0);
      stale.consent=true;await stale.sync.connect();await until(()=>stale.applied>0,'accept remote');assert.deepEqual(stale.backups[0],initial);stale.sync.stop();
    });
    await t.test('offline writes stay local with persistent queue then reconnect',async()=>{
      await until(()=>!pc.sync.busy,'idle');pc.online=false;await pc.db.disableNetwork();
      pc.edit('snapshots',[...pc.data().snapshots,record('10:00',250,240)]);
      await until(()=>!pc.sync.busy,'failed offline transaction');assert(pc.journal().queue.length>0);assert(pc.data().snapshots.some(s=>s.time==='10:00'));
      pc.online=true;await pc.db.enableNetwork();await pc.sync.connect();await until(()=>phone.data().snapshots.some(s=>s.time==='10:00'),'reconnect');
    });
    await t.test('same-time conflict keeps losing input, does not overwrite winner',async()=>{
      await until(()=>!pc.sync.busy&&!phone.sync.busy,'idle');phone.online=false;await phone.db.disableNetwork();
      phone.edit('snapshots',phone.data().snapshots.map(s=>s.time==='10:00'?{...s,own:270}:s));
      await until(()=>!phone.sync.busy,'offline failure');
      pc.edit('snapshots',pc.data().snapshots.map(s=>s.time==='10:00'?{...s,own:260}:s));
      await until(()=>!pc.sync.busy&&pc.journal().queue.length===0,'winning edit');
      phone.online=true;await phone.db.enableNetwork();await phone.sync.connect();await until(()=>phone.status.includes('他端末で変更'),'conflict');
      assert.equal(phone.data().snapshots.find(s=>s.time==='10:00').own,270);assert.equal(pc.data().snapshots.find(s=>s.time==='10:00').own,260);
      assert.equal(phone.journal().queue.length,1);phone.sync.stop();
    });
    await t.test('in-progress form is not replaced by remote snapshots; cancel refreshes',async()=>{
      const draft=make();await draft.login();await until(()=>draft.applied,'draft client');draft.editing=true;
      const previous=draft.applied;
      pc.edit('snapshots',[...pc.data().snapshots,record('10:10',275,265)]);
      await until(()=>draft.status.includes('編集中'),'draft protected');assert.equal(draft.applied,previous);
      draft.editing=false;await draft.sync.refresh();assert(draft.data().snapshots.some(s=>s.time==='10:10'));draft.sync.stop();
    });
    await t.test('persistent outbox survives reload and replays once',async()=>{
      await until(()=>!pc.sync.busy,'idle');pc.online=false;
      pc.edit('snapshots',[...pc.data().snapshots,record('10:15',277,267)]);
      await until(()=>!pc.sync.busy,'offline queue');const saved=pc.journal();assert.equal(saved.queue.length,1);pc.sync.stop();
      const reload=make(pc.data(),{journal:saved});await reload.login();await until(()=>reload.journal().queue.length===0&&!reload.sync.busy,'replay');
      assert.equal(reload.data().snapshots.filter(s=>s.time==='10:15').length,1);reload.sync.stop();
      pc.sync.journal=reload.journal();pc.online=true;await pc.sync.connect();await until(()=>pc.status.includes('同期済み'),'restore pc');
    });
    await t.test('time edit atomically moves record without deleting unrelated rows',async()=>{
      pc.edit('snapshots',pc.data().snapshots.map(s=>s.time==='10:15'?{...s,time:'10:16'}:s));
      await until(()=>!pc.sync.busy&&pc.journal().queue.length===0,'rename');
      const col=pc.db.collection('gwBattleReviews/2026-09-24_day1/entries');
      assert.equal((await col.doc('1015').get()).exists,false);assert.equal((await col.doc('1016').get()).exists,true);assert.equal((await col.doc('1010').get()).exists,true);
    });
    await t.test('date/day boundaries stop old-session writes and keep data',async()=>{
      await until(()=>!pc.sync.busy,'idle');const count=pc.data().snapshots.length;pc.session='2026-09-25_day2';
      pc.edit('snapshots',[...pc.data().snapshots,record('10:20',280,270)]);
      assert.equal(pc.sync.ready,false);assert.equal(pc.data().snapshots.length,count+1);assert.equal(pc.journal().localOnly,true);
      assert.equal((await pc.db.collection('gwBattleReviews/2026-09-25_day2/entries').get()).size,0);
      pc.sync.stop();
    });
    await t.test('empty new session initializes without copying another session',async()=>{
      const fresh=make(empty(),{session:'2026-09-25_day2'});await fresh.login();await until(()=>fresh.status.includes('同期済み'),'fresh session');
      assert.equal(fresh.prompts.length,0);assert.equal(fresh.data().snapshots.length,0);assert.equal(fresh.data().conditions.dayKey,'day2');fresh.sync.stop();
    });
    await t.test('Rules validate fields, times, score sizes and session, protect meta deletion',async()=>{
      const db=admin(),col=db.collection('gwBattleReviews/2026-09-24_day1/entries');
      const meta=(await col.doc('meta').get()).data();
      for(const delta of [{extra:1},{dayKey:'day2'},{dayType:'other'},{schemaVersion:2},{dateJst:'2026-99-99'},{base:{enemyContrib12:1}},{base:{enemyContrib12:-1,enemySpeed:1,ownContrib12:null,ownSpeed:null}},{migrationId:'changed'},{updatedAt:new Date(0)}]) {
        await assertFails(col.doc('meta').set({...meta,updatedAt:serverTimestamp(),...delta}));
      }
      await assertFails(col.doc('meta').delete());
      for(const [id,time] of [['0659','06:59'],['0700','08:00'],['2500','25:00']]) await assertFails(col.doc(id).set({...record(time),updatedAt:serverTimestamp()}));
      for(const delta of [{extra:1},{own:-1},{enemy:'100'},{own:9007199254740992},{updatedAt:new Date(0)}]) await assertFails(col.doc('1100').set({...record('11:00'),updatedAt:serverTimestamp(),...delta}));
      for(const [id,time] of [['0700','07:00'],['1159','11:59'],['1200','12:00'],['2400','24:00']]) {
        await assertSucceeds(col.doc(id).set({...record(time),updatedAt:serverTimestamp()}));await assertSucceeds(col.doc(id).delete());
      }
      await assertFails(db.doc('gwBattleReviews/2026-09-26_day1/entries/0700').set({...record('07:00'),updatedAt:serverTimestamp()}));
    });
  } finally {clients.forEach(c=>c.sync.stop());await env.cleanup();}
});
