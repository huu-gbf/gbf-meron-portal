"""Run ONLY with Auth + Firestore emulators, --project gbf-meron-portal.

The project name tests the production binding, but hosts and anonymous credentials
are enforced before any SDK use. No ADC or production service is accessed.
"""
import inspect
import json
import os
import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock

import firebase_admin
import pytest
import requests
from firebase_admin import credentials
from google.auth.credentials import AnonymousCredentials
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import member_sync as m


class EmulatorCredential(credentials.Base):
    def get_credential(self):
        return AnonymousCredentials()


@pytest.fixture(autouse=True)
def setup(monkeypatch):
    assert os.environ.get("FIRESTORE_EMULATOR_HOST") == "127.0.0.1:8080"
    assert os.environ.get("FIREBASE_AUTH_EMULATOR_HOST") == "127.0.0.1:9099"
    monkeypatch.setenv("MEMBER_SYNC_HMAC_SECRET", secrets.token_hex(32))
    monkeypatch.setenv("MEMBER_SYNC_PROJECT_ID", m.PROJECT)
    app = firebase_admin.initialize_app(EmulatorCredential(), {"projectId": m.PROJECT}, name=m.APP_NAME)
    requests.delete("http://127.0.0.1:8080/emulator/v1/projects/gbf-meron-portal/databases/(default)/documents", timeout=10).raise_for_status()
    errors = []
    original_atomic = m.atomic
    def observed_atomic(*args):
        try:
            return original_atomic(*args)
        except Exception as exc:
            errors.append((type(exc).__name__, type(exc.__cause__).__name__))
            raise
    monkeypatch.setattr(m, "atomic", observed_atomic)
    yield errors
    firebase_admin.delete_app(app)


@pytest.fixture
def client():
    # Match the actual mounted path and test streaming middleware replay.
    parent = FastAPI()
    parent.mount("/api/member-sync", m.api)
    with TestClient(parent) as client:
        yield client


def user():
    response = requests.post("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-only",
                             json={"returnSecureToken": True}, timeout=10)
    response.raise_for_status()
    data = response.json()
    return data["localId"], {"Authorization": "Bearer " + data["idToken"]}


def post(client, headers, path, body=None, status=200):
    response = client.post("/api/member-sync" + path, headers=headers, json={} if body is None else body)
    assert response.status_code == status, response.text
    return response.json()


def identity(uid):
    return m.get_member_firestore().document("memberIdentities/" + uid).get().to_dict()


def owner(client):
    uid, headers = user()
    post(client, headers, "/profile")
    return uid, headers


def invite(client, headers):
    return post(client, headers, "/invites")


def claim(client, headers, invitation):
    return post(client, headers, "/invites/claim", {"code": invitation["code"], "label": "phone"})


def invite_document(invitation):
    return m.get_member_firestore().document("memberSyncInvites/" + m.digest(invitation["code"]))


def test_connections_are_bound_to_dedicated_project_and_app(monkeypatch):
    app = m.get_member_app()
    assert app.name == "member-sync-admin" and app.project_id == "gbf-meron-portal"
    verify = Mock(return_value={"uid": "verified"})
    monkeypatch.setattr(m.auth, "verify_id_token", verify)
    assert m.get_member_auth()("token") == {"uid": "verified"}
    verify.assert_called_once_with("token", app=app, check_revoked=True)
    client_factory = Mock(return_value=object())
    monkeypatch.setattr(m.firestore, "client", client_factory)
    assert m.get_member_firestore() is client_factory.return_value
    client_factory.assert_called_once_with(app=app)
    source = inspect.getsource(m)
    assert "FIRESTORE_PROJECT_ID" not in source and "gbf-ai-agent" not in source
    assert "from .main" not in source and "import main" not in source
    main = Path("backend/main.py").read_text(encoding="utf-8")
    assert '"FIRESTORE_PROJECT_ID",\n    "gbf-ai-agent"' in main
    assert 'name="gbf-meron-portal-fcm"' in main


@pytest.mark.parametrize("setting", ["gbf-ai-agent", "", "another-project"])
def test_wrong_project_fails_closed(client, monkeypatch, setting):
    monkeypatch.setenv("MEMBER_SYNC_PROJECT_ID", setting)
    factory = Mock(side_effect=AssertionError("must not access firestore"))
    monkeypatch.setattr(m.firestore, "client", factory)
    _, headers = user()
    post(client, headers, "/profile", status=503)
    factory.assert_not_called()


def test_initialization_failure_does_not_fallback(client, monkeypatch):
    monkeypatch.setattr(m.firebase_admin, "get_app", Mock(side_effect=ValueError()))
    initialize = Mock(side_effect=RuntimeError("private configuration"))
    monkeypatch.setattr(m.firebase_admin, "initialize_app", initialize)
    store = Mock()
    monkeypatch.setattr(m.firestore, "client", store)
    _, headers = user()
    result = post(client, headers, "/profile", status=503)
    assert "private" not in str(result)
    store.assert_not_called()


@pytest.mark.parametrize("header", [None, "Bearer fake-token", "Basic abc", "Bearer " + "x" * 8193])
def test_invalid_tokens_never_reach_firestore(client, monkeypatch, header):
    store = Mock(side_effect=AssertionError("must not access firestore"))
    monkeypatch.setattr(m, "get_member_firestore", store)
    post(client, {} if header is None else {"Authorization": header}, "/profile", status=401)
    store.assert_not_called()


def test_wrong_audience_and_non_anonymous_tokens_denied(client, monkeypatch):
    import jwt
    uid, headers = user()
    payload = jwt.decode(headers["Authorization"][7:], options={"verify_signature": False})
    for patch in [{"aud": "gbf-ai-agent"}, {"iss": "https://securetoken.google.com/other"},
                  {"exp": 1}, {"firebase": {"sign_in_provider": "password"}}]:
        token = jwt.encode({**payload, **patch}, key="", algorithm="none")
        post(client, {"Authorization": "Bearer " + token}, "/profile", status=401)
    assert identity(uid) is None


def test_profile_idempotent_even_concurrently(client):
    uid, headers = user()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: post(client, headers, "/profile"), range(4)))
    assert results == [{"status": "ready"}] * 4
    data = identity(uid)
    assert len(data["profileId"]) == len(data["deviceId"]) == 32
    store = m.get_member_firestore()
    assert len(list(store.collection("memberProfiles").stream())) == 1
    assert len(list(store.collection("memberProfiles").document(data["profileId"]).collection("devices").stream())) == 1


def test_complete_flow_only_approval_creates_membership(client, caplog):
    issuer, existing = owner(client)
    newcomer, new = user()
    invitation = invite(client, existing)
    assert len(invitation["code"]) == 12 and set(invitation["code"]) <= set(m.ALPHABET)
    stored = invite_document(invitation).get().to_dict()
    assert invitation["code"] not in str(stored)
    assert stored["expiresAt"] - stored["createdAt"] == timedelta(minutes=10)
    result = post(client, new, "/invites/claim", {"code": " " + invitation["code"].lower() + " "})
    assert result["status"] == "pending" and identity(newcomer) is None
    assert claim(client, new, invitation)["requestId"] == result["requestId"]
    response = client.get("/api/member-sync/invites/pending", headers=existing)
    assert response.status_code == 200 and len(response.json()["requests"]) == 1
    assert set(response.json()["requests"][0]) == {"requestId", "claimedAt", "label"}
    post(client, existing, "/invites/" + invitation["requestId"] + "/approve")
    assert identity(newcomer)["profileId"] == identity(issuer)["profileId"]
    assert identity(newcomer)["deviceId"] != identity(issuer)["deviceId"]
    assert invite_document(invitation).get().to_dict()["status"] == "consumed"
    assert client.get("/api/member-sync/invites/pending", headers=existing).json() == {"requests": []}
    post(client, new, "/invites/claim", {"code": invitation["code"]}, status=409)
    for action in ("approve", "reject", "revoke"):
        post(client, existing, "/invites/" + invitation["requestId"] + "/" + action, status=409)
    assert "profileId" not in str(result) and "profileId" not in str(invitation)
    assert invitation["code"] not in caplog.text
    assert new["Authorization"] not in caplog.text
    assert os.environ["MEMBER_SYNC_HMAC_SECRET"] not in caplog.text


def test_other_profile_and_forged_body_cannot_escalate(client):
    _, existing = owner(client)
    _, other = owner(client)
    newcomer, new = user()
    invitation = invite(client, existing)
    claim(client, new, invitation)
    for action in ("approve", "reject", "revoke"):
        post(client, other, "/invites/" + invitation["requestId"] + "/" + action, status=409)
    assert client.get("/api/member-sync/invites/pending", headers=other).json() == {"requests": []}
    for body in ({"uid": "other"}, {"profileId": "other"}, {"deviceId": "other"}):
        post(client, new, "/profile", body, status=422)
    assert identity(newcomer) is None


@pytest.mark.parametrize("action", ["reject", "revoke", "reissue", "expire"])
def test_invalidated_invites_cannot_claim_or_approve(client, action):
    _, existing = owner(client)
    uid, new = user()
    invitation = invite(client, existing)
    claim(client, new, invitation)
    if action == "reissue":
        invite(client, existing)
    elif action == "expire":
        invite_document(invitation).update({"expiresAt": m.now_utc() - timedelta(seconds=1)})
    else:
        post(client, existing, "/invites/" + invitation["requestId"] + "/" + action)
    post(client, existing, "/invites/" + invitation["requestId"] + "/approve", status=409)
    post(client, new, "/invites/claim", {"code": invitation["code"]}, status=409)
    assert identity(uid) is None


def test_issued_revoke_reissue_and_expiry(client):
    _, existing = owner(client)
    _, new = user()
    for action in ("revoke", "reissue", "expire"):
        invitation = invite(client, existing)
        if action == "revoke":
            post(client, existing, "/invites/" + invitation["requestId"] + "/revoke")
        elif action == "reissue":
            invite(client, existing)
        else:
            invite_document(invitation).update({"expiresAt": m.now_utc() - timedelta(seconds=1)})
        post(client, new, "/invites/claim", {"code": invitation["code"]}, status=409)


def test_claimant_membership_before_claim_or_approval_denied(client):
    _, existing = owner(client)
    _, other = owner(client)
    uid, new = user()
    invitation = invite(client, existing)
    post(client, other, "/invites/claim", {"code": invitation["code"]}, status=409)
    claim(client, new, invitation)
    post(client, new, "/profile")
    before = identity(uid)
    post(client, existing, "/invites/" + invitation["requestId"] + "/approve", status=409)
    assert identity(uid) == before


def test_two_claimants_race_only_one_pending(client):
    _, existing = owner(client)
    users = [user(), user()]
    invitation = invite(client, existing)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda u: client.post("/api/member-sync/invites/claim", headers=u[1], json={"code": invitation["code"]}), users))
    assert sorted(r.status_code for r in results) == [200, 409]
    assert all(identity(uid) is None for uid, _ in users)


@pytest.mark.parametrize("actions", [("approve", "approve"), ("approve", "reject"), ("reject", "approve")])
def test_finalization_races_are_atomic(client, actions, setup):
    _, existing = owner(client)
    uid, new = user()
    invitation = invite(client, existing)
    claim(client, new, invitation)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda action: client.post("/api/member-sync/invites/" + invitation["requestId"] + "/" + action,
                                                          headers=existing, json={}), actions))
    assert sorted(r.status_code for r in results) == [200, 409], setup
    state = invite_document(invitation).get().to_dict()["status"]
    assert (identity(uid) is not None) == (state == "consumed")


def test_claim_revoke_race_leaves_no_membership(client):
    _, existing = owner(client)
    uid, new = user()
    invitation = invite(client, existing)
    with ThreadPoolExecutor(max_workers=2) as pool:
        claim_future = pool.submit(client.post, "/api/member-sync/invites/claim", headers=new, json={"code": invitation["code"]})
        revoke_future = pool.submit(client.post, "/api/member-sync/invites/" + invitation["requestId"] + "/revoke", headers=existing, json={})
        assert claim_future.result().status_code in (200, 409)
        assert revoke_future.result().status_code == 200
    assert invite_document(invitation).get().to_dict()["status"] == "revoked"
    assert identity(uid) is None


def test_concurrent_fifth_and_sixth_device_enforces_cap(client, setup):
    uid, existing = owner(client)
    members = [(uid, existing)]
    for _ in range(3):
        newcomer, new = user()
        invitation = invite(client, existing)
        claim(client, new, invitation)
        post(client, existing, "/invites/" + invitation["requestId"] + "/approve")
        members.append((newcomer, new))
    pending = []
    for _, issuer in members[:2]:
        newcomer, new = user()
        invitation = invite(client, issuer)
        claim(client, new, invitation)
        pending.append((newcomer, invitation))
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda item: client.post("/api/member-sync/invites/" + item[1]["requestId"] + "/approve",
                                                        headers=existing, json={}), pending))
    assert sorted(r.status_code for r in results) == [200, 409], setup
    profile = m.get_member_firestore().document("memberProfiles/" + identity(uid)["profileId"])
    assert profile.get().to_dict()["deviceCount"] == 5
    assert len(list(profile.collection("devices").stream())) == 5


def test_failure_before_commit_leaves_no_partial_identity(client, monkeypatch):
    from google.cloud.firestore_v1.transaction import Transaction
    _, existing = owner(client)
    uid, new = user()
    invitation = invite(client, existing)
    claim(client, new, invitation)
    original = Transaction.create
    def fail_create(tx, ref, data, *args, **kwargs):
        original(tx, ref, data, *args, **kwargs)
        if ref.path.startswith("memberIdentities/"):
            raise RuntimeError("simulated failure before commit")
    monkeypatch.setattr(Transaction, "create", fail_create)
    post(client, existing, "/invites/" + invitation["requestId"] + "/approve", status=503)
    assert identity(uid) is None
    assert invite_document(invitation).get().to_dict()["status"] == "pending"


def test_bruteforce_uid_rate_limit(client):
    _, new = user()
    for _ in range(30):
        post(client, new, "/invites/claim", {"code": "A" * 12}, status=409)
    post(client, new, "/invites/claim", {"code": "A" * 12}, status=429)


@pytest.mark.parametrize("bucket,limit", [("ip:testclient", 100), ("global", 1000)])
def test_ip_and_global_limits(client, bucket, limit):
    _, headers = user()
    window = int(m.now_utc().timestamp()) // 60
    m.get_member_firestore().document("memberSyncLimits/" + m.digest(bucket) + "_" + str(window)).set({"count": limit})
    post(client, headers, "/profile", status=429)


def test_validation_and_errors_do_not_expose_secrets(client, monkeypatch, caplog):
    uid, headers = user()
    for body in [{"code": 123}, {"code": "A" * 33}, {"code": "A" * 12, "uid": "forged"},
                 {"code": "A" * 12, "label": "\n"}, {"code": "A" * 12, "label": "x" * 41}]:
        post(client, headers, "/invites/claim", body, status=422)
    r = client.post("/api/member-sync/profile", headers=headers, content="{" + "x" * 3000)
    assert r.status_code == 413
    r = client.post("/api/member-sync/profile", headers=headers, content="{")
    assert r.status_code == 422
    monkeypatch.setenv("MEMBER_SYNC_HMAC_SECRET", "")
    post(client, headers, "/profile", status=503)
    assert identity(uid) is None
    assert headers["Authorization"] not in caplog.text


def test_app_initialization_explicit_project_and_existing_mismatch(monkeypatch):
    app = m.get_member_app()
    initialize = Mock(return_value=app)
    monkeypatch.setattr(m.firebase_admin, "get_app", Mock(side_effect=ValueError()))
    monkeypatch.setattr(m.firebase_admin, "initialize_app", initialize)
    assert m.get_member_app() is app
    initialize.assert_called_once_with(options={"projectId": m.PROJECT, "httpTimeout": 10}, name="member-sync-admin")
    monkeypatch.setattr(m.firebase_admin, "get_app", Mock(return_value=Mock(project_id="gbf-ai-agent")))
    with pytest.raises(m.PairingError):
        m.get_member_app()


def test_no_membership_and_revoked_identity_cannot_issue_or_restore(client):
    uid, headers = user()
    post(client, headers, "/invites", status=403)
    post(client, headers, "/profile")
    m.get_member_firestore().document("memberIdentities/" + uid).update({"active": False})
    post(client, headers, "/profile", status=403)
    post(client, headers, "/invites", status=403)
    assert identity(uid)["active"] is False


def test_unknown_commit_outcomes_are_not_retried(monkeypatch):
    from google.api_core.exceptions import DeadlineExceeded
    operation = Mock(side_effect=DeadlineExceeded("unknown commit outcome"))
    monkeypatch.setattr(m.firestore, "transactional", lambda fn: operation)
    with pytest.raises(DeadlineExceeded):
        m.atomic(Mock(), Mock())
    assert operation.call_count == 1


def test_concurrent_reissue_leaves_one_usable_code(client, setup):
    _, headers = owner(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        invitations = list(pool.map(lambda _: invite(client, headers), range(2)))
    states = [invite_document(invitation).get().to_dict()["status"] for invitation in invitations]
    assert sorted(states) == ["issued", "revoked"], setup
