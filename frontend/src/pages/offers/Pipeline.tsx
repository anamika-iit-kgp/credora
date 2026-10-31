import { Link, useSearchParams } from "react-router-dom";
import { Briefcase } from "lucide-react";
import { useOffers } from "../../api/hooks";
import type { Offer, OfferStage } from "../../api/types";
import { useUser } from "../../auth/AuthContext";
import { DecisionBadge, Empty, ErrorState, Grade, Loading, Money, PageHeader, Panel, Stage } from "../../components/ui";
import { num, pct, relative, rupeesShort } from "../../lib/format";

export const STAGES: { s: OfferStage; label: string; help: string }[] = [
  { s: "OFFERED", label: "Offered", help: "Exasol's offer, not yet discussed" },
  { s: "NEGOTIATING", label: "Negotiating", help: "Terms proposed within the limit" },
  { s: "ESCALATED", label: "Escalated", help: "Proposed beyond the limit" },
  { s: "VERIFIED", label: "Verified", help: "Checked by loan operations" },
  { s: "SANCTIONED", label: "Sanctioned", help: "Approved for disbursal" },
  { s: "DECLINED", label: "Declined", help: "Rejected by loan operations" },
];

export function PipelinePage() {
  const user = useUser();
  const q = useOffers();
  const [sp, setSp] = useSearchParams();
  const stage = (sp.get("stage") ?? "") as OfferStage | "";
  const all = q.data ?? [];
  const rows = stage ? all.filter((o) => o.stage === stage) : all;

  return (
    <div className="page">
      <PageHeader
        title={user.role === "rm" ? "My pipeline" : "Offer pipeline"}
        lede={
          user.role === "rm"
            ? "Offers for the companies assigned to you, from the published run. Open one to negotiate inside its limit. Terms above it go to loan operations."
            : "Every live offer across relationship managers, as recorded in the CRM."
        }
      />
      {q.isLoading && <Loading />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && all.length === 0 && <Empty title="No offers yet" icon={Briefcase}>Offers appear after an analysis run approves or refers your companies.</Empty>}
      {all.length > 0 && (
        <>
          <nav className="funnel" aria-label="Filter by stage">
            <button className={`funnel-step ${stage === "" ? "is-on" : ""}`} onClick={() => setSp({}, { replace: true })} aria-pressed={stage === ""}>
              <span className="funnel-label">All offers</span>
              <span className="funnel-n num">{num(all.length)}</span>
              <span className="funnel-amt num">{rupeesShort(sum(all))}</span>
              <span className="funnel-share" aria-hidden="true">
                <span />
              </span>
            </button>
            {STAGES.map((st) => {
              const xs = all.filter((o) => o.stage === st.s);
              return (
                <button
                  key={st.s}
                  className={`funnel-step fs-${st.s.toLowerCase()} ${stage === st.s ? "is-on" : ""}`}
                  onClick={() => setSp({ stage: st.s }, { replace: true })}
                  aria-pressed={stage === st.s}
                  title={st.help}
                >
                  <span className="funnel-label">{st.label}</span>
                  <span className="funnel-n num">{num(xs.length)}</span>
                  <span className="funnel-amt num">{rupeesShort(sum(xs))}</span>
                  <span className="funnel-share" aria-hidden="true">
                    <span style={{ transform: `scaleX(${xs.length / all.length})` }} />
                  </span>
                </button>
              );
            })}
          </nav>
          <Panel flush>
            {rows.length === 0 ? (
              <Empty title="Nothing at this stage" />
            ) : (
              <div className="table-wrap table-wrap-tall">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col" className="r">Rank</th>
                      <th scope="col">Company</th>
                      <th scope="col">Decision</th>
                      <th scope="col">Grade</th>
                      <th scope="col" className="r">Offer</th>
                      <th scope="col" className="r">ROI</th>
                      <th scope="col" className="r">Agreed</th>
                      <th scope="col">Stage</th>
                      <th scope="col">Updated</th>
                      {user.role !== "rm" && <th scope="col">RM</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((o) => (
                      <tr key={o.offer_id}>
                        <td className="r num">{o.rank_no ?? "–"}</td>
                        <td>
                          <Link className="strong" to={`/offers/${o.offer_id}`}>
                            {o.legal_name}
                          </Link>
                          <br />
                          <code className="small muted">{o.cif_id}</code>
                        </td>
                        <td>
                          <DecisionBadge d={o.decision} />
                        </td>
                        <td>
                          <Grade g={o.grade} />
                        </td>
                        <td className="r">
                          <Money v={o.offer_amount} short />
                        </td>
                        <td className="r num">{pct(o.offer_roi)}</td>
                        <td className="r num">
                          {o.agreed_amount != null ? (
                            <>
                              {rupeesShort(o.agreed_amount)} <span className="muted">at {pct(o.agreed_roi)}</span>
                            </>
                          ) : (
                            <span className="muted">–</span>
                          )}
                        </td>
                        <td>
                          <Stage s={o.stage} />
                        </td>
                        <td className="muted nowrap">{relative(o.updated_at)}</td>
                        {user.role !== "rm" && (
                          <td>
                            <code className="muted">{o.rm_id}</code>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function sum(xs: Offer[]) {
  return xs.reduce((a, o) => a + (o.agreed_amount ?? o.offer_amount ?? 0), 0);
}
