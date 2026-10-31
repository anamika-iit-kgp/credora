import { Link } from "react-router-dom";
import { Activity, Briefcase, Building2, DatabaseZap, FlaskConical, History, Play, Server, Target, UserPlus, Users, Wallet, type LucideIcon } from "lucide-react";
import { useOverview } from "../api/hooks";
import type { SourceHealth, SourceKind } from "../api/types";
import { useUser } from "../auth/AuthContext";
import { PublishedNotice } from "../components/PublishedNotice";
import { SourceHealthStrip } from "../components/SourceHealth";
import { Counter, Empty, ErrorState, Loading, MixBar, PageHeader, Panel } from "../components/ui";
import { dateTime, duration, relative } from "../lib/format";
import { can } from "../lib/roles";
import { Explain, WithExplain } from "../explain/Explain";
import { ExaBadge } from "../explain/ExaBadge";

export function OverviewPage() {
  const user = useUser();
  const q = useOverview();

  const action = can(user.role, "generate") ? (
    <Link className="btn" to="/admin/data">
      <DatabaseZap aria-hidden="true" />
      Generate mock data
    </Link>
  ) : can(user.role, "runAnalysis") ? (
    <Link className="btn btn-primary" to="/analysis">
      <Play aria-hidden="true" />
      Run analysis
    </Link>
  ) : user.role === "rm" ? (
    <Link className="btn btn-primary" to="/book">
      <Briefcase aria-hidden="true" />
      Open my companies
    </Link>
  ) : can(user.role, "assign") ? (
    <Link className="btn btn-primary" to="/analysis/decisions?assigned=no">
      <UserPlus aria-hidden="true" />
      Assign companies to RMs
    </Link>
  ) : (
    <Link className="btn btn-primary" to="/models">
      <FlaskConical aria-hidden="true" />
      Open risk models
    </Link>
  );

  return (
    <div className="page">
      <PageHeader
        title="Overview"
        lede={
          q.data?.last_generation
            ? `Data set from seed ${q.data.last_generation.seed}, generated ${relative(q.data.last_generation.generated_at)}.`
            : "Sapphire Bank's corporate book, the 3rd party data on it fetched on demand via API, and what Exasol made of it."
        }
        actions={action}
      />
      <PublishedNotice />
      {q.isLoading && <Loading />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && (
        <>
          <section className="ledger" aria-label="Counts">
            {(
              [
                ...(user.role === "rm"
                  ? [
                      ["My companies", q.data.counts.companies, "assigned to you by loan operations", Building2, false],
                      ["Partners", q.data.counts.partners, "of your companies", Users, false],
                      ["Companies analysed", q.data.counts.applications, "of yours, in the published run", Target, true],
                      ["Sapphire accounts", q.data.counts.accounts, "current accounts of your companies", Wallet, false],
                    ]
                  : [
                      ["Companies", q.data.counts.companies, "corporate current-account customers", Building2, false],
                      ["Partners", q.data.counts.partners, "directors, partners, promoters", Users, false],
                      ["Companies analysed", q.data.counts.applications, "for a pre-approved offer", Target, true],
                      ["Sapphire accounts", q.data.counts.accounts, "company and partner accounts", Wallet, false],
                    ]),
              ] as [string, number, string, LucideIcon, boolean][]
            ).map(([k, v, s, Icon, lead]) => (
              <div key={k} className={`ledger-cell ${lead ? "is-lead" : ""}`}>
                <span className="ledger-label">
                  <Icon aria-hidden="true" />
                  {k}
                  {lead ? (
                    <Explain id="run-analysis" label={k} />
                  ) : user.role === "rm" ? (
                    k === "My companies" && <Explain id="row-level-security" label={k} />
                  ) : (
                    <Explain id="virtual-schema" label={`${k}, counted through a virtual schema`} />
                  )}
                </span>
                <Counter value={v} className="ledger-value" />
                <span className="ledger-sub">{s}</span>
              </div>
            ))}
          </section>

          <div className="grid-2">
            <Panel
              title={<WithExplain id="approve-refer-decline">Decision mix</WithExplain>}
              icon={Activity}
              aside={q.data.last_analysis && <span className="muted">run {q.data.last_analysis.run_id}</span>}
            >
              {q.data.decision_mix ? (
                <>
                  <MixBar mix={q.data.decision_mix} label="Decision mix" />
                  <div className="xb-row top-gap">
                    <ExaBadge what="Decided in Exasol" detail="CREDORA.DECISIONS, GROUP BY DECISION" term="run-analysis" />
                    {user.role === "rm" && <ExaBadge what="Row-level security" detail="V_RM_* on CURRENT_USER" term="row-level-security" />}
                  </div>
                </>
              ) : (
                <Empty
                  title="No decisions on this data set yet"
                  action={
                    can(user.role, "runAnalysis") ? (
                      <Link to="/analysis" className="btn btn-primary btn-sm">
                        Run analysis
                      </Link>
                    ) : undefined
                  }
                >
                  {user.role === "rm"
                    ? "Nothing is assigned to you in the published run yet. Loan operations assigns companies to you."
                    : "No published analysis on this data set. The data scientist runs the analysis and publishes it to loan operations."}
                </Empty>
              )}
            </Panel>
            <Panel title="Last runs" icon={History}>
              <dl className="facts">
                <div>
                  <dt>
                    <DatabaseZap aria-hidden="true" />
                    Mock data generated
                  </dt>
                  <dd>
                    {q.data.last_generation ? (
                      <>
                        {dateTime(q.data.last_generation.generated_at)}
                        <span className="muted"> · seed </span>
                        <span className="num">{q.data.last_generation.seed}</span>
                      </>
                    ) : (
                      "Never"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>
                    <Activity aria-hidden="true" />
                    Analysis
                  </dt>
                  <dd>
                    {q.data.last_analysis ? (
                      <>
                        {can(user.role, "runs") ? <Link to="/analysis">{q.data.last_analysis.run_id}</Link> : <code>{q.data.last_analysis.run_id}</code>}
                        <span className="muted"> · {dateTime(q.data.last_analysis.finished_at)} · </span>
                        <span className="num">{duration(q.data.last_analysis.duration_ms)}</span> in Exasol
                        {q.data.last_analysis.published_by && (
                          <span className="muted"> · published by {q.data.last_analysis.published_by}</span>
                        )}
                      </>
                    ) : (
                      "Not run on this data set"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>
                    <FlaskConical aria-hidden="true" />
                    Risk model
                    <Explain id="model-registry" label="the risk model version" />
                  </dt>
                  <dd>{q.data.last_analysis?.model_version ?? "–"}</dd>
                </div>
              </dl>
            </Panel>
          </div>

          <Panel title="Sources" icon={Server} aside={<SourceKindNote sources={q.data.sources} />} flush>
            <SourceHealthStrip sources={q.data.sources} />
          </Panel>
        </>
      )}
    </div>
  );
}

function SourceKindNote({ sources }: { sources: SourceHealth[] }) {
  const down = sources.filter((s) => s.status === "down");
  const by = (k: SourceKind) => sources.filter((s) => s.kind === k).length;
  return (
    <span className={down.length ? "text-decline" : "muted"}>
      {down.length ? `${down.length} down (${down.map((d) => d.label).join(", ")})` : `All ${sources.length} up · ${by("bank")} bank, ${by("api")} 3rd party API, ${by("exasol")} Exasol`}
    </span>
  );
}
