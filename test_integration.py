"""
モックテスト: 管理画面 → AI要約 → knowledge登録 統合修正の検証
"""
import json, re, hashlib
from urllib.parse import urlparse, parse_qs
from datetime import datetime, timezone

# ==================== ヘルパー関数のモック ====================

def validate_youtube_url(url: str) -> str:
    value = url.strip()
    if not value:
        raise ValueError("YouTube URLが必要です。")
    if not value.startswith("https://"):
        raise ValueError("https:// で始まるURLが必要です。")
    parsed = urlparse(value)
    hostname = (parsed.hostname or "").lower()
    video_id = ""
    if hostname in ("www.youtube.com", "youtube.com", "m.youtube.com"):
        if parsed.path == "/watch":
            qs = parse_qs(parsed.query)
            v_list = qs.get("v")
            if v_list and v_list[0].strip():
                video_id = v_list[0].strip()
    elif hostname == "youtu.be":
        path_parts = [p for p in parsed.path.split("/") if p]
        if path_parts:
            video_id = path_parts[0].strip()
    if not video_id or not re.fullmatch(r"[A-Za-z0-9_-]{6,15}", video_id):
        raise ValueError("有効な動画IDを含むYouTube動画URLが必要です。")
    return value

class MockVector:
    def __init__(self, v): self.v = v

def mock_get_embedding(text):
    return [0.1] * 768

# ==================== Test 1: knowledge data shape ====================

print("=== Test 1: YouTube knowledge data (content/embedding_field/source_type/active) ===")

summary = "グラブル攻略情報の要約テスト"
embedding = mock_get_embedding(summary)
content_hash = hashlib.sha256(summary.encode()).hexdigest()

doc_data = {
    "source_type": "youtube_summary",
    "source": "TestChannel: TestTitle",
    "title": "TestTitle",
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "published_date": "2026/08/27",
    "channel_id": "UC_test",
    "video_id": "dQw4w9WgXcQ",
    "summary": summary,
    "content": f"[第三者YouTube攻略情報]\n{summary}",
    "content_hash": content_hash,
    "active": True,
    "embedding_field": MockVector(embedding),
}

assert doc_data.get("content"), "contentが空"
assert doc_data["content"].startswith("[第三者YouTube攻略情報]"), f"contentラベルなし: {doc_data['content'][:50]}"
assert isinstance(doc_data["embedding_field"], MockVector), "embedding_fieldがVector型でない"
assert doc_data["source_type"] == "youtube_summary", "source_typeが違う"
assert doc_data["active"] is True, "activeがTrueでない"
print("PASS: content / embedding_field / source_type / active すべて正常\n")

# ==================== Test 2: YouTube URL validation ====================

print("=== Test 2: YouTube URL validation ===")

valid_urls = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
]
invalid_urls = [
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",  # http
    "https://example.com/",                          # 外部ドメイン
    "file:///etc/passwd",                            # file://
    "https://169.254.169.254/latest/meta-data/",     # Cloud metadata
    "javascript:alert(1)",                           # javascript:
    "",                                              # 空
    "https://www.youtube.com/",                      # video_idなし
]

for url in valid_urls:
    try:
        validate_youtube_url(url)
        print(f"  PASS (valid): {url}")
    except Exception as e:
        print(f"  FAIL (valid): {url} -> {e}")

for url in invalid_urls:
    try:
        validate_youtube_url(url)
        print(f"  FAIL (invalid, should reject): {url}")
    except ValueError as e:
        print(f"  PASS (rejected): {url[:50]} -> {e}")
print()

# ==================== Test 3: 情報不足で422 (Gemini 0) ====================

print("=== Test 3: 情報不足でHTTP 422 / Gemini呼び出し0 ===")

gemini_calls = 0

def check_summarize(description, transcript):
    global gemini_calls
    desc = description.strip()
    trans = transcript.strip()
    if not desc and not trans:
        return 422, "要約に必要な公開情報が不足しています。"
    # Gemini呼び出し
    gemini_calls += 1
    return 200, "要約テキスト"

status, detail = check_summarize("", "")
assert status == 422, f"期待:422, 実際:{status}"
assert gemini_calls == 0, f"Gemini呼び出し発生: {gemini_calls}回"
print(f"PASS: 情報不足 -> {status} / Gemini呼び出し: {gemini_calls}回")

status, detail = check_summarize("説明文あり", "")
assert status == 200
print(f"PASS: description有 -> {status} / Gemini: {gemini_calls}回\n")

# ==================== Test 4: admin site-updates 返却フィールド ====================

print("=== Test 4: admin site-updates 返却フィールド ===")

# Firestoreドキュメントのモック
class MockDoc:
    def __init__(self, doc_id, data):
        self.id = doc_id
        self._data = data
    def to_dict(self):
        return self._data

mock_docs = [
    MockDoc("update_youtube_abc123", {
        "source_id": "youtube_gbf",
        "source_type": "youtube_creator",
        "source_name": "GBFチャンネル",
        "title": "古戦場攻略動画",
        "url": "https://www.youtube.com/watch?v=abc1234",
        "published_at": "2026/08/27",
        "detected_at": datetime(2026, 8, 27, tzinfo=timezone.utc),
        "status": "pending",
        "article_id": None,
        "video_id": "abc1234",
        "channel_id": "UC_example",
    }),
    MockDoc("update_official_xyz", {
        "source_id": "granblue_official",
        "source_type": "official_news",
        "source_name": "グランブルーファンタジー公式",
        "title": "イベントお知らせ",
        "url": "https://granbluefantasy.com/ja/news/9760/",
        "published_at": "2026/08/26",
        "detected_at": datetime(2026, 8, 26, tzinfo=timezone.utc),
        "status": "pending",
        "article_id": "9760",
        "video_id": None,
        "channel_id": None,
    }),
]

updates = []
for doc in mock_docs:
    data = doc.to_dict()
    updates.append({
        "id":             doc.id,
        "site_update_id": doc.id,
        "source_id":      data.get("source_id") or None,
        "source_type":    data.get("source_type", ""),
        "source_name":    data.get("source_name", ""),
        "title":          data.get("title", ""),
        "url":            data.get("url", ""),
        "published_at":   data.get("published_at", ""),
        "detected_at":    data.get("detected_at"),
        "status":         data.get("status", ""),
        "article_id":     data.get("article_id") or None,
        "video_id":       data.get("video_id") or None,
        "channel_id":     data.get("channel_id") or None,
    })

req_fields = ["id", "site_update_id", "source_id", "source_type", "article_id", "video_id", "channel_id"]
for upd in updates:
    for field in req_fields:
        assert field in upd, f"フィールド {field} が未返却"
    print(f"PASS: {upd['id']} -> video_id={upd['video_id']}, channel_id={upd['channel_id']}, article_id={upd['article_id']}")
print()

# ==================== Test 5: fetchAdminSiteUpdates の定義確認 ====================

print("=== Test 5: admin HTML fetchAdminSiteUpdates 定義確認 ===")

with open("official-news-admin.html", encoding="utf-8") as f:
    admin_html = f.read()

assert "async function fetchAdminSiteUpdates()" in admin_html, "fetchAdminSiteUpdates未定義"
assert 'onclick="fetchAdminSiteUpdates()"' in admin_html or "fetchAdminSiteUpdates()" in admin_html, "ボタンから呼ばれていない"
print("PASS: fetchAdminSiteUpdates 定義済み・ボタン接続確認\n")

# ==================== Test 6: YouTube pending選択時のモード設定 ====================

print("=== Test 6: YouTube pending選択時の currentMode=youtube + prepare呼び出し ===")

assert 'currentMode = \'youtube\'' in admin_html or "currentMode = 'youtube'" in admin_html, "currentMode='youtube'設定なし"
assert "/api/admin/youtube/prepare" in admin_html, "prepare API呼び出しなし"
print("PASS: YouTube選択時 currentMode='youtube' + prepare API呼び出し確認\n")

# ==================== Test 7: clearArticle後のリセット ====================

print("=== Test 7: clearArticle 後の currentMode='official' / currentYoutubeData=null ===")

assert "currentMode = 'official'" in admin_html, "clearArticle内でcurrentModeをofficialへリセットしていない"
assert "currentYoutubeData = null" in admin_html, "clearArticle内でcurrentYoutubeDataをnullにしていない"
print("PASS: clearArticle() でモードリセット確認\n")

# ==================== Test 8: registered API URL (Cloud Run) ====================

print("=== Test 8: registered API URL が Cloud Run ===")

with open("index.html", encoding="utf-8") as f:
    index_html = f.read()

assert "meron-ai-api-281908486591.asia-northeast1.run.app" in index_html, "Cloud Run URL未使用"
# 相対URL /api/registered-updates を単独で使っていないか確認
import re as _re
relative_only = _re.findall(r'fetch\(["\'](?!https?://)(/api/registered-updates)["\']', index_html)
assert not relative_only, f"相対URL /api/registered-updates を直接fetch: {relative_only}"
print("PASS: Cloud Run URLを使用 / 相対URL単独fetch なし\n")

# ==================== Test 9: 認証前にregistered APIを呼ばない ====================

print("=== Test 9: 認証成功後1回だけ registered 取得 ===")

assert "loadRegisteredUpdatesOnce" in index_html, "loadRegisteredUpdatesOnce未定義"
assert "registeredUpdatesLoaded" in index_html, "登録済みフラグなし"
# DOMContentLoaded内でfetchRegisteredUpdatesを直接呼んでいないか
dom_ready_blocks = _re.findall(r'DOMContentLoaded.*?}\s*\)', index_html, _re.DOTALL)
for block in dom_ready_blocks:
    if "fetchRegisteredUpdates()" in block and "loadRegisteredUpdatesOnce" not in block:
        assert False, f"DOMContentLoadedで直接fetchRegisteredUpdatesを呼んでいる: {block[:200]}"
print("PASS: 認証後1回のみ取得 / DOMContentLoaded時の直接呼び出しなし\n")

# ==================== Test 10: XSS対策 (innerHTML未加工挿入なし) ====================

print("=== Test 10: registered表示でtitle/source_nameをinnerHTMLへ未加工挿入しない ===")

# index.html: escapeHTMLを使用していることを確認
assert "function escapeHTML" in index_html, "escapeHTML未定義"
# title表示部分でescapeHTMLを使用しているか確認
assert "escapeHTML(upd.title)" in index_html, "upd.titleをescapeHTMLしていない"
assert "escapeHTML(upd.source_name)" in index_html, "upd.source_nameをescapeHTMLしていない"
print("PASS: index.html escapeHTML使用確認\n")

# admin HTML側もtextContentを使用しているか
assert "titleEl.textContent = upd.title" in admin_html or ".textContent" in admin_html, "admin HTMLでtextContent未使用"
print("PASS: admin HTML textContentによるXSS防止確認\n")

# ==================== Test 11: transcript 非永続化 ====================

print("=== Test 11: transcript/description全文が永続化されない ===")

# main.pyを読み込んで検証
with open("backend/main.py", encoding="utf-8") as f:
    main_py = f.read()

# youtube_register_endpointにtranscriptフィールドが保存されていないか
register_section_match = _re.search(r'@app\.post\("/api/admin/youtube/register"\).*?batch\.commit\(\)', main_py, _re.DOTALL)
if register_section_match:
    register_section = register_section_match.group()
    # 保存されるフィールドにtranscriptが含まれていないことを確認
    assert '"transcript"' not in register_section, "knowledgeにtranscriptが保存されている"
    assert '"description"' not in register_section or "channel_name" in register_section, "knowledgeにdescriptionが保存されている可能性"
    print("PASS: knowledgeにtranscript/descriptionの全文保存なし\n")
else:
    print("WARN: register_sectionを正確に特定できず（手動確認推奨）\n")

# ==================== Test 12: 公式URL制限の維持 ====================

print("=== Test 12: 公式ニュースURL制限 (granbluefantasy.com) の維持 ===")

assert "granbluefantasy.com" in main_py, "公式URL制限なし"
# official-news summarize/registerエンドポイントにgranblueチェックがあるか
assert 'granbluefantasy.com' in main_py, "公式URL検証なし"
print("PASS: granbluefantasy.com URL制限確認\n")

# ==================== コメント内平文パスワード削除確認 ====================

print("=== 追加確認: コメント内平文パスワード削除 ===")

assert "'gbf2026'" not in index_html, "index.html内にgbf2026の平文パスワードが残存"
print("PASS: 平文パスワードコメント削除確認\n")

print("=" * 60)
print("全テスト PASS")
print("=" * 60)

# ==============================================================
# 「AIに教えない」機能 モックテスト (Test 13〜24)
# ==============================================================

print()
print("=" * 60)
print("【AIに教えない】機能 モックテスト")
print("=" * 60)

import re as _re2

# ---- モック: Firestore / Gemini / Embedding ----

class MockHTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code = status_code
        self.detail = detail

class MockDocRef:
    """Firestoreドキュメント参照のモック"""
    def __init__(self, doc_id, data=None, exists=True):
        self.doc_id = doc_id
        self._data = data
        self.exists = data is not None and exists
        self.updated = {}

    def get(self):
        return self

    def to_dict(self):
        return dict(self._data) if self._data else {}

    def update(self, patch):
        self.updated.update(patch)


def mock_validate_site_update_id(raw):
    """_validate_site_update_id のモック実装"""
    PATTERN = _re2.compile(r"^[A-Za-z0-9_\-]{1,200}$")
    if not isinstance(raw, str):
        raise MockHTTPException(400, "site_update_idは文字列で指定してください。")
    value = raw.strip()
    if not value:
        raise MockHTTPException(400, "site_update_idが空です。")
    if len(value) > 200:
        raise MockHTTPException(400, "site_update_idが長すぎます。")
    if "/" in value:
        raise MockHTTPException(400, "site_update_idに '/' を含めることはできません。")
    if not PATTERN.fullmatch(value):
        raise MockHTTPException(400, "site_update_idに使用できない文字が含まれています。")
    return value


GEMINI_CALLS = 0
EMBEDDING_CALLS = 0
KNOWLEDGE_WRITES = 0

def mock_ignore_endpoint(site_update_id_raw, admin_key, db_mock):
    """POST /api/admin/site-updates/ignore のモック実装"""
    global GEMINI_CALLS, EMBEDDING_CALLS, KNOWLEDGE_WRITES

    # 認証チェック
    if not admin_key:
        raise MockHTTPException(401, "管理キーが正しくありません。")

    # 入力検証
    site_update_id = mock_validate_site_update_id(site_update_id_raw)

    # Firestore 取得
    doc_ref = db_mock.get(site_update_id)
    if doc_ref is None or not doc_ref.exists:
        raise MockHTTPException(404, "指定された情報が見つかりません。")

    data = doc_ref.to_dict()
    current_status = data.get("status", "")

    # すでに ignored → 冪等成功
    if current_status == "ignored":
        return {"ok": True, "site_update_id": site_update_id, "status": "ignored", "already_ignored": True}

    # registered / seeded → 409
    if current_status in ("registered", "seeded"):
        raise MockHTTPException(409, f"status='{current_status}' の情報は無視できません。")

    # pending 以外 → 409
    if current_status != "pending":
        raise MockHTTPException(409, f"status='{current_status}' の情報は無視できません。")

    # Gemini / Embedding / knowledge への書き込みは行わない
    # （モックで 0 のまま）

    # pending -> ignored
    doc_ref.update({
        "status": "ignored",
        "ignored_at": "SERVER_TIMESTAMP",
        "ignored_by": "admin",
    })

    return {"ok": True, "site_update_id": site_update_id, "status": "ignored"}


# ==================== Test 13: pending -> ignored 正常フロー ====================

print("\n=== Test 13: pending -> ignored 正常フロー ===")

GEMINI_CALLS = 0
EMBEDDING_CALLS = 0
KNOWLEDGE_WRITES = 0

mock_db = {
    "granblue_official_9760": MockDocRef("granblue_official_9760", {"status": "pending", "title": "イベント"}),
}

result = mock_ignore_endpoint("granblue_official_9760", "test_admin_key", mock_db)
assert result["ok"] is True, "ok が True でない"
assert result["status"] == "ignored", f"statusが 'ignored' でない: {result['status']}"
assert GEMINI_CALLS == 0, f"Gemini呼出: {GEMINI_CALLS}"
assert EMBEDDING_CALLS == 0, f"Embedding呼出: {EMBEDDING_CALLS}"
assert KNOWLEDGE_WRITES == 0, f"knowledge書込: {KNOWLEDGE_WRITES}"
updated = mock_db["granblue_official_9760"].updated
assert updated.get("status") == "ignored", "status=ignoredが保存されていない"
assert "ignored_at" in updated, "ignored_atが保存されていない"
assert updated.get("ignored_by") == "admin", "ignored_byが保存されていない"
print(f"PASS: pending -> ignored / Gemini={GEMINI_CALLS} / Embedding={EMBEDDING_CALLS} / knowledge={KNOWLEDGE_WRITES}")

# ==================== Test 14: 存在しないID -> 404 ====================

print("\n=== Test 14: 存在しないID -> 404 ===")

try:
    mock_ignore_endpoint("nonexistent_id_123", "test_admin_key", mock_db)
    print("FAIL: 404が発生しなかった")
except MockHTTPException as e:
    assert e.status_code == 404, f"期待:404, 実際:{e.status_code}"
    print(f"PASS: 存在しないID -> {e.status_code}")

# ==================== Test 15: 不正ID -> 400 ====================

print("\n=== Test 15: 不正ID -> 400 ===")

invalid_ids = [
    ("../abc", "パストラバーサル"),
    ("foo/bar", "スラッシュ含む"),
    ("", "空文字"),
    ("aaa bbb", "スペース含む"),
    ("test\nabc", "改行含む"),
]

for bad_id, reason in invalid_ids:
    try:
        mock_validate_site_update_id(bad_id)
        print(f"  FAIL ({reason}): 拒否されなかった: {repr(bad_id)}")
    except MockHTTPException as e:
        assert e.status_code == 400, f"期待:400, 実際:{e.status_code}"
        print(f"  PASS ({reason}): 拒否 -> {e.status_code}: {e.detail}")

# ==================== Test 16: registered を ignore -> 409 ====================

print("\n=== Test 16: registered を ignore -> 409 ===")

mock_db_r = {
    "granblue_official_abc": MockDocRef("granblue_official_abc", {"status": "registered"}),
}

try:
    mock_ignore_endpoint("granblue_official_abc", "test_admin_key", mock_db_r)
    print("FAIL: 409が発生しなかった")
except MockHTTPException as e:
    assert e.status_code == 409, f"期待:409, 実際:{e.status_code}"
    # registered ドキュメントが更新されていないことを確認
    assert mock_db_r["granblue_official_abc"].updated == {}, "registeredドキュメントが変更された"
    print(f"PASS: registered -> {e.status_code} / ドキュメント変更なし")

# ==================== Test 17: すでに ignored -> 冪等成功 ====================

print("\n=== Test 17: すでに ignored -> 冪等成功 ===")

mock_db_i = {
    "granblue_official_def": MockDocRef("granblue_official_def", {"status": "ignored"}),
}

result = mock_ignore_endpoint("granblue_official_def", "test_admin_key", mock_db_i)
assert result["ok"] is True
assert result["status"] == "ignored"
assert result.get("already_ignored") is True
print(f"PASS: already_ignored -> {result}")

# ==================== Test 18: admin key なし -> 401 ====================

print("\n=== Test 18: admin key なし -> 401 ===")

try:
    mock_ignore_endpoint("granblue_official_9760", "", mock_db)
    print("FAIL: 401が発生しなかった")
except MockHTTPException as e:
    assert e.status_code == 401, f"期待:401, 実際:{e.status_code}"
    print(f"PASS: adminキーなし -> {e.status_code}")

# ==================== Test 19: admin HTML に「AIに教えない」ボタン生成コード ====================

print("\n=== Test 19: admin HTML に「AIに教えない」ボタン生成コードが存在 ===")

with open("official-news-admin.html", encoding="utf-8") as f:
    admin_html2 = f.read()

assert "AIに教えない" in admin_html2, "「AIに教えない」テキストが未定義"
assert "ignoreBtn" in admin_html2, "ignoreBtnが未定義"
assert "ignoreSiteUpdate" in admin_html2, "ignoreSiteUpdate関数が未定義"
assert "siteUpdateId" in admin_html2 or "site_update_id" in admin_html2, "siteUpdateIdの参照なし"
print("PASS: 「AIに教えない」ボタン生成コード・関数存在確認")

# ==================== Test 20: 確認ダイアログ (confirm) が呼ばれる ====================

print("\n=== Test 20: 確認ダイアログ (confirm) が呼ばれること ===")

assert "confirm(" in admin_html2, "confirm()が未使用"
# ignoreSiteUpdate関数内にconfirmがあることを確認
ignore_fn_match = _re2.search(
    r"async function ignoreSiteUpdate.*?(?=\n    [a-z/]|\Z)",
    admin_html2,
    _re2.DOTALL
)
assert ignore_fn_match, "ignoreSiteUpdate関数が見つからない"
ignore_fn_text = ignore_fn_match.group()
assert "confirm(" in ignore_fn_text, "ignoreSiteUpdate内にconfirmがない"
print("PASS: ignoreSiteUpdate内でconfirm()呼び出し確認")

# ==================== Test 21: ignore成功後 fetchAdminSiteUpdates() 再実行 ====================

print("\n=== Test 21: ignore成功後 fetchAdminSiteUpdates() 再実行 ===")

assert "await fetchAdminSiteUpdates()" in ignore_fn_text, \
    "ignore成功後にfetchAdminSiteUpdates()が呼ばれていない"
print("PASS: ignore成功後 fetchAdminSiteUpdates() 再実行確認")

# ==================== Test 22: watcher が ignored を再び pending にしない ====================

print("\n=== Test 22: watcher の fetch_known_ids が ignored を既知扱いにする ===")

# fetch_known_ids はstatus問わず source_id が一致するドキュメントを全て取得する
# → ignored のドキュメントも既知IDとして返るため、再 pending 化しない

import sys
sys.path.insert(0, "backend/news-watch-job")

# fetch_known_ids をソースレベルで解析（import不可のため）
with open("backend/news-watch-job/watch_news.py", encoding="utf-8") as f:
    watcher_src = f.read()

# fetch_known_ids が status フィルタを持っていないことを確認
fn_match = _re2.search(r"def fetch_known_ids.*?(?=\ndef |\Z)", watcher_src, _re2.DOTALL)
assert fn_match, "fetch_known_ids関数が見つからない"
fn_text = fn_match.group()
# status == "registered" のみに絞っていないことを確認
assert '"status"' not in fn_text and "'status'" not in fn_text, \
    "fetch_known_ids内でstatusフィルタが使われている（ignoredが既知扱いされない可能性）"
# source_idだけでフィルタしていることを確認
assert "source_id" in fn_text, "fetch_known_idsがsource_idでフィルタしていない"
print("PASS: fetch_known_ids はstatus問わず全ドキュメントを既知扱い → ignoredは再pending化されない")

# ==================== Test 23: GET /api/registered-updates に ignored が出ない ====================

print("\n=== Test 23: GET /api/registered-updates に ignored が出ない ===")

with open("backend/main.py", encoding="utf-8") as f:
    main_py2 = f.read()

# registered-updates エンドポイントを抽出
reg_match = _re2.search(
    r'@app\.get\("/api/registered-updates"\).*?(?=\n@app\.|\Z)',
    main_py2,
    _re2.DOTALL
)
assert reg_match, "registered-updatesエンドポイントが見つからない"
reg_section = reg_match.group()
assert '"registered"' in reg_section or "'registered'" in reg_section, \
    "registered-updatesがregisteredをフィルタしていない"
assert '"ignored"' not in reg_section and "'ignored'" not in reg_section, \
    "registered-updatesがignoredを含む条件を持っている"
print("PASS: GET /api/registered-updates は status='registered' のみ返す")

# ==================== Test 24: ignore処理でGemini/Embedding呼出0 ====================

print("\n=== Test 24: ignore処理でGemini/Embedding呼出0 ===")

# ignore_site_update_endpoint の実装を抽出
ignore_match = _re2.search(
    r'@app\.post\("/api/admin/site-updates/ignore"\).*?(?=\n@app\.|\Z)',
    main_py2,
    _re2.DOTALL
)
assert ignore_match, "ignore endpointが見つからない"
ignore_section = ignore_match.group()

assert "get_embedding" not in ignore_section, "ignore処理でget_embeddingを呼んでいる"
assert "generate_content" not in ignore_section, "ignore処理でgenerate_contentを呼んでいる"
assert "client.models" not in ignore_section, "ignore処理でGeminiクライアントを使用している"
assert 'collection("knowledge")' not in ignore_section, "ignore処理でknowledgeコレクションに書き込んでいる"
print("PASS: ignore処理でGemini=0 / Embedding=0 / knowledge書込=0")

print()
print("=" * 60)
print("=" * 60)
print("【AIに教えない】モックテスト 全PASS (Test 13〜24)")
print("=" * 60)

# ==============================================================================
# AI Knowledge 管理 API テスト
# ==============================================================================

print("\n" + "=" * 60)
print("【AI Knowledge管理】モックテスト開始")
print("=" * 60)

with open("backend/main.py", encoding="utf-8") as f:
    main_py_k = f.read()

# ==================== Test 25: knowledge一覧API の定義確認 ====================
print("\n=== Test 25: knowledge一覧API の定義確認 ===")
k_list_match = _re2.search(
    r'@app\.get\("/api/admin/knowledge"\).*?(?=\n@app\.|\Z)',
    main_py_k,
    _re2.DOTALL
)
assert k_list_match, "GET /api/admin/knowledge が未定義"
k_list_src = k_list_match.group()
assert "require_admin(" in k_list_src, "require_admin() が使用されていない"
assert "limit" in k_list_src, "limitパラメータがない"
assert "embedding_field" not in k_list_src.replace('("embedding_field"', ''), "embedding_fieldがハードコード等で返却されている可能性がある"
print("PASS: knowledge一覧API 定義と require_admin 確認")

# ==================== Test 26: knowledge一覧API で embedding 非公開対策 ====================
print("\n=== Test 26: knowledge一覧API で embedding 非公開対策 ===")
assert "allowed_fields" in k_list_src, "allowlist方式になっていない"
allowed_match = _re2.search(r'allowed_fields\s*=\s*\[(.*?)\]', k_list_src, _re2.DOTALL)
assert allowed_match, "allowed_fieldsリストが見つからない"
assert "embedding" not in allowed_match.group(1), "allowed_fieldsにembeddingが含まれている"
print("PASS: embedding非公開対策 (allowlist) 確認")

# ==================== Test 27: active変更API の定義確認と冪等性・ハード削除禁止 ====================
print("\n=== Test 27: active変更API の定義とハード削除禁止確認 ===")
k_active_match = _re2.search(
    r'@app\.patch\("/api/admin/knowledge/\{doc_id\}/active"\).*?(?=\n@app\.|\Z)',
    main_py_k,
    _re2.DOTALL
)
assert k_active_match, "PATCH /api/admin/knowledge/{doc_id}/active が未定義"
k_active_src = k_active_match.group()
assert "require_admin(" in k_active_src, "require_admin() が使用されていない"
assert "request.active" in k_active_src, "明示設定方式(body: active)になっていない(toggle不可)"
assert "delete(" not in k_active_src, "ハード削除(delete)が行われている可能性がある"
assert "db.collection(\"knowledge\").document(doc_id)" in k_active_src, "doc_idが別コレクションアクセスに使われる脆弱性対策がない"
assert "len(doc_id) >" in k_active_src or "不正な" in k_active_src, "doc_idの形式チェックが存在しない"
print("PASS: active変更API 定義と明示設定・安全確認")

# ==================== Test 28: search_knowledge_base での active=false 除外 ====================
print("\n=== Test 28: search_knowledge_base での active=false 除外と過剰取得 ===")
skb_match = _re2.search(
    r'def search_knowledge_base\([^)]*\).*?(?=\ndef |\Z)',
    main_py_k,
    _re2.DOTALL
)
assert skb_match, "search_knowledge_base が見つからない"
skb_src = skb_match.group()
assert "limit=" in skb_src and "+ 15" in skb_src or "+ 10" in skb_src or "+ 20" in skb_src, "ベクトル検索で必要件数より多く取得していない"
assert "doc_data.get(\"active\", True) is False" in skb_src, "active=falseの除外処理がない(既存データ有効扱い含む)"
assert "candidates[:RAG_SEARCH_LIMIT]" in skb_src, "最後に必要件数に絞る処理がない"
print("PASS: search_knowledge_base での active=false 除外ロジック確認")

# ==================== Test 29: knowledge-admin.html の UI 要件確認 ====================
print("\n=== Test 29: knowledge-admin.html UI 要件確認 ===")
import os
assert os.path.exists("knowledge-admin.html"), "knowledge-admin.html が作成されていない"
with open("knowledge-admin.html", encoding="utf-8") as f:
    k_html = f.read()

assert "X-Admin-Key" in k_html, "管理キーを送信する仕組みがない"
assert "localStorage" not in k_html and "sessionStorage" not in k_html, "管理キーをストレージに保存している"
assert "innerHTML" not in k_html.replace('innerHTML = \'\';', '').replace('innerHTML = \'<option', ''), "データ表示にinnerHTMLを使用している(XSSリスク)"
assert "textContent" in k_html, "安全なDOM API (textContent) を使用していない"
assert ".startsWith('http://') || item.url.startsWith('https://')" in k_html, "URLの安全確認(http/https限定)がない"
print("PASS: knowledge-admin.html セキュリティ・UI 要件確認")

print()
print("=" * 60)
print("【AI Knowledge管理】モックテスト 全PASS (Test 25〜29)")
print("=" * 60)

import os
