"""
めろ～ん王国 ニュースウォッチャー（共通制御）
watch_news.py

役割:
  1. sites.json を読み込む
  2. enabled=true のサイトだけ処理
  3. method に応じた adapter を動的に呼び出す
  4. 共通形式の記事リストを取得
  5. Firestore の既知記事ID と比較
  6. 新着だけ site_updates へ保存
  7. サイト単位でログ出力
  8. 次のサイトへ進む

環境変数:
  FIRESTORE_PROJECT_ID  : GCPプロジェクトID（デフォルト: gbf-ai-agent）
  DRY_RUN               : "1" → Firestoreへ書き込まない
  INITIAL_SEED_ONLY     : "1" → 現在の記事を "seeded" として登録（通知しない）

Gemini API は一切使用しません。
GEMINI_API_KEY / ADMIN_API_KEY は不要です。

将来サイトを追加する方法:
  1. sites.json に新しいエントリを追加（enabled: true）
  2. adapters/<adapter名>.py を作成し fetch(site_config) を実装
  3. このファイル（watch_news.py）は変更不要
"""

import os
import sys
import json
import hashlib
import importlib

from pathlib import Path

from dotenv import load_dotenv
from google.cloud import firestore


# =========================================================
# 定数
# =========================================================

COLLECTION_NAME = "site_updates"

SITES_JSON_PATH = Path(__file__).parent / "sites.json"


# =========================================================
# 環境変数
# =========================================================

load_dotenv()

FIRESTORE_PROJECT_ID = os.getenv(
    "FIRESTORE_PROJECT_ID",
    "gbf-ai-agent",
)

DRY_RUN = (
    os.getenv("DRY_RUN", "0").strip() == "1"
)

INITIAL_SEED_ONLY = (
    os.getenv("INITIAL_SEED_ONLY", "0").strip() == "1"
)


# =========================================================
# Firestore
# =========================================================

def get_db():
    return firestore.Client(
        project=FIRESTORE_PROJECT_ID
    )


# =========================================================
# document IDの生成
#
# サイトIDと記事IDから安定したdocument IDを作る。
# 同じ記事を2回実行しても冪等になる。
#
# 例:
#   source_id="granblue_official", article_id="9760"
#   -> "granblue_official_9760"
#
#   source_id="gamewith_gbf", article_id="a1b2c3d4e5f6"（sha1由来）
#   -> "gamewith_gbf_a1b2c3d4e5f6"
# =========================================================

def make_doc_id(
    source_id: str,
    article_id: str,
) -> str:
    return f"{source_id}_{article_id}"


def make_article_id_from_url(url: str) -> str:
    """
    URLから記事IDを生成する汎用フォールバック。
    adapterが article_id を返さなかった場合に使用。
    """
    return hashlib.sha1(
        url.encode("utf-8")
    ).hexdigest()[:12]


# =========================================================
# adapterを動的ロード
#
# method="playwright" → adapters/granblue_official.py
# method="rss"        → adapters/gamewith.py  など
#
# 未実装のmethodは NotImplementedError で警告し、
# そのサイトをスキップする。
# =========================================================

def load_adapter(adapter_name: str):
    """
    adapters/<adapter_name>.py をインポートして返す。
    モジュールが存在しない場合は None を返す。
    """
    try:
        module = importlib.import_module(
            f"adapters.{adapter_name}"
        )
        return module
    except ModuleNotFoundError:
        return None


# =========================================================
# Firestoreからサイト別の既知記事IDを取得
# =========================================================

def fetch_known_ids(
    db,
    source_id: str,
) -> set[str]:
    """
    指定されたsource_idの記事のうち、
    すでにFirestoreに登録済みのarticle_idセットを返す。

    エラー時は空セットを返す（全件を新着候補として扱う）。
    document IDが冪等なため、重複しても上書きになるだけ。
    """
    try:
        docs = (
            db.collection(COLLECTION_NAME)
            .where(
                filter=firestore.FieldFilter(
                    "source_id",
                    "==",
                    source_id,
                )
            )
            .select(["article_id"])
            .stream()
        )

        return {
            doc.to_dict().get("article_id", "")
            for doc in docs
            if doc.to_dict().get("article_id")
        }

    except Exception as e:
        print(
            f"[SITE] {source_id} "
            f"Firestore既知ID取得エラー: {e}"
        )
        return set()


# =========================================================
# Firestoreへ記事を保存
# =========================================================

def save_article(
    db,
    article: dict,
    status: str,
) -> None:
    """
    site_updates コレクションへ記事メタデータを保存する。

    保存しないもの:
      - 記事本文
      - HTML全文
      - AI要約
      - embedding
      - APIキー・認証情報
    """
    source_id = article["source_id"]
    article_id = (
        article.get("article_id")
        or make_article_id_from_url(article["url"])
    )

    doc_id = make_doc_id(source_id, article_id)

    doc_data = {
        "source_id":
            source_id,

        "source_name":
            article.get("source_name", ""),

        "source_type":
            article.get("source_type", ""),

        "title":
            article.get("title", ""),

        "url":
            article.get("url", ""),

        "published_at":
            article.get("published_at", ""),

        "article_id":
            article_id,

        "status":
            status,

        "detected_at":
            firestore.SERVER_TIMESTAMP,
    }

    (
        db.collection(COLLECTION_NAME)
        .document(doc_id)
        .set(
            doc_data,
            merge=True,
        )
    )


# =========================================================
# 1サイト分の処理
# =========================================================

def process_site(
    site_config: dict,
    db,
) -> None:
    """
    1サイト分の監視処理を行う。

    1. adapterで記事一覧を取得
    2. Firestoreの既知IDと比較
    3. 新着をFirestoreへ保存
    """
    source_id = site_config["id"]
    adapter_name = site_config.get("adapter", source_id)
    method = site_config.get("method", "")

    print(f"\n[SITE] {source_id} start")
    print(f"[SITE] {source_id} method={method}")

    # --------------------------------------------------
    # adapterを読み込む
    # --------------------------------------------------
    adapter = load_adapter(adapter_name)

    if adapter is None:
        print(
            f"[SITE] {source_id} "
            f"adapterが見つかりません: "
            f"adapters/{adapter_name}.py"
        )
        print(f"[SITE] {source_id} skipped")
        return

    if not hasattr(adapter, "fetch"):
        print(
            f"[SITE] {source_id} "
            f"adapters/{adapter_name}.py に "
            f"fetch() が定義されていません"
        )
        print(f"[SITE] {source_id} skipped")
        return

    # --------------------------------------------------
    # 記事一覧を取得
    # --------------------------------------------------
    try:
        articles = adapter.fetch(site_config)
    except Exception as e:
        print(
            f"[SITE] {source_id} "
            f"adapter.fetch() エラー: {e}"
        )
        print(f"[SITE] {source_id} done (error)")
        return

    print(f"[SITE] {source_id} fetched={len(articles)}")

    if not articles:
        print(
            f"[SITE] {source_id} "
            f"記事を取得できませんでした"
        )
        print(f"[SITE] {source_id} gemini_calls=0")
        print(f"[SITE] {source_id} done")
        return

    # --------------------------------------------------
    # 既知記事IDを取得
    # --------------------------------------------------
    if DRY_RUN:
        known_ids: set[str] = set()
        print(
            f"[SITE] {source_id} "
            f"[DRY RUN] Firestore問い合わせをスキップ"
        )
    else:
        known_ids = fetch_known_ids(db, source_id)

    print(f"[SITE] {source_id} known={len(known_ids)}")

    # --------------------------------------------------
    # 新着判定
    # --------------------------------------------------
    new_articles = [
        a for a in articles
        if a.get("article_id") not in known_ids
    ]

    print(f"[SITE] {source_id} new={len(new_articles)}")

    if not new_articles:
        print(f"[SITE] {source_id} 新着なし")
        print(f"[SITE] {source_id} gemini_calls=0")
        print(f"[SITE] {source_id} done")
        return

    # --------------------------------------------------
    # 新着ログ
    # --------------------------------------------------
    for article in new_articles:
        print(
            f"[SITE] {source_id} NEW: "
            f"{article.get('title', '')} "
            f"{article.get('url', '')}"
        )

    # --------------------------------------------------
    # Firestoreへ保存
    # --------------------------------------------------
    status = "seeded" if INITIAL_SEED_ONLY else "unread"

    saved_count = 0
    failed_count = 0

    for article in new_articles:

        if DRY_RUN:
            print(
                f"[SITE] {source_id} "
                f"[DRY RUN] 保存スキップ: "
                f"{article.get('title', '')}"
            )
            continue

        try:
            save_article(db, article, status=status)
            saved_count += 1

            article_id = article.get("article_id", "")
            print(
                f"[SITE] {source_id} "
                f"saved: {source_id}_{article_id}"
            )

        except Exception as e:
            failed_count += 1
            print(
                f"[SITE] {source_id} "
                f"保存失敗: "
                f"{article.get('article_id', '')} - {e}"
            )

    if not DRY_RUN:
        print(
            f"[SITE] {source_id} "
            f"saved_count={saved_count}"
        )
        if failed_count > 0:
            print(
                f"[SITE] {source_id} "
                f"failed_count={failed_count}"
            )

    print(f"[SITE] {source_id} gemini_calls=0")
    print(f"[SITE] {source_id} done")


# =========================================================
# メイン
# =========================================================

def main():

    print()
    print("[NEWS WATCH] start")

    if DRY_RUN:
        print(
            "[NEWS WATCH] mode=DRY_RUN "
            "(Firestoreへ書き込みません)"
        )

    if INITIAL_SEED_ONLY:
        print(
            "[NEWS WATCH] mode=INITIAL_SEED_ONLY "
            "(既存記事を seeded として登録)"
        )

    # --------------------------------------------------
    # sites.json を読み込む
    # --------------------------------------------------
    if not SITES_JSON_PATH.exists():
        print(
            f"[NEWS WATCH] sites.json が見つかりません: "
            f"{SITES_JSON_PATH}"
        )
        sys.exit(1)

    with open(SITES_JSON_PATH, encoding="utf-8") as f:
        sites = json.load(f)

    # enabled=true のサイトだけ対象
    enabled_sites = [
        s for s in sites
        if s.get("enabled", False)
    ]

    print(
        f"[NEWS WATCH] "
        f"sites={len(enabled_sites)} "
        f"(enabled)"
    )

    if not enabled_sites:
        print("[NEWS WATCH] 有効なサイトがありません")
        print("[NEWS WATCH] done")
        sys.exit(0)

    # --------------------------------------------------
    # Firestore クライアント（DRY_RUNでない場合のみ）
    # --------------------------------------------------
    db = None
    if not DRY_RUN:
        try:
            db = get_db()
        except Exception as e:
            print(
                f"[NEWS WATCH] "
                f"Firestoreクライアント初期化エラー: {e}"
            )
            sys.exit(1)

    # --------------------------------------------------
    # 各サイトを順番に処理
    # --------------------------------------------------
    for site_config in enabled_sites:
        try:
            process_site(site_config, db)
        except Exception as e:
            source_id = site_config.get("id", "unknown")
            print(
                f"[SITE] {source_id} "
                f"予期しないエラー: {e}"
            )
            print(f"[SITE] {source_id} 次のサイトへ進みます")

    print()
    print("[NEWS WATCH] done")


if __name__ == "__main__":
    main()
