"""
test_formations_addenda.py

Formation 追記 API (POST /api/formations/{category}/{post_id}/addenda) のテスト。
既存テストスタイル (test_formations_delete.py / test_formations_create.py) に合わせて実装。

テストケース: 29 件 + 追加ケース
"""

import base64
import copy
import os
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import google.cloud.firestore
import google.genai
import pytest
from fastapi.testclient import TestClient

os.environ["GEMINI_API_KEY"] = "test"
os.environ["PORTAL_WRITE_ENABLED"] = "true"
os.environ["PORTAL_ALLOW_LOCAL_ORIGINS"] = "false"
google.cloud.firestore.Client = MagicMock()
google.genai.Client = MagicMock()

backend_path = Path(__file__).parent / "backend"
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(backend_path))

import backend.main as main

# ---------------------------------------------------------------------------
# 定数
# ---------------------------------------------------------------------------
ORIGIN = "https://huu-gbf.github.io"
POST_ID = "legacy_abc-1234"
SECRET_BYTES = bytes(range(32))
SECRET = base64.urlsafe_b64encode(SECRET_BYTES).rstrip(b"=").decode("ascii")
WRONG_SECRET = base64.urlsafe_b64encode(b"z" * 32).rstrip(b"=").decode("ascii")
ADDENDUM_REQUEST_ID = "AABBCCDD-EEFF-4000-8000-112233445566"
ADDENDUM_ID = ADDENDUM_REQUEST_ID.lower()


# ---------------------------------------------------------------------------
# Fake Firestore
# ---------------------------------------------------------------------------
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
            raise RuntimeError("secret-database-error-" + SECRET)
        return FakeSnapshot(self, self.database.data.get(self.path))

    @property
    def id(self):
        return self.path[1]


class FakeCollection:
    def __init__(self, database, name):
        self.database = database
        self.name = name

    def document(self, document_id):
        return FakeDocument(self.database, (self.name, document_id))


class FakeTransaction:
    def __init__(self, database):
        self.database = database
        self.operations = []

    def set(self, reference, values, merge=False):
        self.operations.append(("set", reference, copy.deepcopy(values), merge))

    def create(self, reference, values):
        self.operations.append(("create", reference, copy.deepcopy(values), False))

    def delete(self, reference):
        self.operations.append(("delete", reference, None, False))

    def commit(self):
        staged = copy.deepcopy(self.database.data)
        for op_number, (operation, reference, values, merge) in enumerate(self.operations, 1):
            if self.database.fail_write_number == op_number:
                raise RuntimeError("secret-database-error-" + SECRET)
            if operation == "delete":
                staged.pop(reference.path, None)
                continue
            current = copy.deepcopy(staged.get(reference.path, {})) if merge else {}
            for key, value in values.items():
                if value is main.firestore.DELETE_FIELD:
                    current.pop(key, None)
                else:
                    current[key] = value
            staged[reference.path] = current
        self.database.data = staged


class FakeFirestore:
    def __init__(self):
        self.data = {}
        self.lock = threading.RLock()
        self.fail_reads = False
        self.fail_write_number = None

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


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture
def portal(monkeypatch):
    database = FakeFirestore()
    forbidden_push = MagicMock(side_effect=AssertionError("push path must not be called"))
    forbidden_ai_db = MagicMock(side_effect=AssertionError("AI database must not be called"))
    monkeypatch.setattr(main, "_portal_db", database)
    monkeypatch.setattr(main, "db", forbidden_ai_db)
    monkeypatch.setattr(main.firestore, "transactional", fake_transactional)
    monkeypatch.setattr(main.time, "time", lambda: 1_800_000_010.0)
    monkeypatch.setattr(main, "send_formation_push", forbidden_push)
    monkeypatch.setattr(main, "dispatch_pending_push", forbidden_push)
    monkeypatch.setenv("PORTAL_WRITE_ENABLED", "true")
    monkeypatch.setenv("PORTAL_ALLOW_LOCAL_ORIGINS", "false")
    yield database
    forbidden_push.assert_not_called()
    forbidden_ai_db.assert_not_called()
    assert forbidden_ai_db.mock_calls == []


@pytest.fixture
def client():
    return TestClient(main.app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def public_path(category="gw", post_id=POST_ID):
    return (main.PUSH_FORMATIONS[category], post_id)


def private_path(category="gw", post_id=POST_ID):
    return ("formation_private", f"{category}_{post_id}")


def seed(database, category="gw", post_id=POST_ID, *, addenda=None, deleted=False, no_public=False):
    pub_path = public_path(category, post_id)
    prv_path = private_path(category, post_id)
    pub_data = {
        "schema_version": 2,
        "id": post_id,
        "name": "団員A",
        "comment": "コメント",
        "images": [],
        "imageCaptions": [],
        "tags": [],
        "timestamp": "2027-01-01T00:00:00Z",
    }
    if addenda is not None:
        pub_data["addenda"] = addenda
    prv_data = {
        "schema_version": 1,
        "delete_secret_hash": main.hash_delete_secret(SECRET),
        "payload_hash": "a" * 64,
        "created_at": datetime(2027, 1, 1, tzinfo=timezone.utc),
        "timestamp": "2027-01-01T00:00:00Z",
        "deleted_at": datetime(2027, 1, 2, tzinfo=timezone.utc) if deleted else None,
    }
    if not no_public:
        database.data[pub_path] = pub_data
    database.data[prv_path] = prv_data
    return pub_path, prv_path


def addendum_request(
    client,
    category="gw",
    post_id=POST_ID,
    secret=SECRET,
    text="補足情報です。",
    request_id=ADDENDUM_REQUEST_ID,
    headers=None,
):
    h = {"Origin": ORIGIN}
    if secret is not None:
        h["X-Delete-Secret"] = secret
    if headers:
        h.update(headers)
    body = {}
    if request_id is not None:
        body["request_id"] = request_id
    if text is not None:
        body["text"] = text
    return client.post(
        f"/api/formations/{category}/{post_id}/addenda",
        json=body,
        headers=h,
    )


# ---------------------------------------------------------------------------
# TC-1/20/21/22: 正しい secret で追記成功 (gw/multi/high)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("category", ["gw", "multi", "high"])
def test_correct_secret_creates_addendum(client, portal, category):
    seed(portal, category)
    response = addendum_request(client, category, text="補足情報")
    assert response.status_code == 201
    body = response.json()
    assert body["addendum_id"] == ADDENDUM_ID
    assert body["replayed"] is False
    assert body["created_at"].endswith("Z")
    pub = portal.data[public_path(category)]
    assert len(pub["addenda"]) == 1
    stored = pub["addenda"][0]
    assert stored["id"] == ADDENDUM_ID
    assert stored["text"] == "補足情報"
    assert isinstance(stored["createdAt"], datetime)
    assert stored["createdAt"].tzinfo == timezone.utc


# TC-2: 間違った secret は拒否
def test_wrong_secret_is_rejected(client, portal):
    seed(portal)
    response = addendum_request(client, secret=WRONG_SECRET)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ADDENDUM_NOT_AUTHORIZED"
    assert "addenda" not in portal.data[public_path()]


# TC-3: secret なしは 401
def test_missing_secret_is_401(client, portal):
    seed(portal)
    response = addendum_request(client, secret=None)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "DELETE_SECRET_REQUIRED"


# TC-4: 存在しない post_id
def test_nonexistent_post_is_rejected(client, portal):
    response = addendum_request(client)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ADDENDUM_NOT_AUTHORIZED"


# TC-5: category 不正
def test_invalid_category_is_404(client, portal):
    response = addendum_request(client, category="other")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "CATEGORY_NOT_FOUND"


# TC-6: text 空文字は拒否
def test_empty_text_is_rejected(client, portal):
    seed(portal)
    response = addendum_request(client, text="")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"
    assert "addenda" not in portal.data[public_path()]


# TC-7: text 空白のみは拒否
def test_whitespace_only_text_is_rejected(client, portal):
    seed(portal)
    response = addendum_request(client, text="   ")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"


# TC-8: text 300 文字は成功
def test_text_at_max_length_succeeds(client, portal):
    seed(portal)
    text = "あ" * 300
    response = addendum_request(client, text=text)
    assert response.status_code == 201
    pub = portal.data[public_path()]
    assert pub["addenda"][0]["text"] == text


# TC-9: text 301 文字は拒否
def test_text_over_max_length_is_rejected(client, portal):
    seed(portal)
    response = addendum_request(client, text="あ" * 301)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"


# TC-10: request_id 形式不正
@pytest.mark.parametrize("bad_id", [
    "not-a-uuid",
    "AABBCCDD-EEFF-1000-8000-112233445566",
    "AABBCCDD-EEFF-4000-0000-112233445566",
    "aabbccdd-eeff-4000-8000-11223344556",
])
def test_invalid_request_id_is_422(client, portal, bad_id):
    seed(portal)
    response = addendum_request(client, request_id=bad_id)
    assert response.status_code == 422


# TC-11: 1件目の追記成功
def test_first_addendum_succeeds(client, portal):
    seed(portal)
    response = addendum_request(client, text="1件目")
    assert response.status_code == 201
    pub = portal.data[public_path()]
    assert len(pub["addenda"]) == 1
    assert pub["addenda"][0]["text"] == "1件目"


# TC-12: 複数追記の成功
def test_multiple_addenda_succeed(client, portal):
    seed(portal)
    ids = [
        "AABBCCDD-EEFF-4001-8001-112233445501",
        "AABBCCDD-EEFF-4001-8001-112233445502",
        "AABBCCDD-EEFF-4001-8001-112233445503",
    ]
    for i, rid in enumerate(ids):
        resp = addendum_request(client, text=f"追記{i+1}", request_id=rid)
        assert resp.status_code == 201
    pub = portal.data[public_path()]
    assert len(pub["addenda"]) == 3
    assert [a["text"] for a in pub["addenda"]] == ["追記1", "追記2", "追記3"]


# TC-13: 20件目の追記成功
def test_twentieth_addendum_succeeds(client, portal):
    existing = [
        {"id": f"aabbccdd-eeff-4000-8000-{i:012x}", "text": f"追記{i}", "createdAt": "2027-01-01T00:00:00Z"}
        for i in range(19)
    ]
    seed(portal, addenda=existing)
    response = addendum_request(client, text="20件目")
    assert response.status_code == 201
    pub = portal.data[public_path()]
    assert len(pub["addenda"]) == 20


# TC-14: 21件目は拒否
def test_twenty_first_addendum_is_rejected(client, portal):
    existing = [
        {"id": f"aabbccdd-eeff-4000-8000-{i:012x}", "text": f"追記{i}", "createdAt": "2027-01-01T00:00:00Z"}
        for i in range(20)
    ]
    seed(portal, addenda=existing)
    response = addendum_request(client, text="21件目")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "ADDENDA_LIMIT_EXCEEDED"
    pub = portal.data[public_path()]
    assert len(pub["addenda"]) == 20


# TC-15: 同じ request_id + 同じ text の再送は 200 replayed
def test_same_request_id_same_text_is_idempotent(client, portal):
    seed(portal)
    resp1 = addendum_request(client, text="補足情報")
    assert resp1.status_code == 201
    assert resp1.json()["replayed"] is False

    resp2 = addendum_request(client, text="補足情報")
    assert resp2.status_code == 200
    assert resp2.json()["replayed"] is True
    assert resp2.json()["addendum_id"] == ADDENDUM_ID

    pub = portal.data[public_path()]
    assert len(pub["addenda"]) == 1


# TC-16: 同じ request_id + 異なる text は 409
def test_same_request_id_different_text_is_conflict(client, portal):
    seed(portal)
    resp1 = addendum_request(client, text="最初のテキスト")
    assert resp1.status_code == 201

    resp2 = addendum_request(client, text="別のテキスト")
    assert resp2.status_code == 409
    assert resp2.json()["error"]["code"] == "REQUEST_ID_CONFLICT"

    pub = portal.data[public_path()]
    assert len(pub["addenda"]) == 1
    assert pub["addenda"][0]["text"] == "最初のテキスト"


# TC-17: Transaction 失敗で Firestore は変更されない
def test_transaction_write_failure_leaves_data_unchanged(client, portal):
    seed(portal)
    portal.fail_write_number = 1
    before_public = copy.deepcopy(portal.data.get(public_path()))
    response = addendum_request(client, text="失敗するはず")
    assert response.status_code == 503
    assert "addenda" not in (portal.data.get(public_path()) or {})
    assert portal.data.get(public_path()) == before_public


# TC-18: addenda なし旧投稿に追記できる
def test_legacy_post_without_addenda_field_accepts_addendum(client, portal):
    seed(portal)
    portal.data[public_path()].pop("addenda", None)
    assert "addenda" not in portal.data[public_path()]
    response = addendum_request(client, text="旧投稿への追記")
    assert response.status_code == 201
    pub = portal.data[public_path()]
    assert len(pub["addenda"]) == 1
    assert pub["addenda"][0]["text"] == "旧投稿への追記"


# TC-19: 旧 Base64 画像投稿に追記できる
def test_legacy_base64_post_accepts_addendum(client, portal):
    seed(portal)
    portal.data[public_path()]["images"] = ["data:image/jpeg;base64,/9j/test"]
    portal.data[public_path()].pop("imageStoragePaths", None)
    response = addendum_request(client, text="旧Base64投稿への追記")
    assert response.status_code == 201
    pub = portal.data[public_path()]
    assert pub["addenda"][0]["text"] == "旧Base64投稿への追記"


# TC-23: XSS 文字列はテキストとして安全に保存される
def test_xss_string_is_stored_safely(client, portal):
    seed(portal)
    xss = '<script>alert("XSS")</script>'
    response = addendum_request(client, text=xss)
    assert response.status_code == 201
    pub = portal.data[public_path()]
    assert pub["addenda"][0]["text"] == xss


# TC-24: 元 comment が変更されない
def test_addendum_does_not_modify_comment(client, portal):
    seed(portal)
    original_comment = portal.data[public_path()]["comment"]
    addendum_request(client, text="追記")
    assert portal.data[public_path()]["comment"] == original_comment


# TC-25: 元 images が変更されない
def test_addendum_does_not_modify_images(client, portal):
    seed(portal)
    portal.data[public_path()]["images"] = ["https://example.com/img.jpg"]
    original_images = copy.deepcopy(portal.data[public_path()]["images"])
    addendum_request(client, text="追記")
    assert portal.data[public_path()]["images"] == original_images


# TC-26: 元 imageCaptions が変更されない
def test_addendum_does_not_modify_imagecaptions(client, portal):
    seed(portal)
    portal.data[public_path()]["imageCaptions"] = ["キャプション1"]
    original = copy.deepcopy(portal.data[public_path()]["imageCaptions"])
    addendum_request(client, text="追記")
    assert portal.data[public_path()]["imageCaptions"] == original


# TC-27: 元 tags が変更されない
def test_addendum_does_not_modify_tags(client, portal):
    seed(portal)
    portal.data[public_path()]["tags"] = ["火", "マグナ"]
    original = copy.deepcopy(portal.data[public_path()]["tags"])
    addendum_request(client, text="追記")
    assert portal.data[public_path()]["tags"] == original


# TC-28: 元 timestamp が変更されない
def test_addendum_does_not_modify_timestamp(client, portal):
    seed(portal)
    original_ts = portal.data[public_path()]["timestamp"]
    addendum_request(client, text="追記")
    assert portal.data[public_path()]["timestamp"] == original_ts


# TC-29: delete_secret が公開 document に入らない
def test_delete_secret_not_stored_in_public_document(client, portal):
    seed(portal)
    resp = addendum_request(client, text="追記")
    assert resp.status_code == 201
    pub = portal.data[public_path()]
    assert SECRET not in repr(pub)
    assert "delete_secret" not in pub
    assert "delete_secret_hash" not in pub
    assert SECRET not in resp.text


# 追加: text の前後空白は trim されて保存
def test_text_is_trimmed_before_storing(client, portal):
    seed(portal)
    response = addendum_request(client, text="  補足情報  ")
    assert response.status_code == 201
    pub = portal.data[public_path()]
    assert pub["addenda"][0]["text"] == "補足情報"


# 追加: PORTAL_WRITE_ENABLED=false は 503
def test_writes_disabled_returns_503(client, portal, monkeypatch):
    seed(portal)
    monkeypatch.setenv("PORTAL_WRITE_ENABLED", "false")
    response = addendum_request(client)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PORTAL_NOT_READY"


# 追加: Origin 不正は拒否
def test_invalid_origin_is_rejected(client, portal):
    seed(portal)
    response = addendum_request(client, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ORIGIN_NOT_ALLOWED"


# 追加: 削除済み投稿への追記は拒否
def test_deleted_post_rejects_addendum(client, portal):
    seed(portal, deleted=True)
    response = addendum_request(client)
    assert response.status_code == 410
    assert response.json()["error"]["code"] == "POST_DELETED"


# 追加: read 失敗はサニタイズされる
def test_read_failure_is_sanitized(client, portal, capsys):
    seed(portal)
    portal.fail_reads = True
    response = addendum_request(client)
    captured = capsys.readouterr()
    assert response.status_code == 503
    assert SECRET not in response.text + captured.out + captured.err


# 追加: Content-Type が application/json でない場合は 415
def test_wrong_content_type_is_415(client, portal):
    seed(portal)
    response = client.post(
        f"/api/formations/gw/{POST_ID}/addenda",
        content=b'{"request_id": "AABBCCDD-EEFF-4000-8000-112233445566", "text": "test"}',
        headers={"Origin": ORIGIN, "X-Delete-Secret": SECRET, "Content-Type": "text/plain"},
    )
    assert response.status_code == 415


# ---------------------------------------------------------------------------
# Phase E2.1 監査・検証用追加テスト
# ---------------------------------------------------------------------------

# 1. 逐次追記で両方が安全に残る確認
def test_two_sequential_addenda_both_survive(client, portal):
    seed(portal)
    r1 = "AABBCCDD-EEFF-4001-8001-112233445501"
    r2 = "AABBCCDD-EEFF-4001-8001-112233445502"
    resp1 = addendum_request(client, text="追記A", request_id=r1)
    assert resp1.status_code == 201
    resp2 = addendum_request(client, text="追記B", request_id=r2)
    assert resp2.status_code == 201

    pub = portal.data[public_path()]
    assert len(pub["addenda"]) == 2
    assert pub["addenda"][0]["text"] == "追記A"
    assert pub["addenda"][0]["id"] == r1.lower()
    assert isinstance(pub["addenda"][0]["createdAt"], datetime)
    assert pub["addenda"][1]["text"] == "追記B"
    assert pub["addenda"][1]["id"] == r2.lower()
    assert isinstance(pub["addenda"][1]["createdAt"], datetime)


# 2. 並行追記（マルチスレッド）で両方が安全に残る確認
def test_concurrent_addenda_both_survive_multithread(client, portal):
    import concurrent.futures
    seed(portal)
    r1 = "AABBCCDD-EEFF-4001-8001-112233445511"
    r2 = "AABBCCDD-EEFF-4001-8001-112233445522"

    def do_add(rid, text):
        return addendum_request(client, text=text, request_id=rid)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        f1 = executor.submit(do_add, r1, "並行追記1")
        f2 = executor.submit(do_add, r2, "並行追記2")
        resp1 = f1.result()
        resp2 = f2.result()

    assert resp1.status_code == 201
    assert resp2.status_code == 201

    pub = portal.data[public_path()]
    assert len(pub["addenda"]) == 2
    texts = {a["text"] for a in pub["addenda"]}
    assert texts == {"並行追記1", "並行追記2"}
    ids = {a["id"] for a in pub["addenda"]}
    assert ids == {r1.lower(), r2.lower()}


# 3. Rate limit (per_limit=10, 60s窓) 上限超過 429 と窓リセット
def test_rate_limit_per_secret_and_window_reset(client, portal, monkeypatch):
    seed(portal)
    current_time = 1_800_000_000.0
    monkeypatch.setattr(main.time, "time", lambda: current_time)

    # 10回まで成功 (per_limit=10)
    for i in range(10):
        rid = f"AABBCCDD-EEFF-4002-8002-{i:012x}"
        resp = addendum_request(client, text=f"連投{i}", request_id=rid)
        assert resp.status_code == 201, f"Attempt {i} failed: {resp.text}"

    # 11回目は 429
    r_exceed = "AABBCCDD-EEFF-4002-8002-999999999999"
    resp_blocked = addendum_request(client, text="上限超過", request_id=r_exceed)
    assert resp_blocked.status_code == 429
    assert resp_blocked.json()["error"]["code"] == "RATE_LIMITED"
    assert "Retry-After" in resp_blocked.headers

    # 61秒経過後に再度成功することを確認 (60s窓)
    current_time += 61.0
    resp_after = addendum_request(client, text="リセット後", request_id=r_exceed)
    assert resp_after.status_code == 201


# 4. 元投稿の全フィールド厳密不変確認
def test_addendum_preserves_all_original_fields_strictly(client, portal):
    seed(portal)
    pub_path = public_path()
    portal.data[pub_path].update({
        "name": "オリジナル投稿者",
        "comment": "オリジナルコメント",
        "images": ["https://example.com/image1.png"],
        "imageCaptions": ["オリジナルキャプション"],
        "tags": ["火", "マグナ"],
        "timestamp": "2027-01-01T12:34:56Z",
        "id": POST_ID,
        "imageStoragePaths": ["formations/gw/image1.png"],
    })
    before = copy.deepcopy(portal.data[pub_path])

    response = addendum_request(client, text="追記テキスト")
    assert response.status_code == 201

    after = portal.data[pub_path]
    # addenda 以外の全フィールドが一致していることを検証
    for key in ["name", "comment", "images", "imageCaptions", "tags", "timestamp", "id", "imageStoragePaths", "schema_version"]:
        assert after[key] == before[key], f"Field {key} was unexpectedly modified!"
    assert len(after["addenda"]) == 1
    assert after["addenda"][0]["text"] == "追記テキスト"


# 5. 公開 document に機密情報・private 情報が一切混入しないことの厳密確認
def test_public_document_never_contains_sensitive_fields(client, portal):
    seed(portal)
    response = addendum_request(client, text="追記")
    assert response.status_code == 201

    pub = portal.data[public_path()]
    # delete_secret, hash, headers
    assert SECRET not in repr(pub)
    assert "delete_secret" not in pub
    assert "delete_secret_hash" not in pub
    assert "X-Delete-Secret" not in repr(pub)
    # private document 固有フィールド
    assert "payload_hash" not in pub
    assert "deleted_at" not in pub
    # レスポンス本文にも secret が含まれない
    assert SECRET not in response.text

