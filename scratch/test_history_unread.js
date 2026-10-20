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
const timeline = document.getElementById('historyTimeline');
const firstItem = timeline.firstElementChild;
const firstDate = firstItem.querySelector('span.font-mono');
const originalDate = firstDate.textContent;
// Build the expectation from the DOM independently of the implementation.
const latestId = originalDate.trim() + '|' + originalTitle.trim();
let checks = 0;
function check(condition, label) { assert.ok(condition, label); checks++; console.log('PASS: ' + label); }
function toggle() { details.open = true; details.dispatchEvent(new window.Event('toggle')); }

try {
  check(window.getLatestHistoryId() === latestId, 'latest ID matches the current first DOM entry');
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

  title.textContent = originalTitle;
  firstDate.textContent = '2099/01/01';
  window.updateHistoryNewBadge();
  check(!badge.classList.contains('hidden'), 'a date-only change shows NEW');
  check(window.getLatestHistoryId() === '2099/01/01|' + originalTitle.trim(), 'ID includes the changed date');
  firstDate.textContent = originalDate;
  const added = firstItem.cloneNode(true);
  added.querySelector('span.font-mono').textContent = '2099/02/02';
  added.querySelector('strong').textContent = '先頭に追加したテスト履歴';
  timeline.prepend(added);
  window.updateHistoryNewBadge();
  check(!badge.classList.contains('hidden'), 'a prepended entry shows NEW');
  toggle();
  const addedId = '2099/02/02|先頭に追加したテスト履歴';
  check(window.getLatestHistoryId() === addedId, 'a prepended entry becomes the latest ID');
  check(window.localStorage.getItem('gbf_portal_history_seen_v1') === addedId, 'prepended ID is stored in rollback key');
  for (const key of ['gbf_portal_history_seen_ids_v2', 'gbf_portal_history_seen_sync_pending_v1']) {
    check(JSON.parse(window.localStorage.getItem(key)).includes(addedId), 'prepended ID retained in ' + key);
  }
  added.remove();

  let marks = 0;
  const originalMark = window.markHistorySeen;
  window.markHistorySeen = () => { marks++; originalMark(); };
  window.initHistoryUnread(); window.initHistoryUnread(); toggle();
  check(marks === 1, 'repeated initialization registers only one toggle handler');

  title.textContent = '保存できない時の新しい更新';
  const storagePrototype = window.Storage.prototype;
  const originalGet = storagePrototype.getItem;
  let reads = 0;
  storagePrototype.getItem = function () { reads++; throw new Error('Storage get failure'); };
  try {
    window.updateHistoryNewBadge();
    check(window.historyReadLocalState.flush() === false, 'storage read failure blocks cloud persistence');
    check(reads > 0, 'storage read failure path actually executes');
    check(!badge.classList.contains('hidden'), 'a real Storage prototype read failure keeps the unread badge usable');
  } finally { storagePrototype.getItem = originalGet; }

  const originalSet = storagePrototype.setItem;
  let writes = 0;
  storagePrototype.setItem = function () { writes++; throw new Error('Storage set failure'); };
  try {
    toggle();
    check(writes > 0, 'storage write failure path actually executes');
    check(badge.classList.contains('hidden'), 'a real Storage prototype write failure still immediately hides NEW');
    check(window.historyReadLocalState.snapshot().seenIds.includes(window.getLatestHistoryId()), 'write failure retains the read ID in memory');
    check(window.historyReadLocalState.flush() === false, 'cloud persistence fails closed when storage cannot be saved');
  } finally { storagePrototype.setItem = originalSet; }
  check(window.historyReadLocalState.flush() === true, 'restored storage persists the pending local read');
  console.log(`All ${checks} history unread checks passed!`);
} finally { dom.window.close(); }
