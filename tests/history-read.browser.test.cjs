/* Run with the bundled Playwright NODE_PATH. This suite intercepts every URL and
 * uses an in-memory Firebase compat transport; it needs no running service. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {createHistoryFixture,ORIGIN,V1,V2,PENDING,RECORD_PREFIX} = require('./history-read-browser.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const member = (uid,profileId='history-shared') => ({uid,profileId,deviceId:'device-'+uid});
const latest = page => page.evaluate(() => getLatestHistoryId());
const stored = (page,key) => page.evaluate(key => localStorage.getItem(key),key);
const array = async (page,key) => JSON.parse(await stored(page,key) || '[]');
const newBadge = page => page.evaluate(() => !document.getElementById('historyNewBadge').classList.contains('hidden'));
async function until(predicate,message='History browser state did not converge') {
  for (let i=0;i<200;i++) { if (await predicate()) return; await pause(25); }
  throw Error(message);
}
async function waitSeen(page,id) {
  await page.waitForFunction(({key,id}) => JSON.parse(localStorage.getItem(key)||'[]').includes(id),{key:V2,id});
}
async function openHistory(page) {
  await page.locator('#historyDetails > summary').click();
  await page.waitForFunction(() => document.getElementById('historyDetails').open);
}
async function changeLatest(page,title) {
  return page.evaluate(title => {
    document.querySelector('#historyTimeline > :first-child strong').textContent = title;
    updateHistoryNewBadge();
    return getLatestHistoryId();
  },title);
}

test('history local-first UI, isolated two-device transport, reload/offline and desktop/mobile', {timeout:180000}, async t => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  const fixture = createHistoryFixture(browser);
  let pc,phone,currentId;
  try {
    await t.test('PC and mobile show current NEW locally before connecting cloud',async () => {
      pc = await fixture.device('pc',{identity:member('pc'),viewport:{width:1440,height:1000}});
      phone = await fixture.device('phone',{identity:member('phone'),viewport:{width:390,height:844}});
      currentId = await latest(pc.page);
      assert(currentId.length > 0); assert.equal(await latest(phone.page),currentId);
      assert.equal(await newBadge(pc.page),true); assert.equal(await newBadge(phone.page),true);
      await until(() => fixture.cloud('history-shared'));
      await until(async () => (await phone.page.evaluate(() => __historyFixture.listeners.size)) >= 5);
      assert.equal(await pc.page.evaluate(() => __historyFixture.authCreates),0);
      assert.equal(await phone.page.evaluate(() => __historyFixture.authCreates),0);
      for (const entry of [pc,phone]) {
        assert.equal(await entry.page.evaluate(() => firebase.app().auth().currentUser),null);
        assert.deepEqual(await entry.page.evaluate(() => firebase.apps.map(app => app.name).sort()),['[DEFAULT]','member-sync']);
      }
    });

    await t.test('PC details open marks local immediately and ACK removes only acknowledged pending',async () => {
      await pc.page.evaluate(({v1,v2,pending}) => {
        markHistorySeen();
        const id=getLatestHistoryId();
        globalThis.__historyImmediate={id,seen:JSON.parse(localStorage.getItem(v2)||'[]'),
          pending:JSON.parse(localStorage.getItem(pending)||'[]'),v1:localStorage.getItem(v1),
          hidden:document.getElementById('historyNewBadge').classList.contains('hidden')};
      },{v1:V1,v2:V2,pending:PENDING});
      const immediate = await pc.page.evaluate(() => __historyImmediate);
      assert(immediate.seen.includes(currentId)); assert(immediate.pending.includes(currentId));
      assert.equal(immediate.v1,currentId); assert.equal(immediate.hidden,true);
      await openHistory(pc.page);
      await until(() => fixture.cloud('history-shared')?.seenIds.includes(currentId));
      await until(async () => !(await array(pc.page,PENDING)).includes(currentId));
      const transaction = fixture.writes.find(write => write.device === 'pc' && JSON.stringify(write.data).includes(currentId));
      assert(transaction); assert(JSON.parse(transaction.pending).includes(currentId),'pending existed before cloud commit');
    });

    await t.test('PC to mobile remote snapshot clears NEW and updates rollback compatibility without write loop',async () => {
      await waitSeen(phone.page,currentId);
      assert.equal(await newBadge(phone.page),false); assert.equal(await stored(phone.page,V1),currentId);
      const revision = fixture.cloud('history-shared').revision;
      await pause(150);
      assert.equal(fixture.cloud('history-shared').revision,revision);
      assert.equal(fixture.writes.filter(write => write.device === 'phone').length,0);
    });

    await t.test('mobile details read reaches PC in the reverse direction',async () => {
      const next = await changeLatest(pc.page,'ブラウザ試験・逆方向の更新');
      assert.equal(await changeLatest(phone.page,'ブラウザ試験・逆方向の更新'),next);
      assert.equal(await newBadge(pc.page),true); assert.equal(await newBadge(phone.page),true);
      await openHistory(phone.page);
      await until(() => fixture.cloud('history-shared').seenIds.includes(next));
      await waitSeen(pc.page,next); assert.equal(await newBadge(pc.page),false);
      assert.equal(await stored(pc.page,V1),next);
    });

    await t.test('reload preserves current original history read state on both devices',async () => {
      await pc.page.reload(); await phone.page.reload();
      await waitSeen(pc.page,currentId); await waitSeen(phone.page,currentId);
      assert.equal(await newBadge(pc.page),false); assert.equal(await newBadge(phone.page),false);
      assert.equal(await pc.page.evaluate(() => __historyFixture.authCreates),0);
      assert.equal(await phone.page.evaluate(() => __historyFixture.authCreates),0);
    });

    await t.test('local A plus cloud B converges to union and retains unacknowledged local IDs',async () => {
      fixture.seed('union-profile',['cloud-B']);
      const device = await fixture.device('union',{identity:member('union','union-profile'),seed:{[V2]:'["local-A"]'}});
      await until(() => fixture.cloud('union-profile')?.seenIds.includes('local-A'));
      assert.deepEqual(new Set(fixture.cloud('union-profile').seenIds),new Set(['local-A','cloud-B']));
      assert.deepEqual(new Set(await array(device.page,V2)),new Set(['local-A','cloud-B']));
      const before = fixture.writes.length; await fixture.remote('union-profile',['cloud-B','local-A','remote-C']);
      await waitSeen(device.page,'remote-C'); await pause(100);
      assert.equal(fixture.writes.length,before,'remote-derived ID must not be replayed');
    });

    await t.test('offline read is immediate, survives reload, and online replays once',async () => {
      const entry = await fixture.device('offline',{identity:member('offline','offline-profile')});
      await until(() => fixture.cloud('offline-profile'));
      await entry.context.setOffline(true);
      const id = await changeLatest(entry.page,'ブラウザ試験・オフライン');
      await entry.page.evaluate(() => markHistorySeen());
      assert.equal(await newBadge(entry.page),false); assert((await array(entry.page,PENDING)).includes(id));
      assert(!fixture.cloud('offline-profile').seenIds.includes(id));
      await entry.context.setOffline(false);
      await entry.page.evaluate(() => dispatchEvent(new Event('online')));
      await until(() => fixture.cloud('offline-profile').seenIds.includes(id));
      await until(async () => !(await array(entry.page,PENDING)).includes(id));
      await entry.page.reload(); await waitSeen(entry.page,id);
      assert.equal(fixture.cloud('offline-profile').seenIds.filter(value => value === id).length,1);
    });

    await t.test('in-flight A plus B plus pagehide preserves B and reload replays the remaining set',async () => {
      const entry = await fixture.device('inflight',{identity:member('inflight','inflight-profile')});
      await until(() => fixture.cloud('inflight-profile'));
      const held = fixture.holdNextWrite();
      const a = await changeLatest(entry.page,'ブラウザ試験・送信中A');
      await entry.page.evaluate(() => markHistorySeen()); await held.entered;
      const b = await changeLatest(entry.page,'ブラウザ試験・送信中B');
      await entry.page.evaluate(() => { markHistorySeen(); dispatchEvent(new PageTransitionEvent('pagehide')); });
      const pending = await array(entry.page,PENDING);
      assert(pending.includes(a)); assert(pending.includes(b));
      held.release(); await until(() => fixture.cloud('inflight-profile').seenIds.includes(a));
      await pause(50);
      assert((await array(entry.page,PENDING)).includes(b),'late completion of A must retain B until resume');
      assert(!fixture.cloud('inflight-profile').seenIds.includes(b),'a queued pre-pagehide callback must not resume transport');
      await entry.page.reload();
      await until(() => fixture.cloud('inflight-profile').seenIds.includes(b));
      await until(async () => (await array(entry.page,PENDING)).length === 0);
      assert((await array(entry.page,V2)).includes(a)); assert((await array(entry.page,V2)).includes(b));
    });

    await t.test('unconfigured user keeps local behavior, storage events update a second tab, and no Auth is created',async () => {
      const entry = await fixture.device('local-only');
      const tab = await entry.context.newPage(); await tab.goto(ORIGIN+'/index.html');
      await tab.waitForFunction(() => typeof initHistoryUnread === 'function');
      assert.equal(await newBadge(tab),true);
      const reads = fixture.reads.filter(read => read.device === 'local-only' && read.path.startsWith('member'));
      assert.equal(reads.length,0);
      await openHistory(entry.page); await waitSeen(tab,currentId);
      await until(async () => !(await newBadge(tab)));
      await entry.page.reload(); assert.equal(await newBadge(entry.page),false);
      assert.equal(await entry.page.evaluate(() => __historyFixture.authCreates),0);
      assert.equal(await tab.evaluate(() => __historyFixture.authCreates),0);
      assert.equal(fixture.writes.filter(write => write.device === 'local-only').length,0);
    });

    await t.test('legacy v1 migrates once and keeps the raw rollback string',async () => {
      const entry = await fixture.device('migration',{seed:{[V1]:currentId}});
      assert.deepEqual(await array(entry.page,V2),[currentId]);
      assert.equal(await stored(entry.page,V1),currentId); assert.equal(await newBadge(entry.page),false);
      await entry.page.reload(); assert.deepEqual(await array(entry.page,V2),[currentId]);
    });

    await t.test('SDK unavailable fallback still shows and locally reads history on mobile',async () => {
      const entry = await fixture.device('missing-sdk',{missingSdk:true,viewport:{width:390,height:844}});
      assert.equal(await newBadge(entry.page),true);
      await openHistory(entry.page); await waitSeen(entry.page,currentId);
      assert.equal(await newBadge(entry.page),false); assert.equal(await stored(entry.page,V1),currentId);
      assert.equal(fixture.writes.filter(write => write.device === 'missing-sdk').length,0);
    });

    await t.test('Firestore read failure preserves local UX and pending',async () => {
      const entry = await fixture.device('firestore-failure',{identity:member('fail','failure-profile')});
      await until(() => fixture.cloud('failure-profile'));
      await entry.page.evaluate(() => { __historyFixture.failed=true; });
      const id = await changeLatest(entry.page,'ブラウザ試験・Firestore障害');
      await entry.page.evaluate(() => markHistorySeen());
      assert.equal(await newBadge(entry.page),false); assert((await array(entry.page,PENDING)).includes(id));
      await entry.page.evaluate(() => { __historyFixture.failed=false; dispatchEvent(new Event('online')); });
      await until(() => fixture.cloud('failure-profile').seenIds.includes(id));
    });

    await t.test('profile switch archives old pending and never writes it to the new profile',async () => {
      const oldProfile='switch-old', nextProfile='switch-new';
      const entry=await fixture.device('profile-switch',{identity:member('switch-old',oldProfile)});
      await until(() => fixture.cloud(oldProfile));
      await entry.page.evaluate(() => { __historyFixture.blocked=true; });
      const id=await changeLatest(entry.page,'ブラウザ試験・旧profileだけ');
      await entry.page.evaluate(() => markHistorySeen());
      assert((await array(entry.page,PENDING)).includes(id));
      const nextIdentity=member('switch-new',nextProfile); fixture.register(nextIdentity);
      await entry.page.evaluate(identity => {
        __historyFixture.blocked=false; __historySwitchIdentity(identity);
      },nextIdentity);
      await pause(50); await entry.page.evaluate(() => dispatchEvent(new Event('online')));
      await until(() => fixture.cloud(nextProfile));
      assert(!fixture.cloud(nextProfile).seenIds.includes(id));
      assert(!fixture.writes.some(write => write.path === fixture.historyPath(nextProfile) && JSON.stringify(write.data).includes(id)));
      const archive=JSON.parse(await stored(entry.page,RECORD_PREFIX+'profile:'+oldProfile));
      assert(archive.seenIds.includes(id),'old profile data remains archived');
      assert(!archive.acknowledgedIds.includes(id),'old profile read remains unacknowledged');
    });

    await t.test('256-ID limit retains local read and avoids repeated online writes',async () => {
      const profile='limit-profile'; fixture.seed(profile,Array.from({length:256},(_,i) => 'limit-'+i));
      const entry=await fixture.device('limit',{identity:member('limit',profile)});
      await waitSeen(entry.page,'limit-255');
      await openHistory(entry.page); await pause(150);
      assert.equal(await newBadge(entry.page),false); assert((await array(entry.page,V2)).includes(currentId));
      const before=fixture.transactions.filter(name => name === 'limit').length;
      for (let i=0;i<4;i++) await entry.page.evaluate(() => dispatchEvent(new Event('online')));
      await pause(150);
      assert.equal(fixture.transactions.filter(name => name === 'limit').length,before,'limit must be terminal for automatic replay');
      assert.equal(fixture.cloud(profile).seenIds.length,256);
      const limited=await entry.page.evaluate(() => historyReadLocalState.snapshot().limitedIds);
      assert(limited.includes(currentId),'limit metadata retains the unsynchronized ID');
      const record=JSON.parse(await stored(entry.page,RECORD_PREFIX+'profile:'+profile));
      assert(record.limitedIds.includes(currentId),'limit state is durable in the owning profile record');
      await entry.page.reload();
      await entry.page.waitForFunction(id => historyReadLocalState.snapshot().limitedIds.includes(id),currentId);
      assert.equal(await newBadge(entry.page),false,'limit fallback stays read after reload');
      assert.equal(fixture.transactions.filter(name => name === 'limit').length,before,'reload does not retry a terminal limit');
    });

    await t.test('both target viewport sizes retain history layout without horizontal overflow',async () => {
      for (const entry of [pc,phone]) {
        const width=await entry.page.evaluate(() => ({viewport:innerWidth,scroll:document.documentElement.scrollWidth}));
        assert(width.scroll <= width.viewport,JSON.stringify(width));
        assert.equal(await entry.page.locator('#historyDetails').count(),1);
        assert.equal(await entry.page.locator('#historyNewBadge').count(),1);
        assert.equal(await entry.page.locator('[data-member-sync]').count(),0,'index has no new account panel');
      }
    });

    await t.test('all network is intercepted and there are no console exceptions',async () => {
      assert(fixture.requests.some(url => url.includes('/api/visit')),'Visitor behavior is exercised through a local reply');
      assert(fixture.requests.some(url => url.endsWith('/member-sync.js?history-ui-1')) || fixture.requests.some(url => new URL(url).pathname === '/member-sync.js'));
      assert.deepEqual(fixture.errors,[]); assert.deepEqual(fixture.consoleErrors,[]);
    });
  } finally { await fixture.close(); await browser.close(); }
});
