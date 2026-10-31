// A small tokenizer for the three languages Exasol runs in Credora: SQL, Lua and Python.
// Good enough to colour keywords, strings, comments, numbers and object names.

export type TokenType = "kw" | "fn" | "str" | "com" | "num" | "obj" | "op" | "txt";
export interface Token {
  t: TokenType;
  v: string;
}

const SQL_KW = new Set(
  `select from where and or not in is null as join left right inner outer on group by order having limit with
  case when then else end create replace view table or insert into update delete merge using values set distinct
  over partition rows between preceding following current row union all exists like asc desc preferring high low
  plus prior priority cascade script emits returns python3 lua scalar set import export jdbc at connection identified
  user statement truncate commit rollback cast decimal varchar double integer boolean date timestamp interval
  first last nulls coalesce greatest least connect start true false`.split(/\s+/),
);
const SQL_FN = new Set(
  `sum avg count min max stddev median round abs ln exp sqrt nvl zeroifnull nullifzero add_months months_between
  days_between to_char to_date lag lead rank dense_rank row_number ntile percentile_cont approximate_count_distinct
  case_when iproc nproc hash_sha256 current_timestamp systimestamp sys_connect_by_path level`.split(/\s+/),
);
const LUA_KW = new Set(
  `local function end if then else elseif for in do while return and or not nil true false repeat until break query pquery output exit error`.split(
    /\s+/,
  ),
);
const PY_KW = new Set(
  `def return if elif else for in while import from as class with try except finally raise lambda not and or is None True False yield pass continue break global`.split(
    /\s+/,
  ),
);

export function tokenize(code: string, lang: "sql" | "lua" | "python"): Token[] {
  const out: Token[] = [];
  const kw = lang === "sql" ? SQL_KW : lang === "lua" ? LUA_KW : PY_KW;
  const re =
    lang === "sql"
      ? /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|("[^"]*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_]+)/g
      : lang === "lua"
        ? /(--\[\[[\s\S]*?\]\]|--[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\[\[[\s\S]*?\]\])|()(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_]+)/g
        : /(#[^\n]*)|("""[\s\S]*?"""|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|()(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const [all, com, str, ident, n, word, ws, op] = m;
    if (all === "") {
      re.lastIndex++;
      continue;
    }
    if (com) out.push({ t: "com", v: com });
    else if (str) out.push({ t: "str", v: str });
    else if (ident) out.push({ t: "obj", v: ident });
    else if (n) out.push({ t: "num", v: n });
    else if (word) {
      const lw = word.toLowerCase();
      if (lang === "sql" ? kw.has(lw) : kw.has(word)) out.push({ t: "kw", v: word });
      else if (lang === "sql" && SQL_FN.has(lw)) out.push({ t: "fn", v: word });
      else if (/^[A-Z][A-Z0-9_]{2,}$/.test(word)) out.push({ t: "obj", v: word });
      else if (code[re.lastIndex] === "(") out.push({ t: "fn", v: word });
      else out.push({ t: "txt", v: word });
    } else if (ws) out.push({ t: "txt", v: ws });
    else if (op) out.push({ t: "op", v: op });
  }
  return out;
}
