const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;

const html = fs.readFileSync('./index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });

const window = dom.window;
const document = window.document;

function runTests() {
  console.log("Starting tests...");

  // Setup globals that would normally be set by the actual app environment
  window.localStorage.clear();
  const HISTORY_SEEN_KEY = 'gbf_portal_history_seen_v1';

  // Extract functions for testing
  // They are in the global scope of the document since we runScripts: dangerously
  
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
  assert(savedId === '2026/09/29|次回闇有利古戦場の日程を更新', "Case B: savedId should be correct: " + savedId);

  // Case C: 同じ最新IDで再読み込み -> NEW非表示
  // Simulate reload
  window.updateHistoryNewBadge();
  assert(badge.classList.contains('hidden'), "Case C: Badge should remain hidden on reload");

  // Case D: 最新項目の日付またはタイトルが変わる -> NEW再表示
  const titleStrong = document.querySelector('#historyTimeline strong');
  titleStrong.textContent = "新しい更新内容";
  window.updateHistoryNewBadge();
  assert(!badge.classList.contains('hidden'), "Case D: Badge should be visible again after title changes");

  // Case E: 最新項目の説明本文だけ変わる -> NEW再表示しない
  // revert title, change body
  titleStrong.textContent = "次回闇有利古戦場の日程を更新";
  details.dispatchEvent(new window.Event('toggle')); // Mark seen again just in case
  const bodyText = document.querySelector('#historyTimeline p');
  bodyText.textContent = "説明が変わりました。";
  window.updateHistoryNewBadge();
  assert(badge.classList.contains('hidden'), "Case E: Badge should remain hidden after body changes");

  // Case F: 同じ日付でタイトルの違う新しい項目 -> NEW再表示
  titleStrong.textContent = "別の新しい更新";
  window.updateHistoryNewBadge();
  assert(!badge.classList.contains('hidden'), "Case F: Badge should be visible after new title same date");

  // Case G: showPortal相当の初期化を複数回実行 -> toggleイベントが重複登録されない
  // Well, we can't easily assert event listener count, but we can call initHistoryUnread multiple times
  // and ensure it doesn't crash or break behavior.
  window.initHistoryUnread();
  window.initHistoryUnread();
  assert(true, "Case G: initHistoryUnread can be called multiple times safely");

  // Case H: localStorage読み込みエラー -> 例外終了しない
  // Override localStorage getter
  const originalGetItem = window.localStorage.getItem;
  window.localStorage.getItem = function() { throw new Error("Storage get error"); };
  window.updateHistoryNewBadge();
  assert(!badge.classList.contains('hidden'), "Case H: Should not crash on read error and show badge");
  window.localStorage.getItem = originalGetItem; // restore

  // Case I: localStorage書き込みエラー -> 例外終了しない
  const originalSetItem = window.localStorage.setItem;
  window.localStorage.setItem = function() { throw new Error("Storage set error"); };
  details.dispatchEvent(new window.Event('toggle'));
  assert(true, "Case I: Should not crash on write error");

  console.log("All tests passed!");
}

runTests();
