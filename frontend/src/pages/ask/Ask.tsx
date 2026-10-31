import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { LoaderCircle, Send } from "lucide-react";
import { useAiStatus, useAsk } from "../../api/hooks";
import { useAuth } from "../../auth/AuthContext";
import type { AskAnswer, AskStep } from "../../api/types";
import { CodeBlock } from "../../components/CodeBlock";
import { Empty, ErrorState, Loading, PageHeader, Panel } from "../../components/ui";
import { Explain } from "../../explain/Explain";
import { ExaBadge } from "../../explain/ExaBadge";

// Four questions per role, each exercising a different part of the Exasol implementation:
// virtual-schema joins across Oracle, MySQL and PostgreSQL, the semantic view, the raw API data,
// the run log and the model registry. What a role can ask matches what its Exasol user may read.
const SUGGESTED: Record<string, string[]> = {
  admin: [
    "For company C000229, join its partners from the customer master, its credit need on file and its current-account credits over the last 12 months from core banking.",
    "Which 5 industries have the highest pre-approved amount, with their approval rate?",
    "How long did each step of the latest analysis run take, and how many rows did it process?",
    "Which partners have a CIBIL score below 650, and which companies are they partners in?",
  ],
  datasci: [
    "Compare the risk model versions by AUC, Gini and the top three features of each.",
    "What are the average probability of default and the expected loss by GST stage and grade?",
    "In the latest run, how many grades and decisions would the challenger scorecard change, and in which direction?",
    "From the past loans in loan origination, what is the default rate by CIBIL commercial rank?",
  ],
  loanops: [
    "Which approved companies have their KYC expired or pending in the customer master?",
    "Show the 5 referred companies with the largest indicated need, and why each was referred.",
    "For the top 10 ranked companies, what were their current-account credits over the last 12 months in core banking?",
    "Which companies did the anomaly model flag in the latest run, with their decision and the reasons?",
  ],
  rm: [
    "Which of my assigned companies have the most negotiation headroom?",
    "Show my companies by loan status.",
    "What is the lowest ROI I can offer my top-ranked company, and what is the RAROC at that rate?",
    "What is the pre-approved amount of my assigned companies by industry?",
  ],
};

const TOOL_LABEL: Record<string, string> = {
  execute_exasol_query: "Ran a query",
  describe_exasol_tables_and_views: "Read table definitions",
  summarize_exasol_table: "Summarised a table",
  list_exasol_tables_and_views: "Listed tables",
  find_exasol_tables_and_views: "Searched tables",
  list_exasol_schemas: "Listed schemas",
};

export function AskPage() {
  const { user } = useAuth();
  const status = useAiStatus();
  const ask = useAsk();
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const on = !!status.data?.enabled && status.data?.assistant !== false;

  function submit(q: string) {
    const text = q.trim();
    if (!text || ask.isPending) return;
    setQuestion(text);
    setAsked(text);
    ask.mutate(text);
  }

  const header = (
    <PageHeader
      title="Ask Credora"
      lede="Ask about the analysis in plain English. Claude answers by querying Exasol through the Exasol MCP server, logged in as your own role's Exasol user, so it can read exactly what your role may read. Every answer shows the SQL it ran."
    >
      <div className="xb-row">
        <ExaBadge what="Answered from Exasol" detail="exasol-mcp-server as your role's user" term="exasol-mcp-server" />
        <ExaBadge what="Semantic view" detail="certified metrics first" term="certified-metric" />
      </div>
    </PageHeader>
  );

  if (status.isLoading)
    return (
      <div className="page">
        {header}
        <Loading rows={4} />
      </div>
    );
  if (status.isError)
    return (
      <div className="page">
        {header}
        <ErrorState error={status.error} retry={() => status.refetch()} />
      </div>
    );
  if (!on)
    return (
      <div className="page">
        {header}
        <Panel>
          <Empty title="AI is not configured on this server">
            Ask Credora needs an AI provider. An administrator turns it on by setting <code>AI_PROVIDER</code>, <code>AI_MODEL</code> and
            the provider's credentials in the deployment's environment file. Everything else in Credora works without it.
          </Empty>
        </Panel>
      </div>
    );

  return (
    <div className="page">
      {header}

      <Panel className="ask-panel" aside={<span className="ask-powered small">Powered by Claude · {status.data?.model}</span>}>
        <form
          className="ask-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            submit(question);
          }}
        >
          <label className="sr-only" htmlFor="ask-q">
            Your question
          </label>
          <textarea
            id="ask-q"
            ref={box}
            className="input ask-input"
            rows={2}
            maxLength={1000}
            placeholder="For example, which industries have the most referrals?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(question);
              }
            }}
          />
          <button className="btn btn-primary" type="submit" disabled={!question.trim() || ask.isPending}>
            {ask.isPending ? <LoaderCircle className="spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
            {ask.isPending ? "Asking…" : "Ask"}
          </button>
          <Explain id="ask-credora" label="Ask Credora" />
        </form>
        <div className="ask-suggest">
          <span className="small muted">Try</span>
          <ul className="ask-suggest-list">
            {(SUGGESTED[user?.role ?? "rm"] ?? SUGGESTED.rm).map((s) => (
              <li key={s}>
                <button className="btn btn-quiet btn-sm" type="button" disabled={ask.isPending} onClick={() => submit(s)}>
                  {s}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </Panel>

      {ask.isPending && (
        <Panel title={asked}>
          <Loading label="Claude is querying Exasol through the MCP server" rows={4} />
          <p className="muted small">Claude is querying Exasol through the MCP server. This usually takes 10 to 30 seconds.</p>
        </Panel>
      )}
      {ask.isError && !ask.isPending && <ErrorState error={ask.error} retry={() => asked && ask.mutate(asked)} />}
      {ask.data && !ask.isPending && <Answer q={asked ?? ""} a={ask.data} />}
    </div>
  );
}

function Answer({ q, a }: { q: string; a: AskAnswer }) {
  return (
    <>
      <Panel title={q} aside={<span className="muted small">{a.model}</span>}>
        <AnswerText text={a.answer} />
      </Panel>
      <HowAnswered steps={a.steps} exasolUser={a.exasol_user} />
    </>
  );
}

/** Plain text from Claude: paragraphs, and lines starting with "- " as a list. */
function AnswerText({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/).filter((b) => b.trim());
  const out: ReactNode[] = blocks.map((b, i) => {
    const lines = b.split("\n").filter((l) => l.trim());
    if (lines.length && lines.every((l) => /^\s*[-•*]\s+/.test(l)))
      return (
        <ul key={i} className="ask-list">
          {lines.map((l, j) => (
            <li key={j}>{l.replace(/^\s*[-•*]\s+/, "")}</li>
          ))}
        </ul>
      );
    return <p key={i}>{b}</p>;
  });
  return <div className="ask-answer">{out}</div>;
}

/** A query result ({"columns": [...], "rows": [[...]]}) as a table; anything else as text. */
function ResultView({ text }: { text: string }) {
  let t: { columns?: unknown; rows?: unknown } | null = null;
  try {
    t = JSON.parse(text);
  } catch {
    t = null;
  }
  if (t && Array.isArray(t.columns) && Array.isArray(t.rows)) {
    const cols = t.columns as string[];
    const rows = t.rows as unknown[][];
    return (
      <div className="table-wrap ask-table">
        <table className="table">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} scope="col" className={typeof rows[0]?.[cols.indexOf(c)] === "number" ? "r" : undefined}>
                  <code>{c}</code>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j} className={typeof v === "number" ? "r num" : undefined}>
                    {v === null ? <span className="muted">NULL</span> : String(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted small">No rows.</p>}
      </div>
    );
  }
  return <pre tabIndex={0}>{text || "(empty)"}</pre>;
}

function stepSql(s: AskStep): string | null {
  const q = s.input.query;
  return typeof q === "string" ? q.trim() : null;
}

function HowAnswered({ steps, exasolUser }: { steps: AskStep[]; exasolUser?: string | null }) {
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const all = steps.length > 0 && open.size === steps.length;
  const queries = steps.filter((s) => stepSql(s)).length;
  return (
    <section className="howpanel" aria-labelledby="ask-how-title">
      <div className="howpanel-head">
        <div>
          <h2 id="ask-how-title" className="howpanel-title">
            How Credora answered
            <Explain id="mcp-tool-call" label="MCP tool calls" />
          </h2>
          <p className="muted">
            {steps.length === 0
              ? "Claude answered without calling the Exasol MCP server."
              : `Claude made ${steps.length} ${steps.length === 1 ? "call" : "calls"} to the Exasol MCP server${
                  queries ? `, ${queries} of them SQL ${queries === 1 ? "query" : "queries"}` : ""
                }, logged in as ${exasolUser ?? "your role's Exasol user"} (read-only). Open a call to see what ran and what came back.`}
          </p>
        </div>
        {steps.length > 0 && (
          <button className="btn btn-quiet btn-sm" onClick={() => setOpen(all ? new Set() : new Set(steps.map((_, i) => i)))}>
            {all ? "Collapse all" : "Show all"}
          </button>
        )}
      </div>
      {steps.length > 0 && (
        <ol className="how">
          {steps.map((s, i) => {
            const isOpen = open.has(i);
            const sql = stepSql(s);
            const args = Object.fromEntries(Object.entries(s.input).filter(([k]) => k !== "query"));
            return (
              <li key={i} className={`how-step ${isOpen ? "is-open" : ""}`}>
                <span className="how-n num" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="how-body">
                  <button
                    className="how-toggle"
                    aria-expanded={isOpen}
                    onClick={() =>
                      setOpen((o) => {
                        const n = new Set(o);
                        if (n.has(i)) n.delete(i);
                        else n.add(i);
                        return n;
                      })
                    }
                  >
                    <span className="how-name">{TOOL_LABEL[s.tool] ?? "Called a tool"}</span>
                    <span className="how-engine">Exasol MCP</span>
                    <code className="how-object">{s.tool}</code>
                    {s.is_error && <span className="ask-failed small">failed</span>}
                  </button>
                  {!isOpen && sql && <code className="ask-sql-peek small">{sql.replace(/\s+/g, " ")}</code>}
                  {isOpen && (
                    <>
                      {sql && <CodeBlock code={sql} lang="sql" />}
                      {Object.keys(args).length > 0 && (
                        <p className="small muted">
                          Arguments <code>{JSON.stringify(sql ? args : s.input)}</code>
                        </p>
                      )}
                      {!sql && Object.keys(args).length === 0 && <p className="small muted">No arguments.</p>}
                      <div className="ask-result">
                        <span className="small muted">{s.is_error ? "Error from Exasol" : "Result from Exasol"}</span>
                        <ResultView text={s.result_preview} />
                      </div>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
