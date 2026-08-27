"""
adapters パッケージ

各adapterは、指定されたサイトから記事一覧を取得し、
共通形式のリストとして返す責務だけを持ちます。

Firestoreへの書き込みは行いません。

共通形式（各adapterが返すdictの構造）:
  {
      "source_id":   str   # sites.jsonのidと同値
      "source_name": str   # サイト表示名
      "source_type": str   # "official_news" / "strategy_site" など
      "title":       str   # 記事タイトル
      "url":         str   # 記事URL（絶対URL）
      "published_at": str  # 公開日時（取得できた場合）
      "article_id":  str   # サイト内記事ID or sha1(url)[:12]
  }

adapterを追加する場合:
  1. このパッケージに新しい .py ファイルを置く
  2. sites.json の "adapter" フィールドにそのファイル名を指定する
  3. そのモジュールに fetch(site_config: dict) -> list[dict] を実装する
"""
