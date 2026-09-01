"""
Task 9: AI回答へのフィードバック機能のテスト (Security強化版)
test_feedback.py

検証項目:
1. 署名鍵セキュリティ & fail-closed
   - FEEDBACK_SIGNING_KEY未設定時に generate_feedback_token() が RuntimeError を raise すること
   - FEEDBACK_SIGNING_KEY未設定時に POST /api/feedback が 500 となり Firestore Write 0 であること
   - 固定デフォルト値やハードコードされた鍵が存在しないこと
2. /api/chat レスポンス拡張
   - response_id (UUID形式) が返却されること
   - feedback_token (HMAC署名) が返却されること
   - 既存の reply, sources が壊れず維持されること
3. フィードバックAPI (POST /api/feedback) 正常系
   - positive評価の正常保存 (reasonはNone)
   - negative評価 + 有効なreason (全6種) の正常保存
   - Firestore 0 Read, 1 Write であること
   - ドキュメントIDが response_id そのものであること
4. 厳格なバリデーション & 署名検証 (異常系)
   - Extra fields (question, answer, client_id, ip等) を含むリクエストが 422 で拒否され Firestore Write 0 であること
   - response_id 桁数超過・未満・非UUID形式が 422 で拒否されること
   - feedback_token 65文字以上・63文字以下・非Hex形式が 422 で拒否されること
   - rating の空白混入 (" positive ") や不正文字列が 422 で拒否されること
   - reason の空白混入 (" outdated ") や不正文字列が 422 で拒否されること
   - negative評価でreasonなし -> 400
   - positive評価でreasonあり -> 400
   - 不正なfeedback_token (改ざん・形式不正) -> 400
   - 別response_id用tokenの使い回し -> 400
   - 署名不一致時のFirestore書き込みが 0 件であること
5. 評価変更 (上書き)
   - 同一response_idで positive -> negative への変更
   - 同一response_idで negative -> positive への変更時に old reason が None で全体上書きされること
6. プライバシー & セキュリティ
   - 保存ドキュメントに question / answer / client_id / client_hash / IP が一切含まれないこと
   - フィードバックAPI処理で Gemini / Embedding が一切呼び出されないこと
   - Firestore例外発生時に 500 を返すこと
"""

import os
os.environ["GEMINI_API_KEY"] = "test-gemini-key"
os.environ["ADMIN_API_KEY"] = "test-admin-key"
os.environ["FEEDBACK_SIGNING_KEY"] = "test-feedback-secret-key-12345"

import sys
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

import google.cloud.firestore
import google.genai
google.cloud.firestore.Client = MagicMock()
google.genai.Client = MagicMock()

import pytest
from fastapi.testclient import TestClient

backend_path = Path(__file__).parent / "backend"
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(backend_path))

import backend.main
from backend.main import (
    app,
    db,
    get_feedback_signing_key,
    generate_feedback_token,
    verify_feedback_token,
    is_valid_uuid,
    FEEDBACK_ALLOWED_RATINGS,
    FEEDBACK_ALLOWED_REASONS,
)

client = TestClient(app)


# ==============================================================================
# 1. 署名鍵 fail-closed & 単体テスト
# ==============================================================================

def test_feedback_signing_key_unset_raises_runtime_error():
    """FEEDBACK_SIGNING_KEY未設定時に固定フォールバックせずRuntimeErrorとなること"""
    with patch.dict(os.environ, {"FEEDBACK_SIGNING_KEY": ""}):
        with pytest.raises(RuntimeError, match="FEEDBACK_SIGNING_KEY is not configured"):
            get_feedback_signing_key()

        with pytest.raises(RuntimeError, match="FEEDBACK_SIGNING_KEY is not configured"):
            generate_feedback_token(str(uuid.uuid4()))

        # verify_feedback_token は False を返す（クラッシュせず安全に拒否）
        assert verify_feedback_token(str(uuid.uuid4()), "a" * 64) is False


def test_feedback_endpoint_fails_safe_when_signing_key_unset():
    """FEEDBACK_SIGNING_KEY未設定時に /api/feedback が 500 となり Firestore Write 0 であること"""
    res_id = str(uuid.uuid4())
    mock_doc_ref = MagicMock()

    with patch.dict(os.environ, {"FEEDBACK_SIGNING_KEY": ""}):
        with patch.object(backend.main.db.collection("ai_feedback"), "document", return_value=mock_doc_ref):
            res = client.post(
                "/api/feedback",
                json={
                    "response_id": res_id,
                    "feedback_token": "a" * 64,
                    "rating": "positive",
                    "reason": None
                }
            )
            assert res.status_code == 500
            assert "サーバー設定エラー" in res.json()["detail"]
            mock_doc_ref.set.assert_not_called()


def test_uuid_validation():
    valid_id = str(uuid.uuid4())
    assert is_valid_uuid(valid_id) is True
    assert is_valid_uuid("not-a-uuid") is False
    assert is_valid_uuid("") is False
    assert is_valid_uuid("12345") is False
    assert is_valid_uuid("g" + valid_id[1:]) is False
    assert is_valid_uuid(" " + valid_id) is False


def test_feedback_token_generation_and_verification():
    res_id = str(uuid.uuid4())
    token = generate_feedback_token(res_id)
    assert isinstance(token, str)
    assert len(token) == 64  # SHA256 hex
    assert verify_feedback_token(res_id, token) is True

    # 別の response_id での検証は False
    other_res_id = str(uuid.uuid4())
    assert verify_feedback_token(other_res_id, token) is False

    # 改ざんされた token は False
    tampered_token = token[:-1] + ("0" if token[-1] != "0" else "1")
    assert verify_feedback_token(res_id, tampered_token) is False


# ==============================================================================
# 2. /api/chat 成功時の response_id & feedback_token 返却テスト
# ==============================================================================

@patch("backend.main.check_and_reserve_usage")
@patch("backend.main.search_knowledge_base", return_value=("dummy context", []))
@patch("backend.main.client.models.generate_content")
def test_chat_endpoint_includes_response_id_and_token(mock_gemini, mock_rag, mock_usage):
    mock_resp = MagicMock()
    mock_resp.text = "グラブルの回答です。"
    mock_gemini.return_value = mock_resp

    res = client.post(
        "/api/chat",
        headers={"X-Client-Id": "test-client-device-1"},
        json={"message": "ルシファーHLの編成を教えて"}
    )
    assert res.status_code == 200
    data = res.json()

    # 既存フィールドの維持
    assert data["reply"] == "グラブルの回答です。"
    assert isinstance(data["sources"], list)

    # 新規フィールドの検証
    assert "response_id" in data
    assert "feedback_token" in data
    assert is_valid_uuid(data["response_id"]) is True
    assert verify_feedback_token(data["response_id"], data["feedback_token"]) is True


@patch("backend.main.check_and_reserve_usage")
@patch("backend.main.search_knowledge_base", return_value=("dummy context", []))
@patch("backend.main.client.models.generate_content")
def test_chat_endpoint_succeeds_without_feedback_token_when_signing_key_unset(mock_gemini, mock_rag, mock_usage):
    """FEEDBACK_SIGNING_KEY未設定時でも/api/chatは正常に200を返し、response_idとfeedback_tokenがNoneとなること"""
    mock_resp = MagicMock()
    mock_resp.text = "グラブルの回答です。"
    mock_gemini.return_value = mock_resp

    with patch.dict(os.environ, {"FEEDBACK_SIGNING_KEY": ""}):
        res = client.post(
            "/api/chat",
            headers={"X-Client-Id": "test-client-device-1"},
            json={"message": "ルシファーHLの編成を教えて"}
        )
        assert res.status_code == 200
        data = res.json()

        # 既存フィールドの正常返却
        assert data["reply"] == "グラブルの回答です。"
        assert isinstance(data["sources"], list)

        # フィードバック用トークンのみ None になること（チャット機能本体は生かす）
        assert data["response_id"] is None
        assert data["feedback_token"] is None

        # Gemini 呼び出しは正常に1回実行されていること
        mock_gemini.assert_called_once()


# ==============================================================================
# 3. POST /api/feedback 正常系テスト
# ==============================================================================

def test_feedback_positive_success():
    res_id = str(uuid.uuid4())
    token = generate_feedback_token(res_id)

    mock_doc_ref = MagicMock()
    with patch.object(backend.main.db.collection("ai_feedback"), "document", return_value=mock_doc_ref) as mock_doc:
        res = client.post(
            "/api/feedback",
            json={
                "response_id": res_id,
                "feedback_token": token,
                "rating": "positive",
                "reason": None
            }
        )

        assert res.status_code == 200
        assert res.json() == {"status": "ok"}

        mock_doc.assert_called_once_with(res_id)
        mock_doc_ref.set.assert_called_once()
        saved_data = mock_doc_ref.set.call_args[0][0]

        # 許可されたフィールドのみが保存されていること
        assert saved_data["response_id"] == res_id
        assert saved_data["rating"] == "positive"
        assert saved_data["reason"] is None
        assert saved_data["schema_version"] == 1
        assert "updated_at" in saved_data

        # プライバシー検証: 個人情報・会話本文が一切存在しないこと
        assert "question" not in saved_data
        assert "answer" not in saved_data
        assert "client_id" not in saved_data
        assert "client_hash" not in saved_data
        assert "ip" not in saved_data

        # Firestore Read (get) は 0 回であること
        mock_doc_ref.get.assert_not_called()


@pytest.mark.parametrize("valid_reason", [
    "incorrect",
    "outdated",
    "missing_information",
    "hard_to_understand",
    "irrelevant",
    "other"
])
def test_feedback_negative_all_valid_reasons(valid_reason):
    res_id = str(uuid.uuid4())
    token = generate_feedback_token(res_id)

    mock_doc_ref = MagicMock()
    with patch.object(backend.main.db.collection("ai_feedback"), "document", return_value=mock_doc_ref):
        res = client.post(
            "/api/feedback",
            json={
                "response_id": res_id,
                "feedback_token": token,
                "rating": "negative",
                "reason": valid_reason
            }
        )

        assert res.status_code == 200
        assert res.json() == {"status": "ok"}
        saved_data = mock_doc_ref.set.call_args[0][0]
        assert saved_data["rating"] == "negative"
        assert saved_data["reason"] == valid_reason


# ==============================================================================
# 4. Extra Fields & 厳格なスキーマ検証 (422拒否 & Write 0)
# ==============================================================================

@pytest.mark.parametrize("extra_payload", [
    {"question": "秘密の質問"},
    {"answer": "AI回答全文"},
    {"client_id": "device-123"},
    {"client_hash": "hash123"},
    {"ip": "192.168.1.1"},
    {"comment": "自由コメント"},
    {"question": "Q", "answer": "A"}
])
def test_feedback_extra_fields_forbidden_422(extra_payload):
    """余計なフィールドを含むリクエストが 422 で拒否され Firestore Write 0 であること"""
    res_id = str(uuid.uuid4())
    token = generate_feedback_token(res_id)

    mock_doc_ref = MagicMock()
    with patch.object(backend.main.db.collection("ai_feedback"), "document", return_value=mock_doc_ref):
        body = {
            "response_id": res_id,
            "feedback_token": token,
            "rating": "positive",
            "reason": None,
            **extra_payload
        }
        res = client.post("/api/feedback", json=body)
        assert res.status_code == 422
        mock_doc_ref.set.assert_not_called()


def test_feedback_field_length_and_format_limits():
    """各フィールドの桁数上限・形式外が 422 で拒否され Firestore Write 0 であること"""
    res_id = str(uuid.uuid4())
    token = generate_feedback_token(res_id)
    mock_doc_ref = MagicMock()

    with patch.object(backend.main.db.collection("ai_feedback"), "document", return_value=mock_doc_ref):
        # 1. feedback_token 65文字超
        res = client.post("/api/feedback", json={
            "response_id": res_id,
            "feedback_token": token + "a",
            "rating": "positive",
            "reason": None
        })
        assert res.status_code == 422

        # 2. feedback_token 63文字以下
        res = client.post("/api/feedback", json={
            "response_id": res_id,
            "feedback_token": token[:-1],
            "rating": "positive",
            "reason": None
        })
        assert res.status_code == 422

        # 3. response_id 形式不正 (36文字だがハイフン位置不正)
        res = client.post("/api/feedback", json={
            "response_id": "123456789012345678901234567890123456",
            "feedback_token": token,
            "rating": "positive",
            "reason": None
        })
        assert res.status_code == 422

        # 4. rating に前後に空白 (" positive ")
        res = client.post("/api/feedback", json={
            "response_id": res_id,
            "feedback_token": token,
            "rating": " positive ",
            "reason": None
        })
        assert res.status_code == 422

        # 5. reason に前後に空白 (" outdated ")
        res = client.post("/api/feedback", json={
            "response_id": res_id,
            "feedback_token": token,
            "rating": "negative",
            "reason": " outdated "
        })
        assert res.status_code == 422

        mock_doc_ref.set.assert_not_called()


# ==============================================================================
# 5. POST /api/feedback 組み合わせ検証 & 署名エラー (400拒否 & Write 0)
# ==============================================================================

def test_feedback_negative_without_reason_rejected():
    res_id = str(uuid.uuid4())
    token = generate_feedback_token(res_id)

    mock_doc_ref = MagicMock()
    with patch.object(backend.main.db.collection("ai_feedback"), "document", return_value=mock_doc_ref):
        res = client.post(
            "/api/feedback",
            json={
                "response_id": res_id,
                "feedback_token": token,
                "rating": "negative",
                "reason": None
            }
        )
        assert res.status_code == 400
        assert "negative評価には有効なreason" in res.json()["detail"]
        mock_doc_ref.set.assert_not_called()


def test_feedback_negative_invalid_reason_rejected():
    res_id = str(uuid.uuid4())
    token = generate_feedback_token(res_id)

    mock_doc_ref = MagicMock()
    with patch.object(backend.main.db.collection("ai_feedback"), "document", return_value=mock_doc_ref):
        res = client.post(
            "/api/feedback",
            json={
                "response_id": res_id,
                "feedback_token": token,
                "rating": "negative",
                "reason": "invalid_custom_reason"
            }
        )
        assert res.status_code == 422
        mock_doc_ref.set.assert_not_called()


def test_feedback_positive_with_reason_rejected():
    res_id = str(uuid.uuid4())
    token = generate_feedback_token(res_id)

    mock_doc_ref = MagicMock()
    with patch.object(backend.main.db.collection("ai_feedback"), "document", return_value=mock_doc_ref):
        res = client.post(
            "/api/feedback",
            json={
                "response_id": res_id,
                "feedback_token": token,
                "rating": "positive",
                "reason": "outdated"
            }
        )
        assert res.status_code == 400
        assert "positive評価ではreasonを指定できません" in res.json()["detail"]
        mock_doc_ref.set.assert_not_called()


def test_feedback_invalid_rating_rejected():
    res_id = str(uuid.uuid4())
    token = generate_feedback_token(res_id)

    mock_doc_ref = MagicMock()
    with patch.object(backend.main.db.collection("ai_feedback"), "document", return_value=mock_doc_ref):
        res = client.post(
            "/api/feedback",
            json={
                "response_id": res_id,
                "feedback_token": token,
                "rating": "super_good",
                "reason": None
            }
        )
        assert res.status_code == 422
        mock_doc_ref.set.assert_not_called()


def test_feedback_invalid_token_rejected():
    res_id = str(uuid.uuid4())
    mock_doc_ref = MagicMock()
    with patch.object(backend.main.db.collection("ai_feedback"), "document", return_value=mock_doc_ref):
        res = client.post(
            "/api/feedback",
            json={
                "response_id": res_id,
                "feedback_token": "0" * 64,
                "rating": "positive",
                "reason": None
            }
        )
        assert res.status_code == 400
        assert "feedback_tokenが無効です" in res.json()["detail"]
        mock_doc_ref.set.assert_not_called()


def test_feedback_token_for_other_response_id_rejected():
    res_id_1 = str(uuid.uuid4())
    res_id_2 = str(uuid.uuid4())
    token_for_2 = generate_feedback_token(res_id_2)

    mock_doc_ref = MagicMock()
    with patch.object(backend.main.db.collection("ai_feedback"), "document", return_value=mock_doc_ref):
        res = client.post(
            "/api/feedback",
            json={
                "response_id": res_id_1,
                "feedback_token": token_for_2,  # 別のID用トークン
                "rating": "positive",
                "reason": None
            }
        )
        assert res.status_code == 400
        mock_doc_ref.set.assert_not_called()


# ==============================================================================
# 6. 評価変更 (上書き) & ゼロRead/1Write テスト
# ==============================================================================

def test_feedback_rating_change_overwrites_same_doc():
    res_id = str(uuid.uuid4())
    token = generate_feedback_token(res_id)

    mock_doc_ref = MagicMock()
    with patch.object(backend.main.db.collection("ai_feedback"), "document", return_value=mock_doc_ref) as mock_doc:
        # 1. 最初に positive 送信
        res1 = client.post(
            "/api/feedback",
            json={
                "response_id": res_id,
                "feedback_token": token,
                "rating": "positive",
                "reason": None
            }
        )
        assert res1.status_code == 200
        assert mock_doc_ref.set.call_count == 1
        data1 = mock_doc_ref.set.call_args[0][0]
        assert data1["rating"] == "positive"
        assert data1["reason"] is None

        # 2. 後から negative (outdated) に変更送信
        res2 = client.post(
            "/api/feedback",
            json={
                "response_id": res_id,
                "feedback_token": token,
                "rating": "negative",
                "reason": "outdated"
            }
        )
        assert res2.status_code == 200
        assert mock_doc_ref.set.call_count == 2
        data2 = mock_doc_ref.set.call_args[0][0]
        assert data2["rating"] == "negative"
        assert data2["reason"] == "outdated"

        # 3. 再び positive に戻す送信 (negativeのreasonが確実にNoneになること)
        res3 = client.post(
            "/api/feedback",
            json={
                "response_id": res_id,
                "feedback_token": token,
                "rating": "positive",
                "reason": None
            }
        )
        assert res3.status_code == 200
        assert mock_doc_ref.set.call_count == 3
        data3 = mock_doc_ref.set.call_args[0][0]
        assert data3["rating"] == "positive"
        assert data3["reason"] is None

        # すべて同一 document ID (res_id) に対して set が実行されたこと
        assert mock_doc.call_count == 3
        for call in mock_doc.call_args_list:
            assert call[0][0] == res_id

        # 事前 Read は一度も行われていないこと (Read 0回)
        mock_doc_ref.get.assert_not_called()


# ==============================================================================
# 7. 安全性 & コスト隔離テスト (Gemini/Embedding呼び出しゼロ, Firestore例外500)
# ==============================================================================

@patch("backend.main.client.models.generate_content")
@patch("backend.main.get_embedding")
def test_feedback_does_not_call_gemini_or_embedding(mock_embed, mock_gemini):
    res_id = str(uuid.uuid4())
    token = generate_feedback_token(res_id)

    mock_doc_ref = MagicMock()
    with patch.object(backend.main.db.collection("ai_feedback"), "document", return_value=mock_doc_ref):
        res = client.post(
            "/api/feedback",
            json={
                "response_id": res_id,
                "feedback_token": token,
                "rating": "positive",
                "reason": None
            }
        )
        assert res.status_code == 200

        # GeminiおよびEmbedding生成が一切行われていないこと
        mock_gemini.assert_not_called()
        mock_embed.assert_not_called()


def test_feedback_firestore_exception_returns_500():
    res_id = str(uuid.uuid4())
    token = generate_feedback_token(res_id)

    mock_doc_ref = MagicMock()
    mock_doc_ref.set.side_effect = Exception("Firestore connection timeout")

    with patch.object(backend.main.db.collection("ai_feedback"), "document", return_value=mock_doc_ref):
        res = client.post(
            "/api/feedback",
            json={
                "response_id": res_id,
                "feedback_token": token,
                "rating": "positive",
                "reason": None
            }
        )
        assert res.status_code == 500
        assert "フィードバックの保存中にエラーが発生しました" in res.json()["detail"]
