import os
import sys
import hashlib
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types
from google.cloud import firestore
from google.cloud.firestore_v1.vector import Vector

load_dotenv()

# -------------------------
# Gemini / Firestore 初期化
# -------------------------

api_key = os.getenv("GEMINI_API_KEY")

if not api_key:
    raise RuntimeError("GEMINI_API_KEY が設定されていません")

client = genai.Client(api_key=api_key)
db = firestore.Client()

EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_DIMENSIONS = 768


def get_embedding(text: str) -> list[float]:
    """文章を768次元のEmbeddingに変換"""

    response = client.models.embed_content(
        model=EMBEDDING_MODEL,
        contents=text,
        config=types.EmbedContentConfig(
            output_dimensionality=EMBEDDING_DIMENSIONS
        ),
    )

    return response.embeddings[0].values


def read_file(file_path: Path) -> str:
    """txt / md / pdf の内容を読み込む"""

    extension = file_path.suffix.lower()

    if extension in [".txt", ".md"]:
        return file_path.read_text(
            encoding="utf-8-sig"
        )

    elif extension == ".pdf":

        try:
            from pypdf import PdfReader
        except ImportError:
            raise RuntimeError(
                "PDFを読むには pypdf が必要です。\n"
                "pip install pypdf を実行してください。"
            )

        reader = PdfReader(str(file_path))

        texts = []

        for page in reader.pages:
            text = page.extract_text()

            if text:
                texts.append(text)

        return "\n\n".join(texts)

    else:
        raise ValueError(
            f"未対応のファイル形式です: {extension}\n"
            "現在は .txt / .md / .pdf に対応しています。"
        )


def split_text(text: str, max_chars: int = 1500) -> list[str]:
    """文章をRAG検索用のチャンクへ分割"""

    paragraphs = [
        p.strip()
        for p in text.split("\n\n")
        if p.strip()
    ]

    chunks = []
    current_chunk = ""

    for paragraph in paragraphs:

        # 1段落だけで大きすぎる場合
        if len(paragraph) > max_chars:

            if current_chunk:
                chunks.append(current_chunk)
                current_chunk = ""

            for i in range(0, len(paragraph), max_chars):
                piece = paragraph[i:i + max_chars]

                if piece.strip():
                    chunks.append(piece.strip())

            continue

        # 現在のチャンクに追加できる場合
        if len(current_chunk) + len(paragraph) + 2 <= max_chars:

            if current_chunk:
                current_chunk += "\n\n"

            current_chunk += paragraph

        else:

            if current_chunk:
                chunks.append(current_chunk)

            current_chunk = paragraph

    if current_chunk:
        chunks.append(current_chunk)

    return chunks


def ingest_file(file_path_string: str):

    file_path = Path(file_path_string)

    if not file_path.exists():
        print(f"ファイルが見つかりません: {file_path}")
        return

    print()
    print("==============================")
    print("外部ファイル取り込み開始")
    print("==============================")
    print(f"ファイル: {file_path.name}")

    # ファイル内容取得
    text = read_file(file_path)

    if not text.strip():
        print("ファイルから文章を取得できませんでした。")
        return

    # チャンク分割
    chunks = split_text(text)

    print(f"チャンク数: {len(chunks)}")
    print()

    collection_ref = db.collection("knowledge")

    # 同じファイルを再登録しても同じIDになるようにする
    source_id = hashlib.sha1(
        file_path.name.encode("utf-8")
    ).hexdigest()[:12]

    success_count = 0

    for i, chunk_text in enumerate(chunks):

        print(
            f"処理中 ({i + 1}/{len(chunks)}): "
            f"{chunk_text[:30]}..."
        )

        try:

            vector = get_embedding(chunk_text)

            doc_data = {
                "content": chunk_text,
                "source": file_path.name,
                "source_type": "file",
                "file_type": file_path.suffix.lower(),
                "embedding_field": Vector(vector),
                "active": True,
            }

            doc_id = f"file_{source_id}_chunk_{i}"

            collection_ref.document(doc_id).set(
                doc_data
            )

            success_count += 1

        except Exception as e:

            print(
                f"チャンク {i} の処理中に"
                f"エラーが発生しました: {e}"
            )

    print()
    print(
        f"完了: {success_count}/{len(chunks)} 件を"
        "Firestoreに保存しました。"
    )


if __name__ == "__main__":

    if len(sys.argv) < 2:

        print("使い方:")
        print('python ingest_file.py "ファイルの場所"')

        sys.exit(1)

    ingest_file(sys.argv[1])