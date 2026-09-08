import pytest
import os
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
import sys

# Mock google clients and firestore before importing backend.main
sys.modules['google.cloud.firestore'] = MagicMock()
sys.modules['google.cloud.firestore.Client'] = MagicMock()
sys.modules['google.genai'] = MagicMock()

os.environ["GEMINI_API_KEY"] = "test"
os.environ["ADMIN_API_KEY"] = "test_admin_key"

from backend.main import app, MAX_TXT_UPLOAD_BYTES

client = TestClient(app)

HEADERS = {"X-Admin-Key": "test_admin_key"}

# ---------------------------------------------------------
# A. filename validation
# ---------------------------------------------------------
@pytest.mark.parametrize("filename", [
    "knowledge.txt",
    "knowledge.md",
    "KNOWLEDGE.MD",
    "古戦場記録.md"
])
def test_filename_validation_pass(filename):
    files = {"file": (filename, b"valid text content", "text/plain")}
    response = client.post("/api/admin/file-knowledge/extract", files=files, headers=HEADERS)
    assert response.status_code == 200

@pytest.mark.parametrize("filename", [
    "knowledge.pdf",
    "knowledge.docx",
    "knowledge.exe",
    "knowledge.md.exe"
])
def test_filename_validation_reject(filename):
    files = {"file": (filename, b"valid text content", "text/plain")}
    response = client.post("/api/admin/file-knowledge/extract", files=files, headers=HEADERS)
    assert response.status_code == 400
    assert "未対応のファイル形式" in response.text

# ---------------------------------------------------------
# B. Markdown本文互換性
# ---------------------------------------------------------
def test_markdown_content_compatibility():
    md_content = """---
title: 古戦場予選
category: guildwar
tags:
  - 古戦場
  - 予選
---

# 古戦場予選

平日の18時以降は速度が上昇する傾向がある。

| 回 | 倍率 |
|---|---:|
| 83 | 2.81 |
| 82 | 2.62 |

関連:
[[古戦場記録]]"""
    files = {"file": ("test.md", md_content.encode("utf-8"), "text/markdown")}
    response = client.post("/api/admin/file-knowledge/extract", files=files, headers=HEADERS)
    assert response.status_code == 200
    data = response.json()
    extracted_text = data.get("text", "")
    
    # 1. 日本語保持
    assert "古戦場予選" in extracted_text
    assert "平日の18時以降は速度が上昇する傾向がある。" in extracted_text
    # 2. frontmatter保持
    assert "title: 古戦場予選" in extracted_text
    assert "category: guildwar" in extracted_text
    # 3. Markdown table保持
    assert "| 83 | 2.81 |" in extracted_text
    # 4. Wiki Link保持
    assert "[[古戦場記録]]" in extracted_text

# ---------------------------------------------------------
# C. existing defenses
# ---------------------------------------------------------
def test_empty_file_rejection():
    files = {"file": ("empty.md", b"", "text/markdown")}
    response = client.post("/api/admin/file-knowledge/extract", files=files, headers=HEADERS)
    assert response.status_code == 400
    assert "ファイルが空です" in response.text

def test_whitespace_only_rejection():
    files = {"file": ("whitespace.md", b"   \n  \t\n", "text/markdown")}
    response = client.post("/api/admin/file-knowledge/extract", files=files, headers=HEADERS)
    assert response.status_code == 400
    assert "空白のみ" in response.text or "空です" in response.text

def test_null_byte_rejection():
    files = {"file": ("nullbyte.md", b"hello\x00world", "text/markdown")}
    response = client.post("/api/admin/file-knowledge/extract", files=files, headers=HEADERS)
    assert response.status_code == 400
    assert "バイナリファイルは指定できません" in response.text

def test_upload_size_limit_rejection():
    # MAX_TXT_UPLOAD_BYTES を超えるデータを送信
    large_content = b"a" * (MAX_TXT_UPLOAD_BYTES + 10)
    files = {"file": ("large.md", large_content, "text/markdown")}
    response = client.post("/api/admin/file-knowledge/extract", files=files, headers=HEADERS)
    assert response.status_code == 400
    assert "ファイルサイズが大きすぎます" in response.text

# ---------------------------------------------------------
# D. TXT regression
# ---------------------------------------------------------
def test_txt_regression():
    files = {"file": ("regression.txt", b"this is a simple txt test", "text/plain")}
    response = client.post("/api/admin/file-knowledge/extract", files=files, headers=HEADERS)
    assert response.status_code == 200
    data = response.json()
    assert "this is a simple txt test" in data.get("text", "")
    assert data.get("filename") == "regression.txt"
