import { useEffect, useState } from "react";
import { Search, SearchX, X } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useCompanies } from "../../api/hooks";
import { useUser } from "../../auth/AuthContext";
import { SourceLegend } from "../../components/SourceTag";
import { DecisionBadge, Empty, ErrorState, Loading, Money, PageHeader, Pager, Panel } from "../../components/ui";
import { num } from "../../lib/format";
import { ExaBadge } from "../../explain/ExaBadge";

const SIZE = 25;

export function CompaniesPage() {
  const user = useUser();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const q = sp.get("q") ?? "";
  const stage = sp.get("stage") ?? "";
  const decision = sp.get("decision") ?? "";
  const page = Number(sp.get("page") ?? 1);
  const [text, setText] = useState(q);

  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== q) update({ q: text, page: "" });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  function update(p: Record<string, string>) {
    const n = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(p)) (v ? n.set(k, v) : n.delete(k));
    setSp(n, { replace: true });
  }

  const res = useCompanies({ q, stage, decision, page, size: SIZE });

  return (
    <div className="page">
      <PageHeader
        title="Data explorer"
        lede={
          user.role === "rm"
            ? "Only the companies loan operations assigned to you. Exasol filters the rows for your login. Open one for its full details, credit need on file and pre-approved offer."
            : "Every company, and everything Credora knows about it. Open one to see where each piece of data came from."
        }
      >
        <SourceLegend />
        <div className="xb-row">
          {user.role === "rm" ? (
            <ExaBadge what="Row-level security" detail="V_RM_* on CURRENT_USER" term="row-level-security" />
          ) : (
            <ExaBadge kind="bank" what="Read live" detail="VS_CIF pushdown to MySQL" term="pushdown" />
          )}
          <ExaBadge what="Joined in Exasol" detail="CREDORA.DECISIONS of the published run" term="run-publish" />
        </div>
      </PageHeader>

      <Panel flush>
        <div className="filters" role="search">
          <label className="field field-inline grow">
            <span className="sr-only">Search companies</span>
            <Search className="field-icon" aria-hidden="true" />
            <input
              className="input input-icon"
              type="search"
              placeholder="Search by name, CIF or city…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <label className="field field-inline">
            <span className="field-label">GST stage</span>
            <select className="input" value={stage} onChange={(e) => update({ stage: e.target.value, page: "" })}>
              <option value="">All</option>
              <option value="New">New (2–4 years)</option>
              <option value="Mid-level">Mid-level (5–7)</option>
              <option value="Stable">Stable (8–10)</option>
            </select>
          </label>
          <label className="field field-inline">
            <span className="field-label">Decision</span>
            <select className="input" value={decision} onChange={(e) => update({ decision: e.target.value, page: "" })}>
              <option value="">All</option>
              <option value="APPROVE">Approve</option>
              <option value="REFER">Refer</option>
              <option value="DECLINE">Decline</option>
            </select>
          </label>
          {res.data && (
            <span className="filters-count muted">
              <span className="num">{num(res.data.total)}</span> companies
            </span>
          )}
        </div>

        {res.isLoading && <Loading rows={10} />}
        {res.isError && <ErrorState error={res.error} retry={() => res.refetch()} />}
        {res.data && res.data.items.length === 0 && (
          <Empty
            title="No companies match"
            icon={SearchX}
            action={
              <button className="btn btn-quiet btn-sm" onClick={() => { setText(""); setSp(new URLSearchParams(), { replace: true }); }}>
                <X aria-hidden="true" />
                Clear filters
              </button>
            }
          >
            Try a shorter name, or clear the stage and decision filters.
          </Empty>
        )}
        {res.data && res.data.items.length > 0 && (
          <>
            <div className={`table-wrap ${res.isFetching ? "is-refreshing" : ""}`}>
              <table className="table table-hover">
                <thead>
                  <tr>
                    <th scope="col">CIF</th>
                    <th scope="col">Company</th>
                    <th scope="col">Industry</th>
                    <th scope="col">City</th>
                    <th scope="col">GST stage</th>
                    <th scope="col" className="r">Partners</th>
                    <th scope="col">RM</th>
                    <th scope="col">Decision</th>
                    <th scope="col" className="r">Rank</th>
                    <th scope="col" className="r">Offer</th>
                  </tr>
                </thead>
                <tbody>
                  {res.data.items.map((c) => (
                    <tr key={c.cif_id} onClick={() => nav(`/companies/${c.cif_id}`)} className="clickable">
                      <td>
                        <code>{c.cif_id}</code>
                      </td>
                      <td className="strong">
                        <Link to={`/companies/${c.cif_id}`} onClick={(e) => e.stopPropagation()}>
                          {c.legal_name}
                        </Link>
                      </td>
                      <td className="muted">{c.industry}</td>
                      <td>{c.city}</td>
                      <td>
                        <span className={`gst gst-${c.stage.toLowerCase()}`}>{c.stage}</span>
                      </td>
                      <td className="r num">{c.partners}</td>
                      <td>
                        <code className="muted">{c.rm_id}</code>
                      </td>
                      <td>
                        <DecisionBadge d={c.decision} />
                      </td>
                      <td className="r num">{c.rank_no ?? "–"}</td>
                      <td className="r">
                        <Money v={c.offer_amount} short />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={res.data.page} size={res.data.size} total={res.data.total} onPage={(p) => update({ page: String(p) })} />
          </>
        )}
      </Panel>
    </div>
  );
}
