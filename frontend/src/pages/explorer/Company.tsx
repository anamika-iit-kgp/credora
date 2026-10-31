import { Link, useParams, useSearchParams } from "react-router-dom";
import { FileSearch } from "lucide-react";
import { useTree } from "../../api/hooks";
import { useUser } from "../../auth/AuthContext";
import { NodeDetail } from "../../components/NodeDetail";
import { SourceLegend } from "../../components/SourceTag";
import { ProvenanceTree } from "../../components/Tree";
import { ErrorState, Loading, PageHeader } from "../../components/ui";
import { can } from "../../lib/roles";

export function CompanyPage() {
  const { cif = "" } = useParams();
  const user = useUser();
  const [sp, setSp] = useSearchParams();
  const tree = useTree(cif);
  const selected = sp.get("node") ?? tree.data?.id ?? null;
  const limited = user.role === "rm" || user.role === "loanops";

  return (
    <div className="page page-wide">
      <PageHeader
        crumbs={[{ to: "/companies", label: "Data explorer" }, { label: cif }]}
        title={tree.data?.label ?? cif}
        lede={tree.data?.sublabel ?? undefined}
        actions={
          can(user.role, "report") && (
            <Link className="btn btn-primary" to={`/companies/${cif}/report`}>
              <FileSearch aria-hidden="true" />
              Exasol report
            </Link>
          )
        }
      >
        <SourceLegend />
      </PageHeader>

      {tree.isLoading && <Loading rows={12} />}
      {tree.isError && <ErrorState error={tree.error} retry={() => tree.refetch()} />}
      {tree.data && (
        <div className="explorer">
          <section className="explorer-tree" aria-label="Data tree">
            <div className="explorer-tree-head">
              <h2 className="panel-title">Where the data lives</h2>
              <p className="muted small">Arrow keys move, Enter opens a node.</p>
            </div>
            <ProvenanceTree root={tree.data} selected={selected} onSelect={(id) => setSp({ node: id }, { replace: true })} />
            {limited && (
              <p className="explorer-note">
                CIBIL, GST and Account Aggregator records are not shown to your role. You see their effect in the Exasol report.
              </p>
            )}
          </section>
          <section className="explorer-detail" aria-label="Records">
            {selected && <NodeDetail nodeId={selected} cif={cif} reportAllowed={can(user.role, "report")} />}
          </section>
        </div>
      )}
    </div>
  );
}
