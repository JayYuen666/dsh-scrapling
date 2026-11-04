"""V3: verify adaptive element relocation + MCP server tool inventory.

Like `_env/v1_offline.py`, one observation is one labelled line and a raising
observation becomes `OBSERVE-FAIL …` instead of aborting the rest of the file.
Expectations that do not hold are recorded in `FAILED`, and the exit code is
`1` when that list is non-empty — a probe that always exits 0 turns green in a
gate without verifying anything.
"""

import contextlib
import importlib.util
import os
import re
import sqlite3
import tempfile
from collections.abc import Callable
from functools import partial
from pathlib import Path

from scrapling.parser import Selector

FAILED: list[str] = []


def check(label: str, value: Callable[[], object]) -> None:
    """Print one observation; a raising `value()` becomes a labelled failure."""
    try:
        print(f"  {label:<28} -> {value()}")
    except Exception as error:  # noqa: BLE001 — 探针要报任何一类意外，而不是只报预料到的那种
        FAILED.append(label)
        print(f"  {label:<28} -> OBSERVE-FAIL {type(error).__name__}: {error}")


def expect(label: str, ok: Callable[[], bool]) -> None:
    """Print one expectation; `False` is a recorded failure, not just a line."""
    try:
        holds = ok()
    except Exception as error:  # noqa: BLE001
        FAILED.append(label)
        print(f"  {label:<28} -> OBSERVE-FAIL {type(error).__name__}: {error}")
        return
    if not holds:
        FAILED.append(label)
    print(f"  {label:<28} -> {'OK' if holds else 'FAIL'}")


def not_importable(name: str) -> bool:
    """Whether this interpreter fails to import `name`."""
    try:
        __import__(name)
    except ImportError:
        return True
    return False


print("=== [A] Adaptive relocation (the flagship 'AI' feature) ===")

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
check("v1 css('.p1::text')", lambda: s1.css(".p1::text").get())

s2 = Selector(V1, url="https://shop.example.com/p/1", adaptive=True, storage_args={"storage_file": DB})
check("v1 auto_save=True", lambda: s2.css(".p1::text", auto_save=True).get())

check("sqlite file", lambda: (os.path.exists(DB), os.path.getsize(DB) if os.path.exists(DB) else 0))
IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
if os.path.exists(DB):
    # `with sqlite3.connect(DB)` 只管事务提交，不管关连接：中间任何一条查询抛错，
    # 手写的那句 close() 就轮不到。closing() 把两件事一起兜住。
    with contextlib.closing(sqlite3.connect(DB)) as con:
        tables = [row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        check("tables", lambda: tables)

        def inspect(table: str) -> str:
            # PRAGMA 与 COUNT 的表名位置不接受参数绑定，只能拼字符串；所以先按标识符形状验一遍，
            # 不合形状的只报一句话 —— 拼进语句里的东西因此不可能是别的东西。
            if not IDENTIFIER_RE.match(table):
                return "跳过（不是可拼进 SQL 的标识符形状）"
            columns = [c[1] for c in con.execute(f"PRAGMA table_info({table})")]
            # 这条抑制的理由是上面那道标识符校验：这一档 SQLite 语法根本不接受参数绑定。
            count = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]  # noqa: S608
            return f"cols={columns} rows={count}"

        # 每张表一行观察：一条查询抛错时，记的是这张表的 OBSERVE-FAIL，而不是整份探针的
        # Traceback，且 `closing()` 仍然把连接关掉。
        for table in tables:
            check(f"table {table}", partial(inspect, table))

s3 = Selector(V2, url="https://shop.example.com/p/1", adaptive=True, storage_args={"storage_file": DB})
check("v2 css('.p1::text', adaptive=True)", lambda: s3.css(".p1::text", adaptive=True).get())
expect("relocation finds the moved node", lambda: s3.css(".p1::text", adaptive=True).get() is not None)

s4 = Selector(V2, url="https://shop.example.com/p/1")
expect("without adaptive it misses", lambda: s4.css(".p1::text").get() is None)

print("\n=== [B] No-LLM check ===")
for token in (
    "openai",
    "anthropic",
    "ollama",
    "litellm",
    "transformers",
    "sentence_transformers",
    "sklearn",
    "numpy",
):
    # 期望是「导不到」：这些包一旦可导入，本插件不依赖 LLM 栈那句声明就不成立。
    expect(f"{token} not importable", partial(not_importable, token))

print("\n=== [C] MCP server surface ===")
# 上游 0.5.x 的登记写法是 `server.add_tool(_mcp_tool(self.<name>), title=…)`，而 import
# `scrapling.core.ai` 需要 ai extra（pydantic）。所以这里不 import，只用 find_spec 拿到包目录
# 再读源码文件：读不到文件与「一个工具都没有」是两种结论，混成一句「未发现工具」就会把探针
# 自己的失明报成上游的能力。
AI_PACKAGE = "scrapling.core.ai"
ADD_TOOL_RE = re.compile(r"add_tool\(\s*_mcp_tool\(self\.([A-Za-z_0-9]+)\)")
DECORATED_RE = re.compile(r"""@(?:mcp|server|app)\.tool\(\s*(?:name\s*=\s*)?["']([A-Za-z_0-9]+)["']""")
BARE_DECORATOR_RE = re.compile(r"@(?:mcp|server|app)\.tool\(\s*\)")


def ai_folder() -> Path:
    """The installed `scrapling.core.ai` package directory, without importing it.

    `find_spec` only executes the parent packages, so this still answers when the ai
    extra itself is missing its own dependencies.
    """
    spec = importlib.util.find_spec(AI_PACKAGE)
    if spec is None or spec.origin is None:
        raise LookupError(f"找不到 {AI_PACKAGE}（ai extra 没装，探针无从判定）")
    return Path(spec.origin).parent


def inventory() -> str:
    """Count registered tools per registration shape, or say it cannot tell."""
    sources = "\n".join(path.read_text(encoding="utf-8") for path in sorted(ai_folder().glob("*.py")))
    added = sorted(set(ADD_TOOL_RE.findall(sources)))
    decorated = sorted(set(DECORATED_RE.findall(sources)))
    bare = len(BARE_DECORATOR_RE.findall(sources))
    if not added and not decorated and not bare:
        raise LookupError(
            '源码里三种登记写法都没命中（add_tool / @x.tool("name") / @x.tool()）—— '
            "那是探针不认识新的登记形状，不等于 MCP 面没有工具"
        )
    return f"add_tool={len(added)} {added} | decorated={len(decorated)} {decorated} | bare-decorators={bare}"


check("ai package folder", lambda: str(ai_folder()))
check("tool inventory", inventory)

print("\nfailed observations  :", ", ".join(FAILED) if FAILED else "none")
raise SystemExit(1 if FAILED else 0)
