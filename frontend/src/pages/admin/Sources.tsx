import { useMemo } from "react";
import { useSources } from "../../api/hooks";
import { RefreshCw, Table2 } from "lucide-react";
import type { SourceHealth } from "../../api/types";
import { PushdownProof } from "../../components/PushdownProof";
import { SourceHealthStrip } from "../../components/SourceHealth";
import { SortableTh, useSort } from "../../components/SortableTh";
import { SourceTag } from "../../components/SourceTag";
import { ErrorState, Loading, PageHeader, Panel } from "../../components/ui";
import { num } from "../../lib/format";
import type { SortColumns } from "../../lib/sort";
import { KIND_LABEL } from "../../lib/sources";

interface TableRow {
  s: SourceHealth;
  t: SourceHealth["tables"][number];
  first: boolean;
}

const SORT: SortColumns<TableRow> = {
  source: (r) => r.s.source,
  kind: (r) => KIND_LABEL[r.s.kind],
  table: (r) => r.t.name,
  rows: (r) => r.t.rows,
  latency: (r) => r.s.latency_ms,
  status: (r) => r.s.status,
};

export function SourcesPage() {
  const q = useSources();
  const rows = useMemo(() => (q.data ?? []).flatMap((s) => s.tables.map((t, i) => ({ s, t, first: i === 0 }))), [q.data]);
  const sort = useSort(rows, SORT);
  // In the original order rows group under their source. Once sorted they scatter, so each row names its source.
  const grouped = !sort.sort;
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: "Administration" }, { label: "Sources" }]}
        title="Sources"
        lede="Every system Credora reads from, whether it answers, and how many rows it holds."
        actions={
          <button className="btn btn-quiet" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={q.isFetching ? "spin" : undefined} aria-hidden="true" />
            {q.isFetching ? "Checking…" : "Check again"}
          </button>
        }
      />
      {q.isLoading && <Loading />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && (
        <>
          <Panel flush>
            <SourceHealthStrip sources={q.data} />
          </Panel>
          <Panel title="Tables" icon={Table2} flush>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <SortableTh sortKey="source" control={sort}>Source</SortableTh>
                    <SortableTh sortKey="kind" control={sort}>Kind</SortableTh>
                    <SortableTh sortKey="table" control={sort}>Table</SortableTh>
                    <SortableTh sortKey="rows" control={sort} className="r">Rows</SortableTh>
                    <SortableTh sortKey="latency" control={sort} className="r">Latency</SortableTh>
                    <SortableTh sortKey="status" control={sort}>Status</SortableTh>
                  </tr>
                </thead>
                <tbody>
                  {sort.rows.map(({ s, t, first }) => {
                    const show = first || !grouped;
                    return (
                      <tr key={s.source + t.name} className={grouped && first ? "row-group-start" : ""}>
                        <td>{show ? <SourceTag source={s.source} /> : null}</td>
                        <td className="muted">{show ? KIND_LABEL[s.kind] : ""}</td>
                        <td>
                          <code>{t.name}</code>
                        </td>
                        <td className="r num">{num(t.rows)}</td>
                        <td className="r num muted">{show && s.latency_ms != null ? `${s.latency_ms} ms` : ""}</td>
                        <td>
                          {show && (
                            <span className="status">
                              <span className={`dot dot-${s.status}`} aria-hidden="true" />
                              {s.status === "up" ? "Up" : "Down"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
      <PushdownProof />
    </div>
  );
}
