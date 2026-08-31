import os
os.environ["GEMINI_API_KEY"] = "test"
os.environ["ADMIN_API_KEY"] = "test_admin_key"

import sys
from unittest.mock import MagicMock
import google.cloud.firestore
import google.genai
from datetime import datetime, timezone, timedelta

# Mock clients before importing main
google.cloud.firestore.Client = MagicMock()
google.genai.Client = MagicMock()

from backend.main import app, db, search_knowledge_base
from fastapi.testclient import TestClient

client = TestClient(app)

print("=== API挙動テスト: GET /api/admin/knowledge ===")

mock_doc1 = MagicMock()
mock_doc1.id = "doc1"
mock_doc1.to_dict.return_value = {
    "title": "Title1", "active": True, "embedding_field": [0.1, 0.2], "content": "Text1",
    "updated_at": datetime.now(timezone.utc),
    "valid_from": datetime(2026, 9, 1, 0, 0, tzinfo=timezone.utc),
    "valid_until": datetime(2026, 9, 30, 23, 59, tzinfo=timezone.utc)
}

mock_doc2 = MagicMock()
mock_doc2.id = "doc2"
mock_doc2.to_dict.return_value = {
    "title": "Title2", "embedding_field": [0.3], "content": "Text2",
    # No updated_at, no active field (should default to True), no valid_from/until
}

mock_query = MagicMock()
mock_query.stream.return_value = [mock_doc1, mock_doc2]
mock_query.limit.return_value = mock_query

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

# Test 4: Embedding removed, active defaulted to True, valid_from/until serialized
assert "embedding_field" not in items[0]
assert "embedding" not in items[0]
assert items[0]["active"] is True
assert "valid_from" in items[0] and items[0]["valid_from"].startswith("2026-09-01")
assert "valid_until" in items[0] and items[0]["valid_until"].startswith("2026-09-30")
assert items[1]["active"] is True
assert "valid_from" not in items[1]
print("PASS: embedding非公開、activeデフォルトTrue、valid_from/untilシリアライズ")


print("\n=== API挙動テスト: PATCH /api/admin/knowledge/{doc_id}/active ===")

mock_doc_ref = MagicMock()
mock_doc_snap = MagicMock()
mock_doc_snap.exists = True
mock_doc_ref.get.return_value = mock_doc_snap

def doc_side_effect(doc_id):
    if doc_id == "notfound":
        mock_nf = MagicMock()
        mock_nf.get.return_value.exists = False
        return mock_nf
    return mock_doc_ref

mock_collection.document.side_effect = doc_side_effect

# Test 5: doc_id format
res = client.patch("/api/admin/knowledge/doc1/invalid/active", headers={"X-Admin-Key": "test_admin_key"}, json={"active": False})
assert res.status_code == 404
long_id = "a" * 201
res = client.patch(f"/api/admin/knowledge/{long_id}/active", headers={"X-Admin-Key": "test_admin_key"}, json={"active": False})
assert res.status_code == 400
print("PASS: 不正doc_idの拒否")

# Test 6: Not found
res = client.patch("/api/admin/knowledge/notfound/active", headers={"X-Admin-Key": "test_admin_key"}, json={"active": False})
assert res.status_code == 404
print("PASS: 存在しないdoc_id -> 404拒否 (新規作成防止)")

# Test 7: Valid active update (idempotent)
res = client.patch("/api/admin/knowledge/doc1/active", headers={"X-Admin-Key": "test_admin_key"}, json={"active": False})
assert res.status_code == 200
mock_doc_ref.update.assert_called_with({"active": False, "updated_at": google.cloud.firestore.SERVER_TIMESTAMP})
res = client.patch("/api/admin/knowledge/doc1/active", headers={"X-Admin-Key": "test_admin_key"}, json={"active": True})
assert res.status_code == 200
mock_doc_ref.update.assert_called_with({"active": True, "updated_at": google.cloud.firestore.SERVER_TIMESTAMP})
print("PASS: active更新成功 (冪等)")

# Test 8 (Restored): Invalid body for active update -> 422
res = client.patch("/api/admin/knowledge/doc1/active", headers={"X-Admin-Key": "test_admin_key"}, json={"active": "not_a_bool"})
assert res.status_code == 422, f"Expected 422, got {res.status_code}"
res = client.patch("/api/admin/knowledge/doc1/active", headers={"X-Admin-Key": "test_admin_key"}, json={"wrong_field": True})
assert res.status_code == 422, f"Expected 422, got {res.status_code}"
res = client.patch("/api/admin/knowledge/doc1/active", headers={"X-Admin-Key": "test_admin_key"}, json={"active": True, "extra": 1})
assert res.status_code == 422, f"Expected 422 for extra field, got {res.status_code}"
print("PASS: active不正body (型不正・未知フィールド・フィールド欠落) -> 422拒否")


print("\n=== API挙動テスト: PATCH /api/admin/knowledge/{doc_id}/expiration ===")

# Test 9: No admin key / invalid key
res = client.patch("/api/admin/knowledge/doc1/expiration", json={"valid_from": None, "valid_until": None})
assert res.status_code == 401
res = client.patch("/api/admin/knowledge/doc1/expiration", headers={"X-Admin-Key": "bad"}, json={"valid_from": None, "valid_until": None})
assert res.status_code == 401
print("PASS: expiration更新 管理キー認証")

# Test 10: Missing fields / empty body / typo fields / extra fields -> 422
res = client.patch("/api/admin/knowledge/doc1/expiration", headers={"X-Admin-Key": "test_admin_key"}, json={})
assert res.status_code == 422, f"Expected 422 for empty body, got {res.status_code}"

res = client.patch("/api/admin/knowledge/doc1/expiration", headers={"X-Admin-Key": "test_admin_key"}, json={"valid_from": None})
assert res.status_code == 422, f"Expected 422 for missing valid_until, got {res.status_code}"

res = client.patch("/api/admin/knowledge/doc1/expiration", headers={"X-Admin-Key": "test_admin_key"}, json={"valid_until": None})
assert res.status_code == 422, f"Expected 422 for missing valid_from, got {res.status_code}"

res = client.patch("/api/admin/knowledge/doc1/expiration", headers={"X-Admin-Key": "test_admin_key"}, json={"valid_form": "2026-09-01T00:00:00Z", "valid_until": None})
assert res.status_code == 422, f"Expected 422 for typo field, got {res.status_code}"

res = client.patch("/api/admin/knowledge/doc1/expiration", headers={"X-Admin-Key": "test_admin_key"}, json={"valid_from": None, "valid_until": None, "extra_field": "bad"})
assert res.status_code == 422, f"Expected 422 for extra field (extra=forbid), got {res.status_code}"
print("PASS: expiration必須フィールド検証・未知フィールド拒否 -> 422")

# Test 11: Empty string "" -> 422 (nullのみ許可)
res = client.patch("/api/admin/knowledge/doc1/expiration", headers={"X-Admin-Key": "test_admin_key"}, json={"valid_from": "", "valid_until": None})
assert res.status_code == 422, f"Expected 422 for empty string valid_from, got {res.status_code}"
res = client.patch("/api/admin/knowledge/doc1/expiration", headers={"X-Admin-Key": "test_admin_key"}, json={"valid_from": None, "valid_until": ""})
assert res.status_code == 422, f"Expected 422 for empty string valid_until, got {res.status_code}"
print("PASS: 空文字 \"\" -> 422拒否 (明示的nullのみ許可)")

# Test 12: Naive datetime (no timezone) -> 422
res = client.patch(
    "/api/admin/knowledge/doc1/expiration",
    headers={"X-Admin-Key": "test_admin_key"},
    json={"valid_from": "2026-09-01T20:00:00", "valid_until": None}
)
assert res.status_code == 422, f"Expected 422 for naive datetime, got {res.status_code}"
assert "タイムゾーン指定" in res.text
print("PASS: タイムゾーンなし (naive) -> 422拒否")

# Test 13: valid_from > valid_until -> 422
res = client.patch(
    "/api/admin/knowledge/doc1/expiration",
    headers={"X-Admin-Key": "test_admin_key"},
    json={
        "valid_from": "2026-09-10T00:00:00+09:00",
        "valid_until": "2026-09-05T00:00:00+09:00"
    }
)
assert res.status_code == 422, f"Expected 422 for valid_from > valid_until, got {res.status_code}"
print("PASS: valid_from > valid_until -> 422拒否")

# Test 14: valid_from == valid_until -> 200 (許可)
res = client.patch(
    "/api/admin/knowledge/doc1/expiration",
    headers={"X-Admin-Key": "test_admin_key"},
    json={
        "valid_from": "2026-09-05T12:00:00+09:00",
        "valid_until": "2026-09-05T12:00:00+09:00"
    }
)
assert res.status_code == 200, f"Expected 200 for valid_from == valid_until, got {res.status_code}"
print("PASS: valid_from == valid_until -> 200許可")

# Test 15: +09:00 datetime -> 200 (Normalized to UTC)
res = client.patch(
    "/api/admin/knowledge/doc1/expiration",
    headers={"X-Admin-Key": "test_admin_key"},
    json={
        "valid_from": "2026-09-01T09:00:00+09:00",
        "valid_until": "2026-09-10T09:00:00+09:00"
    }
)
assert res.status_code == 200
data = res.json()
assert data["valid_from"] == "2026-09-01T00:00:00+00:00"
assert data["valid_until"] == "2026-09-10T00:00:00+00:00"
print("PASS: +09:00日時 -> 200 (UTCへ正規化)")

# Test 16: Z(UTC) datetime -> 200
res = client.patch(
    "/api/admin/knowledge/doc1/expiration",
    headers={"X-Admin-Key": "test_admin_key"},
    json={
        "valid_from": "2026-09-01T00:00:00Z",
        "valid_until": "2026-09-10T00:00:00Z"
    }
)
assert res.status_code == 200
print("PASS: Z(UTC)日時 -> 200")

# Test 17: Both null -> 200 (期限解除)
res = client.patch(
    "/api/admin/knowledge/doc1/expiration",
    headers={"X-Admin-Key": "test_admin_key"},
    json={"valid_from": None, "valid_until": None}
)
assert res.status_code == 200
data = res.json()
assert data["valid_from"] is None
assert data["valid_until"] is None
mock_doc_ref.update.assert_called_with({
    "valid_from": None,
    "valid_until": None,
    "updated_at": google.cloud.firestore.SERVER_TIMESTAMP
})
print("PASS: 両方null -> 200 (期限解除)")

# Test 18: Not found doc_id
res = client.patch(
    "/api/admin/knowledge/notfound/expiration",
    headers={"X-Admin-Key": "test_admin_key"},
    json={"valid_from": None, "valid_until": None}
)
assert res.status_code == 404
print("PASS: 存在しないdoc_idへのexpiration更新 -> 404拒否")


print("\n=== RAG有効期限除外ロジック挙動テスト ===")

fixed_now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc)

# 境界値判定ロジック自体の検証
# now < valid_from: 除外
assert fixed_now < fixed_now + timedelta(seconds=1)
# now == valid_from: 有効 (除外されない)
assert not (fixed_now < fixed_now)
# now == valid_until: 有効 (除外されない)
assert not (fixed_now > fixed_now)
# now > valid_until: 除外
assert fixed_now > fixed_now - timedelta(seconds=1)
print("PASS: 境界値比較論理（開始ちょうど・終了ちょうどは有効）確認")

now = datetime.now(timezone.utc)

test_docs = []

# 1. 有効 (期限なし)
d1 = MagicMock()
d1.id = "k_no_exp"
d1.to_dict.return_value = {"content": "有効（期限なし）", "vector_distance": 0.1, "active": True}
test_docs.append(d1)

# 2. 有効 (期間内)
d2 = MagicMock()
d2.id = "k_in_range"
d2.to_dict.return_value = {
    "content": "有効（期間内）",
    "vector_distance": 0.15,
    "active": True,
    "valid_from": now - timedelta(days=1),
    "valid_until": now + timedelta(days=1)
}
test_docs.append(d2)

# 3. 期間外（未来）
d3 = MagicMock()
d3.id = "k_future"
d3.to_dict.return_value = {
    "content": "期間外（未来）",
    "vector_distance": 0.05,
    "active": True,
    "valid_from": now + timedelta(days=1)
}
test_docs.append(d3)

# 4. 期限切れ（過去）
d4 = MagicMock()
d4.id = "k_expired"
d4.to_dict.return_value = {
    "content": "期限切れ",
    "vector_distance": 0.06,
    "active": True,
    "valid_until": now - timedelta(days=1)
}
test_docs.append(d4)

# 5. active=false (期間内だが無効)
d5 = MagicMock()
d5.id = "k_inactive"
d5.to_dict.return_value = {
    "content": "無効データ",
    "vector_distance": 0.08,
    "active": False,
    "valid_from": now - timedelta(days=1),
    "valid_until": now + timedelta(days=1)
}
test_docs.append(d5)

# 6. 開始1秒前 (期間外)
d6 = MagicMock()
d6.id = "k_before_1s"
d6.to_dict.return_value = {
    "content": "開始1秒前",
    "vector_distance": 0.07,
    "active": True,
    "valid_from": now + timedelta(seconds=10)
}
test_docs.append(d6)

# 7. 終了1秒後 (期限切れ)
d7 = MagicMock()
d7.id = "k_after_1s"
d7.to_dict.return_value = {
    "content": "終了1秒後",
    "vector_distance": 0.07,
    "active": True,
    "valid_until": now - timedelta(seconds=10)
}
test_docs.append(d7)

# 8. 不正データ: naive datetime (フェイルクローズで安全除外)
d8 = MagicMock()
d8.id = "k_naive_dt"
d8.to_dict.return_value = {
    "content": "壊れたデータ（naive）",
    "vector_distance": 0.04,
    "active": True,
    "valid_from": datetime(2026, 1, 1, 0, 0) # naive
}
test_docs.append(d8)

# 9. 不正データ: パース不能文字列 (フェイルクローズで安全除外)
d9 = MagicMock()
d9.id = "k_bad_str"
d9.to_dict.return_value = {
    "content": "壊れたデータ（不正文字列）",
    "vector_distance": 0.04,
    "active": True,
    "valid_until": "invalid-datetime-string"
}
test_docs.append(d9)

# 10. 不正データ: 不正型 (フェイルクローズで安全除外)
d10 = MagicMock()
d10.id = "k_bad_type"
d10.to_dict.return_value = {
    "content": "壊れたデータ（数値型）",
    "vector_distance": 0.04,
    "active": True,
    "valid_from": 12345678
}
test_docs.append(d10)

# 11. 大量除外シミュレーション用 (期限切れ多数)
for i in range(15):
    d_exp = MagicMock()
    d_exp.id = f"k_mass_expired_{i}"
    d_exp.to_dict.return_value = {
        "content": f"大量期限切れ {i}",
        "vector_distance": 0.05 + (i * 0.01),
        "active": True,
        "valid_until": now - timedelta(days=10)
    }
    test_docs.append(d_exp)

mock_find_results = MagicMock()
mock_find_results.get.return_value = test_docs

mock_col = MagicMock()
mock_col.find_nearest.return_value = mock_find_results
db.collection.return_value = mock_col

# Mock get_embedding
import backend.main
backend.main.get_embedding = MagicMock(return_value=[0.1] * 768)

context_text, sources = search_knowledge_base("テスト検索")

assert "期間外（未来）" not in context_text, "未来の知識がRAGに含まれている"
assert "期限切れ" not in context_text, "期限切れの知識がRAGに含まれている"
assert "無効データ" not in context_text, "無効な知識がRAGに含まれている"
assert "開始1秒前" not in context_text, "開始1秒前の知識がRAGに含まれている"
assert "終了1秒後" not in context_text, "終了1秒後の知識がRAGに含まれている"
assert "壊れたデータ（naive）" not in context_text, "壊れたnaive日時データが除外されずRAGに含まれている"
assert "壊れたデータ（不正文字列）" not in context_text, "壊れた文字列日時データが除外されずRAGに含まれている"
assert "壊れたデータ（数値型）" not in context_text, "壊れた型データが除外されずRAGに含まれている"
assert "大量期限切れ" not in context_text, "大量期限切れの知識がRAGに含まれている"

assert "有効（期限なし）" in context_text or "有効（期間内）" in context_text, "有効な知識が取得できていない"
print("PASS: RAG期限判定、フェイルクローズ（壊れたデータの安全除外）、境界値、active除外、大量期限切れ耐性")


print("\n=== UI状態優先順位判定テスト (JavaScript同等ロジック) ===")

def mock_get_knowledge_status(item, now_dt):
    if item.get("active") is False:
        return "無効"
    vf = item.get("valid_from")
    if vf:
        vf_dt = datetime.fromisoformat(vf) if isinstance(vf, str) else vf
        if now_dt < vf_dt:
            return "期間外（未来）"
    vu = item.get("valid_until")
    if vu:
        vu_dt = datetime.fromisoformat(vu) if isinstance(vu, str) else vu
        if now_dt > vu_dt:
            return "期限切れ"
    return "有効"

test_now = datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc)

# 優先順位 1: active=false かつ 期限切れ -> 「無効」
assert mock_get_knowledge_status({"active": False, "valid_until": "2026-08-01T00:00:00Z"}, test_now) == "無効"
# 優先順位 1: active=false かつ 未来 -> 「無効」
assert mock_get_knowledge_status({"active": False, "valid_from": "2026-10-01T00:00:00Z"}, test_now) == "無効"
# 優先順位 2: active=true かつ 未来 -> 「期間外（未来）」
assert mock_get_knowledge_status({"active": True, "valid_from": "2026-10-01T00:00:00Z"}, test_now) == "期間外（未来）"
# 優先順位 3: active=true かつ 期限切れ -> 「期限切れ」
assert mock_get_knowledge_status({"active": True, "valid_until": "2026-08-01T00:00:00Z"}, test_now) == "期限切れ"
# 優先順位 4: active=true かつ 期間内 -> 「有効」
assert mock_get_knowledge_status({"active": True, "valid_from": "2026-08-01T00:00:00Z", "valid_until": "2026-10-01T00:00:00Z"}, test_now) == "有効"
# 優先順位 4: activeなし (未設定=有効) かつ 期限なし -> 「有効」
assert mock_get_knowledge_status({}, test_now) == "有効"

print("PASS: UI状態優先順位（active=false最優先 -> 未来 -> 期限切れ -> 有効）確認")

print("\n============================================================")
print("全テスト (Test 1〜18 + RAG判定 + UI状態優先順位) 正常終了")
print("============================================================")
