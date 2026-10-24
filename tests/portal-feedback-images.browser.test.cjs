/* Loopback-only browser UI checks. API and Firebase are explicit local fixtures.
 * Mobile viewport/file input is tested; a physical phone gallery is not emulated.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-images-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAACKElEQVR4nO3TQQ3AIADAQJguRKAOvfPAhzS5U9BP515nAE3f6wDgnoEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwDC6fnZ3AopSeXiLAAAAAElFTkSuQmCC', 'base64');
const file = name => ({name, mimeType: 'image/png', buffer: png});
let posts = [], fail = false, deletes = 0, passes = 0;
const id = 'img-' + '1'.repeat(32);
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/portal-feedback')) {
    if (req.method === 'GET') { res.setHeader('Content-Type', 'image/png'); res.end(png); return; }
    if (req.method === 'DELETE') { deletes++; res.end('{}'); return; }
    let data = ''; req.on('data', value => data += value); req.on('end', () => {
      posts.push(JSON.parse(data)); res.statusCode = fail ? 503 : 200; res.end(JSON.stringify({id}));
    }); return;
  }
  const name = req.url.slice(1).split('?')[0];
  if (!['feedback.html', 'feedback-admin.html', 'portal-feedback.js', 'portal-feedback-admin.js', 'feedback.css', 'favicon.svg'].includes(name)) { res.statusCode = 404; res.end(); return; }
  let content = fs.readFileSync(path.join(root, name));
  if (name.endsWith('.html')) content = content.toString().replace(/<script[^>]*src="(?:https:[^"]+|\.?\/?firebase-config\.js)"[^>]*><\/script>/g, '');
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8');
  res.end(content);
});
async function check(name, run) { await run(); passes++; console.log('PASS ' + name); }
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const context = await browser.newContext({permissions: ['clipboard-read', 'clipboard-write']});
    await context.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('blob:') ? route.continue() : route.abort());
    await context.addInitScript(({origin, id}) => {
      window.PORTAL_FEEDBACK_LOCAL = {firebaseConfig: {projectId: 'demo-images', apiKey: 'test', appId: 'test'}, firestoreHost: '127.0.0.1', firestorePort: 8080, authEmulatorUrl: 'http://127.0.0.1:9099', apiBaseUrl: origin};
      const user = {uid: 'wJRZibao8FgMDqDDQ3csPdVuGkx1', getIdToken: async () => 'test-admin'};
      let observer;
      const auth = {currentUser: user, useEmulator() {}, onIdTokenChanged(fn) { observer = fn; queueMicrotask(() => fn(user)); return () => {}; }, async signOut() { this.currentUser = null; observer(null); }};
      const db = {useEmulator() {}, collection() { return {doc: () => ({id: 'plain', set: async value => { window.plainSubmission = value; }}), orderBy() { return this; }, limit() { return this; }, get: async () => ({docs: [{id, data: () => ({type: 'bug', message: '画像付きの報告', name: '', target: '', attachments: [{}, {}]})}]})}; }};
      window.firebase = {apps: [], initializeApp: () => ({firestore: () => db, auth: () => auth}), firestore: {FieldValue: {serverTimestamp: () => 'time'}}};
    }, {origin, id});
    const page = await context.newPage();
    const open = async () => { await page.goto(origin + '/feedback.html'); await page.locator('#feedback-type').selectOption('bug'); await page.locator('#feedback-message').fill('テスト報告'); };
    await check('image-free submission preserves old six-field write', async () => {
      await open(); await page.locator('#feedback-submit').click();
      await page.waitForFunction(() => document.querySelector('#feedback-status').textContent.includes('送信しました'));
      assert.equal(Object.keys(await page.evaluate(() => window.plainSubmission)).length, 6); assert.equal(posts.length, 0);
    });
    await check('file selection, previews, individual removal', async () => {
      await open(); await page.locator('#feedback-images').setInputFiles([file('a.png'), file('b.png')]);
      assert.equal(await page.locator('#feedback-previews img').count(), 2);
      await page.locator('#feedback-previews button').first().click();
      assert.equal(await page.locator('#feedback-previews img').count(), 1);
      await page.screenshot({path: path.join(output, 'desktop.png'), fullPage: true});
    });
    await check('real clipboard image and Ctrl+V', async () => {
      await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4;
        const blob = await new Promise(resolve => canvas.toBlob(resolve));
        await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
      });
      await page.locator('#feedback-message').focus(); await page.keyboard.press('Control+V');
      await page.waitForFunction(() => document.querySelectorAll('#feedback-previews img').length === 2);
    });
    await check('drag and drop adds a preview', async () => {
      await page.locator('#feedback-dropzone').evaluate(element => {
        const dt = new DataTransfer(); dt.items.add(new File(['test'], 'drop.webp', {type: 'image/webp'}));
        element.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt}));
      });
      assert.equal(await page.locator('#feedback-previews img').count(), 3);
      await page.locator('#feedback-previews button').last().click();
    });
    await check('failed send preserves fields/images; retry keeps same ID', async () => {
      fail = true; await page.locator('#feedback-submit').click(); await page.locator('#feedback-error').waitFor({state: 'visible'});
      assert.equal(await page.locator('#feedback-previews img').count(), 2);
      assert.equal(await page.locator('#feedback-message').inputValue(), 'テスト報告');
      fail = false; await page.locator('#feedback-submit').click();
      await page.waitForFunction(() => document.querySelector('#feedback-status').textContent.includes('送信しました'));
      assert.equal(posts[0].requestId, posts[1].requestId); assert.equal(posts[1].attachments.length, 2);
    });
    await check('count, per-file size, total size, unsupported type rejected', async () => {
      await open();
      for (const files of [Array.from({length: 6}, (_, i) => file(i + '.png')),
        [{...file('big.png'), buffer: Buffer.alloc(5 * 1024 * 1024 + 1)}],
        Array.from({length: 5}, () => ({...file('total.png'), buffer: Buffer.alloc(5 * 1024 * 1024)})),
        [{name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>')}]]) {
        await page.locator('#feedback-images').setInputFiles(files);
        assert.equal(await page.locator('#feedback-previews img').count(), 0);
        assert.equal(await page.locator('#feedback-error').isVisible(), true);
      }
    });
    await check('one-image send and new report reset', async () => {
      await page.locator('#feedback-images').setInputFiles(file('one.png')); await page.locator('#feedback-submit').click();
      await page.locator('#feedback-new').waitFor({state: 'visible'}); assert.equal(posts.at(-1).attachments.length, 1);
      await page.locator('#feedback-new').click(); assert.equal(await page.locator('#feedback-previews img').count(), 0);
    });
    await check('admin list, enlarged dialog, logout clears private images', async () => {
      await page.goto(origin + '/feedback-admin.html'); await page.waitForFunction(() => document.querySelectorAll('.feedback-images img').length === 2);
      await page.locator('.feedback-images button').first().click(); assert.equal(await page.locator('dialog').isVisible(), true);
      await page.waitForFunction(() => document.querySelector('dialog img').naturalWidth === 320);
      assert.ok(await page.locator('dialog img').evaluate(img => img.getBoundingClientRect().width > 130));
      await page.screenshot({path: path.join(output, 'admin-expanded.png')});
      await page.getByRole('button', {name: '閉じる', exact: true}).click();
      await page.locator('#feedback-admin-logout').click(); assert.equal(await page.locator('.feedback-images img').count(), 0);
      assert.equal(await page.locator('dialog').count(), 0);
    });
    await check('admin image post deletion uses authenticated API', async () => {
      await page.reload(); await page.locator('[data-feedback-delete]').waitFor(); page.once('dialog', dialog => dialog.accept());
      await page.locator('[data-feedback-delete]').click(); await page.waitForFunction(() => !document.querySelector('[data-feedback-delete]'));
      assert.equal(deletes, 1);
    });
    await check('mobile viewport photo selection, preview, submission', async () => {
      await page.setViewportSize({width: 390, height: 844}); await open();
      await page.locator('#feedback-images').setInputFiles([file('photo.png'), file('photo2.png')]);
      assert.equal(await page.locator('#feedback-previews img').count(), 2);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({path: path.join(output, 'mobile.png'), fullPage: true});
      await page.locator('#feedback-submit').click(); await page.locator('#feedback-new').waitFor({state: 'visible'});
    });
    console.log(JSON.stringify({pass: passes, fail: 0, output, limitation: 'Physical phone gallery not tested'}));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
