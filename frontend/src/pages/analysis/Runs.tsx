import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, Download, History, LoaderCircle, Play, Send, Workflow, X } from "lucide-react";
import { useRuns, useStartAnalysis } from "../../api/hooks";
import type { Run } from "../../api/types";
import { usePublishRun } from "../../api/workflow";
import { useUser } from "../../auth/AuthContext";
import { JobProgress } from "../../components/JobProgress";
import { Dialog, Empty, ErrorState, Loading, MixBar, PageHeader, Panel } from "../../components/ui";
import { csvName, downloadCsv, type CsvColumn } from "../../lib/csv";
import { dateTime, duration, num } from "../../lib/format";
import { can } from "../../lib/roles";
import { usePersistentJob } from "../../lib/usePersistentJob";
import { Explain } from "../../explain/Explain";

export function RunsPage() {
  const user = useUser();
  const runs = useRuns();
  const start = useStartAnalysis();
  const qc = useQueryClient();
  const [jobId, setJobId] = usePersistentJob("analysis");
  const allowed = can(user.role, "runAnalysis");
  const [publishing, setPublishing] = useState<Run | null>(null);

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: "Exasol" }, { label: "Analysis runs" }]}
        title="Analysis runs"
        lede={
          <>
            Each run calls <code>CREDORA.RUN_ANALYSIS()</code> once. Exasol reads the bank, calls the three 3rd party APIs, scores, decides and
            ranks every corporate customer. A new run is a draft until the data scientist reviews it and publishes it to loan
            operations (<code>CREDORA.RUN_PUBLISH</code>). The latest published run is the official one.
          </>
        }
        actions={
          allowed && (
            <>
              <Explain id="run-analysis" label="Run analysis" />
              <button
                className="btn btn-primary"
                disabled={start.isPending}
                onClick={async () => {
                  const r = await start.mutateAsync();
                  setJobId(r.job_id);
                }}
              >
                {start.isPending ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
                {start.isPending ? "Starting…" : "Run analysis"}
              </button>
            </>
          )
        }
      />
      {start.isError && <ErrorState error={start.error} />}
      {jobId && (
        <Panel title="Current run" icon={Workflow} aside={<button className="btn btn-quiet btn-sm" onClick={() => setJobId(null)}><X aria-hidden="true" />Clear</button>}>
          <JobProgress
            jobId={jobId}
            title="Running CREDORA.RUN_ANALYSIS()"
            onFinish={() => {
              void qc.invalidateQueries();
            }}
          />
        </Panel>
      )}

      {runs.isLoading && <Loading />}
      {runs.isError && <ErrorState error={runs.error} retry={() => runs.refetch()} />}
      {runs.data && runs.data.length === 0 && (
        <Empty title="No runs yet" icon={Activity}>
          {allowed ? "Run the analysis to score the current data set." : "The data scientist runs the analysis and publishes the results."}
        </Empty>
      )}
      {runs.data && runs.data.length > 0 && <RunList runs={runs.data} onPublish={setPublishing} />}
      <PublishDialog run={publishing} onClose={() => setPublishing(null)} />
    </div>
  );
}

/** Draft or published: published runs are official for loan operations and relationship managers. */
function PublishState({ r }: { r: Run }) {
  if (r.status !== "done") return null;
  if (r.published === false) return <span className="tag tag-draft">Draft</span>;
  return (
    <span className="tag tag-published" title={r.published_by ? `Published by ${r.published_by}, ${dateTime(r.published_at)}` : undefined}>
      Published
    </span>
  );
}

function PublishDialog({ run, onClose }: { run: Run | null; onClose: () => void }) {
  const [note, setNote] = useState("");
  const m = usePublishRun();
  if (!run) return null;
  const done = () => {
    m.reset();
    setNote("");
    onClose();
  };
  return (
    <Dialog
      open={!!run}
      onClose={done}
      title={`Publish run ${run.run_id} to loan operations?`}
      footer={
        <>
          <button className="btn btn-quiet" onClick={done}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={m.isPending} onClick={() => m.mutate({ runId: run.run_id, note: note.trim() }, { onSuccess: done })}>
            <Send aria-hidden="true" />
            {m.isPending ? "Publishing…" : "Publish to loan operations"}
          </button>
        </>
      }
    >
      <p>
        The run becomes the official one. Loan operations sees it in Decisions and the Top 50 and assigns its companies to relationship
        managers, its pre-approved offers go to the CRM, and Exasol&apos;s <code>V_LATEST_*</code> views and the semantic view switch to it.
      </p>
      <MixBar mix={{ APPROVE: run.approve, REFER: run.refer, DECLINE: run.decline }} label={`Run ${run.run_id}`} />
      <label className="field top-gap">
        <span className="field-label">Note for loan operations (optional)</span>
        <textarea className="input" rows={3} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed in this run" />
      </label>
      {m.isError && (
        <p className="form-error" role="alert">
          {(m.error as Error).message}
        </p>
      )}
    </Dialog>
  );
}

const STAGE_TONE = (name: string) =>
  /fetch/i.test(name) ? "api" : /read bank/i.test(name) ? "bank" : /export/i.test(name) ? "bank" : "exa";

function StageBar({ r, longest }: { r: Run; longest: number }) {
  const total = r.stages.reduce((a, s) => a + s.ms, 0);
  return (
    <div className="stagebar" style={{ width: `${(total / longest) * 100}%` }} role="img" aria-label={`Stage timings for ${r.run_id}, ${duration(total)} in total`}>
      {r.stages.map((s) => (
        <span key={s.name} className={`stagebar-seg st-${STAGE_TONE(s.name)}`} style={{ flexGrow: s.ms }} title={`${s.name}: ${duration(s.ms)}`} />
      ))}
    </div>
  );
}

const runMs = (r: Run) => r.stages.reduce((a, s) => a + s.ms, 0);

/** The Earlier runs table as CSV: the same columns, By stage as "stage: ms" pairs. */
const RUN_CSV: CsvColumn<Run>[] = [
  { header: "Run", value: (r) => r.run_id },
  { header: "Started", value: (r) => r.started_at },
  { header: "By", value: (r) => r.started_by },
  { header: "Model", value: (r) => r.model_version },
  { header: "Approve", value: (r) => r.approve },
  { header: "Refer", value: (r) => r.refer },
  { header: "Decline", value: (r) => r.decline },
  { header: "Time (ms)", value: runMs },
  { header: "By stage (ms)", value: (r) => r.stages.map((s) => `${s.name}: ${s.ms}`).join("; ") },
  { header: "Published", value: (r) => (r.status !== "done" ? "" : r.published === false ? "Draft" : "Published") },
  { header: "Published by", value: (r) => r.published_by ?? "" },
  { header: "Published at", value: (r) => r.published_at ?? "" },
];

function PublishButton({ r, onPublish }: { r: Run; onPublish: (r: Run) => void }) {
  const user = useUser();
  if (!can(user.role, "publish") || r.status !== "done" || r.published !== false) return null;
  return (
    <>
      <button className="btn btn-primary btn-sm" onClick={() => onPublish(r)}>
        <Send aria-hidden="true" />
        Publish to loan operations
      </button>
      <Explain id="run-publish" label="Publish" />
    </>
  );
}

function RunList({ runs, onPublish }: { runs: Run[]; onPublish: (r: Run) => void }) {
  const longest = Math.max(...runs.map((r) => r.stages.reduce((a, s) => a + s.ms, 0)));
  const [latest, ...older] = runs;
  const total = latest.stages.reduce((a, s) => a + s.ms, 0);
  return (
    <>
      <Panel
        title={
          <>
            Latest run <code>{latest.run_id}</code> <PublishState r={latest} />
          </>
        }
        aside={
          <span className="run-aside">
            <span className="muted">
              {dateTime(latest.started_at)} · by <code>{latest.started_by}</code> · model <code>{latest.model_version}</code> ·{" "}
              <span className="num">{num(latest.companies)}</span> companies
              {latest.published_by && (
                <>
                  {" "}
                  · published by <code>{latest.published_by}</code>
                </>
              )}
            </span>
            <PublishButton r={latest} onPublish={onPublish} />
          </span>
        }
      >
        <div className="run">
          <div className="run-mix">
            <MixBar mix={{ APPROVE: latest.approve, REFER: latest.refer, DECLINE: latest.decline }} label={`Run ${latest.run_id}`} />
          </div>
          <div className="run-time">
            <p className="small">
              <span className="strong num">{duration(total)}</span> <span className="muted">inside Exasol, by stage</span>
            </p>
            <StageBar r={latest} longest={total} />
            <table className="stagetable">
              <tbody>
                {latest.stages.map((s) => (
                  <tr key={s.name}>
                    <th scope="row">
                      <span className={`swatch st-${STAGE_TONE(s.name)}`} aria-hidden="true" />
                      {s.name}
                    </th>
                    <td className="r num">{duration(s.ms)}</td>
                    <td className="r num muted">{Math.round((s.ms / total) * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">
              <span className="swatch st-bank" aria-hidden="true" />
              reads and writes Sapphire Bank <span className="swatch st-api" aria-hidden="true" />
              calls the mock APIs <span className="swatch st-exa" aria-hidden="true" />
              computes in Exasol
            </p>
          </div>
        </div>
      </Panel>
      {older.length > 0 && (
        <Panel
          title="Earlier runs"
          icon={History}
          flush
          aside={
            <button className="btn btn-quiet btn-sm" onClick={() => downloadCsv(csvName("analysis-runs"), RUN_CSV, older)} title="Download the rows below as a CSV file">
              <Download aria-hidden="true" />
              Export CSV
            </button>
          }
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Started</th>
                  <th scope="col">By</th>
                  <th scope="col">Model</th>
                  <th scope="col" className="r">Approve</th>
                  <th scope="col" className="r">Refer</th>
                  <th scope="col" className="r">Decline</th>
                  <th scope="col" className="r">Time</th>
                  <th scope="col" style={{ width: "26%" }}>By stage</th>
                  <th scope="col">Published</th>
                </tr>
              </thead>
              <tbody>
                {older.map((r) => (
                  <tr key={r.run_id}>
                    <td>
                      <code>{r.run_id}</code>
                    </td>
                    <td className="nowrap">{dateTime(r.started_at)}</td>
                    <td>
                      <code>{r.started_by}</code>
                    </td>
                    <td>
                      <code>{r.model_version}</code>
                    </td>
                    <td className="r num text-approve">{num(r.approve)}</td>
                    <td className="r num text-refer">{num(r.refer)}</td>
                    <td className="r num text-decline">{num(r.decline)}</td>
                    <td className="r num">{duration(r.stages.reduce((a, s) => a + s.ms, 0))}</td>
                    <td>
                      <StageBar r={r} longest={longest} />
                    </td>
                    <td className="nowrap">
                      <PublishState r={r} /> <PublishButton r={r} onPublish={onPublish} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}
