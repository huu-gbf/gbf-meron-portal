const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf("    const HISTORY_SEEN_KEY ="), html.lastIndexOf('  </script>'));
const V1 = 'gbf_portal_history_seen_v1';
const V2 = 'gbf_portal_history_seen_ids_v2';
const PENDING = 'gbf_portal_history_seen_sync_pending_v1';
const JOURNAL = 'gbf_portal_history_seen_sync_state_v1';
const RECORD = 'gbf_portal_history_seen_sync_record_v1:';

function fixture(initial = {}, options = {}) {
  const dom = new JSDOM(html, {url: 'http://localhost/', runScripts: 'outside-only'});
  const {window} = dom;
  window.eval(source);
  const data = options.data || new Map(Object.entries(initial));
  const writes = [];
  let failGet = false, failSet = false, failKey = null, beforeWrite = null, latest = options.latest || '2026/10/19|最新';
  const storage = {
    getItem(key) { if (failGet) throw new Error('read unavailable'); return data.get(key) ?? null; },
    setItem(key, value) {
      if (failSet || key === failKey) throw new Error('write unavailable');
      beforeWrite?.(key, value); data.set(key, value); writes.push([key, value]);
    },
    removeItem(key) { if (failSet || key === failKey) throw new Error('write unavailable'); data.delete(key); writes.push([key, null]); }
  };
  const target = new window.EventTarget();
  const io = window.createHistoryLocalState(storage, {getLatestId: () => latest,
    onChange: () => options.onChange?.(io), eventTarget: target});
  const array = key => data.has(key) ? JSON.parse(data.get(key)) : [];
  const snapshot = () => JSON.parse(JSON.stringify(io.snapshot()));
  const emit = (key, newValue = data.get(key) ?? null) => {
    const event = new window.Event('storage');
    Object.defineProperties(event, {key: {value: key}, newValue: {value: newValue}, storageArea: {value: storage}});
    target.dispatchEvent(event);
  };
  return {io, data, storage, writes, array, snapshot, emit, window, close: () => dom.window.close(),
    latest: value => { latest = value; }, failGet: value => { failGet = value; }, failSet: value => { failSet = value; },
    failKey: key => { failKey = key; }, beforeWrite: callback => { beforeWrite = callback; }};
}

test('v1 migrates one raw ID into v2 and pending, retaining the raw v1 key', () => {
  const f = fixture({[V1]: '2026/10/01|機能追加'});
  assert.deepEqual(f.array(V2), ['2026/10/01|機能追加']);
  assert.deepEqual(f.array(PENDING), ['2026/10/01|機能追加']);
  assert.equal(f.data.get(V1), '2026/10/01|機能追加'); f.close();
});

test('empty v1 does not migrate an ID', () => {
  const f = fixture({[V1]: ''}); assert.deepEqual(f.array(V2), []);
  assert.equal(f.data.has(PENDING), false); f.close();
});

test('invalid v1 values are ignored, including overlength Unicode IDs', () => {
  for (const value of ['', '😀'.repeat(513)]) {
    const f = fixture({[V1]: value}); assert.deepEqual(f.array(V2), []); f.close();
  }
});

test('invalid v2 JSON safely uses a valid rollback value', () => {
  const f = fixture({[V2]: '{broken', [V1]: 'A'});
  assert.deepEqual(f.array(V2), ['A']); f.close();
});

test('non-array v2 JSON does not crash', () => {
  for (const value of ['null', '{}', '3', '"A"']) {
    const f = fixture({[V2]: value}); assert.deepEqual(f.array(V2), []); f.close();
  }
});

test('v2 deduplicates IDs and filters invalid elements by Unicode code points', () => {
  const boundary = '😀'.repeat(512);
  const f = fixture({[V2]: JSON.stringify(['A', 'A', '', null, 1, boundary, '😀'.repeat(513)])});
  assert.deepEqual(f.array(V2), ['A', boundary]); f.close();
});

test('an existing empty v2 does not remigrate stale v1', () => {
  const f = fixture({[V2]: '[]', [V1]: 'old'});
  assert.deepEqual(f.array(V2), []); f.close();
});

test('migration and reload are idempotent', () => {
  const first = fixture({[V1]: 'A'}), next = fixture({}, {data: first.data});
  assert.deepEqual(next.snapshot().seenIds, ['A']);
  assert.deepEqual(next.array(PENDING), ['A']);
  assert.equal(next.writes.length, 0); first.close(); next.close();
});

test('mark saves local v2 then rollback v1 and persists pending before notification', () => {
  const f = fixture(); f.writes.length = 0;
  let notified = false;
  f.io.subscribe(() => { notified = true; assert.deepEqual(f.array(PENDING), ['2026/10/19|最新']); });
  assert.equal(f.io.mark('2026/10/19|最新'), true);
  assert.equal(notified, true);
  const keys = f.writes.map(([key]) => key);
  assert(keys.indexOf(RECORD + 'unlinked') < keys.indexOf(V2));
  assert(keys.indexOf(V2) < keys.indexOf(V1));
  assert(keys.indexOf(V1) < keys.indexOf(PENDING));
  assert.deepEqual(f.snapshot().seenIds, ['2026/10/19|最新']); f.close();
});

test('mark is visible to the badge callback before pending/network listeners', () => {
  let badgeUpdated = false;
  const f = fixture({}, {onChange: io => { badgeUpdated = io.snapshot().seenIds.includes('2026/10/19|最新'); }});
  f.io.subscribe(() => assert.equal(badgeUpdated, true));
  f.io.mark('2026/10/19|最新'); assert.equal(badgeUpdated, true); f.close();
});

test('duplicate marks preserve one seen and pending ID', () => {
  const f = fixture(); f.io.mark('A'); f.io.mark('A');
  assert.deepEqual(f.array(V2), ['A']); assert.deepEqual(f.array(PENDING), ['A']); f.close();
});

test('mark rejects non-string, empty, and oversized IDs', () => {
  const f = fixture(); for (const id of ['', 1, null, 'あ'.repeat(513)]) assert.equal(f.io.mark(id), false);
  assert.deepEqual(f.snapshot().seenIds, []); f.close();
});

test('local mark survives reload and remains pending', () => {
  const f = fixture(); f.io.mark('A'); const reload = fixture({}, {data: f.data});
  assert.deepEqual(reload.snapshot().seenIds, ['A']); assert.deepEqual(reload.snapshot().pendingIds, ['A']);
  f.close(); reload.close();
});

test('first profile adopts unlinked IDs, later profiles do not adopt another owner', () => {
  const f = fixture({[V1]: 'A'}); assert.equal(f.io.bindProfile('profileA'), true);
  assert.deepEqual(f.snapshot().pendingIds, ['A']); f.io.mark('B');
  assert.equal(f.io.bindProfile('profileB'), true); assert.deepEqual(f.snapshot().seenIds, []);
  f.io.mark('C'); assert.equal(f.io.bindProfile('profileA'), true);
  assert.deepEqual(f.snapshot().seenIds, ['A', 'B']); assert.deepEqual(f.snapshot().pendingIds, ['A', 'B']);
  assert.equal(f.io.bindProfile('profileB'), true); assert.deepEqual(f.snapshot().seenIds, ['C']); f.close();
});

test('profile owner and archived IDs survive reload', () => {
  const f = fixture(); f.io.bindProfile('profileA'); f.io.mark('A'); f.io.bindProfile('profileB'); f.io.mark('B');
  const reload = fixture({}, {data: f.data}); assert.equal(reload.snapshot().profileId, 'profileB');
  assert.equal(reload.io.bindProfile('profileA'), true); assert.deepEqual(reload.snapshot().seenIds, ['A']);
  f.close(); reload.close();
});

test('remote union preserves local IDs and removes only confirmed pending IDs', () => {
  const f = fixture(); f.io.bindProfile('profileA'); f.io.mark('A'); f.io.mark('C');
  assert.equal(f.io.applyRemote(['A', 'B'], 'profileA'), true);
  assert.deepEqual(f.snapshot().seenIds, ['A', 'B', 'C']); assert.deepEqual(f.snapshot().pendingIds, ['C']); f.close();
});

test('remote old IDs never overwrite rollback v1; current latest may update it', () => {
  const f = fixture({[V1]: 'old'}); f.io.bindProfile('profileA'); f.io.applyRemote(['ancient'], 'profileA');
  assert.equal(f.data.get(V1), 'old'); f.io.applyRemote(['2026/10/19|最新'], 'profileA');
  assert.equal(f.data.get(V1), '2026/10/19|最新'); f.close();
});

test('repeating the same remote snapshot writes nothing and creates no pending remote IDs', () => {
  const f = fixture(); f.io.bindProfile('profileA'); f.io.applyRemote(['A'], 'profileA'); f.writes.length = 0;
  f.io.applyRemote(['A'], 'profileA'); assert.equal(f.writes.length, 0);
  assert.deepEqual(f.snapshot().pendingIds, []); f.close();
});

test('ACK is ID-specific and cannot remove a newer in-flight pending ID', () => {
  const f = fixture(); f.io.bindProfile('profileA'); f.io.mark('A'); f.io.mark('B'); f.io.ack('A', 'profileA');
  assert.deepEqual(f.array(PENDING), ['B']); assert.deepEqual(f.snapshot().seenIds, ['A', 'B']); f.close();
});

test('the final ACK removes the pending key and survives reload', () => {
  const f = fixture(); f.io.bindProfile('profileA'); f.io.mark('A'); f.io.ack('A', 'profileA');
  assert.equal(f.data.has(PENDING), false); const reload = fixture({}, {data: f.data});
  assert.deepEqual(reload.snapshot().pendingIds, []); f.close(); reload.close();
});

test('limit is separate from retryable pending, local seen persists across reload', () => {
  const f = fixture(); f.io.bindProfile('profileA'); f.io.mark('A'); f.io.limit('A', 'profileA');
  assert.deepEqual(f.snapshot().limitedIds, ['A']); assert.deepEqual(f.snapshot().pendingIds, []);
  const reload = fixture({}, {data: f.data}); assert.deepEqual(reload.snapshot().seenIds, ['A']);
  assert.deepEqual(reload.snapshot().limitedIds, ['A']); assert.deepEqual(reload.snapshot().pendingIds, []);
  f.close(); reload.close();
});

test('remote confirmation clears a formerly limited ID', () => {
  const f = fixture(); f.io.bindProfile('profileA'); f.io.mark('A'); f.io.limit('A', 'profileA');
  f.io.applyRemote(['A'], 'profileA'); assert.deepEqual(f.snapshot().limitedIds, []); f.close();
});

test('stale profile remote, ACK, and limit cannot mutate a new profile', () => {
  const f = fixture(); f.io.bindProfile('profileA'); f.io.mark('A'); f.io.bindProfile('profileB');
  assert.equal(f.io.applyRemote(['A'], 'profileA'), false); assert.equal(f.io.ack('A', 'profileA'), false);
  assert.equal(f.io.limit('A', 'profileA'), false); assert.deepEqual(f.snapshot().seenIds, []); f.close();
});

test('failed owner persistence refuses cloud binding while preserving local memory', () => {
  const f = fixture(); f.io.mark('A'); f.failSet(true);
  assert.equal(f.io.bindProfile('profileA'), false); assert.equal(f.snapshot().profileId, null);
  assert.deepEqual(f.snapshot().seenIds, ['A']); f.io.mark('B'); assert.equal(f.io.flush(), false); f.close();
});

test('write failures retain immediate local seen state and recover pending on flush', () => {
  const f = fixture(); f.failSet(true); f.io.mark('2026/10/19|最新');
  assert.deepEqual(f.snapshot().seenIds, ['2026/10/19|最新']); assert.equal(f.io.flush(), false);
  f.failSet(false); assert.equal(f.io.flush(), true); assert.deepEqual(f.array(PENDING), ['2026/10/19|最新']); f.close();
});

test('read failures preserve in-memory state and fail cloud flush closed', () => {
  const f = fixture(); f.io.mark('A'); f.failGet(true); f.io.mark('B');
  assert.deepEqual(f.snapshot().seenIds, ['A', 'B']); assert.equal(f.io.flush(), false); f.close();
});

test('binding metadata save failure recovers newer owner records on reload', () => {
  const f = fixture(); f.io.bindProfile('profileA'); f.io.mark('A'); f.failKey(JOURNAL); f.io.mark('B');
  assert.deepEqual(f.array(V2), ['A', 'B']); assert.deepEqual(f.array(PENDING), ['A', 'B']);
  const reload = fixture({}, {data: f.data}); assert.equal(reload.snapshot().profileId, 'profileA');
  assert.deepEqual(reload.snapshot().seenIds, ['A', 'B']); assert.deepEqual(reload.snapshot().pendingIds, ['A', 'B']);
  f.close(); reload.close();
});

test('interrupted owner binding never imports old-owner array mirrors into the new owner', () => {
  const f = fixture(); f.io.bindProfile('profileA'); f.io.mark('A'); f.failKey(V2);
  assert.equal(f.io.bindProfile('profileB'), false); assert.equal(f.snapshot().profileId, 'profileB');
  assert.equal(JSON.parse(f.data.get(JOURNAL)).profileId, 'profileB'); assert.deepEqual(f.array(V2), ['A']);
  const reload = fixture({}, {data: f.data}); assert.equal(reload.snapshot().profileId, 'profileB');
  assert.deepEqual(reload.snapshot().seenIds, []); assert.deepEqual(reload.snapshot().pendingIds, []);
  assert.equal(reload.io.bindProfile('profileA'), true); assert.deepEqual(reload.snapshot().seenIds, ['A']);
  f.close(); reload.close();
});

test('corrupt owner journal leaves local usable and refuses profile adoption', () => {
  const f = fixture({[JOURNAL]: '{broken', [V2]: '["A"]'}); f.io.mark('B');
  assert.deepEqual(f.snapshot().seenIds, ['A', 'B']); assert.equal(f.io.bindProfile('profileB'), false); f.close();
});

test('cross-tab v2 event updates same-owner seen IDs and notifies immediately', () => {
  const a = fixture(), b = fixture({}, {data: a.data}); let notified = false;
  b.io.subscribe(() => { notified = true; }); a.io.mark('A'); b.emit(V2);
  assert.equal(notified, true); assert.deepEqual(b.snapshot().seenIds, ['A']); a.close(); b.close();
});

test('cross-tab union repairs lost mirror updates without a storage write loop', () => {
  const a = fixture(), b = fixture({}, {data: a.data}); a.io.mark('A'); b.io.mark('B');
  a.emit(V2); b.emit(V2); assert.deepEqual(new Set(a.snapshot().seenIds), new Set(['A', 'B']));
  assert.deepEqual(new Set(b.snapshot().seenIds), new Set(['A', 'B']));
  a.writes.length = 0; a.emit(V2); a.emit(JOURNAL); assert.equal(a.writes.length, 0); a.close(); b.close();
});

test('cross-tab ACK does not get resurrected by stale pending memory', () => {
  const a = fixture(); a.io.bindProfile('profileA'); a.io.mark('A'); const b = fixture({}, {data: a.data});
  a.io.ack('A', 'profileA'); b.emit(JOURNAL); b.io.flush();
  assert.deepEqual(b.snapshot().pendingIds, []); assert.equal(b.data.has(PENDING), false); a.close(); b.close();
});

test('cross-tab owner switch never leaks IDs or allows the old tab to reclaim ownership', () => {
  const a = fixture(); a.io.bindProfile('profileA'); a.io.mark('A'); const b = fixture({}, {data: a.data});
  b.io.bindProfile('profileB'); b.io.mark('B'); a.emit(V2);
  assert.equal(a.snapshot().profileId, 'profileB'); assert.deepEqual(a.snapshot().seenIds, ['B']);
  assert.equal(a.io.bindProfile('profileA'), false); assert.equal(a.io.ack('A', 'profileA'), false);
  assert.equal(JSON.parse(a.data.get(JOURNAL)).profileId, 'profileB'); a.close(); b.close();
});

test('a delayed old-owner storage event payload cannot enter the new owner set', () => {
  const a = fixture(); a.io.bindProfile('profileA'); a.io.mark('A');
  a.io.bindProfile('profileB'); a.io.mark('B');
  a.emit(V2, '["A"]'); a.emit(PENDING, '["A"]');
  assert.equal(a.snapshot().profileId, 'profileB'); assert.deepEqual(a.snapshot().seenIds, ['B']);
  assert.deepEqual(a.snapshot().pendingIds, ['B']); a.close();
});

test('a suspended old writer cannot poison a new owner through shared array mirrors', () => {
  const a = fixture(); a.io.bindProfile('profileA'); const b = fixture({}, {data: a.data});
  let switched = false;
  a.beforeWrite(key => {
    if (key === V2 && !switched) {
      switched = true; b.io.bindProfile('profileB'); b.io.mark('B');
    }
  });
  a.io.mark('A');
  assert.equal(JSON.parse(a.data.get(JOURNAL)).profileId, 'profileB');
  assert.deepEqual(JSON.parse(a.data.get(RECORD + 'profile:profileA')).seenIds, ['A']);
  const reload = fixture({}, {data: a.data});
  assert.equal(reload.snapshot().profileId, 'profileB'); assert.deepEqual(reload.snapshot().seenIds, ['B']);
  assert.deepEqual(reload.snapshot().pendingIds, ['B']);
  reload.io.bindProfile('profileA'); assert.deepEqual(reload.snapshot().seenIds, ['A']);
  a.close(); b.close(); reload.close();
});

test('equivalent set order converges to canonical serialization without cross-tab write ping-pong', () => {
  const a = fixture(); a.io.bindProfile('profileA'); const b = fixture({}, {data: a.data});
  let marked = false;
  a.beforeWrite(key => {
    if (key === V2 && !marked) { marked = true; b.io.mark('B'); }
  });
  a.io.mark('A'); a.emit(RECORD + 'profile:profileA'); b.emit(RECORD + 'profile:profileA');
  assert.deepEqual(a.snapshot().seenIds, ['A', 'B']); assert.deepEqual(b.snapshot().seenIds, ['A', 'B']);
  const saved = a.data.get(RECORD + 'profile:profileA');
  a.writes.length = 0; b.writes.length = 0;
  for (let i = 0; i < 10; i++) { a.emit(V2, '["B","A"]'); b.emit(V2, '["A","B"]'); }
  assert.equal(a.data.get(RECORD + 'profile:profileA'), saved);
  assert.equal(a.writes.length + b.writes.length, 0); a.close(); b.close();
});

test('failed owner record persistence retains local memory and prevents cloud flush', () => {
  const f = fixture(); f.io.bindProfile('profileA'); f.failKey(RECORD + 'profile:profileA'); f.io.mark('A');
  assert.deepEqual(f.snapshot().seenIds, ['A']); assert.deepEqual(f.snapshot().pendingIds, ['A']);
  assert.equal(f.io.flush(), false); f.failKey(null); assert.equal(f.io.flush(), true);
  const reload = fixture({}, {data: f.data}); assert.deepEqual(reload.snapshot().seenIds, ['A']); f.close(); reload.close();
});

test('an owner-labelled record with a mismatched owner fails cloud persistence closed', () => {
  const f = fixture(); f.io.bindProfile('profileA');
  f.data.set(RECORD + 'profile:profileA', JSON.stringify({version: 1, profileId: 'profileB', seenIds: ['B'],
    acknowledgedIds: [], limitedIds: []}));
  assert.equal(f.io.flush(), false); assert.deepEqual(f.snapshot().seenIds, []); f.close();
});

test('a surviving tab recovers an overwritten simultaneous owner record after its source closes', () => {
  const a = fixture(); a.io.bindProfile('profileA'); const b = fixture({}, {data: a.data});
  const key = RECORD + 'profile:profileA'; let overwrittenPayload = null, injected = false;
  a.beforeWrite(recordKey => {
    if (recordKey === key && !injected) {
      injected = true; b.io.mark('B'); overwrittenPayload = b.data.get(key);
    }
  });
  a.io.mark('A'); b.close();
  assert.deepEqual(JSON.parse(a.data.get(key)).seenIds, ['A']);
  a.emit(key, overwrittenPayload);
  assert.deepEqual(a.snapshot().seenIds, ['A', 'B']); assert.deepEqual(a.snapshot().pendingIds, ['A', 'B']);
  const reload = fixture({}, {data: a.data}); assert.deepEqual(reload.snapshot().seenIds, ['A', 'B']);
  a.close(); reload.close();
});

test('old owner record events extend only their archive and reject key-owner mismatches', () => {
  const f = fixture(); f.io.bindProfile('profileA'); f.io.mark('A'); f.io.bindProfile('profileB'); f.io.mark('B');
  const old = JSON.stringify({version: 1, profileId: 'profileA', seenIds: ['A', 'X'], acknowledgedIds: [], limitedIds: []});
  f.emit(RECORD + 'profile:profileB', old); assert.deepEqual(f.snapshot().seenIds, ['B']);
  f.emit(RECORD + 'profile:profileA', old); assert.deepEqual(f.snapshot().seenIds, ['B']);
  assert.equal(JSON.parse(f.data.get(JOURNAL)).profileId, 'profileB');
  f.io.bindProfile('profileA'); assert.deepEqual(f.snapshot().seenIds, ['A', 'X']); f.close();
});

test('current latest membership controls NEW immediately and after local marks', () => {
  const f = fixture(); const {window} = f; const badge = window.document.getElementById('historyNewBadge');
  window.updateHistoryNewBadge(); assert.equal(badge.classList.contains('hidden'), false);
  window.markHistorySeen(); assert.equal(badge.classList.contains('hidden'), true);
  window.document.querySelector('#historyTimeline strong').textContent = '次の履歴';
  window.updateHistoryNewBadge(); assert.equal(badge.classList.contains('hidden'), false); f.close();
});

test('initializing unread repeatedly registers one toggle handler', () => {
  const f = fixture(); const {window} = f; const details = window.document.getElementById('historyDetails');
  let marks = 0; const original = window.markHistorySeen; window.markHistorySeen = () => { marks++; original(); };
  window.initHistoryUnread(); window.initHistoryUnread(); window.initHistoryUnread();
  details.open = true; details.dispatchEvent(new window.Event('toggle')); assert.equal(marks, 1); f.close();
});
