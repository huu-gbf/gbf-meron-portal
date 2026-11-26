// Actual calculator DOM/events and sync controller; only the cloud transport is mocked.
// No resources, SDKs or production endpoints are loaded by JSDOM.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');
const {createSpeedCalculatorSync} = require('../member-sync');

const html = fs.readFileSync(path.join(__dirname, '../speed-calculator-folder/speed-calculator.html'), 'utf8');
const calculatorScript = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('const HELL_DATA ='));
assert(calculatorScript, 'actual calculator script must exist');
const levels = [90, 95, 100, 150, 200, 250];
const timesKey = 'gbf_unf_speed_calc_times';
const intervalKey = 'gbf_unf_speed_calc_interval';
const pendingKey = 'gbf_unf_speed_calc_sync_pending';
const copy = value => JSON.parse(JSON.stringify(value));
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function transport() {
  let remote = {hellTimesSec:{90:10,95:20,100:45,150:70,200:90,250:240}, intervalSec:3, revision:1};
  const listeners = new Set(), writes = [], held = [];
  let offline = false, holdNext = false;
  function commit(field, value) {
    const next = copy(remote);
    if (field === 'intervalSec') next.intervalSec = value;
    else next.hellTimesSec[field.split('.')[1]] = value;
    publish(next);
    return remote.revision;
  }
  function publish(next) {
    remote = {...copy(next), revision:remote.revision + 1};
    listeners.forEach(callback => callback(copy(remote)));
  }
  const client = {
    async getSpeedCalculatorSettings() { return copy(remote); },
    async initializeSpeedCalculatorSettings() { throw Error('existing settings must be reused'); },
    subscribeSpeedCalculatorSettings(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    async updateSpeedCalculatorField(field, value) {
      writes.push([field, value]);
      if (offline) throw Error('mock offline');
      if (holdNext) {
        holdNext = false;
        return new Promise(resolve => held.push(() => resolve(commit(field, value))));
      }
      return commit(field, value);
    }
  };
  return {client, writes, held, publish, read:() => copy(remote),
    offline:value => { offline = value; }, hold:() => { holdNext = true; }};
}
async function calculator(t, network, saved = {}) {
  const dom = new JSDOM(html, {runScripts:'outside-only', url:'http://localhost/'});
  const window = dom.window;
  // Wait for JSDOM's own lifecycle before dispatching the calculator's single initialization.
  await new Promise(resolve => window.document.addEventListener('DOMContentLoaded', resolve, {once:true}));
  for (const [key, value] of Object.entries(saved)) window.localStorage.setItem(key, value);
  let controller;
  window.MemberSync = {createSpeedCalculatorSync(...args) {
    controller = createSpeedCalculatorSync(...args);
    return controller;
  }};
  const context = dom.getInternalVMContext();
  vm.runInContext(calculatorScript, context);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  window.dispatchEvent(new window.CustomEvent('member-sync-connection', {detail:{ready:true, client:network.client}}));
  await settle();
  const input = (selector, value) => {
    const element = window.document.querySelector(selector);
    assert(element, selector);
    element.value = String(value);
    element.dispatchEvent(new window.Event('input', {bubbles:true}));
  };
  const readState = () => JSON.parse(vm.runInContext('JSON.stringify(state)', context));
  const storage = () => Object.fromEntries(Object.keys(window.localStorage).map(key => [key, window.localStorage.getItem(key)]));
  const pending = () => JSON.parse(window.localStorage.getItem(pendingKey) || '{}');
  const hide = () => window.dispatchEvent(new window.Event('pagehide'));
  const close = () => { controller.stop(); window.close(); };
  t.after(close);
  const editHellParts = (level, minValue, secValue, activePart = 'seconds') => {
    const minEl = window.document.querySelector('.table-time-input[data-hell="'+level+'"][data-time-part="minutes"]');
    const secEl = window.document.querySelector('.table-time-input[data-hell="'+level+'"][data-time-part="seconds"]');
    assert(minEl && secEl, 'comparison min/sec inputs for ' + level);
    minEl.value = String(minValue);
    secEl.value = String(secValue);
    (activePart === 'minutes' ? minEl : secEl).dispatchEvent(new window.Event('input', {bubbles:true}));
  };
  const editHell = (level, value) => {
    if (Number.isInteger(value) && value >= 0 && value <= 3599) {
      editHellParts(level, Math.floor(value / 60), value % 60);
    } else {
      editHellParts(level, '', value);
    }
  };
  const tableParts = () => levels.map(level => ({
    minutes: window.document.querySelector('.table-time-input[data-hell="'+level+'"][data-time-part="minutes"]').value,
    seconds: window.document.querySelector('.table-time-input[data-hell="'+level+'"][data-time-part="seconds"]').value
  }));
  return {window, controller, input, readState, storage, pending, hide, close,
    select:level => window.document.querySelector('.hell-card[data-level="'+level+'"]').click(),
    editHell,
    editHellParts,
    tableParts,
    editInterval:value => input('#inputInterval', value),
    table:() => tableParts().map(({minutes, seconds}) => Number(minutes) * 60 + Number(seconds))};
}
async function debounce(t) {
  t.mock.timers.tick(800);
  await settle();
}

test('each comparison HELL writes only its own field when selected and non-selected', async t => {
  for (const level of levels) for (const selected of [true, false]) {
    await t.test(level + ' HELL ' + (selected ? 'selected' : 'non-selected'), async t => {
      t.mock.timers.enable({apis:['setTimeout']});
      const network = transport(), page = await calculator(t, network);
      const selection = selected ? level : (level === 200 ? 90 : 200);
      page.select(selection);
      const before = network.read(), mainBefore = page.readState();
      const value = before.hellTimesSec[level] + 7;
      page.editHell(level, value);
      assert.equal(page.readState().comparisonTimes[level], value);
      assert.equal(JSON.parse(page.storage()[timesKey])[level], value);
      assert.equal(page.readState().selectedHell, selection);
      if (selected) {
        assert.equal(page.readState().minutes * 60 + page.readState().seconds, value);
        assert.equal(Number(page.window.document.querySelector('#inputMinutes').value) * 60
          + Number(page.window.document.querySelector('#inputSeconds').value), value);
      } else {
        assert.equal(page.readState().minutes, mainBefore.minutes);
        assert.equal(page.readState().seconds, mainBefore.seconds);
      }
      await debounce(t);
      assert.deepEqual(network.writes, [['hellTimesSec.'+level, value]]);
      const expected = copy(before);
      expected.hellTimesSec[level] = value;
      expected.revision++;
      assert.deepEqual(network.read(), expected);
    });
  }
});

test('non-selected comparison HELL persists offline and replays on online', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const network = transport(), page = await calculator(t, network);
  page.select(200);
  const before = network.read();
  network.offline(true);
  page.editHell(150, 65);
  assert.equal(page.readState().comparisonTimes[150], 65);
  assert.equal(JSON.parse(page.storage()[timesKey])[150], 65);
  assert.equal(page.table()[3], 65);
  assert.equal(page.readState().selectedHell, 200);
  await debounce(t); // mock transport rejects; use the existing failure-to-pending path.
  assert.equal(page.pending()['hellTimesSec.150'], 65);
  assert.deepEqual(network.read(), before);
  network.offline(false);
  page.window.dispatchEvent(new page.window.Event('online'));
  await settle();
  const expected = copy(before);
  expected.hellTimesSec[150] = 65;
  expected.revision++;
  assert.deepEqual(network.read(), expected);
  assert.deepEqual(page.pending(), {});
});

test('non-selected comparison HELL and interval survive pagehide before debounce', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const network = transport(), page = await calculator(t, network);
  page.select(200);
  page.editHell(150, 65);
  page.editInterval(4.5);
  t.mock.timers.tick(799);
  assert.equal(network.writes.length, 0);
  page.hide();
  assert.deepEqual(page.pending(), {'hellTimesSec.150':65, intervalSec:4.5});
  const saved = page.storage();
  page.close();
  const reloaded = await calculator(t, network, saved);
  await debounce(t);
  assert.equal(network.read().hellTimesSec[150], 65);
  assert.equal(network.read().intervalSec, 4.5);
  assert.equal(reloaded.readState().comparisonTimes[150], 65);
  assert.deepEqual(reloaded.pending(), {});
});

test('remote six HELL values and interval update all calculator outputs without writes', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const network = transport(), page = await calculator(t, network);
  page.select(200);
  const next = {hellTimesSec:{90:11,95:22,100:46,150:71,200:137,250:241}, intervalSec:5.7};
  network.publish(next);
  const state = page.readState(), doc = page.window.document;
  assert.deepEqual(state.comparisonTimes, next.hellTimesSec);
  assert.deepEqual(JSON.parse(page.storage()[timesKey]), next.hellTimesSec);
  assert.deepEqual(page.table(), levels.map(level => next.hellTimesSec[level]));
  assert.equal(state.minutes, 2);
  assert.equal(state.seconds, 17);
  assert.equal(doc.querySelector('#inputMinutes').value, '2');
  assert.equal(doc.querySelector('#inputSeconds').value, '17');
  assert.equal(state.intervalSec, 5.7);
  assert.equal(page.storage()[intervalKey], '5.7');
  assert.equal(doc.querySelector('#inputInterval').value, '5.7');
  assert.equal(doc.querySelector('#intervalDisplay').textContent, '5.7');
  assert.equal(doc.querySelector('#cycleTotalTimeDisplay').textContent, '142.7');
  assert.equal(doc.querySelector('#honorHourlyExact').textContent,
    `（約 ${Math.round(3600 / 142.7 * 20000000).toLocaleString()} pt / h）`);
  assert.equal(doc.querySelector('#goalTotalRuns').textContent, '50');
  assert.equal(doc.querySelector('#goalTotalTime').textContent, '1時間58分55秒');
  assert.equal(doc.querySelector('#goalTotalMeat').textContent, '1,000');
  await debounce(t);
  assert.deepEqual(network.writes, []);
});

test('focused comparison input accepts a remote value without a write loop', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const network = transport(), page = await calculator(t, network);
  const minInput = page.window.document.querySelector('.table-time-input[data-hell="150"][data-time-part="minutes"]');
  const secInput = page.window.document.querySelector('.table-time-input[data-hell="150"][data-time-part="seconds"]');
  secInput.focus();
  assert.equal(page.window.document.activeElement, secInput);
  const next = network.read(); next.hellTimesSec[150] = 65;
  network.publish(next);
  assert.equal(minInput.value, '1');
  assert.equal(secInput.value, '5');
  assert.equal(page.window.document.activeElement, secInput);
  assert.equal(page.readState().comparisonTimes[150], 65);
  await debounce(t);
  assert.deepEqual(network.writes, []);
});

for (const field of ['hellTimesSec.200', 'intervalSec']) {
  for (const useMinimum of [false, true]) {
    test('latest '+field+' edit'+(useMinimum ? ' at the minimum' : '')+' survives pagehide while an older write is in flight', async t => {
      t.mock.timers.enable({apis:['setTimeout']});
      const network = transport(), page = await calculator(t, network);
      const a = field === 'intervalSec' ? 4 : 101;
      const minimum = field === 'intervalSec' ? 0 : 1;
      const b = useMinimum ? minimum : (field === 'intervalSec' ? 5 : 102);
      const edit = value => field === 'intervalSec' ? page.editInterval(value) : page.editHell(200, value);
      const valueOf = settings => field === 'intervalSec' ? settings.intervalSec : settings.hellTimesSec[200];
      network.hold();
      edit(a);
      await debounce(t);
      assert.deepEqual(network.writes, [[field, a]], 'A must have started its cloud write');
      assert.equal(network.held.length, 1, 'A must still be in flight');
      edit(b);
      page.hide(); // B's debounce has not fired; execute actual flushPending -> stop listeners.
      const saved = page.storage();
      const localB = field === 'intervalSec' ? Number(saved[intervalKey]) : JSON.parse(saved[timesKey])[200];
      assert.equal(localB, b, 'B is initially preserved in normal localStorage');
      const pendingAtHide = page.pending();
      assert.equal(pendingAtHide[field], b, 'pagehide must persist newer B while A is in flight');
      assert.deepEqual(network.writes, [[field, a]], 'pagehide must not start another network write');
      network.held.shift()(); // Server accepts A after pagehide.
      await settle();
      assert.equal(valueOf(network.read()), a);
      assert.equal(page.pending()[field], b, 'late A success must not delete or overwrite persisted B');
      const savedAfterA = page.storage();
      page.close();
      network.hold(); // Inspect the cloud-A/local-B state before replay B is allowed to finish.
      const reloaded = await calculator(t, network, savedAfterA);
      const localValue = () => field === 'intervalSec' ? Number(reloaded.storage()[intervalKey])
        : JSON.parse(reloaded.storage()[timesKey])[200];
      assert.equal(valueOf(network.read()), a);
      assert.equal(localValue(), b, 'cloud A must not overwrite restored local B');
      assert.equal(reloaded.pending()[field], b, 'B must remain persisted until replay succeeds');
      assert.equal(network.held.length, 1);
      network.held.shift()();
      await settle();
      t.diagnostic(JSON.stringify({field, a, b, pendingAtHide, localBeforeReload:localB,
        localAfterReload:field === 'intervalSec' ? Number(reloaded.storage()[intervalKey])
          : JSON.parse(reloaded.storage()[timesKey])[200],
        pendingAfterReload:reloaded.pending(), cloudAfterReload:valueOf(network.read()), writes:network.writes}));
      assert.equal(valueOf(network.read()), b, 'latest B must converge through pending/replay after reload');
      assert.equal(localValue(), b);
      assert.deepEqual(reloaded.pending(), {}, 'successful replay must clear pending');
      assert.deepEqual(network.writes, [[field, a], [field, b]]);
    });
  }

  test('in-flight '+field+' without a newer edit creates no persistent pending', async t => {
    t.mock.timers.enable({apis:['setTimeout']});
    const network = transport(), page = await calculator(t, network);
    const a = field === 'intervalSec' ? 4 : 101;
    network.hold();
    if (field === 'intervalSec') page.editInterval(a); else page.editHell(200, a);
    await debounce(t);
    assert.deepEqual(network.writes, [[field, a]]);
    assert.equal(network.held.length, 1);
    page.hide();
    assert.deepEqual(page.pending(), {}, 'the already-sent A alone must not be persisted again');
    network.held.shift()();
    await settle();
    assert.deepEqual(page.pending(), {});
    assert.deepEqual(network.writes, [[field, a]]);
  });
}

test('new zero edit is rejected and a legacy cloud zero survives reload until corrected', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const network = transport(), page = await calculator(t, network);
  page.editHell(200, 0);
  await debounce(t);
  assert.deepEqual(network.writes, []);
  assert.equal(JSON.parse(page.storage()[timesKey])[200], 90);
  const legacy = network.read();
  legacy.hellTimesSec[200] = 0;
  network.publish(legacy);
  assert.equal(network.read().hellTimesSec[200], 0);
  assert.equal(JSON.parse(page.storage()[timesKey])[200], 0);
  const saved = page.storage(); page.close();
  const reloaded = await calculator(t, network, saved);
  assert.equal(reloaded.readState().comparisonTimes[200], 0);
  assert.equal(reloaded.table()[4], 0);
  assert.equal(reloaded.window.document.querySelector('#inputSeconds').value, '0');
  assert.equal(reloaded.window.document.querySelector('#totalBattleSeconds').textContent, '—');
  assert.equal(reloaded.window.document.querySelector('#btnCopyResult').disabled, true);
  reloaded.editHell(200, 75);
  await debounce(t);
  assert.deepEqual(network.writes, [['hellTimesSec.200', 75]]);
});

test('selection, target honor and recalculation do not write cloud settings', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const network = transport(), page = await calculator(t, network);
  const before = network.read();
  for (const level of levels) page.select(level);
  page.input('#inputTargetHonor', 2000000000);
  page.window.eval('updateCalculation()');
  await debounce(t);
  assert.deepEqual(network.writes, []);
  assert.deepEqual(network.read(), before);
});

test('200 and 250 HELL show and copy the same hourly rates with the correct material', async t => {
  const page = await calculator(t, transport());
  const doc = page.window.document;
  let copied;
  Object.defineProperty(page.window.navigator, 'clipboard', {value: {writeText: async text => { copied = text; }}});
  for (const [level, seconds, exact, runs, time, material, quantity] of [
    [200, 75, '923,076,923', '50', '1時間5分', '肉', '1,000'],
    [250, 240, '1,111,111,111', '14', '56分42秒', 'マリシャスクランプ', '280']
  ]) {
    page.select(level);
    page.editHell(level, seconds);
    const text = id => doc.getElementById(id).textContent;
    assert.equal(text('honorHourlyExact'), '（約 ' + exact + ' pt / h）');
    assert.equal(text('goalTotalRuns'), runs);
    assert.equal(text('goalTotalTime'), time);
    assert.equal(text('hourlyMaterial'), material);
    assert.equal(text('goalTotalMeat'), quantity);
    assert.equal(text('halfElixirHourly'), String(Math.round(3600 / (seconds + 3) * 50 / 75)));
    doc.getElementById('btnCopyResult').click();
    assert(copied.includes('(' + exact + ' pt)'));
    assert(copied.includes('消費' + material + 'ペース: ' + text('meatHourly') + ' 個/h'));
  }
});

test('time conversion matrix, upper/lower two-way sync, difficulty independence, legacy storage compatibility and invalid input handling', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const network = transport();
  const legacyTimes = {90:12, 95:59, 100:60, 150:75, 200:100, 250:140};
  network.publish({hellTimesSec:{...legacyTimes}, intervalSec:3.5});
  const page = await calculator(t, network, {
    [timesKey]: JSON.stringify(legacyTimes),
    [intervalKey]: '3.5'
  });
  const doc = page.window.document;
  const rowMin = level => doc.querySelector('.table-time-input[data-hell="'+level+'"][data-time-part="minutes"]');
  const rowSec = level => doc.querySelector('.table-time-input[data-hell="'+level+'"][data-time-part="seconds"]');

  // D. 保存データ互換性 (旧版合計秒数データの読み込みと分・秒復元)
  assert.deepEqual(page.tableParts(), [
    {minutes:'0', seconds:'12'},
    {minutes:'0', seconds:'59'},
    {minutes:'1', seconds:'0'},
    {minutes:'1', seconds:'15'},
    {minutes:'1', seconds:'40'},
    {minutes:'2', seconds:'20'}
  ]);
  assert.equal(doc.querySelector('#inputMinutes').value, '1');
  assert.equal(doc.querySelector('#inputSeconds').value, '40');
  assert.equal(doc.querySelector('#inputInterval').value, '3.5');

  // A. 時間変換 (12, 59, 60, 75, 100, 140, 240, 3599)
  const cases = [
    [12, 0, 12],
    [59, 0, 59],
    [60, 1, 0],
    [75, 1, 15],
    [100, 1, 40],
    [140, 2, 20],
    [240, 4, 0],
    [3599, 59, 59]
  ];
  page.select(250);
  for (const [total, min, sec] of cases) {
    // Upper -> Lower
    page.input('#inputMinutes', min);
    page.input('#inputSeconds', sec);
    assert.equal(doc.querySelector('#totalBattleSeconds').textContent, String(total));
    assert.equal(rowMin(250).value, String(min));
    assert.equal(rowSec(250).value, String(sec));
    assert.equal(JSON.parse(page.storage()[timesKey])[250], total);
  }
  for (const [total, min, sec] of [...cases].reverse()) {
    // Lower -> Upper
    page.editHellParts(250, min, sec);
    assert.equal(doc.querySelector('#inputMinutes').value, String(min));
    assert.equal(doc.querySelector('#inputSeconds').value, String(sec));
    assert.equal(doc.querySelector('#totalBattleSeconds').textContent, String(total));
    assert.equal(JSON.parse(page.storage()[timesKey])[250], total);
  }

  // B. 上下の連動 & 時速計算結果の一致
  page.select(250);
  page.input('#inputMinutes', 1);
  page.input('#inputSeconds', 40);
  assert.equal(rowMin(250).value, '1');
  assert.equal(rowSec(250).value, '40');
  const row250Cells = doc.querySelectorAll('#comparisonTableBody tr')[5].children;
  assert.equal(doc.querySelector('#honorHourlyFormatted').textContent + doc.querySelector('#honorHourlyUnit').textContent,
    row250Cells[5].textContent.trim());
  assert.equal(Number(doc.querySelector('#clearsHourly').textContent).toFixed(1),
    row250Cells[4].querySelector('span').textContent.trim());

  page.editHellParts(250, 2, 20);
  assert.equal(doc.querySelector('#inputMinutes').value, '2');
  assert.equal(doc.querySelector('#inputSeconds').value, '20');
  assert.equal(doc.querySelector('#totalBattleSeconds').textContent, '140');
  assert.equal(doc.querySelector('#honorHourlyFormatted').textContent + doc.querySelector('#honorHourlyUnit').textContent,
    row250Cells[5].textContent.trim());

  // C. 難易度ごとの独立性
  page.select(200);
  page.input('#inputMinutes', 1);
  page.input('#inputSeconds', 15);
  page.select(250);
  page.input('#inputMinutes', 1);
  page.input('#inputSeconds', 40);
  page.select(200);
  assert.equal(doc.querySelector('#inputMinutes').value, '1');
  assert.equal(doc.querySelector('#inputSeconds').value, '15');
  page.select(250);
  assert.equal(doc.querySelector('#inputMinutes').value, '1');
  assert.equal(doc.querySelector('#inputSeconds').value, '40');
  // Editing non-selected 200HELL in table must not change selected 250HELL
  page.editHellParts(200, 1, 30);
  assert.equal(page.readState().selectedHell, 250);
  assert.equal(doc.querySelector('#inputMinutes').value, '1');
  assert.equal(doc.querySelector('#inputSeconds').value, '40');
  assert.equal(JSON.parse(page.storage()[timesKey])[200], 90);
  assert.equal(JSON.parse(page.storage()[timesKey])[250], 100);

  await debounce(t);
  network.writes.length = 0;

  // F. 不正入力 (空欄, 負数, 小数, 60秒以上, 60分以上, 0分0秒)
  const invalidPairs = [
    ['', '20'],
    ['1', ''],
    ['-1', '20'],
    ['1', '-5'],
    ['1.5', '0'],
    ['1', '2.5'],
    ['1', '60'],
    ['60', '0'],
    ['0', '0']
  ];
  for (const [badMin, badSec] of invalidPairs) {
    page.editHellParts(250, badMin, badSec);
    assert.equal(doc.querySelector('#timeError').hidden, false, `invalid ${badMin}:${badSec} must show error`);
    assert.equal(doc.querySelector('#totalBattleSeconds').textContent, '—');
    assert.equal(doc.querySelector('#honorHourlyFormatted').textContent, '—');
    assert.equal(doc.querySelector('#btnCopyResult').disabled, true);
    assert.equal(row250Cells[5].querySelector('span').textContent, '—');
    assert.equal(JSON.parse(page.storage()[timesKey])[250], 100, 'invalid input must not overwrite saved value');
  }
  await debounce(t);
  assert.deepEqual(network.writes, [], 'invalid inputs must never be synced');

  // 正しい値に訂正すると正常に復帰すること
  page.editHellParts(250, 2, 20);
  assert.equal(doc.querySelector('#timeError').hidden, true);
  assert.equal(doc.querySelector('#totalBattleSeconds').textContent, '140');
  assert.equal(doc.querySelector('#btnCopyResult').disabled, false);
  assert.equal(JSON.parse(page.storage()[timesKey])[250], 140);
  await debounce(t);
  assert.deepEqual(network.writes, [['hellTimesSec.250', 140]]);

  // 他端末からの同期が入力途中の値（Backspace消去中や先頭0入力中）を不意に上書きしないこと
  const sec250 = rowSec(250);
  sec250.focus();
  sec250.value = '';
  sec250.dispatchEvent(new page.window.Event('input', {bubbles:true}));
  assert.equal(sec250.value, '');
  assert.equal(doc.querySelector('#inputSeconds').value, '');
  const remoteWhileTyping = network.read();
  remoteWhileTyping.hellTimesSec[90] = 15;
  remoteWhileTyping.hellTimesSec[250] = 180;
  network.publish(remoteWhileTyping);
  assert.equal(sec250.value, '', 'in-progress empty seconds input must not be overwritten by remote snapshot while focused');
  assert.equal(doc.querySelector('#inputSeconds').value, '', 'linked upper seconds input must also keep in-progress empty state');
  sec250.value = '05';
  sec250.dispatchEvent(new page.window.Event('input', {bubbles:true}));
  const remoteOtherField = network.read();
  remoteOtherField.hellTimesSec[95] = 25;
  network.publish(remoteOtherField);
  assert.equal(sec250.value, '05', 'focused leading-zero input must not be reformatted by unrelated remote snapshot');
  assert.equal(doc.querySelector('#totalBattleSeconds').textContent, '125');
});
