import watch_news
from unittest.mock import MagicMock

def print_result(case, result):
    print(f"=== {case} ===")
    print(result)
    print()

class MockDB:
    pass

db = MockDB()

base_site_config = {'id': 'test_site', 'name': 'Test', 'method': 'rss', 'adapter': 'youtube_channel'}

def run_test(case_name, init_state, known, articles, initial_seed_only=False, fetch_err=None):
    watch_news.DRY_RUN = False
    watch_news.INITIAL_SEED_ONLY = initial_seed_only
    
    watch_news.fetch_known_ids = MagicMock(return_value=set(known))
    watch_news.fetch_site_state = MagicMock(return_value={'initialized': init_state})
    watch_news.save_article = MagicMock()
    watch_news.save_site_state = MagicMock()
    
    mock_adapter = MagicMock()
    if fetch_err:
        mock_adapter.fetch.side_effect = Exception(fetch_err)
    else:
        mock_adapter.fetch.return_value = articles
        
    watch_news.load_adapter = MagicMock(return_value=(mock_adapter, None))
    
    watch_news.process_site(base_site_config, db)
    
    # Check save_site_state args
    saves = watch_news.save_site_state.call_args_list
    final_save = saves[-1] if saves else None
    if final_save:
        kwargs = final_save.kwargs
        return f"Final save initialized={kwargs.get('initialized')}"
    return 'No save_site_state called'

print("\n--- Mock Test Start ---\n")

# A: initialized=False, known=0, 初回seed成功 -> 最終state initialized=True
print_result('Case A', run_test('A', False, [], [{'article_id': '1'}]))

# B: 既にinitialized=True, 新着なし -> 状態保存後も initialized=True
print_result('Case B', run_test('B', True, ['1'], []))

# C: 既にinitialized=True, エラー発生 -> エラー状態を保存しても initialized=True は消えない
print_result('Case C', run_test('C', True, ['1'], [], fetch_err='Network Error'))

# D: INITIAL_SEED_ONLY=1 -> pendingを生成しない
run_test('D', True, ['1'], [{'article_id': '1'}, {'article_id': '2'}], initial_seed_only=True)
saved = watch_news.save_article.call_args_list
print_result('Case D', f"Status saved: {[call.kwargs.get('status') for call in saved]}")

# E: INITIAL_SEED_ONLY=0, initialized=True, 新着あり -> pendingになる
run_test('E', True, ['1'], [{'article_id': '1'}, {'article_id': '2'}], initial_seed_only=False)
saved = watch_news.save_article.call_args_list
print_result('Case E', f"Status saved: {[call.kwargs.get('status') for call in saved]}")

# ==================================================
# article_id 正規化テスト
# ==================================================
print("\n--- Normalization Tests ---\n")

def run_norm_test(known, articles):
    watch_news.DRY_RUN = False
    watch_news.INITIAL_SEED_ONLY = False
    watch_news.fetch_known_ids = MagicMock(return_value=set(known))
    watch_news.fetch_site_state = MagicMock(return_value={'initialized': True})
    watch_news.save_article = MagicMock()
    watch_news.save_site_state = MagicMock()

    mock_adapter = MagicMock()
    # 記事リストのディープコピーを渡して、内部での変更（article["article_id"] = ...）が
    # 呼び出し元に影響しないようにするか、単にそのままでもOK
    mock_adapter.fetch.return_value = articles
    watch_news.load_adapter = MagicMock(return_value=(mock_adapter, None))

    watch_news.process_site(base_site_config, db)
    return watch_news.save_article.call_args_list

# 新A: article_idあり -> 変更なし
saved_a = run_norm_test([], [{'article_id': '123', 'url': 'https://example.com/a'}])
assert len(saved_a) == 1, "Norm A: save_article should be called exactly once"
args_a = saved_a[0].args[1]
assert args_a.get('article_id') == "123", "Norm A: article_id should remain '123'"
assert saved_a[0].kwargs.get("status") == "pending", "Norm A: status should be pending"
print_result('Norm A (article_id given)', f"Saved article_id: {args_a.get('article_id')}")

# 新B: article_idなし + URLあり -> URLハッシュ生成
saved_b = run_norm_test([], [{'url': 'https://example.com/article/1'}])
assert len(saved_b) == 1, "Norm B: save_article should be called exactly once"
args_b = saved_b[0].args[1]
expected_hash = watch_news.make_article_id_from_url('https://example.com/article/1')
assert args_b.get('article_id') == expected_hash, "Norm B: article_id should be URL hash"
assert saved_b[0].kwargs.get("status") == "pending", "Norm B: status should be pending"
print_result('Norm B (no article_id, url given)', f"Saved article_id: {args_b.get('article_id')}")

# 新C: 同じURL再処理 -> 既知IDなのでsaveされない
url_hash = watch_news.make_article_id_from_url('https://example.com/article/1')
saved_c = run_norm_test([url_hash], [{'url': 'https://example.com/article/1'}])
assert len(saved_c) == 0, "Norm C: save_article should not be called"
print_result('Norm C (same url again)', f"Save called: {len(saved_c)} times")

# 新D: article_idなし + URLなし -> スキップ
saved_d = run_norm_test([], [{'title': 'no_url_no_id'}])
assert len(saved_d) == 0, "Norm D: save_article should not be called"
print_result('Norm D (no id, no url)', f"Save called: {len(saved_d)} times")

# 新E: 既存article_id -> 除外
saved_e = run_norm_test(['123'], [{'article_id': '123', 'url': 'https://example.com/a'}])
assert len(saved_e) == 0, "Norm E: save_article should not be called"
print_result('Norm E (existing article_id)', f"Save called: {len(saved_e)} times")
