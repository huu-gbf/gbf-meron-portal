"""
adapter: granblue_official
対象: グランブルーファンタジー公式ニュース
URL: https://granbluefantasy.com/ja/news/

granbluefantasy.com は SvelteKit SPA のため、
requests + BeautifulSoup ではJSレンダリング後の
記事リストを取得できません。
Playwright（ヘッドレスChromium）を使用します。

このadapterはFirestoreへの書き込みを行いません。
Gemini APIは一切使用しません。
"""

import re
import hashlib

from playwright.sync_api import (
    sync_playwright,
    TimeoutError as PlaywrightTimeoutError,
)


# =========================================================
# Playwright 設定
# =========================================================

# ページ読み込みタイムアウト（ミリ秒）
PAGE_LOAD_TIMEOUT_MS = 30_000

# User-Agent
USER_AGENT = (
    "Mozilla/5.0 (compatible; "
    "MeronKingdom-NewsWatcher/1.0; "
    "+https://granbluefantasy.com/ja/news/)"
)


# =========================================================
# 記事URLから記事IDを抽出
#
# 例:
#   https://granbluefantasy.com/ja/news/9760/  -> "9760"
#   https://granbluefantasy.com/ja/news/9761   -> "9761"
#   数字でないパス                               -> sha1(url)[:12]
# =========================================================

def _extract_article_id(url: str) -> str:
    match = re.search(
        r"/ja/news/(\d+)/?$",
        url,
    )
    if match:
        return match.group(1)

    return (
        hashlib.sha1(
            url.encode("utf-8")
        ).hexdigest()[:12]
    )


# =========================================================
# fetch: 公式ニュース一覧を取得して共通形式で返す
#
# 引数:
#   site_config: sites.json の1エントリ（dict）
#     - url:        監視対象URL
#     - id:         サイトID（"granblue_official"）
#     - name:       サイト名
#     - source_type: "official_news"
#     - max_items:  最大取得件数
#
# 返り値:
#   共通形式dictのリスト（失敗時は空リスト）
#
# Gemini呼び出し: 0回
# =========================================================

def fetch(site_config: dict) -> list[dict]:
    """
    グラブル公式ニュース一覧を Playwright で取得し、
    共通形式のリストとして返す。

    このメソッドの責務:
      - Playwright で1ページだけ開く
      - 記事リンクを収集
      - 共通形式へ変換して返す

    このメソッドが行わないこと:
      - Firestoreへの書き込み
      - 記事詳細ページを開く
      - Gemini API の呼び出し
    """
    target_url = site_config["url"]
    source_id = site_config["id"]
    source_name = site_config["name"]
    source_type = site_config.get("source_type", "official_news")
    max_items = site_config.get("max_items", 25)

    articles: list[dict] = []

    with sync_playwright() as p:

        browser = p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ],
        )

        try:
            page = browser.new_page(
                user_agent=USER_AGENT,
                locale="ja-JP",
            )

            # --------------------------------------------------
            # ページを開く（networkidle まで待つ）
            # --------------------------------------------------
            try:
                page.goto(
                    target_url,
                    timeout=PAGE_LOAD_TIMEOUT_MS,
                    wait_until="networkidle",
                )
            except PlaywrightTimeoutError:
                print(
                    f"[ADAPTER:{source_id}] "
                    f"タイムアウト: ページ読み込み"
                )
                return []

            # --------------------------------------------------
            # ニュース一覧が描画されるのを待つ
            #
            # granbluefantasy.com のDOM構造:
            #   <a href="/ja/news/9760/"> ... </a>
            #
            # SvelteKitのハッシュ付きクラス名には依存せず、
            # href属性のパターンだけで記事リンクを特定する
            # --------------------------------------------------
            try:
                page.wait_for_selector(
                    "a[href*='/ja/news/']",
                    timeout=PAGE_LOAD_TIMEOUT_MS,
                )
            except PlaywrightTimeoutError:
                print(
                    f"[ADAPTER:{source_id}] "
                    f"タイムアウト: ニュース一覧描画待ち"
                )
                return []

            # --------------------------------------------------
            # 記事リンクを収集
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

                # /ja/news/<数字>/ の形式のみ対象
                # /ja/news/（一覧ページ自体）は除外
                if not re.search(r"/ja/news/\d+", href):
                    continue

                article_id = _extract_article_id(href)

                # 重複除去（同じ記事IDを2回取らない）
                if article_id in seen_ids:
                    continue
                seen_ids.add(article_id)

                # ------------------------------------------
                # タイトル取得
                # リンク内テキストから最も長い行を採用
                # ------------------------------------------
                inner_text = link.inner_text().strip()
                title = ""

                if inner_text:
                    parts = [
                        p.strip()
                        for p in inner_text.split("\n")
                        if p.strip()
                    ]
                    if parts:
                        title = max(parts, key=len)

                if not title:
                    title = f"記事 #{article_id}"

                # ------------------------------------------
                # 公開日時取得
                # <time datetime="..."> を優先し、
                # なければ "2026.08.15" パターンを探す
                # ------------------------------------------
                published_at = ""

                time_el = link.query_selector("time")
                if time_el:
                    published_at = (
                        time_el.get_attribute("datetime")
                        or time_el.inner_text().strip()
                    )

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

                # ------------------------------------------
                # 共通形式で追加
                # ------------------------------------------
                articles.append({
                    "source_id":   source_id,
                    "source_name": source_name,
                    "source_type": source_type,
                    "title":       title,
                    "url":         href,
                    "published_at": published_at,
                    "article_id":  article_id,
                })

                if len(articles) >= max_items:
                    break

        except Exception as e:
            print(
                f"[ADAPTER:{source_id}] "
                f"取得中にエラー: {e}"
            )

        finally:
            browser.close()

    return articles
