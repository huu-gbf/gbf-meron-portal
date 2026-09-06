import copy
import hashlib
import os
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import MagicMock

import google.cloud.firestore
import google.genai
import pytest
from fastapi.testclient import TestClient


os.environ["GEMINI_API_KEY"] = "test"
os.environ["PORTAL_WRITE_ENABLED"] = "true"
os.environ["PORTAL_ALLOW_LOCAL_ORIGINS"] = "false"

google.cloud.firestore.Client = MagicMock()
google.genai.Client = MagicMock()

backend_path = Path(__file__).parent / "backend"
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(backend_path))

import backend.main as main


ORIGIN = "https://huu-gbf.github.io"
HEADERS = {"Origin": ORIGIN}
INSTALLATION_ID = "12345678-1234-4234-8234-123456789012"
UPPERCASE_INSTALLATION_ID = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"


class FakeSnapshot:
    def __init__(self, data):
        self.exists = data is not None
        self._data = copy.deepcopy(data)

    def to_dict(self):
        return copy.deepcopy(self._data)


class FakeDocument:
    def __init__(self, database, path):
        self.database = database
        self.path = path

    def get(self, transaction=None):
        if self.database.fail_reads:
            raise RuntimeError("secret-database-error")
        return FakeSnapshot(self.database.data.get(self.path))


class FakeCollection:
    def __init__(self, database, name):
        self.database = database
        self.name = name

    def document(self, document_id):
        return FakeDocument(self.database, (self.name, document_id))


class FakeTransaction:
    def __init__(self, database):
        self.database = database

    def set(self, reference, values, merge=False):
        if self.database.fail_writes:
            raise RuntimeError("secret-database-error")
        current = copy.deepcopy(self.database.data.get(reference.path, {}))
        result = current if merge else {}
        for key, value in values.items():
            if value is main.firestore.DELETE_FIELD:
                result.pop(key, None)
            else:
                result[key] = value
        self.database.data[reference.path] = result


class FakeFirestore:
    def __init__(self):
        self.data = {}
        self.lock = threading.RLock()
        self.fail_reads = False
        self.fail_writes = False

    def collection(self, name):
        return FakeCollection(self, name)

    def transaction(self):
        return FakeTransaction(self)


def fake_transactional(function):
    def run(transaction, *args, **kwargs):
        with transaction.database.lock:
            return function(transaction, *args, **kwargs)

    return run


@pytest.fixture
def portal(monkeypatch):
    database = FakeFirestore()
    monkeypatch.setattr(main, "_portal_db", database)
    monkeypatch.setattr(main.firestore, "transactional", fake_transactional)
    monkeypatch.setattr(main.time, "time", lambda: 1_800_000_010.0)
    monkeypatch.setenv("PORTAL_WRITE_ENABLED", "true")
    monkeypatch.setenv("PORTAL_ALLOW_LOCAL_ORIGINS", "false")
    main.db.reset_mock()
    yield database
    main.db.reset_mock()


@pytest.fixture
def client():
    return TestClient(main.app, raise_server_exceptions=False)


def post(client, path, payload, headers=None):
    return client.post(path, json=payload, headers=headers or HEADERS)


def token_path(installation_id=INSTALLATION_ID):
    canonical = str(uuid.UUID(installation_id)).lower()
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return ("notification_tokens", digest)


def test_status_for_unknown_installation(client, portal):
    response = post(
        client,
        "/api/notifications/status",
        {"installation_id": INSTALLATION_ID},
    )
    assert response.status_code == 200
    assert response.json() == {"enabled": False, "revision": 0}
    assert response.headers["cache-control"] == "no-store"
    main.db.assert_not_called()


def test_subscribe_creates_schema_two_document(client, portal):
    response = post(
        client,
        "/api/notifications/subscribe",
        {
            "installation_id": INSTALLATION_ID,
            "token": "token-A",
            "expected_revision": 0,
        },
    )
    assert response.status_code == 200
    assert response.json() == {"enabled": True, "revision": 1}
    saved = portal.data[token_path()]
    assert saved["schema_version"] == 2
    assert saved["enabled"] is True
    assert saved["token"] == "token-A"
    assert saved["revision"] == 1
    assert "created_at" in saved and "updated_at" in saved
    assert INSTALLATION_ID not in repr(portal.data)
    assert portal.data[("portal_meta", "notification_capacity")] == {
        "active_count": 1
    }
    main.db.assert_not_called()


def test_token_rotation_reuses_document_and_capacity(client, portal):
    first = post(
        client,
        "/api/notifications/subscribe",
        {
            "installation_id": UPPERCASE_INSTALLATION_ID.lower(),
            "token": "token-A",
            "expected_revision": 0,
        },
    )
    second = post(
        client,
        "/api/notifications/subscribe",
        {
            "installation_id": UPPERCASE_INSTALLATION_ID,
            "token": "token-B",
            "expected_revision": 1,
        },
    )
    assert first.status_code == second.status_code == 200
    assert second.json() == {"enabled": True, "revision": 2}
    uppercase_path = token_path(UPPERCASE_INSTALLATION_ID)
    assert portal.data[uppercase_path]["token"] == "token-B"
    assert UPPERCASE_INSTALLATION_ID not in repr(portal.data)
    assert portal.data[("portal_meta", "notification_capacity")][
        "active_count"
    ] == 1


def test_revision_conflict_does_not_change_document(client, portal):
    portal.data[token_path()] = {
        "schema_version": 2,
        "enabled": True,
        "token": "new-token",
        "revision": 4,
    }
    portal.data[("portal_meta", "notification_capacity")] = {"active_count": 1}
    response = post(
        client,
        "/api/notifications/subscribe",
        {
            "installation_id": INSTALLATION_ID,
            "token": "stale-token",
            "expected_revision": 3,
        },
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "REVISION_CONFLICT"
    assert portal.data[token_path()]["token"] == "new-token"
    assert portal.data[token_path()]["revision"] == 4


def test_unsubscribe_needs_no_token_and_leaves_tombstone(client, portal):
    portal.data[token_path()] = {
        "schema_version": 2,
        "enabled": True,
        "token": "secret-token",
        "revision": 7,
        "created_at": "preserved",
    }
    portal.data[("portal_meta", "notification_capacity")] = {"active_count": 1}
    response = post(
        client,
        "/api/notifications/unsubscribe",
        {"installation_id": INSTALLATION_ID},
    )
    assert response.status_code == 200
    assert response.json() == {"enabled": False, "revision": 8}
    saved = portal.data[token_path()]
    assert saved["enabled"] is False
    assert saved["revision"] == 8
    assert saved["created_at"] == "preserved"
    assert "token" not in saved
    assert portal.data[("portal_meta", "notification_capacity")][
        "active_count"
    ] == 0


def test_repeated_unsubscribe_keeps_revision(client, portal):
    first = post(
        client,
        "/api/notifications/unsubscribe",
        {"installation_id": INSTALLATION_ID},
    )
    second = post(
        client,
        "/api/notifications/unsubscribe",
        {"installation_id": INSTALLATION_ID},
    )
    assert first.json() == second.json() == {"enabled": False, "revision": 1}


def test_delayed_subscribe_after_unsubscribe_conflicts(client, portal):
    disabled = post(
        client,
        "/api/notifications/unsubscribe",
        {"installation_id": INSTALLATION_ID},
    )
    stale = post(
        client,
        "/api/notifications/subscribe",
        {
            "installation_id": INSTALLATION_ID,
            "token": "old-token",
            "expected_revision": 0,
        },
    )
    assert disabled.status_code == 200
    assert stale.status_code == 409
    assert portal.data[token_path()]["enabled"] is False
    assert "token" not in portal.data[token_path()]


def test_capacity_rejects_501st_active_subscription(client, portal):
    portal.data[("portal_meta", "notification_capacity")] = {
        "active_count": 500
    }
    response = post(
        client,
        "/api/notifications/subscribe",
        {
            "installation_id": INSTALLATION_ID,
            "token": "token-A",
            "expected_revision": 0,
        },
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "SUBSCRIPTION_CAPACITY"
    assert token_path() not in portal.data


def test_parallel_subscribe_only_one_revision_zero_request_wins(client, portal):
    payload = {
        "installation_id": INSTALLATION_ID,
        "token": "same-token",
        "expected_revision": 0,
    }
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(
            executor.map(
                lambda _: post(client, "/api/notifications/subscribe", payload),
                range(2),
            )
        )
    assert sorted(response.status_code for response in responses) == [200, 409]
    assert portal.data[token_path()]["revision"] == 1
    assert portal.data[("portal_meta", "notification_capacity")][
        "active_count"
    ] == 1


def test_parallel_subscribe_and_unsubscribe_finishes_off_with_zero_capacity(
    client,
    portal,
):
    portal.data[("portal_meta", "notification_capacity")] = {"active_count": 0}
    subscribe_payload = {
        "installation_id": INSTALLATION_ID,
        "token": "same-token",
        "expected_revision": 0,
    }

    with ThreadPoolExecutor(max_workers=2) as executor:
        subscribe_future = executor.submit(
            post,
            client,
            "/api/notifications/subscribe",
            subscribe_payload,
        )
        unsubscribe_future = executor.submit(
            post,
            client,
            "/api/notifications/unsubscribe",
            {"installation_id": INSTALLATION_ID},
        )
        subscribe_response = subscribe_future.result()
        unsubscribe_response = unsubscribe_future.result()

    assert unsubscribe_response.status_code == 200
    assert subscribe_response.status_code in {200, 409}
    assert portal.data[token_path()]["enabled"] is False
    assert "token" not in portal.data[token_path()]
    assert portal.data[("portal_meta", "notification_capacity")][
        "active_count"
    ] == 0


def test_notification_on_rate_limit_is_shared_by_status_and_subscribe(
    client,
    portal,
):
    for _ in range(10):
        response = post(
            client,
            "/api/notifications/status",
            {"installation_id": INSTALLATION_ID},
        )
        assert response.status_code == 200
    response = post(
        client,
        "/api/notifications/subscribe",
        {
            "installation_id": INSTALLATION_ID,
            "token": "token-A",
            "expected_revision": 0,
        },
    )
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "RATE_LIMITED"
    assert int(response.headers["retry-after"]) >= 1
    assert token_path() not in portal.data


def test_unsubscribe_has_independent_rate_limit_group(client, portal):
    for _ in range(10):
        assert post(
            client,
            "/api/notifications/status",
            {"installation_id": INSTALLATION_ID},
        ).status_code == 200
    response = post(
        client,
        "/api/notifications/unsubscribe",
        {"installation_id": INSTALLATION_ID},
    )
    assert response.status_code == 200


def test_global_rate_limit_rejects_101st_installation(client, portal):
    for index in range(100):
        installation_id = f"12345678-1234-4234-8234-{index:012d}"
        response = post(
            client,
            "/api/notifications/status",
            {"installation_id": installation_id},
        )
        assert response.status_code == 200
    response = post(
        client,
        "/api/notifications/status",
        {"installation_id": "87654321-4321-4321-8321-999999999999"},
    )
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "RATE_LIMITED"


@pytest.mark.parametrize(
    "payload",
    [
        {"installation_id": "not-a-uuid"},
        {"installation_id": INSTALLATION_ID, "extra": "rejected"},
    ],
)
def test_status_rejects_invalid_input(client, portal, payload):
    response = post(client, "/api/notifications/status", payload)
    assert response.status_code == 422
    assert response.json() == {
        "error": {
            "code": "INVALID_INPUT",
            "message": "リクエストを確認してください。",
        }
    }


@pytest.mark.parametrize(
    "token",
    ["", "contains space", "contains\nnewline", "あ", "a" * 4097],
)
def test_subscribe_rejects_invalid_token(client, portal, token):
    response = post(
        client,
        "/api/notifications/subscribe",
        {
            "installation_id": INSTALLATION_ID,
            "token": token,
            "expected_revision": 0,
        },
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"


def test_expected_revision_rejects_boolean(client, portal):
    response = post(
        client,
        "/api/notifications/subscribe",
        {
            "installation_id": INSTALLATION_ID,
            "token": "token-A",
            "expected_revision": True,
        },
    )
    assert response.status_code == 422


def test_invalid_json_and_content_type_have_fixed_errors(client, portal):
    invalid_json = client.post(
        "/api/notifications/status",
        content="{",
        headers={"Origin": ORIGIN, "Content-Type": "application/json"},
    )
    wrong_type = client.post(
        "/api/notifications/status",
        content="{}",
        headers={"Origin": ORIGIN, "Content-Type": "text/plain"},
    )
    assert invalid_json.status_code == 400
    assert invalid_json.json()["error"]["code"] == "INVALID_JSON"
    assert wrong_type.status_code == 415
    assert wrong_type.json()["error"]["code"] == "UNSUPPORTED_MEDIA_TYPE"


@pytest.mark.parametrize(
    "path",
    [
        "/api/notifications/status",
        "/api/notifications/subscribe",
        "/api/notifications/unsubscribe",
    ],
)
def test_github_pages_cors_preflight_bypasses_json_guard(
    client,
    portal,
    path,
):
    response = client.options(
        path,
        headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert "POST" in response.headers["access-control-allow-methods"]
    assert "Content-Type" in response.headers["access-control-allow-headers"]


@pytest.mark.parametrize(
    ("content", "content_type", "expected_status", "expected_code"),
    [
        (b"{}", "text/plain", 415, "UNSUPPORTED_MEDIA_TYPE"),
        (b"x" * 8193, "application/json", 413, "BODY_TOO_LARGE"),
    ],
)
def test_guard_errors_include_cors_headers_for_allowed_origin(
    client,
    portal,
    content,
    content_type,
    expected_status,
    expected_code,
):
    response = client.post(
        "/api/notifications/status",
        content=content,
        headers={"Origin": ORIGIN, "Content-Type": content_type},
    )
    assert response.status_code == expected_status
    assert response.json()["error"]["code"] == expected_code
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert "Origin" in response.headers["vary"]


def test_origin_body_limit_and_disabled_switch(client, portal, monkeypatch):
    forbidden = post(
        client,
        "/api/notifications/status",
        {"installation_id": INSTALLATION_ID},
        headers={"Origin": "https://example.com"},
    )
    oversized = client.post(
        "/api/notifications/status",
        content=b"x" * 8193,
        headers={"Origin": ORIGIN, "Content-Type": "application/json"},
    )
    monkeypatch.setenv("PORTAL_WRITE_ENABLED", "false")
    disabled = post(
        client,
        "/api/notifications/status",
        {"installation_id": INSTALLATION_ID},
    )
    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "ORIGIN_NOT_ALLOWED"
    assert oversized.status_code == 413
    assert oversized.json()["error"]["code"] == "BODY_TOO_LARGE"
    assert disabled.status_code == 503
    assert disabled.json()["error"]["code"] == "PORTAL_NOT_READY"


def test_store_failure_does_not_leak_input(client, portal, capsys):
    portal.fail_reads = True
    secret_token = "secret-token-that-must-not-leak"
    response = post(
        client,
        "/api/notifications/subscribe",
        {
            "installation_id": INSTALLATION_ID,
            "token": secret_token,
            "expected_revision": 0,
        },
    )
    captured = capsys.readouterr()
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "STORE_UNAVAILABLE"
    combined = captured.out + captured.err + response.text
    assert secret_token not in combined
    assert INSTALLATION_ID not in combined


def test_portal_client_is_lazy_and_uses_portal_project(monkeypatch):
    factory = MagicMock(return_value=FakeFirestore())
    monkeypatch.setattr(main.firestore, "Client", factory)
    monkeypatch.setattr(main, "_portal_db", None)
    first = main.get_portal_db()
    second = main.get_portal_db()
    assert first is second
    factory.assert_called_once_with(project="gbf-meron-portal")
