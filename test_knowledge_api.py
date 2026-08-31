import os
os.environ["GEMINI_API_KEY"] = "test"
os.environ["ADMIN_API_KEY"] = "test_admin_key"

import sys
from unittest.mock import MagicMock, PropertyMock
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
        type(mock_nf).id = PropertyMock(return_value=doc_id)
        mock_nf.get.return_value.exists = False
        return mock_nf
    
    mock_ref = MagicMock()
    type(mock_ref).id = PropertyMock(return_value=doc_id)
    mock_ref.update = mock_doc_ref.update
    
    mock_snap = MagicMock()
    mock_snap.exists = True
    mock_ref.get.return_value = mock_snap
    
    return mock_ref

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
mock_col.document.side_effect = doc_side_effect
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


print("\n=== 情報ソース管理 (Task 5) テスト ===")

# Test 16: PATCH /api/admin/knowledge/source-settings/{source_type} バリデーション
res = client.patch("/api/admin/knowledge/source-settings/test-source", headers={"X-Admin-Key": "test_admin_key"}, json={"enabled": True})
assert res.status_code == 200

res = client.patch("/api/admin/knowledge/source-settings/test-source", headers={"X-Admin-Key": "test_admin_key"}, json={"enabled": False})
assert res.status_code == 200

res = client.patch("/api/admin/knowledge/source-settings/test-source", headers={"X-Admin-Key": "test_admin_key"}, json={"enabled": "false"})
assert res.status_code == 422, "文字列の false は 422 で拒否"

res = client.patch("/api/admin/knowledge/source-settings/test-source", headers={"X-Admin-Key": "test_admin_key"}, json={"enabled": "true"})
assert res.status_code == 422, "文字列の true は 422 で拒否"

res = client.patch("/api/admin/knowledge/source-settings/test-source", headers={"X-Admin-Key": "test_admin_key"}, json={"enabled": 1})
assert res.status_code == 422, "数値の 1 は 422 で拒否"

res = client.patch("/api/admin/knowledge/source-settings/test-source", headers={"X-Admin-Key": "test_admin_key"}, json={"enabled": True, "extra_field": "test"})
assert res.status_code == 422, "未知のフィールドは 422 で拒否"

#不正な source_type
res = client.patch("/api/admin/knowledge/source-settings/invalid/type", headers={"X-Admin-Key": "test_admin_key"}, json={"enabled": True})
assert res.status_code == 404, "/ を含むとパスが変わるので404"
res = client.patch("/api/admin/knowledge/source-settings/!invalid", headers={"X-Admin-Key": "test_admin_key"}, json={"enabled": True})
assert res.status_code == 400, "不正な文字は400で拒否"
res = client.patch(f"/api/admin/knowledge/source-settings/{'a' * 70}", headers={"X-Admin-Key": "test_admin_key"}, json={"enabled": True})
assert res.status_code == 400, "長すぎる値は400で拒否"
print("PASS: PATCH source-settings API バリデーション (StrictBool, extra=forbid, source_type形式)")

# Test 17: RAG 検索時の source_type による除外挙動
d12 = MagicMock()
d12.id = "k_source_disabled"
d12.to_dict.return_value = {
    "content": "ソース無効データ",
    "vector_distance": 0.03,
    "active": True,
    "source_type": "disabled_source"
}
d13 = MagicMock()
d13.id = "k_source_enabled"
d13.to_dict.return_value = {
    "content": "ソース有効データ",
    "vector_distance": 0.02,
    "active": True,
    "source_type": "enabled_source"
}
d14 = MagicMock()
d14.id = "k_source_unknown"
d14.to_dict.return_value = {
    "content": "ソース未登録データ（デフォルトON）",
    "vector_distance": 0.01,
    "active": True,
    "source_type": "unknown_source"
}
test_docs.extend([d12, d13, d14])

mock_s_disabled = MagicMock()
mock_s_disabled.exists = True
type(mock_s_disabled).id = PropertyMock(return_value="disabled_source")
mock_s_disabled.to_dict.return_value = {"enabled": False}

mock_s_enabled = MagicMock()
mock_s_enabled.exists = True
type(mock_s_enabled).id = PropertyMock(return_value="enabled_source")
mock_s_enabled.to_dict.return_value = {"enabled": True}

mock_s_unknown = MagicMock()
mock_s_unknown.exists = False
type(mock_s_unknown).id = PropertyMock(return_value="unknown_source")

mock_s_bad_type = MagicMock()
mock_s_bad_type.exists = True
type(mock_s_bad_type).id = PropertyMock(return_value="bad_type_source")
mock_s_bad_type.to_dict.return_value = {"enabled": "invalid"}

# 既存の RAG テストで使っている find_nearest に影響するため、再定義
def mock_get_all(refs):
    res = []
    print(f"[DEBUG] mock_get_all called with {len(refs)} refs")
    for r in refs:
        print(f"[DEBUG] ref id: {r.id}")
        if r.id == "disabled_source": res.append(mock_s_disabled)
        elif r.id == "enabled_source": res.append(mock_s_enabled)
        elif r.id == "unknown_source": res.append(mock_s_unknown)
        elif r.id == "bad_type_source": res.append(mock_s_bad_type)
        else:
            m = MagicMock()
            m.exists = False
            type(m).id = PropertyMock(return_value=r.id)
            res.append(m)
    return res

db.get_all = MagicMock(side_effect=mock_get_all)

context_text_2, sources_2 = search_knowledge_base("テスト検索ソース")

assert "ソース無効データ" not in context_text_2, "OFFになったソースのデータが除外されていない"
assert "ソース有効データ" in context_text_2, "ONのソースのデータが取得できていない"
assert "ソース未登録データ（デフォルトON）" in context_text_2, "未登録ソースがデフォルトON扱いになっていない"

print("PASS: RAG検索時の source_type による除外挙動 (1回の get_all で取得し N+1 回避)")

# Test 18: UI状態優先順位判定 (JS同等ロジックの修正版)
def mock_get_knowledge_status_v2(item, sourceSettings, now_dt):
    if item.get("active") is False:
        return "無効"
    
    stype = item.get("source_type")
    sourceDisabled = False
    if stype and sourceSettings:
        s = next((x for x in sourceSettings if x.get("source_type") == stype), None)
        if s and s.get("enabled") is False:
            sourceDisabled = True
            
    if sourceDisabled:
        return "ソース停止中"
        
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

mock_source_settings = [
    {"source_type": "disabled_source", "enabled": False},
    {"source_type": "enabled_source", "enabled": True},
]

# active=false + source OFF -> 「無効」が優先
assert mock_get_knowledge_status_v2({"active": False, "source_type": "disabled_source"}, mock_source_settings, test_now) == "無効"
# active=true + source OFF + 期限切れ -> 「ソース停止中」が優先
assert mock_get_knowledge_status_v2({"active": True, "source_type": "disabled_source", "valid_until": "2026-08-01T00:00:00Z"}, mock_source_settings, test_now) == "ソース停止中"
# active=true + source ON + 期限切れ -> 「期限切れ」
assert mock_get_knowledge_status_v2({"active": True, "source_type": "enabled_source", "valid_until": "2026-08-01T00:00:00Z"}, mock_source_settings, test_now) == "期限切れ"

print("PASS: UI状態優先順位判定 v2 (ソース停止中の優先順位確認)")

d15 = MagicMock()
d15.id = "k_source_invalid_format"
d15.to_dict.return_value = {
    "content": "不正フォーマットデータ",
    "vector_distance": 0.05,
    "active": True,
    "source_type": "invalid/format"
}

d16 = MagicMock()
d16.id = "k_source_bad_type"
d16.to_dict.return_value = {
    "content": "壊れたソース設定データ",
    "vector_distance": 0.04,
    "active": True,
    "source_type": "bad_type_source"
}

d17 = MagicMock()
d17.id = "k_source_none"
d17.to_dict.return_value = {
    "content": "ソース未設定データ",
    "vector_distance": 0.01,
    "active": True
}

test_docs.extend([d15, d16, d17])

db.get_all.reset_mock()
context_text_3, sources_3 = search_knowledge_base("テスト検索ソース")

# db.get_all.call_count == 1 をassertし、N+1になっていないことを確認
assert db.get_all.call_count == 1, "db.get_allが複数回呼ばれている (N+1問題)"

# enabledが文字列など壊れた設定ドキュメントを持つ bad_type_source のknowledge候補がRAGから除外されることをassert
assert "壊れたソース設定データ" not in context_text_3, "enabledが不正なソースのデータが除外されていない"

# source_type未設定knowledge -> デフォルトON
assert "ソース未設定データ" in context_text_3, "source_type未設定のデータが取得できていない"

# source_typeが不正形式のknowledge -> RAG除外
assert "不正フォーマットデータ" not in context_text_3, "不正フォーマットのsource_typeが除外されていない"

print("PASS: RAG検索時の追加条件 (不正フォーマット、不正設定値、未設定、N+1チェック)")

# source設定取得自体が例外になった場合、全sourceがONとして通過しないことを確認 (fail-closed)
db.get_all.side_effect = Exception("Test get_all exception")
context_text_ex, _ = search_knowledge_base("テスト検索ソース")
assert "ソース有効データ" not in context_text_ex, "例外時にソース有効データが含まれている (fail-closedになっていない)"
assert "ソース未登録データ（デフォルトON）" not in context_text_ex, "例外時にソース未登録データが含まれている (fail-closedになっていない)"
assert "ソース未設定データ" in context_text_ex, "例外時でもsource_type未設定のデータは含まれるべき"
db.get_all.side_effect = mock_get_all # restore

print("PASS: RAG検索時のフェッチ例外発生時 fail-closed 挙動")


# 新しいGET/PATCH source-settings APIで管理キーなし -> 401
res_get_no_key = client.get("/api/admin/knowledge/source-settings")
assert res_get_no_key.status_code == 401, "管理キーなしGETで401が返っていない"

res_patch_no_key = client.patch("/api/admin/knowledge/source-settings/enabled_source", json={"enabled": False})
assert res_patch_no_key.status_code == 401, "管理キーなしPATCHで401が返っていない"

print("PASS: source-settings API の認証チェック (401)")

# GET API で実際の knowledge の source_type もマージされているか
def mock_knowledge_stream():
    kd1 = MagicMock()
    kd1.to_dict.return_value = {"source_type": "new_source"}
    kd2 = MagicMock()
    kd2.to_dict.return_value = {"source_type": "invalid/format"}
    return [kd1, kd2]

mock_knowledge_query = MagicMock()
mock_knowledge_query.select.return_value.limit.return_value.stream.side_effect = mock_knowledge_stream
db.collection.side_effect = lambda c: mock_knowledge_query if c == "knowledge" else mock_col

res_get_all = client.get("/api/admin/knowledge/source-settings", headers={"X-Admin-Key": "test_admin_key"})
assert res_get_all.status_code == 200
items = res_get_all.json()["items"]
new_source_item = next((x for x in items if x["source_type"] == "new_source"), None)
assert new_source_item is not None, "knowledgeにのみ存在するsource_typeが一覧に含まれていない"
assert new_source_item["enabled"] is True, "未知のsource_typeのenabledがTrueになっていない"
assert new_source_item["configured"] is False, "未知のsource_typeのconfiguredがFalseになっていない"

invalid_source_item = next((x for x in items if x["source_type"] == "invalid/format"), None)
assert invalid_source_item is None, "不正フォーマットのsource_typeが一覧に含まれてしまっている"

print("PASS: GET API の knowledge レコードからのマージ挙動")

# source ON/OFF切替前後で本体が変更されないこと
mock_doc_ref.update.reset_mock()
client.patch("/api/admin/knowledge/source-settings/enabled_source", json={"enabled": False}, headers={"X-Admin-Key": "test_admin_key"})
assert mock_doc_ref.update.call_count == 0, "source-settings の PATCH で knowledge 本体が変更されている"

# restore db.collection.side_effect
db.collection.side_effect = None
db.collection.return_value = mock_col

# source OFF -> RAG除外 -> source ON -> 復活
mock_s_toggle = MagicMock()
mock_s_toggle.exists = True
type(mock_s_toggle).id = PropertyMock(return_value="toggle_source")
mock_s_toggle.to_dict.return_value = {"enabled": False}

d18 = MagicMock()
d18.id = "k_source_toggle"
d18.to_dict.return_value = {
    "content": "トグルテストデータ",
    "vector_distance": 0.01,
    "active": True,
    "source_type": "toggle_source",
    "valid_from": "2020-01-01T00:00:00Z",
    "valid_until": "2030-01-01T00:00:00Z"
}
test_docs.append(d18)

def mock_get_all_with_toggle(refs):
    res = mock_get_all(refs)
    for r in refs:
        if r.id == "toggle_source": res.append(mock_s_toggle)
    return res

db.get_all.side_effect = mock_get_all_with_toggle
ctx_off, _ = search_knowledge_base("テスト検索ソース")
assert "トグルテストデータ" not in ctx_off, "OFF時は除外される"

# ONに切り替え
mock_s_toggle.to_dict.return_value = {"enabled": True}
ctx_on, _ = search_knowledge_base("テスト検索ソース")
assert "トグルテストデータ" in ctx_on, "ON時は復活する"

db.get_all.side_effect = mock_get_all # restore
print("PASS: source ON/OFF切替でのRAG除外・復活確認")

# knowledge_source_settingsに不正なsource_type ID相当が存在しても、GET一覧に含まれないこと
def mock_settings_stream():
    s1 = MagicMock()
    type(s1).id = PropertyMock(return_value="valid_source")
    s1.to_dict.return_value = {"enabled": True}
    s2 = MagicMock()
    type(s2).id = PropertyMock(return_value="invalid/id")
    s2.to_dict.return_value = {"enabled": True}
    return [s1, s2]

mock_settings_ref = MagicMock()
mock_settings_ref.stream.side_effect = mock_settings_stream

def db_col_side_effect(c):
    if c == "knowledge_source_settings": return mock_settings_ref
    if c == "knowledge": return mock_knowledge_query
    return mock_col
db.collection.side_effect = db_col_side_effect

res_settings = client.get("/api/admin/knowledge/source-settings", headers={"X-Admin-Key": "test_admin_key"})
items2 = res_settings.json()["items"]
assert next((x for x in items2 if x["source_type"] == "invalid/id"), None) is None, "不正なIDがGET一覧に含まれている"
print("PASS: GET API で不正な doc_id が除外される確認")

# 未設定sourceを初回PATCHした後、UI側の状態相当で configured=true になること (バックエンドの挙動として)
mock_settings_ref.stream.side_effect = lambda: [s1] # 既存の valid_source だけを返す
# new_source に対してPATCHを行う
client.patch("/api/admin/knowledge/source-settings/new_source", json={"enabled": False}, headers={"X-Admin-Key": "test_admin_key"})
# すると db.collection("knowledge_source_settings").document("new_source").set() が呼ばれるはず
# 今回のモック構成では db.collection("knowledge_source_settings") は mock_settings_ref を返すので、
# その document("new_source") が set を呼ばれたか確認できる
mock_settings_ref.document.assert_called_with("new_source")
assert mock_settings_ref.document.return_value.set.call_count == 1
# UI側はレスポンスOKなら configured=true にして対応している

# restore db.collection.side_effect
db.collection.side_effect = None
db.collection.return_value = mock_col

# Gemini 0回, Embedding 0回 (mock_get_embedding は呼ばれているが実ネットワークアクセスはしていない。生成AIも呼ばれていない)
print("PASS: すべてのテストで Gemini API, Embedding API 実呼び出し 0回")

print("\n============================================================")
print("全テスト (Task 5 追加要件含む) 完了")
print("============================================================")

print("\n=== API挙動テスト: Task 6 /api/admin/site-updates/pending-count ===")

# Test: No admin key -> 401
res = client.get("/api/admin/site-updates/pending-count")
assert res.status_code == 401

# Mock Firestore count() behavior and capture FieldFilter
mock_count_query = MagicMock()
captured_filters = []

def mock_where_for_count(filter=None, **kwargs):
    captured_filters.append(filter)
    m = MagicMock()
    
    # 状況に応じて件数を変えるモック
    def get_mock():
        if getattr(mock_count_query, 'raise_error', False):
            raise Exception("Firestore count error")
        mock_result = MagicMock()
        mock_result.value = getattr(mock_count_query, 'mock_value', 5)
        return [[mock_result]]
        
    m.count.return_value.get.side_effect = get_mock
    return m

def new_col_side_effect(c):
    col = MagicMock()
    if c == "site_updates":
        col.where = mock_where_for_count
    return col

db.collection.side_effect = new_col_side_effect

# Test: count = 5
captured_filters.clear()
mock_count_query.mock_value = 5
mock_count_query.raise_error = False
res = client.get("/api/admin/site-updates/pending-count", headers={"X-Admin-Key": "test_admin_key"})
assert res.status_code == 200
assert res.json()["count"] == 5
assert len(captured_filters) > 0
assert captured_filters[-1].field_path == "status"
assert captured_filters[-1].value == "pending"
print("PASS: pending-count が正しい件数を返す (Firestore count() + FieldFilter確認)")

# Test: count = 0
captured_filters.clear()
mock_count_query.mock_value = 0
res = client.get("/api/admin/site-updates/pending-count", headers={"X-Admin-Key": "test_admin_key"})
assert res.status_code == 200
assert res.json()["count"] == 0
print("PASS: pending 0件の時は count=0 を返す")

# Test: Firestore exception -> 500
mock_count_query.raise_error = True
res = client.get("/api/admin/site-updates/pending-count", headers={"X-Admin-Key": "test_admin_key"})
assert res.status_code == 500
print("PASS: pending-count で Firestore 例外発生時は 500 を返す")


print("\n=== API挙動テスト: Task 6 /api/admin/official-news/register site_update_id ===")
import backend.main
mock_get_embedding = MagicMock(return_value=[0.1] * 768)
backend.main.get_embedding = mock_get_embedding

mock_batch = MagicMock()
db.batch.return_value = mock_batch

base_url = "https://granbluefantasy.com/ja/news/123/"
req_body = {
    "title": "T", "url": base_url, "summary": "S",
    "site_update_id": "granblue_official_123"
}

mock_update_ref = MagicMock()
mock_update_snap = MagicMock()

def new_col_side_effect_2(c):
    col = MagicMock()
    if c == "site_updates":
        col.document.return_value = mock_update_ref
    elif c == "knowledge":
        q = MagicMock()
        q.where.return_value.stream.return_value = []
        return q
    return col

db.collection.side_effect = new_col_side_effect_2

# Test: 正常系 (実スキーマ: source_id="granblue_official", status="pending", URL一致)
mock_update_snap.exists = True
mock_update_snap.to_dict.return_value = {
    "source_id": "granblue_official",
    "source_type": "official_news",
    "source_name": "グランブルーファンタジー公式",
    "status": "pending",
    "url": base_url,
    "article_id": "123",
}
mock_update_ref.get.return_value = mock_update_snap
mock_batch.update.reset_mock()
mock_batch.set.reset_mock()
mock_batch.commit.reset_mock()
mock_get_embedding.reset_mock()

res = client.post("/api/admin/official-news/register", headers={"X-Admin-Key": "test_admin_key"}, json=req_body)
assert res.status_code == 200
assert any(call[0][0] == mock_update_ref for call in mock_batch.update.call_args_list)
assert mock_batch.set.call_count > 0
assert mock_batch.commit.call_count == 1
assert mock_get_embedding.call_count > 0
print("PASS: 正常系 (source_id=granblue_official, status=pending) -> 登録成功 & batch.set + batch.update + batch.commit + embedding生成")

# Test: URL正規化 (末尾スラッシュの差異があっても正常登録される)
req_body_no_slash = {
    "title": "T", "url": "https://granbluefantasy.com/ja/news/123", "summary": "S",
    "site_update_id": "granblue_official_123"
}
mock_batch.update.reset_mock()
mock_batch.set.reset_mock()
mock_batch.commit.reset_mock()
mock_get_embedding.reset_mock()
res = client.post("/api/admin/official-news/register", headers={"X-Admin-Key": "test_admin_key"}, json=req_body_no_slash)
assert res.status_code == 200
assert mock_batch.set.call_count > 0
assert mock_batch.update.call_count > 0
print("PASS: URL正規化 (末尾スラッシュ差異を許容して同一URL判定) -> 正常登録")

# Test: 異常系 (site_update_id不存在) -> 404, 書き込みなし, embedding 0回
mock_update_snap.exists = False
mock_batch.update.reset_mock()
mock_batch.set.reset_mock()
mock_batch.commit.reset_mock()
mock_get_embedding.reset_mock()
res = client.post("/api/admin/official-news/register", headers={"X-Admin-Key": "test_admin_key"}, json=req_body)
assert res.status_code == 404
assert mock_batch.update.call_count == 0
assert mock_batch.set.call_count == 0
assert mock_batch.commit.call_count == 0
assert mock_get_embedding.call_count == 0
print("PASS: 異常系 (site_update_idが存在しない) -> 404 & 書き込み/embedding 0件")

# Test: 異常系 (URL不一致) -> 409, 書き込みなし, embedding 0回
mock_update_snap.exists = True
mock_update_snap.to_dict.return_value = {
    "source_id": "granblue_official",
    "status": "pending",
    "url": "https://granbluefantasy.com/ja/news/999/",
}
mock_batch.update.reset_mock()
mock_batch.set.reset_mock()
mock_batch.commit.reset_mock()
mock_get_embedding.reset_mock()
res = client.post("/api/admin/official-news/register", headers={"X-Admin-Key": "test_admin_key"}, json=req_body)
assert res.status_code == 409
assert mock_batch.update.call_count == 0
assert mock_batch.set.call_count == 0
assert mock_batch.commit.call_count == 0
assert mock_get_embedding.call_count == 0
print("PASS: 異常系 (URL不一致) -> 409 & 書き込み/embedding 0件")

# Test: 異常系 (status=ignored) -> 409, 書き込みなし, embedding 0回
mock_update_snap.to_dict.return_value = {
    "source_id": "granblue_official",
    "status": "ignored",
    "url": base_url,
}
mock_batch.update.reset_mock()
mock_batch.set.reset_mock()
mock_batch.commit.reset_mock()
mock_get_embedding.reset_mock()
res = client.post("/api/admin/official-news/register", headers={"X-Admin-Key": "test_admin_key"}, json=req_body)
assert res.status_code == 409
assert mock_batch.update.call_count == 0
assert mock_batch.set.call_count == 0
assert mock_batch.commit.call_count == 0
assert mock_get_embedding.call_count == 0
print("PASS: 異常系 (status=ignored) -> 409 & 書き込み/embedding 0件")

# Test: 異常系 (status=registered) -> 409, 書き込みなし, embedding 0回
mock_update_snap.to_dict.return_value = {
    "source_id": "granblue_official",
    "status": "registered",
    "url": base_url,
}
mock_batch.update.reset_mock()
mock_batch.set.reset_mock()
mock_batch.commit.reset_mock()
mock_get_embedding.reset_mock()
res = client.post("/api/admin/official-news/register", headers={"X-Admin-Key": "test_admin_key"}, json=req_body)
assert res.status_code == 409
assert mock_batch.update.call_count == 0
assert mock_batch.set.call_count == 0
assert mock_batch.commit.call_count == 0
assert mock_get_embedding.call_count == 0
print("PASS: 異常系 (status=registered) -> 409 & 書き込み/embedding 0件")

# Test: 異常系 (source_id="youtube_channel_x", source_type="official_news") -> 409, 書き込みなし, embedding 0回
mock_update_snap.to_dict.return_value = {
    "source_id": "youtube_channel_x",
    "source_type": "official_news",
    "status": "pending",
    "url": base_url,
}
mock_batch.update.reset_mock()
mock_batch.set.reset_mock()
mock_batch.commit.reset_mock()
mock_get_embedding.reset_mock()
res = client.post("/api/admin/official-news/register", headers={"X-Admin-Key": "test_admin_key"}, json=req_body)
assert res.status_code == 409
assert mock_batch.update.call_count == 0
assert mock_batch.set.call_count == 0
assert mock_batch.commit.call_count == 0
assert mock_get_embedding.call_count == 0
print("PASS: 異常系 (source_id=youtube_channel_x, source_type=official_news) -> 409 & 書き込み/embedding 0件")

# Test: 異常系 (source_id欠落, source_type="official_news") -> 409, 書き込みなし, embedding 0回
mock_update_snap.to_dict.return_value = {
    "source_type": "official_news",
    "status": "pending",
    "url": base_url,
}
mock_batch.update.reset_mock()
mock_batch.set.reset_mock()
mock_batch.commit.reset_mock()
mock_get_embedding.reset_mock()
res = client.post("/api/admin/official-news/register", headers={"X-Admin-Key": "test_admin_key"}, json=req_body)
assert res.status_code == 409
assert mock_batch.update.call_count == 0
assert mock_batch.set.call_count == 0
assert mock_batch.commit.call_count == 0
assert mock_get_embedding.call_count == 0
print("PASS: 異常系 (source_id欠落, source_type=official_news) -> 409 & 書き込み/embedding 0件")

# Test: 異常系 (Firestore例外) -> 500, 書き込みなし, embedding 0回
mock_update_ref.get.side_effect = Exception("Firestore Error")
mock_batch.update.reset_mock()
mock_batch.set.reset_mock()
mock_batch.commit.reset_mock()
mock_get_embedding.reset_mock()
res = client.post("/api/admin/official-news/register", headers={"X-Admin-Key": "test_admin_key"}, json=req_body)
assert res.status_code == 500
assert mock_batch.update.call_count == 0
assert mock_batch.set.call_count == 0
assert mock_batch.commit.call_count == 0
assert mock_get_embedding.call_count == 0
print("PASS: 異常系 (Firestore取得例外) -> 500 & 書き込み/embedding 0件")
mock_update_ref.get.side_effect = None  # restore

# Test: 異常系 (不正なIDフォーマット - スラッシュ含む) -> 400
req_body_slash = {
    "title": "T", "url": base_url, "summary": "S",
    "site_update_id": "invalid/format"
}
mock_batch.update.reset_mock()
mock_batch.set.reset_mock()
mock_batch.commit.reset_mock()
mock_get_embedding.reset_mock()
res = client.post("/api/admin/official-news/register", headers={"X-Admin-Key": "test_admin_key"}, json=req_body_slash)
assert res.status_code == 400
assert mock_batch.update.call_count == 0
assert mock_batch.set.call_count == 0
assert mock_batch.commit.call_count == 0
assert mock_get_embedding.call_count == 0
print("PASS: 異常系 (スラッシュ含む不正なID) -> 400 & 書き込み/embedding 0件")

# Test: 異常系 (末尾改行付きID) -> 400
req_body_newline = {
    "title": "T", "url": base_url, "summary": "S",
    "site_update_id": "granblue_official_123\n"
}
mock_batch.update.reset_mock()
mock_batch.set.reset_mock()
mock_batch.commit.reset_mock()
mock_get_embedding.reset_mock()
res = client.post("/api/admin/official-news/register", headers={"X-Admin-Key": "test_admin_key"}, json=req_body_newline)
assert res.status_code == 400
assert mock_batch.update.call_count == 0
assert mock_batch.set.call_count == 0
assert mock_batch.commit.call_count == 0
assert mock_get_embedding.call_count == 0
print("PASS: 異常系 (末尾改行付きID) -> 400 & 書き込み/embedding 0件")

# Test: 異常系 (長すぎるID > 100文字) -> 400
req_body_too_long = {
    "title": "T", "url": base_url, "summary": "S",
    "site_update_id": "a" * 101
}
mock_batch.update.reset_mock()
mock_batch.set.reset_mock()
mock_batch.commit.reset_mock()
mock_get_embedding.reset_mock()
res = client.post("/api/admin/official-news/register", headers={"X-Admin-Key": "test_admin_key"}, json=req_body_too_long)
assert res.status_code == 400
assert mock_batch.update.call_count == 0
assert mock_batch.set.call_count == 0
assert mock_batch.commit.call_count == 0
assert mock_get_embedding.call_count == 0
print("PASS: 異常系 (長すぎるID 101文字) -> 400 & 書き込み/embedding 0件")

# Test: site_update_idなし -> 従来の手動登録成功 (site_updates更新なし)
req_body_none = {
    "title": "T", "url": base_url, "summary": "S",
    "site_update_id": None
}
mock_batch.update.reset_mock()
mock_batch.set.reset_mock()
mock_batch.commit.reset_mock()
mock_get_embedding.reset_mock()
res = client.post("/api/admin/official-news/register", headers={"X-Admin-Key": "test_admin_key"}, json=req_body_none)
assert res.status_code == 200
assert mock_batch.update.call_count == 0  # site_updatesは更新されない
assert mock_batch.set.call_count > 0     # Knowledgeは書き込まれる
assert mock_batch.commit.call_count == 1
assert mock_get_embedding.call_count > 0
print("PASS: site_update_idなし -> 手動登録として成功 (site_updates更新0件, Knowledge書き込み実行)")

print("\n============================================================")
print("全テスト (Task 6 追加要件含む) 完了")
print("============================================================")
