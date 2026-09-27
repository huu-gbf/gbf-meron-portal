/* Existing local emulators + the bundled Playwright runtime; no npm dependency changes.
 * NODE_PATH may point to the Codex bundled node_modules. Uses installed Edge headless.
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
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

test('real browser pairing, reload, admin isolation, desktop/mobile and calculator fallback', {timeout:240000}, async t=>{
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8080');
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:9099');
  const server=spawn('python',['tests/member-sync-browser.py'],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let serverErrors='';server.stderr.on('data',chunk=>{serverErrors+=chunk;});
  let browser;
  const output=process.env.MEMBER_SYNC_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(),'member-sync-browser-'));
  fs.mkdirSync(output,{recursive:true});
  const consoleErrors=[],pageErrors=[],external=[];
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
        if(!['127.0.0.1','localhost'].includes(host)){external.push(host);return route.abort();}
        return route.continue();
      });
      const page=await context.newPage();
      page.on('console',msg=>{if(msg.type()==='error')consoleErrors.push(msg.text());});
      page.on('pageerror',error=>pageErrors.push(error.message));
      await page.goto(URL);await page.waitForFunction(()=>globalThis.firebase?.apps.some(a=>a.name==='member-sync'));
      await page.waitForFunction(()=>document.querySelector('[data-member-sync]').getAttribute('aria-busy')==='false');
      await page.locator('[data-member-sync] summary').click();
      return page;
    }
    const pc=await device({width:1440,height:1000});
    const phone=await device({width:390,height:844});
    const stamp=Date.now();
    const pcAdmins=await admins(pc,stamp+'pc'), phoneAdmins=await admins(phone,stamp+'phone');
    let pcUid,phoneUid,code,oldCode;
    await t.test('page load creates no anonymous account; explicit start creates profile only',async()=>{
      assert.equal(await identity(pc),null);assert.equal(await identity(phone),null);
      let inviteCalls=0;pc.on('request',r=>{if(r.url().endsWith('/invites')&&r.method()==='POST')inviteCalls++;});
      await pc.locator(selector('start')).click();await waitText(pc,'status','接続済み');
      pcUid=await identity(pc);assert(pcUid);assert.equal(inviteCalls,0);
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
      const profiles=await Promise.all([pc,phone].map(p=>p.evaluate(async()=> (await firebase.app('member-sync').firestore().doc('memberIdentities/'+firebase.app('member-sync').auth().currentUser.uid).get({source:'server'})).data().profileId)));
      assert.equal(profiles[0],profiles[1]);
      assert.deepEqual(await admins(pc,stamp+'pc'),pcAdmins);assert.deepEqual(await admins(phone,stamp+'phone'),phoneAdmins);
      await phone.reload();await waitText(phone,'status','接続済み');assert.equal(await identity(phone),phoneUid);
      await phone.locator('[data-member-sync] summary').click();
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
    await t.test('happy flow has zero console/page errors and zero external requests',()=>{
      assert.deepEqual(consoleErrors,[]);assert.deepEqual(pageErrors,[]);assert.deepEqual(external,[]);
    });
    await t.test('invalid and consumed codes show safe errors; network loss leaves calculation and storage working',async()=>{
      const fourth=await device({width:390,height:844});
      await fourth.locator(selector('join')).click();await fourth.locator(selector('input')).fill('not-a-code');
      await fourth.locator(selector('join-form')+' button').click();await waitText(fourth,'message','コードが正しくありません');
      assert.equal(await identity(fourth),null);
      await fourth.locator(selector('input')).fill(code);await fourth.locator(selector('join-form')+' button').click();
      await waitText(fourth,'message','このコードは使用できません');
      await pc.route('**/api/member-sync/**',route=>route.abort('failed'));
      await pc.locator(selector('add')).click();await waitText(pc,'message','通信に失敗しました');
      await pc.locator('#inputMinutes').fill('2');await pc.locator('#inputSeconds').fill('10');
      await pc.locator('#inputSeconds').dispatchEvent('input');
      assert.equal(await pc.locator('#totalBattleSeconds').textContent(),'130');
      assert(await pc.evaluate(()=>localStorage.getItem('gbf_unf_speed_calc_times')));
      assert((await pc.locator('#honorHourlyFormatted').textContent()).length>0);
      assert.deepEqual(pageErrors,[]);
    });
    console.log('Browser artifacts: '+output);
    console.log('Happy flow: console errors 0; uncaught errors 0; external requests 0. Error cases use intentional failed requests.');
  } finally {
    if(browser)await browser.close();
    if(server.exitCode===null){server.kill();await once(server,'exit');}
  }
});
