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

test('管理画面は7時と12時の累計を整数のまま公開データにする', () => {
  const d = context.readDraft();
  assert.equal(d.score7, 175e8);
  assert.equal(d.score12, 200e8);
  assert.equal(d.score18, null);
  assert.equal(d.score20, null);
  assert.equal(Object.hasOwn(d, 'earlyAvgSpeed'), false);
  assert.equal(context.validData(d), true);
});

test('既存公開データは新しい必須項目なしで読める', () => {
  const d = context.readDraft();
  delete d.score7;
  assert.equal(context.validData({ ...d, earlyAvgSpeed: 50000 }), true);
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

const inline = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const legacy = Object.freeze({
  schemaVersion: 1, eventDate: '2026-09-22', dayType: 'holiday',
  score12: 8818970636, earlyAvgSpeed: 51125, score18: null, score20: null,
  updatedAt: { toDate: () => new Date('2026-09-22T15:45:20Z') },
});

async function openPredictor(store, user = null) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', style: {}, elements: [], listeners: {},
      addEventListener(type, callback) { this.listeners[type] = callback; },
    });
    return elements.get(id);
  };
  let onSnapshot;
  const notify = () => onSnapshot({ exists: true, metadata: {}, data: () => store.data });
  const ref = {
    onSnapshot(_options, callback) { onSnapshot = callback; notify(); },
    async set(data) { store.writes++; store.data = { ...data }; notify(); },
  };
  const auth = {
    currentUser: user, setPersistence: async () => {},
    onAuthStateChanged(callback) { callback(user); },
  };
  const firestore = Object.assign(() => ({ doc: path => {
    assert.equal(path, 'publicTools/yosenPredictor');
    return ref;
  } }), { FieldValue: { serverTimestamp: () => legacy.updatedAt } });
  const page = vm.createContext({
    document: {
      getElementById: get, querySelectorAll: () => [],
      body: { classList: { add() {}, remove() {} } },
    },
    firebase: {
      initializeApp: () => ({ auth: () => auth, firestore }), firestore,
      auth: { Auth: { Persistence: { SESSION: 'session' } } },
    },
  });
  vm.runInContext(inline, page);
  await vm.runInContext(shared, page);
  return {
    get,
    input(id, value, event = 'input') {
      get(id).value = value;
      get(id.startsWith('edit') ? 'publishForm' : id).listeners[event]();
    },
    submit: () => get('publishForm').onsubmit({ preventDefault() {} }),
  };
}

test('旧形式を読み込み、7時累計を復元して祝日と平日を再計算する', async () => {
  const store = { data: legacy, writes: 0 };
  const page = await openPredictor(store);
  assert.equal(page.get('score7').value, '6262720636');
  assert.equal(page.get('score12').value, '8818970636');
  assert.equal(page.get('valPred12').textContent, '222.48 億');
  page.input('dayType', 'weekday', 'change');
  assert.equal(page.get('valPred12').textContent, '230.83 億');
  assert.equal((await openPredictor(store)).get('valPred12').textContent, '222.48 億');
  assert.equal(store.writes, 0);
});

for (const score12 of [9000000000, 9000000001]) {
  test(`管理画面で ${score12} を公開し、新しいページで両方の整数を復元する`, async () => {
    const store = { data: legacy, writes: 0 };
    const page = await openPredictor(store, { uid: 'wJRZibao8FgMDqDDQ3csPdVuGkx1' });
    page.input('edit7', '6,000,000,000');
    page.input('edit12', String(score12));
    for (const [day, forecast] of [['weekday', '257.40 億'], ['holiday', '247.61 億']]) {
      page.input('editDay', day, 'change');
      assert.equal(page.get('valPred12').textContent, forecast);
    }
    assert.equal(page.get('previewNotice').hidden, false);
    assert.equal(store.writes, 0);
    await page.submit();
    assert.equal(store.writes, 1);
    assert.equal(store.data.score7, 6000000000);
    assert.equal(store.data.score12, score12);
    assert.equal(page.get('previewNotice').hidden, true);
    assert.equal(page.get('adminStatus').textContent, '公開データを更新しました。');

    const reloaded = await openPredictor(store);
    assert.equal(reloaded.get('score7').value, '6000000000');
    assert.equal(reloaded.get('score12').value, String(score12));
    assert.equal(reloaded.get('valPred12').textContent, '247.61 億');
    reloaded.input('dayType', 'weekday', 'change');
    assert.equal(reloaded.get('valPred12').textContent, '257.40 億');
  });
}

test('管理画面は空欄・不正な値・同値・逆転で予測と公開を止める', async () => {
  const store = { data: legacy, writes: 0 };
  const page = await openPredictor(store, { uid: 'wJRZibao8FgMDqDDQ3csPdVuGkx1' });
  for (const [id, value] of [['edit7', ''], ['edit7', 'abc'], ['edit12', '6262720636'], ['edit12', '6262720635']]) {
    page.input(id, value);
    assert.equal(page.get('result12').style.display, 'none');
    await page.submit();
    assert.equal(store.writes, 0);
    page.get('resetDraft').onclick();
    assert.equal(page.get('valPred12').textContent, '222.48 億');
  }
});
