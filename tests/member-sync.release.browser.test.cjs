'use strict';
// Actual SDK + Emulator pairing, followed by navigation within the same origin.
// Existing suites cover field boundaries, offline/reset races and feedback CRUD.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const ORIGIN = 'http://127.0.0.1:18766';
const HISTORY_ID = '2026/10/23|PC・スマホ間の端末同期に対応';
const SPEED = ORIGIN + '/speed-calculator-folder/speed-calculator.html';
const waitStatus = page => page.waitForFunction(() => document.querySelector('[data-sync="status"]')?.textContent.includes('接続済み'));
const uid = page => page.evaluate(() => firebase.app('member-sync').auth().currentUser?.uid);

test('release: pairing persists across speed, portal and Artifact on PC/mobile', {timeout:180000}, async t => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080');
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9099');
  const server = spawn('python', ['-B', 'tests/member-sync-release-browser.py'], {
    env:process.env, stdio:['ignore','pipe','pipe'], windowsHide:true
  });
  let browser, serverError = '';
  server.stderr.on('data', value => { serverError += value; });
  const errors = [], blocked = [], requests = [];
  try {
    for (let i=0; i<100; i++) {
      try { if ((await fetch(SPEED)).ok) break; } catch {}
      if (server.exitCode !== null) throw Error('Local fixture failed: ' + serverError);
      if (i===99) throw Error('Local fixture did not start');
      await new Promise(resolve => setTimeout(resolve,100));
    }
    browser = await chromium.launch({channel:'msedge',headless:true});
    async function device(viewport) {
      const context = await browser.newContext({viewport,serviceWorkers:'block',permissions:['clipboard-read','clipboard-write']});
      await context.route('**/*', route => {
        const url = new URL(route.request().url()); requests.push(url);
        if (['127.0.0.1','localhost'].includes(url.hostname)) {
          if (['/manifest.webmanifest','/icons/apple-touch-icon.png'].includes(url.pathname)) return route.fulfill({status:204,body:''});
          return route.continue();
        }
        if (url.hostname === 'fonts.googleapis.com') return route.fulfill({contentType:'text/css',body:''});
        if (url.hostname === 'cdn.tailwindcss.com') return route.fulfill({contentType:'application/javascript',body:'window.tailwind={};document.write(\'<link rel="stylesheet" href="/css/tailwind.min.css">\');'});
        if (url.pathname === '/api/visit' || url.pathname === '/api/registered-updates') return route.fulfill({contentType:'application/json',body:url.pathname.endsWith('updates')?'[]':'{}',headers:{'access-control-allow-origin':'*'}});
        blocked.push(url.origin + url.pathname); return route.abort();
      });
      const page = await context.newPage();
      page.on('response', response => {
        if(response.status()>=400) {
          const url=new URL(response.url());
          errors.push('HTTP '+response.status()+' '+url.origin+url.pathname);
        }
      });
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type()==='error') errors.push(message.text()); });
      await page.goto(ORIGIN+'/index.html');
      await page.waitForFunction(() => document.querySelector('[data-member-sync]')?.getAttribute('aria-busy')==='false');
      if(viewport.width===390) await page.locator('button[onclick="toggleMobileMenu()"]').click();
      await page.locator(viewport.width===390?'#adminLoginBtnMobile':'#adminLoginBtn').click();
      assert(await page.locator('#authScreen').isVisible());
      await page.locator('button[onclick="showPortal()"]').click();
      assert(await page.locator('#portalScreen').isVisible());
      assert.equal(await page.locator('[data-member-sync]').getAttribute('open'),null);
      assert.equal(await page.locator('[data-sync="status"]').textContent(),'未設定');
      assert.equal(await page.locator('#sec-history #sec-device-sync').count(),0);
      assert(await page.evaluate(()=>document.getElementById('sec-device-sync').compareDocumentPosition(document.getElementById('sec-history')) & Node.DOCUMENT_POSITION_FOLLOWING));
      await page.locator('[data-member-sync] summary').click();
      assert.equal(await page.locator('#historyDetails').evaluate(el=>el.open),false);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      const output=process.env.MEMBER_SYNC_ARTIFACT_DIR;
      if(output) {fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'device-sync-'+viewport.width+'.png'),fullPage:false});}

      return page;
    }
    const pc=await device({width:1440,height:1000}), phone=await device({width:390,height:844});
    let pcUid, phoneUid, profileId, adminUid;
    await t.test('explicit TOP pairing creates one shared profile without changing default Auth', async () => {
      assert.equal(await uid(pc),undefined); assert.equal(await uid(phone),undefined);
      adminUid = await pc.evaluate(async () => {
        const app=firebase.app();
        const result=await app.auth().createUserWithEmailAndPassword('release-'+Date.now()+'@example.test','local-test-only-password');
        return result.user.uid;
      });
      await pc.locator('[data-sync="start"]').click(); await waitStatus(pc);
      await pc.locator('[data-sync="add"]').click();
      await pc.locator('[data-sync="invite"]').waitFor({state:'visible'});
      const previousCode=await pc.locator('[data-sync="code"]').textContent();
      await pc.locator('[data-sync="copy"]').click();
      assert.equal(await pc.evaluate(()=>navigator.clipboard.readText()),previousCode);
      await pc.locator('[data-sync="add"]').click();
      await pc.waitForFunction(previous=>document.querySelector('[data-sync="code"]').textContent.length===14 && document.querySelector('[data-sync="code"]').textContent!==previous,previousCode);
      const code=await pc.locator('[data-sync="code"]').textContent();
      await phone.locator('[data-sync="join"]').click(); await phone.locator('[data-sync="input"]').fill(code);
      await phone.locator('[data-sync="join-form"] button').click();
      await phone.waitForFunction(()=>document.querySelector('[data-sync="status"]').textContent==='承認待ち');
      await phone.reload();
      await phone.waitForFunction(()=>document.querySelector('[data-sync="status"]').textContent==='承認待ち');
      await pc.getByRole('button',{name:'承認',exact:true}).click(); await waitStatus(phone);
      pcUid=await uid(pc); phoneUid=await uid(phone); assert.notEqual(pcUid,phoneUid);
      profileId=await pc.evaluate(async()=> (await firebase.app('member-sync').firestore().doc('memberIdentities/'+firebase.app('member-sync').auth().currentUser.uid).get()).data().profileId);
    });
    await t.test('calculator keeps bidirectional sync and links back to expanded TOP settings', async () => {
      for(const page of [pc,phone]) { await page.goto(SPEED); await waitStatus(page); }
      assert.equal(await pc.locator('[data-sync="start"]').count(),0);
      await pc.locator('.table-time-input[data-hell="200"]').fill('42');
      await phone.waitForFunction(()=>JSON.parse(localStorage.getItem('gbf_unf_speed_calc_times'))?.['200']===42);
      await phone.locator('.table-time-input[data-hell="200"]').fill('0');
      await pc.waitForFunction(()=>JSON.parse(localStorage.getItem('gbf_unf_speed_calc_times'))?.['200']===0);
      for(const [page,expected] of [[pc,pcUid],[phone,phoneUid]]) {
        await page.locator('a[href="../index.html#sec-device-sync"]').click();
        await waitStatus(page);
        assert.equal(await uid(page),expected);
        assert(await page.locator('#sec-device-sync details').evaluate(el=>el.open));
        await page.reload(); await waitStatus(page);
        assert.equal(await uid(page),expected);
      }
    });
    await t.test('same-browser portal restores identity and latest history sync with admin Auth intact', async () => {
      for (const [page,expected] of [[pc,pcUid],[phone,phoneUid]]) {
        await page.goto(ORIGIN+'/index.html');
        await waitStatus(page);
        await page.waitForFunction(profile => window.historyReadLocalState?.snapshot().profileId===profile,profileId);
        assert.equal(await uid(page),expected);
        assert.equal(await page.evaluate(()=>getLatestHistoryId()),HISTORY_ID);
        const ids=await page.locator('#historyTimeline > div').evaluateAll(items=>items.map(item=>item.querySelector('span.font-mono').textContent.trim()+'|'+item.querySelector('strong').textContent.trim()));
        assert.equal(ids.filter(id=>id===HISTORY_ID).length,1);
        assert.equal(ids[1],'2026/10/20|不具合・要望フォームを追加');
        assert((await page.locator('#historyTimeline > :first-child p').textContent()).includes('速度計算・更新履歴の既読状態・アーティファクト整理の設定を、PCとスマホで共有できるようになりました。'));
        assert.equal(await page.locator('#historyNewBadge').isVisible(),true);
      }
      await pc.waitForFunction(expected => firebase.auth().currentUser?.uid===expected,adminUid);
      await pc.locator('#sec-device-sync summary').click();
      await pc.locator('#historyDetails > summary').click();
      assert(await pc.locator('#sec-device-sync details').evaluate(el=>el.open));
      await phone.waitForFunction(()=>document.getElementById('historyNewBadge').classList.contains('hidden'));
      for(const page of [pc,phone]) {
        await page.waitForFunction(id=>window.historyReadLocalState.snapshot().seenIds.includes(id),HISTORY_ID);
        const saved=await page.evaluate(async profile=>(await firebase.app('member-sync').firestore().doc('memberProfiles/'+profile+'/settings/historyReadState').get({source:'server'})).data(),profileId);
        assert(saved.seenIds.includes(HISTORY_ID));
        assert(saved.seenIds.length<=256);
      }
      await phone.reload();
      await phone.waitForFunction(profile=>window.historyReadLocalState?.snapshot().profileId===profile,profileId);
      assert(await phone.evaluate(id=>historyReadLocalState.snapshot().seenIds.includes(id),HISTORY_ID));
      assert.equal(await phone.locator('#historyNewBadge').isVisible(),false);
    });
    await t.test('existing navigation and feedback anchor/card work at both widths', async () => {
      for (const page of [pc,phone]) {
        const mobile=page.viewportSize().width===390;
        for (const id of ['history','schedule','recruit','links','formations','feedback']) {
          if(mobile) await page.locator('button[onclick="toggleMobileMenu()"]').click();
          const link=page.locator((mobile?'#mobileMenu':'#sectionNav')+' a[href="#sec-'+id+'"]').first();
          await link.click();
          await page.waitForFunction(id=>location.hash==='#sec-'+id,id);
          assert.equal(new URL(page.url()).pathname,'/index.html');
        }
        await page.waitForFunction(()=>{const r=document.getElementById('sec-feedback').getBoundingClientRect();return r.top>=100&&r.bottom<=innerHeight;});
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        const output=process.env.MEMBER_SYNC_ARTIFACT_DIR;
        if(output) {fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'release-portal-'+(mobile?'mobile':'pc')+'.png')});}
        await page.locator('#sec-feedback a').click();
        await page.waitForURL(ORIGIN+'/feedback.html');
        assert(await page.locator('textarea').isVisible());
      }
    });
    await t.test('same speed identities restore both Artifact modes and synchronize in both directions', async () => {
      for(const [page,expected]of [[pc,pcUid],[phone,phoneUid]]) {
        await page.goto(ORIGIN+'/awakening-manager.html');
        await page.waitForFunction(profile=>typeof artifactSync!=='undefined'&&artifactSync?.snapshot()?.ownerProfileId===profile,profileId);
        await page.waitForFunction(async profile=>{
          const db=firebase.app('member-sync').firestore();
          const docs=await Promise.all(['awakeningGw','awakeningHigh'].map(name=>db.doc('memberProfiles/'+profile+'/settings/'+name).get({source:'server'})));
          return docs.every(doc=>doc.exists);
        },profileId);
        assert.equal(await uid(page),expected);
      }
      await pc.locator('#list-slot12 input[type=checkbox]').first().setChecked(true,{force:true});
      await phone.waitForFunction(()=>JSON.parse(localStorage.getItem('gbf_awakening_data_gw')||'{}').s12_0?.needed===true);
      await phone.locator('#mode-btn-high').click(); await phone.locator('#list-slot12 select').first().selectOption('1320');
      await pc.waitForFunction(()=>JSON.parse(localStorage.getItem('gbf_awakening_data_high')||'{}').s12_0?.selectedValue==='1320');
      await pc.reload();
      await pc.waitForFunction(expected=>globalThis.firebase?.apps.some(app=>app.name==='member-sync'&&app.auth().currentUser?.uid===expected),pcUid);
      await pc.waitForFunction(profile=>typeof artifactSync!=='undefined'&&artifactSync?.snapshot()?.ownerProfileId===profile,profileId);
      assert.equal(await uid(pc),pcUid);
      for(const page of [pc,phone]) assert(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<= (page===phone?78:0));
      await pc.goto(ORIGIN+'/index.html');
      await pc.waitForFunction(expected=>firebase.auth().currentUser?.uid===expected,adminUid);
    });
    await t.test('release assets use expected cache identifiers; no unexpected errors or external traffic', async () => {
      const assets=requests.filter(url=>/\/(member-sync\.(js|css)|artifact-(catalog|sync)\.js)$/.test(url.pathname));
      for(const file of ['member-sync.js','member-sync.css','artifact-catalog.js','artifact-sync.js']) assert(assets.some(url=>url.pathname.endsWith('/'+file)));
      for(const url of assets) assert(['member-sync-rc1','member-sync-ui2'].includes(url.searchParams.get('v')));
      assert.equal(requests.filter(url=>url.pathname.endsWith('/accounts:signUp')).length,3,
        'only two paired identities and one explicit default-admin fixture account are created');
      assert.deepEqual(blocked,[]); assert.deepEqual(errors,[]);
    });
  } finally {
    if(browser) await browser.close();
    if(server.exitCode===null) {server.kill();await once(server,'exit');}
  }
});
