import os
os.environ["GEMINI_API_KEY"] = "test"
os.environ["ADMIN_API_KEY"] = "test-admin-key"

import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock

import google.cloud.firestore
import google.genai
google.cloud.firestore.Client = MagicMock()
google.genai.Client = MagicMock()

from backend.main import (
    app,
    db,
    client as genai_client,
    get_daily_site_updates,
    classify_site_update_source,
    format_datetime_for_json,
    MAX_DAILY_SUMMARY_ITEMS,
    DAILY_SUMMARY_PAGE_SIZE,
    MAX_DAILY_SUMMARY_PAGES,
)
from google.cloud.firestore import FieldFilter, Query
from datetime import datetime, timezone, timedelta

client = TestClient(app)
JST = timezone(timedelta(hours=9))


def test_daily_summary_unauthorized():
    response = client.get("/api/admin/daily-summary")
    assert response.status_code == 401


def test_classify_site_update_source():
    # 公式
    assert classify_site_update_source({"source_id": "granblue_official"}) == "official"
    assert classify_site_update_source({"source_type": "official_news"}) == "official"
    
    # YouTube
    assert classify_site_update_source({"source_type": "youtube_creator"}) == "youtube"
    assert classify_site_update_source({"source_id": "youtube_ucbc7w818zospu6otxsrenow"}) == "youtube"
    
    # その他
    assert classify_site_update_source({"source_id": "other_site", "source_type": "blog"}) == "other"
    assert classify_site_update_source({}) == "other"


def test_format_datetime_for_json():
    assert format_datetime_for_json(None) is None
    assert format_datetime_for_json("2026-09-01T12:00:00") == "2026-09-01T12:00:00"
    
    dt = datetime(2026, 9, 1, 12, 0, tzinfo=JST)
    assert format_datetime_for_json(dt) == "2026-09-01T12:00:00+09:00"


@patch("backend.main.db")
@patch("backend.main.get_embedding")
def test_daily_summary_query_construction_and_jst_bounds(mock_get_embedding, mock_db):
    """
    JST固定日での境界値（00:00:00 JST <= detected_at < 翌日00:00:00 JST）および
    order_by, limit, scan_complete, Gemini/Embedding 0回を検証
    """
    mock_collection = MagicMock()
    mock_where1 = MagicMock()
    mock_where2 = MagicMock()
    mock_order = MagicMock()
    mock_limit = MagicMock()

    mock_db.collection.return_value = mock_collection
    mock_collection.where.return_value = mock_where1
    mock_where1.where.return_value = mock_where2
    mock_where2.order_by.return_value = mock_order
    mock_order.limit.return_value = mock_limit
    mock_limit.stream.return_value = []

    mock_generate = MagicMock()
    genai_client.models.generate_content = mock_generate

    fixed_now = datetime(2026, 9, 1, 15, 30, 0, tzinfo=JST)
    
    res = get_daily_site_updates(now=fixed_now)
    assert res["summary_date"] == "2026-09-01"
    assert res["timezone"] == "Asia/Tokyo"
    assert res["total_count"] == 0
    assert res["truncated"] is False
    assert res["scan_complete"] is True

    # コレクション名確認
    mock_db.collection.assert_called_with("site_updates")

    # 1つ目の where (detected_at >= 今日 00:00 JST)
    where1_args, where1_kwargs = mock_collection.where.call_args
    f1 = where1_kwargs.get("filter")
    assert f1.field_path == "detected_at"
    assert f1.op_string == ">="
    assert f1.value == datetime(2026, 9, 1, 0, 0, 0, tzinfo=JST)

    # 2つ目の where (detected_at < 翌日 00:00 JST)
    where2_args, where2_kwargs = mock_where1.where.call_args
    f2 = where2_kwargs.get("filter")
    assert f2.field_path == "detected_at"
    assert f2.op_string == "<"
    assert f2.value == datetime(2026, 9, 2, 0, 0, 0, tzinfo=JST)

    # order_by("detected_at", direction=DESCENDING)
    mock_where2.order_by.assert_called_with("detected_at", direction=Query.DESCENDING)

    # limit(100) (ページサイズ)
    mock_order.limit.assert_called_with(DAILY_SUMMARY_PAGE_SIZE)

    # Embedding / Gemini生成 0回確認
    assert mock_get_embedding.call_count == 0
    mock_generate.assert_not_called()


@patch("backend.main.db")
@patch("backend.main.get_embedding")
def test_daily_summary_success_and_allowlist(mock_get_embedding, mock_db):
    """
    ステータス除外、内部秘密フィールド除外(allowlist)、published_at日時型変換、Gemini/Embedding0回、scan_complete=True
    """
    mock_query = MagicMock()
    mock_db.collection.return_value.where.return_value.where.return_value.order_by.return_value.limit.return_value = mock_query

    mock_generate = MagicMock()
    genai_client.models.generate_content = mock_generate

    fixed_now = datetime(2026, 9, 1, 12, 0, tzinfo=JST)

    # 1. 公式 (pending) + 内部秘密フィールド
    doc1 = MagicMock()
    doc1.id = "granblue_official_999"
    doc1.to_dict.return_value = {
        "status": "pending",
        "title": "グラブル公式更新",
        "url": "https://granbluefantasy.com/ja/news/999",
        "source_id": "granblue_official",
        "source_type": "official_news",
        "source_name": "グランブルーファンタジー公式",
        "detected_at": fixed_now - timedelta(hours=1),
        "published_at": datetime(2026, 9, 1, 11, 0, tzinfo=JST), # datetimeオブジェクト
        # 内部秘密・余計なフィールド
        "body": "極秘本文",
        "embedding": [0.1, 0.2, 0.3],
        "internal_token": "secret_12345",
    }

    # 2. YouTube (registered)
    doc2 = MagicMock()
    doc2.id = "youtube_abc_1"
    doc2.to_dict.return_value = {
        "status": "registered",
        "title": "YouTube解説動画",
        "url": "https://www.youtube.com/watch?v=abc",
        "source_id": "youtube_ucbc7w818zospu6otxsrenow",
        "source_type": "youtube_creator",
        "source_name": "YouTubeチャンネル",
        "detected_at": fixed_now - timedelta(hours=2),
        "published_at": "2026-09-01T10:00:00",
    }

    # 3. その他ソース (ignored)
    doc3 = MagicMock()
    doc3.id = "other_1"
    doc3.to_dict.return_value = {
        "status": "ignored",
        "title": "攻略ブログ更新",
        "url": "https://example.com/blog",
        "source_id": "blog_site",
        "source_type": "blog",
        "source_name": "攻略ブログ",
        "detected_at": fixed_now - timedelta(hours=3),
    }

    # 4. seeded (除外対象)
    doc4 = MagicMock()
    doc4.id = "seeded_doc"
    doc4.to_dict.return_value = {
        "status": "seeded",
        "title": "初期シードデータ",
        "detected_at": fixed_now,
    }

    # 5. 未知ステータス (除外対象)
    doc5 = MagicMock()
    doc5.id = "unknown_doc"
    doc5.to_dict.return_value = {
        "status": "custom_reviewing",
        "title": "未知ステータスデータ",
        "detected_at": fixed_now,
    }

    mock_query.stream.return_value = [doc1, doc2, doc3, doc4, doc5]

    response = client.get(
        "/api/admin/daily-summary",
        headers={"X-Admin-Key": "test-admin-key"}
    )
    
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["total_count"] == 3  # pending, registered, ignored のみ
    assert data["truncated"] is False
    assert data["scan_complete"] is True

    counts = data["counts"]
    assert counts["pending"] == 1
    assert counts["registered"] == 1
    assert counts["ignored"] == 1
    assert counts["official"] == 1
    assert counts["youtube"] == 1

    items = data["items"]
    assert len(items) == 3
    
    # 厳格な allowlist 検証 (内部秘密フィールドが含まれていないこと)
    allowed_keys = {
        "site_update_id", "title", "url", "source_id",
        "source_type", "source_name", "status", "detected_at", "published_at"
    }
    for item in items:
        assert set(item.keys()) == allowed_keys
        assert "body" not in item
        assert "embedding" not in item
        assert "internal_token" not in item

    # published_at が ISO文字列化されていること
    assert items[0]["published_at"] == "2026-09-01T11:00:00+09:00"
    assert items[1]["published_at"] == "2026-09-01T10:00:00"
    assert items[2]["published_at"] == ""

    # Gemini/Embedding 0回検証
    assert mock_get_embedding.call_count == 0
    mock_generate.assert_not_called()


@patch("backend.main.db")
def test_daily_summary_pagination_recovers_valid_statuses_after_seeded(mock_db):
    """
    1ページ目に seeded や 未知status が大量に存在しても、
    cursor ページングによって2ページ目の有効ステータス(pending)を漏らさず取得できること
    """
    mock_collection = MagicMock()
    mock_where1 = MagicMock()
    mock_where2 = MagicMock()
    mock_order = MagicMock()
    mock_start_after = MagicMock()
    mock_limit1 = MagicMock()
    mock_limit2 = MagicMock()

    mock_db.collection.return_value = mock_collection
    mock_collection.where.return_value = mock_where1
    mock_where1.where.return_value = mock_where2
    mock_where2.order_by.return_value = mock_order

    # 1ページ目 (100件の seeded / unknown)
    page1_docs = []
    fixed_now = datetime(2026, 9, 1, 12, 0, tzinfo=JST)
    for i in range(DAILY_SUMMARY_PAGE_SIZE):
        d = MagicMock()
        d.id = f"seeded_{i}"
        d.to_dict.return_value = {
            "status": "seeded" if i % 2 == 0 else "unknown_x",
            "title": f"シード記事 {i}",
            "detected_at": fixed_now - timedelta(minutes=i),
        }
        page1_docs.append(d)

    # 2ページ目 (5件の pending)
    page2_docs = []
    for j in range(5):
        d = MagicMock()
        d.id = f"pending_doc_{j}"
        d.to_dict.return_value = {
            "status": "pending",
            "title": f"新着記事 {j}",
            "url": f"https://granbluefantasy.com/ja/news/{j}",
            "source_id": "granblue_official",
            "source_type": "official_news",
            "detected_at": fixed_now - timedelta(minutes=100 + j),
        }
        page2_docs.append(d)

    mock_order.limit.return_value = mock_limit1
    mock_limit1.stream.return_value = page1_docs

    mock_order.start_after.return_value = mock_start_after
    mock_start_after.limit.return_value = mock_limit2
    mock_limit2.stream.return_value = page2_docs

    res = get_daily_site_updates(now=fixed_now)

    assert res["total_count"] == 5
    assert res["truncated"] is False
    assert res["scan_complete"] is True
    assert len(res["items"]) == 5
    assert res["counts"]["pending"] == 5
    assert res["counts"]["official"] == 5

    # ページングが start_after(page1_docs[-1]) で呼ばれたことを確認
    mock_order.start_after.assert_called_once_with(page1_docs[-1])


@patch("backend.main.db")
def test_daily_summary_truncation_exact_200_and_201(mock_db):
    """
    有効statusがちょうど200件 -> truncated=False, scan_complete=True
    有効statusが201件 -> truncated=True, items=200件, scan_complete=True
    """
    fixed_now = datetime(2026, 9, 1, 12, 0, tzinfo=JST)

    # Case 1: ちょうど 200件
    mock_order = mock_db.collection.return_value.where.return_value.where.return_value.order_by.return_value
    mock_start_after = MagicMock()
    mock_order.start_after.return_value = mock_start_after

    docs_200 = []
    for i in range(200):
        d = MagicMock()
        d.id = f"doc_{i}"
        d.to_dict.return_value = {
            "status": "pending",
            "title": f"記事 {i}",
            "url": f"https://example.com/{i}",
            "source_id": "granblue_official",
            "source_type": "official_news",
            "detected_at": fixed_now - timedelta(minutes=i),
        }
        docs_200.append(d)

    mock_limit_p1 = MagicMock()
    mock_limit_p2 = MagicMock()
    mock_limit_p3 = MagicMock()

    mock_order.limit.return_value = mock_limit_p1
    mock_limit_p1.stream.return_value = docs_200[:100]

    mock_start_after.limit.side_effect = [mock_limit_p2, mock_limit_p3]
    mock_limit_p2.stream.return_value = docs_200[100:200]
    mock_limit_p3.stream.return_value = []

    res_200 = get_daily_site_updates(now=fixed_now)
    assert res_200["total_count"] == 200
    assert res_200["truncated"] is False
    assert res_200["scan_complete"] is True
    assert len(res_200["items"]) == 200

    # Case 2: 201件
    docs_201 = docs_200.copy()
    d_201 = MagicMock()
    d_201.id = "doc_201"
    d_201.to_dict.return_value = {
        "status": "pending",
        "title": "記事 201",
        "url": "https://example.com/201",
        "source_id": "granblue_official",
        "source_type": "official_news",
        "detected_at": fixed_now - timedelta(minutes=201),
    }
    docs_201.append(d_201)

    mock_start_after.limit.side_effect = [mock_limit_p2, mock_limit_p3]
    mock_limit_p1.stream.return_value = docs_201[:100]
    mock_limit_p2.stream.return_value = docs_201[100:200]
    mock_limit_p3.stream.return_value = [d_201]

    res_201 = get_daily_site_updates(now=fixed_now)
    assert res_201["total_count"] == 200  # 返却表示件数は最大200件
    assert res_201["truncated"] is True
    assert res_201["scan_complete"] is True
    assert len(res_201["items"]) == 200


@patch("backend.main.db")
def test_daily_summary_scan_complete_false_on_10_full_pages(mock_db):
    """
    10ページすべて100件フルで、全部 seeded (有効0件) の場合:
      total_count == 0, truncated == False, scan_complete == False
    """
    mock_order = mock_db.collection.return_value.where.return_value.where.return_value.order_by.return_value
    mock_start_after = MagicMock()
    mock_order.start_after.return_value = mock_start_after

    fixed_now = datetime(2026, 9, 1, 12, 0, tzinfo=JST)

    # 10ページ分 (各100件) の seeded モックデータ
    page_limits = []
    for p in range(MAX_DAILY_SUMMARY_PAGES):
        p_docs = []
        for i in range(DAILY_SUMMARY_PAGE_SIZE):
            d = MagicMock()
            d.id = f"seeded_{p}_{i}"
            d.to_dict.return_value = {
                "status": "seeded",
                "title": f"シード {p}_{i}",
                "detected_at": fixed_now - timedelta(minutes=p * 100 + i),
            }
            p_docs.append(d)
        lim = MagicMock()
        lim.stream.return_value = p_docs
        page_limits.append(lim)

    mock_order.limit.return_value = page_limits[0]
    mock_start_after.limit.side_effect = page_limits[1:]

    res = get_daily_site_updates(now=fixed_now)
    assert res["total_count"] == 0
    assert res["truncated"] is False
    assert res["scan_complete"] is False


@patch("backend.main.db")
def test_daily_summary_scan_complete_true_on_10th_page_under_limit(mock_db):
    """
    10ページ目まで探索したが、10ページ目が99件以下で当日全件読み切った場合:
      scan_complete == True
    """
    mock_order = mock_db.collection.return_value.where.return_value.where.return_value.order_by.return_value
    mock_start_after = MagicMock()
    mock_order.start_after.return_value = mock_start_after

    fixed_now = datetime(2026, 9, 1, 12, 0, tzinfo=JST)

    page_limits = []
    # 1〜9ページ目は100件
    for p in range(MAX_DAILY_SUMMARY_PAGES - 1):
        p_docs = []
        for i in range(DAILY_SUMMARY_PAGE_SIZE):
            d = MagicMock()
            d.id = f"seeded_{p}_{i}"
            d.to_dict.return_value = {
                "status": "seeded",
                "title": f"シード {p}_{i}",
                "detected_at": fixed_now - timedelta(minutes=p * 100 + i),
            }
            p_docs.append(d)
        lim = MagicMock()
        lim.stream.return_value = p_docs
        page_limits.append(lim)

    # 10ページ目は99件 (読み切り)
    p10_docs = []
    for i in range(99):
        d = MagicMock()
        d.id = f"seeded_9_{i}"
        d.to_dict.return_value = {
            "status": "seeded",
            "title": f"シード 9_{i}",
            "detected_at": fixed_now - timedelta(minutes=900 + i),
        }
        p10_docs.append(d)
    lim10 = MagicMock()
    lim10.stream.return_value = p10_docs
    page_limits.append(lim10)

    mock_order.limit.return_value = page_limits[0]
    mock_start_after.limit.side_effect = page_limits[1:]

    res = get_daily_site_updates(now=fixed_now)
    assert res["total_count"] == 0
    assert res["truncated"] is False
    assert res["scan_complete"] is True


@patch("backend.main.get_daily_site_updates")
def test_daily_summary_internal_error(mock_get):
    mock_get.side_effect = Exception("db error")
    response = client.get(
        "/api/admin/daily-summary",
        headers={"X-Admin-Key": "test-admin-key"}
    )
    assert response.status_code == 500
    assert "今日のまとめの取得に失敗しました" in response.json()["detail"]
