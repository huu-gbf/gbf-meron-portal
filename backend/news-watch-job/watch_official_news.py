"""
めろ～ん王国 グランブルーファンタジー公式ニュース更新ウォッチャー

対象:
  https://granbluefantasy.com/ja/news/

動作概要:
  1. Playwright（ヘッドレスChromium）で公式ニュース一覧ページを開く
  2. JavaScriptで描画された記事リストを取得
  3. 既にFirestoreの site_updates に登録済みの記事IDと比較
  4. 新着があれば site_updates へ保存（status: "unread"）
  5. 変更なしなら終了（Firestore書き込みなし）

環境変数:
  FIRESTORE_PROJECT_ID  : GCPプロジェクトID（デフォルト: gbf-ai-agent）
  DRY_RUN               : "1" にするとFirestoreへ書き込まない
  INITIAL_SEED_ONLY     : "1" にすると現在の記事を "seeded" として登録し通知しない

Gemini APIは一切使用しません。
GEMINI_API_KEY / ADMIN_API_KEY は不要です。
"""

import os
import re
import hashlib
import sys
from datetime import datetime, timezone, timedelta

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
from google.cloud import firestore


# =========================================================
# 定数
# =========================================================

NEWS_URL = "https://granbluefantasy.com/ja/news/"

# 1回の実行で保存する最大件数（全過去記事クロール防止）
MAX_ARTICLES = 25

# Playwrightがニュース一覧の描画を待つ最大時間（ミリ秒）
PAGE_LOAD_TIMEOUT_MS = 30_000

# Firestoreコレクション名
COLLECTION_NAME = "site_updates"

# 日本標準時
JST = timezone(timedelta(hours=9))

# =========================================================
# 環境変数
# =========================================================

load_dotenv()

FIRESTORE_PROJECT_ID = os.getenv(
    "FIRESTORE_PROJECT_ID",
    "gbf-ai-agent"
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
# 記事URLから安定したdocument IDを生成
#
# 例:
#   https://granbluefantasy.com/ja/news/9760/
#   → article_id: "9760"
#   → doc_id: "official_news_9760"
#
# URLから記事番号が取れない場合は
#   SHA1(url) の先頭12文字で代替
# =========================================================

def extract_article_id(url: str) -> str:
    """
    ニュース記事URLから記事IDを抽出する。

    例:
      https://granbluefantasy.com/ja/news/9760/  -> "9760"
      https://granbluefantasy.com/ja/news/9760   -> "9760"
    """
    # /ja/news/<数字>/ のパターン
    match = re.search(
        r"/ja/news/(\d+)/?$",
        url
    )
    if match:
        return match.group(1)

    # 取れない場合はURLのsha1で代替
    return (
        hashlib.sha1(
            url.encode("utf-8")
        ).hexdigest()[:12]
    )


def make_doc_id(article_id: str) -> str:
    return f"official_news_{article_id}"


# =========================================================
# Playwright でニュース一覧を取得
#
# granbluefantasy.com は SvelteKit SPA のため、
# requests + BeautifulSoup ではJSレンダリング後の
# 記事リストを取得できません。
# Playwright（ヘッドレスChromium）でページを開き、
# JSが描画した後のDOMを解析します。
#
# ページ掲載情報のみ取得し、記事本文は保存しません。
# =========================================================

def fetch_news_articles() -> list[dict]:
    """
    公式ニュース一覧ページを Playwright で開き、
    記事のタイトル・URL・公開日時を取得して返す。

    返り値例:
      [
        {
          "title": "最終上限解放！〇〇",
          "url": "https://granbluefantasy.com/ja/news/9760/",
          "article_id": "9760",
          "published_at": "2026-08-15",
        },
        ...
      ]

    取得に失敗した場合は空リストを返す。
    """
    articles = []

    with sync_playwright() as p:

        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )

        try:
            page = browser.new_page(
                user_agent=(
                    "Mozilla/5.0 (compatible; "
                    "MeronKingdom-NewsWatcher/1.0; "
                    "+https://granbluefantasy.com/ja/news/)"
                ),
                # Cookieバナーのポップアップを避けるため
                locale="ja-JP",
            )

            # --------------------------------------------------
            # ページを開く
            # --------------------------------------------------
            try:
                page.goto(
                    NEWS_URL,
                    timeout=PAGE_LOAD_TIMEOUT_MS,
                    wait_until="networkidle",
                )
            except PlaywrightTimeoutError:
                print(
                    "[NEWS WATCH] タイムアウト: "
                    "ページの読み込みが完了しませんでした"
                )
                browser.close()
                return []

            # --------------------------------------------------
            # ニュース一覧が描画されるのを待つ
            #
            # 公式サイトの構造:
            #   <ul class="news-list ...">
            #     <li class="news-item ...">
            #       <a href="/ja/news/9760/">
            #         <span class="date">2026.08.15</span>
            #         <span class="title">...</span>
            #       </a>
            #     </li>
            #   </ul>
            #
            # クラス名はSvelteKitのハッシュが付くため
            # 部分一致（*=）で検索する
            # --------------------------------------------------
            try:
                page.wait_for_selector(
                    "a[href*='/ja/news/']",
                    timeout=PAGE_LOAD_TIMEOUT_MS,
                )
            except PlaywrightTimeoutError:
                print(
                    "[NEWS WATCH] タイムアウト: "
                    "ニュース一覧の描画を待てませんでした"
                )
                browser.close()
                return []

            # --------------------------------------------------
            # ニュース記事リンクを収集
            # --------------------------------------------------
            links = page.query_selector_all(
                "a[href*='/ja/news/']"
            )

            seen_ids: set[str] = set()

            for link in links:

                href = link.get_attribute("href") or ""

                # 相対URLを絶対URLへ変換
                if href.startswith("/"):
                    href = "https://granbluefantasy.com" + href

                # /ja/news/<数字>/ パターンのみ対象
                # /ja/news/ (一覧ページ自体) は除く
                if not re.search(r"/ja/news/\d+", href):
                    continue

                article_id = extract_article_id(href)

                # 重複除去
                if article_id in seen_ids:
                    continue
                seen_ids.add(article_id)

                # ------------------------------------------
                # タイトルを取得
                # 構造: <a href="..."><div>...<p class="title">...</p>...</div></a>
                # ------------------------------------------
                title = ""

                # まずリンク内のテキストを取得
                inner_text = (
                    link.inner_text().strip()
                )

                if inner_text:
                    # 改行で分割して最も長い行をタイトルとして使う
                    parts = [
                        p.strip()
                        for p in inner_text.split("\n")
                        if p.strip()
                    ]
                    if parts:
                        title = max(parts, key=len)

                # タイトルが取れなかった場合は article_id で代替
                if not title:
                    title = f"記事 #{article_id}"

                # ------------------------------------------
                # 公開日時を取得
                # 日付要素を探す: <time> タグまたは
                # "2026.08.15" のようなテキストを含む要素
                # ------------------------------------------
                published_at = ""

                # <time datetime="..."> を優先
                time_el = link.query_selector("time")
                if time_el:
                    published_at = (
                        time_el.get_attribute("datetime")
                        or time_el.inner_text().strip()
                    )

                # "2026.08.15" or "2026/08/15" パターンを探す
                if not published_at:
                    date_match = re.search(
                        r"(\d{4}[./]\d{2}[./]\d{2})",
                        inner_text,
                    )
                    if date_match:
                        published_at = (
                            date_match.group(1)
                            .replace("/", ".")
                        )

                articles.append({
                    "title": title,
                    "url": href,
                    "article_id": article_id,
                    "published_at": published_at,
                })

                if len(articles) >= MAX_ARTICLES:
                    break

        except Exception as e:
            print(f"[NEWS WATCH] ページ取得中にエラー: {e}")

        finally:
            browser.close()

    return articles


# =========================================================
# Firestoreから既知の記事IDを取得
# =========================================================

def fetch_known_ids(db) -> set[str]:
    """
    Firestoreの site_updates コレクションに
    登録済みの記事IDセットを返す。

    未登録 = 新着 として判定するために使用。
    """
    try:
        docs = (
            db.collection(COLLECTION_NAME)
            .where(
                filter=firestore.FieldFilter(
                    "source_type",
                    "==",
                    "official_news"
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
            f"[NEWS WATCH] Firestore既知ID取得エラー: {e}"
        )
        # 取得失敗時は空セットを返し、
        # 全件を「新着候補」として扱う
        # → DRY_RUN でない場合は重複保存のリスクがあるが、
        #   document IDが冪等なので上書きになるだけで問題なし
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

    document IDは article_id 由来（冪等）。
    同じ記事を2回実行しても上書きになるだけ。

    保存しないもの:
      - 記事本文
      - HTML全文
      - AI要約
      - embedding
    """
    doc_id = make_doc_id(article["article_id"])

    doc_data = {
        "source_type":
            "official_news",

        "source_name":
            "グランブルーファンタジー公式",

        "title":
            article["title"],

        "url":
            article["url"],

        "published_at":
            article.get("published_at", ""),

        "article_id":
            article["article_id"],

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
            merge=True,  # 既存データがある場合は上書き
        )
    )


# =========================================================
# メイン処理
# =========================================================

def main():

    print()
    print("[NEWS WATCH] start")
    print(f"[NEWS WATCH] target={NEWS_URL}")

    if DRY_RUN:
        print("[NEWS WATCH] mode=DRY_RUN (Firestoreへ書き込みません)")

    if INITIAL_SEED_ONLY:
        print("[NEWS WATCH] mode=INITIAL_SEED_ONLY (既存記事を seeded として登録)")

    # --------------------------------------------------
    # 1. 公式ニュース一覧を取得
    # --------------------------------------------------
    articles = fetch_news_articles()

    print(f"[NEWS WATCH] fetched={len(articles)}")

    if not articles:
        print("[NEWS WATCH] 記事を取得できませんでした。終了します。")
        print("[NEWS WATCH] gemini_calls=0")
        print("[NEWS WATCH] done")
        sys.exit(0)

    # --------------------------------------------------
    # 2. Firestoreから既知の記事IDを取得
    # --------------------------------------------------
    if DRY_RUN:
        known_ids: set[str] = set()
        print("[DRY RUN] Firestore問い合わせをスキップ")
    else:
        db = get_db()
        known_ids = fetch_known_ids(db)

    print(f"[NEWS WATCH] known={len(known_ids)}")

    # --------------------------------------------------
    # 3. 新着記事を判定
    # --------------------------------------------------
    new_articles = [
        a for a in articles
        if a["article_id"] not in known_ids
    ]

    print(f"[NEWS WATCH] new={len(new_articles)}")

    # --------------------------------------------------
    # 4. 新着なし → 終了
    # --------------------------------------------------
    if not new_articles:
        print("[NEWS WATCH] 新着なし")
        print("[NEWS WATCH] gemini_calls=0")
        print("[NEWS WATCH] done")
        sys.exit(0)

    # --------------------------------------------------
    # 5. 新着あり → ログ出力
    # --------------------------------------------------
    for article in new_articles:
        print(
            f"[NEWS WATCH] NEW: "
            f"{article['title']} "
            f"{article['url']}"
        )

    # --------------------------------------------------
    # 6. Firestoreへ保存
    # --------------------------------------------------
    if INITIAL_SEED_ONLY:
        # 初回シード: 現在の記事を "seeded" で登録
        # （新着通知扱いにしない）
        status = "seeded"
    else:
        # 通常実行: 新着を "unread" で登録
        status = "unread"

    saved_count = 0
    failed_count = 0

    for article in new_articles:

        if DRY_RUN:
            print(
                f"[DRY RUN] 保存スキップ: "
                f"{article['title']}"
            )
            continue

        try:
            save_article(
                db,
                article,
                status=status,
            )

            saved_count += 1
            print(
                f"[NEWS WATCH] saved: "
                f"official_news_{article['article_id']}"
            )

        except Exception as e:
            failed_count += 1
            print(
                f"[NEWS WATCH] 保存失敗: "
                f"{article['article_id']} - {e}"
            )

    # --------------------------------------------------
    # 7. 結果サマリー
    # --------------------------------------------------
    if not DRY_RUN:
        print(f"[NEWS WATCH] saved_count={saved_count}")
        if failed_count > 0:
            print(
                f"[NEWS WATCH] failed_count={failed_count}"
            )

    print("[NEWS WATCH] gemini_calls=0")
    print("[NEWS WATCH] done")


if __name__ == "__main__":
    main()
