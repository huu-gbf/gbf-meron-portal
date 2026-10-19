/*
 * Local-only browser integration tests for the feedback MVP.
 * Start Auth (9099) and Firestore (8080) emulators with this repository's Rules,
 * then run with the bundled Playwright package on NODE_PATH:
 *   node tests/portal-feedback.browser.test.cjs
 * Add --serve to keep the isolated HTTP fixture open for manual checks.
 * Screenshots and JSON results are written only to a new OS temporary folder.
 * Synthetic composition events exercise event handling; real OS IME is not tested.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = 'demo-feedback-mvp';
const COLLECTION = 'portalFeedback';
const ADMIN_UID = 'wJRZibao8FgMDqDDQ3csPdVuGkx1';
const ADMIN_EMAIL = 'feedback-admin@example.test';
const OTHER_EMAIL = 'feedback-other@example.test';
const PASSWORD = 'LocalFeedback123!';
const FIRESTORE = 'http://127.0.0.1:8080';
const AUTH = 'http://127.0.0.1:9099';
const OUTPUT = fs.mkdtempSync(path.join(os.tmpdir(), 'gbf-feedback-browser-'));
const LOCAL_CONFIG = {
  firebaseConfig: { projectId: PROJECT, apiKey: 'local-only', appId: 'feedback-local' },
  firestoreHost: '127.0.0.1', firestorePort: 8080,
  authEmulatorUrl: AUTH
};
const results = [];
const browserMetadata = {};

function assertLoopback(url) {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, '127.0.0.1', 'Fixture may contact only 127.0.0.1');
  assert.equal(parsed.protocol, 'http:');
  return parsed;
}

async function localRequest(url, { method = 'GET', body, owner = true, allow404 = false } = {}) {
  assertLoopback(url);
  const response = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(owner ? { Authorization: 'Bearer owner' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  if (allow404 && response.status === 404) return null;
  assert.ok(response.ok, `${method} ${url}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

function documentUrl(id = '') {
  return `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${COLLECTION}${id ? `/${encodeURIComponent(id)}` : ''}`;
}

async function clearFeedback() {
  const all = await localRequest(documentUrl() + '?pageSize=1000', { allow404: true });
  for (const document of all?.documents || []) {
    await localRequest(`${FIRESTORE}/v1/${document.name}`, { method: 'DELETE' });
  }
}

function feedbackFields(index, override = {}) {
  const data = {
    schemaVersion: 1, type: ['bug', 'request', 'other'][index % 3],
    message: `Fixture report ${String(index).padStart(2, '0')}\nSecond line`,
    name: `Fixture ${index}`, target: 'Fixture screen',
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    ...override
  };
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key,
    key === 'schemaVersion' ? { integerValue: String(value) } :
      key === 'createdAt' ? { timestampValue: value } : { stringValue: value }
  ]));
}

async function seedFeedback(count = 31) {
  await clearFeedback();
  for (let index = 0; index < count; index++) {
    await localRequest(documentUrl(`seed-${String(index).padStart(2, '0')}`), {
      method: 'PATCH', body: { fields: feedbackFields(index) }
    });
  }
}

async function createFixtureAccounts() {
  // The emulator-only admin import gives the fixture the exact Rules admin UID.
  const imported = await localRequest(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:batchCreate`, {
    method: 'POST', body: { allowOverwrite: true, users: [
      { localId: ADMIN_UID, email: ADMIN_EMAIL, rawPassword: PASSWORD, emailVerified: true },
      { localId: 'feedback-fixture-non-admin', email: OTHER_EMAIL, rawPassword: PASSWORD, emailVerified: true }
    ] }
  });
  assert.equal(imported.error?.length || 0, 0, `Fixture account import failed: ${JSON.stringify(imported)}`);
}

function fixtureHtml(filename) {
  return fs.readFileSync(path.join(ROOT, filename), 'utf8')
    .replace(/<link\b[^>]*\brel=["'](?:preconnect|dns-prefetch)["'][^>]*>/gi, '')
    .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/(firebase-(?:app|auth|firestore)-compat\.js)/g, '/__feedback_sdk/$1')
    .replace(/<script\b[^>]*\bsrc=["'][^"']*firebase-config\.js["'][^>]*>\s*<\/script>/gi,
      '<script src="/__feedback_fixture_config.js"></script>');
}

async function startFixture() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/__feedback_fixture_config.js' || url.pathname === '/firebase-config.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`globalThis.PORTAL_FEEDBACK_LOCAL=${JSON.stringify(LOCAL_CONFIG)};`);
      return;
    }
    const sdk = /^\/__feedback_sdk\/(firebase-(?:app|auth|firestore)-compat\.js)$/.exec(url.pathname);
    if (sdk) {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end(fs.readFileSync(path.join(ROOT, 'node_modules/firebase', sdk[1])));
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const filename = path.resolve(ROOT, relative);
    if (!filename.startsWith(ROOT + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile() || relative.startsWith('.')) {
      response.writeHead(404); response.end('Not found'); return;
    }
    const ext = path.extname(filename);
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[ext];
    if (!type || relative.startsWith('node_modules')) {
      response.writeHead(404); response.end('Not found'); return;
    }
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(relative === 'feedback.html' || relative === 'feedback-admin.html' ? fixtureHtml(relative) : fs.readFileSync(filename));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin };
}

async function eventually(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { await check(); return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`, { cause: last });
}

async function record(name, action) {
  const started = Date.now();
  try {
    await action();
    results.push({ name, passed: true, durationMs: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, durationMs: Date.now() - started, error: error.stack });
    throw error;
  }
}

async function main() {
  const { server, origin } = await startFixture();
  if (process.argv.includes('--serve')) {
    console.log(`Feedback local fixture: ${origin}/feedback.html`);
    console.log(`Admin local fixture: ${origin}/feedback-admin.html`);
    console.log('Only local emulator data is used; Ctrl+C stops this HTTP fixture.');
    return;
  }
  try {
    await localRequest(`${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${COLLECTION}?pageSize=1`, { allow404: true });
    await createFixtureAccounts();
    // The UI scenarios are defined below; both real Edge viewports share this fixture.
    await runBrowserScenarios(origin);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(OUTPUT, 'results.json'), JSON.stringify({
      browser: 'Microsoft Edge (headless, installed channel)', project: PROJECT,
      ...browserMetadata,
      network: 'Loopback HTTP only; all other browser requests aborted',
      ime: 'Synthetic composition event handling tested; real OS IME not tested',
      results
    }, null, 2));
    console.log(`Browser artifacts: ${OUTPUT}`);
  }
}

async function allFeedback() {
  return (await localRequest(documentUrl() + '?pageSize=1000', { allow404: true }))?.documents || [];
}

async function assertCount(page, field, count) {
  const text = await page.locator(`#feedback-${field}-count`).textContent();
  const numerator = /^\s*([\d,，]+)\s*\//.exec(text);
  assert.ok(numerator, `${field} counter has a current / maximum value: ${text}`);
  assert.equal(Number(numerator[1].replace(/[,，]/g, '')), count, `${field} codepoint counter`);
}

async function assertNoOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page must fit the viewport width');
}

async function assertActiveCaret(page, id, position, expectedValue) {
  const state = await page.locator(`#${id}`).evaluate(element => ({
    focused: document.activeElement === element,
    start: element.selectionStart, end: element.selectionEnd, value: element.value
  }));
  assert.equal(state.focused, true, `${id} retains focus`);
  assert.equal(state.start, position, `${id} caret start`);
  assert.equal(state.end, position, `${id} caret end`);
  assert.equal(state.value, expectedValue, `${id} content`);
}

async function editingScenario(page, context, origin) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  for (const field of ['message', 'name', 'target']) {
    const id = `feedback-${field}`;
    const input = page.locator(`#${id}`);
    await input.fill('');
    await input.focus();
    await page.keyboard.type('abcdef', { delay: 15 });
    await page.keyboard.press('Backspace');
    await assertActiveCaret(page, id, 5, 'abcde');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('X');
    await assertActiveCaret(page, id, 3, 'abXcde');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Copy text');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+C');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Control+V');
    await assertActiveCaret(page, id, 9, 'Copy text');
    await page.evaluate(() => navigator.clipboard.writeText('貼り付け😀'));
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+V');
    await assertActiveCaret(page, id, '貼り付け😀'.length, '貼り付け😀');
    await assertCount(page, field, Array.from('貼り付け😀').length);
  }

  const message = page.locator('#feedback-message');
  await message.fill('first line');
  await message.focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second line');
  await assertActiveCaret(page, 'feedback-message', 22, 'first line\nsecond line');
  await page.keyboard.press('Home');
  await page.keyboard.type('insert ');
  await assertActiveCaret(page, 'feedback-message', 18, 'first line\ninsert second line');

  // These events cover the UI's composition handler only, not native OS IME.
  const composition = '入力途中😀';
  await page.locator('#feedback-type').selectOption('bug');
  await message.evaluate((element, value) => {
    element.focus();
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    element.value = value;
    element.setSelectionRange(value.length, value.length);
    element.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: value }));
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: value, isComposing: true }));
    element.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }, composition);
  assert.equal(await page.locator('#feedback-submit').isEnabled(), true, 'Submit is ignored during composition');
  assert.equal((await allFeedback()).length, 0, 'A composition event does not send a report');
  await message.evaluate((element, value) => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value }));
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }, composition);
  await assertActiveCaret(page, 'feedback-message', composition.length, composition);
  await assertCount(page, 'message', Array.from(composition).length);
  for (const field of ['name', 'target']) {
    await page.locator(`#feedback-${field}`).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#feedback-submit').isEnabled(), true, `${field} Enter does not implicitly submit`);
    assert.equal((await allFeedback()).length, 0);
  }

  await message.fill(Array.from({ length: 70 }, (_, index) => `line ${index}`).join('\n'));
  await message.focus();
  await page.keyboard.press('Control+End');
  const before = await message.evaluate(element => ({ top: element.scrollTop, page: scrollY }));
  await page.keyboard.type('x');
  const after = await message.evaluate(element => ({ top: element.scrollTop, page: scrollY, focused: document.activeElement === element }));
  assert.equal(after.focused, true);
  assert.ok(Math.abs(after.top - before.top) <= 25, 'Text area scroll remains at the caret');
  assert.ok(Math.abs(after.page - before.page) <= 2, 'Counter updates do not move page scroll');
}

async function publicScenario(page, context, origin, label) {
  await clearFeedback();
  await page.goto(`${origin}/feedback.html`);
  await page.locator('#feedback-submit').waitFor({ state: 'visible' });
  await assertNoOverflow(page);
  assert.equal(await page.evaluate(() => typeof firebase.auth), 'undefined', 'Public form does not load Auth SDK');
  await page.locator('#feedback-submit').click();
  assert.equal((await allFeedback()).length, 0, 'Required fields prevent an empty write');
  await editingScenario(page, context, origin);

  await page.locator('#feedback-type').selectOption('bug');
  await page.locator('#feedback-message').fill('Offline draft\n入力は残ります。');
  await page.locator('#feedback-name').fill('Draft name');
  await page.locator('#feedback-target').fill('Draft target');
  await context.setOffline(true);
  await page.locator('#feedback-submit').click();
  await page.locator('#feedback-error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#feedback-submit').isEnabled(), true, 'Offline error allows retry');
  assert.equal(await page.locator('#feedback-message').inputValue(), 'Offline draft\n入力は残ります。');
  assert.equal(await page.locator('#feedback-name').inputValue(), 'Draft name');
  assert.equal(await page.locator('#feedback-target').inputValue(), 'Draft target');
  await context.setOffline(false);
  await page.locator('#feedback-message').fill('😀'.repeat(4001));
  await page.locator('#feedback-name').fill('😀'.repeat(41));
  await page.locator('#feedback-target').fill('😀'.repeat(101));
  await assertCount(page, 'message', 4001);
  await assertCount(page, 'name', 41);
  await assertCount(page, 'target', 101);
  await page.locator('#feedback-submit').click();
  assert.equal((await allFeedback()).length, 0, 'Too many Unicode codepoints do not create a report');
  assert.equal(await page.locator('#feedback-message').inputValue(), '😀'.repeat(4001), 'Invalid data remains editable without truncation');

  const payload = { type: 'bug', message: '😀'.repeat(4000), name: '😀'.repeat(40), target: '😀'.repeat(100) };
  for (const field of ['message', 'name', 'target']) {
    await page.locator(`#feedback-${field}`).fill(payload[field]);
    await assertCount(page, field, Array.from(payload[field]).length);
    if (field === 'message') {
      assert.equal(await page.locator('#feedback-error').isVisible(), false, 'Editing the invalid field clears its stale error');
      assert.equal(await page.locator('#feedback-message').getAttribute('aria-invalid'), null, 'Corrected field no longer has an invalid border');
    }
  }
  await assertNoOverflow(page);
  await page.screenshot({ path: path.join(OUTPUT, `public-boundary-${label}.png`), fullPage: true });
  await page.locator('#feedback-submit').click({ clickCount: 2 });
  await page.locator('#feedback-new').waitFor({ state: 'visible' });
  assert.deepEqual(await page.evaluate(() => firebase.apps.map(app => app.name)), ['portal-feedback-public']);
  const documents = await allFeedback();
  assert.equal(documents.length, 1, 'Double click creates one report');
  for (const field of ['type', 'message', 'name', 'target']) assert.equal(documents[0].fields[field].stringValue, payload[field]);
  assert.equal(documents[0].fields.schemaVersion.integerValue, '1');
  assert.ok(documents[0].fields.createdAt.timestampValue, 'Server timestamp is stored');
  assert.equal(await page.locator('#feedback-message').evaluate(element => element.readOnly), true, 'Successful report remains locked until a new report is requested');

  for (const type of ['request', 'other']) {
    await page.locator('#feedback-new').click();
    await page.locator('#feedback-type').selectOption(type);
    await page.locator('#feedback-message').fill(`One ${type} report\n日本語も入力できます。`);
    assert.equal(await page.locator('#feedback-name').inputValue(), '', 'Name is optional and resets');
    assert.equal(await page.locator('#feedback-target').inputValue(), '', 'Target is optional and resets');
    if (type === 'request') {
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: path.join(OUTPUT, `public-${label}.png`), fullPage: true });
      await page.screenshot({ path: path.join(OUTPUT, `public-${label}-viewport.png`) });
    }
    await page.locator('#feedback-submit').click();
    await page.locator('#feedback-new').waitFor({ state: 'visible' });
  }
  const submitted = await allFeedback();
  assert.equal(submitted.length, 3);
  assert.deepEqual(submitted.map(document => document.fields.type.stringValue).sort(), ['bug', 'other', 'request']);
  for (const document of submitted.filter(document => document.fields.type.stringValue !== 'bug')) {
    assert.equal(document.fields.name.stringValue, '');
    assert.equal(document.fields.target.stringValue, '');
  }
}

async function login(page, email) {
  await page.locator('#feedback-admin-email').fill(email);
  await page.locator('#feedback-admin-password').fill(PASSWORD);
  await page.locator('#feedback-admin-login').click();
}

async function cardIds(page) {
  return page.locator('[data-feedback-id]').evaluateAll(elements => elements.map(element => element.dataset.feedbackId));
}

async function adminScenario(page, origin, label) {
  await seedFeedback();
  const xss = '<img src=x onerror="globalThis.__feedbackXss=true"><script>globalThis.__feedbackXss=true</script>';
  await localRequest(documentUrl('seed-30'), { method: 'PATCH', body: { fields: feedbackFields(30, { message: xss + '\nA real newline', name: xss, target: xss }) } });
  await localRequest(documentUrl('seed-29'), { method: 'PATCH', body: { fields: feedbackFields(29, { name: 'W'.repeat(40), target: 'W'.repeat(100) }) } });
  await page.goto(`${origin}/feedback-admin.html`);
  await page.locator('#feedback-admin-login').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#feedback-admin-panel').isVisible(), false, 'Signed-out users see no reports');
  assert.equal((await cardIds(page)).length, 0);
  await login(page, OTHER_EMAIL);
  await eventually(async () => {
    assert.equal(await page.locator('#feedback-admin-login').isEnabled(), true);
    assert.equal(await page.evaluate(() => firebase.auth().currentUser?.uid), 'feedback-fixture-non-admin');
    assert.ok((await page.locator('#feedback-admin-status').textContent()).includes('管理権限がありません'));
  }, 'Non-admin login rejected');
  assert.equal((await cardIds(page)).length, 0, 'Another UID never gets reports');
  assert.equal(await page.locator('#feedback-admin-panel').isVisible(), false);
  await page.locator('#feedback-admin-logout').click();
  await eventually(async () => assert.equal(await page.evaluate(() => firebase.auth().currentUser), null), 'Non-admin logout completes');
  await login(page, ADMIN_EMAIL);
  await page.locator('[data-feedback-id="seed-30"]').waitFor({ state: 'visible' });
  const firstPage = await cardIds(page);
  assert.equal(firstPage.length, 30);
  assert.deepEqual(firstPage, Array.from({ length: 30 }, (_, index) => `seed-${String(30 - index).padStart(2, '0')}`));
  assert.equal(await page.evaluate(() => firebase.auth().currentUser.uid), ADMIN_UID);
  assert.equal(await page.locator('#feedback-admin-list img, #feedback-admin-list script').count(), 0, 'Untrusted reports do not become HTML');
  assert.equal(await page.evaluate(() => Boolean(globalThis.__feedbackXss)), false);
  assert.ok((await page.locator('[data-feedback-id="seed-30"]').textContent()).includes(xss), 'XSS payload is shown literally');
  assert.ok((await page.locator('[data-feedback-id="seed-30"]').textContent()).includes('\nA real newline'));
  assert.equal(await page.locator('[data-feedback-id="seed-30"] .feedback-message').evaluate(element => getComputedStyle(element).whiteSpace), 'pre-wrap');
  assert.ok((await page.locator('[data-feedback-id="seed-30"] time').textContent()).includes('09:00:30 JST'), 'Admin timestamps are shown in Japan time');
  await assertNoOverflow(page);
  await page.screenshot({ path: path.join(OUTPUT, `admin-${label}-viewport.png`) });
  await page.screenshot({ path: path.join(OUTPUT, `admin-${label}.png`), fullPage: true });

  await page.locator('#feedback-admin-next').click();
  await eventually(async () => assert.ok((await cardIds(page)).includes('seed-00')), 'Next page contains final report');
  const nextPage = await cardIds(page);
  assert.equal(new Set(nextPage).size, nextPage.length, 'Pagination contains no duplicate cards');
  assert.equal(nextPage.length, 31, 'Next page appends the remaining report');
  await localRequest(documentUrl('fresh-31'), { method: 'PATCH', body: { fields: feedbackFields(31) } });
  await page.locator('#feedback-admin-refresh').click();
  await eventually(async () => assert.equal((await cardIds(page))[0], 'fresh-31'), 'Refresh loads latest server data');
  assert.equal((await cardIds(page)).length, 30);
  await page.locator('[data-feedback-delete="fresh-31"]').scrollIntoViewIfNeeded();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-feedback-delete="fresh-31"]').click();
  await eventually(async () => assert.equal(await localRequest(documentUrl('fresh-31'), { allow404: true }), null), 'Admin delete reaches emulator');
  await eventually(async () => assert.equal((await cardIds(page)).includes('fresh-31'), false), 'Deleted report is removed from the list');
  await page.locator('#feedback-admin-logout').click();
  await page.locator('#feedback-admin-login').waitFor({ state: 'visible' });
  assert.equal((await cardIds(page)).length, 0, 'Logout removes report content');
  assert.equal(await page.locator('#feedback-admin-panel').isVisible(), false);
  await eventually(async () => assert.equal(await page.evaluate(() => firebase.auth().currentUser), null), 'Admin logout completes');
  await page.reload();
  await page.locator('#feedback-admin-login').waitFor({ state: 'visible' });
  assert.equal((await cardIds(page)).length, 0, 'Reload after logout keeps reports hidden');
}

async function runBrowserScenarios(origin) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  browserMetadata.browserVersion = browser.version();
  browserMetadata.viewports = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }];
  console.log(`Browser: Microsoft Edge ${browser.version()}`);
  try {
    for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      const requests = [], blocked = [], errors = [];
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        requests.push({ url: url.href, method: route.request().method() });
        if ([origin, FIRESTORE, AUTH].includes(url.origin)) return route.continue();
        blocked.push(url.href);
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      try {
        await record(`${label}: public editing, Unicode validation, create and no Auth`, () => publicScenario(page, context, origin, label));
        assert.equal(requests.filter(request => request.url.startsWith(AUTH)).length, 0, 'Public form makes no Auth request');
        await record(`${label}: admin login, access, 30/newest, next, refresh, XSS, delete and logout`, () => adminScenario(page, origin, label));
        assert.deepEqual(errors, [], 'No uncaught browser errors');
        assert.equal(blocked.filter(url => /(?:firestore|identitytoolkit|securetoken)\.googleapis\.com/.test(url)).length, 0, 'No production Firebase request is attempted');
      } catch (error) {
        await page.screenshot({ path: path.join(OUTPUT, `failure-${label}.png`), fullPage: true }).catch(() => {});
        fs.writeFileSync(path.join(OUTPUT, `failure-${label}.html`), await page.content().catch(() => ''));
        throw error;
      } finally {
        fs.writeFileSync(path.join(OUTPUT, `network-${label}.json`), JSON.stringify({ requests, blocked, errors }, null, 2));
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { startFixture, LOCAL_CONFIG };
