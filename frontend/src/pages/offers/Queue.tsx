import { useState } from "react";
import { BadgeCheck, Ban, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { useOffers } from "../../api/hooks";
import { useAuth } from "../../auth/AuthContext";
import type { Offer } from "../../api/types";
import { SortableTh, useSort } from "../../components/SortableTh";
import { Empty, ErrorState, Grade, Loading, PageHeader, Panel, Segmented, Stage } from "../../components/ui";
import { num, pct, relative, rupeesShort } from "../../lib/format";
import { offerStageRank, type SortColumns } from "../../lib/sort";
import { allowedActions, CheckerDialog } from "./CheckerActions";

type Tab = "verify" | "sanction";

function breaches(o: Offer) {
  const b: string[] = [];
  if ((o.agreed_amount ?? 0) > (o.max_amount ?? Infinity)) b.push("amount");
  if ((o.agreed_roi ?? Infinity) < (o.floor_roi ?? 0)) b.push("ROI");
  if ((o.agreed_tenure ?? 0) > (o.max_tenure ?? Infinity)) b.push("tenure");
  return b;
}

const SORT: SortColumns<Offer> = {
  legal_name: (o) => o.legal_name,
  stage: (o) => offerStageRank(o.stage),
  grade: (o) => o.grade,
  agreed_amount: (o) => o.agreed_amount,
  agreed_roi: (o) => o.agreed_roi,
  agreed_tenure: (o) => o.agreed_tenure,
  limit: (o) => breaches(o).length,
  updated_at: (o) => o.updated_at,
};

export function QueuePage() {
  const q = useOffers();
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const [picked, setTab] = useState<Tab>("verify");
  // The admin only ever sanctions, so the admin has no verify tab.
  const tab: Tab = admin ? "sanction" : picked;
  const [pending, setPending] = useState<{ o: Offer; a: "verify" | "sanction" | "reject" } | null>(null);
  const all = q.data ?? [];
  const toVerify = all.filter((o) => (o.stage === "NEGOTIATING" && o.agreed_amount != null) || o.stage === "ESCALATED");
  const toSanction = all.filter((o) => o.stage === "VERIFIED");
  const queued = (tab === "verify" ? toVerify : toSanction).sort((a, b) => (a.stage === "ESCALATED" ? -1 : 0) - (b.stage === "ESCALATED" ? -1 : 0));
  const sort = useSort(queued, SORT);
  const rows = sort.rows;

  return (
    <div className="page">
      <PageHeader
        title="Approval queue"
        lede={
          admin
            ? "Offers loan operations has verified. Sanction gives the final approval. Terms outside Exasol's negotiation limit show here as outside."
            : "Offers with terms proposed by relationship managers. Escalated ones are outside Exasol's negotiation limit and come first. Once you verify an offer, the admin sanctions it."
        }
        actions={
          admin ? undefined : <Segmented
            label="Queue"
            value={tab}
            onChange={setTab}
            options={[
              { value: "verify", label: <>To verify <span className="num muted">{toVerify.length}</span></> },
              { value: "sanction", label: <>With the admin <span className="num muted">{toSanction.length}</span></> },
            ]}
          />
        }
      />
      {q.isLoading && <Loading />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && (
        <Panel flush>
          {rows.length === 0 ? (
            <Empty title={tab === "verify" ? "Nothing to verify" : "Nothing to sanction"}>
              {tab === "verify" ? "Proposals from relationship managers will appear here." : admin ? "Offers appear here once loan operations has verified them." : "Offers you verified wait here for the admin to sanction them."}
            </Empty>
          ) : (
            <div className="table-wrap table-wrap-tall">
              <table className="table">
                <thead>
                  <tr>
                    <SortableTh sortKey="legal_name" control={sort}>Company</SortableTh>
                    <SortableTh sortKey="stage" control={sort}>Stage</SortableTh>
                    <SortableTh sortKey="grade" control={sort}>Grade</SortableTh>
                    <SortableTh sortKey="agreed_amount" control={sort} className="r">Agreed amount</SortableTh>
                    <SortableTh sortKey="agreed_roi" control={sort} className="r">ROI (floor)</SortableTh>
                    <SortableTh sortKey="agreed_tenure" control={sort} className="r">Tenure (max)</SortableTh>
                    <SortableTh sortKey="limit" control={sort}>Limit</SortableTh>
                    <SortableTh sortKey="updated_at" control={sort}>Updated</SortableTh>
                    <th scope="col"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => {
                    const b = breaches(o);
                    return (
                      <tr key={o.offer_id}>
                        <td>
                          <Link className="strong" to={`/offers/${o.offer_id}`}>
                            {o.legal_name}
                          </Link>
                          <br />
                          <span className="small muted">
                            <code>{o.cif_id}</code> · RM <code>{o.rm_id}</code> ·{" "}
                            <Link to={`/companies/${o.cif_id}/report`}>report</Link>
                          </span>
                        </td>
                        <td>
                          <Stage s={o.stage} />
                        </td>
                        <td>
                          <Grade g={o.grade} />
                        </td>
                        <td className="r num">
                          {rupeesShort(o.agreed_amount)}
                          <br />
                          <span className="small muted">max {rupeesShort(o.max_amount)}</span>
                        </td>
                        <td className="r num">
                          {pct(o.agreed_roi)}
                          <br />
                          <span className="small muted">{pct(o.floor_roi)}</span>
                        </td>
                        <td className="r num">
                          {num(o.agreed_tenure)} mo
                          <br />
                          <span className="small muted">{num(o.max_tenure)} mo</span>
                        </td>
                        <td>{b.length ? <span className="text-refer">Outside on {b.join(", ")}</span> : <span className="text-approve">Within</span>}</td>
                        <td className="muted nowrap">{relative(o.updated_at)}</td>
                        <td>
                          <div className="btn-row btn-row-tight">
                            {allowedActions(o, user?.role).map((a) => (
                              <button
                                key={a}
                                className={`btn btn-sm ${a === "reject" ? "btn-danger-quiet" : "btn-quiet"}`}
                                onClick={() => setPending({ o, a })}
                              >
                                {a === "reject" ? <Ban aria-hidden="true" /> : a === "sanction" ? <BadgeCheck aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                                {a.charAt(0).toUpperCase() + a.slice(1)}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
      {pending && <CheckerDialog offer={pending.o} act={pending.a} onClose={() => setPending(null)} />}
    </div>
  );
}
