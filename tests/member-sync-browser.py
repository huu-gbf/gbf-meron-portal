"""Local pairing fixture. Run through the existing Auth + Firestore emulators.

python tests/member-sync-browser.py (http://127.0.0.1:18765)
Only allowlisted assets are served. No backend.main, ADC or production config.
"""
import os
import re
import secrets
import sys
from pathlib import Path

import firebase_admin
from firebase_admin import credentials
from google.auth.credentials import AnonymousCredentials
from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse, Response
import uvicorn

assert os.environ.get("FIRESTORE_EMULATOR_HOST") == "127.0.0.1:8080"
assert os.environ.get("FIREBASE_AUTH_EMULATOR_HOST") == "127.0.0.1:9099"
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import member_sync as m


class EmulatorCredential(credentials.Base):
    def get_credential(self):
        return AnonymousCredentials()


os.environ["MEMBER_SYNC_HMAC_SECRET"] = secrets.token_hex(32)
os.environ["MEMBER_SYNC_PROJECT_ID"] = m.PROJECT
firebase_admin.initialize_app(EmulatorCredential(), {"projectId": m.PROJECT}, name=m.APP_NAME)
app = FastAPI()
app.mount("/api/member-sync", m.api)
SETUP = '''<script>
globalThis.MEMBER_SYNC_LOCAL={apiBase:'/api/member-sync',firebaseConfig:{
  apiKey:'local-only',projectId:'gbf-meron-portal',appId:'local-member-sync'}};
</script>'''


@app.get("/speed-calculator-folder/speed-calculator.html")
def calculator():
    html = (ROOT / "speed-calculator-folder/speed-calculator.html").read_text(encoding="utf-8")
    html = re.sub(r'<link[^>]+href="https://fonts\.[^>]+>', '', html)
    return HTMLResponse(html.replace('<head>', '<head>' + SETUP), headers={"Cache-Control": "no-store"})


@app.get("/sdk/{name}")
def sdk(name: str):
    if name not in ["firebase-" + part + "-compat.js" for part in ("app", "auth", "firestore")]:
        return Response(status_code=404)
    return FileResponse(ROOT / "node_modules/firebase" / name, media_type="application/javascript")


@app.get("/{name}")
def asset(name: str):
    if name not in ("member-sync.js", "member-sync.css", "favicon.svg"):
        return Response(status_code=204 if name == "favicon.ico" else 404)
    return FileResponse(ROOT / name)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=18765, access_log=False)
