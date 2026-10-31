import { useState } from "react";
import { Briefcase, ChevronsDownUp, Code, Handshake, LoaderCircle, Network, Play, Sparkles, Receipt, Scale, Server, ShieldAlert, Table2 } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useAiStatus, useCreditMemo, useGenerateMemo, useReport } from "../../api/hooks";
import type { ApiError } from "../../api/client";
import type { CreditMemo, Feature, Reason, Report, ReportStep } from "../../api/types";
import { useUser } from "../../auth/AuthContext";
import { CodeBlock } from "../../components/CodeBlock";
import { SourceTag } from "../../components/SourceTag";
import { DecisionBadge, Empty, ErrorState, Grade, Loading, PageHeader, Panel } from "../../components/ui";
import { dateTime, duration, num, pct, pctFromRatio, rupees, rupeesShort } from "../../lib/format";
import { can } from "../../lib/roles";
import { Explain, WithExplain } from "../../explain/Explain";
import { ExaBadge } from "../../explain/ExaBadge";

export function ReportPage() {
  const { cif = "" } = useParams();
  const user = useUser();
  const q = useReport(cif);
  const crumbs = [
    { to: "/companies", label: "Data explorer" },
    { to: `/companies/${cif}`, label: cif },
    { label: "Exasol report" },
  ];

  if (q.isLoading)
    return (
      <div className="page">
        <PageHeader crumbs={crumbs} title="Exasol report" />
        <Loading rows={10} />
      </div>
    );
  if (q.isError) {
    const status = (q.error as ApiError).status;
    return (
      <div className="page">
        <PageHeader crumbs={crumbs} title="Exasol report" />
        {status === 404 ? (
          <Empty
            title="No Exasol report for this company yet"
            action={
              can(user.role, "runAnalysis") ? (
                <Link className="btn btn-primary btn-sm" to="/analysis">
                  <Play aria-hidden="true" />
                  Run analysis
                </Link>
              ) : undefined
            }
          >
            {(q.error as Error).message}
          </Empty>
        ) : (
          <ErrorState error={q.error} retry={() => q.refetch()} />
        )}
      </div>
    );
  }
  const r = q.data!;

  return (
    <div className="page">
      <PageHeader
        crumbs={crumbs}
        title={r.legal_name}
        lede={`${r.partners} partners · ${r.stage}, ${r.gst_years} years of GST · run ${r.run_id} · model ${r.model_version} · ${dateTime(r.generated_at)}`}
        actions={
          <>
            <Link className="btn btn-quiet" to={`/companies/${cif}`}>
              <Network aria-hidden="true" />
              Explore data
            </Link>
            {r.offer_id && user.role === "rm" && (
              <Link className="btn btn-primary" to={`/offers/${r.offer_id}`}>
                <Handshake aria-hidden="true" />
                Negotiate offer
              </Link>
            )}
            {r.offer_id && (user.role === "loanops" || user.role === "admin") && (
              <Link className="btn btn-quiet" to={`/offers/${r.offer_id}`}>
                <Briefcase aria-hidden="true" />
                Offer and trail
              </Link>
            )}
          </>
        }
      />

      <Verdict r={r} />
      <div className="xb-row" aria-label="How Exasol produced this report">
        <ExaBadge what="Decided in Exasol" detail={`RUN_ANALYSIS ${r.run_id}`} term="run-analysis" />
        <ExaBadge what="Computed in Exasol" detail="Python UDF PD_SCORE" term="python-udf" />
        <ExaBadge what="Ranked" detail="PREFERRING skyline" term="preferring-skyline" />
        {user.role === "rm" && <ExaBadge what="Row-level security" detail="V_RM_* on CURRENT_USER" term="row-level-security" />}
      </div>
      <Flags r={r} />

      <div className="grid-2 grid-report">
        <Panel title={<WithExplain id="negotiation-limit">Offer and negotiation limit</WithExplain>} icon={Receipt} aside={<SourceTag source="exasol" />}>
          <Terms r={r} />
        </Panel>
        <Panel title="Why" icon={Scale} aside={<span className="muted small">Effect of each feature on the probability of default (percentage points)</span>}>
          <Reasons reasons={r.reasons} />
        </Panel>
      </div>

      {can(user.role, "memo") && <MemoPanel cif={r.cif_id} />}

      <Steps steps={r.steps} />

      <div className="grid-main-side">
        <Panel title="Features the model saw" icon={Table2} flush>
          <Features features={r.features} />
        </Panel>
        <Panel title="Sources used" icon={Server}>
          <ul className="tag-list">
            {r.sources_used.map((s) => (
              <li key={s}>
                <SourceTag source={s} />
              </li>
            ))}
          </ul>
          <p className="muted small top-gap">
            Bank data is read in place through virtual schemas. API replies are staged in <code>CREDORA_STAGE</code> and purged on
            schedule.
          </p>
        </Panel>
      </div>
    </div>
  );
}

const ENGINE_NOTE: Record<CreditMemo["engine"], string> = {
  "exasol-udf": "Generated inside Exasol by the CREDIT_MEMO UDF",
  backend: "Generated by the API",
};

function MemoPanel({ cif }: { cif: string }) {
  const status = useAiStatus();
  const on = !!status.data?.enabled;
  const memo = useCreditMemo(cif, on);
  const gen = useGenerateMemo(cif);
  const m = memo.data;
  return (
    <Panel
      title={<WithExplain id="credit-memo-udf">Credit memo</WithExplain>}
      className="memo-panel"
      aside={
        on ? (
          <button className="btn btn-quiet btn-sm" disabled={gen.isPending || memo.isLoading} onClick={() => gen.mutate()}>
            {gen.isPending ? <LoaderCircle className="spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
            {gen.isPending ? "Writing memo…" : m ? "Regenerate" : "Generate memo"}
          </button>
        ) : undefined
      }
    >
      {status.isLoading ? (
        <Loading rows={2} />
      ) : !on ? (
        <p className="muted small">Credit memos are written by Claude. AI is not configured on this server, so this is off.</p>
      ) : memo.isLoading ? (
        <Loading rows={3} />
      ) : memo.isError ? (
        <ErrorState error={memo.error} retry={() => memo.refetch()} />
      ) : (
        <>
          {gen.isError && <ErrorState error={gen.error} retry={() => gen.mutate()} />}
          {gen.isPending && !m && <Loading label="Writing the credit memo" rows={4} />}
          {m ? (
            <div className={`memo ${gen.isPending ? "is-refreshing" : ""}`}>
              <div className="memo-text">
                {m.memo
                  .split("\n")
                  .filter((l) => l.trim())
                  .map((l, i) => (
                    <p key={i}>{l}</p>
                  ))}
              </div>
              <p className="memo-meta small muted">
                {ENGINE_NOTE[m.engine]} · Claude <code>{m.model}</code> · {dateTime(m.created_at)}. Written from this report's
                numbers only. Check before sending.
              </p>
            </div>
          ) : (
            !gen.isPending && (
              <p className="muted">
                No memo yet. Generate one to get a short note for the relationship manager with the decision, why, what to watch and what to
                negotiate.
              </p>
            )
          )}
        </>
      )}
    </Panel>
  );
}

function Verdict({ r }: { r: Report }) {
  return (
    <section className={`verdict verdict-${r.decision.toLowerCase()}`} aria-label="Decision">
      <div className="verdict-main">
        <span className="verdict-label">
          Decision
          <Explain id="approve-refer-decline" label="the decision" />
        </span>
        <DecisionBadge d={r.decision} large />
      </div>
      <div className="verdict-cell">
        <span className="verdict-label">
          Grade
          <Explain id="grade" />
        </span>
        <span className="verdict-value">
          <Grade g={r.grade} />
        </span>
      </div>
      <div className="verdict-cell">
        <span className="verdict-label">
          Probability of default
          <Explain id="pd" />
        </span>
        <span className="verdict-value num">{pctFromRatio(r.pd)}</span>
      </div>
      <div className="verdict-cell">
        <span className="verdict-label">
          Rank
          <Explain id="preferring-skyline" label="the rank" />
        </span>
        <span className="verdict-value num">
          {num(r.rank_no)}
          <span className="verdict-of"> of {num(r.rank_of)}</span>
        </span>
      </div>
      <div className="verdict-cell">
        <span className="verdict-label">
          RAROC
          <Explain id="raroc" />
        </span>
        <span className="verdict-value num">{r.raroc != null ? pct(r.raroc, 1) : "–"}</span>
      </div>
    </section>
  );
}

/** Why a company was referred or declined: the policy rules and the anomaly model's flag, as stored in
 *  CREDORA.DECISIONS.HARD_FAILS. The anomaly score itself shows only to roles that may read CREDORA.ANOMALY. */
function Flags({ r }: { r: Report }) {
  const items = r.hard_fails ?? [];
  const a = r.anomaly;
  if (!items.length && !a?.flagged) return null;
  const tone = r.decision === "DECLINE" ? "callout-decline" : "callout-refer";
  return (
    <div className={`callout ${tone} verdict-reasons`} role="note">
      <ShieldAlert aria-hidden="true" />
      <div>
        <strong>
          {r.decision === "DECLINE" ? "Why declined" : r.decision === "REFER" ? "Why referred" : "Noted"}
          <Explain id="hard-fail" label="hard fails" />
        </strong>
        {items.length > 0 && (
          <ul>
            {items.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
        {a?.flagged && (
          <p className="small">
            Anomaly model (Isolation Forest, <code>CREDORA.ANOMALY_FLAG</code>) scored <span className="num">{a.score.toFixed(3)}</span>, among the most unusual companies
            analysed in this run. A person reviews it before any offer, and it never declines on its own.
          </p>
        )}
      </div>
    </div>
  );
}

function Track({ lo, hi, a, b, labels }: { lo: number; hi: number; a: number; b: number; labels: [string, string] }) {
  const pos = (x: number) => `${Math.max(0, Math.min(100, ((x - lo) / (hi - lo || 1)) * 100))}%`;
  const left = Math.min(a, b);
  const right = Math.max(a, b);
  return (
    <div className="track" aria-hidden="true">
      <span className="track-room" style={{ left: pos(left), width: `calc(${pos(right)} - ${pos(left)})` }} />
      <span className="track-pin track-offer" style={{ left: pos(a) }} title={labels[0]} />
      <span className="track-pin track-limit" style={{ left: pos(b) }} title={labels[1]} />
    </div>
  );
}

function Terms({ r }: { r: Report }) {
  if (!r.offer || !r.limit)
    return (
      <Empty title="No offer">
        Declined companies get no offer. The reasons and the steps below show what stopped it.
      </Empty>
    );
  const rows = [
    {
      k: "Amount",
      need: rupeesShort(r.requested.amount),
      offer: rupeesShort(r.offer.amount),
      offerFull: rupees(r.offer.amount),
      limit: rupeesShort(r.limit.max_amount),
      limitNote: "maximum",
      track: <Track lo={0} hi={Math.max(r.limit.max_amount, r.requested.amount) * 1.05} a={r.offer.amount} b={r.limit.max_amount} labels={["offer", "maximum"]} />,
    },
    {
      k: "ROI",
      need: "–",
      offer: pct(r.offer.roi),
      offerFull: pct(r.offer.roi),
      limit: pct(r.limit.floor_roi),
      limitNote: "floor",
      track: <Track lo={r.limit.floor_roi - 1} hi={r.offer.roi + 0.6} a={r.offer.roi} b={r.limit.floor_roi} labels={["offer", "floor"]} />,
    },
    {
      k: "Tenure",
      need: `${r.requested.tenure} months`,
      offer: `${r.offer.tenure} months`,
      offerFull: `${r.offer.tenure} months`,
      limit: `${r.limit.max_tenure} months`,
      limitNote: "maximum",
      track: <Track lo={0} hi={Math.max(r.limit.max_tenure, r.requested.tenure) * 1.05} a={r.offer.tenure} b={r.limit.max_tenure} labels={["offer", "maximum"]} />,
    },
  ];
  return (
    <div className="terms">
      <table className="terms-table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col" className="r">
              Indicated need
            </th>
            <th scope="col" className="r">
              Offer
            </th>
            <th scope="col" className="r">
              Limit if negotiated
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.k}>
              <th scope="row">{x.k}</th>
              <td className="r num muted">{x.need}</td>
              <td className="r num terms-offer" title={x.offerFull}>
                {x.offer}
              </td>
              <td className="r num">
                {x.limit} <span className="muted small">{x.limitNote}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="terms-tracks">
        {rows.map((x) => (
          <div key={x.k} className="terms-track-row">
            <span className="small muted">{x.k}</span>
            {x.track}
          </div>
        ))}
        <p className="terms-key small muted">
          <span className="key-offer" /> offer <span className="key-limit" /> limit <span className="key-room" /> room to negotiate
        </p>
      </div>
      <p className="small muted">
        {r.requested.product}. Amount is the smallest of the indicated need, a share of GST turnover and what cash flow can repay.
      </p>
    </div>
  );
}

function Reasons({ reasons }: { reasons: Reason[] }) {
  const max = Math.max(0.01, ...reasons.map((r) => Math.abs(r.contribution)));
  return (
    <>
      <div className="shap-axis small muted" aria-hidden="true">
        <span>Lowers risk</span>
        <span>Raises risk</span>
      </div>
      <ol className="shap">
        {reasons.map((r) => {
          const w = (Math.abs(r.contribution) / max) * 50;
          const up = r.contribution > 0;
          return (
            <li key={r.feature} className={`shap-row ${up ? "is-up" : "is-down"}`}>
              <div className="shap-text">
                <span className="shap-sign" aria-hidden="true">
                  {up ? "−" : "+"}
                </span>
                <span>{r.text}</span>
                <span className="sr-only">{up ? ", raises risk" : ", lowers risk"} by {Math.abs(r.contribution).toFixed(2)}</span>
              </div>
              <div className="shap-bar" aria-hidden="true">
                <span className="shap-fill" style={up ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
              </div>
              <div className="shap-meta">
                <code className="small muted">{r.feature}</code>
                <span className="num small">{(up ? "+" : "−") + Math.abs(r.contribution).toFixed(2)}</span>
                <SourceTag source={r.source} compact />
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function featureValue(f: Feature) {
  if (f.value === null) return "–";
  if (typeof f.value === "string") return f.value;
  switch (f.unit) {
    case "inr":
      return rupeesShort(f.value);
    case "pct":
      return pct(f.value, 1);
    case "ratio":
      return pctFromRatio(f.value, 2);
    case "years":
      return `${f.value} years`;
    default:
      return num(f.value, Number.isInteger(f.value) ? 0 : f.value < 10 ? 2 : 1);
  }
}

function Features({ features }: { features: Feature[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Feature</th>
            <th scope="col" className="r">
              Value
            </th>
            <th scope="col">From</th>
          </tr>
        </thead>
        <tbody>
          {features.map((f) => (
            <tr key={f.name}>
              <td>
                {f.label}
                <br />
                <code className="small muted">{f.name}</code>
              </td>
              <td className="r num nowrap">{featureValue(f)}</td>
              <td>
                <SourceTag source={f.source} compact />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Steps({ steps }: { steps: ReportStep[] }) {
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const all = open.size === steps.length;
  const total = steps.reduce((a, s) => a + (s.ms ?? 0), 0);
  return (
    <section className="howpanel" aria-labelledby="how-title">
      <div className="howpanel-head">
        <div>
          <h2 id="how-title" className="howpanel-title">
            How Exasol decided
          </h2>
          <p className="muted">
            {steps.length} steps inside the database, <span className="num">{duration(total)}</span> for this company. Open a step to see the
            code that ran.
          </p>
        </div>
        <button className="btn btn-quiet btn-sm" onClick={() => setOpen(all ? new Set() : new Set(steps.map((s) => s.n)))}>
          {all ? <ChevronsDownUp aria-hidden="true" /> : <Code aria-hidden="true" />}
          {all ? "Collapse all" : "Show all code"}
        </button>
      </div>
      <ol className="how">
        {steps.map((s) => {
          const isOpen = open.has(s.n);
          return (
            <li key={s.n} className={`how-step ${isOpen ? "is-open" : ""}`}>
              <span className="how-n num" aria-hidden="true">
                {s.n}
              </span>
              <div className="how-body">
                <button
                  className="how-toggle"
                  aria-expanded={isOpen}
                  onClick={() =>
                    setOpen((o) => {
                      const n = new Set(o);
                      if (n.has(s.n)) n.delete(s.n);
                      else n.add(s.n);
                      return n;
                    })
                  }
                >
                  <span className="how-name">{s.name}</span>
                  <span className="how-engine">{s.engine}</span>
                  <code className="how-object">{s.object}</code>
                  <span className="how-ms num">{duration(s.ms)}</span>
                </button>
                <p className="how-what">{s.what}</p>
                <ul className="how-sources" aria-label="Fed by">
                  {s.sources.map((src) => (
                    <li key={src}>
                      <SourceTag source={src} compact />
                    </li>
                  ))}
                </ul>
                {isOpen && <CodeBlock code={s.code} lang={s.language} />}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
