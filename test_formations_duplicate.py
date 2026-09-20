"""Local-only tests for independent formation duplication."""
import base64
import copy
import hashlib
from urllib.parse import parse_qs, quote, urlparse

import pytest

from test_formations_create import (
    DELETE_SECRET, HEADERS, JPEG, POST_ID, REQUEST_ID, client, portal,
)
from test_formations_delete import FakeTransaction as DeleteTransaction
import backend.main as main


SOURCE_ID = "source_post"
SOURCE_SECRET = base64.urlsafe_b64encode(b"s" * 32).rstrip(b"=").decode()
JPEG_BYTES = b"\xff\xd8\xffbody\xff\xd9"
PNG_BYTES = b"\x89PNG\r\n\x1a\nbody"
GIF_BYTES = b"GIF89abody"
WEBP_BYTES = b"RIFF\x08\x00\x00\x00WEBPbody"


class DuplicateBlob:
    def __init__(self, bucket, path):
        self.bucket, self.path = bucket, path
        self.metadata = {}
        self.generation = bucket.objects.get(path, {}).get("generation")

    def upload_from_string(self, data, content_type, if_generation_match):
        self.bucket.upload_calls += 1
        if self.bucket.fail_upload_number == self.bucket.upload_calls:
            raise RuntimeError("upload failed")
        assert if_generation_match == 0
        assert self.path not in self.bucket.objects
        self.bucket.objects[self.path] = {
            "data": data, "metadata": copy.deepcopy(self.metadata),
            "content_type": content_type, "generation": self.bucket.next_generation(),
        }
        self.generation = self.bucket.objects[self.path]["generation"]

    def patch(self, if_generation_match):
        self.bucket.patch_calls += 1
        if self.bucket.fail_patch_number == self.bucket.patch_calls:
            raise RuntimeError("patch failed")
        assert if_generation_match == self.bucket.objects[self.path]["generation"]
        self.bucket.objects[self.path]["metadata"] = copy.deepcopy(self.metadata)

    def delete(self):
        self.bucket.deleted.append(self.path)
        self.bucket.objects.pop(self.path, None)


class DuplicateBucket:
    def __init__(self):
        self.objects = {}
        self.deleted = []
        self.copy_calls = 0
        self.upload_calls = 0
        self.patch_calls = 0
        self.fail_copy_number = None
        self.fail_upload_number = None
        self.fail_patch_number = None
        self._generation = 1

    def next_generation(self):
        self._generation += 1
        return self._generation

    def blob(self, path):
        return DuplicateBlob(self, path)

    def get_blob(self, path):
        return self.blob(path) if path in self.objects else None

    def copy_blob(self, source, destination_bucket, new_name, **conditions):
        self.copy_calls += 1
        if self.fail_copy_number == self.copy_calls:
            raise RuntimeError("copy failed")
        assert destination_bucket is self
        assert source.path in self.objects
        assert conditions["if_generation_match"] == 0
        assert conditions["source_generation"] == source.generation
        assert conditions["if_source_generation_match"] == source.generation
        assert new_name not in self.objects
        record = copy.deepcopy(self.objects[source.path])
        record["generation"] = self.next_generation()
        self.objects[new_name] = record
        return self.blob(new_name)


@pytest.fixture
def duplicate_store(portal):
    database, _ = portal
    database.bucket = DuplicateBucket()
    return database


def source_path(index, source_id=SOURCE_ID):
    return f"formations/{source_id}/{index + 1:02d}-{index + 1:032x}.jpg"


def source_url(path, token="source-token"):
    return (
        f"https://firebasestorage.googleapis.com/v0/b/{main.FORMATION_STORAGE_BUCKET}"
        f"/o/{quote(path, safe='')}?alt=media&token={token}"
    )


def seed_source(database, category="gw", count=1, images=None, source_id=SOURCE_ID):
    if images is None:
        paths = [source_path(i, source_id) for i in range(count)]
        images = [source_url(path) for path in paths]
    else:
        paths = [source_path(i, source_id) if not image.startswith("data:") else None
                 for i, image in enumerate(images)]
    public = {
        "schema_version": 2, "id": source_id, "name": "元の投稿者",
        "comment": "元コメント", "tags": ["火"], "timestamp": "2020-01-01T00:00:00Z",
        "images": images, "imageStoragePaths": paths,
        "imageCaptions": ["元説明"] * len(images),
        "addenda": [{"id": "old-addendum", "text": "元追記"}],
    }
    database.data[(main.PUSH_FORMATIONS[category], source_id)] = copy.deepcopy(public)
    database.data[("formation_private", f"{category}_{source_id}")] = {
        "schema_version": 1, "delete_secret_hash": hashlib.sha256(b"s" * 32).hexdigest(),
        "payload_hash": "source-hash", "timestamp": public["timestamp"], "deleted_at": None,
    }
    for path in paths:
        if path:
            database.bucket.objects[path] = {
                "data": JPEG_BYTES, "metadata": {"firebaseStorageDownloadTokens": "source-token"},
                "content_type": "image/jpeg", "generation": database.bucket.next_generation(),
            }
    return public


def payload(items=None, **changes):
    value = {
        "request_id": REQUEST_ID, "delete_secret": DELETE_SECRET,
        "name": "新しい投稿者", "comment": "編集したコメント",
        "tags": ["半フルオート"], "imageItems": items if items is not None else [{"kind": "source", "index": 0}],
        "imageCaptions": ["編集した説明"] if items is None else [],
    }
    value.update(changes)
    return value


def post(client, value=None, category="gw", source_id=SOURCE_ID, headers=None):
    return client.post(
        f"/api/formations/{category}/{source_id}/duplicate",
        json=payload() if value is None else value,
        headers=HEADERS if headers is None else headers,
    )


def public_doc(database, category="gw"):
    return database.data[(main.PUSH_FORMATIONS[category], POST_ID)]


def destination_paths(database):
    return [path for path in database.bucket.objects if path.startswith(f"formations/{POST_ID}/")]


@pytest.mark.parametrize("category", ["gw", "multi", "high"])
def test_duplicate_across_categories_and_new_identity(client, duplicate_store, category):
    source = seed_source(duplicate_store, category)
    private = copy.deepcopy(duplicate_store.data[("formation_private", f"{category}_{SOURCE_ID}")])
    result = post(client, category=category)
    assert result.status_code == 201
    body = result.json()
    assert body["id"] == POST_ID and body["category"] == category and body["replayed"] is False
    assert body["timestamp"] != source["timestamp"]
    new = public_doc(duplicate_store, category)
    assert new["name"] == "新しい投稿者" and new["comment"] == "編集したコメント"
    assert new["tags"] == ["半フルオート"] and new["imageCaptions"] == ["編集した説明"]
    assert new["imageStoragePaths"][0] != source["imageStoragePaths"][0]
    assert new["images"][0] != source["images"][0]
    assert "addenda" not in new and "delete_secret" not in new and "favorite" not in new
    assert duplicate_store.data[(main.PUSH_FORMATIONS[category], SOURCE_ID)] == source
    assert duplicate_store.data[("formation_private", f"{category}_{SOURCE_ID}")] == private
    dest_private = duplicate_store.data[("formation_private", f"{category}_{POST_ID}")]
    assert dest_private["delete_secret_hash"] == hashlib.sha256(bytes(range(32))).hexdigest()
    assert DELETE_SECRET not in str(new) + str(dest_private) + str(body)


def test_source_secret_not_required_and_new_token(client, duplicate_store):
    seed_source(duplicate_store)
    result = post(client)
    assert result.status_code == 201
    dest = public_doc(duplicate_store)
    new_path = dest["imageStoragePaths"][0]
    assert new_path in duplicate_store.bucket.objects
    assert duplicate_store.bucket.objects[new_path]["metadata"]["firebaseStorageDownloadTokens"] != "source-token"
    assert duplicate_store.bucket.objects[source_path(0)]["metadata"]["firebaseStorageDownloadTokens"] == "source-token"
    new_token = duplicate_store.bucket.objects[new_path]["metadata"]["firebaseStorageDownloadTokens"]
    assert parse_qs(urlparse(dest["images"][0]).query)["token"] == [new_token]
    assert duplicate_store.bucket.copy_calls == 1
    assert duplicate_store.bucket.patch_calls == 1


def test_source_private_document_is_not_required(client, duplicate_store):
    seed_source(duplicate_store)
    duplicate_store.data.pop(("formation_private", f"gw_{SOURCE_ID}"))
    assert post(client).status_code == 201


@pytest.mark.parametrize("count", [0, 1, 10])
def test_source_image_counts(client, duplicate_store, count):
    seed_source(duplicate_store, count=count)
    items = [{"kind": "source", "index": i} for i in range(count)]
    result = post(client, payload(items))
    assert result.status_code == 201
    assert len(public_doc(duplicate_store)["images"]) == count
    assert len(destination_paths(duplicate_store)) == count


def test_zero_selected_images_does_not_copy_source_images(client, duplicate_store):
    seed_source(duplicate_store, count=3)
    assert post(client, payload([])).status_code == 201
    assert public_doc(duplicate_store)["images"] == []
    assert public_doc(duplicate_store)["imageStoragePaths"] == []
    assert duplicate_store.bucket.copy_calls == 0


def test_eleven_images_rejected(client, duplicate_store):
    seed_source(duplicate_store, count=10)
    items = [{"kind": "source", "index": i % 10} for i in range(11)]
    assert post(client, payload(items)).status_code == 422
    assert not destination_paths(duplicate_store)


@pytest.mark.parametrize("count, expected", [(10, 201), (11, 422)])
def test_mixed_image_limit_applies_to_total(client, duplicate_store, count, expected):
    seed_source(duplicate_store, count=1)
    items = [{"kind": "source", "index": 0}] + [{"kind": "upload", "data": JPEG}] * (count - 1)
    assert post(client, payload(items)).status_code == expected
    assert len(destination_paths(duplicate_store)) == (count if expected == 201 else 0)


def test_order_subset_and_captions(client, duplicate_store):
    seed_source(duplicate_store, count=3)
    for i in range(3):
        duplicate_store.bucket.objects[source_path(i)]["data"] = b"\xff\xd8\xff" + bytes([i]) + b"\xff\xd9"
    items = [{"kind": "source", "index": 2}, {"kind": "source", "index": 0}]
    result = post(client, payload(items, imageCaptions=["三枚目", "一枚目"]))
    assert result.status_code == 201
    dest = public_doc(duplicate_store)
    assert dest["imageCaptions"] == ["三枚目", "一枚目"]
    assert [duplicate_store.bucket.objects[p]["data"] for p in dest["imageStoragePaths"]] == [
        b"\xff\xd8\xff\x02\xff\xd9", b"\xff\xd8\xff\x00\xff\xd9",
    ]
    assert len(dest["images"]) == 2
    assert len(set(dest["imageStoragePaths"])) == 2


@pytest.mark.parametrize("items", [
    [{"kind": "source", "index": 0}, {"kind": "upload", "data": JPEG}],
    [{"kind": "upload", "data": JPEG}],
])
def test_upload_and_source_mix(client, duplicate_store, items):
    seed_source(duplicate_store)
    assert post(client, payload(items)).status_code == 201
    dest = public_doc(duplicate_store)
    assert len(dest["images"]) == len(items)
    assert duplicate_store.bucket.upload_calls == 1
    assert duplicate_store.bucket.copy_calls == (1 if len(items) == 2 else 0)


@pytest.mark.parametrize(("mime", "data"), [
    ("jpeg", JPEG_BYTES), ("png", PNG_BYTES), ("gif", GIF_BYTES), ("webp", WEBP_BYTES),
])
def test_legacy_image_bytes_preserved(client, duplicate_store, mime, data):
    image = f"data:image/{mime};base64," + base64.b64encode(data).decode()
    seed_source(duplicate_store, images=[image])
    assert post(client).status_code == 201
    path = public_doc(duplicate_store)["imageStoragePaths"][0]
    assert path.endswith(".jpg")  # current frontend URL and delete validators
    assert duplicate_store.bucket.objects[path]["data"] == data
    assert duplicate_store.bucket.objects[path]["content_type"] == f"image/{mime}"
    assert duplicate_store.bucket.copy_calls == 0


@pytest.mark.parametrize("image", [
    "data:image/png;base64," + base64.b64encode(JPEG_BYTES).decode(),
    "data:image/jpeg;base64,%%%%",
    "data:image/svg+xml;base64," + base64.b64encode(b"<svg/>").decode(),
])
def test_invalid_legacy_image_rejected(client, duplicate_store, image):
    seed_source(duplicate_store, images=[image])
    assert post(client).status_code == 422
    assert not destination_paths(duplicate_store)


@pytest.mark.parametrize("mime, data", [
    ("png", b"not-png"), ("gif", b"GIF00anot-gif"),
    ("webp", b"RIFF\x08\x00\x00\x00NOPEbody"),
    ("png", b""), ("png", b"\x89PNG\r\n\x1a\n" + b"x" * 1_125_000),
], ids=["png-signature", "gif-signature", "webp-signature", "empty", "oversized"])
def test_malformed_or_oversized_legacy_formats_rejected(client, duplicate_store, mime, data):
    image = f"data:image/{mime};base64," + base64.b64encode(data).decode()
    seed_source(duplicate_store, images=[image])
    assert post(client).status_code == 422
    assert not destination_paths(duplicate_store)


@pytest.mark.parametrize("item", [
    {"kind": "source", "index": -1}, {"kind": "source", "index": 9},
    {"kind": "source", "index": 0, "data": JPEG},
    {"kind": "upload", "index": 0, "data": JPEG},
    {"kind": "upload", "data": "https://example.com/x.jpg"},
])
def test_invalid_item_rejected(client, duplicate_store, item):
    seed_source(duplicate_store)
    assert post(client, payload([item])).status_code == 422
    assert not destination_paths(duplicate_store)


@pytest.mark.parametrize("item", [
    {"kind": "unknown", "index": 0},
    {"kind": "upload", "data": JPEG, "token": "injected"},
    {"kind": "upload", "data": JPEG, "bucket": "other"},
])
def test_unknown_kind_and_dangerous_item_fields_rejected(client, duplicate_store, item):
    seed_source(duplicate_store)
    assert post(client, payload([item])).status_code == 422
    assert not destination_paths(duplicate_store)


@pytest.mark.parametrize("mutation", ["missing_path", "other_post", "url_mismatch", "missing_object"])
def test_source_storage_inconsistency_rejected(client, duplicate_store, mutation):
    seed_source(duplicate_store)
    source = duplicate_store.data[(main.PUSH_FORMATIONS["gw"], SOURCE_ID)]
    if mutation == "missing_path":
        source["imageStoragePaths"] = []
    elif mutation == "other_post":
        source["imageStoragePaths"][0] = source_path(0, "other_post")
    elif mutation == "url_mismatch":
        source["images"][0] = source_url(source_path(0, "other_post"))
    else:
        duplicate_store.bucket.objects.pop(source_path(0))
    result = post(client)
    assert result.status_code == 503
    assert result.json()["error"]["code"] == "SOURCE_IMAGE_UNAVAILABLE"
    assert not destination_paths(duplicate_store)


def test_short_source_path_list_rolls_back_earlier_copy(client, duplicate_store):
    seed_source(duplicate_store, count=2)
    duplicate_store.data[(main.PUSH_FORMATIONS["gw"], SOURCE_ID)]["imageStoragePaths"].pop()
    items = [{"kind": "source", "index": 0}, {"kind": "source", "index": 1}]
    result = post(client, payload(items))
    assert result.status_code == 503
    assert result.json()["error"]["code"] == "SOURCE_IMAGE_UNAVAILABLE"
    assert not destination_paths(duplicate_store)
    assert all(source_path(i) in duplicate_store.bucket.objects for i in range(2))


def test_caption_rules_and_edited_tags(client, duplicate_store):
    seed_source(duplicate_store, count=2)
    items = [{"kind": "source", "index": 0}, {"kind": "source", "index": 1}]
    assert post(client, payload(items, imageCaptions=["", "説明"], tags=["火", "半フルオート"])).status_code == 201
    assert public_doc(duplicate_store)["imageCaptions"] == ["", "説明"]
    assert "半フルオート" in public_doc(duplicate_store)["tags"]


@pytest.mark.parametrize("captions", [["only"], ["x" * 21]])
def test_bad_captions_rejected(client, duplicate_store, captions):
    seed_source(duplicate_store, count=2)
    items = [{"kind": "source", "index": 0}, {"kind": "source", "index": 1}]
    assert post(client, payload(items, imageCaptions=captions)).status_code == 422


def test_all_empty_captions_canonicalized(client, duplicate_store):
    seed_source(duplicate_store, count=2)
    items = [{"kind": "source", "index": 0}, {"kind": "source", "index": 1}]
    assert post(client, payload(items, imageCaptions=["", ""])).status_code == 201
    assert "imageCaptions" not in public_doc(duplicate_store)


def test_replay_precedes_source_read_even_after_source_deletion(client, duplicate_store):
    seed_source(duplicate_store)
    first = post(client)
    assert first.status_code == 201
    before_paths = destination_paths(duplicate_store)
    destination = public_doc(duplicate_store)
    before_url = destination["images"][0]
    before_token = duplicate_store.bucket.objects[before_paths[0]]["metadata"]["firebaseStorageDownloadTokens"]
    duplicate_store.data.pop((main.PUSH_FORMATIONS["gw"], SOURCE_ID))
    duplicate_store.bucket.objects.pop(source_path(0))
    second = post(client)
    assert second.status_code == 200 and second.json()["replayed"] is True
    assert second.json()["timestamp"] == first.json()["timestamp"]
    assert destination_paths(duplicate_store) == before_paths
    assert public_doc(duplicate_store)["images"][0] == before_url
    assert duplicate_store.bucket.objects[before_paths[0]]["metadata"]["firebaseStorageDownloadTokens"] == before_token
    assert duplicate_store.bucket.copy_calls == 1


@pytest.mark.parametrize("change", [
    {"comment": "別本文"}, {"imageCaptions": ["別説明"]},
    {"imageItems": [{"kind": "upload", "data": JPEG}]},
    {"tags": ["手動"]},
    {"imageItems": [{"kind": "source", "index": 0}, {"kind": "source", "index": 0}],
     "imageCaptions": ["編集した説明", ""]},
])
def test_same_request_id_changed_payload_conflicts(client, duplicate_store, change):
    seed_source(duplicate_store)
    assert post(client).status_code == 201
    assert post(client, payload(**change)).status_code == 409
    assert duplicate_store.bucket.copy_calls == 1


def test_same_request_id_changed_image_order_conflicts(client, duplicate_store):
    seed_source(duplicate_store, count=2)
    first = [{"kind": "source", "index": 0}, {"kind": "source", "index": 1}]
    second = list(reversed(first))
    assert post(client, payload(first)).status_code == 201
    assert post(client, payload(second)).status_code == 409


def test_same_request_id_changed_upload_bytes_conflicts(client, duplicate_store):
    seed_source(duplicate_store, count=0)
    first = [{"kind": "upload", "data": JPEG}]
    other = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xffother\xff\xd9").decode()
    second = [{"kind": "upload", "data": other}]
    assert post(client, payload(first)).status_code == 201
    assert post(client, payload(second)).status_code == 409


def test_missing_source_and_category(client, duplicate_store):
    assert post(client).status_code == 404
    assert post(client).json()["error"]["code"] == "SOURCE_POST_NOT_FOUND"
    assert post(client, category="unknown").json()["error"]["code"] == "CATEGORY_NOT_FOUND"


@pytest.mark.parametrize("failure_number", [2, 3])
def test_partial_copy_failure_rolls_back_destinations_only(client, duplicate_store, failure_number):
    seed_source(duplicate_store, count=3)
    duplicate_store.bucket.fail_copy_number = failure_number
    items = [{"kind": "source", "index": i} for i in range(3)]
    result = post(client, payload(items))
    assert result.status_code == 503
    assert not destination_paths(duplicate_store)
    assert all(source_path(i) in duplicate_store.bucket.objects for i in range(3))
    assert (main.PUSH_FORMATIONS["gw"], POST_ID) not in duplicate_store.data


def test_patch_failure_rolls_back_copy(client, duplicate_store):
    seed_source(duplicate_store)
    duplicate_store.bucket.fail_patch_number = 1
    assert post(client).status_code == 503
    assert not destination_paths(duplicate_store)
    assert source_path(0) in duplicate_store.bucket.objects


def test_upload_failure_rolls_back_prior_copy(client, duplicate_store):
    seed_source(duplicate_store)
    duplicate_store.bucket.fail_upload_number = 1
    items = [{"kind": "source", "index": 0}, {"kind": "upload", "data": JPEG}]
    assert post(client, payload(items)).status_code == 503
    assert not destination_paths(duplicate_store)
    assert source_path(0) in duplicate_store.bucket.objects


def test_firestore_failure_rolls_back_destinations(client, duplicate_store):
    seed_source(duplicate_store)
    duplicate_store.fail_create_write_number = 2
    assert post(client).status_code == 503
    assert not destination_paths(duplicate_store)
    assert source_path(0) in duplicate_store.bucket.objects


def test_storage_independence_after_either_deletion(client, duplicate_store):
    seed_source(duplicate_store)
    assert post(client).status_code == 201
    destination = destination_paths(duplicate_store)[0]
    main.cleanup_formation_images([source_path(0)])
    assert destination in duplicate_store.bucket.objects
    # A fresh clone shows the opposite deletion direction.
    duplicate_store.data.clear()
    duplicate_store.bucket.objects.clear()
    seed_source(duplicate_store)
    assert post(client).status_code == 201
    main.cleanup_formation_images(destination_paths(duplicate_store))
    assert source_path(0) in duplicate_store.bucket.objects


def test_delete_apis_keep_other_posts_images(client, duplicate_store, monkeypatch):
    seed_source(duplicate_store)
    assert post(client).status_code == 201
    new_path = destination_paths(duplicate_store)[0]
    duplicate_store.fail_delete_write_number = None
    monkeypatch.setattr(duplicate_store, "transaction", lambda: DeleteTransaction(duplicate_store))
    source_delete = client.delete(
        f"/api/formations/gw/{SOURCE_ID}",
        headers={**HEADERS, "X-Delete-Secret": SOURCE_SECRET},
    )
    assert source_delete.status_code == 204
    assert source_path(0) not in duplicate_store.bucket.objects
    assert new_path in duplicate_store.bucket.objects
    duplicate_delete = client.delete(
        f"/api/formations/gw/{POST_ID}",
        headers={**HEADERS, "X-Delete-Secret": DELETE_SECRET},
    )
    assert duplicate_delete.status_code == 204
    assert new_path not in duplicate_store.bucket.objects


def test_delete_duplicate_first_keeps_source_image(client, duplicate_store, monkeypatch):
    seed_source(duplicate_store)
    assert post(client).status_code == 201
    duplicate_store.fail_delete_write_number = None
    monkeypatch.setattr(duplicate_store, "transaction", lambda: DeleteTransaction(duplicate_store))
    result = client.delete(
        f"/api/formations/gw/{POST_ID}",
        headers={**HEADERS, "X-Delete-Secret": DELETE_SECRET},
    )
    assert result.status_code == 204
    assert source_path(0) in duplicate_store.bucket.objects
    assert (main.PUSH_FORMATIONS["gw"], SOURCE_ID) in duplicate_store.data


def test_uncertain_firestore_commit_preserves_referenced_image(client, duplicate_store, monkeypatch):
    seed_source(duplicate_store)
    original = main.create_formation_transaction

    def commit_then_timeout(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("response lost after commit")

    monkeypatch.setattr(main, "create_formation_transaction", commit_then_timeout)
    assert post(client).status_code == 500
    new_path = destination_paths(duplicate_store)[0]
    assert new_path in duplicate_store.bucket.objects
    monkeypatch.setattr(main, "create_formation_transaction", original)
    replay = post(client)
    assert replay.status_code == 200 and replay.json()["replayed"] is True
    assert new_path in duplicate_store.bucket.objects


def test_private_source_and_public_source_are_unchanged(client, duplicate_store):
    seed_source(duplicate_store)
    before = copy.deepcopy(duplicate_store.data)
    assert post(client).status_code == 201
    for path, value in before.items():
        assert duplicate_store.data[path] == value


@pytest.mark.parametrize("field", ["imageStoragePaths", "images", "favorite", "addenda", "sourcePath"])
def test_extra_client_fields_rejected(client, duplicate_store, field):
    seed_source(duplicate_store)
    assert post(client, payload(**{field: ["malicious"]})).status_code == 422


@pytest.mark.parametrize("item", [
    {"kind": "source", "index": 0, "path": "formations/other/x.jpg"},
    {"kind": "source", "index": 0, "url": "https://example.com/x.jpg"},
])
def test_source_item_cannot_supply_path_or_url(client, duplicate_store, item):
    seed_source(duplicate_store)
    assert post(client, payload([item])).status_code == 422


def test_rate_limit_uses_create_group(client, duplicate_store):
    seed_source(duplicate_store, count=0)
    value = payload([])
    assert post(client, value).status_code == 201
    assert post(client, value).status_code == 200
    assert post(client, value).status_code == 200
    fourth = post(client, value)
    assert fourth.status_code == 429
    assert fourth.json()["error"]["code"] == "RATE_LIMITED"


def test_writes_disabled_and_wrong_origin(client, duplicate_store, monkeypatch):
    seed_source(duplicate_store)
    monkeypatch.setenv("PORTAL_WRITE_ENABLED", "false")
    assert post(client).status_code == 503
    monkeypatch.setenv("PORTAL_WRITE_ENABLED", "true")
    assert post(client, headers={"Origin": "https://evil.example"}).status_code == 403
    assert not destination_paths(duplicate_store)


def test_request_id_secret_and_response_are_safe(client, duplicate_store):
    seed_source(duplicate_store)
    assert post(client, payload(request_id="invalid")).status_code == 422
    assert post(client, payload(delete_secret="invalid")).status_code == 422
    result = post(client)
    assert result.status_code == 201
    assert set(result.json()) == {"id", "category", "timestamp", "replayed"}
    assert SOURCE_SECRET not in str(result.json())
    assert DELETE_SECRET not in str(result.json())


def test_source_equals_new_post_id_rejected(client, duplicate_store):
    seed_source(duplicate_store, source_id=POST_ID)
    assert post(client, source_id=POST_ID).status_code == 422
