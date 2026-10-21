"""Offline auth diagnostics: actual dependency/HTTP responses, mocked SDK only."""
import json
import logging
import socket
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from firebase_admin import auth, exceptions
from starlette.requests import Request

from backend import member_sync as m


SECRETS = (
    "dummy-id-token", "dummy-refresh-token", "dummy-uid", "dummy-profile",
    "dummy-device", "dummy@example.test", "192.0.2.123", "ABCDEFGHJKLM",
    "dummy-hmac", "dummy-api-key", "dummy-cookie", "dummy-exception-message",
)
PRIVATE_MESSAGE = " ".join(SECRETS)
CLAIMS = {"uid": "dummy-uid", "firebase": {"sign_in_provider": "anonymous"},
          "exp": 4102444800}


@pytest.fixture(autouse=True)
def isolated(monkeypatch, caplog):
    monkeypatch.setattr(m, "_auth_log_times", {})
    caplog.set_level(logging.WARNING, logger=m.__name__)
    original = socket.socket.connect

    def loopback_only(sock, address):
        if isinstance(address, tuple) and address[0] not in ("127.0.0.1", "::1", "localhost"):
            raise AssertionError("external network forbidden")
        return original(sock, address)

    monkeypatch.setattr(socket.socket, "connect", loopback_only)


@pytest.fixture
def boundary(monkeypatch):
    verifier = Mock(return_value=CLAIMS.copy())
    factory = Mock(return_value=verifier)
    store = Mock(side_effect=AssertionError("Firestore forbidden in rejected auth"))
    quota = Mock(side_effect=AssertionError("Quota forbidden in rejected auth"))
    key = Mock(return_value=b"local-dummy-only")
    monkeypatch.setattr(m, "get_member_auth", factory)
    monkeypatch.setattr(m, "get_member_firestore", store)
    monkeypatch.setattr(m, "consume_quota", quota)
    monkeypatch.setattr(m, "server_key", key)
    return SimpleNamespace(verifier=verifier, factory=factory, store=store, quota=quota, key=key)


@pytest.fixture
def client():
    parent = FastAPI()
    parent.mount("/api/member-sync", m.api)
    with TestClient(parent) as value:
        yield value


def rejected(client, boundary, header="Bearer dummy-id-token"):
    response = client.post("/api/member-sync/profile", json={}, headers={
        "Authorization": header, "Cookie": "dummy-cookie"})
    assert response.status_code == 401
    assert response.json() == {"error": {"code": "UNAUTHENTICATED"}}
    assert response.headers["cache-control"] == "no-store"
    boundary.store.assert_not_called()
    boundary.quota.assert_not_called()
    boundary.key.assert_not_called()
    assert not any(secret in response.text for secret in SECRETS)
    return response


def diagnostic(caplog, phase, reason):
    records = [r for r in caplog.records if r.name == m.__name__]
    assert len(records) == 1
    record = records[0]
    assert json.loads(record.getMessage()) == {
        "event": "member_auth_rejected", "phase": phase, "reason": reason}
    assert record.exc_info is None and record.exc_text is None and record.stack_info is None
    assert not any(secret in caplog.text for secret in SECRETS)
    assert "Traceback" not in caplog.text


@pytest.mark.parametrize("header", [None, "", "Basic dummy-id-token", "bearer dummy-id-token", "Bearer "])
def test_missing_or_bad_header_stays_401_without_logging(client, boundary, caplog, header):
    headers = {} if header is None else {"Authorization": header}
    response = client.post("/api/member-sync/profile", json={}, headers=headers)
    assert response.status_code == 401
    assert response.json() == {"error": {"code": "UNAUTHENTICATED"}}
    boundary.factory.assert_not_called()
    boundary.store.assert_not_called()
    boundary.quota.assert_not_called()
    assert not caplog.records


@pytest.mark.parametrize("failure,reason", [
    (auth.InvalidIdTokenError(PRIVATE_MESSAGE), "invalid_token"),
    (auth.ExpiredIdTokenError(PRIVATE_MESSAGE, None), "expired_token"),
    (auth.RevokedIdTokenError(PRIVATE_MESSAGE), "revoked_token"),
    (auth.UserDisabledError(PRIVATE_MESSAGE), "disabled_user"),
    (auth.CertificateFetchError(PRIVATE_MESSAGE, None), "certificate_fetch"),
    (auth.InsufficientPermissionError(PRIVATE_MESSAGE, None, None), "permission_denied"),
    (exceptions.PermissionDeniedError(PRIVATE_MESSAGE), "permission_denied"),
    (exceptions.UnavailableError(PRIVATE_MESSAGE), "service_unavailable"),
    (auth.UserNotFoundError(PRIVATE_MESSAGE), "verification_other"),
    (ValueError(PRIVATE_MESSAGE), "verification_other"),
    (RuntimeError(PRIVATE_MESSAGE), "verification_other"),
], ids=["invalid", "expired", "revoked", "disabled", "certificate", "insufficient-permission",
        "permission", "unavailable", "user-not-found", "value-error", "unknown"])
def test_sdk_failures_are_safe_and_do_not_persist(client, boundary, caplog, failure, reason):
    boundary.verifier.side_effect = failure
    rejected(client, boundary)
    boundary.verifier.assert_called_once_with("dummy-id-token")
    diagnostic(caplog, "verify_id_token", reason)


@pytest.mark.parametrize("claims", [
    {}, dict(CLAIMS, uid="bad/uid"), dict(CLAIMS, firebase={"sign_in_provider": "password"}),
    dict(CLAIMS, exp=0), dict(CLAIMS, exp="4102444800"), dict(CLAIMS, firebase=None), None,
])
def test_claims_failure_separate_from_sdk_failure(client, boundary, caplog, claims):
    boundary.verifier.return_value = claims
    rejected(client, boundary)
    diagnostic(caplog, "claims", "claims_rejected")


def test_success_keeps_token_uid_store_and_quota_flow(boundary, caplog):
    store = object()
    boundary.store.side_effect = None
    boundary.store.return_value = store
    boundary.quota.side_effect = None
    request = Request({"type": "http", "headers": [(b"authorization", b"Bearer dummy-id-token")],
                       "client": ("192.0.2.123", 1)})
    assert m.authenticated(request) == ("dummy-uid", store)
    boundary.verifier.assert_called_once_with("dummy-id-token")
    boundary.quota.assert_called_once_with(store, "dummy-uid", "192.0.2.123")
    boundary.key.assert_called_once_with()
    assert not caplog.records


def test_named_app_project_and_check_revoked_unchanged(monkeypatch):
    app = SimpleNamespace(project_id="gbf-meron-portal")
    initialize = Mock(return_value=app)
    monkeypatch.setenv("MEMBER_SYNC_PROJECT_ID", "gbf-meron-portal")
    monkeypatch.setattr(m.firebase_admin, "get_app", Mock(side_effect=ValueError()))
    monkeypatch.setattr(m.firebase_admin, "initialize_app", initialize)
    verify = Mock(return_value=CLAIMS)
    monkeypatch.setattr(m.auth, "verify_id_token", verify)
    assert m.get_member_auth()("dummy-id-token") == CLAIMS
    initialize.assert_called_once_with(options={"projectId": "gbf-meron-portal", "httpTimeout": 10},
                                       name="member-sync-admin")
    verify.assert_called_once_with("dummy-id-token", app=app, check_revoked=True)


def test_initialization_failure_not_reclassified(client, boundary, caplog):
    boundary.factory.side_effect = m.PairingError(503, "NOT_READY")
    response = client.post("/api/member-sync/profile", json={}, headers={"Authorization": "Bearer dummy-id-token"})
    assert response.status_code == 503
    assert response.json() == {"error": {"code": "NOT_READY"}}
    boundary.store.assert_not_called()
    assert not caplog.records


def test_unknown_exception_is_never_stringified(client, boundary, caplog):
    class PrivateError(Exception):
        def __str__(self):
            raise AssertionError("must not stringify")

        __repr__ = __str__

    boundary.verifier.side_effect = PrivateError()
    rejected(client, boundary)
    diagnostic(caplog, "verify_id_token", "verification_other")


def test_logging_failure_cannot_change_401(client, boundary, monkeypatch):
    boundary.verifier.side_effect = RuntimeError(PRIVATE_MESSAGE)
    monkeypatch.setattr(m._auth_log, "warning", Mock(side_effect=RuntimeError(PRIVATE_MESSAGE)))
    rejected(client, boundary)


def test_repeated_categories_are_bounded_and_reopen_after_60_seconds(monkeypatch, caplog):
    clock = [100.0]
    monkeypatch.setattr(m, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    failure = auth.InvalidIdTokenError(PRIVATE_MESSAGE)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _: m.log_auth_rejection("verify_id_token", failure), range(100)))
    assert len(caplog.records) == 1
    clock[0] = 159.999
    m.log_auth_rejection("verify_id_token", failure)
    assert len(caplog.records) == 1
    m.log_auth_rejection("verify_id_token", exceptions.PermissionDeniedError(PRIVATE_MESSAGE))
    assert len(caplog.records) == 2  # A different failure is not hidden by invalid tokens.
    clock[0] = 160.0
    m.log_auth_rejection("verify_id_token", failure)
    assert len(caplog.records) == 3


def test_unknown_classes_cannot_expand_log_state_or_fields(caplog):
    for i in range(100):
        failure = type("private_class_" + str(i), (Exception,), {})(PRIVATE_MESSAGE)
        m.log_auth_rejection("private_phase_" + str(i), failure)
    assert len(m._auth_log_times) == 1
    diagnostic(caplog, "verify_id_token", "verification_other")
