"""Opt-in device pairing API. No production initialization at import time.

All persistence and token verification originate from member-sync-admin, never
main.db. Provision MEMBER_SYNC_HMAC_SECRET through Secret Manager before deploy.
"""
import functools
import hashlib
import hmac
import os
import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Annotated

import firebase_admin
from firebase_admin import auth, firestore
from fastapi import Depends, FastAPI, Path, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictStr
from google.api_core.exceptions import Aborted

PROJECT = "gbf-meron-portal"
APP_NAME = "member-sync-admin"
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_app_lock = threading.Lock()
RequestID = Annotated[str, Path(min_length=32, max_length=32, pattern=r"^[a-f0-9]{32}$")]


class PairingError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def get_member_app():
    if os.getenv("MEMBER_SYNC_PROJECT_ID", PROJECT) != PROJECT:
        raise PairingError(503, "NOT_READY")
    with _app_lock:
        try:
            app = firebase_admin.get_app(APP_NAME)
        except ValueError:
            app = firebase_admin.initialize_app(
                options={"projectId": PROJECT, "httpTimeout": 10}, name=APP_NAME)
        if app.project_id != PROJECT:
            raise PairingError(503, "NOT_READY")
        return app


def get_member_auth():
    # Public SDK entry point, permanently bound to this App, including revocation.
    return functools.partial(auth.verify_id_token, app=get_member_app(), check_revoked=True)


def get_member_firestore():
    return firestore.client(app=get_member_app())


def server_key():
    value = os.getenv("MEMBER_SYNC_HMAC_SECRET", "")
    if len(value.encode()) < 32:
        raise PairingError(503, "NOT_READY")
    return value.encode()


def digest(value):
    return hmac.new(server_key(), value.encode(), hashlib.sha256).hexdigest()


def now_utc():
    return datetime.now(timezone.utc)


def random_id():
    return secrets.token_hex(16)


def fail():
    # Missing, expired, rejected, revoked and consumed codes are indistinguishable.
    raise PairingError(409, "INVITE_UNAVAILABLE")


def read(tx, ref):
    snap = ref.get(transaction=tx)
    return snap.to_dict() if snap.exists else None


def atomic(store, operation):
    # Use one bounded, jittered retry loop for both read and commit aborts. The
    # SDK wraps exhausted commit aborts in ValueError; inspect the cause, not text.
    # Unknown commit outcomes must never be replayed.
    for attempt in range(5):
        try:
            return firestore.transactional(operation)(store.transaction(max_attempts=1))
        except (Aborted, ValueError) as exc:
            if not (isinstance(exc, Aborted) or isinstance(exc.__cause__, Aborted)) or attempt == 4:
                raise
            time.sleep((attempt + 1) * (0.02 + secrets.randbelow(200) / 1000))


def membership(store, tx, uid):
    identity = read(tx, store.collection("memberIdentities").document(uid))
    if not identity or identity.get("active") is not True:
        raise PairingError(403, "MEMBERSHIP_REQUIRED")
    profile_id, device_id = identity.get("profileId"), identity.get("deviceId")
    if not all(isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", v)
               for v in (profile_id, device_id)):
        raise PairingError(403, "MEMBERSHIP_REQUIRED")
    profile_ref = store.collection("memberProfiles").document(profile_id)
    profile = read(tx, profile_ref)
    device = read(tx, profile_ref.collection("devices").document(device_id))
    if not profile or profile.get("status") != "active" or not device or device.get("status") != "active":
        raise PairingError(403, "MEMBERSHIP_REQUIRED")
    return identity, profile_ref, profile


def consume_quota(store, uid, ip):
    stamp = now_utc()
    window = int(stamp.timestamp()) // 60
    # Do not trust X-Forwarded-For. A shared proxy IP is a conservative extra cap.
    buckets = [("uid:" + uid, 30), ("ip:" + ip, 100), ("global", 1000)]
    refs = [(store.collection("memberSyncLimits").document(digest(name) + "_" + str(window)), limit)
            for name, limit in buckets]

    def update(tx):
        counts = [(ref, limit, (read(tx, ref) or {}).get("count", 0)) for ref, limit in refs]
        if any(count >= limit for _, limit, count in counts):
            raise PairingError(429, "RATE_LIMITED")
        for ref, _, count in counts:
            tx.set(ref, {"count": count + 1, "expiresAt": stamp + timedelta(minutes=3)})
    atomic(store, update)


def authenticated(request: Request):
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer ") or not 1 <= len(header[7:]) <= 8192:
        raise PairingError(401, "UNAUTHENTICATED")
    verifier = get_member_auth()  # Initialization failure must never fall back.
    try:
        claims = verifier(header[7:])
        uid = claims.get("uid")
        if (not isinstance(uid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", uid)
                or claims.get("firebase", {}).get("sign_in_provider") != "anonymous"
                or type(claims.get("exp")) is not int or claims["exp"] <= now_utc().timestamp()):
            raise ValueError("anonymous identity required")
    except Exception:
        raise PairingError(401, "UNAUTHENTICATED") from None
    server_key()  # Fail closed before any persistence when secret is unconfigured.
    store = get_member_firestore()
    consume_quota(store, uid, request.client.host if request.client else "unknown")
    return uid, store


class EmptyInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ClaimInput(EmptyInput):
    code: StrictStr = Field(min_length=12, max_length=32)
    label: StrictStr = Field(default="", max_length=40, pattern=r"^[^\x00-\x1f\x7f]*$")


api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def error_response(status, code):
    headers = {"Cache-Control": "no-store"}
    if status == 429:
        headers["Retry-After"] = "60"
    return JSONResponse({"error": {"code": code}}, status_code=status, headers=headers)


@api.exception_handler(PairingError)
async def pairing_error(request, exc):
    return error_response(exc.status, exc.code)


@api.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    # Never reflect input, token, code or Pydantic's raw error payload.
    return error_response(422, "INVALID_INPUT")


@api.middleware("http")
async def guard(request, call_next):
    try:
        payload = bytearray()
        async for chunk in request.stream():
            if len(payload) + len(chunk) > 2048:
                return error_response(413, "INPUT_TOO_LARGE")
            payload.extend(chunk)
        request._body = bytes(payload)
    except Exception:
        return error_response(400, "INVALID_INPUT")
    try:
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response
    except Exception:
        # SDK exceptions may include document paths or credentials. Do not log or
        # return their text, and never retry against another Firebase project.
        return error_response(503, "NOT_READY")


def identity_data(profile_id, device_id, stamp):
    return {"schemaVersion": 1, "profileId": profile_id, "deviceId": device_id,
            "active": True, "linkedAt": stamp, "revokedAt": None}


def device_data(stamp, label=None):
    return {"schemaVersion": 1, "label": label, "status": "active",
            "linkedAt": stamp, "lastSeenAt": stamp}


@api.post("/profile")
def create_profile(body: EmptyInput, principal=Depends(authenticated)):
    uid, store = principal
    identity_ref = store.collection("memberIdentities").document(uid)
    profile_id, device_id = random_id(), random_id()
    profile_ref = store.collection("memberProfiles").document(profile_id)

    def create(tx):
        old = read(tx, identity_ref)
        if old is not None:
            membership(store, tx, uid)  # Inactive identities must not resurrect.
            return {"status": "ready"}
        stamp = now_utc()
        tx.create(profile_ref, {"schemaVersion": 1, "status": "active", "createdAt": stamp, "deviceCount": 1})
        tx.create(identity_ref, identity_data(profile_id, device_id, stamp))
        tx.create(profile_ref.collection("devices").document(device_id), device_data(stamp))
        return {"status": "ready"}
    return atomic(store, create)


def pending_ref(store, invite):
    return store.collection("memberSyncPending").document(invite["profileId"]).collection("requests").document(invite["requestId"])


@api.post("/invites")
def issue_invite(body: EmptyInput, principal=Depends(authenticated)):
    uid, store = principal
    code = "".join(secrets.choice(ALPHABET) for _ in range(12))
    code_hash, request_id = digest(code), random_id()
    invite_ref = store.collection("memberSyncInvites").document(code_hash)
    issuer_ref = store.collection("memberSyncIssuers").document(uid)

    def issue(tx):
        identity, _, _ = membership(store, tx, uid)
        pointer = read(tx, issuer_ref)
        old_ref = store.collection("memberSyncInvites").document(pointer["digest"]) if pointer else None
        old = read(tx, old_ref) if old_ref else None
        stamp = now_utc()
        if old and old["status"] in ("issued", "pending"):
            tx.update(old_ref, {"status": "revoked", "revokedAt": stamp})
            tx.delete(pending_ref(store, old))
        invite = {"schemaVersion": 1, "keyVersion": 1, "profileId": identity["profileId"],
                  "issuerUid": uid, "issuerDeviceId": identity["deviceId"], "status": "issued",
                  "claimantUid": None, "claimantDeviceId": None, "requestId": request_id,
                  "createdAt": stamp, "expiresAt": stamp + timedelta(minutes=10),
                  "consumedAt": None, "revokedAt": None}
        tx.create(invite_ref, invite)
        tx.create(store.collection("memberSyncRequests").document(request_id), {"digest": code_hash})
        tx.set(issuer_ref, {"digest": code_hash})
        return {"code": code, "requestId": request_id, "expiresAt": invite["expiresAt"]}
    return atomic(store, issue)


@api.post("/invites/claim")
def claim_invite(body: ClaimInput, principal=Depends(authenticated)):
    uid, store = principal
    normalized = body.code.strip().upper()
    if len(normalized) != 12 or any(c not in ALPHABET for c in normalized):
        fail()
    invite_ref = store.collection("memberSyncInvites").document(digest(normalized))
    device_id = random_id()

    def claim(tx):
        invite = read(tx, invite_ref)
        identity = read(tx, store.collection("memberIdentities").document(uid))
        stamp = now_utc()
        if not invite or invite["expiresAt"] <= stamp or identity is not None:
            fail()
        if invite["status"] == "pending" and invite["claimantUid"] == uid:
            return {"status": "pending", "requestId": invite["requestId"]}
        if invite["status"] != "issued":
            fail()
        issuer, _, _ = membership(store, tx, invite["issuerUid"])
        if issuer["profileId"] != invite["profileId"] or issuer["deviceId"] != invite["issuerDeviceId"]:
            fail()
        update = {"status": "pending", "claimantUid": uid, "claimantDeviceId": device_id,
                  "claimedAt": stamp, "label": body.label}
        tx.update(invite_ref, update)
        tx.set(pending_ref(store, invite), {"requestId": invite["requestId"], "claimedAt": stamp,
                                          "label": body.label, "expiresAt": invite["expiresAt"]})
        return {"status": "pending", "requestId": invite["requestId"]}
    return atomic(store, claim)


@api.get("/invites/pending")
def list_pending(principal=Depends(authenticated)):
    uid, store = principal

    def listing(tx):
        identity, _, _ = membership(store, tx, uid)
        rows = store.collection("memberSyncPending").document(identity["profileId"]).collection("requests").stream(transaction=tx)
        return {"requests": [{k: value[k] for k in ("requestId", "claimedAt", "label")}
                             for row in rows if (value := row.to_dict())["expiresAt"] > now_utc()]}
    return atomic(store, listing)


def resolve_invite(store, tx, request_id):
    if not re.fullmatch(r"[a-f0-9]{32}", request_id):
        fail()
    pointer = read(tx, store.collection("memberSyncRequests").document(request_id))
    if not pointer:
        fail()
    ref = store.collection("memberSyncInvites").document(pointer["digest"])
    invite = read(tx, ref)
    if not invite:
        fail()
    return ref, invite


def finish_invite(request_id, action, principal):
    uid, store = principal

    def finish(tx):
        identity, profile_ref, profile = membership(store, tx, uid)
        ref, invite = resolve_invite(store, tx, request_id)
        stamp = now_utc()
        allowed = ("issued", "pending") if action == "revoke" else ("pending",)
        if (invite["profileId"] != identity["profileId"] or invite["status"] not in allowed
                or invite["expiresAt"] <= stamp or (action == "revoke" and invite["issuerUid"] != uid)):
            fail()
        if action == "approve":
            claimant_ref = store.collection("memberIdentities").document(invite["claimantUid"])
            if read(tx, claimant_ref) is not None:
                fail()
            count = profile.get("deviceCount")
            if type(count) is not int or not 1 <= count < 5:
                raise PairingError(409, "DEVICE_LIMIT")
            tx.create(claimant_ref, identity_data(invite["profileId"], invite["claimantDeviceId"], stamp))
            tx.create(profile_ref.collection("devices").document(invite["claimantDeviceId"]), device_data(stamp, invite["label"]))
            tx.update(profile_ref, {"deviceCount": count + 1})
        status = {"approve": "consumed", "reject": "rejected", "revoke": "revoked"}[action]
        tx.update(ref, {"status": status, {"approve": "consumedAt", "reject": "rejectedAt", "revoke": "revokedAt"}[action]: stamp})
        tx.delete(pending_ref(store, invite))
        return {"status": status}
    return atomic(store, finish)


@api.post("/invites/{request_id}/approve")
def approve(request_id: RequestID, body: EmptyInput, principal=Depends(authenticated)):
    return finish_invite(request_id, "approve", principal)


@api.post("/invites/{request_id}/reject")
def reject(request_id: RequestID, body: EmptyInput, principal=Depends(authenticated)):
    return finish_invite(request_id, "reject", principal)


@api.post("/invites/{request_id}/revoke")
def revoke(request_id: RequestID, body: EmptyInput, principal=Depends(authenticated)):
    return finish_invite(request_id, "revoke", principal)
