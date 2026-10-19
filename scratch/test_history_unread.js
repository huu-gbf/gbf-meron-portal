const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const dom = new JSDOM(html, {runScripts: 'outside-only', url: 'http://localhost/'});
const {window} = dom;
const {document} = window;
// Execute only the real history implementation. No Firebase, Visitor, or remote resources.
window.eval(html.slice(html.indexOf('    const HISTORY_SEEN_KEY ='), html.lastIndexOf('  </script>')));
const badge = document.getElementById('historyNewBadge');
const details = document.getElementById('historyDetails');
const title = document.querySelector('#historyTimeline strong');
const originalTitle = title.textContent;
const latestId = window.getLatestHistoryId();
let checks = 0;
function check(condition, label) { assert.ok(condition, label); checks++; console.log('PASS: ' + label); }
function toggle() { details.open = true; details.dispatchEvent(new window.Event('toggle')); }

try {
  window.initHistoryUnread();
  check(!badge.classList.contains('hidden'), 'missing local state shows NEW');

  toggle();
  check(badge.classList.contains('hidden'), 'opening details immediately hides NEW');
  check(window.localStorage.getItem('gbf_portal_history_seen_v1') === latestId, 'rollback key remains a raw latest ID');
  check(JSON.parse(window.localStorage.getItem('gbf_portal_history_seen_ids_v2')).includes(latestId), 'v2 contains the current latest ID');
  check(JSON.parse(window.localStorage.getItem('gbf_portal_history_seen_sync_pending_v1')).includes(latestId), 'pending is already saved before any cloud work');

  window.updateHistoryNewBadge();
  check(badge.classList.contains('hidden'), 'a repeated render keeps NEW hidden');
  title.textContent = '新しい更新内容'; window.updateHistoryNewBadge();
  check(!badge.classList.contains('hidden'), 'changing the latest title shows NEW');

  title.textContent = originalTitle;
  document.querySelector('#historyTimeline p').textContent = '説明だけが変わりました。';
  window.updateHistoryNewBadge();
  check(badge.classList.contains('hidden'), 'changing only the body retains read state');
  title.textContent = '同日の別の新しい更新'; window.updateHistoryNewBadge();
  check(!badge.classList.contains('hidden'), 'same date with a distinct title shows NEW');

  let marks = 0;
  const originalMark = window.markHistorySeen;
  window.markHistorySeen = () => { marks++; originalMark(); };
  window.initHistoryUnread(); window.initHistoryUnread(); toggle();
  check(marks === 1, 'repeated initialization registers only one toggle handler');

  title.textContent = '保存できない時の新しい更新';
  const storagePrototype = window.Storage.prototype;
  const originalGet = storagePrototype.getItem;
  storagePrototype.getItem = function () { throw new Error('Storage get failure'); };
  try {
    window.updateHistoryNewBadge();
    check(!badge.classList.contains('hidden'), 'a real Storage prototype read failure keeps the unread badge usable');
  } finally { storagePrototype.getItem = originalGet; }

  const originalSet = storagePrototype.setItem;
  storagePrototype.setItem = function () { throw new Error('Storage set failure'); };
  try {
    toggle();
    check(badge.classList.contains('hidden'), 'a real Storage prototype write failure still immediately hides NEW');
    check(window.historyReadLocalState.snapshot().seenIds.includes(window.getLatestHistoryId()), 'write failure retains the read ID in memory');
    check(window.historyReadLocalState.flush() === false, 'cloud persistence fails closed when storage cannot be saved');
  } finally { storagePrototype.setItem = originalSet; }
  check(window.historyReadLocalState.flush() === true, 'restored storage persists the pending local read');
  console.log(`All ${checks} history unread checks passed!`);
} finally { dom.window.close(); }
