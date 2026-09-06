import copy
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import google.cloud.firestore
import google.genai
import pytest

# テスト用環境変数設定
os.environ["GEMINI_API_KEY"] = "test"
os.environ["PORTAL_WRITE_ENABLED"] = "true"
os.environ["PORTAL_ALLOW_LOCAL_ORIGINS"] = "false"

google.cloud.firestore.Client = MagicMock()
google.genai.Client = MagicMock()

backend_path = Path(__file__).parent / "backend"
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(backend_path))

import backend.main as main
import firebase_admin.exceptions as firebase_exceptions
from firebase_admin import messaging as fcm_messaging


class MockSendResponse:
    def __init__(self, success: bool, exception=None, message_id="mock-msg-id"):
        self.success = success
        self.exception = exception
        self.message_id = message_id


class MockBatchResponse:
    def __init__(self, responses):
        self.responses = responses
        self.success_count = sum(1 for r in responses if r.success)
        self.failure_count = sum(1 for r in responses if not r.success)


# =====================================================================
# 1. 0件・上限値チェックテスト
# =====================================================================
def test_send_push_zero_installations():
    event = {"category": "gw", "post_id": "post001"}
    result = main.send_formation_push(event, [])
    assert result["total_target"] == 0
    assert result["success_count"] == 0
    assert result["failure_count"] == 0
    assert result["config_error"] is False
    assert result["retryable_installations"] == []
    assert result["permanent_installations"] == []


def test_send_push_exceeds_500_limit():
    event = {"category": "gw", "post_id": "post001"}
    installations = [
        {"installation_hash": f"hash_{i}", "token": f"token_{i}", "revision": 1}
        for i in range(501)
    ]
    with pytest.raises(ValueError, match="exceeds FCM multicast limit of 500"):
        main.send_formation_push(event, installations)


def test_send_push_invalid_category():
    """categoryが gw/multi/high 以外の場合は config_error で即返却、FCM送信0回、retryable=0、token無効化0回"""
    event = {"category": "invalid", "post_id": "post001"}
    installations = [
        {"installation_hash": "hash_1", "token": "token_1", "revision": 1}
    ]
    with patch.object(main, "get_fcm_app") as mock_app, \
         patch.object(fcm_messaging, "send_each_for_multicast") as mock_send, \
         patch.object(main, "disable_token_if_unchanged") as mock_disable:
        result = main.send_formation_push(event, installations)
        assert result["config_error"] is True
        assert result["failure_count"] == 1
        assert len(result["retryable_installations"]) == 0
        assert len(result["permanent_installations"]) == 0
        assert len(result["unregistered_installations"]) == 0
        mock_send.assert_not_called()
        mock_disable.assert_not_called()
        assert_no_token_leaks(result, ["token_1"])


def test_send_push_invalid_post_id():
    """post_idが不正な場合は config_error で即返却、FCM送信0回、retryable=0、token無効化0回"""
    event = {"category": "gw", "post_id": "../evil"}
    installations = [
        {"installation_hash": "hash_1", "token": "token_1", "revision": 1}
    ]
    with patch.object(main, "get_fcm_app") as mock_app, \
         patch.object(fcm_messaging, "send_each_for_multicast") as mock_send, \
         patch.object(main, "disable_token_if_unchanged") as mock_disable:
        result = main.send_formation_push(event, installations)
        assert result["config_error"] is True
        assert result["failure_count"] == 1
        assert len(result["retryable_installations"]) == 0
        assert len(result["permanent_installations"]) == 0
        assert len(result["unregistered_installations"]) == 0
        mock_send.assert_not_called()
        mock_disable.assert_not_called()
        assert_no_token_leaks(result, ["token_1"])


# =====================================================================
# 2. 正常系マルチキャスト送信テスト (1件, 100件, 500件)
# =====================================================================
@pytest.mark.parametrize("count", [1, 100, 500])
def test_send_push_success_multicast(count):
    event = {
        "category": "gw",
        "post_id": "post123",
    }
    installations = [
        {"installation_hash": f"hash_{i}", "token": f"token_{i}", "revision": 1}
        for i in range(count)
    ]

    mock_responses = [MockSendResponse(success=True) for _ in range(count)]
    mock_batch = MockBatchResponse(mock_responses)

    mock_app = MagicMock()
    with patch.object(main, "get_fcm_app", return_value=mock_app), \
         patch.object(fcm_messaging, "send_each_for_multicast", return_value=mock_batch) as mock_send:

        result = main.send_formation_push(event, installations)

        assert result["total_target"] == count
        assert result["success_count"] == count
        assert result["failure_count"] == 0
        assert result["config_error"] is False
        assert len(result["retryable_installations"]) == 0
        assert len(result["permanent_installations"]) == 0

        # 送信メッセージの検証
        mock_send.assert_called_once()
        call_args, call_kwargs = mock_send.call_args
        sent_message = call_args[0]

        # data ペイロードの検証（サーバー側で生成される正規ペイロード）
        assert sent_message.data["type"] == "formation_created"
        assert sent_message.data["category"] == "gw"
        assert sent_message.data["post_id"] == "post123"
        assert sent_message.data["event_id"] == "gw_post123"
        assert sent_message.data["title"] == "【新着編成】古戦場用"
        assert sent_message.data["body"] == "新しい編成が投稿されました"
        assert "huu-gbf.github.io" in sent_message.data["url"]
        assert "category=gw" in sent_message.data["url"]
        assert "post=post123" in sent_message.data["url"]

        # notification ペイロードは二重表示防止のため None であること（data-only）
        assert getattr(sent_message, "notification", None) is None

        # トークン数の検証
        assert len(sent_message.tokens) == count
        assert sent_message.tokens[0] == "token_0"

        # Webpush headers の検証
        assert sent_message.webpush.headers["Urgency"] == "high"
        assert sent_message.webpush.headers["TTL"] == "3600"


def test_send_push_deduplicates_tokens():
    """同一tokenの重複がFCMに1回だけ送信されることを検証"""
    event = {"category": "multi", "post_id": "dup_test"}
    installations = [
        {"installation_hash": "hash_a", "token": "shared_token", "revision": 1},
        {"installation_hash": "hash_b", "token": "shared_token", "revision": 2},
        {"installation_hash": "hash_c", "token": "unique_token", "revision": 1},
    ]

    # FCMへは重複排除後の2トークンだけ送信される
    mock_responses = [
        MockSendResponse(success=True),
        MockSendResponse(success=True),
    ]
    mock_batch = MockBatchResponse(mock_responses)

    mock_app = MagicMock()
    with patch.object(main, "get_fcm_app", return_value=mock_app), \
         patch.object(fcm_messaging, "send_each_for_multicast", return_value=mock_batch) as mock_send:

        result = main.send_formation_push(event, installations)

        # 3件全てが成功扱い
        assert result["total_target"] == 3
        assert result["success_count"] == 3
        assert result["failure_count"] == 0

        # FCMへは2トークンだけ送信
        call_args, _ = mock_send.call_args
        sent_message = call_args[0]
        assert len(sent_message.tokens) == 2


# =====================================================================
# 3. エラー分類と安全な無効化呼び出しテスト
# =====================================================================
def assert_no_token_leaks(obj, tokens_to_check):
    """SendResultなどの辞書・リスト内にFCMトークンがキーや値として一切存在しないことを再帰的に検証"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            assert "token" != k.lower(), f"Forbidden key 'token' found in dict: {obj}"
            assert_no_token_leaks(k, tokens_to_check)
            assert_no_token_leaks(v, tokens_to_check)
    elif isinstance(obj, list):
        for item in obj:
            assert_no_token_leaks(item, tokens_to_check)
    elif isinstance(obj, str):
        for token in tokens_to_check:
            assert token not in obj, f"Token string leaked into result: {obj}"


def test_send_push_error_classification():
    """Unregistered/SenderIdMismatch/InvalidArgument/Unavailable の分類を検証"""
    event = {"category": "gw", "post_id": "err_test"}
    installations = [
        {"installation_hash": "hash_unreg", "token": "token_unreg_xyz", "revision": 2},
        {"installation_hash": "hash_retry", "token": "token_retry_abc", "revision": 1},
        {"installation_hash": "hash_invalid", "token": "token_invalid_def", "revision": 1},
        {"installation_hash": "hash_sender_mismatch", "token": "token_mismatch_ghi", "revision": 3},
        {"installation_hash": "hash_ok", "token": "token_ok_jkl", "revision": 1},
    ]
    all_tokens = [i["token"] for i in installations]

    # モック例外
    unreg_exc = fcm_messaging.UnregisteredError("Requested entity was not found")
    retry_exc = firebase_exceptions.UnavailableError("Server unavailable")
    invalid_exc = firebase_exceptions.InvalidArgumentError("Invalid argument provided")
    mismatch_exc = fcm_messaging.SenderIdMismatchError("Sender ID mismatch")

    mock_responses = [
        MockSendResponse(success=False, exception=unreg_exc),
        MockSendResponse(success=False, exception=retry_exc),
        MockSendResponse(success=False, exception=invalid_exc),
        MockSendResponse(success=False, exception=mismatch_exc),
        MockSendResponse(success=True),
    ]
    mock_batch = MockBatchResponse(mock_responses)

    mock_app = MagicMock()
    with patch.object(main, "get_fcm_app", return_value=mock_app), \
         patch.object(fcm_messaging, "send_each_for_multicast", return_value=mock_batch), \
         patch.object(main, "disable_token_if_unchanged") as mock_disable:

        result = main.send_formation_push(event, installations)

        assert result["total_target"] == 5
        assert result["success_count"] == 1
        assert result["failure_count"] == 4

        # Unregistered の分類確認（Unregisteredのみ）
        unreg_hashes = [x["installation_hash"] for x in result["unregistered_installations"]]
        assert unreg_hashes == ["hash_unreg"]

        # config_error フラグ（SenderIdMismatch / InvalidArgument で True）
        assert result["config_error"] is True

        # Retryable の分類確認（Unavailable のみ。config_error系はretryableに入らない）
        retry_hashes = [x["installation_hash"] for x in result["retryable_installations"]]
        assert retry_hashes == ["hash_retry"]

        # Permanent の分類確認（Unregistered のみ。config_error系はpermanentにも入らない）
        permanent_hashes = [x["installation_hash"] for x in result["permanent_installations"]]
        assert permanent_hashes == ["hash_unreg"]

        # disable_token_if_unchanged の呼び出し検証
        # Unregistered の1回だけ呼ばれること（SenderIdMismatch/InvalidArgumentでは呼ばない）
        assert mock_disable.call_count == 1
        mock_disable.assert_called_once_with(
            installation_hash="hash_unreg",
            snapshot_revision=2,
            snapshot_token="token_unreg_xyz",
        )

        # SendResult 内の全階層にトークンが漏洩していないことを再帰検証
        assert_no_token_leaks(result, all_tokens)


def test_send_push_individual_invalid_argument():
    """個別response InvalidArgumentError: config_error=True, retryable=0, permanent=0, disable_token_if_unchanged=0"""
    event = {"category": "gw", "post_id": "arg_test"}
    installations = [
        {"installation_hash": "hash_inv", "token": "token_inv_123", "revision": 1}
    ]
    invalid_exc = firebase_exceptions.InvalidArgumentError("Invalid argument")
    mock_batch = MockBatchResponse([MockSendResponse(success=False, exception=invalid_exc)])

    with patch.object(main, "get_fcm_app", return_value=MagicMock()), \
         patch.object(fcm_messaging, "send_each_for_multicast", return_value=mock_batch), \
         patch.object(main, "disable_token_if_unchanged") as mock_disable:
        result = main.send_formation_push(event, installations)
        assert result["config_error"] is True
        assert result["failure_count"] == 1
        assert len(result["retryable_installations"]) == 0
        assert len(result["permanent_installations"]) == 0
        assert len(result["unregistered_installations"]) == 0
        mock_disable.assert_not_called()
        assert_no_token_leaks(result, ["token_inv_123"])


def test_send_push_individual_sender_id_mismatch():
    """個別response SenderIdMismatch: config_error=True, retryable=0, permanent=0, disable_token_if_unchanged=0"""
    event = {"category": "multi", "post_id": "sender_test"}
    installations = [
        {"installation_hash": "hash_mismatch", "token": "token_mismatch_123", "revision": 1}
    ]
    mismatch_exc = fcm_messaging.SenderIdMismatchError("Sender ID mismatch")
    mock_batch = MockBatchResponse([MockSendResponse(success=False, exception=mismatch_exc)])

    with patch.object(main, "get_fcm_app", return_value=MagicMock()), \
         patch.object(fcm_messaging, "send_each_for_multicast", return_value=mock_batch), \
         patch.object(main, "disable_token_if_unchanged") as mock_disable:
        result = main.send_formation_push(event, installations)
        assert result["config_error"] is True
        assert result["failure_count"] == 1
        assert len(result["retryable_installations"]) == 0
        assert len(result["permanent_installations"]) == 0
        assert len(result["unregistered_installations"]) == 0
        mock_disable.assert_not_called()
        assert_no_token_leaks(result, ["token_mismatch_123"])


# =====================================================================
# 4. send_each_for_multicast 自体が投げる例外・FCM初期化エラーテスト
# =====================================================================
def test_send_push_multicast_throws_invalid_argument():
    """send_each_for_multicast自体がInvalidArgumentErrorをthrow: config_error=True, retryable=0, token無効化0回"""
    event = {"category": "high", "post_id": "multi_inv"}
    installations = [
        {"installation_hash": "hash_1", "token": "token_multi_inv", "revision": 1}
    ]
    with patch.object(main, "get_fcm_app", return_value=MagicMock()), \
         patch.object(fcm_messaging, "send_each_for_multicast", side_effect=firebase_exceptions.InvalidArgumentError("Invalid payload")), \
         patch.object(main, "disable_token_if_unchanged") as mock_disable:
        result = main.send_formation_push(event, installations)
        assert result["config_error"] is True
        assert result["failure_count"] == 1
        assert len(result["retryable_installations"]) == 0
        assert len(result["permanent_installations"]) == 0
        assert len(result["unregistered_installations"]) == 0
        mock_disable.assert_not_called()
        assert_no_token_leaks(result, ["token_multi_inv"])


def test_send_push_multicast_throws_permission_denied():
    """send_each_for_multicast自体がPermissionDeniedErrorをthrow: config_error=True, retryable=0, token無効化0回"""
    event = {"category": "gw", "post_id": "perm_denied"}
    installations = [
        {"installation_hash": "hash_1", "token": "token_perm", "revision": 1}
    ]
    with patch.object(main, "get_fcm_app", return_value=MagicMock()), \
         patch.object(fcm_messaging, "send_each_for_multicast", side_effect=firebase_exceptions.PermissionDeniedError("Permission denied")), \
         patch.object(main, "disable_token_if_unchanged") as mock_disable:
        result = main.send_formation_push(event, installations)
        assert result["config_error"] is True
        assert result["failure_count"] == 1
        assert len(result["retryable_installations"]) == 0
        assert len(result["permanent_installations"]) == 0
        mock_disable.assert_not_called()
        assert_no_token_leaks(result, ["token_perm"])


def test_send_push_multicast_throws_unavailable():
    """send_each_for_multicast自体がUnavailableErrorをthrow: config_error=False, retryableに全件, token無効化0回"""
    event = {"category": "gw", "post_id": "unavail_test"}
    installations = [
        {"installation_hash": "hash_1", "token": "token_unavail", "revision": 1}
    ]
    with patch.object(main, "get_fcm_app", return_value=MagicMock()), \
         patch.object(fcm_messaging, "send_each_for_multicast", side_effect=firebase_exceptions.UnavailableError("Unavailable")), \
         patch.object(main, "disable_token_if_unchanged") as mock_disable:
        result = main.send_formation_push(event, installations)
        assert result["config_error"] is False
        assert result["failure_count"] == 1
        assert len(result["retryable_installations"]) == 1
        assert result["retryable_installations"][0]["installation_hash"] == "hash_1"
        assert len(result["permanent_installations"]) == 0
        mock_disable.assert_not_called()
        assert_no_token_leaks(result, ["token_unavail"])


def test_send_push_multicast_throws_unknown_exception():
    """send_each_for_multicast自体が未知Exceptionをthrow: config_error=False, 全対象retryable, permanent=0, token無効化0回"""
    event = {"category": "gw", "post_id": "unknown_err"}
    installations = [
        {"installation_hash": "hash_u1", "token": "token_u1", "revision": 1},
        {"installation_hash": "hash_u2", "token": "token_u2", "revision": 2},
    ]
    with patch.object(main, "get_fcm_app", return_value=MagicMock()), \
         patch.object(fcm_messaging, "send_each_for_multicast", side_effect=Exception("Something completely unexpected")), \
         patch.object(main, "disable_token_if_unchanged") as mock_disable:
        result = main.send_formation_push(event, installations)
        assert result["config_error"] is False
        assert result["failure_count"] == 2
        assert len(result["retryable_installations"]) == 2
        retry_hashes = [x["installation_hash"] for x in result["retryable_installations"]]
        assert retry_hashes == ["hash_u1", "hash_u2"]
        assert len(result["permanent_installations"]) == 0
        assert len(result["unregistered_installations"]) == 0
        mock_disable.assert_not_called()
        assert_no_token_leaks(result, ["token_u1", "token_u2"])


def test_send_push_individual_unknown_exception():
    """個別responseが未知Exception: retryable, permanent=0, token無効化0回"""
    event = {"category": "multi", "post_id": "indiv_unknown"}
    installations = [
        {"installation_hash": "hash_iu", "token": "token_iu_1", "revision": 1}
    ]
    unknown_exc = Exception("Custom unexpected gateway error")
    mock_batch = MockBatchResponse([MockSendResponse(success=False, exception=unknown_exc)])

    with patch.object(main, "get_fcm_app", return_value=MagicMock()), \
         patch.object(fcm_messaging, "send_each_for_multicast", return_value=mock_batch), \
         patch.object(main, "disable_token_if_unchanged") as mock_disable:
        result = main.send_formation_push(event, installations)
        assert result["config_error"] is False
        assert result["failure_count"] == 1
        assert len(result["retryable_installations"]) == 1
        assert result["retryable_installations"][0]["installation_hash"] == "hash_iu"
        assert len(result["permanent_installations"]) == 0
        assert len(result["unregistered_installations"]) == 0
        mock_disable.assert_not_called()
        assert_no_token_leaks(result, ["token_iu_1"])


def test_send_push_config_error():
    """FCM初期化エラー: config_error=True, retryable=0, permanent=0"""
    event = {"category": "gw", "post_id": "cfg_test"}
    installations = [
        {"installation_hash": "hash_1", "token": "secret_fcm_token_12345", "revision": 1}
    ]

    with patch.object(main, "get_fcm_app", side_effect=Exception("Missing credentials")), \
         patch.object(main, "disable_token_if_unchanged") as mock_disable:
        result = main.send_formation_push(event, installations)
        assert result["total_target"] == 1
        assert result["config_error"] is True
        assert result["failure_count"] == 1
        assert len(result["retryable_installations"]) == 0
        assert len(result["permanent_installations"]) == 0
        mock_disable.assert_not_called()
        assert_no_token_leaks(result, ["secret_fcm_token_12345"])


# =====================================================================
# 5. disable_token_if_unchanged のトランザクション動作テスト
# =====================================================================
class MemoryFirestore:
    def __init__(self):
        self.data = {}

    def collection(self, col_name):
        return MemoryCollection(self, col_name)

    def transaction(self):
        return MemoryTransaction(self)


class MemoryCollection:
    def __init__(self, db, name):
        self.db = db
        self.name = name

    def document(self, doc_id):
        return MemoryDocument(self.db, f"{self.name}/{doc_id}")


class MemorySnapshot:
    def __init__(self, data):
        self.exists = data is not None
        self._data = copy.deepcopy(data) if data is not None else None

    def to_dict(self):
        return copy.deepcopy(self._data) or {}


class MemoryDocument:
    def __init__(self, db, path):
        self.db = db
        self.path = path

    def get(self, transaction=None):
        if transaction and getattr(transaction, "written", False):
            raise Exception("Read-After-Write is prohibited in Firestore transactions")
        return MemorySnapshot(self.db.data.get(self.path))


class MemoryTransaction:
    def __init__(self, db):
        self.db = db
        self.written = False

    def set(self, doc_ref, update_data, merge=True):
        self.written = True
        current = copy.deepcopy(self.db.data.get(doc_ref.path, {}))
        for k, v in update_data.items():
            if v is main.firestore.DELETE_FIELD:
                current.pop(k, None)
            elif v is main.firestore.SERVER_TIMESTAMP:
                current[k] = "MOCK_TIMESTAMP"
            else:
                current[k] = v
        self.db.data[doc_ref.path] = current


def fake_transactional(function):
    def run(transaction, *args, **kwargs):
        return function(transaction, *args, **kwargs)
    return run


def test_disable_token_if_unchanged_success():
    mem_db = MemoryFirestore()
    installation_hash = "inst_hash_1"
    token_path = f"notification_tokens/{installation_hash}"
    cap_path = "portal_meta/notification_capacity"

    # 初期状態
    mem_db.data[token_path] = {
        "schema_version": 2,
        "enabled": True,
        "token": "valid_token",
        "revision": 5,
        "created_at": "old_timestamp",
    }
    mem_db.data[cap_path] = {"active_count": 10}

    with patch.object(main, "get_portal_db", return_value=mem_db), \
         patch.object(main.firestore, "transactional", fake_transactional):
        success = main.disable_token_if_unchanged(
            installation_hash=installation_hash,
            snapshot_revision=5,
            snapshot_token="valid_token",
        )

        assert success is True
        token_doc = mem_db.data[token_path]
        assert token_doc["enabled"] is False
        assert token_doc["revision"] == 6
        assert "token" not in token_doc
        assert token_doc["disabled_reason"] == "unregistered"
        assert mem_db.data[cap_path]["active_count"] == 9


def test_disable_token_if_unchanged_already_disabled_noop():
    """enabled=False の場合は完全に no-op (writeしない、active_count減算しない)"""
    mem_db = MemoryFirestore()
    installation_hash = "inst_hash_disabled"
    token_path = f"notification_tokens/{installation_hash}"
    cap_path = "portal_meta/notification_capacity"

    mem_db.data[token_path] = {
        "schema_version": 2,
        "enabled": False,
        "revision": 5,
    }
    mem_db.data[cap_path] = {"active_count": 10}

    with patch.object(main, "get_portal_db", return_value=mem_db), \
         patch.object(main.firestore, "transactional", fake_transactional):
        success = main.disable_token_if_unchanged(
            installation_hash=installation_hash,
            snapshot_revision=5,
            snapshot_token=None,
        )

        assert success is False
        assert mem_db.data[cap_path]["active_count"] == 10


def test_disable_token_if_unchanged_token_conflict():
    mem_db = MemoryFirestore()
    installation_hash = "inst_hash_1"
    token_path = f"notification_tokens/{installation_hash}"

    # クライアントが既に新しいトークンにローテーションしていた場合
    mem_db.data[token_path] = {
        "schema_version": 2,
        "enabled": True,
        "token": "new_rotated_token",
        "revision": 6,
    }

    with patch.object(main, "get_portal_db", return_value=mem_db), \
         patch.object(main.firestore, "transactional", fake_transactional):
        # 送信時の古いトークンを指定
        success = main.disable_token_if_unchanged(
            installation_hash=installation_hash,
            snapshot_revision=5,
            snapshot_token="old_stale_token",
        )

        # 変更されずにスキップされること
        assert success is False
        assert mem_db.data[token_path]["token"] == "new_rotated_token"
        assert mem_db.data[token_path]["enabled"] is True
        assert mem_db.data[token_path]["revision"] == 6


def test_disable_token_if_unchanged_doc_not_found():
    mem_db = MemoryFirestore()
    with patch.object(main, "get_portal_db", return_value=mem_db), \
         patch.object(main.firestore, "transactional", fake_transactional):
        success = main.disable_token_if_unchanged(
            installation_hash="non_existent",
            snapshot_revision=1,
            snapshot_token="some_token",
        )
        assert success is False


# =====================================================================
# 6. JavaScript / Service Worker 受信契約テスト (Node.js vm実行)
# =====================================================================
def test_javascript_sw_contract():
    """firebase-messaging-sw.js および formations.html の契約テストをNode.js環境で実行"""
    import subprocess

    js_test_code = r"""
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const swPath = path.join(__dirname, 'firebase-messaging-sw.js');
const swCode = fs.readFileSync(swPath, 'utf8');

function setupSWEnvironment(initialClients = []) {
  const notifications = [];
  const openedWindows = [];
  const listeners = {};
  let backgroundHandler = null;

  const mockSelf = {
    location: {
      href: 'https://huu-gbf.github.io/gbf-meron-portal/firebase-messaging-sw.js',
      origin: 'https://huu-gbf.github.io',
      pathname: '/gbf-meron-portal/firebase-messaging-sw.js',
    },
    addEventListener: (event, handler) => {
      listeners[event] = handler;
    },
    registration: {
      showNotification: (title, options) => {
        notifications.push({ title, options });
        return Promise.resolve();
      }
    },
    clients: {
      matchAll: () => Promise.resolve(initialClients),
      openWindow: (url) => {
        openedWindows.push(url);
        return Promise.resolve();
      }
    },
    importScripts: () => {},
    firebase: {
      initializeApp: () => {},
      messaging: () => ({
        onBackgroundMessage: (fn) => {
          backgroundHandler = fn;
        }
      })
    },
    isFirebaseConfigured: () => true,
    firebaseConfig: {},
  };

  const context = vm.createContext({
    self: mockSelf,
    globalThis: mockSelf,
    URL: URL,
    console: console,
    clients: mockSelf.clients,
    importScripts: mockSelf.importScripts,
    firebase: mockSelf.firebase,
    isFirebaseConfigured: mockSelf.isFirebaseConfigured,
    firebaseConfig: mockSelf.firebaseConfig,
  });

  vm.runInContext(swCode, context);

  return {
    mockSelf,
    listeners,
    getBackgroundHandler: () => backgroundHandler,
    notifications,
    openedWindows,
    getSafeTargetUrl: context.getSafeTargetUrl,
  };
}

(async () => {
  // 1. getSafeTargetUrl テスト
  const env = setupSWEnvironment();
  const getSafeTargetUrl = env.getSafeTargetUrl;
  const fallback = 'https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=gw';

  // 外部origin -> fallback
  assert.strictEqual(getSafeTargetUrl('https://evil.com/formations.html?category=gw'), fallback);
  assert.strictEqual(getSafeTargetUrl('http://huu-gbf.github.io/gbf-meron-portal/formations.html?category=gw'), fallback);

  // index.html / ルート -> fallback
  assert.strictEqual(getSafeTargetUrl('https://huu-gbf.github.io/gbf-meron-portal/index.html?category=gw'), fallback);
  assert.strictEqual(getSafeTargetUrl('https://huu-gbf.github.io/gbf-meron-portal/'), fallback);
  assert.strictEqual(getSafeTargetUrl('https://huu-gbf.github.io/other/formations.html?category=gw'), fallback);

  // 正しい gw / multi / high URL
  assert.strictEqual(
    getSafeTargetUrl('https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=gw'),
    'https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=gw'
  );
  assert.strictEqual(
    getSafeTargetUrl('https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=multi&post=abc-123_XYZ'),
    'https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=multi&post=abc-123_XYZ'
  );
  assert.strictEqual(
    getSafeTargetUrl('https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=high&post=post_99'),
    'https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=high&post=post_99'
  );

  // 不正category -> fallback
  assert.strictEqual(getSafeTargetUrl('https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=other'), fallback);
  assert.strictEqual(getSafeTargetUrl('https://huu-gbf.github.io/gbf-meron-portal/formations.html'), fallback);

  // 不正post -> fallback
  assert.strictEqual(getSafeTargetUrl('https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=gw&post=../evil'), fallback);
  assert.strictEqual(getSafeTargetUrl('https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=gw&post=<script>'), fallback);

  // 2. background 受信テスト
  // 正常background -> showNotification 1回
  const envBg = setupSWEnvironment();
  const bgHandler = envBg.getBackgroundHandler();
  assert(bgHandler, 'backgroundHandler must be registered');

  bgHandler({
    data: {
      type: 'formation_created',
      event_id: 'gw_post001',
      category: 'gw',
      post_id: 'post001',
      title: '【新着編成】古戦場用',
      body: '新しい編成が投稿されました',
      url: 'https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=gw&post=post001'
    }
  });

  assert.strictEqual(envBg.notifications.length, 1);
  const notif = envBg.notifications[0];
  assert.strictEqual(notif.title, '【新着編成】古戦場用');
  assert.strictEqual(notif.options.body, '新しい編成が投稿されました');
  assert.strictEqual(notif.options.tag, 'gw_post001');
  assert.strictEqual(notif.options.renotify, false);
  assert.strictEqual(notif.options.icon, './favicon.svg');
  assert.strictEqual(notif.options.badge, './favicon.svg');
  assert.strictEqual(notif.options.data.url, 'https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=gw&post=post001');

  // 不正category -> showNotification 0回
  const envBadCat = setupSWEnvironment();
  envBadCat.getBackgroundHandler()({
    data: {
      type: 'formation_created',
      category: 'invalid',
      post_id: 'post001'
    }
  });
  assert.strictEqual(envBadCat.notifications.length, 0);

  // 不正post -> showNotification 0回
  const envBadPost = setupSWEnvironment();
  envBadPost.getBackgroundHandler()({
    data: {
      type: 'formation_created',
      category: 'gw',
      post_id: '../evil'
    }
  });
  assert.strictEqual(envBadPost.notifications.length, 0);

  // 不正type -> showNotification 0回
  const envBadType = setupSWEnvironment();
  envBadType.getBackgroundHandler()({
    data: {
      type: 'other_event',
      category: 'gw',
      post_id: 'post001'
    }
  });
  assert.strictEqual(envBadType.notifications.length, 0);

  // 3. notificationclick テスト
  // 既存formationsタブあり -> navigate + focus
  let navigatedUrl = null;
  let focused = false;
  const mockExistingClient = {
    url: 'https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=gw',
    navigate: (url) => {
      navigatedUrl = url;
      return Promise.resolve();
    },
    focus: () => {
      focused = true;
      return Promise.resolve();
    }
  };

  const envClick1 = setupSWEnvironment([mockExistingClient]);
  const clickHandler1 = envClick1.listeners['notificationclick'];
  assert(clickHandler1, 'notificationclick listener must be registered');

  let closed = false;
  let waitUntilPromise = null;
  clickHandler1({
    notification: {
      close: () => { closed = true; },
      data: { url: 'https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=multi&post=post123' }
    },
    waitUntil: (p) => { waitUntilPromise = p; }
  });
  assert.strictEqual(closed, true);
  await waitUntilPromise;
  assert.strictEqual(navigatedUrl, 'https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=multi&post=post123');
  assert.strictEqual(focused, true);
  assert.strictEqual(envClick1.openedWindows.length, 0);

  // 対象タブなし -> openWindow
  const envClick2 = setupSWEnvironment([]);
  const clickHandler2 = envClick2.listeners['notificationclick'];
  let waitUntilPromise2 = null;
  clickHandler2({
    notification: {
      close: () => {},
      data: { url: 'https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=gw&post=post999' }
    },
    waitUntil: (p) => { waitUntilPromise2 = p; }
  });
  await waitUntilPromise2;
  assert.strictEqual(envClick2.openedWindows.length, 1);
  assert.strictEqual(envClick2.openedWindows[0], 'https://huu-gbf.github.io/gbf-meron-portal/formations.html?category=gw&post=post999');

  // 4. formations.html の契約チェック (OS Notification 0回)
  const formationsHtml = fs.readFileSync(path.join(__dirname, 'formations.html'), 'utf8');
  assert(!formationsHtml.includes('showNotification'), 'formations.html must never call showNotification');
  assert(!formationsHtml.includes('new Notification('), 'formations.html must never instantiate new Notification');

  console.log('ALL_JS_SW_CONTRACTS_PASSED');
})();
"""

    result = subprocess.run(
        ["node", "-e", js_test_code],
        cwd=Path(__file__).parent,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"Node.js contract test failed:\nSTDOUT: {result.stdout}\nSTDERR: {result.stderr}"
    assert "ALL_JS_SW_CONTRACTS_PASSED" in result.stdout
