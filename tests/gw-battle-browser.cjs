/* Local-only browser fixture. Start the Firestore emulator first, then:
 * node tests/gw-battle-browser.cjs
 * PC:    http://127.0.0.1:18764/tools/gw-battle-review.html?seed=pc
 * Phone: http://localhost:18764/tools/gw-battle-review.html
 * Different origins isolate caches. Authentication is simulated; Rules are real.
 * All SDKs are local and all Firestore traffic uses the demo emulator.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const setup = `<script>
globalThis.firebaseConfig={apiKey:'demo-key',projectId:'demo-gbf-meron-portal-rules',appId:'demo-battle-browser'};
const fixtureApp=firebase.initializeApp(globalThis.firebaseConfig,'yosen-shared');
fixtureApp.firestore().useEmulator('127.0.0.1',8080,{mockUserToken:{sub:'wJRZibao8FgMDqDDQ3csPdVuGkx1'}});
const fixtureAuth={setPersistence:()=>Promise.resolve(),onAuthStateChanged:cb=>{fixtureAuth.notify=cb;queueMicrotask(()=>cb({uid:'wJRZibao8FgMDqDDQ3csPdVuGkx1'}));},signOut:async()=>fixtureAuth.notify(null)};
fixtureApp.auth=()=>fixtureAuth;
</script>`;
const seed = `<script>
if (!localStorage.getItem('gw_review_conditions')) localStorage.setItem('gw_review_conditions',JSON.stringify({dayKey:'day4',dayType:'weekday'}));
if (location.search==='?seed=pc' && !localStorage.getItem('gw_review_snapshots')) localStorage.setItem('gw_review_snapshots',JSON.stringify([{id:1,time:'08:00',own:1000000000,enemy:900000000},{id:2,time:'08:17',own:1200000000,enemy:1100000000}]));
</script>`;
http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/tools/gw-battle-review.html') {
    let html=fs.readFileSync(path.join(root,'tools/gw-battle-review.html'),'utf8');
    html=html.replace('<head>','<head>'+seed)
      .replaceAll('https://www.gstatic.com/firebasejs/10.8.0/','/sdk/')
      .replace('<script src="../firebase-config.js"></script>',setup);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;
  }
  const sdk=/^\/sdk\/(firebase-(app|auth|firestore)-compat\.js)$/.exec(url.pathname);
  if(sdk){res.writeHead(200,{'Content-Type':'application/javascript'});res.end(fs.readFileSync(path.join(root,'node_modules/firebase',sdk[1])));return;}
  res.writeHead(404);res.end();
}).listen(18764,'127.0.0.1',()=>console.log('Battle browser fixture: http://127.0.0.1:18764/tools/gw-battle-review.html?seed=pc (demo emulator only)'));
