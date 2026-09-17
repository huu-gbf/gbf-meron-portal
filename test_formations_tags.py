# -*- coding: utf-8 -*-
import base64
import json
import os
import sys
import uuid
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

@pytest.fixture
def client():
    return TestClient(main.app)

import test_formations_create as tfc

@pytest.fixture
def mock_db(monkeypatch):
    db = tfc.FakeFirestore()
    monkeypatch.setattr(main, "get_portal_db", lambda: db)
    monkeypatch.setattr(main.firestore, "transactional", tfc.fake_transactional)
    
    bucket = tfc.FakeBucket()
    monkeypatch.setattr(main, "formation_storage_bucket", lambda: bucket)
    monkeypatch.setattr(main, "consume_portal_quota", lambda *args, **kwargs: None)
    return db

ORIGIN = "https://huu-gbf.github.io"
HEADERS = {"Origin": ORIGIN}
REQUEST_ID = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"
SECRET_BYTES = bytes(range(32))
DELETE_SECRET = base64.urlsafe_b64encode(SECRET_BYTES).rstrip(b"=").decode("ascii")
JPEG = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xffbody\xff\xd9").decode("ascii")

def make_payload(tags=None, missing_tags=False):
    payload = {
        "request_id": str(uuid.uuid4()),
        "delete_secret": DELETE_SECRET,
        "name": "name",
        "comment": "comment",
        "images": [JPEG]
    }
    if not missing_tags:
        payload["tags"] = tags if tags is not None else []
    return payload

def test_tags_missing(client, mock_db):
    response = client.post("/api/formations/gw", headers=HEADERS, json=make_payload(missing_tags=True))
    assert response.status_code == 201

def test_tags_empty(client, mock_db):
    response = client.post("/api/formations/gw", headers=HEADERS, json=make_payload([]))
    assert response.status_code == 201

def test_tags_common_single(client, mock_db):
    response = client.post("/api/formations/gw", headers=HEADERS, json=make_payload(["火"]))
    assert response.status_code == 201

def test_tags_common_multiple(client, mock_db):
    response = client.post("/api/formations/gw", headers=HEADERS, json=make_payload(["火", "神石", "フルオート"]))
    assert response.status_code == 201

def test_tags_gw_specific(client, mock_db):
    response = client.post("/api/formations/gw", headers=HEADERS, json=make_payload(["火", "神石", "フルオート", "250HELL"]))
    assert response.status_code == 201

def test_tags_gw_multiple_uses(client, mock_db):
    response = client.post("/api/formations/gw", headers=HEADERS, json=make_payload(["150HELL", "200HELL"]))
    assert response.status_code == 201

def test_tags_multi(client, mock_db):
    response = client.post("/api/formations/multi", headers=HEADERS, json=make_payload(["光", "マグナ", "ソロモナスの賢者"]))
    assert response.status_code == 201

def test_tags_hihi(client, mock_db):
    response = client.post("/api/formations/multi", headers=HEADERS, json=make_payload(["火", "神石", "ヒヒ掘り"]))
    assert response.status_code == 201

def test_tags_invalid(client, mock_db):
    response = client.post("/api/formations/gw", headers=HEADERS, json=make_payload(["存在しないタグ"]))
    assert response.status_code == 422

def test_tags_gw_tag_to_multi(client, mock_db):
    response = client.post("/api/formations/multi", headers=HEADERS, json=make_payload(["250HELL"]))
    assert response.status_code == 422

def test_tags_multi_tag_to_gw(client, mock_db):
    response = client.post("/api/formations/gw", headers=HEADERS, json=make_payload(["ヒヒ掘り"]))
    assert response.status_code == 422

def test_tags_gw_tag_to_high(client, mock_db):
    response = client.post("/api/formations/high", headers=HEADERS, json=make_payload(["250HELL"]))
    assert response.status_code == 422

def test_tags_multiple_elements(client, mock_db):
    response = client.post("/api/formations/gw", headers=HEADERS, json=make_payload(["火", "水"]))
    assert response.status_code == 422

def test_tags_multiple_summons(client, mock_db):
    response = client.post("/api/formations/gw", headers=HEADERS, json=make_payload(["神石", "マグナ"]))
    assert response.status_code == 422

def test_tags_multiple_playstyles(client, mock_db):
    response = client.post("/api/formations/gw", headers=HEADERS, json=make_payload(["フルオート", "奥義軸"]))
    assert response.status_code == 201

def test_tags_type_string(client, mock_db):
    payload = make_payload()
    payload["tags"] = "火"
    response = client.post("/api/formations/gw", headers=HEADERS, json=payload)
    assert response.status_code == 422

def test_tags_type_number(client, mock_db):
    payload = make_payload()
    payload["tags"] = 123
    response = client.post("/api/formations/gw", headers=HEADERS, json=payload)
    assert response.status_code == 422

def test_tags_type_object(client, mock_db):
    payload = make_payload()
    payload["tags"] = {}
    response = client.post("/api/formations/gw", headers=HEADERS, json=payload)
    assert response.status_code == 422

def test_tags_type_number_in_array(client, mock_db):
    payload = make_payload()
    payload["tags"] = [123]
    response = client.post("/api/formations/gw", headers=HEADERS, json=payload)
    assert response.status_code == 422

def test_tags_type_mixed_array(client, mock_db):
    payload = make_payload()
    payload["tags"] = ["火", 123]
    response = client.post("/api/formations/gw", headers=HEADERS, json=payload)
    assert response.status_code == 422

def test_tags_hash_idempotency_empty(client, mock_db):
    payload_a = make_payload(missing_tags=True)
    payload_a["request_id"] = REQUEST_ID
    payload_b = make_payload([])
    payload_b["request_id"] = REQUEST_ID
    
    response_a = client.post("/api/formations/gw", headers=HEADERS, json=payload_a)
    assert response_a.status_code == 201
    
    import backend.main as main
    hash_a = main.build_formation_payload_hash("gw", "name", "comment", [JPEG], [])
    hash_b = main.build_formation_payload_hash("gw", "name", "comment", [JPEG], [])
    assert hash_a == hash_b

def test_tags_hash_idempotency_order(client, mock_db):
    import backend.main as main
    payload_a = make_payload(["火", "神石", "フルオート"])
    payload_b = make_payload(["フルオート", "火", "神石"])
    
    _, _, _, tags_a = main.validate_formation_payload(main.FormationCreateRequest(**payload_a), "gw")
    _, _, _, tags_b = main.validate_formation_payload(main.FormationCreateRequest(**payload_b), "gw")
    
    assert tags_a == ["火", "神石", "フルオート"]
    assert tags_b == ["火", "神石", "フルオート"]
    
    hash_a = main.build_formation_payload_hash("gw", "name", "comment", [JPEG], tags_a)
    hash_b = main.build_formation_payload_hash("gw", "name", "comment", [JPEG], tags_b)
    assert hash_a == hash_b
