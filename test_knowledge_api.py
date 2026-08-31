import os
os.environ["GEMINI_API_KEY"] = "test"
os.environ["ADMIN_API_KEY"] = "test_admin_key"

import sys
from unittest.mock import MagicMock
import google.cloud.firestore
import google.genai
from datetime import datetime, timezone

# Mock clients before importing main
google.cloud.firestore.Client = MagicMock()
google.genai.Client = MagicMock()

from backend.main import app, db
from fastapi.testclient import TestClient

client = TestClient(app)

print("=== API挙動テスト: GET /api/admin/knowledge ===")

# Mock Firestore stream
mock_doc1 = MagicMock()
mock_doc1.id = "doc1"
mock_doc1.to_dict.return_value = {
    "title": "Title1", "active": True, "embedding_field": [0.1, 0.2], "content": "Text1",
    "updated_at": datetime.now(timezone.utc)
}

mock_doc2 = MagicMock()
mock_doc2.id = "doc2"
mock_doc2.to_dict.return_value = {
    "title": "Title2", "embedding_field": [0.3], "content": "Text2",
    # No updated_at, no active field (should default to True)
}

mock_query = MagicMock()
mock_query.stream.return_value = [mock_doc1, mock_doc2]
mock_query.limit.return_value = mock_query

# Mock collection
mock_collection = MagicMock()
mock_collection.limit.return_value = mock_query
db.collection.return_value = mock_collection

# Test 1: No admin key
res = client.get("/api/admin/knowledge")
assert res.status_code == 401, f"Expected 401, got {res.status_code}"
print("PASS: 管理キーなし -> 401")

# Test 2: Invalid admin key
res = client.get("/api/admin/knowledge", headers={"X-Admin-Key": "invalid"})
assert res.status_code == 401, f"Expected 401, got {res.status_code}"
print("PASS: 不正な管理キー -> 401")

# Test 3: Valid admin key
res = client.get("/api/admin/knowledge", headers={"X-Admin-Key": "test_admin_key"})
assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
data = res.json()
assert data["status"] == "ok"
items = data["items"]
assert len(items) == 2, f"Expected 2 items, got {len(items)}"
print("PASS: 正しいキー -> 200")

# Test 4: Embedding removed, active defaulted to True, updated_at preserved
for item in items:
    assert "embedding_field" not in item, "embedding_fieldがレスポンスに含まれている"
    assert "embedding" not in item, "embeddingがレスポンスに含まれている"
    assert item["active"] is True, "activeフィールドがTrueになっていない"

assert "updated_at" in items[0], "Timestampが文字列化されていない"
print("PASS: embedding非公開、activeデフォルトTrue、TimestampのJSON化")


print("\n=== API挙動テスト: PATCH /api/admin/knowledge/{doc_id}/active ===")

mock_doc_ref = MagicMock()
mock_doc_snap = MagicMock()
mock_doc_snap.exists = True
mock_doc_ref.get.return_value = mock_doc_snap

mock_collection.document.return_value = mock_doc_ref

# Test 1: doc_id check (invalid doc_id)
res = client.patch("/api/admin/knowledge/doc1/invalid/active", headers={"X-Admin-Key": "test_admin_key"}, json={"active": False})
assert res.status_code == 404, "パスの構造上、スラッシュが入ると404になるはず"
print("PASS: doc_idにスラッシュ -> 404拒否")

# Test 2: doc_id too long
long_id = "a" * 201
res = client.patch(f"/api/admin/knowledge/{long_id}/active", headers={"X-Admin-Key": "test_admin_key"}, json={"active": False})
assert res.status_code == 400, "長すぎるdoc_idが拒否されていない"
print("PASS: 長すぎるdoc_id -> 400拒否")

# Test 3: Document not found
mock_doc_snap_nf = MagicMock()
mock_doc_snap_nf.exists = False
mock_doc_ref_nf = MagicMock()
mock_doc_ref_nf.get.return_value = mock_doc_snap_nf
def doc_side_effect(doc_id):
    if doc_id == "notfound":
        return mock_doc_ref_nf
    return mock_doc_ref
mock_collection.document.side_effect = doc_side_effect

res = client.patch("/api/admin/knowledge/notfound/active", headers={"X-Admin-Key": "test_admin_key"}, json={"active": False})
assert res.status_code == 404, "存在しないドキュメントの更新が拒否されていない"
print("PASS: 存在しないdoc_id -> 404拒否 (新規作成防止)")

# Test 4: valid update (active: false)
res = client.patch("/api/admin/knowledge/doc1/active", headers={"X-Admin-Key": "test_admin_key"}, json={"active": False})
assert res.status_code == 200
mock_doc_ref.update.assert_called_with({"active": False, "updated_at": google.cloud.firestore.SERVER_TIMESTAMP})
print("PASS: active=false への更新成功 (冪等)")

# Test 5: valid update (active: true)
res = client.patch("/api/admin/knowledge/doc1/active", headers={"X-Admin-Key": "test_admin_key"}, json={"active": True})
assert res.status_code == 200
mock_doc_ref.update.assert_called_with({"active": True, "updated_at": google.cloud.firestore.SERVER_TIMESTAMP})
print("PASS: active=true への更新成功 (冪等)")

# Test 6: Invalid body
res = client.patch("/api/admin/knowledge/doc1/active", headers={"X-Admin-Key": "test_admin_key"}, json={"active": "not_a_bool"})
assert res.status_code == 422, "不正な型のbodyが拒否されていない"
res = client.patch("/api/admin/knowledge/doc1/active", headers={"X-Admin-Key": "test_admin_key"}, json={"wrong_field": True})
assert res.status_code == 422, "不正なフィールドのbodyが拒否されていない"
print("PASS: 不正なbody -> 422拒否")

print("\n全テスト完了")
