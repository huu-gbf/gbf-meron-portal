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
  return {window, controller, input, readState, storage, pending, hide, close,
    select:level => window.document.querySelector('.hell-card[data-level="'+level+'"]').click(),
    editHell:(level, value) => input('.table-time-input[data-hell="'+level+'"]', value),
    editInterval:value => input('#inputInterval', value),
    table:() => levels.map(level => Number(window.document.querySelector('.table-time-input[data-hell="'+level+'"]').value))};
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
  assert.equal(doc.querySelector('#goalTotalTime').textContent, '1時間 58分');
  assert.equal(doc.querySelector('#goalTotalMeat').textContent, '1,000');
  await debounce(t);
  assert.deepEqual(network.writes, []);
});

test('focused comparison input accepts a remote value without a write loop', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const network = transport(), page = await calculator(t, network);
  const input = page.window.document.querySelector('.table-time-input[data-hell="150"]');
  input.focus();
  assert.equal(page.window.document.activeElement, input);
  const next = network.read(); next.hellTimesSec[150] = 65;
  network.publish(next);
  assert.equal(input.value, '65');
  assert.equal(page.window.document.activeElement, input);
  assert.equal(page.readState().comparisonTimes[150], 65);
  await debounce(t);
  assert.deepEqual(network.writes, []);
});

for (const field of ['hellTimesSec.200', 'intervalSec']) {
  for (const latestZero of [false, true]) {
    test('latest '+field+' edit'+(latestZero ? ' of zero' : '')+' survives pagehide while an older write is in flight', async t => {
      t.mock.timers.enable({apis:['setTimeout']});
      const network = transport(), page = await calculator(t, network);
      const a = field === 'intervalSec' ? 4 : 101;
      const b = latestZero ? 0 : (field === 'intervalSec' ? 5 : 102);
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

test('comparison zero survives cloud propagation and reload', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const network = transport(), page = await calculator(t, network);
  page.editHell(200, 0);
  await debounce(t);
  assert.equal(network.read().hellTimesSec[200], 0);
  assert.equal(JSON.parse(page.storage()[timesKey])[200], 0);
  const saved = page.storage(); page.close();
  const reloaded = await calculator(t, network, saved);
  assert.equal(reloaded.readState().comparisonTimes[200], 0);
  assert.equal(reloaded.table()[4], 0);
  assert.equal(reloaded.window.document.querySelector('#inputSeconds').value, '0');
  assert.equal(reloaded.window.document.querySelector('#totalBattleSeconds').textContent, '1');
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
