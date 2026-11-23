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
    document:{getElementById:() => ({classList:{add(){},remove(){},toggle(){}},hidden:false})},
    window:{isAdmin:true},initNavObserver(){},initNavAccordionSync(){},initHistoryUnread(){},
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
    async function setDate(page, date) {
      await page.locator('#battle-date').evaluate((el, value) => {
        el.value = value;
        el.dispatchEvent(new Event('change', {bubbles:true}));
      }, date);
    }
    async function assertLocked(page) {
      for (const selector of ['#btn-predict', '#btn-record', 'input[name="day-type"]:checked']) {
        assert.equal(await page.locator(selector).isDisabled(), true, selector);
      }
      await page.evaluate(() => {
        for (const id of ['btn-predict','btn-record']) {
          document.getElementById(id).dispatchEvent(new MouseEvent('click', {bubbles:true}));
        }
        document.querySelector('.snapshot-edit-form:not(.result-hidden) .btn-primary')
          ?.dispatchEvent(new MouseEvent('click', {bubbles:true}));
        const other = document.querySelector('input[name="day-type"]:not(:checked)');
        other.checked = true;
        other.dispatchEvent(new Event('change', {bubbles:true}));
      });
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
    const newDate = '2099-01-05';
    const newSession = newDate + '_day1';
    let original;
    await t.test('day 4 to a new day 1 locks writes, archives old drafts, and restores day 4 on return', async () => {
      await pc.locator('#battle-connect').click(); await synced(pc);
      for (const [id,value] of Object.entries({'enemy-contrib12':'100億','enemy-speed':'20億','own-contrib12':'120億','own-speed':'24億'})) {
        await pc.locator('#'+id).fill(value);
      }
      await pc.locator('#btn-predict').click(); await synced(pc);
      original = await cloud(pc, day4Session);
      assert.equal(original.find(row => row.id==='meta').base.enemyContrib12, 10000000000);
      await pc.locator('#enemy-contrib12').fill('999億');
      await pc.locator('#snap-own').fill('888億');
      await pc.locator('.snapshot-actions button').first().click();
      await pc.evaluate(() => firebase.app('yosen-shared').firestore().disableNetwork());
      await pc.locator('label').filter({has:pc.locator('input[name="gw-day"][value="day1"]')}).click();
      await setDate(pc, newDate);
      await pc.locator('#battle-connect').click();
      await assertLocked(pc);
      assert.equal(await pc.locator('.snapshot-edit-form:not(.result-hidden) button').first().isDisabled(), true);
      assert.equal(await pc.locator('#enemy-contrib12').inputValue(), '999億');
      assert.deepEqual(await cloud(phone, newSession), []);
      await pc.evaluate(() => firebase.app('yosen-shared').firestore().enableNetwork());
      await synced(pc);
      assert.match(await pc.locator('#battle-sync-status').textContent(), new RegExp(newSession));
      for (const id of ['enemy-contrib12','enemy-speed','own-contrib12','own-speed','snap-own','snap-enemy']) {
        assert.equal(await pc.locator('#'+id).inputValue(), '', id);
      }
      assert.match(await pc.locator('#history-list').textContent(), /記録がありません/);
      const next = await cloud(pc, newSession);
      assert.deepEqual(next.map(row => row.id), ['meta']);
      assert.equal(next[0].base, null);
      assert.equal(await pc.evaluate(session => Object.keys(localStorage).filter(k => k.startsWith('gw_review_backup_v1_'))
        .map(k => JSON.parse(localStorage.getItem(k))).some(b => b.session===session && b.drafts['enemy-contrib12']==='999億'
          && b.drafts['snap-own']==='888億' && b.snapshots.some(s => s.time==='08:00')), day4Session), true);
      await pc.reload(); await synced(pc);
      assert.equal(await pc.locator('#battle-date').inputValue(), newDate);
      assert.equal(await pc.locator('#enemy-contrib12').inputValue(), '');
      await day(pc, 'day4');
      assert.equal(await pc.locator('#battle-date').inputValue(), chosenDate);
      assert.match(await pc.locator('#history-list').textContent(), /08:00/);
      assert.equal(await pc.locator('#enemy-contrib12').inputValue(), '10000000000');
      assert.deepEqual(await cloud(pc, day4Session), original);
    });
    await t.test('same-day draft cannot leak on repeated target changes during a connection failure', async () => {
      await pc.locator('#enemy-speed').fill('999億');
      await pc.evaluate(() => firebase.app('yosen-shared').firestore().disableNetwork());
      await setDate(pc, '2099-01-09');
      await pc.locator('#battle-connect').click();
      await assertLocked(pc);
      await setDate(pc, '2099-01-10');
      await pc.locator('#battle-connect').click();
      await assertLocked(pc);
      await pc.evaluate(() => firebase.app('yosen-shared').firestore().enableNetwork());
      await synced(pc);
      assert.match(await pc.locator('#battle-sync-status').textContent(), /2099-01-10_day4/);
      assert.equal(await pc.locator('#enemy-speed').inputValue(), '');
      assert.deepEqual(await cloud(pc, '2099-01-09_day4'), []);
      assert.equal((await cloud(pc, '2099-01-10_day4'))[0].base, null);
      assert.deepEqual(await cloud(pc, day4Session), original);
      await setDate(pc, chosenDate);
      await pc.locator('#battle-connect').click(); await synced(pc);
    });
    await t.test('metadata for a different session keeps editing locked until retry succeeds', async () => {
      const date = '2099-01-12';
      const path = `gwBattleReviews/${date}_day4/entries/meta`;
      const metadata = {schemaVersion:1, dateJst:'2099-01-13', dayKey:'day4', dayType:'weekday', base:null};
      await env.withSecurityRulesDisabled(context => context.firestore().doc(path).set(metadata));
      await setDate(pc, date);
      await pc.locator('#battle-connect').click();
      await pc.waitForFunction(() => document.querySelector('#battle-sync-status').textContent.includes('基準データの形式が不正'));
      await assertLocked(pc);
      assert.equal(await pc.locator('#enemy-contrib12').inputValue(), '10000000000');
      assert.deepEqual(await cloud(pc, day4Session), original);
      await env.withSecurityRulesDisabled(context => context.firestore().doc(path).set({...metadata,dateJst:date}));
      await pc.locator('#battle-connect').click(); await synced(pc);
      assert.equal(await pc.locator('#enemy-contrib12').inputValue(), '');
      await setDate(pc, chosenDate);
      await pc.locator('#battle-connect').click(); await synced(pc);
    });
    await t.test('failed send preserves the original queue and an older cache can return to it after reload', async () => {
      await pc.evaluate(() => {
        firebase.app('yosen-shared').firestore().runTransaction = async () => { throw Error('test connection failure'); };
      });
      await pc.locator('#snap-time').fill('09:00');
      await pc.locator('#snap-own').fill('20億');
      await pc.locator('#snap-enemy').fill('19億');
      await pc.locator('#btn-record').click();
      await pc.waitForFunction(() => document.querySelector('#battle-sync-status').textContent.includes('test connection failure'));
      await assertLocked(pc);
      await setDate(pc, '2099-01-11');
      await pc.locator('label').filter({has:pc.locator('input[name="gw-day"][value="day1"]')}).click();
      assert.equal(await pc.locator('#battle-date').inputValue(), chosenDate);
      assert.equal(await pc.locator('input[name="gw-day"]:checked').inputValue(), 'day4');
      const journal = await pc.evaluate(() => JSON.parse(localStorage.getItem('gw_review_sync_v1')));
      assert.equal(journal.session, day4Session);
      assert.equal(journal.queue.length, 1);
      assert.deepEqual(await cloud(phone, day4Session), original);
      // Older pages could save a new date while the queue still targeted the original date.
      await pc.evaluate(() => {
        const key = 'gw_review_conditions';
        const conditions = JSON.parse(localStorage.getItem(key));
        conditions.dayDates.day4 = '2099-01-11';
        localStorage.setItem(key, JSON.stringify(conditions));
      });
      await pc.reload();
      await pc.waitForFunction(() => document.querySelector('#battle-sync-status').textContent.includes('元の共有先'));
      await assertLocked(pc);
      assert.equal(await pc.locator('#battle-date').inputValue(), '2099-01-11');
      await setDate(pc, chosenDate);
      await pc.locator('#battle-connect').click(); await synced(pc);
      assert.equal((await cloud(pc, day4Session)).filter(row => row.id==='0900').length, 1);
      assert.deepEqual(await cloud(pc, '2099-01-11_day4'), []);
      assert.deepEqual((await cloud(pc, newSession)).map(row => row.id), ['meta']);
    });
    await t.test('day 1 prediction, recording, and graph match the existing model after switching', async () => {
      await day(pc, 'day1');
      assert.equal(await pc.locator('#battle-date').inputValue(), newDate);
      for (const [id,value] of Object.entries({'enemy-contrib12':'100億','enemy-speed':'20億','own-contrib12':'120億','own-speed':'24億'})) {
        await pc.locator('#'+id).fill(value);
      }
      await pc.locator('label').filter({has:pc.locator('input[name="day-type"][value="weekday"]')}).click();
      await pc.locator('#btn-predict').click(); await synced(pc);
      assert.match(await pc.locator('#pred-std-enemy').textContent(), /386\.0億/);
      assert.match(await pc.locator('#pred-caut-enemy').textContent(), /405\.0億/);
      assert.match(await pc.locator('#reference-range-value').textContent(), /374\.1億.*412\.7億/);
      assert.match(await pc.locator('#pred-std-own').textContent(), /463\.2億/);
      assert.match(await pc.locator('#pred-caut-own').textContent(), /486\.0億/);
      await pc.locator('#snap-time').fill('13:00');
      await pc.locator('#snap-own').fill('140億');
      await pc.locator('#snap-enemy').fill('130億');
      await pc.locator('#btn-record').click(); await synced(pc);
      assert.match(await pc.locator('#history-list').textContent(), /13:00/);
      assert.match(await pc.locator('#lead-indicator').textContent(), /自団が 10\.0億 リード/);
      assert.equal(await pc.locator('#chart-area svg polyline').count(), 2);
      assert.equal(await pc.locator('#chart-area svg line[stroke-dasharray]').count() >= 2, true);
      assert.deepEqual((await cloud(pc, newSession)).map(row => row.id).sort(), ['1300','meta']);
      assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
    });
    await t.test('5000万/h survives save, reload and a second save; invalid drafts hide predictions', async () => {
      await pc.locator('#enemy-speed').fill('5000万/h');
      await pc.locator('#btn-predict').click(); await synced(pc);
      const base = async () => (await cloud(pc,newSession)).find(row => row.id === 'meta').base;
      assert.equal((await base()).enemySpeed, 50000000);
      assert.equal(await pc.locator('#pred-std-enemy').textContent(), '107.2億');
      await pc.reload(); await synced(pc);
      assert.equal(await pc.locator('#enemy-speed').inputValue(), '5000');
      assert.equal(await pc.locator('#pred-std-enemy').textContent(), '107.2億');
      await pc.locator('#enemy-contrib12').fill('101億');
      await pc.locator('#btn-predict').click(); await synced(pc);
      assert.equal((await base()).enemyContrib12, 101e8);
      assert.equal((await base()).enemySpeed, 50000000);
      await pc.locator('#enemy-speed').fill('Infinity');
      await pc.locator('label').filter({has:pc.locator('input[name="day-type"][value="weekend"]')}).click();
      assert.equal(await pc.locator('#sec-results').isHidden(), true);
      assert.equal(await pc.evaluate(() => collectChartData().predStd), null);
      await pc.locator('#enemy-speed').fill('5000');
      assert.equal(await pc.locator('#pred-std-enemy').textContent(), '108.8億');
      assert.equal(await pc.evaluate(() => collectChartData().predStd), 10880000000);
      await pc.locator('#btn-predict').click(); await synced(pc);
      assert.equal((await base()).enemySpeed, 50000000);
    });
    await t.test('editing a record preserves exact points including an unchanged save', async () => {
      const edit = pc.locator('#history-list .snapshot-actions button').first();
      const form = pc.locator('.snapshot-edit-form:not(.result-hidden)');
      for (const amount of ['12345678901', null, '12345678902']) {
        await edit.click();
        const field = form.locator('[id^="edit-enemy-"]');
        if (amount === null) assert.equal(await field.inputValue(), '12345678901');
        else await field.fill(amount);
        await form.locator('.btn-primary').click(); await synced(pc);
        const row = (await cloud(pc,newSession)).find(row => row.id === '1300');
        assert.equal(row.enemy, Number(amount ?? '12345678901'));
      }
    });
    await t.test('observations share a sorted time axis and comparable speed interval', async () => {
      const result = await pc.evaluate(() => {
        const point = (time,own,enemy) => ({time,own:own == null ? null : own*1e8,enemy:enemy*1e8});
        state.snapshots = [point('07:00',0,0),point('12:00',121,101),point('13:00',141,131)];
        updateAnalysis();
        const values = () => ['ana-own-speed','ana-enemy-speed','ana-speed-diff'].map(id => document.getElementById(id).textContent);
        const all = values(), points = collectChartData().enemy;
        state.snapshots.splice(2,0,point('12:30',null,115));
        updateAnalysis(); const partial = values();
        state.snapshots.push(point('14:00',null,140)); updateAnalysis();
        return {all,points,partial,last:values(),hidden:document.getElementById('overtake-block').classList.contains('result-hidden')};
      });
      assert.deepEqual(result.points.map(p => p.min), [420,720,780]);
      assert.equal(result.points[1].val, 101e8);
      assert.deepEqual(result.all.slice(0,2), ['20.00億/h','30.00億/h']);
      assert.deepEqual(result.partial, result.all);
      assert.equal(result.last[2], '—'); assert.equal(result.hidden, true);
    });
    await t.test('graph renders adjacent safe integers at the storage limit', async () => {
      const rendered = await pc.evaluate(() => {
        state.predictDone = false;
        state.enemyContrib12 = state.ownContrib12 = null;
        state.snapshots = [{time:'13:00',own:null,enemy:Number.MAX_SAFE_INTEGER - 1},
          {time:'14:00',own:null,enemy:Number.MAX_SAFE_INTEGER}];
        drawChart();
        return document.querySelector('#chart-area polyline')?.getAttribute('points');
      });
      assert.match(rendered, /^[-.\d]+,[-.\d]+ [-.\d]+,[-.\d]+$/);
    });
    console.log('Battle browser artifacts: '+output);
  } finally {
    if (browser) await browser.close();
    if (server.exitCode===null) {server.kill();await once(server,'exit');}
    await env.cleanup();
  }
});
