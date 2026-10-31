import { useEffect, useRef } from "react";
import { Ban, Check, Circle, LoaderCircle, X } from "lucide-react";
import { useJob } from "../api/hooks";
import type { Job } from "../api/types";
import { duration } from "../lib/format";
import { ErrorState } from "./ui";
import { Explain } from "../explain/Explain";
import { useExplain } from "../explain/ExplainContext";
import { stepObject } from "../explain/steps";

/** Explain mode: the Exasol object a step works on, e.g. "Python SET UDF CREDORA.PD_SCORE → CREDORA.SCORES". */
function StepObj({ name }: { name: string }) {
  const { on } = useExplain();
  const o = on ? stepObject(name) : null;
  if (!o) return null;
  return (
    <span className="job-step-obj">
      <code>{o.object}</code>
      <Explain id={o.term} />
    </span>
  );
}

const STATUS_WORD: Record<string, string> = {
  pending: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

function StepIcon({ status }: { status: string }) {
  // Keyed by status so the new icon pops in when a step changes state.
  if (status === "done") return <Check key="d" />;
  if (status === "running") return <LoaderCircle key="r" />;
  if (status === "failed") return <X key="f" />;
  if (status === "skipped") return <Ban key="s" />;
  return <Circle key="p" style={{ opacity: 0 }} />;
}

export function JobProgress({ jobId, onFinish, title }: { jobId: string; onFinish?: (j: Job) => void; title: string }) {
  const q = useJob(jobId);
  const fired = useRef(false);
  const job = q.data;

  useEffect(() => {
    if (job && job.status !== "running" && !fired.current) {
      fired.current = true;
      onFinish?.(job);
    }
  }, [job, onFinish]);

  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!job)
    return (
      <div className="job-pending" aria-busy="true">
        <LoaderCircle aria-hidden="true" />
        Starting job…
      </div>
    );

  const elapsed = (job.finished_at ? new Date(job.finished_at).getTime() : Date.now()) - new Date(job.started_at).getTime();
  return (
    <div className={`job job-${job.status}`}>
      <div className="job-head">
        <div>
          <p className="job-title">
            {title}
          </p>
          <p className="job-meta">
            Job <code>{job.job_id}</code> · {job.status === "running" ? "running for" : job.status === "done" ? "finished in" : "failed after"}{" "}
            <span className="num">{duration(elapsed)}</span>
          </p>
        </div>
        <span className="job-pct num" aria-hidden="true">
          {job.progress}
          <small>%</small>
        </span>
      </div>
      <div
        className="job-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={job.progress}
        aria-label={`${title} progress`}
      >
        <span style={{ transform: `scaleX(${Math.max(0.01, job.progress / 100)})` }} />
      </div>
      <ol className="job-steps" aria-live="polite">
        {job.steps.map((s, i) => (
          <li key={i} className={`job-step is-${s.status}`}>
            <span className="job-step-icon" aria-hidden="true">
              <StepIcon status={s.status} />
            </span>
            <span className="job-step-name">
              {s.name}
              <StepObj name={s.name} />
            </span>
            <span className="job-step-detail">{s.detail ?? ""}</span>
            <span className="job-step-status">{STATUS_WORD[s.status] ?? s.status}</span>
          </li>
        ))}
      </ol>
      {job.error && <p className="job-error" role="alert">{job.error}</p>}
    </div>
  );
}
