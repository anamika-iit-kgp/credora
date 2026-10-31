"""Build the Credora documentation site from the repo's Markdown.

    python sites/build_docs.py            # writes sites/docs/dist/

Renders README.md (home page) and docs/*.md into static HTML with a left nav, heading anchors and
CSS-only code highlighting, copies docs/architecture.html and the docs/diagrams/ folder in as-is, and copies the shared assets
(sites/_assets) and sites/docs/docs.css next to the pages. The output is self-contained: serve
sites/docs/dist/ as the web root of the docs site.

Links between the docs are rewritten to the generated pages. Links to code in the repository go to
the public repository: its URL is CREDORA_REPO_URL if set, otherwise the git remote "origin".

Needs only the standard library and the `markdown` package (see deploy/requirements.txt).
"""

from __future__ import annotations

import html
import os
import posixpath
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path

try:
    import markdown
except ImportError:  # pragma: no cover
    sys.exit("The `markdown` package is missing: pip install -r deploy/requirements.txt")

SITES = Path(__file__).resolve().parent
REPO = SITES.parent
OUT = SITES / "docs" / "dist"

# (source relative to the repo, output page, nav label)
PAGES = [
    ("README.md", "index.html", "Overview"),
    ("docs/WHY_EXASOL.md", "why-exasol.html", "Why Exasol"),
    ("docs/DATA_MODEL.md", "data-model.html", "Data model"),
    ("docs/API.md", "api.html", "APIs"),
    ("docs/PORTING.md", "porting.html", "Porting"),
    ("docs/GLOSSARY.md", "glossary.html", "Glossary"),
]
COPIED = [("docs/architecture.html", "architecture.html", "Architecture diagrams")]
# (source folder relative to the repo, output folder, nav label, page the nav links to)
COPIED_DIRS = [("docs/diagrams", "diagrams", "Diagrams", "index.html")]
# Extra nav links to pages inside the copied folders: (path in the site, nav label)
NAV_LINKS = [("diagrams/05-roles-access.html", "Roles and AI access")]
SOURCE_TO_PAGE = {src: out for src, out, _ in PAGES + COPIED}


# ---------------------------------------------------------------- repository links


def repo_url() -> str | None:
    url = os.environ.get("CREDORA_REPO_URL", "").strip()
    if not url:
        try:
            url = subprocess.run(
                ["git", "-C", str(REPO), "remote", "get-url", "origin"],
                capture_output=True, text=True, check=True,
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            return None
    m = re.match(r"^git@([^:]+):(.+?)(?:\.git)?$", url)
    if m:
        url = f"https://{m.group(1)}/{m.group(2)}"
    url = re.sub(r"\.git$", "", url).rstrip("/")
    return url if url.startswith("https://") else None


REPO_URL = repo_url()


def rewrite_href(href: str, src: str) -> str | None:
    """Map a Markdown link target to its place on the docs site; None drops the link (text stays)."""
    if re.match(r"^[a-z][a-z0-9+.-]*:", href, re.I) or href.startswith("#"):
        return href
    path, _, anchor = href.partition("#")
    target = posixpath.normpath(posixpath.join(posixpath.dirname(src), path)) if path else src
    frag = f"#{anchor}" if anchor else ""
    if target in SOURCE_TO_PAGE:
        return SOURCE_TO_PAGE[target] + frag
    for src_dir, out_dir, _, index in COPIED_DIRS:
        if target == src_dir:
            return f"{out_dir}/{index}{frag}"
        if target.startswith(src_dir + "/"):
            return out_dir + target[len(src_dir):] + frag
    if target.startswith(".."):
        return None
    if not REPO_URL:
        return None
    kind = "tree" if path.endswith("/") or (REPO / target).is_dir() else "blob"
    return f"{REPO_URL}/{kind}/HEAD/{target}{frag}"


# ---------------------------------------------------------------- headings and anchors


def slugify(value: str, separator: str = "-") -> str:
    """GitHub-style heading ids, so anchors match the repository view."""
    value = unicodedata.normalize("NFKD", html.unescape(re.sub(r"<[^>]+>", "", value)))
    value = re.sub(r"[^\w\s-]", "", value).strip().lower()
    return re.sub(r"\s+", separator, value)


# ---------------------------------------------------------------- CSS-only code highlighting

SQL_KW = set("""select from where and or not in is null as join left right inner outer on group by order having limit
with case when then else end create replace view table insert into update delete merge using values set distinct over
partition rows between union all exists like asc desc script emits returns python3 lua scalar import export jdbc at
connection identified user statement truncate commit rollback cast decimal varchar double integer boolean date
timestamp interval execute grant to role schema open close true false primary key references""".split())
SQL_FN = set("""sum avg count min max stddev median round abs ln exp sqrt nvl zeroifnull coalesce greatest least
add_months months_between days_between to_char to_date lag lead rank dense_rank row_number ntile
approximate_count_distinct hash_sha256 current_timestamp systimestamp""".split())
TOKEN_RES = {
    "sql": re.compile(r"""(--[^\n]*|/\*[\s\S]*?\*/)|('(?:[^']|'')*')|("[^"\n]*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+|[^\sA-Za-z0-9_'"-]+|-)"""),
    "json": re.compile(r"""()("(?:[^"\\]|\\.)*"(?=\s*:))|("(?:[^"\\]|\\.)*")|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b|[A-Za-z_][A-Za-z0-9_]*)|(\s+|[^\s"A-Za-z0-9_-]+|-)"""),
    "bash": re.compile(r"""(#[^\n]*)|('[^']*'|"(?:[^"\\]|\\.)*")|()(\b\d+\b)|([A-Za-z_][A-Za-z0-9_./-]*)|(\s+|[^\sA-Za-z0-9_'"#]+)"""),
}
BASH_KW = {"make", "cd", "export", "curl", "python", "npm", "git", "docker", "uv", "pip", "exasol", "aws", "if", "then", "fi", "for", "do", "done"}


def highlight(code: str, lang: str) -> str:
    rx = TOKEN_RES.get(lang)
    if rx is None:
        return html.escape(code)
    out: list[str] = []
    pos = 0
    for m in rx.finditer(code):
        if m.start() > pos:
            out.append(html.escape(code[pos:m.start()]))
        pos = m.end()
        com, s1, s2, num, word, rest = m.groups()
        tok = m.group(0)
        cls = None
        if com:
            cls = "com"
        elif lang == "json" and s1:
            cls = "key"
        elif s1 or s2:
            cls = "str"
        elif num:
            cls = "num"
        elif word:
            lw = word.lower()
            if lang == "sql":
                if lw in SQL_KW:
                    cls = "kw"
                elif lw in SQL_FN or code[m.end():m.end() + 1] == "(":
                    cls = "fn"
                elif re.fullmatch(r"[A-Z][A-Z0-9_]{2,}", word):
                    cls = "obj"
            elif lang == "json":
                cls = "kw"
            elif lang == "bash" and (word in BASH_KW or (out == [] or out[-1].endswith("\n"))):
                cls = "fn"
        out.append(f'<span class="t-{cls}">{html.escape(tok)}</span>' if cls else html.escape(tok))
    out.append(html.escape(code[pos:]))
    return "".join(out)


def guess_lang(code: str) -> str:
    c = code.lstrip()
    if c[:1] in "{[":
        return "json"
    if re.match(r"(?i)(select|create|execute|with|grant|insert|--)\b", c):
        return "sql"
    if re.match(r"(curl|make|cd|python|npm|git|docker|uv|aws|exasol)\b", c):
        return "bash"
    return ""


CODE_RE = re.compile(r'<pre><code(?: class="language-([\w-]+)")?>([\s\S]*?)</code></pre>')


def render_code(m: re.Match) -> str:
    code = html.unescape(m.group(2))
    lang = (m.group(1) or guess_lang(code)).lower()
    label = f'<span class="code-lang">{html.escape(lang)}</span>' if lang else ""
    return f'<div class="code">{label}<pre><code class="lang-{lang or "text"}">{highlight(code, lang)}</code></pre></div>'


# ---------------------------------------------------------------- page assembly

GEM = (
    '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path class="gem-face-d" d="M7.2 3.5h9.6L20.5 9H3.5Z"/>'
    '<path class="gem-face-a" d="M3.5 9h17L12 21.5Z"/><path class="gem-face-b" d="M8.6 9h6.8L12 21.5Z"/>'
    '<path class="gem-face-c" d="M3.5 9 8.6 9 12 21.5Z"/><path class="gem-edge" d="M7.2 3.5h9.6L20.5 9 12 21.5 3.5 9ZM3.5 9h17M8.6 9 12 3.5 15.4 9"/></svg>'
)
OUT_ICON = (
    '<svg class="out" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" '
    'stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>'
)
EXASOL = (
    '<span class="exasol-logo"><img class="on-dark" src="_assets/Exasol_Logo_2025_Bright.svg" alt="Exasol">'
    '<img class="on-light" src="_assets/Exasol_Logo_2025_Dark.svg" alt="Exasol"></span>'
)
CREDIT = (
    '<p class="exathon-credit"><span class="built">Built for ExaThon India 2026</span><span aria-hidden="true">·</span>'
    f'<span class="powered">Powered by {EXASOL} Personal</span></p>'
)


def nav_html(current: str, toc: list[tuple[int, str, str]]) -> str:
    items = []
    for _, out, label in PAGES:
        cur = out == current
        sub = ""
        if cur and toc:
            sub = '<ul class="toc">' + "".join(
                f'<li class="toc-l{lvl}"><a href="#{i}">{t}</a></li>' for lvl, i, t in toc
            ) + "</ul>"
        items.append(
            f'<li><a class="doc-link{" is-active" if cur else ""}" href="{out}"'
            f'{" aria-current=page" if cur else ""}>{label}</a>{sub}</li>'
        )
    for _, out, label in COPIED:
        items.append(f'<li><a class="doc-link" href="{out}">{label}{OUT_ICON}</a></li>')
    for _, out_dir, label, index in COPIED_DIRS:
        items.append(f'<li><a class="doc-link" href="{out_dir}/{index}" target="_blank" rel="noopener">{label}{OUT_ICON}</a></li>')
    for href, label in NAV_LINKS:
        items.append(f'<li><a class="doc-link" href="{href}" target="_blank" rel="noopener">{label}{OUT_ICON}</a></li>')
    return "".join(items)


def page_html(title: str, body: str, current: str, toc: list[tuple[int, str, str]]) -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>{html.escape(title)} · Credora docs</title>
<link rel="icon" type="image/svg+xml" href="/_assets/credora-gem.svg">
<link rel="stylesheet" href="_assets/site.css">
<link rel="stylesheet" href="docs.css">
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<div class="docs">
  <aside class="docs-nav" aria-label="Documentation">
    <div class="docs-brand">
      <a class="wordmark" href="index.html">{GEM}<span class="wordmark-text"><span class="wordmark-name">Credora</span><span class="wordmark-sub">Documentation</span></span></a>
    </div>
    <details class="docs-menu" open>
      <summary>Pages</summary>
      <nav><ul class="doc-links">{nav_html(current, toc)}</ul></nav>
    </details>
    <div class="docs-nav-foot">
      <ul class="companion">
        <li><a data-site="app" href="/" target="_blank" rel="noopener">Credora app{OUT_ICON}</a></li>
        <li><a data-site="video" href="../../video/index.html" target="_blank" rel="noopener">Demo video{OUT_ICON}</a></li>
        <li><a data-site="ppt" href="../../ppt/index.html" target="_blank" rel="noopener">Presentation{OUT_ICON}</a></li>
      </ul>
      <span class="exathon-badge">ExaThon India 2026</span>
      {CREDIT}
    </div>
  </aside>
  <main id="content" class="docs-main" tabindex="-1">
    <article class="prose">
{body}
    </article>
    <footer class="docs-foot">
      {CREDIT}
      <span>Sapphire Bank is fictional. All companies, people and accounts are synthetic.</span>
      <span class="views" data-views="docs"></span>
    </footer>
  </main>
</div>
<script src="_assets/sites.js"></script>
</body>
</html>
"""


def nest_lists(text: str) -> str:
    """GitHub nests a list indented by 2-3 spaces; Python-Markdown needs 4. Fenced code is left alone."""
    parts = re.split(r"(?ms)(^```.*?^```)", text)
    return "".join(
        p if p.startswith("```") else re.sub(r"(?m)^ {2,3}(?=(?:[-*+]|\d+\.) )", "    ", p) for p in parts
    )


A_RE = re.compile(r'<a href="([^"]*)"([^>]*)>([\s\S]*?)</a>')
H_RE = re.compile(r'<h([23]) id="([^"]+)">([\s\S]*?)</h\1>')


def build_page(src: str, out: str, label: str) -> None:
    text = nest_lists((REPO / src).read_text(encoding="utf-8"))
    md = markdown.Markdown(
        extensions=["fenced_code", "tables", "sane_lists", "toc"],
        extension_configs={"toc": {"slugify": slugify, "permalink": False}},
    )
    body = md.convert(text)

    def link(m: re.Match) -> str:
        href = rewrite_href(html.unescape(m.group(1)), src)
        if href is None:
            return f'<span class="dead-link">{m.group(3)}</span>'
        ext = href.startswith("http")
        attrs = ' target="_blank" rel="noopener"' if ext else ""
        return f'<a href="{html.escape(href, quote=True)}"{m.group(2)}{attrs}>{m.group(3)}</a>'

    body = A_RE.sub(link, body)
    body = CODE_RE.sub(render_code, body)
    body = re.sub(r"<table>", '<div class="table-wrap"><table>', body).replace("</table>", "</table></div>")

    toc: list[tuple[int, str, str]] = []

    def anchor(m: re.Match) -> str:
        lvl, hid, inner = m.groups()
        toc.append((int(lvl), hid, re.sub(r"<[^>]+>", "", inner)))
        return (
            f'<h{lvl} id="{hid}">{inner}<a class="anchor" href="#{hid}" aria-label="Link to this section">#</a></h{lvl}>'
        )

    body = H_RE.sub(anchor, body)
    toc = [t for t in toc if t[0] == 2] if len(toc) > 12 else toc
    m = re.search(r"<h1[^>]*>([\s\S]*?)</h1>", body)
    title = re.sub(r"<[^>]+>", "", m.group(1)) if m else label
    (OUT / out).write_text(page_html(label if out != "index.html" else title, body, out, toc), encoding="utf-8", newline="\n")


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    shutil.copytree(SITES / "_assets", OUT / "_assets")
    shutil.copy2(SITES / "docs" / "docs.css", OUT / "docs.css")
    for src, out, _ in COPIED:
        shutil.copy2(REPO / src, OUT / out)
    for src_dir, out_dir, _, _ in COPIED_DIRS:
        shutil.copytree(REPO / src_dir, OUT / out_dir)
    for src, out, label in PAGES:
        build_page(src, out, label)
    rel = OUT.relative_to(REPO).as_posix()
    print(f"docs: {len(PAGES)} pages + {len(COPIED)} copied + {len(COPIED_DIRS)} folder(s) into {rel}/" + ("" if REPO_URL else " (no repository URL: code links left as text)"))


if __name__ == "__main__":
    main()
