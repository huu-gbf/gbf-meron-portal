/* Local browser regression for the main integration. Requires Firestore at
 * 127.0.0.1:8080; uses only the demo project and the existing browser fixture.
 * NODE_PATH may point to the bundled Playwright runtime.
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {chromium} = require('playwright');
const {initializeTestEnvironment} = require('@firebase/rules-unit-testing');
const ORIGIN = 'http://127.0.0.1:18764';
const URL = ORIGIN + '/tools/gw-battle-review.html';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('portal excludes admin visits while retaining ordinary member tracking', () => {
  const html = fs.readFileSync('index.html','utf8');
  const begin = html.indexOf('function showPortal()');
  const end = html.indexOf('function showAuth()',begin);
  assert(begin > 0 && end > begin);
  let visits = 0, stored = 'admin-fixture';
  const context = {
    document:{getElementById:() => ({classList:{add(){},remove(){}},hidden:false})},
    window:{isAdmin:true},initNavObserver(){},initNavAccordionSync(){},
    localStorage:{getItem:() => stored},STORAGE_KEY:'fixture',ADMIN_HASH:'admin-fixture',
    recordVisit:() => visits++
  };
  require('node:vm').runInNewContext(html.slice(begin,end)+';showPortal();',context);
  assert.equal(visits,0);
  stored = 'member-fixture'; context.window.isAdmin = false;
  context.showPortal(); assert.equal(visits,1);
});

test('integrated battle page: dates, local deletion, sharing and viewer controls', {timeout:120000}, async t => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080');
  const env = await initializeTestEnvironment({projectId:'demo-gbf-meron-portal-rules',
    firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore.rules','utf8')}});
  await env.clearFirestore();
  const server = spawn(process.execPath, ['tests/gw-battle-browser.cjs'], {windowsHide:true,stdio:'pipe'});
  let browser;
  const errors = [], blocked = [];
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'block6b-battle-'));
  try {
    for (let i=0; i<100; i++) {
      try { if ((await fetch(URL)).ok) break; } catch {}
      if (server.exitCode !== null) throw Error('Battle fixture exited');
      await pause(100);
    }
    browser = await chromium.launch({channel:'msedge',headless:true});
    async function device(viewport) {
      const context = await browser.newContext({viewport});
      await context.route('**/*', route => {
        const url = new globalThis.URL(route.request().url());
        if (['127.0.0.1','localhost'].includes(url.hostname)) return route.continue();
        // Fonts are decorative; no external network request is allowed.
        if (url.hostname.startsWith('fonts.')) return route.fulfill({status:200,body:''});
        blocked.push(url.origin); return route.abort();
      });
      const page = await context.newPage();
      // Keep the recording check independent of the time this suite is run.
      await page.clock.setFixedTime(new Date('2026-09-29T14:59:00Z'));
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept(dialog.type()==='prompt' ? '全データ削除' : undefined));
      await page.goto(URL);
      await synced(page);
      return page;
    }
    async function synced(page) {
      await page.waitForFunction(() => document.querySelector('#battle-sync-status').textContent.includes('同期済み'));
      await page.waitForFunction(() => {
        const journal = JSON.parse(localStorage.getItem('gw_review_sync_v1'));
        return journal && journal.queue.length===0;
      });
    }
    async function day(page, value) {
      await page.locator('label').filter({has:page.locator('input[name="gw-day"][value="'+value+'"]')}).click();
      await synced(page);
    }
    async function cloud(page, session) {
      return page.evaluate(async session => {
        const docs = await firebase.app('yosen-shared').firestore().collection('gwBattleReviews/'+session+'/entries').get();
        return docs.docs.map(doc => ({id:doc.id,...doc.data()}));
      }, session);
    }
    const pc = await device({width:1440,height:1000});
    let chosenDate, day4Session, beforeDelete;
    await t.test('latest title and admin controls are visible; empty session does not pin a date', async () => {
      assert.equal(await pc.title(), '古戦場 戦況分析ツール');
      assert.equal(await pc.locator('#btn-record').isEnabled(), true);
      assert.equal(await pc.locator('#battle-connect').isVisible(), true);
      assert.equal(await pc.locator('input[name="gw-day"]:checked').inputValue(), 'day4');
      assert.deepEqual(await pc.evaluate(() => JSON.parse(localStorage.getItem('gw_review_conditions')).dayDates), {});
    });
    await t.test('selected date links adjacent battle days and survives reload', async () => {
      chosenDate = '2026-09-24';
      await pc.locator('#battle-date').fill(chosenDate);
      await pc.locator('#battle-date').dispatchEvent('change');
      await pc.locator('#battle-connect').click(); await synced(pc);
      await day(pc, 'day3');
      assert.equal(await pc.locator('#battle-date').inputValue(), '2026-09-23');
      await day(pc, 'day4');
      assert.equal(await pc.locator('#battle-date').inputValue(), chosenDate);
      await pc.reload(); await synced(pc);
      assert.equal(await pc.locator('#battle-date').inputValue(), chosenDate);
      day4Session = chosenDate + '_day4';
    });
    await t.test('recording reaches the selected cloud session and the mobile page', async () => {
      await pc.locator('#snap-time').fill('08:00');
      await pc.locator('#snap-own').fill('10億');
      await pc.locator('#snap-enemy').fill('9億');
      await pc.locator('#btn-record').click(); await synced(pc);
      beforeDelete = await cloud(pc, day4Session);
      assert(beforeDelete.some(row => row.id==='0800' && row.own===1000000000),
        await pc.locator('#snap-error').textContent());
      await pc.screenshot({path:path.join(output,'desktop-record.png'),fullPage:true});
    });
    const phone = await device({width:390,height:844});
    await t.test('mobile selects the shared date and reads the existing record', async () => {
      await phone.locator('#battle-date').fill(chosenDate);
      await phone.locator('#battle-date').dispatchEvent('change');
      await phone.locator('#battle-connect').click(); await synced(phone);
      await phone.waitForFunction(() => document.querySelector('#history-list').textContent.includes('08:00'));
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await phone.screenshot({path:path.join(output,'mobile-record.png'),fullPage:true});
    });
    await t.test('day deletion changes only this device and retains other days and cloud records', async () => {
      await pc.evaluate(() => {
        const store = JSON.parse(localStorage.getItem('gw_review_snapshots'));
        store.day1=[{id:123,time:'09:00',own:1,enemy:2}];
        localStorage.setItem('gw_review_snapshots',JSON.stringify(store));
      });
      await pc.locator('#btn-clear-day').click();
      const store = await pc.evaluate(() => JSON.parse(localStorage.getItem('gw_review_snapshots')));
      assert.deepEqual(store.day4, []); assert.equal(store.day1.length, 1);
      assert.deepEqual(await cloud(pc,day4Session), beforeDelete);
      assert.match(await phone.locator('#history-list').textContent(), /08:00/);
      assert.equal(await pc.evaluate(() => JSON.parse(localStorage.getItem('gw_review_sync_v1')).queue.length), 0);
    });
    await t.test('all-days deletion preserves date mapping and does not delete shared data', async () => {
      await pc.locator('#btn-clear-all').click();
      assert.equal(await pc.evaluate(() => localStorage.getItem('gw_review_snapshots')), null);
      assert.equal(await pc.evaluate(() => JSON.parse(localStorage.getItem('gw_review_conditions')).dayDates.day4), chosenDate);
      assert.deepEqual(await cloud(pc,day4Session), beforeDelete);
      assert.equal(await pc.evaluate(() => JSON.parse(localStorage.getItem('gw_review_sync_v1')).queue.length), 0);
    });
    await t.test('signed-out viewer retains shared reading but loses editing and deletion controls', async () => {
      await phone.locator('#battle-sign-out').click();
      await phone.waitForFunction(() => document.querySelector('#btn-record').disabled);
      assert.equal(await phone.locator('#btn-clear-day').isDisabled(), true);
      assert.equal(await phone.locator('#btn-clear-all').isDisabled(), true);
      assert.equal(await phone.locator('#battle-connect').isHidden(), true);
      assert.match(await phone.locator('#history-list').textContent(), /08:00/);
      assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
    });
    console.log('Battle browser artifacts: '+output);
  } finally {
    if (browser) await browser.close();
    if (server.exitCode===null) {server.kill();await once(server,'exit');}
    await env.cleanup();
  }
});
