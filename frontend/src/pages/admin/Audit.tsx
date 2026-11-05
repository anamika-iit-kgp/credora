import { useAudit, usePurgeLog } from "../../api/hooks";
import { Eraser, ScrollText } from "lucide-react";
import type { AuditEntry, PurgeEntry } from "../../api/types";
import { SortableTh, useSort } from "../../components/SortableTh";
import { SourceTag } from "../../components/SourceTag";
import { Empty, ErrorState, Loading, PageHeader, Panel } from "../../components/ui";
import { dateTime, num } from "../../lib/format";
import { ROLE_LABEL } from "../../lib/roles";
import type { SortColumns } from "../../lib/sort";

const AUDIT_LIMIT = 200;

const PURGE_SORT: SortColumns<PurgeEntry> = {
  purged_at: (p) => p.purged_at,
  table_name: (p) => p.table_name,
  source: (p) => p.source,
  rows: (p) => p.rows,
  purge_due: (p) => p.purge_due,
};

const AUDIT_SORT: SortColumns<AuditEntry> = {
  at: (a) => a.at,
  username: (a) => a.username,
  role: (a) => a.role,
  action: (a) => a.action,
  target: (a) => a.target,
  detail: (a) => a.detail,
};

export function AuditPage() {
  const audit = useAudit(AUDIT_LIMIT);
  const purge = usePurgeLog();
  const purgeSort = useSort(purge.data ?? [], PURGE_SORT);
  const auditSort = useSort(audit.data ?? [], AUDIT_SORT);
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: "Administration" }, { label: "Audit and purge" }]}
        title="Audit and purge"
        lede="Who looked at or changed what, and proof that raw 3rd party data, fetched on demand via API, was deleted on time."
      />
      <Panel title="Purge log" icon={Eraser} aside={<span className="muted">Raw API replies are kept only until their purge time</span>} flush>
        {purge.isLoading && <Loading rows={4} />}
        {purge.isError && <ErrorState error={purge.error} retry={() => purge.refetch()} />}
        {purge.data && purge.data.length === 0 && <Empty title="Nothing purged yet" icon={Eraser}>Raw API data is purged after each analysis run.</Empty>}
        {purge.data && purge.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <SortableTh sortKey="purged_at" control={purgeSort}>Purged</SortableTh>
                  <SortableTh sortKey="table_name" control={purgeSort}>Table</SortableTh>
                  <SortableTh sortKey="source" control={purgeSort}>Data from</SortableTh>
                  <SortableTh sortKey="rows" control={purgeSort} className="r">Rows</SortableTh>
                  <SortableTh sortKey="purge_due" control={purgeSort}>Due</SortableTh>
                  <th scope="col">SHA-256 of deleted rows</th>
                </tr>
              </thead>
              <tbody>
                {purgeSort.rows.map((p, i) => {
                  const late = new Date(p.purged_at).getTime() - new Date(p.purge_due).getTime();
                  return (
                    <tr key={i}>
                      <td className="nowrap">{dateTime(p.purged_at)}</td>
                      <td>
                        <code>{p.table_name}</code>
                      </td>
                      <td>
                        <SourceTag source={p.source} />
                      </td>
                      <td className="r num">{num(p.rows)}</td>
                      <td className="nowrap muted">
                        {dateTime(p.purge_due)} {late <= 5 * 60000 ? <span className="text-approve">on time</span> : <span className="text-decline">late</span>}
                      </td>
                      <td>
                        <code className="hash" title={p.sha256}>
                          {p.sha256.slice(0, 16)}…{p.sha256.slice(-6)}
                        </code>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Audit log" icon={ScrollText} aside={<span className="muted">The latest {AUDIT_LIMIT} entries</span>} flush>
        {audit.isLoading && <Loading rows={6} />}
        {audit.isError && <ErrorState error={audit.error} retry={() => audit.refetch()} />}
        {audit.data && audit.data.length === 0 && <Empty title="No activity recorded yet" icon={ScrollText} />}
        {audit.data && audit.data.length > 0 && (
          <div className="table-wrap table-wrap-tall">
            <table className="table">
              <thead>
                <tr>
                  <SortableTh sortKey="at" control={auditSort}>When</SortableTh>
                  <SortableTh sortKey="username" control={auditSort}>User</SortableTh>
                  <SortableTh sortKey="role" control={auditSort}>Role</SortableTh>
                  <SortableTh sortKey="action" control={auditSort}>Action</SortableTh>
                  <SortableTh sortKey="target" control={auditSort}>Target</SortableTh>
                  <SortableTh sortKey="detail" control={auditSort}>Detail</SortableTh>
                </tr>
              </thead>
              <tbody>
                {auditSort.rows.map((a, i) => (
                  <tr key={i}>
                    <td className="nowrap">{dateTime(a.at)}</td>
                    <td>
                      <code>{a.username}</code>
                    </td>
                    <td className="muted">{ROLE_LABEL[a.role] ?? a.role}</td>
                    <td>
                      <code className="action">{a.action}</code>
                    </td>
                    <td>{a.target}</td>
                    <td className="muted">{a.detail ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
