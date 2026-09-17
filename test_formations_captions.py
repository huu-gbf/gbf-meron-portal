"""Caption metadata contract, storage isolation, and retry compatibility."""
import hashlib
import json

import pytest

from test_formations_create import (
    JPEG, main, client, portal, payload, post, paths,
)


@pytest.mark.parametrize("captions", [None, [], [""], [" \t "]])
def test_no_caption_canonical_and_legacy_hash(client, portal, captions):
    value = payload()
    if captions is not None:
        value["imageCaptions"] = captions
    assert post(client, value=value).status_code == 201
    database, _ = portal
    public, private, _ = paths()
    assert "imageCaptions" not in database.data[public]
    original = {"category": "gw", "name": value["name"].strip(),
                "comment": value["comment"].strip(), "images": value["images"]}
    expected = hashlib.sha256(json.dumps(original, sort_keys=True, ensure_ascii=False,
                                        separators=(",", ":")).encode()).hexdigest()
    assert database.data[private]["payload_hash"] == expected


@pytest.mark.parametrize("captions,expected", [
    (["  武器  "], ["武器"]),
    (["あ" * 20], ["あ" * 20]),
    (["😀" * 20], ["😀" * 20]),
    (["キャラ", "", " 召喚石 "], ["キャラ", "", "召喚石"]),
    ([str(index) for index in range(10)], [str(index) for index in range(10)]),
])
def test_caption_saved_with_storage_urls_and_tags(client, portal, captions, expected):
    value = payload(images=[JPEG] * len(captions), imageCaptions=captions,
                    tags=["神石", "火", "火"])
    assert post(client, value=value).status_code == 201
    database, _ = portal
    public = database.data[paths()[0]]
    assert public["imageCaptions"] == expected
    assert public["tags"] == ["火", "神石"]
    assert len(public["images"]) == len(public["imageStoragePaths"]) == len(expected)
    assert all(url.startswith("https://firebasestorage.googleapis.com/") for url in public["images"])
    assert database.bucket.upload_calls == len(expected)
    assert all(obj["data"] == b"\xff\xd8\xffbody\xff\xd9" for obj in database.bucket.objects.values())


@pytest.mark.parametrize("captions", [["あ" * 21], ["x"] * 11, ["a", "b"],
                                     "caption", [123], [None], None, {}])
def test_invalid_captions_rejected_before_upload(client, portal, captions):
    assert post(client, value=payload(imageCaptions=captions)).status_code == 422
    database, _ = portal
    assert database.bucket.upload_calls == 0
    assert not database.data


def test_caption_hash_changes_and_no_caption_compatibility():
    args = ("gw", "name", "comment", [JPEG], ["火"])
    old_hash = main.build_formation_payload_hash(*args)
    assert old_hash == main.build_formation_payload_hash(*args, [])
    assert old_hash == main.build_formation_payload_hash(*args, [""])
    first = main.build_formation_payload_hash(*args, ["武器"])
    second = main.build_formation_payload_hash(*args, ["召喚石"])
    assert len({old_hash, first, second}) == 3


def test_caption_retry_and_changed_caption_conflict(client, portal):
    value = payload(imageCaptions=[" 武器 "], tags=["火"])
    assert post(client, value=value).status_code == 201
    value["imageCaptions"] = ["武器"]
    replay = post(client, value=value)
    assert replay.status_code == 200
    assert replay.json()["replayed"] is True
    value["imageCaptions"] = ["召喚石"]
    assert post(client, value=value).status_code == 409
    assert portal[0].bucket.upload_calls == 1


def test_no_caption_retry_forms(client, portal):
    assert post(client).status_code == 201
    assert post(client, value=payload(imageCaptions=[])).status_code == 200
    assert post(client, value=payload(imageCaptions=[" "])).status_code == 200
    assert portal[0].bucket.upload_calls == 1


def test_caption_upload_rollback(client, portal):
    database, _ = portal
    database.bucket.fail_upload_number = 2
    value = payload(images=[JPEG, JPEG], imageCaptions=["キャラ", "武器"])
    assert post(client, value=value).status_code == 503
    assert not database.bucket.objects
    assert paths()[0] not in database.data


def test_caption_transaction_rollback(client, portal):
    database, _ = portal
    database.fail_create_write_number = 2
    assert post(client, value=payload(imageCaptions=["武器"])).status_code == 503
    assert not database.bucket.objects
    assert paths()[0] not in database.data


def test_caption_transaction_replay(client, portal):
    from datetime import datetime, timezone
    value = payload(imageCaptions=["武器"])
    assert post(client, value=value).status_code == 201
    database, _ = portal
    public, private, _ = paths()
    stored = database.data[public]
    secret = database.data[private]
    result = main.create_formation_transaction(
        "gw", stored["id"], secret["delete_secret_hash"], secret["payload_hash"],
        stored["name"], stored["comment"], stored["images"], stored["tags"],
        datetime.now(timezone.utc), stored["imageStoragePaths"], ["武器"],
    )
    assert result["replayed"] is True


def test_caption_openapi():
    model = main.app.openapi()["components"]["schemas"]["FormationCreateRequest"]
    caption = model["properties"]["imageCaptions"]
    assert "imageCaptions" not in model["required"]
    assert caption["type"] == "array"
    assert caption["maxItems"] == 10
    assert caption["items"] == {"type": "string", "maxLength": 20}
    assert model["additionalProperties"] is False
    assert "tags" in model["properties"]
