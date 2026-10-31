"""One generation run: clear every database (replace) or read what is already there (append),
synthesize, load, record the truth."""

import csv
import io
import logging
import os
import secrets
import threading
import time
import traceback
import uuid
from datetime import datetime

from . import ids, synth
from .loaders import BankPostgres, MockDb, MySQL, Oracle, now

log = logging.getLogger("generator")

MODES = ("replace", "append")
DEFAULT_COMPANIES = 1000

# (step name, share of total progress). Append starts with "prepare" (read the ids and names in use)
# instead of "clear".
_LOAD_STEPS = [("synthesize", 10), ("oracle", 45), ("mysql", 4), ("postgres", 4), ("mockdb", 27),
               ("truth_export", 2)]
STEPS_BY_MODE = {"replace": [("clear", 8)] + _LOAD_STEPS, "append": [("prepare", 8)] + _LOAD_STEPS}
STEPS = STEPS_BY_MODE["replace"]


def merge_counts(before: dict, added: dict) -> dict:
    """Totals after a run: rows that were there plus rows added, for every table either side names."""
    return {k: before.get(k, 0) + added.get(k, 0) for k in {**before, **added}}


class Job:
    def __init__(self, seed: int | None, mode: str = "replace", companies: int = DEFAULT_COMPANIES):
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        self.job_id = str(uuid.uuid4())
        self.seed = seed if seed is not None else secrets.randbelow(2**31)
        self.mode = mode
        self.companies = companies
        self.step_defs = STEPS_BY_MODE[mode]
        self.status = "running"
        self.started_at = now()
        self.finished_at: datetime | None = None
        self.error: str | None = None
        self.counts: dict = {}      # rows in each table after the run
        self.added: dict = {}       # rows this run wrote to each table
        self.before: dict = {}      # rows in each table before the run (append only)
        self.timings: dict = {}
        self.steps = [{"name": n, "status": "pending", "detail": ""} for n, _ in self.step_defs]
        self._done_weight = 0.0
        self._step_fraction = 0.0
        self._current = 0
        self._lock = threading.Lock()

    @property
    def progress(self) -> int:
        total = sum(w for _, w in self.step_defs)
        if self.status == "done":
            return 100
        current = (self.step_defs[self._current][1] * self._step_fraction
                   if self._current < len(self.step_defs) else 0)
        return min(99, int((self._done_weight + current) / total * 100))

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "job_id": self.job_id, "kind": "generate", "status": self.status,
                "progress": self.progress, "steps": [dict(s) for s in self.steps],
                "started_at": self.started_at, "finished_at": self.finished_at,
                "error": self.error, "seed": self.seed, "mode": self.mode, "companies": self.companies,
                "counts": self.counts or None, "added": self.added or None, "timings": self.timings or None,
            }

    def _update(self, fraction: float, detail: str) -> None:
        with self._lock:
            self._step_fraction = fraction
            self.steps[self._current]["detail"] = detail

    def _run_step(self, index: int, fn):
        name = self.step_defs[index][0]
        with self._lock:
            self._current, self._step_fraction = index, 0.0
            self.steps[index]["status"] = "running"
        t0 = time.perf_counter()
        result = fn()
        elapsed = round(time.perf_counter() - t0, 1)
        with self._lock:
            self.timings[name] = elapsed
            self.steps[index]["status"] = "done"
            if isinstance(result, str):
                self.steps[index]["detail"] = result
            self.steps[index]["detail"] += f" ({elapsed}s)"
            self._done_weight += self.step_defs[index][1]
        log.info("step %s done in %ss: %s", name, elapsed, self.steps[index]["detail"])
        return result

    def run(self) -> None:
        mock = MockDb()
        try:
            self._execute(mock)
            with self._lock:
                self.status = "done"
        except Exception as exc:  # noqa: BLE001 - any failure ends the job and is reported
            log.error("generation failed: %s", traceback.format_exc())
            with self._lock:
                self.status = "failed"
                self.error = f"{type(exc).__name__}: {exc}"
                for step in self.steps:
                    if step["status"] == "running":
                        step["status"] = "failed"
        finally:
            with self._lock:
                self.finished_at = now()
            try:
                mock.save_job(self.record())
            except Exception:  # noqa: BLE001 - mockdb may be the thing that failed
                log.warning("could not record job in mockdb: %s", traceback.format_exc())

    def record(self) -> dict:
        return {"job_id": self.job_id, "seed": self.seed, "status": self.status,
                "started_at": self.started_at, "finished_at": self.finished_at,
                "seconds": round((self.finished_at - self.started_at).total_seconds(), 1),
                "counts": {"rows": self.counts, "added": self.added, "timings": self.timings,
                           "mode": self.mode, "companies": self.companies},
                "error": self.error}

    def _add(self, counts: dict) -> None:
        with self._lock:
            self.added.update(counts)
            self.counts = merge_counts(self.before, self.added)

    def _execute(self, mock: MockDb) -> None:
        oracle, mysql, bank_pg = Oracle(), MySQL(), BankPostgres()
        targets = (("oracle", oracle), ("mysql", mysql), ("postgres", bank_pg), ("mockdb", mock))
        existing: list[synth.Existing] = []

        def clear():
            for k, (label, target) in enumerate(targets):
                self._update(0.25 * k, f"clearing {label}")
                target.prepare()
            return "all tables created if missing and emptied"

        def prepare():
            # Nothing is truncated. Tables are created if missing, so append also works on empty databases.
            for k, (label, target) in enumerate(targets):
                self._update(0.1 * k, f"checking {label}")
                target.prepare(truncate=False)
            self._update(0.4, "reading the ids and names in use")
            ora, cif, los, bureaus = oracle.existing(), mysql.existing(), bank_pg.existing(), mock.existing()
            self.before = {**oracle.counts(), **mysql.counts(), **bank_pg.counts(), **mock.counts()}
            ex = synth.Existing(
                rms=cif["rms"], last_cif=cif["last_cif"], last_partner=cif["last_partner"],
                last_app=los["last_app"], last_txn=ora["last_txn"], has_past_loans=los["has_past_loans"],
                company_names=cif["company_names"], person_names=cif["person_names"],
                pans=cif["pans"] | bureaus["pans"], gstins=cif["gstins"] | bureaus["gstins"],
                account_nos=ora["account_nos"], aa_ids=bureaus["aa_ids"])
            existing.append(ex)
            return (f"{self.before.get('cif.company', 0):,} companies and {self.before.get('cif.partner', 0):,} "
                    f"partners kept, next ids {ids.cif_id(ex.last_cif + 1)}, {ids.partner_id(ex.last_partner + 1)}, "
                    f"{ids.app_id(ex.last_app + 1)}, TXN_ID {ex.last_txn + 1:,}")

        self._run_step(0, clear if self.mode == "replace" else prepare)
        world = self._run_step(1, lambda: synth.build_world(
            self.seed, n_companies=self.companies, existing=existing[0] if existing else None))
        self.steps[1]["detail"] = (f"{len(world.companies):,} new companies, {len(world.partners):,} partners "
                                   + self.steps[1]["detail"])

        def load_oracle():
            accounts = synth.bank_accounts(world)
            # about 36 rows per company-month and 14 per partner SA account-month
            expected = sum(c.bank_months * 36 for c in world.companies) + 170 * (len(accounts) - len(world.companies))
            n = oracle.load(accounts, synth.bank_transactions(world), expected, self._update)
            self._add({"CBS.ACCOUNT": len(accounts), "CBS.TXN": n})
            return f"{len(accounts):,} accounts, {n:,} transactions"

        self._run_step(2, load_oracle)

        def load_mysql():
            companies = [(c.cif_id, c.legal_name, c.constitution, c.pan, c.gstin, c.incorporated_on, c.industry,
                          c.city, c.state, c.rm_id, c.kyc_status, c.kyc_expiry, c.account_opened)
                         for c in world.companies]
            partners = [(p.partner_id, p.cif_id, p.name, p.pan, p.dob, p.gender, p.role, p.share_pct, p.city,
                         int(p.sapphire_customer)) for p in world.partners]
            rms = world.rms if world.new_rms else []
            mysql.load({"rm": rms, "company": companies, "partner": partners})
            self._add({"cif.rm": len(rms), "cif.company": len(companies), "cif.partner": len(partners)})
            return f"{len(rms)} RMs, {len(companies):,} companies, {len(partners):,} partners"

        self._run_step(3, load_mysql)

        def load_postgres():
            bank_pg.load(world.applications, world.past_loans)
            self._add({"los.application": len(world.applications), "los.past_loan": len(world.past_loans),
                       "crm.offer": 0, "crm.offer_event": 0})
            if world.past_loans:
                defaulted = sum(1 for r in world.past_loans if r[-1])
                loans = f"{len(world.past_loans):,} past loans ({defaulted / len(world.past_loans):.1%} defaulted)"
            else:
                loans = "existing past loans kept"
            return f"{len(world.applications):,} credit needs on file, {loans}, CRM {'emptied' if self.mode == 'replace' else 'kept'}"

        self._run_step(4, load_postgres)

        def load_mockdb():
            marker = (now(), self.seed, self.job_id)
            self._update(0.05, "cibil")
            self._add(mock.load("cibil", [
                ("consumer_report", ["pan", "name", "dob", "score", "report_date", "enquiries_6m", "enquiries_12m"],
                 world.consumer_reports),
                ("consumer_account", ["pan", "lender", "acct_type", "opened_on", "sanctioned", "balance", "overdue",
                                      "status", "dpd_36m"], world.consumer_accounts),
                ("commercial_report", ["pan", "name", "cmr_rank", "report_date", "total_exposure", "overdue",
                                       "suit_filed", "wilful_default", "facilities"], world.commercial_reports),
            ], marker))
            self._update(0.2, "gstn")
            self._add(mock.load("gstn", [
                ("registration", ["gstin", "legal_name", "pan", "state", "registered_on", "status"], world.registrations),
                ("filing", ["gstin", "period", "gstr1_turnover", "gstr3b_tax_paid", "due_date", "filed_on"],
                 world.filings()),
            ], marker))
            self._update(0.35, "aa")
            # fi_txn first: streaming the transactions fixes each account's closing balance
            self._add(mock.load("aa", [
                ("fi_txn", ["aa_account_id", "txn_date", "dr_cr", "amount", "narration", "balance_after"],
                 synth.aa_transactions(world)),
                ("fi_account", ["aa_account_id", "owner_pan", "owner_name", "fip", "acct_type", "masked_no",
                                "opened_on", "current_balance"], (a[:8] for a in world.aa_accounts)),
            ], marker))
            self._update(0.95, "truth")
            self._add(mock.load("truth", [("truth", ["cif_id", "true_pd", "would_default"], world.truth())],
                                marker))
            return ", ".join(f"{k} {v:,}" for k, v in self.added.items()
                             if k.split(".")[0] in ("cibil", "gstn", "aa", "truth"))

        self._run_step(5, load_mockdb)
        self._run_step(6, lambda: export_truth(world, self.job_id))


def export_truth(world: synth.World, job_id: str) -> str:
    bucket = os.environ.get("S3_BUCKET")
    if not bucket:
        return "S3_BUCKET not set; truth kept in mockdb only"
    import boto3

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["cif_id", "true_pd", "would_default"])
    writer.writerows(world.truth())
    key = f"truth/{job_id}.csv"
    boto3.client("s3").put_object(Bucket=bucket, Key=key, Body=buf.getvalue().encode(), ContentType="text/csv")
    return f"s3://{bucket}/{key}"
