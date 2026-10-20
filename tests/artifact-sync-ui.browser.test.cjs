/* Real Edge + Auth/Firestore emulators. Every external URL is blocked or fulfilled locally. */
'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const {createDefaultArtifactProjection,ARTIFACT_LEGACY_EFFECT_IDS}=require('../artifact-catalog');
const {createFixture,waitCloud,waitLocal,needed,selected,memo,reset,storage,fixtureState,syncState,idle,
  offline,resume,pause,GW,HIGH,OWNER,PREFIX}=require('./artifact-sync-ui-browser.cjs');
const X=ARTIFACT_LEGACY_EFFECT_IDS.s12_0,Y=ARTIFACT_LEGACY_EFFECT_IDS.s12_1,F=ARTIFACT_LEGACY_EFFECT_IDS.s4_0;
const legacy=(text,extra={})=>JSON.stringify({memos:[{character:'local',artifact:text}],...extra});
const pendingCount=async(device,mode='gw')=>(await syncState(device))?.modes?.[mode]?.pending?.length||0;
const localMemo=async(device,mode='gw')=>JSON.parse((await storage(device))[mode==='gw'?GW:HIGH]||'{}').memos;
const snapshotUi=device=>device.page.evaluate(()=>({mode:currentMode,settings:JSON.parse(JSON.stringify(userSettings)),
  summary:['summary-slot12','summary-slot3','summary-slot4'].map(id=>document.getElementById(id).textContent),
  width:document.documentElement.scrollWidth,viewport:innerWidth}));

test('Artifact UI: actual PC/mobile SDK sync, durable offline/reset lifecycle and local fallback',{timeout:600000},async t=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const fixture=await createFixture(browser);
  let pc,phone,owner;
  try {
    await t.test('first restored PC initializes gw and high independently from legacy state',async()=>{
      owner=await fixture.profile();
      pc=await fixture.open({owner,seed:{
        [GW]:legacy('PC private',{s12_0:{needed:true,selectedValue:'1320'},unknownLegacy:{keep:'PC'}}),
        [HIGH]:legacy('PC high private',{s3_0:{needed:true,selectedValue:'2.2%'}})}});
      const gw=await waitCloud(fixture,owner,value=>value?.items[X].needed&&value.items[X].selectedValue==='1320');
      const high=await waitCloud(fixture,owner,value=>value?.items[ARTIFACT_LEGACY_EFFECT_IDS.s3_0].selectedValue==='2.2%','high');
      assert.equal(Object.keys(gw.items).length,63);assert.equal(Object.keys(high.items).length,63);
      assert.equal(gw.resetEpoch,0);assert.equal(high.resetEpoch,0);assert.equal(gw.revision,1);assert.equal(high.revision,1);
      assert.equal((await fixtureState(pc)).authCreates,0);await idle(pc);await idle(pc,'high');
    });
    if(!pc||!(await fixture.cloud(owner)))throw Error('Initial real-PC fixture did not connect; later device cases depend on it');
    await t.test('second phone adopts cloud fields without uploading old legacy or its private memos',async()=>{
      phone=await fixture.open({owner,viewport:{width:390,height:844},seed:{
        [GW]:legacy('phone private',{s12_0:{needed:false,selectedValue:'1800'},s12_1:{needed:true,selectedValue:'8.8%'}}),
        [HIGH]:legacy('phone high private',{s3_0:{needed:false,selectedValue:'3%'}})}});
      await waitLocal(phone,'s12_0','needed',true);await waitLocal(phone,'s12_0','selectedValue','1320');
      await waitLocal(phone,'s12_1','needed',false);await waitLocal(phone,'s3_0','selectedValue','2.2%','high');
      assert.equal((await localMemo(phone))[0].artifact,'phone private');assert.equal((await localMemo(pc))[0].artifact,'PC private');
      assert.equal((await fixture.cloud(owner)).revision,1);assert.equal((await fixtureState(phone)).authCreates,0);
    });
    if(!phone)throw Error('Real phone fixture did not open; later paired-device cases depend on it');
    await t.test('needed synchronizes PC to phone and phone to PC without changing selection',async()=>{
      await needed(pc,'s12_1',true);await waitLocal(phone,'s12_1','needed',true);
      await needed(phone,'s12_1',false);await waitLocal(pc,'s12_1','needed',false);
      assert.equal((await fixture.cloud(owner)).items[Y].selectedValue,'12%');await idle(pc);await idle(phone);
    });
    await t.test('selected values synchronize in both directions without changing needed',async()=>{
      await selected(pc,'s12_0','1440');await waitLocal(phone,'s12_0','selectedValue','1440');
      await selected(phone,'s12_0','1560');await waitLocal(pc,'s12_0','selectedValue','1560');
      assert.equal((await fixture.cloud(owner)).items[X].needed,true);await idle(pc);await idle(phone);
    });
    await t.test('fixed s4 synchronizes only needed and regenerates its display value locally',async()=>{
      await needed(phone,'s4_0',true);await waitLocal(pc,'s4_0','needed',true);
      const cloud=await waitCloud(fixture,owner,value=>value?.items[F].needed);
      assert.deepEqual(cloud.items[F],{needed:true});
      const data=JSON.parse((await storage(pc))[GW]);assert.equal(data.s4_0.selectedValue,'3%');
    });
    await t.test('gw and high are separate across both devices and pending ACKs',async()=>{
      const gw=await fixture.cloud(owner);
      await needed(pc,'s12_2',true,'high');await selected(phone,'s3_0','2.4%','high');
      await waitLocal(phone,'s12_2','needed',true,'high');await waitLocal(pc,'s3_0','selectedValue','2.4%','high');
      assert.deepEqual(await fixture.cloud(owner),gw);await idle(pc,'high');await idle(phone,'high');
    });
    await t.test('memo editing changes local legacy only and produces no pending or Firestore write',async()=>{
      await idle(pc);const before=await fixture.cloud(owner),transactions=(await fixtureState(pc)).transactions.length;
      await memo(pc,'PC <>& only');await pause(150);
      assert.equal((await localMemo(pc))[0].artifact,'PC <>& only');assert.equal((await localMemo(phone))[0].artifact,'phone private');
      assert.equal(await pendingCount(pc),0);assert.equal((await fixtureState(pc)).transactions.length,transactions);
      assert.deepEqual(await fixture.cloud(owner),before);
    });
    await t.test('different effects edited concurrently converge without lost writes',async()=>{
      await Promise.all([needed(pc,'s12_3',true),needed(phone,'s12_4',true)]);
      await waitLocal(phone,'s12_3','needed',true);await waitLocal(pc,'s12_4','needed',true);
      const cloud=await fixture.cloud(owner);assert(cloud.items[ARTIFACT_LEGACY_EFFECT_IDS.s12_3].needed);assert(cloud.items[ARTIFACT_LEGACY_EFFECT_IDS.s12_4].needed);
    });
    await t.test('same effect concurrent edits settle to the confirmed server value on both devices',async()=>{
      await Promise.all([selected(pc,'s12_0','1680'),selected(phone,'s12_0','1800')]);
      await idle(pc);await idle(phone);const cloud=await fixture.cloud(owner),value=cloud.items[X].selectedValue;
      assert(['1680','1800'].includes(value));await waitLocal(pc,'s12_0','selectedValue',value);await waitLocal(phone,'s12_0','selectedValue',value);
    });
    await t.test('remote updates recompute summary while retaining unknown legacy fields and mode/tab',async()=>{
      await pc.page.locator('#mode-btn-gw').click();await pc.page.locator('#nav-summary').click();
      const before=await pc.page.evaluate(()=>{
        const input=document.querySelector('#memo-container > div input:last-of-type');
        input.focus();input.setSelectionRange(1,3);globalThis.__artifactUiFocused=input;scrollTo(0,80);return scrollY;
      });
      await selected(phone,'s12_0','1440');await waitLocal(pc,'s12_0','selectedValue','1440');
      const ui=await snapshotUi(pc);assert.equal(ui.mode,'gw');assert(ui.summary[0].includes('1440'));
      assert.equal(await pc.page.locator('#tab-summary').evaluate(element=>element.classList.contains('hidden')),false);
      assert.deepEqual(await pc.page.evaluate(()=>({same:document.activeElement===__artifactUiFocused,
        start:__artifactUiFocused.selectionStart,end:__artifactUiFocused.selectionEnd,scroll:scrollY})),{same:true,start:1,end:3,scroll:before});
      assert.deepEqual(JSON.parse((await storage(pc))[GW]).unknownLegacy,{keep:'PC'});
    });
    await t.test('offline field/selection/memo writes remain immediate, survive reload and replay after reconnect',async()=>{
      await idle(phone);await offline(phone,true);
      await needed(phone,'s12_5',true);await selected(phone,'s12_0','1320');await memo(phone,'offline phone memo');
      assert.equal((await snapshotUi(phone)).settings.s12_5.needed,true);assert(await pendingCount(phone)>=2);
      await phone.page.reload({waitUntil:'load'});await phone.page.waitForFunction(()=>document.querySelectorAll('.item-card').length===63);
      assert.equal(JSON.parse((await storage(phone))[GW]).s12_5.needed,true);
      assert.equal((await localMemo(phone))[0].artifact,'offline phone memo');
      await needed(phone,'s12_9',true);
      await phone.page.reload({waitUntil:'load'});await phone.page.waitForFunction(()=>document.querySelectorAll('.item-card').length===63);
      assert.equal(JSON.parse((await storage(phone))[GW]).s12_9.needed,true);
      await offline(phone,false);await resume(phone);
      await waitLocal(pc,'s12_5','needed',true);await waitLocal(pc,'s12_9','needed',true);await waitLocal(pc,'s12_0','selectedValue','1320');await idle(phone);
      assert.equal((await localMemo(pc))[0].artifact,'PC <>& only');
    });
    await t.test('in-flight A ACK preserves newer B and another mode through pagehide/pageshow',async()=>{
      await idle(pc);await idle(pc,'high');
      await pc.page.evaluate(()=>{__artifactUiFixture.holdNext=true;});
      await needed(pc,'s12_6',true);await pc.page.waitForFunction(()=>__artifactUiFixture.held);
      await needed(pc,'s12_7',true);await needed(pc,'s12_8',true,'high');
      await pc.page.evaluate(()=>dispatchEvent(new Event('pagehide')));
      const before=(await fixtureState(pc)).transactions.length;
      await pc.page.evaluate(()=>__artifactUiFixture.release());await pause(120);
      const snapshot=await syncState(pc);assert(snapshot.modes.gw.pending.some(op=>op.effectId===ARTIFACT_LEGACY_EFFECT_IDS.s12_7));
      assert(snapshot.modes.high.pending.some(op=>op.effectId===ARTIFACT_LEGACY_EFFECT_IDS.s12_8));
      assert.equal((await fixtureState(pc)).transactions.length,before);
      await resume(pc);await waitLocal(phone,'s12_7','needed',true);await waitLocal(phone,'s12_8','needed',true,'high');
      await idle(pc);await idle(pc,'high');
      const sent=(await fixtureState(pc)).transactions.find(tx=>tx.writes.some(write=>write.keys.includes('items.'+ARTIFACT_LEGACY_EFFECT_IDS.s12_6+'.needed')));
      assert(sent);assert(Object.values(sent.pending).some(raw=>raw.includes(ARTIFACT_LEGACY_EFFECT_IDS.s12_6)),'pending is durable before transaction starts');
    });
    await t.test('online local reset clears its own memo but remote reset preserves the other memo',async()=>{
      const epoch=(await fixture.cloud(owner)).resetEpoch;await reset(pc);
      const cloud=await waitCloud(fixture,owner,value=>value?.resetEpoch===epoch+1);
      assert.deepEqual(cloud.items,createDefaultArtifactProjection().items);await waitLocal(phone,'s12_0','needed',false);
      assert.equal((await localMemo(phone))[0].artifact,'offline phone memo');
      const own=await localMemo(pc);assert(!own||own.every(value=>value.artifact===''));
      await idle(pc);
    });
    await t.test('remote reset invalidates stale offline field pending without clearing local memo',async()=>{
      await offline(phone,true);await needed(phone,'s12_0',true);const before=(await fixture.cloud(owner)).resetEpoch;
      await reset(pc);await waitCloud(fixture,owner,value=>value?.resetEpoch===before+1);
      await offline(phone,false);await resume(phone);await waitLocal(phone,'s12_0','needed',false);await idle(phone);
      assert.equal((await fixture.cloud(owner)).items[X].needed,false);assert.equal((await localMemo(phone))[0].artifact,'offline phone memo');
    });
    await t.test('offline X then reset then Y replays only post-reset edits across another remote reset',async()=>{
      await offline(phone,true);await needed(phone,'s12_0',true);await reset(phone);await needed(phone,'s12_1',true);
      const before=(await fixture.cloud(owner)).resetEpoch;await reset(pc);
      await waitCloud(fixture,owner,value=>value?.resetEpoch===before+1);await offline(phone,false);await resume(phone);
      const cloud=await waitCloud(fixture,owner,value=>value?.resetEpoch===before+2&&value.items[Y].needed);
      assert.equal(cloud.items[X].needed,false);await waitLocal(pc,'s12_1','needed',true);await idle(phone);
      assert.equal((await syncState(phone)).modes.gw.lastKnownResetEpoch,cloud.resetEpoch);
    });
    await t.test('simultaneous explicit resets both advance epoch and converge to defaults',async()=>{
      const before=(await fixture.cloud(owner)).resetEpoch;await Promise.all([reset(pc),reset(phone)]);
      const cloud=await waitCloud(fixture,owner,value=>value?.resetEpoch===before+2);
      assert.deepEqual(cloud.items,createDefaultArtifactProjection().items);await idle(pc);await idle(phone);
    });
    await t.test('same-value offline replay ACKs without changing revision or causing a remote write loop',async()=>{
      await idle(pc);const before=await fixture.cloud(owner);
      await pc.page.evaluate(()=>dispatchEvent(new Event('pagehide')));
      await needed(pc,'s12_0',true);await needed(pc,'s12_0',false);assert.equal(await pendingCount(pc),1);
      await resume(pc);await idle(pc);await pause(200);
      assert.deepEqual(await fixture.cloud(owner),before);
    });
    await t.test('PC/mobile viewport, fixed item count and console exception checks remain stable',async()=>{
      for(const device of [pc,phone]){
        await device.page.locator('#nav-summary').click();const ui=await snapshotUi(device);
        assert.equal(await device.page.locator('.item-card').count(),63);
        assert(ui.width-ui.viewport<=(ui.viewport===390?78:0),'no new horizontal overflow');
        assert.deepEqual(device.pageErrors,[]);assert.deepEqual(device.external,[]);
        assert.equal((await fixtureState(device)).authCreates,0);
      }
      const directory=process.env.ARTIFACT_SYNC_ARTIFACT_DIR;
      if(directory){fs.mkdirSync(directory,{recursive:true});for(const [name,device]of [['pc',pc],['mobile',phone]])await device.page.screenshot({path:path.join(directory,'artifact-sync-'+name+'.png'),fullPage:true});}
    });

    await t.test('owner A pending is archived and never replayed to owner B after identity replacement',async()=>{
      const a=await fixture.profile(),b=await fixture.profile();await fixture.seedCloud(a);await fixture.seedCloud(b);
      const device=await fixture.open({owner:a});await idle(device);
      await device.page.evaluate(()=>dispatchEvent(new Event('pagehide')));await needed(device,'s12_0',true);
      assert.equal(await pendingCount(device),1);await fixture.changeIdentity(device,b);
      await device.page.reload({waitUntil:'load'});await waitLocal(device,'s12_0','needed',false);await idle(device);
      assert.equal((await fixture.cloud(b)).items[X].needed,false);
      const records=await storage(device);assert(records[PREFIX+a]);assert(records[PREFIX+a].includes(X));
      assert.equal((await syncState(device)).ownerProfileId,b);assert.equal(records[OWNER]!==undefined,true);
    });
    await t.test('unconfigured user retains legacy fields/memos/reset/reload without Auth creation or Firestore requests',async()=>{
      const device=await fixture.open({unconfigured:true,viewport:{width:390,height:844},seed:{[GW]:legacy('unconfigured')}});
      await needed(device,'s12_0',true);await selected(device,'s12_0','1440');await memo(device,'local only');
      await device.page.reload({waitUntil:'load'});assert.equal(JSON.parse((await storage(device))[GW]).s12_0.selectedValue,'1440');
      await reset(device);assert.equal((await storage(device))[GW],'{}');
      const state=await fixtureState(device);assert.equal(state.authCreates,0);assert.deepEqual(state.reads,[]);assert.deepEqual(state.transactions,[]);
      assert.equal(device.requests.some(value=>new URL(value).port==='8080'),false);assert.deepEqual(device.pageErrors,[]);
    });
    await t.test('missing cloud and initial get failure initialize the latest local values after recovery',async()=>{
      const profile=await fixture.profile(),device=await fixture.open({owner:profile,faults:{get:true},seed:{[GW]:legacy('first offline memo')}});
      await device.page.waitForFunction(profile=>typeof artifactSync!=='undefined'&&artifactSync?.snapshot()?.ownerProfileId===profile,profile);
      await needed(device,'s12_1',true);await selected(device,'s12_0','1440');
      assert.equal(await fixture.cloud(profile),null);assert(await pendingCount(device)>=2);
      await device.page.evaluate(()=>{__artifactUiFixture.faults={};});await resume(device);
      const cloud=await waitCloud(fixture,profile,value=>value?.items[Y].needed&&value.items[X].selectedValue==='1440');
      assert.equal(cloud.revision,1);assert.equal(Object.keys(cloud.items).length,63);await idle(device);
      assert.equal((await localMemo(device))[0].artifact,'first offline memo');
      await waitCloud(fixture,profile,value=>value?.revision===1,'high');
    });
    for(const fault of ['memberScript','sdk','auth','get','subscribe','update']){
      await t.test(fault+' failure preserves immediate local tool operations and private memos',async()=>{
        const profile=await fixture.profile();await fixture.seedCloud(profile);
        const device=await fixture.open({owner:profile,faults:{[fault]:true},seed:{[GW]:legacy(fault+' memo')}});
        await needed(device,'s12_0',true);await selected(device,'s12_0','1440');await memo(device,fault+' local');
        const local=JSON.parse((await storage(device))[GW]);assert.equal(local.s12_0.needed,true);assert.equal(local.s12_0.selectedValue,'1440');
        assert.equal(local.memos[0].artifact,fault+' local');await needed(device,'s4_0',true,'high');
        assert.equal(JSON.parse((await storage(device))[HIGH]).s4_0.needed,true);assert.deepEqual(device.pageErrors,[]);
        assert.equal((await fixtureState(device)).authCreates,0);
        if(['get','subscribe','update'].includes(fault)){
          await device.page.evaluate(()=>{__artifactUiFixture.faults={};});await resume(device);
          await waitCloud(fixture,profile,value=>value?.items[X].needed&&value.items[X].selectedValue==='1440');await idle(device);
        }
      });
    }
    await t.test('invalid catalog remote safely stops without overwriting legacy or repairing cloud',async()=>{
      const profile=await fixture.profile();await fixture.seedCloud(profile,'gw',createDefaultArtifactProjection(),{catalogVersion:2});
      const device=await fixture.open({owner:profile,seed:{[GW]:legacy('invalid remote',{s12_0:{needed:true,selectedValue:'1440'}})}});
      await pause(150);await selected(device,'s12_0','1560');
      const saved=JSON.parse((await storage(device))[GW]);assert.equal(saved.s12_0.needed,true);assert.equal(saved.s12_0.selectedValue,'1560');
      assert.equal(saved.memos[0].artifact,'invalid remote');assert.equal((await fixture.cloud(profile)).catalogVersion,2);
      assert.deepEqual(device.pageErrors,[]);
    });
    await t.test('all fixtures stayed loopback and every page has zero uncaught JavaScript exceptions',async()=>{
      for(const device of fixture.devices){assert.deepEqual(device.external,[]);assert.deepEqual(device.pageErrors,[]);
        await Promise.all(device.responseReads);
        assert.equal(device.requests.some(value=>/https:\/\/(?:identitytoolkit|securetoken|firestore)\.googleapis\.com/.test(value)),false);
        const unexpected=device.consoleErrors.filter(error=>{
          if((device.expectedFaults.memberScript||device.expectedFaults.sdk)&&/Failed to load resource/.test(error.text)&&/503/.test(error.text))return false;
          if(device.wasOffline&&/Failed to load resource/.test(error.text)&&/ERR_INTERNET_DISCONNECTED/.test(error.text))return false;
          if(/Failed to load resource/.test(error.text)&&/400/.test(error.text)&&/127\.0\.0\.1:8080.*documents:commit/.test(error.url)){
            const responses=device.responses.filter(response=>response.url===error.url&&response.status===400);
            if(responses.length&&responses.every(response=>['ABORTED','FAILED_PRECONDITION','PERMISSION_DENIED'].includes(response.code)))return false;
          }
          return true;
        });
        assert.deepEqual(unexpected,[],'no unexpected console errors; deliberate SDK failures and decoded transaction conflicts are accounted for: '+JSON.stringify(device.responses));
      }
    });
  } finally {await fixture.close();await browser.close();}
});
