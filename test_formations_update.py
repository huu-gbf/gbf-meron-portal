import base64
import copy
import hashlib
import json
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


class FakeBlob:
    def __init__(self, bucket, path):
        self.bucket = bucket
        self.path = path
        self.metadata = {}

    def upload_from_string(self, data, content_type, if_generation_match):
        self.bucket.upload_calls += 1
        if self.bucket.upload_calls == self.bucket.fail_upload_number and not self.bucket.fail_after_upload:
            raise RuntimeError("simulated-upload-failure")
        assert content_type == "image/jpeg"
        assert if_generation_match == 0
        assert self.path not in self.bucket.objects
        self.bucket.objects[self.path] = {"data": data, "metadata": self.metadata}
        if self.bucket.upload_calls == self.bucket.fail_upload_number and self.bucket.fail_after_upload:
            raise RuntimeError("simulated-timeout-after-upload")

    def delete(self):
        self.bucket.deleted.append(self.path)
        if self.bucket.fail_delete:
            raise RuntimeError("simulated-delete-failure")
        self.bucket.objects.pop(self.path, None)


class FakeBucket:
    def __init__(self):
        self.objects = {}
        self.deleted = []
        self.upload_calls = 0
        self.fail_upload_number = None
        self.fail_after_upload = False
        self.fail_delete = False

    def blob(self, path):
        return FakeBlob(self, path)


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
        self.database.committed_operations.extend(self.operations)


class FakeFirestore:
    def __init__(self):
        self.data = {}
        self.committed_operations = []
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
    database.bucket = FakeBucket()
    monkeypatch.setattr(main, "formation_storage_bucket", lambda: database.bucket)
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


def paths(category="gw", post_id=POST_ID):
    event_id = f"{category}_{post_id}"
    return (
        (main.PUSH_FORMATIONS[category], post_id),
        ("formation_private", event_id),
        (main.PUSH_OUTBOX_COLLECTION, event_id),
    )


def formation_documents(database, category="gw", post_id=POST_ID):
    expected = set(paths(category, post_id)[:2])
    return {path: copy.deepcopy(data) for path, data in database.data.items() if path in expected}


def formation_write_count(database):
    collections = set(main.PUSH_FORMATIONS.values()) | {"formation_private"}
    return sum(operation[1].path[0] in collections for operation in database.committed_operations)


def payload(**changes):
    value = {
        "request_id": REQUEST_ID,
        "comment": "updated comment",
        "tags": ["火", "マグナ"],
        "imageCaptions": ["caption1"],
    }
    value.update(changes)
    return value


def patch_api(client, category="gw", post_id=POST_ID, value=None, secret=DELETE_SECRET):
    headers = dict(HEADERS)
    if secret is not None:
        headers["X-Delete-Secret"] = secret
    return client.patch(
        f"/api/formations/{category}/{post_id}",
        json=payload() if value is None else value,
        headers=headers,
    )


def setup_db(database, category="gw", post_id=POST_ID, public_data=None, private_data=None):
    public_path, private_path, _ = paths(category, post_id)
    if public_data is not None:
        database.data[public_path] = public_data
    if private_data is not None:
        database.data[private_path] = private_data

def get_base_public_data():
    return {
        "schema_version": 2,
        "id": POST_ID,
        "name": "tester",
        "comment": "old comment",
        "timestamp": "2026-09-21T00:00:00Z",
        "images": [JPEG],
        "imageStoragePaths": ["path"],
        "tags": ["水"],
        "addenda": [{"id": "a1", "text": "addendum"}],
    }


def get_base_private_data():
    return {
        "schema_version": 1,
        "delete_secret_hash": hashlib.sha256(SECRET_BYTES).hexdigest(),
        "timestamp": "2026-09-21T00:00:00Z",
        "created_at": datetime.now(timezone.utc),
        "deleted_at": None,
    }


@pytest.mark.parametrize(
    ("changes", "field", "expected"),
    [
        ({"comment": "new comment", "tags": ["水"], "imageCaptions": []}, "comment", "new comment"),
        ({"comment": "old comment", "tags": ["火", "マグナ"], "imageCaptions": []}, "tags", ["火", "マグナ"]),
        ({"comment": "old comment", "tags": ["水"], "imageCaptions": ["caption1"]}, "imageCaptions", ["caption1"]),
    ],
)
def test_each_editable_field_updates_and_preserves_immutable_fields(client, portal, changes, field, expected):
    database, _ = portal
    original = get_base_public_data()
    setup_db(database, public_data=original, private_data=get_base_private_data())

    response = patch_api(client, value=payload(**changes))
    assert response.status_code == 200, response.json()

    public_path, private_path, _ = paths()
    public = database.data[public_path]
    private = database.data[private_path]
    assert response.json()["replayed"] is False
    assert public[field] == expected
    assert public["updatedAt"] == response.json()["updated_at"]
    for immutable in ("timestamp", "name", "images", "imageStoragePaths", "addenda", "schema_version"):
        assert public[immutable] == original[immutable]
    assert private["last_edit_request_id"] == REQUEST_ID.lower()
    assert private["last_edit_payload_hash"] == main.build_formation_update_payload_hash(
        public["comment"], public["tags"], public.get("imageCaptions", []),
    )


@pytest.mark.parametrize("captions", [[], ["", ""], ["   ", "\t"]])
def test_canonical_noop_performs_no_public_or_private_write(client, portal, captions):
    database, _ = portal
    public = get_base_public_data()
    public.update({
        "comment": "same comment",
        "tags": ["火"],
        "imageCaptions": [],
        "updatedAt": "2026-09-21T10:00:00Z"
    })
    private = get_base_private_data()
    setup_db(database, public_data=public, private_data=private)
    before = formation_documents(database)

    response = patch_api(client, value=payload(comment="same comment  ", tags=["火"], imageCaptions=captions))
    assert response.status_code == 200, response.json()
    assert response.json() == {
        "id": POST_ID, "category": "gw", "replayed": False,
        "updated_at": "2026-09-21T10:00:00Z",
    }
    assert formation_documents(database) == before
    assert formation_write_count(database) == 0


def test_correct_header_secret_succeeds_and_body_secret_is_not_accepted(client, portal):
    database, _ = portal
    setup_db(database, public_data=get_base_public_data(), private_data=get_base_private_data())
    assert patch_api(client).status_code == 200

    database.data.clear()
    setup_db(database, public_data=get_base_public_data(), private_data=get_base_private_data())
    body_secret = payload(delete_secret=DELETE_SECRET)
    assert patch_api(client, value=body_secret, secret=None).status_code == 422


def test_secret_and_private_document_failures(client, portal):
    database, _ = portal
    setup_db(database, public_data=get_base_public_data(), private_data=get_base_private_data())
    wrong_secret = base64.urlsafe_b64encode(b"a" * 32).rstrip(b"=").decode("ascii")

    assert patch_api(client, secret=None).status_code == 401
    assert patch_api(client, secret="invalid").status_code == 401
    assert patch_api(client, secret=wrong_secret).status_code == 403

    database.data.pop(paths()[1])
    assert patch_api(client).status_code == 403

    private = get_base_private_data()
    private["deleted_at"] = datetime.now(timezone.utc)
    setup_db(database, private_data=private)
    assert patch_api(client).status_code == 410


@pytest.mark.parametrize(
    ("category", "post_id", "changes"),
    [
        ("invalid", POST_ID, {}),
        ("gw", "invalid!id", {}),
        ("gw", POST_ID, {"comment": "a" * 3001}),
        ("gw", POST_ID, {"comment": "bad\x00comment"}),
        ("gw", POST_ID, {"tags": ["invalid"]}),
        ("gw", POST_ID, {"tags": ["火", "水"]}),
        ("gw", POST_ID, {"tags": ["神石", "マグナ"]}),
        ("multi", POST_ID, {"tags": ["90HELL"]}),
        ("gw", POST_ID, {"imageCaptions": ["a" * 21]}),
        ("gw", POST_ID, {"imageCaptions": [str(i) for i in range(11)]}),
    ],
)
def test_validation_failures(client, portal, category, post_id, changes):
    database, _ = portal
    setup_db(database, category=category if category in main.PUSH_FORMATIONS else "gw",
             post_id=post_id, public_data=get_base_public_data(), private_data=get_base_private_data())
    assert patch_api(client, category=category, post_id=post_id, value=payload(**changes)).status_code in {404, 422}


def test_caption_count_cannot_exceed_existing_images(client, portal):
    database, _ = portal
    public = get_base_public_data()
    public["images"] = []
    setup_db(database, public_data=public, private_data=get_base_private_data())
    assert patch_api(client, value=payload(imageCaptions=["cap"])).status_code == 422


def test_post_without_updated_at_can_be_edited(client, portal):
    database, _ = portal
    public = get_base_public_data()
    assert "updatedAt" not in public
    setup_db(database, public_data=public, private_data=get_base_private_data())
    response = patch_api(client)
    assert response.status_code == 200
    assert database.data[paths()[0]]["updatedAt"] == response.json()["updated_at"]


def test_addenda_does_not_change_updated_at(client, portal):
    database, _ = portal
    public = get_base_public_data()
    public["updatedAt"] = "2026-09-21T10:00:00Z"
    setup_db(database, public_data=public, private_data=get_base_private_data())

    response = client.post(
        f"/api/formations/gw/{POST_ID}/addenda",
        json={"request_id": REQUEST_ID, "text": "addendum 2"},
        headers={**HEADERS, "X-Delete-Secret": DELETE_SECRET}
    )
    assert response.status_code == 201, response.json()
    public_path, _, _ = paths()
    assert database.data[public_path]["updatedAt"] == "2026-09-21T10:00:00Z"


def test_same_request_id_and_same_canonical_payload_replays_without_writes(client, portal):
    database, _ = portal
    setup_db(database, public_data=get_base_public_data(), private_data=get_base_private_data())
    first = patch_api(client)
    assert first.status_code == 200
    write_count = formation_write_count(database)

    response = patch_api(client, value=payload(comment=" updated comment ", tags=["マグナ", "火"]))
    assert response.status_code == 200, response.json()
    assert response.json()["replayed"] is True
    assert response.json()["updated_at"] == first.json()["updated_at"]
    assert formation_write_count(database) == write_count


def test_same_request_id_and_different_canonical_payload_conflicts(client, portal):
    database, _ = portal
    setup_db(database, public_data=get_base_public_data(), private_data=get_base_private_data())
    assert patch_api(client).status_code == 200
    before = formation_documents(database)
    write_count = formation_write_count(database)

    response = patch_api(client, value=payload(comment="diff"))
    assert response.status_code == 409, response.json()
    assert response.json()["error"]["code"] == "REQUEST_ID_CONFLICT"
    assert formation_documents(database) == before
    assert formation_write_count(database) == write_count
