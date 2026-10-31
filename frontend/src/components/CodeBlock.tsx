import { useMemo, useState } from "react";
import { tokenize } from "../lib/highlight";

const LANG_LABEL = { sql: "Exasol SQL", lua: "Lua script", python: "Python UDF" } as const;

export function CodeBlock({ code, lang }: { code: string; lang: "sql" | "lua" | "python" }) {
  const tokens = useMemo(() => tokenize(code, lang), [code, lang]);
  const [copied, setCopied] = useState(false);
  const lines = code.split("\n").length;
  return (
    <div className="code">
      <div className="code-bar">
        <span>{LANG_LABEL[lang]}</span>
        <span className="muted num">{lines} lines</span>
        <button
          className="btn btn-quiet btn-sm"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre tabIndex={0} aria-label={`${LANG_LABEL[lang]} source`}>
        <code>
          {tokens.map((t, i) =>
            t.t === "txt" || t.t === "op" ? (
              t.v
            ) : (
              <span key={i} className={`tk-${t.t}`}>
                {t.v}
              </span>
            ),
          )}
        </code>
      </pre>
    </div>
  );
}
