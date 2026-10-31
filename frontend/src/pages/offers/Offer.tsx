import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, FileSearch, RotateCcw, Send, TriangleAlert, Handshake, History, Receipt } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { quoteOffer, useOfferAction, useOfferEvents, useOffers } from "../../api/hooks";
import type { Offer, Quote } from "../../api/types";
import { useUser } from "../../auth/AuthContext";
import { SourceTag } from "../../components/SourceTag";
import { DecisionBadge, Empty, ErrorState, Grade, KV, Loading, PageHeader, Panel, Stage } from "../../components/ui";
import { dateTime, num, pct, pctFromRatio, rupees, rupeesShort } from "../../lib/format";
import { can } from "../../lib/roles";
import { CheckerActions } from "./CheckerActions";
import { Explain, WithExplain } from "../../explain/Explain";
import { ExaBadge } from "../../explain/ExaBadge";

export function OfferPage() {
  const { offerId = "" } = useParams();
  const id = Number(offerId);
  const user = useUser();
  const offers = useOffers();
  const offer = offers.data?.find((o) => o.offer_id === id) ?? null;

  if (offers.isLoading)
    return (
      <div className="page">
        <Loading rows={10} />
      </div>
    );
  if (offers.isError)
    return (
      <div className="page">
        <ErrorState error={offers.error} retry={() => offers.refetch()} />
      </div>
    );
  if (!offer)
    return (
      <div className="page">
        <Empty title={`Offer ${offerId} is not in your view`} action={<Link to="/pipeline" className="btn btn-quiet btn-sm"><ArrowLeft aria-hidden="true" />Back to pipeline</Link>}>
          It may belong to another relationship manager, or a new analysis run replaced it.
        </Empty>
      </div>
    );

  const negotiable = user.role === "rm" && ["OFFERED", "NEGOTIATING", "ESCALATED"].includes(offer.stage);

  return (
    <div className="page">
      <PageHeader
        crumbs={[
          { to: user.role === "loanops" ? "/queue" : "/pipeline", label: user.role === "loanops" ? "Approval queue" : user.role === "rm" ? "My pipeline" : "Offer pipeline" },
          { label: `Offer ${offer.offer_id}` },
        ]}
        title={offer.legal_name}
        lede={
          <>
            <code>{offer.cif_id}</code> · case <code>{offer.app_id}</code> · run <code>{offer.run_id}</code> · RM <code>{offer.rm_id}</code>
          </>
        }
        actions={
          can(user.role, "report") && (
            <Link className="btn btn-quiet" to={`/companies/${offer.cif_id}/report`}>
              <FileSearch aria-hidden="true" />
              Exasol report
            </Link>
          )
        }
      >
        <div className="offer-strip">
          <Stage s={offer.stage} />
          <DecisionBadge d={offer.decision} />
          <span>
            Grade <Grade g={offer.grade} />
          </span>
          <span className="muted">
            PD <span className="num">{pctFromRatio(offer.pd)}</span>
          </span>
          <span className="muted">
            Rank <span className="num">{offer.rank_no ?? "–"}</span>
          </span>
        </div>
      </PageHeader>

      <div className="grid-main-side">
        <div className="stack">
          {negotiable ? <Negotiate offer={offer} /> : <ReadOnlyTerms offer={offer} />}
          {user.role === "loanops" && <CheckerActions offer={offer} />}
        </div>
        <Trail offerId={offer.offer_id} />
      </div>
    </div>
  );
}

function ReadOnlyTerms({ offer }: { offer: Offer }) {
  return (
    <Panel title="Terms" icon={Receipt} aside={<SourceTag source="exasol" />}>
      <table className="terms-table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col" className="r">Exasol offer</th>
            <th scope="col" className="r">Limit</th>
            <th scope="col" className="r">Agreed</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Amount</th>
            <td className="r num">{rupeesShort(offer.offer_amount)}</td>
            <td className="r num">{rupeesShort(offer.max_amount)} <span className="small muted">max</span></td>
            <td className="r num strong">{rupeesShort(offer.agreed_amount)}</td>
          </tr>
          <tr>
            <th scope="row">ROI</th>
            <td className="r num">{pct(offer.offer_roi)}</td>
            <td className="r num">{pct(offer.floor_roi)} <span className="small muted">floor</span></td>
            <td className="r num strong">{pct(offer.agreed_roi)}</td>
          </tr>
          <tr>
            <th scope="row">Tenure</th>
            <td className="r num">{offer.offer_tenure ?? "–"} mo</td>
            <td className="r num">{offer.max_tenure ?? "–"} mo <span className="small muted">max</span></td>
            <td className="r num strong">{offer.agreed_tenure != null ? `${offer.agreed_tenure} mo` : "–"}</td>
          </tr>
        </tbody>
      </table>
      {offer.agreed_amount != null && <LimitCheck offer={offer} />}
    </Panel>
  );
}

function LimitCheck({ offer }: { offer: Offer }) {
  const breaches: string[] = [];
  if ((offer.agreed_amount ?? 0) > (offer.max_amount ?? Infinity)) breaches.push("amount above maximum");
  if ((offer.agreed_roi ?? Infinity) < (offer.floor_roi ?? 0)) breaches.push("ROI below floor");
  if ((offer.agreed_tenure ?? 0) > (offer.max_tenure ?? Infinity)) breaches.push("tenure above maximum");
  return breaches.length ? (
    <p className="callout callout-refer top-gap">Agreed terms are outside the limit ({breaches.join(", ")}). Needs a checker's decision.</p>
  ) : (
    <p className="callout callout-approve top-gap">Agreed terms are within the negotiation limit.</p>
  );
}

interface Bound {
  min: number;
  max: number;
  step: number;
  offer: number;
  limit: number;
  /** "max": values above limit breach it; "min": values below limit breach it */
  side: "max" | "min";
}

function BoundedSlider({
  id,
  label,
  value,
  onChange,
  b,
  fmt,
  unit,
  scale = 1,
}: {
  scale?: number;
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  b: Bound;
  fmt: (v: number) => string;
  unit: string;
}) {
  const pos = (x: number) => `${((x - b.min) / (b.max - b.min)) * 100}%`;
  const breach = b.side === "max" ? value > b.limit : value < b.limit;
  return (
    <div className={`bslider bslider-side-${b.side} ${breach ? "is-breach" : ""}`}>
      <div className="bslider-head">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        <span className="bslider-value">
          <input
            className="input input-num"
            type="number"
            step={b.step / scale}
            min={b.min / scale}
            max={b.max / scale}
            value={Math.round((value / scale) * 100) / 100}
            onChange={(e) => onChange(Number(e.target.value) * scale)}
            aria-label={`${label} in ${unit}`}
          />
          <span className="muted small">{unit}</span>
        </span>
      </div>
      <div className="bslider-track">
        <span
          className="bslider-out"
          aria-hidden="true"
          style={b.side === "max" ? { left: pos(b.limit), right: 0 } : { left: 0, width: pos(b.limit) }}
        />
        <span className="bslider-mark bslider-offer" style={{ left: pos(b.offer) }} aria-hidden="true">
          <span>offer {fmt(b.offer)}</span>
        </span>
        <span className="bslider-mark bslider-limit" style={{ left: pos(b.limit) }} aria-hidden="true">
          <span>
            {b.side === "max" ? "max" : "floor"} {fmt(b.limit)}
          </span>
        </span>
        <input
          id={id}
          type="range"
          className="range"
          min={b.min}
          max={b.max}
          step={b.step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-valuetext={`${fmt(value)}${breach ? ", outside the limit" : ""}`}
        />
      </div>
      <p className="bslider-now">
        <span className="num strong">{fmt(value)}</span>
        {breach && <span className="text-decline small"> outside the limit</span>}
      </p>
    </div>
  );
}

function Negotiate({ offer }: { offer: Offer }) {
  const start = {
    amount: offer.agreed_amount ?? offer.offer_amount ?? 0,
    roi: offer.agreed_roi ?? offer.offer_roi ?? 0,
    tenure: offer.agreed_tenure ?? offer.offer_tenure ?? 12,
  };
  const [t, setT] = useState(start);
  const [note, setNote] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const act = useOfferAction(offer.offer_id);

  const bounds = useMemo(() => {
    const oa = offer.offer_amount ?? 0;
    const ma = offer.max_amount ?? oa;
    const or = offer.offer_roi ?? 10;
    const fr = offer.floor_roi ?? or;
    const ot = offer.offer_tenure ?? 36;
    const mt = offer.max_tenure ?? ot;
    return {
      amount: { min: Math.max(500000, Math.round((oa * 0.4) / 500000) * 500000), max: Math.ceil((ma * 1.3) / 500000) * 500000, step: 500000, offer: oa, limit: ma, side: "max" } as Bound,
      roi: { min: Math.floor((fr - 1) * 4) / 4, max: Math.ceil((or + 1) * 4) / 4, step: 0.05, offer: or, limit: fr, side: "min" } as Bound,
      tenure: { min: 12, max: mt + 24, step: 6, offer: ot, limit: mt, side: "max" } as Bound,
    };
  }, [offer]);

  useEffect(() => {
    const ctl = new AbortController();
    setQuoting(true);
    const h = setTimeout(() => {
      quoteOffer(offer.offer_id, t, ctl.signal)
        .then((q) => {
          setQuote(q);
          setQErr(null);
        })
        .catch((e) => {
          if ((e as Error).name !== "AbortError") setQErr((e as Error).message);
        })
        .finally(() => !ctl.signal.aborted && setQuoting(false));
    }, 180);
    return () => {
      clearTimeout(h);
      ctl.abort();
    };
  }, [offer.offer_id, t]);

  const within = quote?.within_limit ?? true;

  return (
    <Panel
      title={<WithExplain id="negotiation-limit">Negotiate</WithExplain>}
      icon={Handshake}
      aside={
        <>
          <span className="small muted">Exasol checks every change against the limit</span>{" "}
          <ExaBadge what="Quote query" detail="as your Exasol user" term="raroc" />
        </>
      }
    >
      <div className="negotiate">
        <div className="sliders">
          <BoundedSlider id="amt" label="Amount" unit="₹ lakh" scale={100000} value={t.amount} onChange={(v) => setT({ ...t, amount: v })} b={bounds.amount} fmt={rupeesShort} />
          <BoundedSlider id="roi" label="ROI" unit="% a year" value={t.roi} onChange={(v) => setT({ ...t, roi: Math.round(v * 100) / 100 })} b={bounds.roi} fmt={(v) => pct(v)} />
          <BoundedSlider id="ten" label="Tenure" unit="months" value={t.tenure} onChange={(v) => setT({ ...t, tenure: v })} b={bounds.tenure} fmt={(v) => `${v} mo`} />
        </div>

        <div className={`quote ${quote ? (within ? "quote-ok" : "quote-out") : ""} ${quoting ? "is-refreshing" : ""}`} aria-live="polite">
          <div className="quote-head">
            <span className="quote-verdict">{quote ? (within ? "Within limit" : "Outside limit") : "Checking…"}</span>
            <SourceTag source="exasol" compact />
          </div>
          {qErr && <p className="form-error">{qErr}</p>}
          {quote && (
            <>
              <KV
                cols={2}
                items={[
                  ["EMI", <span className="num strong">{rupees(quote.emi)}</span>],
                  [<WithExplain id="raroc">RAROC</WithExplain>, <span className="num strong">{pct(quote.raroc, 1)}</span>],
                ]}
              />
              <ul className="quote-reasons">
                {quote.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </>
          )}
        </div>

        <form
          className="propose"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate({ action: "propose", body: { ...t, note } }, { onSuccess: () => setNote("") });
          }}
        >
          <label className="field">
            <span className="field-label">Note for the trail</span>
            <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What the customer wants changed and why these terms" />
          </label>
          <div className="propose-row">
            <button type="button" className="btn btn-quiet" onClick={() => setT({ amount: bounds.amount.offer, roi: bounds.roi.offer, tenure: bounds.tenure.offer })}>
              <RotateCcw aria-hidden="true" />
              Reset to offer
            </button>
            <button className={`btn ${within ? "btn-primary" : "btn-warn"}`} disabled={act.isPending}>
              {within ? <Send aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
              {act.isPending ? "Saving…" : within ? "Propose these terms" : "Propose and escalate"}
            </button>
            <Explain id="maker-checker" label="Propose" />
          </div>
          {!within && <p className="small muted">Terms outside the limit go to loan operations as escalated.</p>}
          {act.isError && <p className="form-error" role="alert">{(act.error as Error).message}</p>}
          {act.isSuccess && (
            <p className="callout callout-approve" role="status">
              Proposed. Stage is now {act.data.stage.toLowerCase()}.
            </p>
          )}
        </form>
      </div>
    </Panel>
  );
}

function Trail({ offerId }: { offerId: number }) {
  const q = useOfferEvents(offerId);
  return (
    <Panel title="Negotiation trail" icon={History} aside={<SourceTag source="bank.postgres" compact />}>
      {q.isLoading && <Loading rows={4} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && q.data.length === 0 && <p className="muted">No events yet. Exasol's offer stands as made.</p>}
      {q.data && q.data.length > 0 && (
        <ol className="trail">
          {q.data.map((e) => (
            <li key={e.event_id} className={`trail-item ta-${e.action.toLowerCase()}`}>
              <p className="trail-head">
                <code className="action">{e.action}</code> <span className="muted">by</span> <code>{e.actor}</code>
                <span className="trail-at muted">{dateTime(e.at)}</span>
              </p>
              {e.amount != null && (
                <p className="trail-terms num">
                  {rupeesShort(e.amount)} · {pct(e.roi)} · {num(e.tenure)} mo
                </p>
              )}
              {e.note && <p className="trail-note">{e.note}</p>}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
