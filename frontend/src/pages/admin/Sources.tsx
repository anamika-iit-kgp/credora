import { useSources } from "../../api/hooks";
import { RefreshCw, Table2 } from "lucide-react";
import { PushdownProof } from "../../components/PushdownProof";
import { SourceHealthStrip } from "../../components/SourceHealth";
import { SourceTag } from "../../components/SourceTag";
import { ErrorState, Loading, PageHeader, Panel } from "../../components/ui";
import { num } from "../../lib/format";
import { KIND_LABEL } from "../../lib/sources";

export function SourcesPage() {
  const q = useSources();
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
                    <th scope="col">Source</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Table</th>
                    <th scope="col" className="r">
                      Rows
                    </th>
                    <th scope="col" className="r">
                      Latency
                    </th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.flatMap((s) =>
                    s.tables.map((t, i) => (
                      <tr key={s.source + t.name} className={i === 0 ? "row-group-start" : ""}>
                        <td>{i === 0 ? <SourceTag source={s.source} /> : null}</td>
                        <td className="muted">{i === 0 ? KIND_LABEL[s.kind] : ""}</td>
                        <td>
                          <code>{t.name}</code>
                        </td>
                        <td className="r num">{num(t.rows)}</td>
                        <td className="r num muted">{i === 0 && s.latency_ms != null ? `${s.latency_ms} ms` : ""}</td>
                        <td>
                          {i === 0 && (
                            <span className="status">
                              <span className={`dot dot-${s.status}`} aria-hidden="true" />
                              {s.status === "up" ? "Up" : "Down"}
                            </span>
                          )}
                        </td>
                      </tr>
                    )),
                  )}
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
