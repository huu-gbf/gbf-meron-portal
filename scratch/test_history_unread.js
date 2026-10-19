const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;

const html = fs.readFileSync('./index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });

const window = dom.window;
const document = window.document;
// 対象の実装だけを評価し、他のページ初期化・外部サービスを起動しない。
const begin = html.indexOf("const HISTORY_SEEN_KEY =");
const end = html.indexOf('</script>', begin);
if (begin < 0 || end <= begin) throw new Error('History unread implementation not found');
window.eval(html.slice(begin, end));

function runTests() {
  console.log("Starting tests...");

  // Setup globals that would normally be set by the actual app environment
  window.localStorage.clear();
  const HISTORY_SEEN_KEY = 'gbf_portal_history_seen_v1';

  // 期待値は対象関数を呼ばず、実際の先頭項目から組み立てる。
  const timeline = document.getElementById('historyTimeline');
  const firstItem = timeline.firstElementChild;
  const firstDate = firstItem.querySelector('span.font-mono');
  const titleStrong = firstItem.querySelector('strong');
  const originalTitle = titleStrong.textContent;
  const originalDate = firstDate.textContent;
  const expectedId = originalDate.trim() + '|' + originalTitle.trim();
  
  // A helper to assert conditions
  function assert(condition, message) {
    if (!condition) {
      console.error("FAIL: " + message);
      throw new Error("Assertion failed");
    } else {
      console.log("PASS: " + message);
    }
  }

  // Find badge
  const badge = document.getElementById('historyNewBadge');
  const details = document.getElementById('historyDetails');
  
  // test initialization
  window.initHistoryUnread();
  
  // Case A: localStorageに既読情報なし -> NEW表示
  assert(!badge.classList.contains('hidden'), "Case A: Badge should be visible initially");

  // Case B: 履歴詳細を開く -> 最新ID保存 -> NEW非表示
  details.open = true;
  details.dispatchEvent(new window.Event('toggle'));
  assert(badge.classList.contains('hidden'), "Case B: Badge should be hidden after opening details");
  let savedId = window.localStorage.getItem(HISTORY_SEEN_KEY);
  assert(savedId === expectedId, "Case B: savedId should match the current first entry: " + savedId);

  // Case C: 同じ最新IDで再読み込み -> NEW非表示
  // Simulate reload
  window.updateHistoryNewBadge();
  assert(badge.classList.contains('hidden'), "Case C: Badge should remain hidden on reload");

  // Case D: 最新項目の日付またはタイトルが変わる -> NEW再表示
  titleStrong.textContent = "新しい更新内容";
  window.updateHistoryNewBadge();
  assert(!badge.classList.contains('hidden'), "Case D: Badge should be visible again after title changes");

  // Case E: 最新項目の説明本文だけ変わる -> NEW再表示しない
  // revert title, change body
  titleStrong.textContent = originalTitle;
  details.dispatchEvent(new window.Event('toggle')); // Mark seen again just in case
  const bodyText = document.querySelector('#historyTimeline p');
  bodyText.textContent = "説明が変わりました。";
  window.updateHistoryNewBadge();
  assert(badge.classList.contains('hidden'), "Case E: Badge should remain hidden after body changes");

  // Case F: 同じ日付でタイトルの違う新しい項目 -> NEW再表示
  titleStrong.textContent = "別の新しい更新";
  window.updateHistoryNewBadge();
  assert(!badge.classList.contains('hidden'), "Case F: Badge should be visible after new title same date");

  // 日付だけの変更、および新しい先頭項目も、固定日付に依存せず検証する。
  titleStrong.textContent = originalTitle;
  firstDate.textContent = '2099/01/01';
  window.updateHistoryNewBadge();
  assert(!badge.classList.contains('hidden'), "Case F2: Date change should show badge");
  assert(window.getLatestHistoryId() === '2099/01/01|' + originalTitle.trim(), "Case F2: ID should include the changed date");
  firstDate.textContent = originalDate;
  const added = firstItem.cloneNode(true);
  added.querySelector('span.font-mono').textContent = '2099/02/02';
  added.querySelector('strong').textContent = '先頭に追加したテスト履歴';
  timeline.prepend(added);
  details.dispatchEvent(new window.Event('toggle'));
  assert(window.localStorage.getItem(HISTORY_SEEN_KEY) === '2099/02/02|先頭に追加したテスト履歴', "Case F3: Prepended first entry should be saved as latest");
  added.remove();

  // Case G: showPortal相当の初期化を複数回実行 -> toggleイベントが重複登録されない
  const storagePrototype = window.Storage.prototype;
  const originalSetItem = storagePrototype.setItem;
  let writes = 0;
  storagePrototype.setItem = function(...args) { writes++; return originalSetItem.apply(this, args); };
  window.initHistoryUnread();
  window.initHistoryUnread();
  details.dispatchEvent(new window.Event('toggle'));
  storagePrototype.setItem = originalSetItem;
  assert(writes === 1, "Case G: Repeated initialization should register only one toggle listener");

  // Case H: localStorage読み込みエラー -> 例外終了しない
  const originalGetItem = storagePrototype.getItem;
  let reads = 0;
  storagePrototype.getItem = function() { reads++; throw new Error("Storage get error"); };
  window.updateHistoryNewBadge();
  assert(reads === 1, "Case H: Read-error path should actually execute");
  assert(!badge.classList.contains('hidden'), "Case H: Should not crash on read error and show badge");
  storagePrototype.getItem = originalGetItem;

  // Case I: localStorage書き込みエラー -> 例外終了しない
  writes = 0;
  storagePrototype.setItem = function() { writes++; throw new Error("Storage set error"); };
  details.dispatchEvent(new window.Event('toggle'));
  storagePrototype.setItem = originalSetItem;
  assert(writes === 1, "Case I: Write-error path should actually execute");
  assert(badge.classList.contains('hidden'), "Case I: Should hide badge without crashing on write error");

  console.log("All tests passed!");
}

try { runTests(); } finally { window.close(); }
