import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { ExternalLink, Search } from "lucide-react";
import { PageHeader, Empty, Loading, Segmented } from "../../components/ui";
import type { Term } from "../../explain/glossary";
import { useGlossary, type Glossary } from "../../explain/glossaryStore";
import { KIND_META, TermBody } from "../../explain/Explain";

type KindFilter = "all" | Term["kind"];
const KINDS: KindFilter[] = ["all", "exasol", "banking", "ai", "aws", "app"];

function matches(t: Term, q: string) {
  if (!q) return true;
  const hay = [t.term, t.id, t.plain, t.inExasol ?? "", ...(t.objects ?? [])].join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** The route fetches the term data together with this screen, so the loading state below is only a fallback. */
export function GlossaryPage() {
  const glossary = useGlossary();
  if (!glossary) return <Loading label="Opening the glossary" rows={3} />;
  return <GlossaryList glossary={glossary} />;
}

function GlossaryList({ glossary }: { glossary: Glossary }) {
  const terms = useMemo(() => Object.values(glossary).sort((a, b) => a.term.localeCompare(b.term, "en", { sensitivity: "base" })), [glossary]);
  const { hash } = useLocation();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const target = decodeURIComponent(hash.replace(/^#/, ""));

  // A link from a popover's "More" names one term: show it even if the filters would hide it.
  useEffect(() => {
    if (!target || !glossary[target]) return;
    setQ("");
    setKind("all");
    const t = window.setTimeout(() => {
      const el = document.getElementById(target);
      if (!el) return;
      el.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      el.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(t);
  }, [target, glossary]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: terms.length };
    for (const t of terms) c[t.kind] = (c[t.kind] ?? 0) + 1;
    return c;
  }, [terms]);
  const shown = terms.filter((t) => (kind === "all" || t.kind === kind) && matches(t, q));

  return (
    <div className="page glossary">
      <PageHeader
        title="Glossary"
        lede={
          <>
            {terms.length} terms behind Credora, each in plain words and in Exasol's terms, with the objects it touches, the code that runs and where to read
            more. The same text is in{" "}
            <a href="https://docs.credora.loan/glossary.html" target="_blank" rel="noreferrer">
              the documentation
              <ExternalLink className="ic ic-sm" aria-hidden="true" style={{ marginLeft: 4, verticalAlign: "-2px" }} />
            </a>
            .
          </>
        }
      />
      <div className="glossary-tools">
        <label className="field-inline grow">
          <span className="sr-only">Search the glossary</span>
          <Search className="field-icon" aria-hidden="true" />
          <input
            className="input input-icon"
            type="search"
            placeholder="Search terms, Exasol objects, plain words"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <Segmented<KindFilter>
          label="Kind of term"
          value={kind}
          onChange={setKind}
          options={KINDS.map((k) => ({
            value: k,
            label: (
              <>
                {k === "all" ? "All" : KIND_META[k].label} <span className="num muted">{counts[k] ?? 0}</span>
              </>
            ),
          }))}
        />
      </div>
      <p className="muted small" role="status">
        {shown.length === terms.length ? `${terms.length} terms` : `${shown.length} of ${terms.length} terms`}
      </p>
      {shown.length === 0 ? (
        <Empty title="No term matches">Try a shorter word, an Exasol object such as VS_CBS, or another kind.</Empty>
      ) : (
        <ol className="glossary-list">
          {shown.map((t) => (
            <li key={t.id} id={t.id} tabIndex={-1} className={`glossary-item ${target === t.id ? "is-target" : ""}`}>
              <TermBody t={t} headingLevel={2} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
