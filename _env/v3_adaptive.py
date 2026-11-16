"""V3: verify adaptive element relocation + MCP server tool inventory.

Like `_env/v1_offline.py`, one observation is one labelled line and a raising
observation becomes `OBSERVE-FAIL …` instead of aborting the rest of the file.
Expectations that do not hold are recorded in `FAILED`, and the exit code is
`1` when that list is non-empty — a probe that always exits 0 turns green in a
gate without verifying anything.

构造也一样：`Selector(...)` 与 `sqlite3.connect(...)` 都走 `build()` 而不是裸写。
它们抛错（存储不可写、adaptive 参数改名）时应该是一条点名失败，而不是 Traceback
把 [B] 的 no-LLM 检查与 [C] 的 MCP 清单一起吞掉 —— 那两段恰恰是出事时最想读的。
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
from typing import Any

from scrapling.parser import Selector

FAILED: list[str] = []

PRODUCTION_DIR = Path(__file__).resolve().parent.parent / "py"
REQUIREMENTS = PRODUCTION_DIR / "runtime-requirements.txt"
REPO_URL = "https://shop.example.com/p/1"
# 分桶粒度是**注册域**（`py/adapters.py` 的注释原话是「按注册域分桶」）：同注册域换 URL
# 仍会命中同一桶，所以这里必须换一个真不同的注册域，否则这条判据测不出分桶。
OTHER_URL = "https://other-shop.test/p/2"

# 上游 0.5.x 的真机 `tools/list` 是 16 枚；这里在钉住的版本上量到 17 枚（含
# `close_session` / `list_sessions` 两个会话级工具）。地板取 16 是为了容住小幅增删，
# 又不至于把「只剩一两枚」这种缩水放过 —— 那条正是只印一行数字看不见的回归。
MIN_TOOLS = 16
REQUIRED_TOOLS = ("browser_fetch", "make_request", "open_request_session")

# 「本插件不依赖 LLM 栈」这句声明该由**生产侧的 import 面与依赖钉版**证明，
# 不该由这台机器装没装它们证明：开发机或任何装了 numpy 的 CI 镜像都会让一份
# 与被审对象无关的断言变红，而源码里真的 `import openai` 反而不报。
LLM_STACK = (
    "openai",
    "anthropic",
    "ollama",
    "litellm",
    "transformers",
    "sentence_transformers",
    "sklearn",
    "numpy",
)
IMPORT_RE = re.compile(r"^\s*(?:from|import)\s+(?P<module>[A-Za-z_][A-Za-z0-9_]*)", re.MULTILINE)


def fail(label: str, error: BaseException) -> None:
    """Record and print one failed observation, once, in one shape."""
    FAILED.append(label)
    print(f"  {label:<28} -> OBSERVE-FAIL {type(error).__name__}: {error}")


def check(label: str, value: Callable[[], object]) -> None:
    """Print one observation; a raising `value()` becomes a labelled failure."""
    try:
        print(f"  {label:<28} -> {value()}")
    except Exception as error:  # noqa: BLE001 — 探针要报任何一类意外，而不是只报预料到的那种
        fail(label, error)


def expect(label: str, ok: Callable[[], bool]) -> None:
    """Print one expectation; `False` is a recorded failure, not just a line."""
    try:
        holds = ok()
    except Exception as error:  # noqa: BLE001
        fail(label, error)
        return
    if not holds:
        FAILED.append(label)
    print(f"  {label:<28} -> {'OK' if holds else 'FAIL'}")


def build(label: str, factory: Callable[[], Any]) -> Any:
    """Construct something the later observations reuse; a raise is one failed row.

    Returns `None` on failure, so the caller can skip the observations that need it
    without turning the whole file into a stack trace.
    """
    try:
        built = factory()
    except Exception as error:  # noqa: BLE001
        fail(label, error)
        return None
    print(f"  {label:<28} -> built")
    return built


print("=== [A] Adaptive relocation (the flagship 'AI' feature) ===")

DB = os.path.join(tempfile.mkdtemp(), "adaptive.db")


def storage_args(url: str) -> dict[str, Any]:
    """`storage_args` in the shape production uses (`py/adapters.py` `_adaptive_kwargs`).

    `url` 必须一起给：Scrapling 对「给了部分 storage_args」是整体替换而不是补齐，
    漏了它全部指纹都会落进 default 桶 —— 只验 storage_file 就绕开了按 URL 分桶那条路。
    """
    return {"storage_file": DB, "url": url}


V1 = """<html><body><div class="wrap">
  <span class="p1">$19.99</span>
  <span class="unrelated">x</span>
</div></body></html>"""

V2 = """<html><body><div class="wrap">
  <span class="price-final">$19.99</span>
  <span class="unrelated">x</span>
</div></body></html>"""

s1 = build("build s1", lambda: Selector(V1, url=REPO_URL, adaptive=True, storage_args=storage_args(REPO_URL)))
if s1 is not None:
    check("v1 css('.p1::text')", lambda: s1.css(".p1::text").get())

s2 = build(
    "build s2 (auto_save)", lambda: Selector(V1, url=REPO_URL, adaptive=True, storage_args=storage_args(REPO_URL))
)
if s2 is not None:
    check("v1 auto_save=True", lambda: s2.css(".p1::text", auto_save=True).get())

check("sqlite file", lambda: (os.path.exists(DB), os.path.getsize(DB) if os.path.exists(DB) else 0))

IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def inspect(con: sqlite3.Connection, table: str) -> str:
    """One table's columns and row count, with SQLite's own syntax in mind.

    PRAGMA 与 COUNT 的表名位置不接受参数绑定，只能拼字符串；所以先按标识符形状验一遍，
    不合形状的只报一句话 —— 拼进去的东西因此不可能是表名之外的东西。
    """
    if not IDENTIFIER_RE.match(table):
        return "跳过（不是可拼进 SQL 的标识符形状）"
    columns = [c[1] for c in con.execute(f"PRAGMA table_info({table})")]
    # 这条抑制的理由是上面那道标识符校验：SQLite 的表名位置根本不接受参数绑定。
    count = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]  # noqa: S608
    return f"cols={columns} rows={count}"


def inspect_tables() -> None:
    """每张表一行观察：一条查询抛错只记这张表的 OBSERVE-FAIL，而不是整份探针的 Traceback。"""
    if not os.path.exists(DB):
        return
    # `with sqlite3.connect(DB)` 只管事务提交、不管关连接：中间任何一条查询抛错，
    # 手写的那句 close() 就轮不到。closing() 把两件事一起兜住。
    with contextlib.closing(sqlite3.connect(DB)) as con:
        tables = [row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        check("tables", lambda: tables)
        for table in tables:
            check(f"table {table}", partial(inspect, con, table))


check("inspect storage", inspect_tables)

s3 = build(
    "build s3 (v2, adaptive)", lambda: Selector(V2, url=REPO_URL, adaptive=True, storage_args=storage_args(REPO_URL))
)
if s3 is not None:
    check("v2 css('.p1::text', adaptive=True)", lambda: s3.css(".p1::text", adaptive=True).get())
    expect("relocation finds the moved node", lambda: s3.css(".p1::text", adaptive=True).get() is not None)

s4 = build("build s4 (v2, no adaptive)", lambda: Selector(V2, url=REPO_URL))
if s3 is not None and s4 is not None:
    # 对照而不是两次独立断言：V2 里本来就没有 `.p1`，单看 s4 得到 None 无论 adaptive
    # 实现对不对都成立、永远无法失败。要证的是「重定位带来了差异」，所以两边一起判。
    expect(
        "relocation differs from plain css",
        lambda: s3.css(".p1::text", adaptive=True).get() is not None and s4.css(".p1::text").get() is None,
    )

s5 = build(
    "build s5 (other url)",
    lambda: Selector(V2, url=OTHER_URL, adaptive=True, storage_args=storage_args(OTHER_URL)),
)
if s5 is not None:
    # 指纹按**注册域**分桶：换一个注册域就不该命中上一个桶里存下的那份。
    expect(
        "another site does not reuse the fingerprint",
        lambda: s5.css(".p1::text", adaptive=True).get() is None,
    )

print("\n=== [B] No-LLM check ===")


def production_sources() -> list[Path]:
    """The Python files that ship in `py/`; unreadable means the probe is blind, not upstream."""
    if not PRODUCTION_DIR.is_dir():
        raise LookupError(f"找不到 {PRODUCTION_DIR}（探针的搜索范围不对，不等于生产侧有问题）")
    files = sorted(PRODUCTION_DIR.glob("*.py"))
    if not files:
        raise LookupError(f"{PRODUCTION_DIR} 下一份 *.py 都没有（探针失明，不是上游回归）")
    return files


def imported_modules(files: list[Path]) -> set[str]:
    """Top-level module names the production sources import."""
    modules: set[str] = set()
    for path in files:
        modules.update(IMPORT_RE.findall(path.read_text(encoding="utf-8")))
    return modules


def requirement_lines() -> str:
    """The pinned requirements file, lower-cased for a substring check."""
    return REQUIREMENTS.read_text(encoding="utf-8").lower()


sources = build("production py/ sources", production_sources)
if sources is not None:
    imported = imported_modules(sources)
    for token in LLM_STACK:
        expect(f"py/ does not import {token}", lambda token=token: token not in imported)

pinned = build("runtime-requirements.txt", requirement_lines)
if pinned is not None:
    for token in LLM_STACK:
        expect(f"requirements do not pin {token}", lambda token=token, text=pinned: token not in text)

# 环境里装了什么是**提示**，不是判据：它由这台机器/这个镜像决定，与被审对象无关。
present = [token for token in LLM_STACK if importlib.util.find_spec(token) is not None]
print(f"  {'interpreter has (info only)':<28} -> {present or 'none'}")

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


def inventory() -> dict[str, Any]:
    """Count registered tools per registration shape, and hand back the scanned surface.

    `rglob` 而不是 `glob`：上游把工具拆进子包（`ai/tools/*.py`）时非递归的 glob
    一份都扫不到，`inventory()` 会抛 LookupError —— 于是探针把自己的搜索范围不当作成
    上游的能力回归。失败文案里带上扫到的份数，才能分清「扫了没命中」与「根本没扫到」。
    """
    folder = ai_folder()
    files = sorted(folder.rglob("*.py"))
    if not files:
        raise LookupError(f"{folder} 下 rglob('*.py') 一份都没有（探针失明，不是上游回归）")
    sources = "\n".join(path.read_text(encoding="utf-8") for path in files)
    added = sorted(set(ADD_TOOL_RE.findall(sources)))
    decorated = sorted(set(DECORATED_RE.findall(sources)))
    bare = len(BARE_DECORATOR_RE.findall(sources))
    if not added and not decorated and not bare:
        raise LookupError(
            f"扫了 {len(files)} 份 .py，三种登记写法都没命中"
            '（add_tool / @x.tool("name") / @x.tool()）—— '
            "那是探针不认识新的登记形状，不等于 MCP 面没有工具"
        )
    return {"files": len(files), "added": added, "decorated": decorated, "bare": bare}


check("ai package folder", lambda: str(ai_folder()))

found = build("tool inventory", inventory)
if found is not None:
    added = found["added"]
    print(f"  {'tools registered':<28} -> {len(added)} {added}")
    print(f"  {'files scanned':<28} -> {found['files']} (decorated={len(found['decorated'])} bare={found['bare']})")
    # 这条是 [C] 的判据本体：原先这里只印一行数字，工具面从 17 枚缩到 1 枚也照样 exit 0。
    expect(f"at least {MIN_TOOLS} tools registered", lambda: len(added) >= MIN_TOOLS)
    for name in REQUIRED_TOOLS:
        expect(f"inventory lists {name}", lambda name=name: name in added)

print("\nfailed observations  :", ", ".join(FAILED) if FAILED else "none")
raise SystemExit(1 if FAILED else 0)
