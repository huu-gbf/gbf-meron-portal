/* Offline browser regression against the S1-2 checkpoint. Run with the bundled
 * Playwright NODE_PATH. No HTTP request is continued to a network transport. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const BASE = '1a300a6074b51a8cf33c92777b26981791f30345';
const ORIGIN = 'http://127.0.0.1:18863';
const URL = ORIGIN + '/awakening-manager.html';
const GW = 'gbf_awakening_data_gw';
const HIGH = 'gbf_awakening_data_high';
const artifactDir = process.env.ARTIFACT_SYNC_ARTIFACT_DIR;
const source = fs.readFileSync(path.join(ROOT, 'awakening-manager.html'), 'utf8');
const baseline = execFileSync('git', ['show', BASE + ':awakening-manager.html'],
  {cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024});
const css = fs.readFileSync(path.join(ROOT, 'css/tailwind.min.css'), 'utf8');
const catalogSource = fs.readFileSync(path.join(ROOT, 'artifact-catalog.js'), 'utf8');

async function open(browser, html, viewport, seed = {}) {
  // Browser preconnects do not pass through Playwright request interception.
  const fixtureHtml = html.replace(/<link\b[^>]*\brel="preconnect"[^>]*>/gi, '');
  const context = await browser.newContext({viewport, serviceWorkers: 'block'});
  const requests = [], unexpected = [], exceptions = [], consoleErrors = [];
  await context.route('**/*', async route => {
    const url = new globalThis.URL(route.request().url());
    requests.push(url.href);
    if (url.href === URL) return route.fulfill({contentType: 'text/html', body: fixtureHtml});
    if (url.origin === ORIGIN && url.pathname === '/artifact-catalog.js') {
      return route.fulfill({contentType: 'application/javascript', body: catalogSource});
    }
    if (url.origin === ORIGIN && url.pathname === '/css/tailwind.min.css') {
      return route.fulfill({contentType: 'text/css', body: css});
    }
    // Same local stylesheet and system fonts for checkpoint and candidate. The
    // remote Tailwind compiler and Google Fonts are never downloaded/executed.
    if (url.hostname === 'cdn.tailwindcss.com' && url.pathname === '/') {
      return route.fulfill({contentType: 'application/javascript',
        body: 'window.tailwind={};document.write(\'<link rel="stylesheet" href="/css/tailwind.min.css">\');'});
    }
    if (url.hostname === 'fonts.googleapis.com') {
      return route.fulfill({contentType: 'text/css', body: ''});
    }
    if (url.origin === ORIGIN && url.pathname === '/manifest.webmanifest') {
      return route.fulfill({contentType: 'application/manifest+json', body: '{}'});
    }
    if (url.origin === ORIGIN && ['/favicon.ico', '/icons/apple-touch-icon.png'].includes(url.pathname)) {
      return route.fulfill({status: 204, body: ''});
    }
    unexpected.push(url.href);
    return route.abort();
  });
  await context.addInitScript(seed => {
    if (location.origin === 'null' || sessionStorage.getItem('__artifact_seeded')) return;
    for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
    sessionStorage.setItem('__artifact_seeded', '1');
  }, seed);
  const page = await context.newPage();
  page.on('pageerror', error => exceptions.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(URL, {waitUntil: 'load'});
  await page.waitForFunction(() => document.querySelectorAll('.item-card').length === 63);
  return {context, page, requests, unexpected, exceptions, consoleErrors};
}

async function state(page) {
  return page.evaluate(() => {
    const body = document.body.cloneNode(true);
    body.querySelectorAll('script').forEach(script => {
      // Ignore only inert script-separator whitespace when catalog moves to a
      // shared script. All rendered controls and pixel comparisons stay exact.
      const next = script.nextSibling;
      if (next?.nodeType === Node.TEXT_NODE && next.textContent.trim() === '') next.remove();
      script.remove();
    });
    const settings = JSON.parse(JSON.stringify(userSettings));
    return {
      mode: currentMode,
      settings,
      storage: Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)])),
      counts: ['list-slot12', 'list-slot3', 'list-slot4'].map(id => document.getElementById(id).children.length),
      values: ['dataSlot12', 'dataSlot3', 'dataSlot4'].map((_, i) => {
        const list = [dataSlot12, dataSlot3, dataSlot4][i];
        return list.map((item, index) => ({key: ['s12', 's3', 's4'][i] + '_' + index,
          expectedDefault: item.values ? item.values[item.values.length - 1] : item.value}));
      }).flat(),
      summary: ['summary-slot12', 'summary-slot3', 'summary-slot4'].map(id => document.getElementById(id).textContent.trim()),
      memos: Array.from(document.querySelectorAll('#memo-container > div')).map(row =>
        Array.from(row.querySelectorAll('input')).map(input => input.value)),
      dom: body.innerHTML,
      width: {viewport: innerWidth, document: document.documentElement.scrollWidth,
        overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth)}
    };
  });
}

async function same(pair, label) {
  const before = await state(pair[0].page), after = await state(pair[1].page);
  assert.deepEqual(after, before, label + ': checkpoint and candidate observable state');
  assert(after.width.overflow <= before.width.overflow, label + ': no new horizontal overflow');
  assert(Object.keys(after.storage).every(key => [GW, HIGH].includes(key)), label + ': legacy keys only');
  for (const raw of Object.values(after.storage)) {
    let data;
    try { data = JSON.parse(raw); } catch { continue; } // Existing malformed bytes must also remain untouched.
    assert.equal(Object.hasOwn(data, 'catalogVersion'), false, label + ': no automatic projection writeback');
    assert.equal(Object.hasOwn(data, 'items'), false, label + ': no stable ID map writeback');
  }
  return after;
}

function defaults(snapshot) {
  assert.deepEqual(snapshot.counts, [14, 20, 29]);
  assert.equal(Object.keys(snapshot.settings).length, 64);
  for (const item of snapshot.values) {
    assert.deepEqual(snapshot.settings[item.key], {needed: false, selectedValue: item.expectedDefault});
  }
  assert.deepEqual(snapshot.memos, [['', '']]);
}

async function each(pair, action) { for (const device of pair) await action(device.page); }

async function editMode(page, mode) {
  await page.locator('#mode-btn-' + mode).click();
  for (const [tab, list, value] of [
    ['slot12', 'list-slot12', mode === 'gw' ? '1320' : '1680'],
    ['slot3', 'list-slot3', mode === 'gw' ? '2.2%' : '2.8%'],
    ['slot4', 'list-slot4', null]
  ]) {
    await page.locator('#nav-' + tab).click();
    await page.locator('#' + list + ' input[type=checkbox]').first().check({force: true});
    if (value) await page.locator('#' + list + ' select').first().selectOption(value);
  }
  await page.locator('#nav-summary').click();
  const rows = page.locator('#memo-container > div');
  await rows.nth(0).locator('input').nth(0).fill(mode + ' キャラ <>&"');
  await rows.nth(0).locator('input').nth(1).fill(mode + ' メモ・保持');
  await rows.nth(1).locator('input').nth(0).fill('削除するキャラ');
  await rows.nth(1).locator('input').nth(1).fill('削除するメモ');
  assert.equal(await rows.count(), 3, 'typing in last row appends one empty memo');
  await rows.nth(1).locator('button').click();
  assert.equal(await rows.count(), 2, 'memo deletion retains first memo and one empty row');
}

async function dialogReset(page, accept) {
  const dialog = new Promise(resolve => page.once('dialog', async dialog => {
    assert.equal(dialog.type(), 'confirm');
    assert.match(dialog.message(), /必要\/不要設定と数値をすべてリセット/);
    if (accept) await dialog.accept(); else await dialog.dismiss();
    resolve();
  }));
  await page.locator('button[onclick="resetAllData()"]').click();
  await dialog;
}

async function pixels(pair, label) {
  const images = [];
  for (const [index, device] of pair.entries()) {
    await device.page.evaluate(() => {
      document.activeElement?.blur();
      scrollTo(0, 0);
    });
    await device.page.mouse.move(0, 0);
    await device.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const buffer = await device.page.screenshot({fullPage: true, animations: 'disabled', caret: 'hide'});
    if (artifactDir) {
      fs.mkdirSync(artifactDir, {recursive: true});
      fs.writeFileSync(path.join(artifactDir, label + '-' + (index ? 'candidate' : 'checkpoint') + '.png'), buffer);
    }
    images.push(PNG.sync.read(buffer));
  }
  assert.equal(images[1].width, images[0].width, label + ': screenshot width');
  assert.equal(images[1].height, images[0].height, label + ': screenshot height');
  assert.deepEqual(images[1].data, images[0].data, label + ': rendered pixel difference is zero');
}

test('artifact browser preserves legacy UI and storage without any service connection', {timeout: 180000}, async t => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    for (const [name, viewport] of [['pc', {width: 1440, height: 1000}], ['mobile', {width: 390, height: 844}]]) {
      await t.test(name + ' checkpoint comparison', async t => {
        const pair = [await open(browser, baseline, viewport), await open(browser, source, viewport)];
        let gwSaved, highSaved;
        try {
          await t.test('default 63 effects and one memo do not cause any local write', async () => {
            const snapshot = await same(pair, name + ' initial');
            defaults(snapshot);
            assert.deepEqual(snapshot.storage, {});
            await pixels(pair, name + '-initial');
          });

          await t.test('gw checkbox/select/memo save, append/delete and summary retain legacy meaning', async () => {
            await each(pair, page => editMode(page, 'gw'));
            const snapshot = await same(pair, name + ' gw edits');
            gwSaved = snapshot.storage[GW];
            assert.equal(snapshot.storage[HIGH], undefined);
            assert.equal(snapshot.settings.s12_0.needed, true);
            assert.equal(snapshot.settings.s12_0.selectedValue, '1320');
            assert.equal(snapshot.settings.s3_0.selectedValue, '2.2%');
            assert.equal(snapshot.settings.s4_0.selectedValue, '3%');
            assert(snapshot.summary[0].includes('攻撃力'));
            assert(snapshot.summary[0].includes('1320'));
            assert(snapshot.summary[1].includes('2.2%'));
            assert(snapshot.summary[2].includes('3%'));
            assert.deepEqual(snapshot.memos, [['gw キャラ <>&"', 'gw メモ・保持'], ['', '']]);
          });

          await t.test('high mode starts independently then saves its own checkbox/select/memos', async () => {
            await each(pair, page => page.locator('#mode-btn-high').click());
            const emptyHigh = await same(pair, name + ' high defaults');
            defaults(emptyHigh);
            assert.equal(emptyHigh.storage[GW], gwSaved);
            assert.equal(emptyHigh.storage[HIGH], undefined);
            await each(pair, page => editMode(page, 'high'));
            const snapshot = await same(pair, name + ' high edits');
            highSaved = snapshot.storage[HIGH];
            assert.equal(snapshot.storage[GW], gwSaved);
            assert.equal(snapshot.settings.s12_0.selectedValue, '1680');
            assert.equal(snapshot.settings.s3_0.selectedValue, '2.8%');
            assert.deepEqual(snapshot.memos, [['high キャラ <>&"', 'high メモ・保持'], ['', '']]);
            await pixels(pair, name + '-high-summary');
          });

          await t.test('reload restores gw then switching modes restores each saved value and memo', async () => {
            await each(pair, page => page.reload({waitUntil: 'load'}));
            let snapshot = await same(pair, name + ' reload gw');
            assert.equal(snapshot.mode, 'gw');
            assert.equal(snapshot.settings.s12_0.selectedValue, '1320');
            assert.equal(snapshot.memos[0][0], 'gw キャラ <>&"');
            await each(pair, page => page.locator('#mode-btn-high').click());
            snapshot = await same(pair, name + ' restore high');
            assert.equal(snapshot.settings.s12_0.selectedValue, '1680');
            assert.equal(snapshot.memos[0][0], 'high キャラ <>&"');
            assert.equal(snapshot.storage[GW], gwSaved);
            assert.equal(snapshot.storage[HIGH], highSaved);
          });

          await t.test('reset cancel leaves values, memos and both modes untouched', async () => {
            const before = await state(pair[1].page);
            await each(pair, page => dialogReset(page, false));
            const after = await same(pair, name + ' cancel reset');
            assert.deepEqual(after, before);
          });

          await t.test('high reset confirms local {} and memory defaults without touching gw', async () => {
            await each(pair, page => dialogReset(page, true));
            const snapshot = await same(pair, name + ' high reset');
            assert.equal(snapshot.storage[HIGH], '{}');
            assert.equal(snapshot.storage[GW], gwSaved);
            defaults(snapshot);
            await each(pair, page => page.reload({waitUntil: 'load'}));
            await each(pair, page => page.locator('#mode-btn-high').click());
            const reloaded = await same(pair, name + ' high reset reload');
            defaults(reloaded);
            assert.equal(reloaded.storage[HIGH], '{}', 'render defaults are not automatically saved');
          });

          await t.test('gw reset is isolated and deleting its last memo recreates one empty memo', async () => {
            await each(pair, page => page.locator('#mode-btn-gw').click());
            await each(pair, page => dialogReset(page, true));
            const reset = await same(pair, name + ' gw reset');
            defaults(reset);
            assert.equal(reset.storage[GW], '{}');
            assert.equal(reset.storage[HIGH], '{}');
            await each(pair, async page => {
              await page.locator('#nav-summary').click();
              await page.locator('#memo-container button').click();
            });
            const snapshot = await same(pair, name + ' last memo delete');
            assert.deepEqual(snapshot.memos, [['', '']]);
            assert.deepEqual(JSON.parse(snapshot.storage[GW]).memos, [{character: '', artifact: ''}]);
          });

          await t.test('unknown legacy fields survive loading and subsequent legacy saves', async () => {
            const legacy = {s12_0: {needed: true, selectedValue: '1440', extra: {keep: 'known-extra'}},
              unknownLegacy: {keep: ['unknown', 5]},
              memos: [{character: '既存メモ', artifact: 'local専用 <>&'}]};
            await each(pair, async page => {
              await page.evaluate(({key, data}) => localStorage.setItem(key, JSON.stringify(data)), {key: GW, data: legacy});
              await page.reload({waitUntil: 'load'});
            });
            let snapshot = await same(pair, name + ' unknown legacy load');
            assert.equal(snapshot.storage[GW], JSON.stringify(legacy), 'load does not clean or migrate saved object');
            await each(pair, async page => {
              await page.locator('#list-slot12 input[type=checkbox]').first().uncheck({force: true});
            });
            snapshot = await same(pair, name + ' unknown legacy save');
            const saved = JSON.parse(snapshot.storage[GW]);
            assert.deepEqual(saved.unknownLegacy, legacy.unknownLegacy);
            assert.deepEqual(saved.s12_0.extra, legacy.s12_0.extra);
            assert.deepEqual(saved.memos, legacy.memos);
          });

          await t.test('projection remains pure in browser with legacy memo and storage untouched', async () => {
            const result = await pair[1].page.evaluate(() => {
              const raw = localStorage.getItem('gbf_awakening_data_gw');
              const input = JSON.parse(raw);
              const serialized = JSON.stringify(input);
              const freeze = object => {
                Object.freeze(object);
                for (const value of Object.values(object)) if (value && typeof value === 'object') freeze(value);
                return object;
              };
              const before = Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]));
              const projection = projectArtifactSettings(freeze(input));
              return {serialized, inputAfter: JSON.stringify(input), projection,
                before, after: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]))};
            });
            assert.equal(result.inputAfter, result.serialized);
            assert.deepEqual(result.after, result.before);
            assert.equal(result.projection.catalogVersion, 1);
            assert.deepEqual(Object.keys(result.projection).sort(), ['catalogVersion', 'items']);
            for (const item of Object.values(result.projection.items)) {
              assert(Object.keys(item).every(key => ['needed', 'selectedValue'].includes(key)));
            }
            assert(!JSON.stringify(result.projection).includes('既存メモ'));
            await same(pair, name + ' pure projection');
          });

          await t.test('malformed JSON safely restores defaults without rewriting stored bytes', async () => {
            await each(pair, async page => {
              await page.evaluate(key => localStorage.setItem(key, '{broken json'), GW);
              await page.reload({waitUntil: 'load'});
            });
            const snapshot = await same(pair, name + ' malformed JSON');
            defaults(snapshot);
            assert.equal(snapshot.storage[GW], '{broken json');
          });

          await t.test('no console exceptions, service requests or unsupported URLs occurred', async () => {
            for (const device of pair) {
              assert.deepEqual(device.exceptions, []);
              assert.deepEqual(device.consoleErrors, []);
              assert.deepEqual(device.unexpected, []);
              assert.equal(device.requests.filter(url => /firebase|firestore|identitytoolkit|securetoken|member-sync|run\.app|cloudfunctions/i.test(url)).length, 0);
              assert.equal(await device.page.evaluate(() => typeof firebase), 'undefined');
              assert.equal(await device.page.evaluate(() => typeof MemberSync), 'undefined');
            }
          });
        } finally {
          for (const device of pair) await device.context.close();
        }
      });
    }
  } finally { await browser.close(); }
});
