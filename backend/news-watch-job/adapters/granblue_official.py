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
    clean_url = url.split("?")[0].split("#")[0]
    match = re.search(
        r"/ja/news/.*?(\d+)/?$",
        clean_url,
    )
    if match:
        return match.group(1)

    return (
        hashlib.sha1(
            clean_url.encode("utf-8")
        ).hexdigest()[:12]
    )


def _is_article_url(href: str) -> bool:
    clean_url = href.split("?")[0].split("#")[0]
    
    if not clean_url.startswith("https://granbluefantasy.com/ja/news/"):
        return False
        
    path = clean_url.replace("https://granbluefantasy.com", "")
    
    excludes = [
        r"^/ja/news/?$",
        r"^/ja/news/category/?",
        r"^/ja/news/archive/?",
    ]
    
    for pattern in excludes:
        if re.search(pattern, path):
            return False
            
    return True


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

            # JavaScriptエラー記録
            page_errors: list[str] = []
            def on_page_error(err):
                msg = str(err).replace("\n", " ")[:200]
                page_errors.append(msg)
            page.on("pageerror", on_page_error)

            # ネットワークレスポンス記録 (URLとHTTPステータスのみ、最大10件保持)
            network_responses: list[str] = []
            def on_response(res):
                url = res.url
                if "granbluefantasy.com" in url or any(k in url.lower() for k in ["json", "data", "api", "news"]):
                    if len(network_responses) < 20:
                        network_responses.append(f"{res.status} {url[:120]}")
            page.on("response", on_response)

            def scrape_page(url_to_open, page_name):
                print(f"[OFFICIAL_DIAG] page={page_name}")
                page_errors.clear()
                network_responses.clear()

                # 1. ページ遷移 (domcontentloaded を基準に待機)
                try:
                    page.goto(
                        url_to_open,
                        timeout=PAGE_LOAD_TIMEOUT_MS,
                        wait_until="domcontentloaded",
                    )
                except PlaywrightTimeoutError:
                    print(f"[OFFICIAL_DIAG] timeout: goto_domcontentloaded")
                except Exception as e:
                    print(f"[OFFICIAL_DIAG] goto_error: {e}")

                # 2. SPA初期レンダリング待機 (数秒待機 + セレクタ待機)
                try:
                    page.wait_for_timeout(3000)
                except Exception:
                    pass

                try:
                    page.wait_for_selector(
                        "a[href*='/ja/news/']",
                        timeout=10000,
                    )
                except PlaywrightTimeoutError:
                    print(f"[OFFICIAL_DIAG] timeout: wait_for_selector")
                except Exception as e:
                    print(f"[OFFICIAL_DIAG] selector_error: {e}")

                # 3. ページ基本情報とDOM診断
                final_url = page.url
                try:
                    title_text = page.title() or ""
                except Exception:
                    title_text = ""
                title_chars = len(title_text)

                try:
                    body_text = page.inner_text("body") or ""
                except Exception:
                    body_text = ""
                body_text_chars = len(body_text)

                # DOM存在件数の確認
                try:
                    all_a = page.query_selector_all("a")
                    anchor_count = len(all_a)
                except Exception:
                    anchor_count = 0

                try:
                    a_href = page.query_selector_all("a[href]")
                    a_href_count = len(a_href)
                except Exception:
                    a_href_count = 0

                try:
                    a_news_href = page.query_selector_all("a[href*='/ja/news/']")
                    news_href_count = len(a_news_href)
                except Exception:
                    news_href_count = 0

                try:
                    any_news_href = page.query_selector_all("[href*='/ja/news/']")
                    any_news_href_count = len(any_news_href)
                except Exception:
                    any_news_href_count = 0

                has_news_heading = "NEWS" in body_text or "news" in body_text.lower()
                has_latest_heading = "新着情報" in body_text or "お知らせ" in body_text

                # 4. 診断ログ出力 (ASCII中心、本文は文字数のみ)
                print(f"[OFFICIAL_DIAG] stage=goto_done")
                print(f"[OFFICIAL_DIAG] final_url={final_url}")
                print(f"[OFFICIAL_DIAG] title_chars={title_chars}")
                print(f"[OFFICIAL_DIAG] body_text_chars={body_text_chars}")
                print(f"[OFFICIAL_DIAG] anchor_count={anchor_count}")
                print(f"[OFFICIAL_DIAG] a_href_count={a_href_count}")
                print(f"[OFFICIAL_DIAG] news_href_count={news_href_count}")
                print(f"[OFFICIAL_DIAG] any_news_href_count={any_news_href_count}")
                print(f"[OFFICIAL_DIAG] has_news_heading={str(has_news_heading).lower()}")
                print(f"[OFFICIAL_DIAG] has_latest_heading={str(has_latest_heading).lower()}")

                # JSエラー出力 (最大3件)
                print(f"[OFFICIAL_DIAG] js_error_count={len(page_errors)}")
                for err_msg in page_errors[:3]:
                    print(f"[OFFICIAL_DIAG] js_error={err_msg}")

                # ネットワーク通信診断 (最大10件)
                print(f"[OFFICIAL_DIAG] net_resp_count={len(network_responses)}")
                for resp_info in network_responses[:10]:
                    print(f"[OFFICIAL_DIAG] net_resp={resp_info}")

                # 5. 記事リンク解析
                links = page.query_selector_all("a[href*='/ja/news/']")
                if not links:
                    links = page.query_selector_all("[href*='/ja/news/']")

                seen_ids: set[str] = set()
                results = []
                sample_urls = []

                for link in links:
                    href = link.get_attribute("href") or ""
                    if href.startswith("/"):
                        href = "https://granbluefantasy.com" + href

                    if not _is_article_url(href):
                        continue

                    article_id = _extract_article_id(href)
                    if article_id in seen_ids:
                        continue
                    seen_ids.add(article_id)

                    inner_text = ""
                    try:
                        inner_text = link.inner_text().strip()
                    except Exception:
                        pass

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

                    published_at = ""
                    try:
                        time_el = link.query_selector("time")
                        if time_el:
                            published_at = (
                                time_el.get_attribute("datetime")
                                or time_el.inner_text().strip()
                            )
                    except Exception:
                        pass

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

                    results.append({
                        "source_id":   source_id,
                        "source_name": source_name,
                        "source_type": source_type,
                        "title":       title,
                        "url":         href,
                        "published_at": published_at,
                        "article_id":  article_id,
                    })

                    if len(sample_urls) < 3:
                        sample_urls.append(href)

                    if len(results) >= max_items:
                        break

                print(f"[OFFICIAL_DIAG] article_link_count={len(results)}")
                if sample_urls:
                    print(f"[OFFICIAL_DIAG] samples: {', '.join(sample_urls)}")

                return results

            # まずトップページを取得
            articles = scrape_page(target_url, "top")
            
            # 記事が0件ならカテゴリ一覧へフォールバック
            if not articles:
                print("[OFFICIAL_DIAG] fallback=category")
                articles = scrape_page("https://granbluefantasy.com/ja/news/category/", "category")
                
            print(f"[OFFICIAL_DIAG] final_fetched={len(articles)}")

        except Exception as e:
            print(
                f"[ADAPTER:{source_id}] "
                f"取得中にエラー: {e}"
            )

        finally:
            browser.close()

    return articles
