import { useState, type ReactNode } from "react";
import { ArrowRight, FlaskConical, GitCompareArrows, Workflow, X, BarChart3, GitBranch, LoaderCircle, Play } from "lucide-react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useModelCompare, useModels, useStartTraining } from "../../api/hooks";
import type { FeatureImportance, Model, ModelCard, ModelComparison } from "../../api/types";
import { useUser } from "../../auth/AuthContext";
import { JobProgress } from "../../components/JobProgress";
import { DecisionBadge, Empty, ErrorState, Grade, Loading, PageHeader, Panel } from "../../components/ui";
import { dateTime, num, pctFromRatio } from "../../lib/format";
import { can } from "../../lib/roles";
import { usePersistentJob } from "../../lib/usePersistentJob";
import { MyActivationRequests, RequestActivationButton } from "./ActivationParts";
import { CalibrationPanel, PsiPanel } from "./ValidationParts";
import { WithExplain } from "../../explain/Explain";
import { ExaBadge } from "../../explain/ExaBadge";

export function ModelsPage() {
  const user = useUser();
  const q = useModels();
  const train = useStartTraining();
  const qc = useQueryClient();
  const [jobId, setJobId] = usePersistentJob("train");
  const [picked, setPicked] = useState<string | null>(null);
  const models = q.data ?? [];
  const active = models.find((m) => m.active) ?? null;
  const shown = models.find((m) => m.version === picked) ?? active ?? models[0] ?? null;

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: "Exasol" }, { label: "Risk models" }]}
        title="Risk models"
        lede={
          <>
            Two probability-of-default models, trained together inside Exasol on past loans and versioned in BucketFS. They are gradient-boosted trees with monotonic credit
            constraints (<code>CREDORA.TRAIN_PD</code>) and a logistic regression scorecard (<code>CREDORA.TRAIN_SCORECARD</code>). The active model is the champion and
            decides, and the other is scored on every run in the shadow. Below, the validation evidence of the picked version, its calibration on the training&apos;s
            hold-out and the stability of the latest published run&apos;s features against the past loans.
          </>
        }
        actions={
          can(user.role, "train") && (
            <button
              className="btn btn-primary"
              disabled={train.isPending}
              onClick={async () => {
                const r = await train.mutateAsync();
                setJobId(r.job_id);
              }}
            >
              {train.isPending ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
              {train.isPending ? "Starting…" : "Train champion and challenger"}
            </button>
          )
        }
        children={
          <div className="xb-row">
            <ExaBadge what="Trained in Exasol" detail="Python UDF TRAIN_PD on VS_LOS" term="python-udf" />
            <ExaBadge what="MODEL_REGISTRY" detail="pickle in BucketFS" term="model-registry" />
            <ExaBadge what="Validated in Exasol" detail="PD_CALIBRATE, MODEL_PSI" term="model-risk-management" />
          </div>
        }
      />
      {train.isError && <ErrorState error={train.error} />}
      {jobId && (
        <Panel title="Training" icon={Workflow} aside={<button className="btn btn-quiet btn-sm" onClick={() => setJobId(null)}><X aria-hidden="true" />Clear</button>}>
          <JobProgress jobId={jobId} title="Training with CREDORA.TRAIN_MODEL" onFinish={() => void qc.invalidateQueries({ queryKey: ["models"] })} />
        </Panel>
      )}
      {q.isLoading && <Loading />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && models.length === 0 && <Empty title="No models yet" icon={FlaskConical}>Train the first models on the past-loans table.</Empty>}
      {can(user.role, "requestActivation") && <MyActivationRequests />}
      {models.length > 0 && <Comparison canActivate={can(user.role, "requestActivation")} />}
      {models.length > 0 && (
        <div className="grid-main-side grid-models">
          <Panel title="Versions" icon={GitBranch} flush>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">
                      <WithExplain id="model-registry">Version</WithExplain>
                    </th>
                    <th scope="col">Trained</th>
                    <th scope="col" className="r">Rows</th>
                    <th scope="col" className="r">
                      <WithExplain id="risk-model">AUC</WithExplain>
                    </th>
                    <th scope="col" className="r">Gini</th>
                    <th scope="col">
                      <WithExplain id="model-activation">Status</WithExplain>
                    </th>
                    <th scope="col"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.version} className={shown?.version === m.version ? "is-picked" : ""}>
                      <td>
                        <button className="linkish" onClick={() => setPicked(m.version)} aria-pressed={shown?.version === m.version}>
                          <code>{m.version}</code>
                        </button>
                        <br />
                        <span className="small muted">{m.algorithm}</span>
                      </td>
                      <td className="nowrap">
                        {dateTime(m.trained_at)}
                        <br />
                        <span className="small muted">by {m.trained_by}</span>
                      </td>
                      <td className="r num">{num(m.train_rows)}</td>
                      <td className="r num">
                        {m.auc.toFixed(3)}
                        {active && m.version !== active.version && <Delta a={m.auc} b={active.auc} />}
                      </td>
                      <td className="r num">{m.gini.toFixed(3)}</td>
                      <td>
                        {m.active ? (
                          <span className="pill pill-on">Champion</span>
                        ) : m.role === "challenger" ? (
                          <span className="pill">Challenger</span>
                        ) : (
                          <span className="muted">Inactive</span>
                        )}
                      </td>
                      <td className="r">
                        {can(user.role, "requestActivation") && !m.active && <RequestActivationButton model={m} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted pad">
              The active model is used by the next analysis run. A model becomes active only when the admin approves an activation
              request. Training never activates it, and activating does not rescore past runs.
            </p>
          </Panel>
          {shown && <Importance m={shown} active={active} />}
        </div>
      )}
      {shown && (
        <div className="stack">
          <CalibrationPanel m={shown} />
          <PsiPanel />
        </div>
      )}
    </div>
  );
}

function Delta({ a, b }: { a: number; b: number }) {
  const d = a - b;
  if (Math.abs(d) < 0.0005) return null;
  return <span className={`delta ${d > 0 ? "text-approve" : "text-decline"}`}>{` ${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(3)}`}</span>;
}

/* ------------------------------ champion vs challenger ------------------------------ */

function Comparison({ canActivate }: { canActivate: boolean }) {
  const q = useModelCompare();
  if (q.isLoading) return <Loading rows={4} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const c = q.data!;
  if (!c.champion) return null;
  const ch = c.challenger;
  return (
    <Panel
      title={<WithExplain id="challenger-model">Champion vs challenger</WithExplain>}
      icon={GitCompareArrows}
      className="cc-panel"
      aside={<span className="small muted">{c.same_holdout ? "Both measured on the same 25% hold-out of past loans" : "Each measured on its own training's hold-out"}</span>}
    >
      <div className="cc-cards">
        <CardFor m={c.champion} label="Champion" note={c.champion.active ? "decides the offers" : `decided run ${c.run_id ?? ""}, ${c.active_version ?? ""} is active now`} />
        {ch ? (
          <CardFor
            m={ch}
            label="Challenger"
            note="shadow only"
            vs={c.champion}
            action={canActivate && <RequestActivationButton model={ch} label={`Request activation of ${ch.version}`} />}
          />
        ) : (
          <Empty title="No challenger yet" icon={FlaskConical}>
            Train once more. Every training adds a logistic regression scorecard next to the trees.
          </Empty>
        )}
      </div>
      {ch && <Shadow c={c} />}
    </Panel>
  );
}

function CardFor({ m, label, note, vs, action }: { m: ModelCard; label: string; note: string; vs?: ModelCard; action?: ReactNode }) {
  return (
    <section className="cc-card" aria-label={`${label} ${m.version}`}>
      <div className="cc-head">
        <span className={`pill ${label === "Champion" ? "pill-on" : ""}`}>{label}</span>
        <code>{m.version}</code>
        <span className="small muted">{note}</span>
      </div>
      <p className="small muted">{m.algorithm}</p>
      <dl className="cc-metrics">
        <div>
          <dt>AUC</dt>
          <dd className="num">
            {m.auc != null ? m.auc.toFixed(3) : "–"}
            {vs?.auc != null && m.auc != null && <Delta a={m.auc} b={vs.auc} />}
          </dd>
        </div>
        <div>
          <dt>Gini</dt>
          <dd className="num">
            {m.gini != null ? m.gini.toFixed(3) : "–"}
            {vs?.gini != null && m.gini != null && <Delta a={m.gini} b={vs.gini} />}
          </dd>
        </div>
      </dl>
      <p className="small muted">{m.kind === "coefficient" ? "Top coefficients in log-odds per standard deviation (+ raises risk)" : "Top features by permutation importance (AUC lost without it)"}</p>
      <Bars items={m.top} signed={m.kind === "coefficient"} />
      {action && <div className="cc-action">{action}</div>}
    </section>
  );
}

const MOVE_WORD: Record<string, string> = { APPROVE: "approve", REFER: "refer", DECLINE: "decline" };

function Shadow({ c }: { c: ModelComparison }) {
  if (!c.scored)
    return (
      <p className="small muted top-gap">
        {c.run_id ? `Run ${c.run_id} has not been scored by the challenger yet.` : "No analysis run yet."} The next analysis run, or the next training, scores it in the shadow.
      </p>
    );
  return (
    <div className="cc-shadow">
      <p className="cc-summary">
        On run <code>{c.run_id}</code>, the challenger would change <strong className="num">{num(c.grades_changed)}</strong> of {num(c.companies)} grades and{" "}
        <strong className="num">{num(c.decisions_changed)}</strong> decisions. Average PD {pctFromRatio(c.champion_mean_pd)} with the champion, {pctFromRatio(c.challenger_mean_pd)} with the
        challenger.
      </p>
      {c.transitions.length > 0 && (
        <ul className="cc-moves" aria-label="Decisions that would change">
          {c.transitions.map((t) => (
            <li key={`${t.from}-${t.to}`}>
              <DecisionBadge d={t.from} />
              <ArrowRight aria-hidden="true" className="cc-arrow" />
              <DecisionBadge d={t.to} />
              <span className="num">{num(t.n)}</span>
              <span className="sr-only">
                companies would move from {MOVE_WORD[t.from]} to {MOVE_WORD[t.to]}
              </span>
            </li>
          ))}
        </ul>
      )}
      {c.changed.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Companies whose decision would change, largest PD difference first</caption>
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col">Champion</th>
                <th scope="col">Challenger</th>
                <th scope="col" className="r">PD champion</th>
                <th scope="col" className="r">PD challenger</th>
              </tr>
            </thead>
            <tbody>
              {c.changed.map((x) => (
                <tr key={x.cif_id}>
                  <td>
                    <Link to={`/companies/${x.cif_id}/report`}>{x.legal_name}</Link>
                    <br />
                    <code className="small muted">{x.cif_id}</code>
                  </td>
                  <td className="nowrap">
                    <DecisionBadge d={x.from} /> <Grade g={x.champion_grade} />
                  </td>
                  <td className="nowrap">
                    <DecisionBadge d={x.to} /> <Grade g={x.challenger_grade} />
                  </td>
                  <td className="r num">{pctFromRatio(x.champion_pd)}</td>
                  <td className="r num">{pctFromRatio(x.challenger_pd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted top-gap">
        Shadow only. <code>CREDORA.SCORE_CHALLENGER</code> runs the decision SQL again on the challenger's PD and writes <code>CREDORA.CHALLENGER_SCORES</code>. No offer changes until a
        data scientist requests the challenger&apos;s activation and the admin approves it, and then from the next run.
      </p>
    </div>
  );
}

/* ------------------------------ importance and coefficients ------------------------------ */

function Bars({ items, signed, cmp, max: maxIn }: { items: FeatureImportance[]; signed: boolean; cmp?: Map<string, number> | null; max?: number }) {
  const max = maxIn ?? Math.max(1e-9, ...items.map((f) => Math.abs(f.importance)));
  return (
    <ol className="fi">
      {items.map((f) => {
        const w = (Math.abs(f.importance) / max) * (signed ? 50 : 100);
        const up = f.importance > 0;
        return (
          <li key={f.feature} className={`fi-row ${signed ? (up ? "is-up" : "is-down") : ""}`}>
            <code className="fi-name">{f.feature}</code>
            <span className={`fi-bar ${signed ? "fi-bar-signed" : ""}`}>
              <span className="fi-fill" style={signed ? (up ? { left: "50%", width: `${w}%` } : { left: `${50 - w}%`, width: `${w}%` }) : { width: `${Math.max(0, w)}%` }} />
              {!signed && cmp?.has(f.feature) && <span className="fi-tick" style={{ left: `${(Math.max(0, cmp.get(f.feature)!) / max) * 100}%` }} />}
            </span>
            <span className="num small">
              {signed && up ? "+" : ""}
              {f.importance.toFixed(3)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Importance({ m, active }: { m: Model; active: Model | null }) {
  const signed = m.kind === "coefficient";
  const fi = [...m.feature_importance].sort((a, b) => (signed ? Math.abs(b.importance) - Math.abs(a.importance) : b.importance - a.importance));
  const sameKind = !!active && active.version !== m.version && (active.kind ?? "importance") === (m.kind ?? "importance");
  const cmp = sameKind && !signed ? new Map(active!.feature_importance.map((f) => [f.feature, f.importance])) : null;
  const max = signed ? undefined : Math.max(1e-9, ...fi.map((f) => f.importance), ...(cmp ? [...cmp.values()] : []));
  return (
    <Panel
      icon={BarChart3}
      title={
        <>
          {signed ? "Coefficients" : "Feature importance"}, <code>{m.version}</code>
        </>
      }
      aside={cmp ? <span className="small muted">tick = active {active!.version}</span> : signed ? <span className="small muted">+ raises risk, − lowers it</span> : undefined}
    >
      <Bars items={fi} signed={signed} cmp={cmp} max={max} />
    </Panel>
  );
}
