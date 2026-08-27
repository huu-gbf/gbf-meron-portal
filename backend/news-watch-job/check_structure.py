import json
import pathlib
import hashlib

# =======================================
# sites.json の読み込みテスト
# =======================================
p = pathlib.Path(__file__).parent / "sites.json"
sites = json.loads(p.read_text(encoding="utf-8"))
enabled = [s for s in sites if s.get("enabled")]

print(f"sites.json: {len(sites)} 件 / enabled={len(enabled)} 件")

for s in enabled:
    print("  id=" + s["id"] + "  method=" + s["method"] + "  adapter=" + s["adapter"])

# =======================================
# doc_id 生成ロジックのテスト
# =======================================
def make_doc_id(source_id, article_id):
    return source_id + "_" + article_id

cases = [
    ("granblue_official", "9760"),
    ("granblue_official", "9761"),
    ("gamewith_gbf",      "a1b2c3d4e5f6"),
]
print()
print("doc_ID生成テスト:")
for sid, aid in cases:
    print("  " + make_doc_id(sid, aid))

# =======================================
# Gemini import チェック
# =======================================
print()
print("Gemini import チェック:")
base = pathlib.Path(__file__).parent

targets = [
    base / "watch_news.py",
    base / "adapters" / "granblue_official.py",
    base / "adapters" / "__init__.py",
]

for fpath in targets:
    src = fpath.read_text(encoding="utf-8")
    has_gemini = (
        "google.generativeai" in src
        or "from google import genai" in src
        or "import genai" in src
    )
    status = "NG (Gemini importあり)" if has_gemini else "OK (Gemini importなし)"
    print("  " + status + ": " + str(fpath.name))

# =======================================
# adapter動的ロードのテスト（importのみ）
# =======================================
print()
print("adapterロードテスト:")
import sys
sys.path.insert(0, str(base))

try:
    import importlib
    mod = importlib.import_module("adapters.granblue_official")
    has_fetch = hasattr(mod, "fetch")
    print("  OK: adapters.granblue_official loaded, fetch=" + str(has_fetch))
except ImportError as e:
    print("  NOTE: " + str(e) + " (Playwright未インストールのため想定内)")

print()
print("全テスト完了")
