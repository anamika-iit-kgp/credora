import { SearchCode } from "lucide-react";
import { usePushdown } from "../api/exasolAudit";
import { CodeBlock } from "./CodeBlock";
import { ErrorState, Loading, Panel } from "./ui";
import "../styles/exasol-audit.css";

/** "Pushdown proof": Exasol's own EXPLAIN VIRTUAL for the analysis's reads of the bank's databases,
 *  run live as the signed-in role's Exasol user. Shows the SQL each source database receives. */
export function PushdownProof() {
  const q = usePushdown();
  return (
    <Panel title="Pushdown proof with EXPLAIN VIRTUAL" icon={SearchCode} aside={<span className="muted">run live, as your role's Exasol user</span>} flush>
      <p className="xa-note">
        RUN_ANALYSIS reads the bank's databases through virtual schemas. <code>EXPLAIN VIRTUAL</code> asks Exasol which SQL it would send to each
        source, without running it. For core banking the join, the filter and the grouping by account and month all run inside Oracle, so about
        19,000 monthly rows cross the network instead of 850,000 transactions.
      </p>
      {q.isLoading && <Loading rows={4} label="Asking Exasol" />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data &&
        q.data.map((p) => (
          <div className="xa-push" key={p.key}>
            <div className="xa-push-head">
              <h3>{p.title}</h3>
              <span className="muted">
                {p.source} · <code>{p.schema}</code> · analysis step {p.step} · EXPLAIN VIRTUAL took {p.explain_ms} ms
              </span>
            </div>
            <CodeBlock code={`EXPLAIN VIRTUAL\n${p.query}`} lang="sql" />
            {p.pushdowns.map((d) => (
              <div key={d.id}>
                <p className="xa-arrow">
                  Pushdown {d.id}. Exasol sends this to <code>{d.connection ?? "the source"}</code>
                  {d.driver ? ` (${d.driver === "jdbc" ? "Oracle, JDBC" : `${d.driver}, ADBC`})` : ""}, tables {d.tables}
                </p>
                <CodeBlock code={d.sql ?? d.pushdown_sql} lang="sql" />
              </div>
            ))}
          </div>
        ))}
    </Panel>
  );
}
