import base64
import copy
import hashlib
import os
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock

import google.cloud.firestore
import google.genai
import pytest
from fastapi.testclient import TestClient


os.environ["GEMINI_API_KEY"] = "test"
os.environ["PORTAL_WRITE_ENABLED"] = "true"
os.environ["PORTAL_PUSH_ENABLED"] = "false"
os.environ["PORTAL_ALLOW_LOCAL_ORIGINS"] = "false"
google.cloud.firestore.Client = MagicMock()
google.genai.Client = MagicMock()

backend_path = Path(__file__).parent / "backend"
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(backend_path))

import backend.main as main


ORIGIN = "https://huu-gbf.github.io"
HEADERS = {"Origin": ORIGIN}
REQUEST_ID = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"
POST_ID = REQUEST_ID.lower()
SECRET_BYTES = bytes(range(32))
DELETE_SECRET = base64.urlsafe_b64encode(SECRET_BYTES).rstrip(b"=").decode("ascii")
JPEG = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xffbody\xff\xd9").decode("ascii")


class FakeSnapshot:
    def __init__(self, reference, data):
        self.reference = reference
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
        return FakeSnapshot(self, self.database.data.get(self.path))

    @property
    def id(self):
        return self.path[1]


class FakeQuery:
    def __init__(self, database, collection, filters=None, maximum=None):
        self.database = database
        self.collection = collection
        self.filters = filters or []
        self.maximum = maximum

    def where(self, field=None, operator=None, value=None, filter=None):
        if filter is not None:
            field, operator, value = filter.field_path, filter.op_string, filter.value
        return FakeQuery(self.database, self.collection, self.filters + [(field, operator, value)], self.maximum)

    def order_by(self, field):
        return self

    def limit(self, maximum):
        return FakeQuery(self.database, self.collection, self.filters, maximum)

    def stream(self, transaction=None):
        rows = []
        for path, data in self.database.data.items():
            if path[0] != self.collection:
                continue
            matches = True
            for field, operator, value in self.filters:
                actual = data.get(field)
                if operator == "==" and actual != value:
                    matches = False
                elif operator == "<=" and not (actual is not None and actual <= value):
                    matches = False
                elif operator == ">=" and not (actual is not None and actual >= value):
                    matches = False
            if matches:
                rows.append(FakeSnapshot(FakeDocument(self.database, path), data))
        return rows[: self.maximum]


class FakeCollection:
    def __init__(self, database, name):
        self.database = database
        self.name = name

    def document(self, document_id):
        return FakeDocument(self.database, (self.name, document_id))

    def where(self, field=None, operator=None, value=None, filter=None):
        return FakeQuery(self.database, self.name).where(field, operator, value, filter)


class FakeTransaction:
    def __init__(self, database):
        self.database = database
        self.operations = []

    def set(self, reference, values, merge=False):
        self.operations.append(("set", reference, copy.deepcopy(values), merge))

    def create(self, reference, values):
        self.operations.append(("create", reference, copy.deepcopy(values), False))

    def commit(self):
        staged = copy.deepcopy(self.database.data)
        create_number = 0
        for operation, reference, values, merge in self.operations:
            if operation == "create":
                create_number += 1
                if self.database.fail_create_write_number == create_number:
                    raise RuntimeError("secret-database-error")
                if reference.path in staged:
                    raise RuntimeError("already-exists")
            current = copy.deepcopy(staged.get(reference.path, {})) if merge else {}
            for key, value in values.items():
                if value is main.firestore.DELETE_FIELD:
                    current.pop(key, None)
                else:
                    current[key] = value
            staged[reference.path] = current
        self.database.data = staged


class FakeFirestore:
    def __init__(self):
        self.data = {}
        self.lock = threading.RLock()
        self.fail_reads = False
        self.fail_create_write_number = None

    def collection(self, name):
        return FakeCollection(self, name)

    def transaction(self):
        return FakeTransaction(self)


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
    forbidden = MagicMock(side_effect=AssertionError("push path must not be called"))
    forbidden_ai_db = MagicMock(side_effect=AssertionError("AI database must not be called"))
    monkeypatch.setattr(main, "_portal_db", database)
    monkeypatch.setattr(main, "db", forbidden_ai_db)
    monkeypatch.setattr(main.firestore, "transactional", fake_transactional)
    monkeypatch.setattr(main.time, "time", lambda: 1_800_000_010.0)
    monkeypatch.setattr(main, "send_formation_push", forbidden)
    monkeypatch.setattr(main, "dispatch_pending_push", forbidden)
    monkeypatch.setenv("PORTAL_WRITE_ENABLED", "true")
    monkeypatch.setenv("PORTAL_PUSH_ENABLED", "false")
    monkeypatch.setenv("PORTAL_ALLOW_LOCAL_ORIGINS", "false")
    yield database, forbidden
    forbidden.assert_not_called()
    forbidden_ai_db.assert_not_called()
    assert forbidden_ai_db.mock_calls == []


@pytest.fixture
def client():
    return TestClient(main.app, raise_server_exceptions=False)


def payload(**changes):
    value = {
        "request_id": REQUEST_ID,
        "delete_secret": DELETE_SECRET,
        "name": "  団員A  ",
        "comment": "  コメント\n二行目  ",
        "images": [JPEG],
    }
    value.update(changes)
    return value


def post(client, category="gw", value=None, headers=None):
    return client.post(
        f"/api/formations/{category}",
        json=payload() if value is None else value,
        headers=HEADERS if headers is None else headers,
    )


def paths(category="gw", post_id=POST_ID):
    event_id = f"{category}_{post_id}"
    return (
        (main.PUSH_FORMATIONS[category], post_id),
        ("formation_private", event_id),
        (main.PUSH_OUTBOX_COLLECTION, event_id),
    )


def formation_documents(database):
    return {path: data for path, data in database.data.items() if path in paths()}


@pytest.mark.parametrize("category", ["gw", "multi", "high"])
def test_create_writes_three_documents_and_no_secret_or_push(client, portal, category):
    database, forbidden = portal
    response = post(client, category)
    assert response.status_code == 201
    body = response.json()
    assert body == {
        "id": POST_ID,
        "category": category,
        "timestamp": body["timestamp"],
        "replayed": False,
    }
    assert body["timestamp"].endswith("Z")
    public_path, private_path, outbox_path = paths(category)
    public = database.data[public_path]
    private = database.data[private_path]
    outbox = database.data[outbox_path]
    assert public == {
        "schema_version": 2,
        "id": POST_ID,
        "name": "団員A",
        "comment": "コメント\n二行目",
        "images": [JPEG],
        "timestamp": body["timestamp"],
    }
    assert private["schema_version"] == 1
    assert private["delete_secret_hash"] == hashlib.sha256(SECRET_BYTES).hexdigest()
    assert private["deleted_at"] is None
    assert private["timestamp"] == body["timestamp"]
    assert private["created_at"].tzinfo == timezone.utc
    assert outbox == {
        "schema_version": 1,
        "category": category,
        "post_id": POST_ID,
        "created_at": private["created_at"],
        "status": "pending",
        "next_attempt_at": private["created_at"],
        "attempts": 0,
        "expires_at": private["created_at"] + timedelta(days=7),
    }
    assert "recipients" not in outbox
    assert DELETE_SECRET not in repr(database.data)
    assert REQUEST_ID not in repr(database.data)
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["access-control-allow-origin"] == ORIGIN
    forbidden.assert_not_called()
    main.db.assert_not_called()


@pytest.mark.parametrize(
    "invalid",
    [
        "not-a-uuid",
        "abcdefabcdef4abc8defabcdefabcdef",
        "abcdefab-cdef-1abc-8def-abcdefabcdef",
        "abcdefab-cdef-4abc-8def-abcdefabcdef ",
    ],
)
def test_uppercase_uuid_is_normalized_and_invalid_uuid_rejected(client, portal, invalid):
    assert post(client).json()["id"] == POST_ID
    bad = post(client, value=payload(request_id=invalid))
    assert bad.status_code == 422
    assert bad.json()["error"]["code"] == "INVALID_INPUT"


@pytest.mark.parametrize(
    "secret",
    ["A" * 42, "A" * 44, "+" + "A" * 42, "_" * 43],
)
def test_delete_secret_must_be_canonical_32_byte_base64url(client, portal, secret):
    response = post(client, value=payload(delete_secret=secret))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"


@pytest.mark.parametrize("name", ["", "   ", "x" * 31, "bad\nname", "bad\x7fname"])
def test_name_validation(client, portal, name):
    assert post(client, value=payload(name=name)).status_code == 422


@pytest.mark.parametrize("name", ["団", "団" * 30])
def test_name_length_boundaries_are_accepted(client, portal, name):
    response = post(client, value=payload(name=name))
    assert response.status_code == 201
    assert portal[0].data[paths()[0]]["name"] == name


@pytest.mark.parametrize("comment", ["x" * 3001, "bad\rcomment", "bad\x00comment"])
def test_comment_validation(client, portal, comment):
    assert post(client, value=payload(comment=comment)).status_code == 422


@pytest.mark.parametrize("comment", ["", "文" * 3000])
def test_comment_length_boundaries_are_accepted(client, portal, comment):
    response = post(client, value=payload(comment=comment))
    assert response.status_code == 201
    assert portal[0].data[paths()[0]]["comment"] == comment


def test_empty_comment_and_lf_tab_are_allowed(client, portal):
    response = post(client, value=payload(comment="\n\t"))
    assert response.status_code == 201
    assert portal[0].data[paths()[0]]["comment"] == ""


@pytest.mark.parametrize(
    "image",
    [
        "data:image/png;base64,AAAA",
        "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        "https://example.com/image.jpg",
        "data:image/jpeg;base64,***",
        "data:image/jpeg;base64,\"/9j/2Q==",
        "data:image/jpeg;base64," + base64.b64encode(b"not-jpeg").decode("ascii"),
        "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xffmissing-end").decode("ascii"),
    ],
)
def test_image_format_is_strict(client, portal, image):
    assert post(client, value=payload(images=[image])).status_code == 422


def test_image_count_and_size_limits(client, portal):
    too_many = post(client, value=payload(images=[JPEG] * 5))
    assert too_many.status_code == 422
    oversized = "data:image/jpeg;base64," + "A" * 199978
    too_large = post(client, value=payload(images=[oversized]))
    assert too_large.status_code == 413
    assert too_large.json()["error"]["code"] == "BODY_TOO_LARGE"


@pytest.mark.parametrize("images", [[], [JPEG] * 4])
def test_image_count_boundaries_are_accepted(client, portal, images):
    response = post(client, value=payload(images=images))
    assert response.status_code == 201
    assert portal[0].data[paths()[0]]["images"] == images


def test_body_content_type_json_and_json_syntax_guards(client, portal):
    large = client.post(
        "/api/formations/gw",
        content=b"{}",
        headers={**HEADERS, "Content-Type": "application/json", "Content-Length": "850001"},
    )
    assert large.status_code == 413
    text = client.post("/api/formations/gw", content="{}", headers={**HEADERS, "Content-Type": "text/plain"})
    assert text.status_code == 415
    broken = client.post(
        "/api/formations/gw", content=b"{", headers={**HEADERS, "Content-Type": "application/json"}
    )
    assert broken.status_code == 400
    assert broken.json()["error"]["code"] == "INVALID_JSON"
    for response in (large, text, broken):
        assert response.headers["access-control-allow-origin"] == ORIGIN


def test_actual_body_bytes_are_checked_even_with_small_content_length(client, portal):
    response = client.post(
        "/api/formations/gw",
        content=b"{" + b" " * 850000,
        headers={**HEADERS, "Content-Type": "application/json", "Content-Length": "2"},
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "BODY_TOO_LARGE"


def test_preflight_is_handled_without_json_body(client, portal):
    response = client.options(
        "/api/formations/gw",
        headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ORIGIN


def test_category_origin_extra_and_strict_types(client, portal):
    missing = post(client, "unknown")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "CATEGORY_NOT_FOUND"
    denied = post(client, headers={"Origin": "https://evil.example"})
    assert denied.status_code == 403
    assert post(client, headers={}).status_code == 403
    assert post(client, headers={"Origin": "null"}).status_code == 403
    extra = post(client, value=payload(extra="x"))
    assert extra.status_code == 422
    wrong = post(client, value=payload(name=123))
    assert wrong.status_code == 422


def test_local_origin_requires_explicit_gate(client, portal, monkeypatch):
    local_headers = {"Origin": "http://localhost:5500"}
    assert post(client, headers=local_headers).status_code == 403
    monkeypatch.setenv("PORTAL_ALLOW_LOCAL_ORIGINS", "true")
    assert post(client, headers=local_headers).status_code == 201


def test_write_gate_prevents_all_documents(client, portal, monkeypatch):
    database, _ = portal
    monkeypatch.setenv("PORTAL_WRITE_ENABLED", "false")
    response = post(client)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PORTAL_NOT_READY"
    assert database.data == {}


def test_identical_replay_returns_original_timestamp_without_writes(client, portal):
    database, _ = portal
    first = post(client)
    before = copy.deepcopy(formation_documents(database))
    second = post(client)
    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json() == {**first.json(), "replayed": True}
    assert formation_documents(database) == before


def test_concurrent_identical_create_makes_one_post(client, portal):
    database, _ = portal
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda _: post(client), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 201]
    assert len(formation_documents(database)) == 3


@pytest.mark.parametrize(
    "changes",
    [
        {"name": "別名"},
        {"comment": "別コメント"},
        {"images": []},
        {"delete_secret": base64.urlsafe_b64encode(b"z" * 32).rstrip(b"=").decode("ascii")},
    ],
)
def test_replay_conflict(client, portal, changes):
    assert post(client).status_code == 201
    response = post(client, value=payload(**changes))
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "REQUEST_ID_CONFLICT"


def test_deleted_replay_returns_410(client, portal):
    database, _ = portal
    assert post(client).status_code == 201
    database.data[paths()[1]]["deleted_at"] = datetime.now(timezone.utc)
    response = post(client)
    assert response.status_code == 410
    assert response.json()["error"]["code"] == "POST_DELETED"


@pytest.mark.parametrize("missing_index", [0, 1, 2])
def test_partial_state_returns_503_without_repair(client, portal, missing_index):
    database, _ = portal
    assert post(client).status_code == 201
    del database.data[paths()[missing_index]]
    before = copy.deepcopy(formation_documents(database))
    response = post(client)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "STORE_INCONSISTENT"
    assert formation_documents(database) == before


@pytest.mark.parametrize("write_number", [1, 2, 3])
def test_three_document_create_is_atomic(client, portal, write_number):
    database, _ = portal
    database.fail_create_write_number = write_number
    response = post(client)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "STORE_UNAVAILABLE"
    assert all(path not in database.data for path in paths())


def test_store_failure_does_not_leak_exception(client, portal, capsys):
    database, _ = portal
    database.fail_reads = True
    response = post(client)
    captured = capsys.readouterr()
    combined = response.text + captured.out + captured.err
    assert response.status_code == 503
    assert "secret-database-error" not in combined


def test_subject_quota_is_shared_across_categories(client, portal):
    for index, category in enumerate(("gw", "multi", "high")):
        request_id = str(uuid.UUID(int=index + 1, version=4))
        assert post(client, category, payload(request_id=request_id)).status_code == 201
    limited = post(client, "gw", payload(request_id=str(uuid.UUID(int=10, version=4))))
    assert limited.status_code == 429
    assert limited.headers["retry-after"]


def test_successful_replays_consume_subject_quota(client, portal):
    assert [post(client).status_code for _ in range(3)] == [201, 200, 200]
    assert post(client).status_code == 429


def test_global_quota(client, portal):
    for index in range(30):
        secret = base64.urlsafe_b64encode(index.to_bytes(32, "big")).rstrip(b"=").decode("ascii")
        request_id = str(uuid.UUID(int=index + 1, version=4))
        assert post(client, value=payload(request_id=request_id, delete_secret=secret)).status_code == 201
    secret = base64.urlsafe_b64encode((31).to_bytes(32, "big")).rstrip(b"=").decode("ascii")
    response = post(client, value=payload(request_id=str(uuid.UUID(int=31, version=4)), delete_secret=secret))
    assert response.status_code == 429


def test_payload_hash_is_canonical_and_includes_category():
    first = main.build_formation_payload_hash("gw", "名前", "本文", [JPEG])
    assert first == main.build_formation_payload_hash("gw", "名前", "本文", [JPEG])
    assert first != main.build_formation_payload_hash("multi", "名前", "本文", [JPEG])


def test_outbox_can_be_claimed_and_initialized_by_b2(client, portal):
    database, _ = portal
    assert post(client).status_code == 201
    outbox_path = paths()[2]
    now = database.data[outbox_path]["next_attempt_at"]
    claim = main.claim_push_event(now)
    assert claim is not None
    reference, lease_id = claim
    initialized = main.initialize_push_recipients(reference, lease_id, now)
    assert initialized["recipients"] == []
    assert database.data[outbox_path]["status"] == "processing"
