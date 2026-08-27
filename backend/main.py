import os
import re
import hmac
import hashlib
from datetime import datetime, timezone, timedelta
from urllib.parse import urlparse

from dotenv import load_dotenv

from fastapi import (
    FastAPI,
    HTTPException,
    Request,
)

from fastapi.middleware.cors import (
    CORSMiddleware,
)

from pydantic import (
    BaseModel,
    Field,
)

from google import genai
from google.genai import types

from google.cloud import firestore

from google.cloud.firestore_v1.vector import (
    Vector,
)

from google.cloud.firestore_v1.base_vector_query import (
    DistanceMeasure,
)

from google.cloud.firestore_v1.base_query import (
    FieldFilter,
)


# =========================================================
# 環境変数
# =========================================================

load_dotenv()


GEMINI_API_KEY = os.getenv(
    "GEMINI_API_KEY"
)


if not GEMINI_API_KEY:
    raise RuntimeError(
        "GEMINI_API_KEY が設定されていません"
    )


FIRESTORE_PROJECT_ID = os.getenv(
    "FIRESTORE_PROJECT_ID",
    "gbf-ai-agent"
)


GENERATION_MODEL = os.getenv(
    "GENERATION_MODEL",
    "gemini-3.7-flash"
)


# =========================================================
# 管理用API設定
#
# ADMIN_API_KEY はCloud RunのSecret Managerから渡します。
# HTMLには管理キーを埋め込みません。
# =========================================================

ADMIN_API_KEY = os.getenv(
    "ADMIN_API_KEY",
    ""
).strip()


MAX_ADMIN_SOURCE_LENGTH = int(
    os.getenv(
        "MAX_ADMIN_SOURCE_LENGTH",
        "50000"
    )
)


MAX_ADMIN_SUMMARY_LENGTH = int(
    os.getenv(
        "MAX_ADMIN_SUMMARY_LENGTH",
        "7000"
    )
)


OFFICIAL_NEWS_ALLOWED_HOSTS = {
    "granbluefantasy.com",
    "www.granbluefantasy.com",
}


OFFICIAL_NEWS_INGEST_VERSION = (
    "official_news_summary_v1"
)


# =========================================================
# 利用制限
#
# Cloud Runの環境変数から変更できます。
# =========================================================

SHORT_WINDOW_LIMIT = int(
    os.getenv(
        "SHORT_WINDOW_LIMIT",
        "20"
    )
)


DAILY_CLIENT_LIMIT = int(
    os.getenv(
        "DAILY_CLIENT_LIMIT",
        "100"
    )
)


DAILY_GLOBAL_LIMIT = int(
    os.getenv(
        "DAILY_GLOBAL_LIMIT",
        "500"
    )
)


MAX_MESSAGE_LENGTH = int(
    os.getenv(
        "MAX_MESSAGE_LENGTH",
        "1500"
    )
)


# =========================================================
# 日本時間
# =========================================================

JST = timezone(
    timedelta(hours=9)
)


# =========================================================
# Gemini / Firestore
# =========================================================

client = genai.Client(
    api_key=GEMINI_API_KEY
)


db = firestore.Client(
    project=FIRESTORE_PROJECT_ID
)


# =========================================================
# Embedding設定
# =========================================================

EMBEDDING_MODEL = (
    "gemini-embedding-001"
)

EMBEDDING_DIMENSIONS = 768


# =========================================================
# RAG設定
# =========================================================

RAG_SEARCH_LIMIT = 8

RAG_MAX_DISTANCE = 0.50

RAG_DISTANCE_MARGIN = 0.07


# =========================================================
# FastAPI
# =========================================================

app = FastAPI(
    title=
        "めろ～ん王国 AI Assistant API"
)


# =========================================================
# CORS
# =========================================================

ALLOWED_ORIGINS = [

    "https://huu-gbf.github.io",

    # ローカルファイルテスト用
    "null",

    "http://127.0.0.1:5500",

    "http://localhost:5500",
]


app.add_middleware(

    CORSMiddleware,

    allow_origins=
        ALLOWED_ORIGINS,

    allow_credentials=
        False,

    allow_methods=[
        "GET",
        "POST",
        "OPTIONS",
    ],

    allow_headers=[
        "Content-Type",
        "X-Client-Id",
        "X-Admin-Key",
    ],
)


# =========================================================
# API形式
# =========================================================

class ChatRequest(
    BaseModel
):

    message: str


class SourceInfo(
    BaseModel
):

    name: str

    type: str = "internal"

    url: str | None = None


class ChatResponse(
    BaseModel
):

    reply: str

    sources: list[SourceInfo] = (
        Field(
            default_factory=list
        )
    )


class OfficialNewsSummarizeRequest(
    BaseModel
):

    title: str

    url: str

    article_text: str

    published_date: str | None = None


class OfficialNewsSummarizeResponse(
    BaseModel
):

    summary: str


class OfficialNewsRegisterRequest(
    BaseModel
):

    title: str

    url: str

    summary: str

    published_date: str | None = None


class OfficialNewsRegisterResponse(
    BaseModel
):

    status: str

    message: str

    document_count: int = 0


# =========================================================
# 利用制限用例外
# =========================================================

class UsageLimitError(
    Exception
):

    def __init__(
        self,
        message: str
    ):

        self.message = message

        super().__init__(
            message
        )


# =========================================================
# Client IDを安全な形へ変換
# =========================================================

def normalize_client_id(
    client_id: str | None
) -> str:

    if not client_id:

        return "anonymous"


    client_id = (
        client_id.strip()
    )


    # 長すぎる値や怪しい値を拒否
    if (
        len(client_id) > 100
        or
        not re.fullmatch(
            r"[A-Za-z0-9_\-\.]+",
            client_id
        )
    ):

        return "anonymous"


    return client_id


# =========================================================
# Client IDをハッシュ化
#
# Firestoreには端末IDそのものを保存しません。
# =========================================================

def hash_client_id(
    client_id: str
) -> str:

    return (
        hashlib
        .sha256(
            client_id.encode(
                "utf-8"
            )
        )
        .hexdigest()[:32]
    )


# =========================================================
# Firestoreカウント取得
# =========================================================

def get_counter_value(
    snapshot
) -> int:

    if not snapshot.exists:
        return 0


    data = (
        snapshot.to_dict()
        or {}
    )


    return int(
        data.get(
            "count",
            0
        )
    )


# =========================================================
# 利用制限
# =========================================================

def check_and_reserve_usage(
    client_id: str
):

    now = datetime.now(
        JST
    )


    day_key = (
        now.strftime(
            "%Y%m%d"
        )
    )


    # 5分単位のバケット
    bucket_minute = (
        now.minute
        // 5
        * 5
    )


    window_key = (
        now.strftime(
            "%Y%m%d%H"
        )
        +
        f"{bucket_minute:02d}"
    )


    client_hash = (
        hash_client_id(
            client_id
        )
    )


    usage_collection = (
        db.collection(
            "ai_usage_limits"
        )
    )


    global_ref = (
        usage_collection
        .document(
            f"global_day_{day_key}"
        )
    )


    client_day_ref = (
        usage_collection
        .document(
            f"client_day_"
            f"{client_hash}_"
            f"{day_key}"
        )
    )


    client_window_ref = (
        usage_collection
        .document(
            f"client_window_"
            f"{client_hash}_"
            f"{window_key}"
        )
    )


    transaction = (
        db.transaction()
    )


    @firestore.transactional
    def update_usage(
        transaction
    ):

        global_snapshot = (
            global_ref.get(
                transaction=transaction
            )
        )


        client_day_snapshot = (
            client_day_ref.get(
                transaction=transaction
            )
        )


        client_window_snapshot = (
            client_window_ref.get(
                transaction=transaction
            )
        )


        global_count = (
            get_counter_value(
                global_snapshot
            )
        )


        client_day_count = (
            get_counter_value(
                client_day_snapshot
            )
        )


        client_window_count = (
            get_counter_value(
                client_window_snapshot
            )
        )


        # ---------------------------------------------
        # 5分制限
        # ---------------------------------------------

        if (
            client_window_count
            >= SHORT_WINDOW_LIMIT
        ):

            raise UsageLimitError(
                "短時間に多くの質問が送信されました。"
                "5分ほど待ってから、もう一度お試しください。"
            )


        # ---------------------------------------------
        # 端末1日制限
        # ---------------------------------------------

        if (
            client_day_count
            >= DAILY_CLIENT_LIMIT
        ):

            raise UsageLimitError(
                "本日のAI利用回数の上限に達しました。"
                "明日になると自動的に利用できるようになります。"
            )


        # ---------------------------------------------
        # 団全体1日制限
        # ---------------------------------------------

        if (
            global_count
            >= DAILY_GLOBAL_LIMIT
        ):

            raise UsageLimitError(
                "本日のAI全体利用上限に達しました。"
                "明日になると自動的に利用できるようになります。"
            )


        common_data = {

            "updated_at":
                firestore.SERVER_TIMESTAMP,

            "day":
                day_key,
        }


        # ---------------------------------------------
        # 団全体
        # ---------------------------------------------

        transaction.set(

            global_ref,

            {
                **common_data,

                "type":
                    "global_day",

                "count":
                    global_count + 1,
            },

            merge=True
        )


        # ---------------------------------------------
        # 端末1日
        # ---------------------------------------------

        transaction.set(

            client_day_ref,

            {
                **common_data,

                "type":
                    "client_day",

                "count":
                    client_day_count + 1,
            },

            merge=True
        )


        # ---------------------------------------------
        # 端末5分
        # ---------------------------------------------

        transaction.set(

            client_window_ref,

            {
                **common_data,

                "type":
                    "client_window",

                "window":
                    window_key,

                "count":
                    client_window_count + 1,
            },

            merge=True
        )


    update_usage(
        transaction
    )


# =========================================================
# Embedding
# =========================================================

def get_embedding(
    text: str
) -> list[float]:

    response = (
        client.models.embed_content(

            model=
                EMBEDDING_MODEL,

            contents=
                text,

            config=
                types.EmbedContentConfig(

                    output_dimensionality=
                        EMBEDDING_DIMENSIONS
                ),
        )
    )


    return (
        response
        .embeddings[0]
        .values
    )


# =========================================================
# 管理API認証
# =========================================================

def require_admin(
    http_request: Request
):

    if not ADMIN_API_KEY:

        raise HTTPException(

            status_code=503,

            detail=
                "管理機能がまだ設定されていません。"
        )


    supplied_key = (
        http_request.headers.get(
            "X-Admin-Key",
            ""
        )
    )


    if (
        not supplied_key
        or
        not hmac.compare_digest(
            supplied_key,
            ADMIN_API_KEY
        )
    ):

        raise HTTPException(

            status_code=401,

            detail=
                "管理キーが正しくありません。"
        )


# =========================================================
# 公式ニュースURL検証
# =========================================================

def validate_official_news_url(
    url: str
) -> str:

    value = url.strip()


    if not value:

        raise HTTPException(

            status_code=400,

            detail=
                "公式URLを入力してください。"
        )


    try:

        parsed = urlparse(
            value
        )


    except Exception:

        raise HTTPException(

            status_code=400,

            detail=
                "URLの形式が正しくありません。"
        )


    hostname = (
        parsed.hostname
        or ""
    ).lower()


    if (
        parsed.scheme != "https"
        or
        hostname
        not in OFFICIAL_NEWS_ALLOWED_HOSTS
    ):

        raise HTTPException(

            status_code=400,

            detail=
                "granbluefantasy.com の"
                "HTTPS公式URLだけ登録できます。"
        )


    if not parsed.path.startswith(
        "/ja/news"
    ):

        raise HTTPException(

            status_code=400,

            detail=
                "グランブルーファンタジー公式の"
                "ニュースURLを指定してください。"
        )


    return value


# =========================================================
# 公式ニュース入力チェック
# =========================================================

def normalize_official_news_metadata(
    title: str,
    url: str,
    published_date: str | None
) -> tuple[str, str, str]:

    clean_title = (
        title.strip()
    )


    if not clean_title:

        raise HTTPException(

            status_code=400,

            detail=
                "記事タイトルを入力してください。"
        )


    if len(clean_title) > 300:

        raise HTTPException(

            status_code=400,

            detail=
                "記事タイトルが長すぎます。"
        )


    clean_url = (
        validate_official_news_url(
            url
        )
    )


    clean_date = (
        published_date
        or ""
    ).strip()


    if len(clean_date) > 80:

        raise HTTPException(

            status_code=400,

            detail=
                "公開日の入力が長すぎます。"
        )


    return (
        clean_title,
        clean_url,
        clean_date
    )


# =========================================================
# RAG保存用チャンク分割
# =========================================================

def split_knowledge_text(
    text: str,
    max_chars: int = 1500
) -> list[str]:

    paragraphs = [

        item.strip()

        for item
        in text.splitlines()

        if item.strip()
    ]


    chunks = []

    current = ""


    for paragraph in paragraphs:

        if len(paragraph) > max_chars:

            if current:

                chunks.append(
                    current
                )

                current = ""


            for index in range(
                0,
                len(paragraph),
                max_chars
            ):

                piece = paragraph[
                    index:
                    index + max_chars
                ].strip()


                if piece:

                    chunks.append(
                        piece
                    )


            continue


        candidate = (
            paragraph
            if not current
            else
            current
            + "\n"
            + paragraph
        )


        if len(candidate) <= max_chars:

            current = candidate


        else:

            if current:

                chunks.append(
                    current
                )


            current = paragraph


    if current:

        chunks.append(
            current
        )


    return chunks


# =========================================================
# 同一公式URLの既存knowledge
# =========================================================

def get_existing_official_news_docs(
    url: str
):

    query = (

        db.collection(
            "knowledge"
        )

        .where(
            filter=FieldFilter(
                "url",
                "==",
                url
            )
        )
    )


    docs = []


    for doc in query.stream():

        data = (
            doc.to_dict()
            or {}
        )


        if (
            data.get(
                "source_type"
            )
            == "official_summary"
        ):

            docs.append(
                doc
            )


    return docs


# =========================================================
# 公式ニュース要約ハッシュ
# =========================================================

def calculate_official_news_hash(
    title: str,
    url: str,
    published_date: str,
    summary: str
) -> str:

    source = "\n".join([
        OFFICIAL_NEWS_INGEST_VERSION,
        title,
        url,
        published_date,
        summary,
    ])


    return (
        hashlib.sha256(
            source.encode(
                "utf-8"
            )
        )
        .hexdigest()
    )


# =========================================================
# 公式ニュース要約をknowledgeへ保存
# =========================================================

def save_official_news_summary(
    title: str,
    url: str,
    published_date: str,
    summary: str
) -> tuple[str, int]:

    summary = (
        summary.strip()
    )


    if not summary:

        raise HTTPException(

            status_code=400,

            detail=
                "AI要約が空です。"
        )


    if (
        len(summary)
        > MAX_ADMIN_SUMMARY_LENGTH
    ):

        raise HTTPException(

            status_code=400,

            detail=
                "AI要約が長すぎます。"
                f"{MAX_ADMIN_SUMMARY_LENGTH}文字以内に"
                "調整してください。"
        )


    content_hash = (
        calculate_official_news_hash(
            title,
            url,
            published_date,
            summary
        )
    )


    try:

        existing_docs = (
            get_existing_official_news_docs(
                url
            )
        )


    except Exception as e:

        print(
            "Official news lookup failed: "
            f"{e}"
        )

        raise HTTPException(

            status_code=500,

            detail=
                "既存の公式情報を確認できませんでした。"
        )


    for doc in existing_docs:

        data = (
            doc.to_dict()
            or {}
        )


        if (
            data.get(
                "content_hash"
            )
            == content_hash
        ):

            return (
                "unchanged",
                len(existing_docs)
            )


    knowledge_text = (
        "【グランブルーファンタジー公式情報の要約】\n"
        f"タイトル: {title}\n"
    )


    if published_date:

        knowledge_text += (
            f"公開日: {published_date}\n"
        )


    knowledge_text += (
        "\n"
        f"{summary}\n"
        "\n"
        f"公式URL: {url}\n"
        "※管理者が公式記事を確認し、"
        "AIで要約して登録した情報です。"
        "詳細や最新情報は公式URLを確認してください。"
    )


    chunks = (
        split_knowledge_text(
            knowledge_text
        )
    )


    if not chunks:

        raise HTTPException(

            status_code=400,

            detail=
                "保存できる要約がありません。"
        )


    source_id = (
        hashlib.sha1(
            url.encode(
                "utf-8"
            )
        )
        .hexdigest()[:12]
    )


    prepared = []


    # Embeddingが全部成功するまでは
    # Firestoreを書き換えません。
    for index, chunk in enumerate(
        chunks
    ):

        try:

            vector = (
                get_embedding(
                    chunk
                )
            )


        except Exception as e:

            print(
                "Official news embedding failed: "
                f"{e}"
            )

            raise HTTPException(

                status_code=500,

                detail=
                    "AI知識用データの作成に"
                    "失敗しました。"
            )


        doc_id = (
            f"official_news_"
            f"{source_id}_"
            f"chunk_{index}"
        )


        prepared.append((
            doc_id,
            {
                "content":
                    chunk,

                "source":
                    f"公式ニュース: {title}",

                "source_type":
                    "official_summary",

                "source_id":
                    source_id,

                "url":
                    url,

                "title":
                    title,

                "published_date":
                    published_date,

                "content_hash":
                    content_hash,

                "ingest_version":
                    OFFICIAL_NEWS_INGEST_VERSION,

                "active":
                    True,

                "updated_at":
                    firestore.SERVER_TIMESTAMP,

                "embedding_field":
                    Vector(
                        vector
                    ),
            }
        ))


    new_doc_ids = {
        doc_id
        for doc_id, _ in prepared
    }


    # まとめてコミットするので、
    # 保存途中の半端な状態を作りにくくします。
    batch = db.batch()

    collection_ref = (
        db.collection(
            "knowledge"
        )
    )


    for doc_id, doc_data in prepared:

        batch.set(

            collection_ref.document(
                doc_id
            ),

            doc_data
        )


    for old_doc in existing_docs:

        if (
            old_doc.id
            not in new_doc_ids
        ):

            batch.delete(
                old_doc.reference
            )


    try:

        batch.commit()


    except Exception as e:

        print(
            "Official news save failed: "
            f"{e}"
        )

        raise HTTPException(

            status_code=500,

            detail=
                "公式情報をFirestoreへ"
                "保存できませんでした。"
        )


    return (
        "saved",
        len(prepared)
    )


# =========================================================
# Firestore RAG検索
# =========================================================

def search_knowledge_base(
    query_text: str
) -> tuple[str, list[dict]]:

    try:

        query_vector = (
            get_embedding(
                query_text
            )
        )


        collection_ref = (
            db.collection(
                "knowledge"
            )
        )


        results = (
            collection_ref
            .find_nearest(

                vector_field=
                    "embedding_field",

                query_vector=
                    Vector(
                        query_vector
                    ),

                distance_measure=
                    DistanceMeasure.COSINE,

                limit=
                    RAG_SEARCH_LIMIT,

                distance_result_field=
                    "vector_distance",
            )
        )


        candidates = []


        for doc in results.get():

            doc_data = (
                doc.to_dict()
            )


            distance = (
                doc_data.get(
                    "vector_distance"
                )
            )


            if distance is None:
                continue


            print(

                f"[RAG候補] "
                f"{doc.id} "
                f"distance={distance}"
            )


            candidates.append({

                "id":
                    doc.id,

                "data":
                    doc_data,

                "distance":
                    distance,
            })


        if not candidates:

            print(
                "[RAG] 候補なし"
            )

            return "", []


        best_distance = min(

            item["distance"]

            for item
            in candidates
        )


        print(

            f"[RAG] 最良distance="
            f"{best_distance}"
        )


        if (
            best_distance
            > RAG_MAX_DISTANCE
        ):

            print(
                "[RAG] 関連資料なし"
            )

            return "", []


        dynamic_cutoff = min(

            RAG_MAX_DISTANCE,

            best_distance
            + RAG_DISTANCE_MARGIN
        )


        print(

            f"[RAG] 採用ライン="
            f"{dynamic_cutoff}"
        )


        selected = [

            item

            for item
            in candidates

            if (
                item["distance"]
                <= dynamic_cutoff
            )
        ]


        selected.sort(

            key=lambda item:
                item["distance"]
        )


        retrieved_texts = []

        sources = []

        seen_sources = set()


        for item in selected:

            doc_id = (
                item["id"]
            )

            doc_data = (
                item["data"]
            )

            distance = (
                item["distance"]
            )


            print(

                f"[RAG採用] "
                f"{doc_id} "
                f"distance={distance}"
            )


            content = (
                doc_data.get(
                    "content",
                    ""
                )
            )


            if content:

                retrieved_texts.append(
                    content
                )


            source = (
                doc_data.get(
                    "source",
                    "不明な参照元"
                )
            )


            source_type = (
                doc_data.get(
                    "source_type",
                    "internal"
                )
            )


            url = (
                doc_data.get(
                    "url"
                )
            )


            display_name = source


            if (
                source
                == "crew_rules_v1"
            ):

                display_name = (
                    "めろ～ん王国 団内規約"
                )


            source_key = (

                display_name,

                url
            )


            if (
                source_key
                not in seen_sources
            ):

                seen_sources.add(
                    source_key
                )


                sources.append({

                    "name":
                        display_name,

                    "type":
                        source_type,

                    "url":
                        url,
                })


        context_text = (

            "\n\n---\n\n"
            .join(
                retrieved_texts
            )
        )


        print(

            f"[RAG] 採用チャンク数="
            f"{len(selected)}"
        )


        print(

            f"[RAG] 参照元数="
            f"{len(sources)}"
        )


        return (
            context_text,
            sources
        )


    except Exception as e:

        print(
            f"Vector search failed: {e}"
        )

        return "", []


# =========================================================
# ヘルスチェック
# =========================================================

@app.get("/")
def health_check():

    return {

        "status":
            "ok",

        "service":
            "meron-crew-ai-rag",

        "firestore_project":
            FIRESTORE_PROJECT_ID,

        "generation_model":
            GENERATION_MODEL,

        "official_news_admin":
            bool(ADMIN_API_KEY),

        "usage_limits": {

            "five_minutes":
                SHORT_WINDOW_LIMIT,

            "client_daily":
                DAILY_CLIENT_LIMIT,

            "global_daily":
                DAILY_GLOBAL_LIMIT,
        },
    }


# =========================================================
# 管理API
# 公式記事本文 → 要約
#
# 元の本文はFirestoreへ保存しません。
# =========================================================

@app.post(
    "/api/admin/official-news/summarize",
    response_model=
        OfficialNewsSummarizeResponse
)
async def summarize_official_news(

    request:
        OfficialNewsSummarizeRequest,

    http_request:
        Request
):

    require_admin(
        http_request
    )


    title, url, published_date = (
        normalize_official_news_metadata(

            request.title,

            request.url,

            request.published_date
        )
    )


    article_text = (
        request.article_text.strip()
    )


    if not article_text:

        raise HTTPException(

            status_code=400,

            detail=
                "記事本文を貼り付けてください。"
        )


    if (
        len(article_text)
        > MAX_ADMIN_SOURCE_LENGTH
    ):

        raise HTTPException(

            status_code=400,

            detail=
                "貼り付けた記事本文が長すぎます。"
                f"{MAX_ADMIN_SOURCE_LENGTH}文字以内に"
                "してください。"
        )


    system_instruction = """
あなたはグランブルーファンタジー騎空団の
管理者向け情報整理アシスタントです。

ユーザーが確認して貼り付けた公式ニュース本文を、
団内AIの検索知識として使えるように
簡潔な日本語へ要約してください。

重要ルール:
- 元記事の文章を長くそのまま転載しないでください。
- 原則として自分の言葉で要約してください。
- 日付、時刻、数値、イベント名、
  キャラクター名、武器名、召喚石名など、
  本文に明記された固有情報は正確に残してください。
- 本文にない情報を推測・補完しないでください。
- 不明確な内容は断定しないでください。
- 宣伝文句や重複説明は省いてください。
- 団員が後から質問しそうな情報を優先してください。
- Markdownで読みやすくしてください。
- 公式URL自体は本文へ再掲しなくて構いません。
  URLは別フィールドとして保存されます。

基本形式:
## 概要
- ...

## 重要な日程・数値
- ...

## 団員向けポイント
- ...

該当情報がない見出しは省略して構いません。
"""


    user_content = (
        f"記事タイトル: {title}\n"
    )


    if published_date:

        user_content += (
            f"公開日: {published_date}\n"
        )


    user_content += (
        f"公式URL: {url}\n\n"
        "以下がユーザーが確認して貼り付けた"
        "公式記事本文です。\n\n"
        f"{article_text}"
    )


    try:

        response = (
            client.models.generate_content(

                model=
                    GENERATION_MODEL,

                contents=
                    user_content,

                config=
                    types.GenerateContentConfig(

                        system_instruction=
                            system_instruction,

                        temperature=
                            0.1,

                        max_output_tokens=
                            1800
                    )
            )
        )


        summary = (
            response.text
            or ""
        ).strip()


    except Exception as e:

        print(
            "Official news summary failed: "
            f"{e}"
        )

        raise HTTPException(

            status_code=500,

            detail=
                "公式記事のAI要約中に"
                "エラーが発生しました。"
        )


    if not summary:

        raise HTTPException(

            status_code=500,

            detail=
                "AI要約を生成できませんでした。"
        )


    if (
        len(summary)
        > MAX_ADMIN_SUMMARY_LENGTH
    ):

        raise HTTPException(

            status_code=500,

            detail=
                "AI要約が想定より長くなりました。"
                "もう一度実行してください。"
        )


    return (
        OfficialNewsSummarizeResponse(
            summary=summary
        )
    )


# =========================================================
# 管理API
# 確認済み要約 → knowledge登録
# =========================================================

@app.post(
    "/api/admin/official-news/register",
    response_model=
        OfficialNewsRegisterResponse
)
async def register_official_news(

    request:
        OfficialNewsRegisterRequest,

    http_request:
        Request
):

    require_admin(
        http_request
    )


    title, url, published_date = (
        normalize_official_news_metadata(

            request.title,

            request.url,

            request.published_date
        )
    )


    summary = (
        request.summary.strip()
    )


    status, document_count = (
        save_official_news_summary(

            title,

            url,

            published_date,

            summary
        )
    )


    if status == "unchanged":

        return (
            OfficialNewsRegisterResponse(

                status=
                    "unchanged",

                message=
                    "同じ内容がすでに登録されています。"
                    "Embedding作成はスキップしました。",

                document_count=
                    document_count
            )
        )


    return (
        OfficialNewsRegisterResponse(

            status=
                "saved",

            message=
                "公式情報の要約を"
                "AI knowledgeへ登録しました。",

            document_count=
                document_count
        )
    )


# =========================================================
# チャット
# =========================================================

@app.post(
    "/api/chat",
    response_model=ChatResponse
)
async def chat_endpoint(

    request: ChatRequest,

    http_request: Request
):

    user_query = (
        request.message.strip()
    )


    # =====================================================
    # 空メッセージ
    # =====================================================

    if not user_query:

        raise HTTPException(

            status_code=400,

            detail=
                "メッセージが空です。"
        )


    # =====================================================
    # 極端に長い入力を防止
    # =====================================================

    if (
        len(user_query)
        > MAX_MESSAGE_LENGTH
    ):

        raise HTTPException(

            status_code=400,

            detail=
                f"メッセージが長すぎます。"
                f"{MAX_MESSAGE_LENGTH}文字以内で"
                f"質問してください。"
        )


    # =====================================================
    # 端末ID
    # =====================================================

    raw_client_id = (
        http_request.headers.get(
            "X-Client-Id"
        )
    )


    client_id = (
        normalize_client_id(
            raw_client_id
        )
    )


    # =====================================================
    # Geminiを呼ぶ前に利用制限チェック
    # =====================================================

    try:

        check_and_reserve_usage(
            client_id
        )


    except UsageLimitError as e:

        print(
            f"[RATE LIMIT] "
            f"{e.message}"
        )


        raise HTTPException(

            status_code=429,

            detail=
                e.message
        )


    except Exception as e:

        # 利用制限システム自体がおかしい場合は
        # 安全側に倒してGeminiを呼ばない
        print(
            f"Usage limit check failed: {e}"
        )


        raise HTTPException(

            status_code=503,

            detail=
                "AI利用状況の確認中に"
                "エラーが発生しました。"
                "少し待ってから再度お試しください。"
        )


    # =====================================================
    # RAG
    # =====================================================

    context_text, sources = (
        search_knowledge_base(
            user_query
        )
    )


    # =====================================================
    # プロンプト
    # =====================================================

    rag_instruction = f"""
あなたは、グラブル騎空団「めろ～ん王国」の
ポータルサイトに常駐する専用AIアシスタントです。

団員からの質問に対し、
親切かつ丁寧に敬語で回答してください。

以下の【提供された情報】が存在する場合は、
その情報を最優先して回答してください。

団内情報として断定してよいのは、
【提供された情報】から確認できる内容だけです。

提供された情報に質問への答えがない場合は、
存在しない団内ルール、
編成情報、
数値、
日時、
人物などを
推測して作らないでください。

その場合は、

「現在登録されている団内データには記載がありません」

または、

「団長に確認してみてくださいね」

などと回答してください。

編成共有のスクリーンショットから解析した情報には、
画像認識による誤認の可能性があります。

キャラクター名、
武器名、
召喚石名などについて
確実でない情報を断定しないでください。

回答はMarkdown形式を使用し、
見出しや箇条書きを使って
読みやすく整理してください。


【提供された情報】

{context_text}
"""


    # =====================================================
    # Gemini回答
    # =====================================================

    try:

        response = (
            client.models.generate_content(

                model=
                    GENERATION_MODEL,

                contents=
                    user_query,

                config=
                    types.GenerateContentConfig(

                        system_instruction=
                            rag_instruction
                    )
            )
        )


        return ChatResponse(

            reply=
                response.text
                or
                "回答を生成できませんでした。",

            sources=
                sources
        )


    except Exception as e:

        print(
            f"Error generating content: {e}"
        )


        raise HTTPException(

            status_code=500,

            detail=
                "AI応答の生成中に"
                "エラーが発生しました。"
        )