"""V3: verify adaptive element relocation + MCP server tool inventory."""

import os, tempfile, inspect

print("=== [A] Adaptive relocation (the flagship 'AI' feature) ===")
from scrapling.parser import Selector

DB = os.path.join(tempfile.mkdtemp(), "adaptive.db")

V1 = """<html><body><div class="wrap">
  <span class="p1">$19.99</span>
  <span class="unrelated">x</span>
</div></body></html>"""

V2 = """<html><body><div class="wrap">
  <span class="price-final">$19.99</span>
  <span class="unrelated">x</span>
</div></body></html>"""

s1 = Selector(V1, url="https://shop.example.com/p/1", adaptive=True, storage_args={"storage_file": DB})
got = s1.css(".p1::text").get()
print(f"  v1 css('.p1::text')      -> {got!r}   (auto_save default False)")

s2 = Selector(V1, url="https://shop.example.com/p/1", adaptive=True, storage_args={"storage_file": DB})
got2 = s2.css(".p1::text", auto_save=True).get()
print(f"  v1 auto_save=True        -> {got2!r}")

print(f"\n  sqlite file exists: {os.path.exists(DB)}  size={os.path.getsize(DB) if os.path.exists(DB) else 0}")
if os.path.exists(DB):
    import sqlite3
    con = sqlite3.connect(DB)
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    print(f"  tables: {tables}")
    for t in tables:
        cols = [c[1] for c in con.execute(f"PRAGMA table_info({t})")]
        cnt = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(f"    {t}: cols={cols} rows={cnt}")
    con.close()

s3 = Selector(V2, url="https://shop.example.com/p/1", adaptive=True, storage_args={"storage_file": DB})
try:
    reloc = s3.css(".p1::text", adaptive=True).get()
    print(f"\n  v2 css('.p1::text', adaptive=True) -> {reloc!r}")
    print("  ==> ADAPTIVE RELOCATION WORKS" if reloc else "  ==> relocation returned nothing")
except Exception as e:
    print(f"\n  v2 adaptive relocation raised: {type(e).__name__}: {e}")

s4 = Selector(V2, url="https://shop.example.com/p/1")
print(f"  v2 css('.p1::text') WITHOUT adaptive -> {s4.css('.p1::text').get()!r}")

print("\n\n=== [B] No-LLM check ===")
for tok in ("openai", "anthropic", "ollama", "litellm", "transformers",
            "sentence_transformers", "sklearn", "numpy"):
    try:
        mod = __import__(tok)
        print(f"  {tok:22} IMPORTABLE: {getattr(mod,'__version__','?')}")
    except Exception:
        print(f"  {tok:22} not importable")

print("\n=== [C] MCP server surface ===")
try:
    from scrapling.core import ai
    print(f"  module: {ai.__file__}")
    src = inspect.getsource(ai)
    import re
    tools = sorted(set(re.findall(r'@(?:mcp|server|app)\.tool\(\s*(?:name\s*=\s*)?["\']([a-z_0-9]+)["\']', src)))
    print(f"  decorated tools ({len(tools)}): {tools}")
    if not tools:
        names = sorted(set(re.findall(r'^\s*(?:async )?def ([a-z_0-9]+)\(', src, re.M)))
        print(f"  all top-level fn names: {names}")
except Exception as e:
    print(f"  FAILED: {type(e).__name__}: {e}")