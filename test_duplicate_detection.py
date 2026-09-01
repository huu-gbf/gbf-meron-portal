"""
Task 8: 重複情報検出機能のテスト (Review指摘反映版)
test_duplicate_detection.py

検証項目:
1. 正規化アルゴリズム (normalize_duplicate_text & normalize_duplicate_source_url)
   - Unicode NFKC (全角/半角)
   - 複数空白/タブ/改行の単一スペース統一
   - 英字 casefold (大文字小文字差)
   - 記号保持 (+10% vs -10%)
   - 数字保持 (100% vs 200%)
   - URL正規化: scheme/host小文字化, 末尾スラッシュ除去, query (特に v=VIDEO_ID) 保持, fragment除外
2. ハッシュ計算 (calculate_duplicate_hash_v1)
3. 重複検出 & 登録API (POST /api/admin/official-news/register, POST /api/admin/youtube/register)
   - 管理キーなし -> 401
   - 同一URL + 同一内容 -> 既存 unchanged を維持
   - 同一URL + 更新内容 -> duplicate警告ではなく既存更新処理を維持
   - 別URL + 同一summary -> 409 Conflict (duplicate: true, existing情報返却)
   - YouTube専用: 動画A (?v=AAA) vs 動画B (?v=BBB) で同一summary -> 409 Conflict
   - 同一hashで自己チャンク5件超 + その後に別URLのduplicate doc -> 正しく409 Conflictを検出
   - allow_duplicate=False 時の 409 安全性検証:
     * Gemini実呼び出し 0
     * Embedding実生成 0
     * Firestore書き込み 0 (batch.commit==0, batch.set==0, batch.update==0, batch.delete==0, site_updates更新0)
   - allow_duplicate=True 時:
     * 409をバイパスして通常登録 (saved)
   - 既存knowledge本文やembeddingが409レスポンスに漏洩しない
   - Firestore duplicate query例外 -> 500
"""

import os
os.environ["GEMINI_API_KEY"] = "test"
os.environ["ADMIN_API_KEY"] = "test-admin-key"

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import google.cloud.firestore
import google.genai
google.cloud.firestore.Client = MagicMock()
google.genai.Client = MagicMock()

import pytest
from fastapi.testclient import TestClient

# backend をパスに追加
backend_path = Path(__file__).parent / "backend"
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(backend_path))

import backend.main
from backend.main import (
    app,
    db,
    normalize_duplicate_text,
    normalize_duplicate_source_url,
    calculate_duplicate_hash_v1,
    find_duplicate_knowledge,
)

client = TestClient(app)
ADMIN_KEY = "test-admin-key"


@pytest.fixture(autouse=True)
def setup_env_and_mocks():
    """環境変数と安全用モックのセットアップ"""
    with patch.dict("os.environ", {"ADMIN_API_KEY": ADMIN_KEY, "FIRESTORE_PROJECT_ID": "test-project"}):
        with patch("backend.main.get_embedding", return_value=[0.1] * 768) as mock_embed:
            with patch("backend.main.client.models.generate_content") as mock_gemini:
                yield {
                    "embed": mock_embed,
                    "gemini": mock_gemini,
                }


# ==============================================================================
# 1. テキスト正規化 & URL正規化 & ハッシュ計算の単体テスト
# ==============================================================================

def test_normalize_duplicate_text_nfkc():
    """全角・半角のNFKC正規化"""
    text_full = "ＡＢＣ　１２３　＋１０％"
    text_half = "abc 123 +10%"
    assert normalize_duplicate_text(text_full) == text_half


def test_normalize_duplicate_text_whitespace():
    """前後空白除去、連続空白・タブ・改行の単一スペース統一"""
    raw = "  グランブルー\n\nファンタジー\t\t公式   ニュース  "
    expected = "グランブルー ファンタジー 公式 ニュース"
    assert normalize_duplicate_text(raw) == expected


def test_normalize_duplicate_text_casefold():
    """英字の大文字小文字をcasefoldで統一"""
    raw = "Granblue Fantasy Versus: Rising"
    expected = "granblue fantasy versus: rising"
    assert normalize_duplicate_text(raw) == expected


def test_normalize_symbols_preserved():
    """記号が保持され、異なる記号は別ハッシュになること"""
    text_plus = "攻撃力 +10%"
    text_minus = "攻撃力 -10%"
    norm_plus = normalize_duplicate_text(text_plus)
    norm_minus = normalize_duplicate_text(text_minus)
    assert norm_plus != norm_minus
    assert calculate_duplicate_hash_v1(text_plus) != calculate_duplicate_hash_v1(text_minus)


def test_normalize_numbers_preserved():
    """数字の差異が保持され、別ハッシュになること"""
    text_100 = "奥義ゲージ 100% UP"
    text_200 = "奥義ゲージ 200% UP"
    assert normalize_duplicate_text(text_100) != normalize_duplicate_text(text_200)
    assert calculate_duplicate_hash_v1(text_100) != calculate_duplicate_hash_v1(text_200)


def test_hash_identical_for_spacing_differences():
    """空白・改行・大文字小文字の違いのみの場合は同一ハッシュになること"""
    t1 = "Granblue Fantasy\nUpdate: +10% ATK"
    t2 = "  granblue   FANTASY\t\tupdate: +10% atk  \n"
    assert calculate_duplicate_hash_v1(t1) == calculate_duplicate_hash_v1(t2)


def test_normalize_duplicate_source_url():
    """URL比較用ヘルパー: scheme/host小文字化, 末尾スラッシュ除去, query保持, fragment除外"""
    u1 = "HTTPS://WWW.YouTube.Com/watch?v=VIDEO_AAA_123#section1"
    u2 = "https://www.youtube.com/watch?v=VIDEO_AAA_123"
    assert normalize_duplicate_source_url(u1) == "https://www.youtube.com/watch?v=VIDEO_AAA_123"
    assert normalize_duplicate_source_url(u2) == "https://www.youtube.com/watch?v=VIDEO_AAA_123"

    # 異なるvideo_idは異なるURLとして保持される
    u3 = "https://www.youtube.com/watch?v=VIDEO_BBB_123"
    assert normalize_duplicate_source_url(u1) != normalize_duplicate_source_url(u3)

    # 公式ニュースのURL正規化
    u_official1 = "https://GranBlueFantasy.jp/pages/12345/"
    u_official2 = "https://granbluefantasy.jp/pages/12345"
    assert normalize_duplicate_source_url(u_official1) == "https://granbluefantasy.jp/pages/12345"
    assert normalize_duplicate_source_url(u_official2) == "https://granbluefantasy.jp/pages/12345"


# ==============================================================================
# 2. 公式ニュース登録 重複検出テスト (POST /api/admin/official-news/register)
# ==============================================================================

def test_official_news_register_requires_admin():
    """管理キーなし -> 401"""
    res = client.post(
        "/api/admin/official-news/register",
        json={
            "title": "タイトル",
            "url": "https://granbluefantasy.com/ja/news/detail/123",
            "summary": "要約本文",
        },
    )
    assert res.status_code == 401


def test_official_news_same_url_same_content_unchanged(setup_env_and_mocks):
    """同一URL + 同一内容 -> unchanged (Task 8のduplicate警告ではなく既存unchanged)"""
    mock_doc = MagicMock()
    mock_doc.id = "official_news_test_chunk_0"
    content_hash = backend.main.calculate_official_news_hash(
        "公式タイトル",
        "https://granbluefantasy.com/ja/news/detail/123",
        "2026-09-01",
        "公式要約本文"
    )
    mock_doc.to_dict.return_value = {
        "url": "https://granbluefantasy.com/ja/news/detail/123",
        "title": "公式タイトル",
        "source_type": "official_summary",
        "content_hash": content_hash,
    }

    with patch("backend.main.get_existing_official_news_docs", return_value=[mock_doc]):
        res = client.post(
            "/api/admin/official-news/register",
            headers={"X-Admin-Key": ADMIN_KEY},
            json={
                "title": "公式タイトル",
                "url": "https://granbluefantasy.com/ja/news/detail/123",
                "published_date": "2026-09-01",
                "summary": "公式要約本文",
                "allow_duplicate": False,
            },
        )
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "unchanged"
        assert setup_env_and_mocks["embed"].call_count == 0


def test_official_news_same_url_updated_content_proceeds_update(setup_env_and_mocks):
    """同一URL + 更新内容 -> duplicate警告を出さず、更新処理(saved)へ進む"""
    mock_doc = MagicMock()
    mock_doc.id = "official_news_test_chunk_0"
    mock_doc.to_dict.return_value = {
        "url": "https://granbluefantasy.com/ja/news/detail/123",
        "title": "旧公式タイトル",
        "source_type": "official_summary",
        "content_hash": "old_hash",
        "duplicate_hash_v1": "old_dup_hash",
    }

    # db batch mock
    mock_batch = MagicMock()
    mock_collection = MagicMock()

    with patch("backend.main.get_existing_official_news_docs", return_value=[mock_doc]), \
         patch("backend.main.db.batch", return_value=mock_batch), \
         patch("backend.main.db.collection", return_value=mock_collection):
        res = client.post(
            "/api/admin/official-news/register",
            headers={"X-Admin-Key": ADMIN_KEY},
            json={
                "title": "公式タイトル",
                "url": "https://granbluefantasy.com/ja/news/detail/123",
                "published_date": "2026-09-01",
                "summary": "新しい要約本文",
                "allow_duplicate": False,
            },
        )
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "saved"
        assert mock_batch.commit.call_count == 1


def test_official_news_same_url_update_with_colliding_hash_proceeds_saved(setup_env_and_mocks):
    """
    同一URL更新テスト強化:
    既存URL A を更新する際、更新後summaryが既存別URL B のduplicate_hash_v1と完全一致していても、
    同一記事の更新であるため 409 duplicate ではなく従来の saved / 更新処理へ進むこと。
    """
    url_a = "https://granbluefantasy.com/ja/news/detail/AAA"
    url_b = "https://granbluefantasy.com/ja/news/detail/BBB"
    shared_summary = "URL Bに既に存在する共通要約テキストです。"
    dup_hash_b = calculate_duplicate_hash_v1(shared_summary)

    # 既存URL A のドキュメント (古いハッシュ)
    mock_doc_a = MagicMock()
    mock_doc_a.id = "official_news_AAA_0"
    mock_doc_a.reference = MagicMock()
    mock_doc_a.to_dict.return_value = {
        "url": url_a,
        "title": "URL A 旧タイトル",
        "source_type": "official_summary",
        "content_hash": "old_content_hash_A",
        "duplicate_hash_v1": "old_dup_hash_A",
    }

    # 既存別URL B のドキュメント (共通要約のduplicate_hash_v1を保持)
    mock_doc_b = MagicMock()
    mock_doc_b.id = "official_news_BBB_0"
    mock_doc_b.to_dict.return_value = {
        "url": url_b,
        "title": "URL B タイトル",
        "source_type": "official_summary",
        "duplicate_hash_v1": dup_hash_b,
    }

    mock_batch = MagicMock()

    # get_existing_official_news_docs(url_a) は mock_doc_a を返す (同一記事更新と判定)
    with patch("backend.main.get_existing_official_news_docs", return_value=[mock_doc_a]), \
         patch("backend.main.db.batch", return_value=mock_batch), \
         patch("backend.main.db.collection") as mock_col:

        # もし誤って find_duplicate_knowledge が走った場合は mock_doc_b が見つかる
        mock_query = MagicMock()
        mock_query.stream.return_value = [mock_doc_b]
        mock_col.return_value.where.return_value = mock_query

        res = client.post(
            "/api/admin/official-news/register",
            headers={"X-Admin-Key": ADMIN_KEY},
            json={
                "title": "URL A 新タイトル",
                "url": url_a,
                "published_date": "2026-09-01",
                "summary": shared_summary,
                "allow_duplicate": False,  # allow_duplicate=False でも同一記事更新なので409にならない
            },
        )

        # 409 ではなく 200 OK (saved)
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "saved"
        assert setup_env_and_mocks["embed"].call_count >= 1
        assert mock_batch.commit.call_count == 1
        assert mock_batch.set.call_count >= 1


def test_official_news_different_url_same_summary_duplicate_409(setup_env_and_mocks):
    """別URL + 同一summary -> 409 Conflict (duplicate: true, existing情報返却)"""
    summary = "共通の要約テキストです。+10% ATK UP。"
    dup_hash = calculate_duplicate_hash_v1(summary)

    mock_existing_doc = MagicMock()
    mock_existing_doc.id = "official_news_other_0"
    mock_existing_doc.to_dict.return_value = {
        "url": "https://granbluefantasy.com/ja/news/detail/999",
        "title": "別記事タイトル",
        "source_type": "official_summary",
        "duplicate_hash_v1": dup_hash,
        "content": "機密な本文全文",  # レスポンスに漏洩してはならない
        "embedding_field": [0.1] * 768,  # レスポンスに漏洩してはならない
    }

    mock_batch = MagicMock()

    with patch("backend.main.get_existing_official_news_docs", return_value=[]), \
         patch("backend.main.db.batch", return_value=mock_batch), \
         patch("backend.main.db.collection") as mock_col:

        # query mock for find_duplicate_knowledge
        mock_query = MagicMock()
        mock_query.stream.return_value = [mock_existing_doc]
        mock_col.return_value.where.return_value = mock_query

        res = client.post(
            "/api/admin/official-news/register",
            headers={"X-Admin-Key": ADMIN_KEY},
            json={
                "title": "新規記事タイトル",
                "url": "https://granbluefantasy.com/ja/news/detail/100",
                "published_date": "2026-09-01",
                "summary": "  共通の要約テキストです。\n+10% ATK UP。  ",  # 空白・改行差
                "allow_duplicate": False,
            },
        )

        assert res.status_code == 409
        data = res.json()
        detail = data.get("detail", {})
        assert detail.get("duplicate") is True
        assert "すでに登録されています" in detail.get("message", "")
        
        # 既存ドキュメント情報の検証
        existing = detail.get("existing", {})
        assert existing.get("doc_id") == "official_news_other_0"
        assert existing.get("title") == "別記事タイトル"
        assert existing.get("url") == "https://granbluefantasy.com/ja/news/detail/999"
        assert existing.get("source_type") == "official_summary"

        # 本文・embeddingが漏洩していないこと
        assert "content" not in existing
        assert "embedding_field" not in existing
        assert "機密な本文全文" not in str(data)

        # 409時の書き込み0テスト (set/update/delete/commit呼び出し0)
        assert setup_env_and_mocks["embed"].call_count == 0
        assert setup_env_and_mocks["gemini"].call_count == 0
        assert mock_batch.commit.call_count == 0
        assert mock_batch.set.call_count == 0
        assert mock_batch.update.call_count == 0
        assert mock_batch.delete.call_count == 0


def test_official_news_with_site_update_id_duplicate_409_keeps_pending(setup_env_and_mocks):
    """
    site_update_id付きで公式ニュース登録を試みた際のduplicate 409検証:
    ・site_updates doc は pending かつ granblue_official
    ・別URLに同一summaryの既存情報あり
    ・409 Conflict かつ duplicate == True
    ・Embedding 0回, Gemini生成 0回, batch.set 0回, batch.update 0回, batch.delete 0回, batch.commit 0回
    ・site_updates の status が registered に更新されず pending のまま維持されることを保証
    """
    url = "https://granbluefantasy.com/ja/news/detail/100"
    site_update_id = "granblue_official_test_123"
    summary = "共通の要約テキストです。+10% ATK UP。"
    dup_hash = calculate_duplicate_hash_v1(summary)

    # 1. site_updates 対象ドキュメント (pending)
    mock_su_doc = MagicMock()
    mock_su_doc.exists = True
    mock_su_doc.to_dict.return_value = {
        "status": "pending",
        "source_id": "granblue_official",
        "url": url,
    }
    mock_su_ref = MagicMock()
    mock_su_ref.get.return_value = mock_su_doc

    # 2. knowledge の別URL重複ドキュメント
    mock_existing_doc = MagicMock()
    mock_existing_doc.id = "official_news_other_0"
    mock_existing_doc.to_dict.return_value = {
        "url": "https://granbluefantasy.com/ja/news/detail/999",
        "title": "別記事タイトル",
        "source_type": "official_summary",
        "duplicate_hash_v1": dup_hash,
    }

    mock_batch = MagicMock()

    with patch("backend.main.get_existing_official_news_docs", return_value=[]), \
         patch("backend.main.db.batch", return_value=mock_batch), \
         patch("backend.main.db.collection") as mock_col:

        def collection_side_effect(name):
            col_mock = MagicMock()
            if name == "site_updates":
                col_mock.document.return_value = mock_su_ref
            elif name == "knowledge":
                mock_query = MagicMock()
                mock_query.stream.return_value = [mock_existing_doc]
                col_mock.where.return_value = mock_query
            return col_mock

        mock_col.side_effect = collection_side_effect

        res = client.post(
            "/api/admin/official-news/register",
            headers={"X-Admin-Key": ADMIN_KEY},
            json={
                "title": "新規記事タイトル",
                "url": url,
                "published_date": "2026-09-01",
                "summary": summary,
                "site_update_id": site_update_id,
                "allow_duplicate": False,
            },
        )

        assert res.status_code == 409
        data = res.json()
        detail = data.get("detail", {})
        assert detail.get("duplicate") is True
        assert detail.get("existing", {}).get("doc_id") == "official_news_other_0"
        assert detail.get("existing", {}).get("title") == "別記事タイトル"
        assert detail.get("existing", {}).get("url") == "https://granbluefantasy.com/ja/news/detail/999"

        # 409時の安全性検証: Embedding 0回, Gemini 0回, Firestore書き込み・更新 0回 (pending維持)
        assert setup_env_and_mocks["embed"].call_count == 0
        assert setup_env_and_mocks["gemini"].call_count == 0
        assert mock_batch.set.call_count == 0
        assert mock_batch.update.call_count == 0
        assert mock_batch.delete.call_count == 0
        assert mock_batch.commit.call_count == 0


def test_official_news_self_chunks_exceeding_5_finds_duplicate(setup_env_and_mocks):
    """同一URLの自己チャンクが6件存在し、その後に別URLの重複が存在する場合に正しく409を検出"""
    summary = "長文要約の共通内容です。"
    dup_hash = calculate_duplicate_hash_v1(summary)
    current_url = "https://granbluefantasy.com/ja/news/detail/100"

    # 自己チャンク 6件 (同一URL)
    self_docs = []
    for i in range(6):
        d = MagicMock()
        d.id = f"official_news_self_chunk_{i}"
        d.to_dict.return_value = {
            "url": current_url,
            "title": "自己記事タイトル",
            "source_type": "official_summary",
            "duplicate_hash_v1": dup_hash,
        }
        self_docs.append(d)

    # 別URLのドキュメント (7件目)
    other_doc = MagicMock()
    other_doc.id = "official_news_other_chunk_0"
    other_doc.to_dict.return_value = {
        "url": "https://granbluefantasy.com/ja/news/detail/200",
        "title": "先行他記事タイトル",
        "source_type": "official_summary",
        "duplicate_hash_v1": dup_hash,
    }

    mock_batch = MagicMock()

    with patch("backend.main.get_existing_official_news_docs", return_value=[]), \
         patch("backend.main.db.batch", return_value=mock_batch), \
         patch("backend.main.db.collection") as mock_col:

        mock_query = MagicMock()
        mock_query.stream.return_value = self_docs + [other_doc]
        mock_col.return_value.where.return_value = mock_query

        res = client.post(
            "/api/admin/official-news/register",
            headers={"X-Admin-Key": ADMIN_KEY},
            json={
                "title": "新規記事タイトル",
                "url": current_url,
                "published_date": "2026-09-01",
                "summary": summary,
                "allow_duplicate": False,
            },
        )

        assert res.status_code == 409
        data = res.json()
        detail = data.get("detail", {})
        assert detail.get("duplicate") is True
        assert detail.get("existing", {}).get("doc_id") == "official_news_other_chunk_0"
        assert detail.get("existing", {}).get("title") == "先行他記事タイトル"


def test_official_news_allow_duplicate_true_bypasses(setup_env_and_mocks):
    """allow_duplicate=True の場合、重複が存在しても通常登録へ進む"""
    mock_batch = MagicMock()
    mock_col = MagicMock()

    with patch("backend.main.get_existing_official_news_docs", return_value=[]), \
         patch("backend.main.db.batch", return_value=mock_batch), \
         patch("backend.main.db.collection", return_value=mock_col):

        res = client.post(
            "/api/admin/official-news/register",
            headers={"X-Admin-Key": ADMIN_KEY},
            json={
                "title": "重複許可タイトル",
                "url": "https://granbluefantasy.com/ja/news/detail/100",
                "published_date": "2026-09-01",
                "summary": "共通の要約テキストです。",
                "allow_duplicate": True,
            },
        )

        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "saved"
        assert setup_env_and_mocks["embed"].call_count >= 1
        assert mock_batch.commit.call_count == 1


# ==============================================================================
# 3. YouTube登録 重複検出テスト (POST /api/admin/youtube/register)
# ==============================================================================

def test_youtube_register_different_videos_same_summary_duplicate_409(setup_env_and_mocks):
    """
    YouTube動画A (?v=AAA) と 動画B (?v=BBB) で同一summaryの場合に 409 Conflict
    URLのquery string (v=VIDEO_ID) が保持され、別動画が同一URLと誤認されないことを検証
    """
    summary = "共通YouTube攻略まとめ"
    dup_hash = calculate_duplicate_hash_v1(summary)

    # 既存動画A (v=vid_AAA_123)
    mock_existing_doc = MagicMock()
    mock_existing_doc.id = "youtube_vid_AAA_123"
    mock_existing_doc.to_dict.return_value = {
        "url": "https://www.youtube.com/watch?v=vid_AAA_123",
        "title": "先行動画Aタイトル",
        "source_type": "youtube_summary",
        "duplicate_hash_v1": dup_hash,
    }

    # 今回登録する動画B (v=vid_BBB_123) の site_updates doc
    mock_su_doc = MagicMock()
    mock_su_doc.exists = True
    mock_su_doc.to_dict.return_value = {
        "status": "pending",
        "source_type": "youtube_creator",
        "video_id": "vid_BBB_123",
        "channel_id": "chan123",
        "url": "https://www.youtube.com/watch?v=vid_BBB_123",
    }

    mock_batch = MagicMock()

    with patch("backend.main.db.collection") as mock_col, \
         patch("backend.main.db.batch", return_value=mock_batch):

        def collection_side_effect(name):
            col_mock = MagicMock()
            if name == "site_updates":
                col_mock.document.return_value.get.return_value = mock_su_doc
            elif name == "knowledge":
                mock_query = MagicMock()
                mock_query.stream.return_value = [mock_existing_doc]
                col_mock.where.return_value = mock_query
            return col_mock

        mock_col.side_effect = collection_side_effect

        res = client.post(
            "/api/admin/youtube/register",
            headers={"X-Admin-Key": ADMIN_KEY},
            json={
                "title": "動画Bタイトル",
                "channel_name": "配信者名",
                "url": "https://www.youtube.com/watch?v=vid_BBB_123",
                "summary": summary,
                "channel_id": "chan123",
                "video_id": "vid_BBB_123",
                "site_update_id": "youtube_vid_BBB_123",
                "allow_duplicate": False,
            },
        )

        assert res.status_code == 409
        data = res.json()
        detail = data.get("detail", {})
        assert detail.get("duplicate") is True
        assert detail.get("existing", {}).get("doc_id") == "youtube_vid_AAA_123"
        assert detail.get("existing", {}).get("title") == "先行動画Aタイトル"
        assert detail.get("existing", {}).get("url") == "https://www.youtube.com/watch?v=vid_AAA_123"

        # 409時の安全性検証: Embedding 0回, Gemini生成 0回, batch.set 0回, batch.update 0回, batch.delete 0回, batch.commit 0回
        assert setup_env_and_mocks["embed"].call_count == 0
        assert setup_env_and_mocks["gemini"].call_count == 0
        assert mock_batch.set.call_count == 0
        assert mock_batch.update.call_count == 0
        assert mock_batch.delete.call_count == 0
        assert mock_batch.commit.call_count == 0


def test_youtube_register_allow_duplicate_true(setup_env_and_mocks):
    """YouTube登録時、allow_duplicate=True であれば通常登録"""
    mock_su_doc = MagicMock()
    mock_su_doc.exists = True
    mock_su_doc.to_dict.return_value = {
        "status": "pending",
        "source_type": "youtube_creator",
        "video_id": "vid12345",
        "channel_id": "chan123",
        "url": "https://www.youtube.com/watch?v=vid12345",
    }

    mock_batch = MagicMock()

    with patch("backend.main.db.collection") as mock_col, \
         patch("backend.main.db.batch", return_value=mock_batch):

        def collection_side_effect(name):
            col_mock = MagicMock()
            if name == "site_updates":
                col_mock.document.return_value.get.return_value = mock_su_doc
            return col_mock

        mock_col.side_effect = collection_side_effect

        res = client.post(
            "/api/admin/youtube/register",
            headers={"X-Admin-Key": ADMIN_KEY},
            json={
                "title": "YouTube動画タイトル",
                "channel_name": "配信者名",
                "url": "https://www.youtube.com/watch?v=vid12345",
                "summary": "YouTube攻略情報要約",
                "channel_id": "chan123",
                "video_id": "vid12345",
                "site_update_id": "youtube_vid12345",
                "allow_duplicate": True,
            },
        )

        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "saved"
        assert setup_env_and_mocks["embed"].call_count == 1
        assert mock_batch.commit.call_count == 1


# ==============================================================================
# 4. exclude_doc_ids 直接テスト & 例外ハンドリング & Query安全性テスト
# ==============================================================================

def test_find_duplicate_knowledge_exclude_doc_ids_direct():
    """
    find_duplicate_knowledge() に exclude_doc_ids={"self_doc"} を渡し、
    同一hash候補に self_doc と other_doc が存在する場合、
    URL除外に頼らず exclude_doc_ids により self_doc を除外して other_doc を返すことを直接検証
    """
    dup_hash = "dummy_duplicate_hash_v1_value"

    mock_self_doc = MagicMock()
    mock_self_doc.id = "self_doc"
    mock_self_doc.to_dict.return_value = {
        "title": "自己ドキュメント",
        "url": "https://example.com/page1",
        "source_type": "official_summary",
        "duplicate_hash_v1": dup_hash,
    }

    mock_other_doc = MagicMock()
    mock_other_doc.id = "other_doc"
    mock_other_doc.to_dict.return_value = {
        "title": "他ドキュメント",
        "url": "https://example.com/page2",
        "source_type": "youtube_summary",
        "duplicate_hash_v1": dup_hash,
    }

    with patch("backend.main.db.collection") as mock_col:
        mock_query = MagicMock()
        mock_query.stream.return_value = [mock_self_doc, mock_other_doc]
        mock_col.return_value.where.return_value = mock_query

        # exclude_url=None で URL除外に頼らず、exclude_doc_ids のみで判定
        result = find_duplicate_knowledge(
            dup_hash,
            exclude_url=None,
            exclude_doc_ids={"self_doc"}
        )

        assert result is not None
        assert result["doc_id"] == "other_doc"
        assert result["title"] == "他ドキュメント"
        assert result["url"] == "https://example.com/page2"
        assert result["source_type"] == "youtube_summary"


def test_firestore_duplicate_query_exception():
    """Firestore duplicate query例外発生時は安全に500エラー"""
    with patch("backend.main.db.collection") as mock_col:
        mock_col.side_effect = Exception("Firestore connection error")

        with pytest.raises(backend.main.HTTPException) as exc_info:
            find_duplicate_knowledge("some_hash")
        assert exc_info.value.status_code == 500
        assert "重複チェック中にエラーが発生しました" in exc_info.value.detail
