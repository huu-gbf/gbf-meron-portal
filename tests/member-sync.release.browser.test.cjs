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
      const context = await browser.newContext({viewport,serviceWorkers:'block'});
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
      await page.goto(SPEED);
      await page.waitForFunction(() => document.querySelector('[data-member-sync]')?.getAttribute('aria-busy')==='false');
      await page.locator('[data-member-sync] summary').click();
      return page;
    }
    const pc=await device({width:1440,height:1000}), phone=await device({width:390,height:844});
    let pcUid, phoneUid, profileId, adminUid;
    await t.test('explicit speed pairing creates one shared profile without changing default Auth', async () => {
      assert.equal(await uid(pc),undefined); assert.equal(await uid(phone),undefined);
      adminUid = await pc.evaluate(async () => {
        const app=firebase.initializeApp(MEMBER_SYNC_LOCAL.firebaseConfig);
        app.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
        const result=await app.auth().createUserWithEmailAndPassword('release-'+Date.now()+'@example.test','local-test-only-password');
        return result.user.uid;
      });
      await pc.locator('[data-sync="start"]').click(); await waitStatus(pc);
      await pc.locator('[data-sync="add"]').click();
      await pc.locator('[data-sync="invite"]').waitFor({state:'visible'});
      const code=await pc.locator('[data-sync="code"]').textContent();
      await phone.locator('[data-sync="join"]').click(); await phone.locator('[data-sync="input"]').fill(code);
      await phone.locator('[data-sync="join-form"] button').click();
      await pc.getByRole('button',{name:'承認',exact:true}).click(); await waitStatus(phone);
      pcUid=await uid(pc); phoneUid=await uid(phone); assert.notEqual(pcUid,phoneUid);
      profileId=await pc.evaluate(async()=> (await firebase.app('member-sync').firestore().doc('memberIdentities/'+firebase.app('member-sync').auth().currentUser.uid).get()).data().profileId);
    });
    await t.test('same-browser portal restores identity and latest history sync with admin Auth intact', async () => {
      for (const [page,expected] of [[pc,pcUid],[phone,phoneUid]]) {
        await page.goto(ORIGIN+'/index.html');
        await page.waitForFunction(profile => window.historyReadLocalState?.snapshot().profileId===profile,profileId);
        assert.equal(await uid(page),expected);
        assert.equal((await page.locator('#historyTimeline > :first-child p').textContent()).trim(),'不具合・要望フォームを追加しました。');
        assert.equal(await page.locator('#historyNewBadge').isVisible(),true);
      }
      await pc.waitForFunction(expected => firebase.auth().currentUser?.uid===expected,adminUid);
      await pc.locator('#historyDetails > summary').click();
      await phone.waitForFunction(()=>document.getElementById('historyNewBadge').classList.contains('hidden'));
      await phone.reload();
      await phone.waitForFunction(profile=>window.historyReadLocalState?.snapshot().profileId===profile,profileId);
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
    await t.test('release assets use one cache identifier; no unexpected errors or external traffic', async () => {
      const assets=requests.filter(url=>/\/(member-sync\.(js|css)|artifact-(catalog|sync)\.js)$/.test(url.pathname));
      for(const file of ['member-sync.js','member-sync.css','artifact-catalog.js','artifact-sync.js']) assert(assets.some(url=>url.pathname.endsWith('/'+file)));
      for(const url of assets) assert.equal(url.searchParams.get('v'),'member-sync-rc1');
      assert.equal(requests.filter(url=>url.pathname.endsWith('/accounts:signUp')).length,3,
        'only two paired identities and one explicit default-admin fixture account are created');
      assert.deepEqual(blocked,[]); assert.deepEqual(errors,[]);
    });
  } finally {
    if(browser) await browser.close();
    if(server.exitCode===null) {server.kill();await once(server,'exit');}
  }
});
