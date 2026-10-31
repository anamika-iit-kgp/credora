import { Link } from "react-router-dom";
import { FileSearch } from "lucide-react";
import { useNode } from "../api/hooks";
import type { Cell, NodeRecords } from "../api/types";
import { cell, humanize, isNumericColumn, num } from "../lib/format";
import { sourceMeta } from "../lib/sources";
import { SourceGlyph, SourceTag } from "./SourceTag";
import { ErrorState, Loading } from "./ui";
import { ExaBadge } from "../explain/ExaBadge";

const MAX_ROWS = 400;

const VS_OF: Record<string, [string, string]> = {
  "bank.oracle": ["VS_CBS", "Oracle"],
  "bank.mysql": ["VS_CIF", "MySQL"],
  "bank.postgres": ["VS_LOS", "PostgreSQL"],
};

/** Explain mode: how Exasol got these records (read in place, staged from an API, or computed). */
function NodeBadge({ kind, meta, source }: { kind?: string; meta?: Record<string, unknown>; source: string }) {
  const vs = VS_OF[source];
  const via = typeof meta?.via === "string" ? (meta.via as string) : vs?.[0];
  if (kind === "bank" && vs) return <ExaBadge kind="bank" what="Read live" detail={`${via} pushdown to ${vs[1]}`} term="pushdown" />;
  if (kind === "api") return <ExaBadge kind="api" what="Fetched by a Python UDF" detail="staged in CREDORA_STAGE" term="python-udf" />;
  if (kind === "exasol") return <ExaBadge what="Computed in Exasol" detail="CREDORA results" term="credora-schema" />;
  return null;
}

function DpdStrip({ value }: { value: string }) {
  const xs = value.split(",").map((v) => Number(v));
  const worst = Math.max(...xs);
  return (
    <span className="dpd" role="img" aria-label={`36 months of days past due, newest first. Worst ${worst} days.`}>
      {xs.map((d, i) => (
        <span key={i} className={`dpd-cell dpd-${d >= 90 ? 90 : d >= 60 ? 60 : d >= 30 ? 30 : 0}`} />
      ))}
    </span>
  );
}

function renderCell(col: string, v: Cell) {
  if (col === "dpd_36m" && typeof v === "string") return <DpdStrip value={v} />;
  if ((col === "dr_cr" || col === "bounced") && typeof v === "string") {
    if (col === "dr_cr") return <span className={v === "C" ? "cr" : "dr"}>{v === "C" ? "Credit" : "Debit"}</span>;
    return v === "Y" ? <span className="text-decline">Bounced</span> : <span className="muted">No</span>;
  }
  if (col === "decision" && typeof v === "string") return <span className={`text-${v.toLowerCase()}`}>{v.charAt(0) + v.slice(1).toLowerCase()}</span>;
  if (col === "pd" && typeof v === "number") return `${(v * 100).toFixed(2)}%`;
  if ((col === "offer_roi" || col === "floor_roi") && typeof v === "number") return `${v.toFixed(2)}%`;
  return cell(col, v);
}

function where(r: NodeRecords): string | null {
  const m = r.meta ?? {};
  if (m.endpoint) return `Mock API call ${m.endpoint}`;
  if (m.table && m.database) return `Read from ${m.database}, table ${m.table}`;
  if (m.table) return `Exasol table ${m.table}`;
  return null;
}

const META_HIDDEN = new Set(["endpoint", "table", "database"]);

export function NodeDetail({ nodeId, cif, reportAllowed }: { nodeId: string; cif: string; reportAllowed: boolean }) {
  const q = useNode(nodeId);
  if (q.isLoading) return <Loading rows={8} label="Loading records" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const r = q.data!;
  const m = sourceMeta(r.source);
  const single = r.rows.length === 1;
  const meta = Object.entries(r.meta ?? {}).filter(([k]) => !META_HIDDEN.has(k));
  const shown = r.rows.slice(0, MAX_ROWS);
  const numericCols = r.columns.map((c) => isNumericColumn(c, r.rows.find((row) => row[r.columns.indexOf(c)] != null)?.[r.columns.indexOf(c)]));

  return (
    <article className={`record rk-${m?.kind ?? "none"}`} aria-live="polite">
      <header className="record-head">
        <div className="record-prov">
          {m && <SourceGlyph kind={m.kind} size={11} />}
          <span>
            {m?.kind === "bank" && "Sapphire Bank's own data"}
            {m?.kind === "api" && "3rd party data, fetched on demand via API"}
            {m?.kind === "exasol" && "Computed by Exasol"}
          </span>
          <span className="record-where">{where(r)}</span>
        </div>
        <div className="record-title-row">
          <h2 className="record-title">{r.title}</h2>
          <SourceTag source={r.source} />
        </div>
        <NodeBadge kind={m?.kind} meta={r.meta} source={r.source} />
        {meta.length > 0 && (
          <dl className="record-meta">
            {meta.map(([k, v]) => (
              <div key={k}>
                <dt>{humanize(k)}</dt>
                <dd className={typeof v === "number" ? "num" : ""}>{renderCell(k, v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </header>

      {r.rows.length === 0 && <p className="muted pad">No records.</p>}

      {single && (
        <dl className="record-kv">
          {r.columns.map((c, i) => (
            <div key={c}>
              <dt>
                <code>{c}</code>
              </dt>
              <dd className={typeof r.rows[0][i] === "number" ? "num" : ""}>{renderCell(c, r.rows[0][i])}</dd>
            </div>
          ))}
        </dl>
      )}

      {!single && r.rows.length > 0 && (
        <>
          <div className="table-wrap table-wrap-tall">
            <table className="table table-dense">
              <thead>
                <tr>
                  {r.columns.map((c, i) => (
                    <th key={c} scope="col" className={numericCols[i] ? "r" : ""}>
                      <code>{c}</code>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((v, ci) => (
                      <td key={ci} className={`${numericCols[ci] ? "r num" : ""} nowrap`}>
                        {renderCell(r.columns[ci], v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="record-foot muted">
            {r.rows.length > MAX_ROWS ? `Showing the latest ${num(MAX_ROWS)} of ${num(r.rows.length)} rows.` : `${num(r.rows.length)} rows.`}
          </p>
        </>
      )}

      {r.source === "exasol" && reportAllowed && (
        <div className="pad">
          <Link className="btn btn-primary" to={`/companies/${cif}/report`}>
            <FileSearch aria-hidden="true" />
            Open the full Exasol report
          </Link>
        </div>
      )}
    </article>
  );
}
