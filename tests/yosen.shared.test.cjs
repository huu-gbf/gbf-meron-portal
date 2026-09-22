const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('tools/yosen-predictor.html', 'utf8');
const shared = fs.readFileSync('tools/yosen-shared.js', 'utf8');
const parseStart = html.indexOf('function parseNumber(');
const parseEnd = html.indexOf('function formatOku(', parseStart);
const sharedStart = shared.indexOf('const safeScore =');
const sharedEnd = shared.indexOf('function preview()', sharedStart);
assert(parseStart >= 0 && parseEnd > parseStart && sharedStart >= 0 && sharedEnd > sharedStart);

const fields = {
  editDate: { value: '2026-09-21' }, editDay: { value: 'weekday' },
  edit7: { value: '175億' }, edit12: { value: '200億' },
  editEarlyAvgSpeed: { value: '50000 万/h' },
  edit18: { value: '' }, edit20: { value: '' }
};
const context = { fields };
vm.runInNewContext("const $ = id => globalThis.fields[id]; const days = {weekday:'平日',saturday:'土曜',sunday:'日曜',holiday:'祝日'};\n"
  + html.slice(parseStart, parseEnd) + '\n' + shared.slice(sharedStart, sharedEnd)
  + '\nglobalThis.readDraft=readDraft; globalThis.validData=validData; globalThis.dropStale=dropStaleEveningScores;', context);

test('管理画面は7時と12時値から平均時速を計算して保存形式へ変換する', () => {
  const d = context.readDraft();
  assert.equal(d.earlyAvgSpeed, 50000);
  assert.equal(d.score12, 200e8);
  assert.equal(d.score18, null);
  assert.equal(d.score20, null);
  assert.equal(Object.hasOwn(d, 'score7'), false);
  assert.equal(context.validData(d), true);
  
  // 12時を変更すると平均時速が変わるが、制限はない
  fields.edit12.value = '200.005億'; // 200.005億 - 175億 = 25.005億 / 5 = 5.001億 (50001万/h)
  assert.equal(context.validData(context.readDraft()), true);
  fields.edit12.value = '200億';
});

test('既存公開データは新しい必須項目なしで読める', () => {
  const d = context.readDraft();
  delete d.earlyAvgSpeed;
  assert.equal(context.validData(d), true);
});

test('引き継いだ18時・20時値が新しい12時値と矛盾したときだけ空欄にする', () => {
  const previous = { eventDate: '2026-09-20', score12: 200e8, score18: 300e8, score20: 400e8 };
  fields.edit18.value = '300億';
  fields.edit20.value = '400億';
  const unchanged = context.dropStale(context.readDraft(), previous);
  assert.equal(unchanged.score18, 300e8);
  assert.equal(unchanged.score20, 400e8);
  fields.edit12.value = '350億';
  const d = context.dropStale(context.readDraft(), previous);
  assert.equal(d.score18, null);
  assert.equal(d.score20, null);
  assert.equal(context.validData(d), true);

  fields.edit18.value = '340億'; // 管理者が新たに入れた不正な値は従来どおりエラー
  assert.equal(context.validData(context.dropStale(context.readDraft(), previous)), false);
  fields.edit18.value = '450億';
  const only20Stale = context.dropStale(context.readDraft(), previous);
  assert.equal(only20Stale.score18, 450e8);
  assert.equal(only20Stale.score20, null);
  assert.equal(context.validData(only20Stale), true);
});
