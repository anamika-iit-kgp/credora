import { useState } from "react";
import { DatabaseZap, Info, Layers, PackagePlus, RefreshCw, TriangleAlert, Workflow, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useOverview, useStartGenerate } from "../../api/hooks";
import type { GenerateRequest, SourceId } from "../../api/types";
import { JobProgress } from "../../components/JobProgress";
import { SourceTag } from "../../components/SourceTag";
import { Dialog, PageHeader, Panel, Segmented } from "../../components/ui";
import { dateTime, num } from "../../lib/format";
import { usePersistentJob } from "../../lib/usePersistentJob";
import { Explain } from "../../explain/Explain";

type Mode = GenerateRequest["mode"];
const MIN_ADD = 100;
const MAX_ADD = 5000;

const CREATES: [string, string, SourceId][] = [
  ["Partners (directors, partners, promoters)", "2–5 per company", "bank.mysql"],
  ["Company current accounts and transactions", "12–24 months each", "bank.oracle"],
  ["Partners' savings accounts at Sapphire Bank", "about 30% of partners", "bank.oracle"],
  ["Credit need on file (indicative amount, tenure, purpose)", "1 per company", "bank.postgres"],
  ["Past loans with outcomes, to train the model", "a few thousand", "bank.postgres"],
  ["CIBIL consumer report per partner", "1 per partner", "api.cibil"],
  ["CIBIL commercial report per company (CMR rank)", "1 per company", "api.cibil"],
  ["GST registration and monthly returns", "2–10 years per company", "api.gstn"],
  ["Partners' accounts at other banks", "1–3 per partner, 12 months", "api.aa"],
];

export function DataGenerationPage() {
  const ov = useOverview();
  const start = useStartGenerate();
  const qc = useQueryClient();
  const [jobId, setJobId] = usePersistentJob("generate");
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("replace");
  const [seed, setSeed] = useState("");
  const [count, setCount] = useState("1000");
  const append = mode === "append";
  const seedNum = seed.trim() === "" ? null : Number(seed);
  const seedBad = seedNum !== null && (!Number.isInteger(seedNum) || seedNum < 0);
  const companies = Number(count) || 0;
  const countBad = append && (!Number.isInteger(companies) || companies < MIN_ADD || companies > MAX_ADD);
  const current = ov.data?.counts.companies;

  async function confirm() {
    const r = await start.mutateAsync({ seed: seedNum, mode, companies: append ? companies : 1000 });
    setOpen(false);
    setJobId(r.job_id);
  }

  const rows: [string, string, SourceId][] = [
    ["Companies (corporate current-account customers)", append ? `${num(companies)} new` : "1,000", "bank.mysql"],
    ...CREATES.map(([w, n, s]): [string, string, SourceId] => (append && s === "bank.postgres" && w.startsWith("Past loans") ? [w, "kept as they are", s] : [w, n, s])),
  ];

  const seedNote =
    seedNum !== null ? (
      <>
        Seed <span className="num">{seedNum}</span>.
      </>
    ) : (
      "A random seed will be chosen and shown here when the run starts."
    );

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: "Administration" }, { label: "Data generation" }]}
        title="Data generation"
        lede="Create a fresh synthetic data set, or add companies to the current one, and write each part to the system where it would really live."
      />

      {jobId && (
        <Panel title="Progress" icon={Workflow} aside={<button className="btn btn-quiet btn-sm" onClick={() => setJobId(null)}><X aria-hidden="true" />Clear</button>}>
          <JobProgress
            jobId={jobId}
            title="Generating mock data"
            onFinish={() => {
              void qc.invalidateQueries();
            }}
          />
        </Panel>
      )}
      <div className="grid-main-side">
        <Panel title={append ? "What adding companies creates" : "What a run creates"} icon={Layers} flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">What</th>
                  <th scope="col">How much</th>
                  <th scope="col">Stored in</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([w, n, s]) => (
                  <tr key={w}>
                    <td>{w}</td>
                    <td className="nowrap">{n}</td>
                    <td>
                      <SourceTag source={s} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <div className="stack">
          <Panel title="Generate" icon={DatabaseZap}>
            <div className="stack-sm">
              <p className="muted">
                Current data set{" "}
                {ov.data?.last_generation ? (
                  <>
                    seed <span className="num">{ov.data.last_generation.seed}</span>, {dateTime(ov.data.last_generation.generated_at)}
                    {current !== undefined && (
                      <>
                        , <span className="num">{num(current)}</span> companies
                      </>
                    )}
                  </>
                ) : (
                  "none"
                )}
              </p>
              <Segmented
                label="Generation mode"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "replace", label: "Replace all data" },
                  { value: "append", label: "Add more companies" },
                ]}
              />
              {append && (
                <label className="field">
                  <span className="field-label">Companies to add</span>
                  <input
                    className="input num"
                    inputMode="numeric"
                    value={count}
                    onChange={(e) => setCount(e.target.value.replace(/[^\d]/g, ""))}
                    aria-describedby="count-help"
                    aria-invalid={countBad}
                  />
                  <span id="count-help" className="field-help">
                    {num(MIN_ADD)} to {num(MAX_ADD)}. Existing data stays.
                  </span>
                </label>
              )}
              <label className="field">
                <span className="field-label">Seed (optional)</span>
                <input
                  className="input num"
                  inputMode="numeric"
                  placeholder="Random"
                  value={seed}
                  onChange={(e) => setSeed(e.target.value.replace(/[^\d]/g, ""))}
                  aria-describedby="seed-help"
                  aria-invalid={seedBad}
                />
                <span id="seed-help" className="field-help">
                  {append ? "Seeds the new companies only." : "The same seed recreates exactly the same data."}
                </span>
              </label>
              {append ? (
                <button className="btn btn-primary" onClick={() => setOpen(true)} disabled={seedBad || countBad || start.isPending}>
                  <PackagePlus aria-hidden="true" />
                  Add companies
                </button>
              ) : (
                <button className="btn btn-danger" onClick={() => setOpen(true)} disabled={seedBad || start.isPending}>
                  <DatabaseZap aria-hidden="true" />
                  Generate mock data
                </button>
              )}
              <Explain id="mock-data" label="Generate mock data" />
            </div>
          </Panel>
        </div>
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        tone={append ? "default" : "danger"}
        title={append ? `Add ${num(companies)} companies?` : "Generate new mock data?"}
        footer={
          <>
            <button className="btn btn-quiet" onClick={() => setOpen(false)} autoFocus>
              Cancel
            </button>
            {append ? (
              <button className="btn btn-primary" onClick={() => void confirm()} disabled={start.isPending}>
                <PackagePlus aria-hidden="true" />
                {start.isPending ? "Starting…" : "Add companies"}
              </button>
            ) : (
              <button className="btn btn-danger" onClick={() => void confirm()} disabled={start.isPending}>
                <RefreshCw aria-hidden="true" />
                {start.isPending ? "Starting…" : "Clear and generate"}
              </button>
            )}
          </>
        }
      >
        {append ? (
          <>
            <p className="dialog-lead dialog-lead-info">
              <Info className="ic" aria-hidden="true" />
              This adds {num(companies)} new companies with their partners, accounts, CIBIL, GST and AA data. Existing data stays.
            </p>
            <div className="dialog-cols">
              <div>
                <p className="dialog-sub">Kept</p>
                <ul>
                  <li>
                    Every existing company
                    {current !== undefined && (
                      <>
                        {" "}
                        (<span className="num">{num(current)}</span>)
                      </>
                    )}
                    , with its partners and accounts
                  </li>
                  <li>CIBIL, GSTN and Account Aggregator records</li>
                  <li>Past loans, offers and earlier analysis runs</li>
                </ul>
              </div>
              <div>
                <p className="dialog-sub">Added</p>
                <ul>
                  <li>{num(companies)} companies with 2–5 partners each, spread over the 12 RMs</li>
                  <li>CIBIL reports for every new company and partner</li>
                  <li>2–10 years of GST returns per new company</li>
                  <li>Account Aggregator accounts for every new partner</li>
                </ul>
              </div>
            </div>
            <p className="muted">{seedNote} Run the analysis again afterwards so the new companies are scored.</p>
          </>
        ) : (
          <>
            <p className="dialog-lead">
              <TriangleAlert className="ic" aria-hidden="true" />
              Generating new mock data will clear all the existing data.
            </p>
            <div className="dialog-cols">
              <div>
                <p className="dialog-sub">Cleared</p>
                <ul>
                  <li>Sapphire Bank data in Oracle, MySQL and PostgreSQL</li>
                  <li>CIBIL, GSTN and Account Aggregator records</li>
                  <li>All Exasol results, meaning decisions, ranks, offers, run history and staging</li>
                </ul>
              </div>
              <div>
                <p className="dialog-sub">Created</p>
                <ul>
                  <li>1,000 companies with 2–5 partners each</li>
                  <li>CIBIL reports for every company and partner</li>
                  <li>2–10 years of GST returns per company</li>
                  <li>Account Aggregator accounts for every partner</li>
                </ul>
              </div>
            </div>
            <p className="muted">
              {seedNote} This cannot be undone. Run the analysis again afterwards.
            </p>
          </>
        )}
        {start.isError && (
          <p className="form-error" role="alert">
            {(start.error as Error).message}
          </p>
        )}
      </Dialog>
    </div>
  );
}
