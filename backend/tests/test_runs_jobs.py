import datetime as dt

from app.crm import stage_for
from app.jobs import apply_run_log, new_run_id, next_version
from app.runs import pick_current, summarize


def log(run, n, status="OK", ms=100, at="2026-10-31T00:22:19.511Z"):
    return {"RUN_ID": run, "STEP_NO": n, "STEP_NAME": f"step {n}", "STATUS": status, "ROWS_OUT": 10, "MS": ms,
            "LOGGED_AT": at}


def test_summarize_runs():
    rows = [log("R3", n, at=f"2026-10-31T00:22:{18 + n:02d}.000Z") for n in range(1, 14)]
    rows += [log("R1", 1, at="2026-10-31T00:15:53.745Z", ms=1764), log("R1", 2, "FAILED", at="2026-10-31T00:15:54Z")]
    rows += [log("R9", 1, at="2026-10-31T09:00:00Z")]
    out = summarize(rows, {"R3": {"APPROVE": 545, "REFER": 168, "DECLINE": 287}}, {"R3": "v1"}, {"R9"},
                    {"R3": "loanops"})
    by = {r["run_id"]: r for r in out}
    assert [r["run_id"] for r in out] == ["R9", "R3", "R1"]
    assert by["R3"]["status"] == "done" and by["R3"]["companies"] == 1000 and by["R3"]["started_by"] == "loanops"
    assert by["R3"]["finished_at"] == "2026-10-31T00:22:31.000Z" and len(by["R3"]["stages"]) == 13
    assert by["R1"]["status"] == "failed" and by["R1"]["started_at"] == "2026-10-31T00:15:51.981Z"
    assert by["R9"]["status"] == "running" and by["R9"]["finished_at"] is None


def test_finished_runs_new_and_legacy():
    from app.runs import finished
    assert finished(13, "Shadow-score with the challenger model")
    assert finished(11, "Rank with PREFERRING skyline")  # a run from before the anomaly and challenger steps
    assert not finished(11, "Decide offer and negotiation limit")  # a new run still on its way
    assert not finished(12, "Rank with PREFERRING skyline")
    legacy = [log("R0", n) for n in range(1, 11)] + [dict(log("R0", 11), STEP_NAME="Rank with PREFERRING skyline")]
    assert summarize(legacy, {}, {}, set(), {})[0]["status"] == "done"
    assert summarize([log("R5", n) for n in range(1, 12)], {}, {}, set(), {})[0]["status"] == "failed"


def test_challenger_version():
    from app.jobs import challenger_version
    assert challenger_version("v7") == "v7-lr"
    assert next_version(["v1", "v1-lr", "v2", "v2-lr"]) == "v3"


def test_pick_current_ignores_runs_older_than_the_data():
    runs = [{"run_id": "R2", "status": "done", "finished_at": "2026-10-31T00:20:00Z"},
            {"run_id": "R3", "status": "done", "finished_at": "2026-10-31T00:22:37Z"},
            {"run_id": "R4", "status": "other", "finished_at": "2026-10-31T00:30:00Z"}]
    assert pick_current(runs, None)["run_id"] == "R3"
    assert pick_current(runs, dt.datetime(2026, 10, 31, 0, 21, tzinfo=dt.timezone.utc))["run_id"] == "R3"
    assert pick_current(runs, dt.datetime(2026, 10, 31, 0, 25, tzinfo=dt.timezone.utc)) is None


def test_new_run_id_uses_ist_minute_and_avoids_collisions():
    t = dt.datetime(2026, 10, 31, 10, 0, tzinfo=dt.timezone.utc)  # 15:30 IST
    assert new_run_id(set(), t) == "R20261031-1530"
    assert new_run_id({"R20261031-1530"}, t) == "R20261031-1530-2"
    assert len(new_run_id({"R20261031-1530", "R20261031-1530-2"}, t)) <= 20


def test_apply_run_log_marks_progress():
    steps = [{"name": str(i), "status": "pending", "detail": None} for i in range(12)]
    done = apply_run_log(steps, [{"STEP_NO": 1, "STATUS": "OK", "ROWS_OUT": 3, "MS": 1688},
                                 {"STEP_NO": 2, "STATUS": "OK", "ROWS_OUT": 1000, "MS": 312}])
    assert done == 2
    assert steps[1]["status"] == "done" and steps[1]["detail"] == "1,000 rows · 0.3 s in Exasol"
    assert steps[2]["status"] == "running" and steps[3]["status"] == "pending"
    assert steps[11]["status"] == "pending"  # CRM export is not a RUN_LOG step
    apply_run_log(steps, [{"STEP_NO": 1, "STATUS": "FAILED", "ROWS_OUT": 0, "MS": 8, "DETAIL": "boom"}])
    assert steps[0]["status"] == "failed" and steps[0]["detail"] == "boom"


def test_next_version_and_stage_for():
    assert next_version([]) == "v1"
    assert next_version(["v1", "v3", "pd-x"]) == "v4"
    assert stage_for("APPROVE") == "OFFERED" and stage_for("REFER") == "OFFERED"
    assert stage_for("DECLINE") == "DECLINED"


def test_failed_step_stops_the_running_marker():
    steps = [{"name": str(i), "status": "pending", "detail": None} for i in range(12)]
    apply_run_log(steps, [{"STEP_NO": 1, "STATUS": "OK", "ROWS_OUT": 3, "MS": 10},
                          {"STEP_NO": 2, "STATUS": "FAILED", "ROWS_OUT": 0, "MS": 8, "DETAIL": "no privilege"}])
    assert [s["status"] for s in steps[:4]] == ["done", "failed", "pending", "pending"]


def test_estimate_steps_from_previous_durations():
    from app.jobs import estimate_steps
    steps = [{"name": str(i), "status": "pending", "detail": None} for i in range(12)]
    p = estimate_steps(steps, [1000] * 11, 2500)
    assert [s["status"] for s in steps[:4]] == ["done", "done", "running", "pending"]
    assert 0 < p < 95
    assert estimate_steps(steps, [1000] * 11, 10 ** 7) == 95
    assert steps[10]["status"] == "running"  # never claims the last step done before Exasol says so
