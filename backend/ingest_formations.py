import os
import base64
import hashlib

from dotenv import load_dotenv

from google import genai
from google.genai import types

from google.cloud import firestore
from google.cloud.firestore_v1.vector import Vector
from google.cloud.firestore_v1.base_query import FieldFilter


# =========================================================
# .env 読み込み
# =========================================================

load_dotenv()


# =========================================================
# プロジェクト設定
# =========================================================

# 編成共有掲示板があるFirebaseプロジェクト
SOURCE_PROJECT_ID = "gbf-meron-portal"

# AIのknowledgeがあるFirestoreプロジェクト
TARGET_PROJECT_ID = "gbf-ai-agent"


# =========================================================
# 編成共有コレクション
# =========================================================

FORMATION_COLLECTIONS = {
    "gw": {
        "name": "古戦場用",
        "collection": "formations_gw",
        "url": (
            "https://huu-gbf.github.io/"
            "gbf-meron-portal/"
            "formations.html?category=gw"
        ),
    },

    "multi": {
        "name": "他マルチ",
        "collection": "formations_multi",
        "url": (
            "https://huu-gbf.github.io/"
            "gbf-meron-portal/"
            "formations.html?category=multi"
        ),
    },

    "high": {
        "name": "高難易度",
        "collection": "formations_high",
        "url": (
            "https://huu-gbf.github.io/"
            "gbf-meron-portal/"
            "formations.html?category=high"
        ),
    },
}


# =========================================================
# Gemini設定
# =========================================================

api_key = os.getenv("GEMINI_API_KEY")

if not api_key:
    raise RuntimeError(
        "GEMINI_API_KEY が設定されていません"
    )


client = genai.Client(
    api_key=api_key
)


# 画像解析
VISION_MODEL = "gemini-3-flash-preview"

# Embedding
EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_DIMENSIONS = 768


# =========================================================
# Firestore
# =========================================================

# 編成共有を読む
source_db = firestore.Client(
    project=SOURCE_PROJECT_ID
)

# AI knowledgeへ書き込む
target_db = firestore.Client(
    project=TARGET_PROJECT_ID
)


# =========================================================
# インジェストのバージョン
#
# 将来解析方法を変更した時、
# この文字列を v2 などへ変えると
# 全投稿を再解析できます。
# =========================================================

INGEST_VERSION = "formation_v1"


# =========================================================
# Embedding作成
# =========================================================

def get_embedding(
    text: str
) -> list[float]:

    response = client.models.embed_content(
        model=EMBEDDING_MODEL,

        contents=text,

        config=types.EmbedContentConfig(
            output_dimensionality=
                EMBEDDING_DIMENSIONS
        ),
    )

    return response.embeddings[0].values


# =========================================================
# 投稿のハッシュ作成
#
# 投稿内容が変わっていない場合、
# Gemini画像解析をもう一度行わないようにします。
# =========================================================

def calculate_post_hash(
    category_key: str,
    post_id: str,
    data: dict
) -> str:

    hasher = hashlib.sha256()

    values = [
        INGEST_VERSION,
        category_key,
        post_id,
        str(data.get("name", "")),
        str(data.get("comment", "")),
        str(data.get("timestamp", "")),
    ]


    for value in values:

        hasher.update(
            value.encode(
                "utf-8",
                errors="ignore"
            )
        )


    images = data.get(
        "images",
        []
    )


    if isinstance(images, list):

        for image in images:

            if isinstance(image, str):

                hasher.update(
                    image.encode(
                        "utf-8",
                        errors="ignore"
                    )
                )


    return hasher.hexdigest()


# =========================================================
# Data URLを画像バイトへ変換
# =========================================================

def decode_data_url(
    image_data: str
):

    if not isinstance(
        image_data,
        str
    ):

        return None


    # 例:
    # data:image/jpeg;base64,/9j/4AAQ...
    if not image_data.startswith(
        "data:"
    ):

        return None


    try:

        header, encoded = (
            image_data.split(
                ",",
                1
            )
        )


        # MIMEタイプ取得
        mime_type = (
            header
            .split(";")[0]
            .replace(
                "data:",
                ""
            )
        )


        image_bytes = (
            base64.b64decode(
                encoded
            )
        )


        return (
            image_bytes,
            mime_type
        )


    except Exception as e:

        print(
            f"画像Data URLの"
            f"変換失敗: {e}"
        )

        return None


# =========================================================
# Geminiで編成画像を解析
# =========================================================

def analyze_formation_images(
    images: list,
    category_name: str,
    player_name: str,
    comment: str
) -> str:

    if not images:

        return ""


    image_parts = []


    for index, image_data in enumerate(
        images[:4]
    ):

        decoded = decode_data_url(
            image_data
        )


        if not decoded:

            print(
                f"  画像{index + 1}: "
                "読み込みできませんでした"
            )

            continue


        image_bytes, mime_type = (
            decoded
        )


        try:

            image_part = (
                types.Part.from_bytes(
                    data=image_bytes,
                    mime_type=mime_type
                )
            )


            image_parts.append(
                image_part
            )


            print(
                f"  画像{index + 1}: "
                f"準備OK "
                f"({mime_type})"
            )


        except Exception as e:

            print(
                f"  画像{index + 1}: "
                f"準備失敗 {e}"
            )


    if not image_parts:

        return ""


    prompt = f"""
これはグランブルーファンタジーの
騎空団内で共有された編成スクリーンショットです。

カテゴリ:
{category_name}

投稿者:
{player_name}

投稿者コメント:
{comment}

画像から検索に役立つ情報を日本語で整理してください。

特に確認してください。

・バトル名や敵の名前
・属性
・主人公ジョブ
・編成キャラクター
・召喚石
・武器
・アビリティ
・ターン数
・HPや討伐状況
・フルオートか手動か
・奥義ON/OFF
・編成の目的
・その他、画像から明確に読み取れる重要情報

【重要】

画像から確認できない情報は推測しないでください。

キャラクター名・武器名・召喚石名など、
自信がない場合は勝手に名前を作らず
「判別できない」としてください。

投稿者コメントに書かれている情報と、
画像から確認できる情報を混同しないでください。

AI検索用の資料として利用するため、
簡潔かつ検索しやすい文章にしてください。
"""


    try:

        contents = [
            prompt
        ]

        contents.extend(
            image_parts
        )


        response = (
            client.models.generate_content(

                model=
                    VISION_MODEL,

                contents=
                    contents,

                config=
                    types.GenerateContentConfig(
                        temperature=0.1,
                        max_output_tokens=1200,
                    )
            )
        )


        return (
            response.text
            or ""
        ).strip()


    except Exception as e:

        print(
            "  Gemini画像解析失敗:"
        )

        print(
            f"  {e}"
        )

        return ""


# =========================================================
# AI検索用テキスト作成
# =========================================================

def build_knowledge_text(
    category_name: str,
    post_id: str,
    data: dict,
    image_analysis: str,
    source_url: str
) -> str:

    name = data.get(
        "name",
        "名前なし"
    )


    comment = data.get(
        "comment",
        ""
    )


    timestamp = data.get(
        "timestamp",
        ""
    )


    images = data.get(
        "images",
        []
    )


    image_count = (
        len(images)
        if isinstance(
            images,
            list
        )
        else 0
    )


    parts = [
        "【編成共有データ】",
        f"カテゴリ: {category_name}",
        f"投稿者: {name}",
        f"投稿ID: {post_id}",
        f"投稿日: {timestamp}",
        f"画像枚数: {image_count}",
    ]


    if comment:

        parts.extend([
            "",
            "【投稿者コメント】",
            comment,
        ])


    if image_analysis:

        parts.extend([
            "",
            "【編成スクリーンショットから確認できる情報】",
            image_analysis,
        ])


    parts.extend([
        "",
        "【参照ページ】",
        source_url,
    ])


    return "\n".join(
        parts
    )


# =========================================================
# 編成共有を全部読み込む
# =========================================================

def load_all_formations():

    all_posts = []

    success = True


    print()
    print(
        "================================"
    )

    print(
        "編成共有データ読み込み"
    )

    print(
        "================================"
    )

    print()


    for category_key, info in (
        FORMATION_COLLECTIONS.items()
    ):

        category_name = (
            info["name"]
        )

        collection_name = (
            info["collection"]
        )


        print(
            f"--- {category_name} ---"
        )


        try:

            docs = list(
                source_db
                .collection(
                    collection_name
                )
                .stream()
            )


            print(
                f"投稿数: "
                f"{len(docs)}"
            )


            for doc in docs:

                all_posts.append({

                    "category_key":
                        category_key,

                    "category_name":
                        category_name,

                    "source_url":
                        info["url"],

                    "post_id":
                        doc.id,

                    "data":
                        doc.to_dict(),
                })


        except Exception as e:

            success = False


            print(
                "❌ 読み込み失敗:"
            )

            print(
                e
            )


        print()


    return (
        all_posts,
        success
    )


# =========================================================
# 1投稿をknowledgeへ登録
# =========================================================

def ingest_one_post(
    post: dict
) -> str:

    category_key = (
        post["category_key"]
    )

    category_name = (
        post["category_name"]
    )

    source_url = (
        post["source_url"]
    )

    post_id = (
        post["post_id"]
    )

    data = (
        post["data"]
    )


    player_name = data.get(
        "name",
        "名前なし"
    )


    comment = data.get(
        "comment",
        ""
    )


    images = data.get(
        "images",
        []
    )


    if not isinstance(
        images,
        list
    ):

        images = []


    # =====================================================
    # knowledge側の固定ID
    # =====================================================

    knowledge_doc_id = (
        f"formation_"
        f"{category_key}_"
        f"{post_id}"
    )


    doc_ref = (
        target_db
        .collection(
            "knowledge"
        )
        .document(
            knowledge_doc_id
        )
    )


    # =====================================================
    # 投稿内容ハッシュ
    # =====================================================

    content_hash = (
        calculate_post_hash(
            category_key,
            post_id,
            data
        )
    )


    # =====================================================
    # 変更が無いかチェック
    # =====================================================

    try:

        existing_doc = (
            doc_ref.get()
        )


        if existing_doc.exists:

            existing_data = (
                existing_doc.to_dict()
            )


            old_hash = (
                existing_data.get(
                    "content_hash"
                )
            )


            if (
                old_hash
                == content_hash
            ):

                print(
                    "  変更なし → "
                    "スキップ"
                )

                return "skipped"


    except Exception as e:

        print(
            "  既存データ確認失敗:"
        )

        print(
            f"  {e}"
        )


    # =====================================================
    # 画像解析
    # =====================================================

    image_analysis = ""


    if images:

        print(
            f"  画像解析開始: "
            f"{len(images)}枚"
        )


        image_analysis = (
            analyze_formation_images(

                images=
                    images,

                category_name=
                    category_name,

                player_name=
                    player_name,

                comment=
                    comment,
            )
        )


        if image_analysis:

            print(
                "  画像解析成功"
            )

        else:

            print(
                "  画像解析結果なし"
            )


    # =====================================================
    # AI検索用本文
    # =====================================================

    knowledge_text = (
        build_knowledge_text(

            category_name=
                category_name,

            post_id=
                post_id,

            data=
                data,

            image_analysis=
                image_analysis,

            source_url=
                source_url,
        )
    )


    # =====================================================
    # Embedding
    # =====================================================

    print(
        "  Embedding作成中..."
    )


    try:

        embedding = (
            get_embedding(
                knowledge_text
            )
        )


    except Exception as e:

        print(
            "  ❌ Embedding失敗:"
        )

        print(
            f"  {e}"
        )

        return "failed"


    # =====================================================
    # knowledge保存
    #
    # 元画像Base64は保存しません。
    # =====================================================

    try:

        doc_data = {

            "content":
                knowledge_text,

            "source":
                (
                    f"⚔️ 編成共有 "
                    f"({category_name}) "
                    f"- {player_name}"
                ),

            "source_type":
                "formation",

            "url":
                source_url,

            "title":
                (
                    f"編成共有 "
                    f"{category_name}"
                ),

            "formation_category":
                category_key,

            "formation_category_name":
                category_name,

            "formation_post_id":
                post_id,

            "formation_player_name":
                player_name,

            "formation_timestamp":
                data.get(
                    "timestamp",
                    ""
                ),

            "formation_image_count":
                len(images),

            "content_hash":
                content_hash,

            "ingest_version":
                INGEST_VERSION,

            "active":
                True,

            "updated_at":
                firestore.SERVER_TIMESTAMP,

            "embedding_field":
                Vector(
                    embedding
                ),
        }


        doc_ref.set(
            doc_data
        )


        print(
            "  ✅ knowledgeへ保存"
        )


        return "saved"


    except Exception as e:

        print(
            "  ❌ Firestore保存失敗:"
        )

        print(
            f"  {e}"
        )

        return "failed"


# =========================================================
# 削除済み投稿をknowledgeから削除
# =========================================================

def cleanup_deleted_posts(
    active_keys: set[str]
) -> int:

    print()
    print(
        "削除済み投稿チェック中..."
    )


    deleted_count = 0


    try:

        query = (
            target_db
            .collection(
                "knowledge"
            )
            .where(
                filter=FieldFilter(
                    "source_type",
                    "==",
                    "formation"
                )
            )
        )


        for doc in query.stream():

            data = doc.to_dict()


            category_key = (
                data.get(
                    "formation_category",
                    ""
                )
            )


            post_id = (
                data.get(
                    "formation_post_id",
                    ""
                )
            )


            active_key = (
                f"{category_key}:"
                f"{post_id}"
            )


            if (
                active_key
                not in active_keys
            ):

                print(
                    f"  古い編成削除: "
                    f"{doc.id}"
                )


                doc.reference.delete()


                deleted_count += 1


    except Exception as e:

        print(
            "削除済み投稿チェック失敗:"
        )

        print(
            e
        )


    return deleted_count


# =========================================================
# メイン
# =========================================================

def main():

    print()
    print(
        "================================"
    )

    print(
        "編成共有 → AI knowledge"
    )

    print(
        "同期開始"
    )

    print(
        "================================"
    )

    print()


    # =====================================================
    # 全編成を先に読む
    # =====================================================

    posts, read_success = (
        load_all_formations()
    )


    # =====================================================
    # どれか1コレクションでも
    # 読み込み失敗した場合、
    # 安全のため削除処理は行いません。
    # =====================================================

    if not read_success:

        print()
        print(
            "⚠️ 一部の編成コレクションを"
            "読み込めませんでした。"
        )

        print(
            "安全のため同期を中止します。"
        )

        print(
            "knowledgeの既存データは"
            "削除しません。"
        )

        return


    print(
        f"取得した投稿総数: "
        f"{len(posts)}"
    )

    print()


    saved_count = 0
    skipped_count = 0
    failed_count = 0


    active_keys = set()


    # =====================================================
    # 各投稿を処理
    # =====================================================

    for index, post in enumerate(
        posts,
        start=1
    ):

        category_name = (
            post["category_name"]
        )

        post_id = (
            post["post_id"]
        )

        player_name = (
            post["data"].get(
                "name",
                "名前なし"
            )
        )


        print(
            "--------------------------------"
        )

        print(
            f"処理中 "
            f"({index}/{len(posts)})"
        )

        print(
            f"カテゴリ: "
            f"{category_name}"
        )

        print(
            f"投稿者: "
            f"{player_name}"
        )

        print(
            f"投稿ID: "
            f"{post_id}"
        )


        active_key = (
            f"{post['category_key']}:"
            f"{post_id}"
        )


        active_keys.add(
            active_key
        )


        result = (
            ingest_one_post(
                post
            )
        )


        if result == "saved":

            saved_count += 1


        elif result == "skipped":

            skipped_count += 1


        else:

            failed_count += 1


        print()


    # =====================================================
    # Firestoreから削除済みの編成を
    # AI knowledge側からも削除
    # =====================================================

    deleted_count = (
        cleanup_deleted_posts(
            active_keys
        )
    )


    # =====================================================
    # 完了
    # =====================================================

    print()
    print(
        "================================"
    )

    print(
        "編成共有同期 完了"
    )

    print(
        "================================"
    )

    print(
        f"新規・更新: "
        f"{saved_count}"
    )

    print(
        f"変更なし: "
        f"{skipped_count}"
    )

    print(
        f"失敗: "
        f"{failed_count}"
    )

    print(
        f"削除反映: "
        f"{deleted_count}"
    )

    print(
        f"現在の投稿数: "
        f"{len(posts)}"
    )

    print(
        "================================"
    )

    print()


if __name__ == "__main__":
    main()