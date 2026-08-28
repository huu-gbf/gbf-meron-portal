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
