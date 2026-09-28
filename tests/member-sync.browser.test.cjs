/* Existing local emulators + the bundled Playwright runtime; no npm dependency changes.
 * NODE_PATH may point to the Codex bundled node_modules. Uses installed Edge headless.
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn,execFileSync} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {chromium} = require('playwright');
const ORIGIN='http://127.0.0.1:18765';
const URL=ORIGIN+'/speed-calculator-folder/speed-calculator.html';
const selector=id=>'[data-sync="'+id+'"]';
async function waitText(page,id,text) {
  await page.waitForFunction(({id,text})=>document.querySelector('[data-sync="'+id+'"]').textContent.includes(text),{id,text},{timeout:35000});
}
async function identity(page) {
  return page.evaluate(()=>firebase.app('member-sync').auth().currentUser?.uid || null);
}
async function admins(page,stamp) {
  return page.evaluate(async stamp=>{
    const result=[];
    for(const [i,name] of ['[DEFAULT]','yosen-shared','gbf-meron-portal-fcm'].entries()) {
      let app=firebase.apps.find(a=>a.name===name);
      if(!app){app=firebase.initializeApp(MEMBER_SYNC_LOCAL.firebaseConfig,name);app.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});}
      const auth=app.auth();await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
      await new Promise(resolve=>{const off=auth.onAuthStateChanged(()=>{off();resolve();});});
      if(i<2 && !auth.currentUser)await auth.createUserWithEmailAndPassword('admin-'+stamp+'-'+i+'@example.test','local-test-only-password');
      result.push(auth.currentUser?.uid || null);
    }
    return result;
  },stamp);
}

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function cloud(page) {
  return page.evaluate(async()=>{
    const app=firebase.app('member-sync'), db=app.firestore();
    const identity=(await db.doc('memberIdentities/'+app.auth().currentUser.uid).get({source:'server'})).data();
    return (await db.doc('memberProfiles/'+identity.profileId+'/settings/speedCalculator').get({source:'server'})).data();
  });
}
async function waitCloud(page,predicate) {
  for(let i=0;i<100;i++){const value=await cloud(page);if(value&&predicate(value))return value;await pause(100);}
  throw Error('Cloud settings did not converge');
}
async function waitLocal(page,level,value) {
  await page.waitForFunction(({level,value})=>JSON.parse(localStorage.getItem('gbf_unf_speed_calc_times'))?.[level]===value,{level,value});
  assert.equal(await page.locator('.table-time-input[data-hell="'+level+'"]').inputValue(),String(value));
}
async function editHell(page,level,value) {
  await page.locator('.table-time-input[data-hell="'+level+'"]').fill(String(value));
}
async function editInterval(page,value) {
  await page.locator('#inputInterval').evaluate((input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));},String(value));
}

test('real browser pairing, reload, admin isolation, desktop/mobile and calculator fallback', {timeout:360000}, async t=>{
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8080');
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:9099');
  const server=spawn('python',['tests/member-sync-browser.py'],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let serverErrors='';server.stderr.on('data',chunk=>{serverErrors+=chunk;});
  let browser;
  const output=process.env.MEMBER_SYNC_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(),'member-sync-browser-'));
  fs.mkdirSync(output,{recursive:true});
  const consoleErrors=[],pageErrors=[],external=[],failedResponses=[];
  try {
    for(let i=0;i<100;i++){
      try {if((await fetch(URL)).ok)break;}catch{}
      if(server.exitCode!==null)throw Error('Local fixture failed: '+serverErrors);
      if(i===99)throw Error('Local fixture did not start');
      await new Promise(r=>setTimeout(r,100));
    }
    browser=await chromium.launch({channel:'msedge',headless:true});
    const contexts=[];
    async function device(viewport) {
      const context=await browser.newContext({viewport,permissions:['clipboard-read','clipboard-write']});contexts.push(context);
      await context.route('**/*',route=>{
        const host=new globalThis.URL(route.request().url()).hostname;
        if(!['127.0.0.1','localhost'].includes(host)){external.push(host+new globalThis.URL(route.request().url()).pathname);return route.abort();}
        return route.continue();
      });
      const page=await context.newPage();
      page.on('console',msg=>{if(msg.type()==='error'){consoleErrors.push({text:msg.text(),location:msg.location()});console.log('CONSOLE ERROR:', msg.text());}});
      page.on('pageerror',error=>{pageErrors.push(error.message);console.log('PAGE ERROR:', error.message);});
      page.on('response',response=>{
        if(response.status()>=400)failedResponses.push((async()=>{
          let body;try{body=await response.json();}catch{}
          return {url:response.url(),status:response.status(),code:body?.error?.status,message:body?.error?.message};
        })());
      });
      await page.goto(URL);await page.waitForFunction(()=>globalThis.firebase?.apps.some(a=>a.name==='member-sync'));
      await page.waitForFunction(()=>document.querySelector('[data-member-sync]').getAttribute('aria-busy')==='false');
      await page.locator('[data-member-sync] summary').click();
      return page;
    }
    const pc=await device({width:1440,height:1000});
    const phone=await device({width:390,height:844});
    const stamp=Date.now();
    const pcAdmins=await admins(pc,stamp+'pc'), phoneAdmins=await admins(phone,stamp+'phone');
    const widths=await Promise.all([pc,phone].map(p=>p.evaluate(()=>document.documentElement.scrollWidth)));
    let pcUid,phoneUid,code,oldCode;
    await t.test('unpaired calculator saves immediately without creating authentication',async()=>{
      await editHell(pc,200,123);await editInterval(pc,4.2);
      await editHell(phone,200,333);await editInterval(phone,9.1);
      await waitLocal(pc,200,123);await waitLocal(phone,200,333);
      assert.equal(await identity(pc),null);assert.equal(await identity(phone),null);
      assert((await pc.locator('#honorHourlyFormatted').textContent()).length>0);
    });
    await t.test('page load creates no anonymous account; explicit start creates profile only',async()=>{
      assert.equal(await identity(pc),null);assert.equal(await identity(phone),null);
      let inviteCalls=0;pc.on('request',r=>{if(r.url().endsWith('/invites')&&r.method()==='POST')inviteCalls++;});
      await pc.locator(selector('start')).click();await waitText(pc,'status','接続済み');
      pcUid=await identity(pc);assert(pcUid);assert.equal(inviteCalls,0);
      const initial=await waitCloud(pc,data=>data.revision===1);
      assert.equal(initial.hellTimesSec[200],123);assert.equal(initial.intervalSec,4.2);
      await pause(1100);assert.equal((await cloud(pc)).revision,1);
      assert.deepEqual(await admins(pc,stamp+'pc'),pcAdmins);
      await pc.screenshot({path:path.join(output,'desktop-ready.png'),fullPage:true});
    });
    await t.test('reload restores the same UID and connection without another start',async()=>{
      await pc.reload();await waitText(pc,'status','接続済み');assert.equal(await identity(pc),pcUid);
      assert.deepEqual(await admins(pc,stamp+'pc'),pcAdmins);
      await pc.locator('[data-member-sync] summary').click();assert.equal(await pc.locator(selector('start')).isVisible(),false);
    });
    await t.test('issue, copy, expiry text and reissue show only the latest code',async()=>{
      await pc.locator(selector('add')).click();await pc.locator(selector('invite')).waitFor({state:'visible'});
      oldCode=await pc.locator(selector('code')).textContent();assert.match(oldCode,/^[A-Z2-9]{4}(-[A-Z2-9]{4}){2}$/);
      assert((await pc.locator(selector('invite')).textContent()).includes('10分間有効'));
      await pc.locator(selector('copy')).click();await waitText(pc,'message','コピーしました');
      assert.equal(await pc.evaluate(()=>navigator.clipboard.readText()),oldCode);
      await pc.locator(selector('add')).click();await pc.locator(selector('invite')).waitFor({state:'visible'});
      code=await pc.locator(selector('code')).textContent();assert.notEqual(code,oldCode);
      assert.equal(await pc.locator(selector('code')).count(),1);
      await pc.locator('[data-member-sync]').screenshot({path:path.join(output,'desktop-code.png')});
    });
    await t.test('phone claim has no membership; pending and UID survive reload',async()=>{
      await phone.locator(selector('join')).click();await phone.locator(selector('input')).fill(' '+code.toLowerCase()+' ');
      await phone.locator(selector('join-form')+' button').click();await waitText(phone,'status','承認待ち');
      phoneUid=await identity(phone);assert(phoneUid);assert.notEqual(phoneUid,pcUid);
      assert.equal(await phone.evaluate(async()=> (await firebase.app('member-sync').firestore().doc('memberIdentities/'+firebase.app('member-sync').auth().currentUser.uid).get({source:'server'})).exists),false);
      await phone.screenshot({path:path.join(output,'phone-pending.png'),fullPage:true});
      await phone.reload();await waitText(phone,'status','承認待ち');assert.equal(await identity(phone),phoneUid);
      await phone.locator('[data-member-sync] summary').click();
      assert.deepEqual(await admins(phone,stamp+'phone'),phoneAdmins);
    });
    await t.test('existing device detects pending automatically; one approve completes phone pairing',async()=>{
      await waitText(pc,'notice','追加申請があります');
      await pc.getByRole('button',{name:'承認',exact:true}).click();await waitText(pc,'message','端末を追加しました');
      await waitText(phone,'status','接続済み');await waitText(phone,'message','同期設定が完了しました');
      await waitLocal(phone,200,123);
      assert.equal(await phone.locator('#inputInterval').inputValue(),'4.2');
      await pause(1100);assert.equal((await cloud(pc)).revision,1);
      const profiles=await Promise.all([pc,phone].map(p=>p.evaluate(async()=> (await firebase.app('member-sync').firestore().doc('memberIdentities/'+firebase.app('member-sync').auth().currentUser.uid).get({source:'server'})).data().profileId)));
      assert.equal(profiles[0],profiles[1]);
      assert.deepEqual(await admins(pc,stamp+'pc'),pcAdmins);assert.deepEqual(await admins(phone,stamp+'phone'),phoneAdmins);
      await phone.reload();await waitText(phone,'status','接続済み');assert.equal(await identity(phone),phoneUid);
      await phone.locator('[data-member-sync] summary').click();
    });
    await t.test('PC 200HELL reaches phone; interval returns to PC without remote write loops',async()=>{
      const before=(await cloud(pc)).revision;
      await pc.locator('.hell-card[data-level="200"]').click();
      await phone.locator('.hell-card[data-level="200"]').click();
      await pc.locator('#inputMinutes').fill('2');await pc.locator('#inputSeconds').fill('17');
      await waitLocal(phone,200,137);assert.equal(await phone.locator('#inputMinutes').inputValue(),'2');
      assert.equal(await phone.locator('#inputSeconds').inputValue(),'17');
      await waitCloud(pc,data=>data.hellTimesSec[200]===137);
      await pause(1200);assert.equal((await cloud(pc)).revision,before+1);
      await editInterval(phone,5.7);
      await pc.waitForFunction(()=>localStorage.getItem('gbf_unf_speed_calc_interval')==='5.7');
      assert.equal(await pc.locator('#inputInterval').inputValue(),'5.7');
      assert.equal(await pc.locator('#intervalDisplay').textContent(),'5.7');
      await pause(1200);assert.equal((await cloud(pc)).revision,before+2);
    });
    await t.test('different HELL fields survive concurrent edits and independent debounce',async()=>{
      const before=(await cloud(pc)).revision;
      await Promise.all([editHell(pc,90,19),editHell(phone,250,267)]);
      await waitLocal(phone,90,19);await waitLocal(pc,250,267);
      await waitCloud(pc,data=>data.hellTimesSec[90]===19&&data.hellTimesSec[250]===267);
      await pause(1100);assert.equal((await cloud(pc)).revision,before+2);
      await editHell(pc,90,20);await editHell(pc,250,268);await editHell(pc,90,21);
      await waitLocal(phone,90,21);await waitLocal(phone,250,268);
      await pause(1100);assert.equal((await cloud(pc)).revision,before+4);
    });
    await t.test('HELL switches, identical inputs, recalculation and reload do not update cloud',async()=>{
      const before=await cloud(pc);
      await pc.locator('.hell-card[data-level="90"]').click();
      await pc.locator('.hell-card[data-level="200"]').click();
      await pc.locator('#inputSeconds').dispatchEvent('input');
      await editInterval(pc,before.intervalSec);
      await pc.evaluate(()=>updateCalculation());
      await pc.reload();await waitText(pc,'status','接続済み');await waitLocal(pc,200,137);
      assert.equal(await identity(pc),pcUid);
      assert.equal((await cloud(pc)).updatedByDeviceId,before.updatedByDeviceId);
      await pause(1200);assert.equal((await cloud(pc)).revision,before.revision);
      await pc.locator('[data-member-sync] summary').click();
    });
    await t.test('preset and boundary zero values propagate and remain in local storage',async()=>{
      await pc.locator('.hell-card[data-level="200"]').click();
      const chip=pc.locator('.preset-chips .chip').first();const value=Number(await chip.getAttribute('data-time'));
      await chip.click();await waitLocal(phone,200,value);
      await editHell(pc,200,0);await waitLocal(phone,200,0);
      assert.equal(await phone.locator('#inputMinutes').inputValue(),'0');assert.equal(await phone.locator('#inputSeconds').inputValue(),'0');
      assert.equal((await cloud(pc)).hellTimesSec[200],0);
    });
    await t.test('calculator results match pre-sync checkpoint with identical inputs',async()=>{
      const baseline=execFileSync('git',['show','17d2628:speed-calculator-folder/speed-calculator.html'],{encoding:'utf8'})
        .replace(/<link[^>]+href="https:\/\/fonts\.[^>]+>/g,'').replace(/<script src="..\/member-sync.js"><\/script>/,'');
      const base=await browser.newContext({viewport:{width:1440,height:1000}});
      await base.route('**/*',route=>route.request().url()===URL?route.fulfill({contentType:'text/html',body:baseline}):route.fulfill({status:204,body:''}));
      const page=await base.newPage();await page.goto(URL);
      const ids=['totalBattleSeconds','cycleTotalTimeDisplay','honorHourlyFormatted','honorHourlyExact','clearsHourly','meatHourly','apHourly','goalTotalRuns','goalTotalTime','goalTotalMeat'];
      for(const target of [pc,page]){
        await target.locator('.hell-card[data-level="200"]').click();
        await target.locator('#inputMinutes').fill('2');await target.locator('#inputSeconds').fill('10');
        await editInterval(target,4.2);await target.locator('#inputTargetHonor').fill('1000000000');
      }
      const values=target=>target.evaluate(ids=>ids.map(id=>document.getElementById(id).textContent),ids);
      assert.deepEqual(await values(pc),await values(page));await base.close();
      await waitLocal(phone,200,130);await pause(1100);
    });
    await t.test('desktop and mobile remain editable without increased page overflow',async()=>{
      for(const [i,page] of [pc,phone].entries()){
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),widths[i]);
        assert(await page.locator('#inputSeconds').isEditable());
        assert(await page.locator(selector('add')).isEnabled());
        await page.screenshot({path:path.join(output,i?'phone-synced.png':'desktop-synced.png'),fullPage:true});
      }
      assert.deepEqual(await admins(pc,stamp+'pc'),pcAdmins);assert.deepEqual(await admins(phone,stamp+'phone'),phoneAdmins);
    });
    await t.test('phone code fits 390px; approval/rejection targets are spaced; rejection is automatic',async()=>{
      await phone.locator(selector('add')).click();await phone.locator(selector('invite')).waitFor({state:'visible'});
      const phoneCode=await phone.locator(selector('code')).textContent();
      const box=await phone.locator(selector('code')).boundingBox();assert(box.x>=0&&box.x+box.width<=390);
      const third=await device({width:390,height:844});
      await third.locator(selector('join')).click();await third.locator(selector('input')).fill(phoneCode);
      await third.locator(selector('join-form')+' button').click();await waitText(third,'status','承認待ち');
      await waitText(phone,'notice','追加申請があります');
      const approve=await phone.getByRole('button',{name:'承認',exact:true}).boundingBox();
      const reject=await phone.getByRole('button',{name:'拒否',exact:true}).boundingBox();
      assert(approve.height>=44&&reject.height>=44&&reject.x-(approve.x+approve.width)>=16);
      await phone.screenshot({path:path.join(output,'phone-code-and-approval.png'),fullPage:true});
      await phone.getByRole('button',{name:'拒否',exact:true}).click();await waitText(third,'message','拒否されました');
      assert.equal(await third.locator(selector('add')).isVisible(),false);
    });
    await t.test('happy flow has only verified transaction retries, no uncaught errors or external requests',async()=>{
      const failures=await Promise.all(failedResponses);
      const retries=failures.filter(r=>r.status===400&&r.url==='http://127.0.0.1:8080/v1/projects/gbf-meron-portal/databases/(default)/documents:commit'
        && r.code==='FAILED_PRECONDITION'&&r.message.includes('stored version')&&r.message.includes('required base version'));
      assert.deepEqual(failures,retries);
      assert.equal(consoleErrors.length,retries.length);
      for(const error of consoleErrors){assert.equal(error.location.url,retries[0].url);assert(error.text.includes('400 (Bad Request)'));}
      console.log('Verified Firestore transaction retries: '+retries.length);
      assert.deepEqual(pageErrors,[]);assert.deepEqual(external,[]);
    });
    await t.test('invalid and consumed codes show safe errors; network loss leaves calculation and storage working',async()=>{
      const fourth=await device({width:390,height:844});
      await fourth.locator(selector('join')).click();await fourth.locator(selector('input')).fill('not-a-code');
      await fourth.locator(selector('join-form')+' button').click();await waitText(fourth,'message','コードが正しくありません');
      assert.equal(await identity(fourth),null);
      await fourth.locator(selector('input')).fill(code);await fourth.locator(selector('join-form')+' button').click();
      await waitText(fourth,'message','このコードは使用できません');
      await pc.context().setOffline(true);
      await pc.route('**/api/member-sync/**',route=>route.abort('failed'));
      await pc.locator(selector('add')).click();await waitText(pc,'message','通信に失敗しました');
      await pc.locator('#inputMinutes').fill('2');await pc.locator('#inputSeconds').fill('11');
      await pc.locator('#inputSeconds').dispatchEvent('input');
      assert.equal(await pc.locator('#totalBattleSeconds').textContent(),'131');
      assert(await pc.evaluate(()=>localStorage.getItem('gbf_unf_speed_calc_times')));
      assert((await pc.locator('#honorHourlyFormatted').textContent()).length>0);
      await pause(1800);
      assert.equal(await pc.locator('#totalBattleSeconds').textContent(),'131');
      assert.equal(await pc.evaluate(()=>JSON.parse(localStorage.getItem('gbf_unf_speed_calc_times'))[200]),131);
      assert.deepEqual(pageErrors,[]);
    });
    // ── Block 5A-1: offline pending / reconnect replay browser tests ──────────────────────
    // Helper: read gbf_unf_speed_calc_sync_pending localStorage key from a page.
    async function pendingLS(page) {
      return page.evaluate(()=>{
        const raw=localStorage.getItem('gbf_unf_speed_calc_sync_pending');
        return raw?JSON.parse(raw):null;
      });
    }
    // Block 5A-1 uses a fresh paired browser context.
    const pc5=await device({width:1440,height:1000});
    const stamp5=Date.now();
    await admins(pc5,stamp5+'pc5');
    await t.test('Block 5A-1 H: unpaired device — pending cloud mechanism must not activate',async()=>{
      await editHell(pc5,90,50);
      await pause(1800);
      assert.equal(await identity(pc5),null,'no anonymous auth on unpaired device');
      assert.equal(await pendingLS(pc5),null,'pending LS must not be created on unpaired device');
    });
    let pc5uid;
    const pc5clone=await device({width:1440,height:1000});
    await admins(pc5clone,stamp5+'pc5c');
    await t.test('Block 5A-1 setup: pair pc5 for pending tests',async()=>{
      await pc5.locator(selector('start')).click();await waitText(pc5,'status','接続済み');
      pc5uid=await identity(pc5);assert(pc5uid);
      await pc5.locator(selector('add')).click();await pc5.locator(selector('invite')).waitFor({state:'visible'});
      const c5=await pc5.locator(selector('code')).textContent();
      await pc5clone.locator(selector('join')).click();await pc5clone.locator(selector('input')).fill(c5);
      await pc5clone.locator(selector('join-form')+' button').click();await waitText(pc5clone,'status','承認待ち');
      await waitText(pc5,'notice','追加申請があります');
      await pc5.getByRole('button',{name:'承認',exact:true}).click();await waitText(pc5,'message','端末を追加しました');
      await waitText(pc5clone,'status','接続済み');
    });
    await t.test('Block 5A-1 A+F: offline change saves to pending LS; different field snapshot accepted',async()=>{
      await editHell(pc5,90,10);await waitCloud(pc5,d=>d.hellTimesSec[90]===10);
      assert.equal(await pendingLS(pc5),null,'no pending before going offline');
      await pc5.context().setOffline(true);
      await pc5.locator('.hell-card[data-level=\"90\"]').click();
      await pc5.locator('#inputMinutes').fill('0');await pc5.locator('#inputSeconds').fill('12');
      await pc5.locator('#inputSeconds').dispatchEvent('input');
      await pause(1800);
      assert.equal(await pc5.locator('#totalBattleSeconds').textContent(),'12','UI must keep pending value');
      assert.equal(await pc5.evaluate(()=>JSON.parse(localStorage.getItem('gbf_unf_speed_calc_times'))[90]),12,'normal LS must retain value');
      const p=await pendingLS(pc5);assert(p&&p['hellTimesSec.90']===12,'pending LS must hold offline change');
      await pc5.context().setOffline(false);
      // Clone writes 250=220; pc5 snapshot: 90 stays 12 (pending), 250 becomes 220.
      await editHell(pc5clone,250,220);await waitCloud(pc5clone,d=>d.hellTimesSec[250]===220);
      await pause(1500);
      assert.equal(await pc5.evaluate(()=>JSON.parse(localStorage.getItem('gbf_unf_speed_calc_times'))[90]),12,'pending field must not be overwritten by snapshot');
      assert.equal(await pc5.evaluate(()=>JSON.parse(localStorage.getItem('gbf_unf_speed_calc_times'))[250]),220,'non-pending field must accept remote snapshot');
    });
    await t.test('Block 5A-1 B: reconnect replays pending to cloud and clears pending LS',async()=>{
      await waitCloud(pc5,d=>d.hellTimesSec[90]===12);
      await pc5.waitForFunction(()=>!localStorage.getItem('gbf_unf_speed_calc_sync_pending'));
      assert.equal(await pendingLS(pc5),null,'pending LS must be empty after replay');
    });
    await t.test('Block 5A-1 E: same-field conflict — last commit wins (PC 12 beats phone 15)',async()=>{
      await editHell(pc5clone,90,15);await waitCloud(pc5clone,d=>d.hellTimesSec[90]===15);
      await pc5.context().setOffline(true);
      await pc5.locator('.hell-card[data-level=\"90\"]').click();
      await pc5.locator('#inputMinutes').fill('0');await pc5.locator('#inputSeconds').fill('12');
      await pc5.locator('#inputSeconds').dispatchEvent('input');
      await pause(1800);
      const p2=await pendingLS(pc5);assert(p2&&p2['hellTimesSec.90']===12,'pending must hold 12');
      await pc5.context().setOffline(false);
      await waitCloud(pc5,d=>d.hellTimesSec[90]===12);
      await pc5.waitForFunction(()=>!localStorage.getItem('gbf_unf_speed_calc_sync_pending'));
    });
    await t.test('Block 5A-1 C: offline + reload + reconnect replays pending',async()=>{
      await editHell(pc5,90,10);await waitCloud(pc5,d=>d.hellTimesSec[90]===10);
      await pc5.context().setOffline(true);
      await pc5.locator('.hell-card[data-level=\"90\"]').click();
      await pc5.locator('#inputMinutes').fill('0');await pc5.locator('#inputSeconds').fill('13');
      await pc5.locator('#inputSeconds').dispatchEvent('input');
      await pause(1800);
      assert.equal((await pendingLS(pc5))?.['hellTimesSec.90'],13,'pending must be saved before reload');
      await pc5.context().setOffline(false);
      await pc5.reload();await waitText(pc5,'status','接続済み');
      await waitCloud(pc5,d=>d.hellTimesSec[90]===13);
      await pc5.waitForFunction(()=>!localStorage.getItem('gbf_unf_speed_calc_sync_pending'));
      assert.equal(await pendingLS(pc5),null,'pending must be cleared after reload replay');
    });
    await t.test('Block 5A-1 G: multiple pending fields replayed; both cleared on success',async()=>{
      await editHell(pc5,90,10);await pause(1200);
      await pc5.context().setOffline(true);
      await pc5.locator('.hell-card[data-level=\"90\"]').click();
      await pc5.locator('#inputMinutes').fill('0');await pc5.locator('#inputSeconds').fill('14');
      await pc5.locator('#inputSeconds').dispatchEvent('input');
      await pc5.locator('#inputInterval').evaluate(input=>{input.value='7';input.dispatchEvent(new Event('input',{bubbles:true}));});
      await pause(1800);
      const p3=await pendingLS(pc5);
      assert(p3&&p3['hellTimesSec.90']===14,'90 pending must exist');
      assert(p3&&p3['intervalSec']===7,'intervalSec pending must exist');
      await pc5.context().setOffline(false);
      await waitCloud(pc5,d=>d.hellTimesSec[90]===14&&d.intervalSec===7);
      await pc5.waitForFunction(()=>!localStorage.getItem('gbf_unf_speed_calc_sync_pending'));
    });
    console.log('Block 5A-1 browser tests complete');
    console.log('Browser artifacts: '+output);
    console.log('Uncaught errors: '+pageErrors.length+'; external requests: '+JSON.stringify(external)+'. Error cases use intentional failed requests.');
  } finally {
    if(browser)await browser.close();
    if(server.exitCode===null){server.kill();await once(server,'exit');}
  }
});
