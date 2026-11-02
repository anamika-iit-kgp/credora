// Model-validation evidence on the Risk models screen. Calibration of one model on the training's own
// hold-out (CREDORA.MODEL_CALIBRATION, written by CALIBRATE_MODEL) and the population stability index of
// the latest published run's features against the past loans (CREDORA.MODEL_PSI). How to read both is in
// docs/MODEL_VALIDATION.md.
import { Activity, LoaderCircle, RefreshCw, Target } from "lucide-react";
import { useCalibration, useComputeCalibration, useComputePsi, usePsi } from "../../api/hooks";
import type { Calibration, CalibrationDecile, Model, Psi, PsiBand, PsiFeature } from "../../api/types";
import { useUser } from "../../auth/AuthContext";
import { Empty, ErrorState, Loading, Panel } from "../../components/ui";
import { dateTime, num, pctFromRatio } from "../../lib/format";
import { can } from "../../lib/roles";
import { WithExplain } from "../../explain/Explain";

const f3 = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(3));
const f4 = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(4));

/* ------------------------------ calibration on the hold-out ------------------------------ */

export function CalibrationPanel({ m }: { m: Model }) {
  const user = useUser();
  const q = useCalibration(m.version);
  const compute = useComputeCalibration();
  const busy = compute.isPending && compute.variables === m.version;
  const button = can(user.role, "computeValidation") && (
    <button className="btn btn-quiet btn-sm" disabled={compute.isPending} onClick={() => compute.mutate(m.version)}>
      {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
      {busy ? "Calibrating…" : q.data?.computed ? "Recompute" : "Compute on the hold-out"}
    </button>
  );
  return (
    <Panel
      icon={Target}
      title={
        <>
          <WithExplain id="model-risk-management">Calibration on the hold-out</WithExplain>, <code>{m.version}</code>
        </>
      }
      aside={button}
    >
      {q.isLoading && <Loading rows={4} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {compute.isError && compute.variables === m.version && <ErrorState error={compute.error} />}
      {q.data && !q.data.computed && (
        <Empty title="Not computed yet" icon={Target}>
          <code>CREDORA.CALIBRATE_MODEL</code> repeats the training&apos;s hold-out split over the past loans, fits a fresh copy of this model&apos;s recipe on the
          rest and scores the hold-out, so every figure here is on loans the model did not learn from.
        </Empty>
      )}
      {q.data?.computed && <CalibrationBody cal={q.data} />}
    </Panel>
  );
}

function skillSentence(cal: Calibration): string {
  const { brier, brier_base: base } = cal;
  if (brier == null || base == null) return "";
  const skill = base > 0 ? 1 - brier / base : 0;
  if (skill <= 0) return `The Brier score of ${f4(brier)} is no better than the ${f4(base)} of always predicting the training default rate, so the probabilities carry no information beyond the base rate.`;
  return `The Brier score of ${f4(brier)} beats the ${f4(base)} of always predicting the training default rate by ${Math.round(skill * 100)}%, so the probabilities carry information beyond the base rate.`;
}

function gapSentence(cal: Calibration): string {
  if (cal.max_gap == null) return "";
  const pp = (cal.max_gap * 100).toFixed(1);
  if (cal.max_gap < 0.02) return `The largest gap between predicted and observed in any decile is ${pp} percentage points, so the PDs read as probabilities, not only as a ranking.`;
  if (cal.max_gap <= 0.05) return `The largest gap between predicted and observed in any decile is ${pp} percentage points. The ranking holds, and the PDs are close to probabilities.`;
  return `The largest gap between predicted and observed in any decile is ${pp} percentage points. The ranking may hold, but the PDs should not be read as probabilities without a recalibration.`;
}

function aucSentence(cal: Calibration): string {
  if (cal.auc == null) return "";
  if (cal.registry_auc == null) return `The hold-out AUC is ${f3(cal.auc)}.`;
  return cal.reproduces_training
    ? `The reproduced hold-out AUC ${f3(cal.auc)} equals the ${f3(cal.registry_auc)} in MODEL_REGISTRY, so the past loans are still the ones this model learnt from.`
    : `The reproduced hold-out AUC ${f3(cal.auc)} differs from the ${f3(cal.registry_auc)} in MODEL_REGISTRY, so the past loans changed since the training and this hold-out is not the training's.`;
}

function CalibrationBody({ cal }: { cal: Calibration }) {
  const max = Math.max(1e-6, ...cal.deciles.flatMap((d) => [d.mean_pd ?? 0, d.observed_rate ?? 0]));
  return (
    <div className="val">
      <dl className="val-metrics">
        <div>
          <dt>Brier score</dt>
          <dd className="num">
            {f4(cal.brier)} <span className="small muted">base {f4(cal.brier_base)}</span>
          </dd>
        </div>
        <div>
          <dt>AUC on the hold-out</dt>
          <dd className="num">
            {f3(cal.auc)} <span className="small muted">registry {f3(cal.registry_auc)}</span>
          </dd>
        </div>
        <div>
          <dt>Hold-out loans</dt>
          <dd className="num">
            {num(cal.n_holdout)} <span className="small muted">25% of the past loans</span>
          </dd>
        </div>
      </dl>
      <p className="val-read">
        {skillSentence(cal)} {gapSentence(cal)} {aucSentence(cal)}
      </p>
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Hold-out loans by decile of predicted PD, with the mean predicted PD and the observed default rate</caption>
          <thead>
            <tr>
              <th scope="col">Decile</th>
              <th scope="col" className="r">Loans</th>
              <th scope="col" className="r">Predicted PD</th>
              <th scope="col" className="r">Observed</th>
              <th scope="col" className="r">Defaults</th>
              <th scope="col">
                <span className="cal-legend">
                  <span>
                    <i className="cal-legend-pred" aria-hidden="true" />
                    predicted
                  </span>
                  <span>
                    <i className="cal-legend-obs" aria-hidden="true" />
                    observed
                  </span>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {cal.deciles.map((d) => (
              <DecileRow key={d.decile} d={d} max={max} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted top-gap">
        Decile 1 holds the lowest predicted PDs, decile 10 the highest. A calibrated model shows the two bars at the same length in every decile.
        Computed {dateTime(cal.computed_at)} by <code>CREDORA.PD_CALIBRATE</code> over <code>VS_LOS.past_loan_training</code>.
      </p>
    </div>
  );
}

function DecileRow({ d, max }: { d: CalibrationDecile; max: number }) {
  const w = (v: number | null) => `${((v ?? 0) / max) * 100}%`;
  return (
    <tr>
      <td className="num">{d.decile}</td>
      <td className="r num">{num(d.n)}</td>
      <td className="r num" title={`PD from ${pctFromRatio(d.pd_min)} to ${pctFromRatio(d.pd_max)}`}>
        {pctFromRatio(d.mean_pd)}
      </td>
      <td className="r num">{pctFromRatio(d.observed_rate)}</td>
      <td className="r num">{num(d.defaults)}</td>
      <td>
        <span className="cal-bar" aria-hidden="true">
          <span className="cal-pred" style={{ width: w(d.mean_pd) }} />
          <span className="cal-obs" style={{ width: w(d.observed_rate) }} />
        </span>
      </td>
    </tr>
  );
}

/* ------------------------------ population stability ------------------------------ */

const BAND_WORD: Record<PsiBand, string> = { stable: "stable", shift: "some shift", significant: "significant shift", unknown: "no value" };
const BAND_PILL: Record<PsiBand, string> = { stable: "pill-on", shift: "pill-warn", significant: "pill-off", unknown: "" };

export function PsiPanel() {
  const user = useUser();
  const q = usePsi();
  const compute = useComputePsi();
  const runId = q.data?.run_id ?? null;
  const button = can(user.role, "computeValidation") && runId && (
    <button className="btn btn-quiet btn-sm" disabled={compute.isPending} onClick={() => compute.mutate(runId)}>
      {compute.isPending ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
      {compute.isPending ? "Comparing…" : q.data?.computed ? "Recompute" : "Compute for this run"}
    </button>
  );
  return (
    <Panel
      icon={Activity}
      title={
        <>
          <WithExplain id="model-risk-management">Population stability</WithExplain>
          {runId && (
            <>
              , run <code>{runId}</code>
            </>
          )}
        </>
      }
      aside={button}
    >
      {q.isLoading && <Loading rows={4} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {compute.isError && <ErrorState error={compute.error} />}
      {q.data && !runId && (
        <Empty title="No published run yet" icon={Activity}>
          The PSI compares the features of the latest published run with the past loans. Run and publish an analysis first.
        </Empty>
      )}
      {q.data && runId && !q.data.computed && (
        <Empty title="Not computed yet" icon={Activity}>
          <code>CREDORA.MODEL_PSI</code> bins each of the 13 model features of this run against the tenths of the past loans and sums the shift.
        </Empty>
      )}
      {q.data?.computed && <PsiBody psi={q.data} />}
    </Panel>
  );
}

function PsiBody({ psi }: { psi: Psi }) {
  const { counts, thresholds: t } = psi;
  const total = psi.features.length;
  return (
    <div className="val">
      <p className="val-read">
        Across the {total} model features, {num(counts.stable)} {counts.stable === 1 ? "is" : "are"} stable, {num(counts.shift)}{" "}
        {counts.shift === 1 ? "shows" : "show"} some shift and {num(counts.significant)} {counts.significant === 1 ? "shows" : "show"} a significant shift.
        {psi.max_feature && psi.max_psi != null && (
          <>
            {" "}
            The largest is <code>{psi.max_feature}</code> at PSI {f3(psi.max_psi)}.
          </>
        )}
      </p>
      <p className="small muted">
        Below {t.some_shift} the feature is stable. From {t.some_shift} to {t.significant} the population moved somewhat and the feature deserves a look.
        Above {t.significant} the shift is significant and the model may be scoring companies unlike the ones it learnt from.
      </p>
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Population stability index per model feature, largest shift first</caption>
          <thead>
            <tr>
              <th scope="col">Feature</th>
              <th scope="col" className="r">PSI</th>
              <th scope="col">Shift</th>
              <th scope="col">
                <span className="small muted">0 to {t.significant * 2}, ticks at {t.some_shift} and {t.significant}</span>
              </th>
              <th scope="col" className="r">Past loans mean</th>
              <th scope="col" className="r">This run mean</th>
              <th scope="col">Tenths</th>
            </tr>
          </thead>
          <tbody>
            {psi.features.map((f) => (
              <PsiRow key={f.feature} f={f} psi={psi} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted top-gap">
        Ten bins fixed on the {num(psi.features[0]?.n_train ?? 0)} past loans the models learnt from, against the {num(psi.features[0]?.n_live ?? 0)} companies analysed
        in this run. Companies without a value for a feature are left out of its shares. Some shift is expected by design. The past loans are synthetic feature snapshots
        drawn by formula, while the live features are computed from ledgers, returns and bureau reports, so a feature whose two formulas differ moves even when the companies
        do not. Computed {dateTime(psi.computed_at)} by <code>CREDORA.MODEL_PSI</code>.
      </p>
    </div>
  );
}

function PsiRow({ f, psi }: { f: PsiFeature; psi: Psi }) {
  const scale = psi.thresholds.significant * 2;
  const w = Math.min(1, (f.psi ?? 0) / scale) * 100;
  const meanOf = (v: number | null) => (v == null ? "–" : Math.abs(v) >= 100 ? num(v) : num(v, 3));
  return (
    <tr>
      <td>
        <code>{f.feature}</code>
        {f.null_live > 0 && (
          <>
            <br />
            <span className="small muted">{num(f.null_live)} without a value</span>
          </>
        )}
      </td>
      <td className="r num">{f3(f.psi)}</td>
      <td>
        <span className={`pill ${BAND_PILL[f.band]}`}>{BAND_WORD[f.band]}</span>
      </td>
      <td>
        <span className="psi-bar" aria-hidden="true">
          <span className={`psi-fill is-${f.band}`} style={{ width: `${w}%` }} />
          <span className="psi-tick" style={{ left: `${(psi.thresholds.some_shift / scale) * 100}%` }} />
          <span className="psi-tick" style={{ left: `${(psi.thresholds.significant / scale) * 100}%` }} />
        </span>
      </td>
      <td className="r num">{meanOf(f.train_mean)}</td>
      <td className="r num">{meanOf(f.live_mean)}</td>
      <td>
        <BinStrip f={f} />
      </td>
    </tr>
  );
}

/** Ten pairs of tiny bars, the past loans' share next to this run's share per bin. */
function BinStrip({ f }: { f: PsiFeature }) {
  if (f.bins.length === 0) return null;
  const max = Math.max(1e-6, ...f.bins.flatMap((b) => [b.train, b.live]));
  const text = f.bins.map((b) => `bin ${b.bin} past ${pctFromRatio(b.train, 0)} run ${pctFromRatio(b.live, 0)}`).join(", ");
  return (
    <span className="bins" title={text}>
      <span className="sr-only">{text}</span>
      {f.bins.map((b) => (
        <span key={b.bin} aria-hidden="true">
          <i style={{ height: `${(b.train / max) * 100}%` }} />
          <i style={{ height: `${(b.live / max) * 100}%` }} />
        </span>
      ))}
    </span>
  );
}
