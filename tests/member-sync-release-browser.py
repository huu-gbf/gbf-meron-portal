"""Allowlisted release integration fixture; loopback Emulators only.

Reuses the pairing fixture without importing backend.main or production clients.
"""
import re
import runpy
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse
import uvicorn

ROOT = Path(__file__).resolve().parents[1]
pairing = runpy.run_path(str(ROOT / "tests/member-sync-browser.py"))
app = FastAPI()


def html(name):
    source = (ROOT / name).read_text(encoding="utf-8")
    source = re.sub(r'<link[^>]+(?:href="https://fonts\.|rel="preconnect")[^>]*>', '', source)
    source = re.sub(r'<script\b[^>]*\bsrc="(?:\./)?firebase-config\.js"[^>]*></script>', '', source)
    source = re.sub(r'https://www\.gstatic\.com/firebasejs/[^/]+/(firebase-(?:app|auth|firestore)-compat\.js)', r'/sdk/\1', source)
    source = re.sub(r'<script[^>]+src="https://www\.gstatic\.com/[^>]+></script>', '', source)
    source = source.replace('<head>', '<head>' + pairing['SETUP'])
    if name == 'index.html':
        # Configure the separate default app before portal initialization. Its
        # existing admin/Visitor code remains intact and cannot reach production.
        anchor = '<script src="/sdk/firebase-firestore-compat.js"></script>'
        setup = '''<script>
firebase.initializeApp(MEMBER_SYNC_LOCAL.firebaseConfig);
firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
firebase.firestore().useEmulator('127.0.0.1',8080);
</script>'''
        assert anchor in source
        source = source.replace(anchor, anchor + setup)
    elif name == 'feedback.html':
        source = source.replace('<head>', '''<head><script>
globalThis.PORTAL_FEEDBACK_LOCAL={firebaseConfig:{projectId:'demo-feedback-mvp',apiKey:'local-only',appId:'feedback-local'},
firestoreHost:'127.0.0.1',firestorePort:8080,authEmulatorUrl:'http://127.0.0.1:9099'};
</script>''')
    return HTMLResponse(source, headers={"Cache-Control": "no-store"})


@app.get('/index.html')
def portal():
    return html('index.html')


@app.get('/awakening-manager.html')
def artifact():
    return html('awakening-manager.html')


@app.get('/feedback.html')
def feedback():
    return html('feedback.html')


def asset_handler(filename):
    def serve():
        return FileResponse(ROOT / filename)
    return serve


for asset in ['artifact-catalog.js', 'artifact-sync.js', 'css/tailwind.min.css',
              'feedback.css', 'portal-feedback.js']:
    app.add_api_route('/' + asset, asset_handler(asset), methods=['GET'])

app.mount('/', pairing['app'])

if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=18766, access_log=False)
