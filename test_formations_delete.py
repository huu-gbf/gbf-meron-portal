import base64
import copy
import os
import sys
import threading
from datetime import datetime, timezone
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
POST_ID = "legacy_abc-123"
SECRET_BYTES = bytes(range(32))
SECRET = base64.urlsafe_b64encode(SECRET_BYTES).rstrip(b"=").decode("ascii")
WRONG_SECRET = base64.urlsafe_b64encode(b"z" * 32).rstrip(b"=").decode("ascii")


class FakeSnapshot:
    def __init__(self, reference, data):
        self.reference, self.exists, self._data = reference, data is not None, copy.deepcopy(data)
    def to_dict(self):
        return copy.deepcopy(self._data)


class FakeDocument:
    def __init__(self, database, path):
        self.database, self.path = database, path
    def get(self, transaction=None):
        if self.database.fail_reads:
            raise RuntimeError("secret-database-error-" + SECRET)
        return FakeSnapshot(self, self.database.data.get(self.path))
    @property
    def id(self):
        return self.path[1]


class FakeCollection:
    def __init__(self, database, name): self.database, self.name = database, name
    def document(self, document_id): return FakeDocument(self.database, (self.name, document_id))


class FakeTransaction:
    def __init__(self, database): self.database, self.operations = database, []
    def set(self, reference, values, merge=False): self.operations.append(("set", reference, copy.deepcopy(values), merge))
    def delete(self, reference): self.operations.append(("delete", reference, None, False))
    def commit(self):
        staged = copy.deepcopy(self.database.data)
        is_delete_transaction = any(operation == "delete" for operation, *_ in self.operations)
        for number, (operation, reference, values, merge) in enumerate(self.operations, 1):
            if is_delete_transaction and self.database.fail_delete_write_number == number:
                raise RuntimeError("secret-database-error-" + SECRET)
            if operation == "delete":
                staged.pop(reference.path, None)
                continue
            current = copy.deepcopy(staged.get(reference.path, {})) if merge else {}
            for key, value in values.items():
                if value is main.firestore.DELETE_FIELD: current.pop(key, None)
                else: current[key] = value
            staged[reference.path] = current
        self.database.data = staged


class FakeFirestore:
    def __init__(self):
        self.data, self.lock, self.fail_reads, self.fail_delete_write_number = {}, threading.RLock(), False, None
    def collection(self, name): return FakeCollection(self, name)
    def transaction(self): return FakeTransaction(self)


def fake_transactional(function):
    def run(transaction, *args, **kwargs):
        with transaction.database.lock:
            result = function(transaction, *args, **kwargs)
            transaction.commit()
            return result
    return run


@pytest.fixture
def portal(monkeypatch):
    database = FakeFirestore()
    forbidden_push = MagicMock(side_effect=AssertionError("push path must not be called"))
    forbidden_ai_db = MagicMock(side_effect=AssertionError("AI database must not be called"))
    monkeypatch.setattr(main, "_portal_db", database)
    monkeypatch.setattr(main, "db", forbidden_ai_db)
    monkeypatch.setattr(main.firestore, "transactional", fake_transactional)
    monkeypatch.setattr(main.time, "time", lambda: 1_800_000_010.0)
    monkeypatch.setattr(main, "send_formation_push", forbidden_push)
    monkeypatch.setattr(main, "dispatch_pending_push", forbidden_push)
    monkeypatch.setenv("PORTAL_WRITE_ENABLED", "true")
    monkeypatch.setenv("PORTAL_ALLOW_LOCAL_ORIGINS", "false")
    yield database
    forbidden_push.assert_not_called()
    forbidden_ai_db.assert_not_called()
    assert forbidden_ai_db.mock_calls == []


@pytest.fixture
def client(): return TestClient(main.app, raise_server_exceptions=False)


def paths(category="gw", post_id=POST_ID):
    event_id = f"{category}_{post_id}"
    return ((main.PUSH_FORMATIONS[category], post_id), ("formation_private", event_id), (main.PUSH_OUTBOX_COLLECTION, event_id))


def seed(database, category="gw", post_id=POST_ID, *, outbox_status="pending", public=True, outbox=True):
    public_path, private_path, outbox_path = paths(category, post_id)
    if public: database.data[public_path] = {"schema_version": 2, "id": post_id, "name": "団員A"}
    database.data[private_path] = {"schema_version": 1, "delete_secret_hash": main.hash_delete_secret(SECRET), "payload_hash": "a" * 64, "created_at": datetime(2027, 1, 1, tzinfo=timezone.utc), "timestamp": "2027-01-01T00:00:00Z", "deleted_at": None}
    if outbox: database.data[outbox_path] = {"schema_version": 1, "category": category, "post_id": post_id, "created_at": datetime(2027, 1, 1, tzinfo=timezone.utc), "status": outbox_status, "next_attempt_at": datetime(2027, 1, 1, tzinfo=timezone.utc)}
    return public_path, private_path, outbox_path


def delete(client, category="gw", post_id=POST_ID, secret=SECRET, headers=None):
    values = {"Origin": ORIGIN}
    if secret is not None: values["X-Delete-Secret"] = secret
    if headers: values.update(headers)
    return client.delete(f"/api/formations/{category}/{post_id}", headers=values)


@pytest.mark.parametrize("category", ["gw", "multi", "high"])
def test_correct_secret_deletes_public_tombstones_private_and_cancels_outbox(client, portal, category):
    public_path, private_path, outbox_path = seed(portal, category)
    response = delete(client, category)
    assert response.status_code == 204 and response.content == b""
    assert public_path not in portal.data
    assert portal.data[private_path]["deleted_at"].tzinfo == timezone.utc
    assert portal.data[outbox_path]["status"] == "canceled"
    assert "next_attempt_at" not in portal.data[outbox_path]


@pytest.mark.parametrize("post_id", ["A", "a" * 64, "bad id", "bad/thing", "bad\\thing", "bad\"thing", "a" * 65])
def test_post_id_validation(client, portal, post_id):
    if post_id in {"A", "a" * 64}:
        seed(portal, post_id=post_id)
        assert delete(client, post_id=post_id).status_code == 204
    else:
        response = delete(client, post_id=post_id)
        assert response.status_code == 422 and response.json()["error"]["code"] == "INVALID_INPUT"


def test_wrong_or_missing_secret_never_deletes(client, portal):
    public_path, private_path, outbox_path = seed(portal)
    assert delete(client, secret=WRONG_SECRET).status_code == 403
    assert delete(client, secret=None).status_code == 401
    assert public_path in portal.data and portal.data[private_path]["deleted_at"] is None
    assert portal.data[outbox_path]["status"] == "pending"


@pytest.mark.parametrize("secret", ["", "A" * 42, "A" * 44, "A" * 42 + "=", "+" + "A" * 42, " " + "A" * 42])
def test_malformed_secret_is_401_and_global_only(client, portal, secret):
    seed(portal)
    response = delete(client, secret=secret)
    assert response.status_code == 401 and response.json()["error"]["code"] == "DELETE_SECRET_REQUIRED"
    assert all("formation_delete_global" in path[1] for path in portal.data if path[0] == "portal_rate_limits")


def test_legacy_public_and_private_missing_are_not_authorized(client, portal):
    public_path, _, _ = paths()
    portal.data[public_path] = {"id": POST_ID, "name": "団員A", "authorId": "anything"}
    response = delete(client)
    assert response.status_code == 403 and response.json()["error"]["code"] == "DELETE_NOT_AUTHORIZED"
    assert public_path in portal.data


def test_missing_public_outbox_is_allowed_and_double_delete_preserves_tombstone(client, portal):
    _, private_path, _ = seed(portal, public=False, outbox=False)
    assert delete(client).status_code == 204
    deleted_at = portal.data[private_path]["deleted_at"]
    assert delete(client).status_code == 204
    assert portal.data[private_path]["deleted_at"] == deleted_at


@pytest.mark.parametrize("status", ["retry", "processing", "unknown"])
def test_unfinished_or_malformed_outbox_is_canceled_and_lease_is_removed(client, portal, status):
    _, _, outbox_path = seed(portal, outbox_status=status)
    portal.data[outbox_path].update({"lease_id": "old", "lease_until": datetime(2027, 1, 2, tzinfo=timezone.utc), "retry_after": datetime(2027, 1, 2, tzinfo=timezone.utc), "round_attempted": ["x"]})
    assert delete(client).status_code == 204
    outbox = portal.data[outbox_path]
    assert outbox["status"] == "canceled"
    assert not {"next_attempt_at", "lease_id", "lease_until", "retry_after", "round_attempted"} & set(outbox)


@pytest.mark.parametrize("status", ["sent", "failed"])
def test_terminal_outbox_status_is_preserved(client, portal, status):
    _, _, outbox_path = seed(portal, outbox_status=status)
    assert delete(client).status_code == 204
    assert portal.data[outbox_path]["status"] == status


def test_already_canceled_outbox_cleans_non_terminal_fields_and_keeps_history(client, portal):
    _, _, outbox_path = seed(portal, outbox_status="canceled")
    outbox = portal.data[outbox_path]
    outbox.update({
        "lease_id": "old",
        "lease_until": datetime(2027, 1, 2, tzinfo=timezone.utc),
        "retry_after": datetime(2027, 1, 2, tzinfo=timezone.utc),
        "round_attempted": ["x"],
        "recipients": ["recipient"],
        "delivered": ["recipient"],
        "permanent_failed": ["failed"],
    })
    assert delete(client).status_code == 204
    outbox = portal.data[outbox_path]
    assert outbox["status"] == "canceled"
    assert not {"next_attempt_at", "lease_id", "lease_until", "retry_after", "round_attempted"} & set(outbox)
    assert outbox["recipients"] == ["recipient"]
    assert outbox["delivered"] == ["recipient"]
    assert outbox["permanent_failed"] == ["failed"]


def test_deleted_tombstone_redeletes_reappeared_public(client, portal):
    public_path, private_path, _ = seed(portal)
    prior = datetime(2027, 1, 2, tzinfo=timezone.utc)
    portal.data[private_path]["deleted_at"] = prior
    assert delete(client).status_code == 204
    assert public_path not in portal.data and portal.data[private_path]["deleted_at"] == prior


def test_category_origin_gate_and_preflight(client, portal, monkeypatch):
    assert delete(client, category="other").status_code == 404
    assert delete(client, headers={"Origin": "https://evil.example"}).status_code == 403
    assert delete(client, headers={"Origin": "null"}).status_code == 403
    monkeypatch.setenv("PORTAL_WRITE_ENABLED", "false")
    assert delete(client).status_code == 503
    monkeypatch.setenv("PORTAL_WRITE_ENABLED", "true")
    response = client.options("/api/formations/gw/A", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "DELETE", "Access-Control-Request-Headers": "x-delete-secret"})
    assert response.status_code == 200
    assert "DELETE" in response.headers["access-control-allow-methods"]
    assert "x-delete-secret" in response.headers["access-control-allow-headers"].lower()


def test_atomic_delete_failures_and_read_failure_are_sanitized(client, portal, capsys):
    public_path, private_path, outbox_path = seed(portal)
    before = copy.deepcopy({path: portal.data[path] for path in (public_path, private_path, outbox_path)})
    for write_number in (1, 2, 3):
        portal.fail_delete_write_number = write_number
        assert delete(client).status_code == 503
        assert {path: portal.data[path] for path in (public_path, private_path, outbox_path)} == before
    portal.fail_delete_write_number, portal.fail_reads = None, True
    response = delete(client)
    captured = capsys.readouterr()
    assert response.status_code == 503 and SECRET not in response.text + captured.out + captured.err
    assert public_path in portal.data and portal.data[private_path]["deleted_at"] is None and portal.data[outbox_path]["status"] == "pending"


def test_valid_subject_quota_and_malformed_global_quota(client, portal):
    seed(portal, public=False, outbox=False)
    assert [delete(client).status_code for _ in range(10)] == [204] * 10
    limited = delete(client)
    assert limited.status_code == 429 and limited.headers["retry-after"]
    portal.data.clear()
    valid_secrets = [base64.urlsafe_b64encode(number.to_bytes(32, "big")).rstrip(b"=").decode("ascii") for number in range(1, 102)]
    assert [delete(client, secret=secret).status_code for secret in valid_secrets[:100]] == [403] * 100
    assert delete(client, secret=valid_secrets[100]).status_code == 429
    portal.data.clear()
    assert [delete(client, secret="bad").status_code for _ in range(100)] == [401] * 100
    assert delete(client, secret="bad").status_code == 429


def test_no_secret_is_stored_in_documents_or_response(client, portal):
    seed(portal)
    response = delete(client)
    assert response.status_code == 204 and SECRET not in repr(portal.data) and SECRET not in response.text
