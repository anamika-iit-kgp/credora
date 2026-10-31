"""Policy maker-checker: datasci proposes, admin approves or rejects; rules enforced by the backend."""

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import jobs, policy
from app.auth import issue_token, make_user
from app.main import app
from app.routes import policy as routes

CONFIG = {"HURDLE_PCT": 15.0, "EBLR_PCT": 8.25, "MAX_GST_SHARE_PCT": 20.0, "MIN_DSCR": 1.25}
RUN = {"run_id": "W0007", "created_by": "datasci", "base_run_id": "R20261031-1530", "model_version": "v3",
       "levers": {"hurdle_pct": 16.0, "eblr_pct": 8.25, "max_gst_share_pct": 22.0},
       "baseline": {"hurdle_pct": 15.0, "eblr_pct": 8.25, "max_gst_share_pct": 20.0},
       "before": {"APPROVE": 545, "REFER": 168, "DECLINE": 287}, "after": {"APPROVE": 512, "REFER": 201, "DECLINE": 287},
       "before_amount": 1.2e10, "after_amount": 1.1e10, "ms": 840}
LEVERS = [{"key": "HURDLE_PCT", "lever": "hurdle_pct", "label": "RAROC hurdle", "old": 15.0, "new": 16.0}]


def proposal(**kw):
    return {"proposal_id": 3, "created_by": "datasci", "run_id": "W0007", "levers": LEVERS, "outcome": {},
            "note": "n", "status": "PENDING", "decided_by": None, "decided_at": None, "decision_note": None,
            "applied_run_id": None, **kw}


def h(role):
    return {"Authorization": f"Bearer {issue_token(make_user(role))}"}


@pytest.fixture
def fake(monkeypatch):
    """Stand-ins for Exasol and the CRM; records what the routes did."""
    calls = {"decide": [], "apply": [], "create": [], "audit": []}
    state = {"config": dict(CONFIG), "proposal": proposal(), "pending": None}
    monkeypatch.setattr(policy, "read_config", lambda user_db: dict(state["config"]))
    monkeypatch.setattr(policy, "get_run", lambda run_id: dict(RUN) if run_id == "W0007" else None)
    monkeypatch.setattr(policy, "pending_for", lambda run_id: state["pending"])
    monkeypatch.setattr(policy, "get_proposal", lambda pid: dict(state["proposal"]) if pid == 3 else None)
    monkeypatch.setattr(policy, "create_proposal",
                        lambda u, r, ch, out, note: calls["create"].append((u, r, ch, note)) or proposal(levers=ch))
    monkeypatch.setattr(policy, "decide",
                        lambda pid, st, u, note: calls["decide"].append((pid, st, u)) or proposal(status=st, decided_by=u))
    monkeypatch.setattr(policy, "start_apply", lambda user, p: calls["apply"].append(p) or
                        jobs.Job(job_id="analysis-x", kind="analysis", steps=[], started_by=user.username,
                                 result={"run_id": "R20261031-1600"}))
    monkeypatch.setattr(jobs, "_guard", lambda *k: None)
    monkeypatch.setattr(routes.crm, "audit", lambda u, a, t, d=None: calls["audit"].append(a))
    return calls, state


c = TestClient(app)


# ---------------------------------------------------------------- pure rules

def test_lever_changes_and_stale_keys():
    ch = policy.lever_changes(RUN["levers"], RUN["baseline"])
    assert [(x["key"], x["old"], x["new"]) for x in ch] == [("HURDLE_PCT", 15.0, 16.0), ("MAX_GST_SHARE_PCT", 20.0, 22.0)]
    assert policy.stale_keys(ch, CONFIG) == []
    assert policy.stale_keys(ch, {**CONFIG, "MAX_GST_SHARE_PCT": 21.0}) == ["MAX_GST_SHARE_PCT"]
    assert policy.lever_changes(RUN["baseline"], RUN["baseline"]) == []
    assert policy.same(8.25, 8.2500) and not policy.same(8.25, 8.3)


def test_config_update_is_one_statement_over_whitelisted_keys():
    sql, params = policy.config_update_sql(LEVERS + [{"key": "MIN_DSCR; DROP", "old": 1, "new": 2}])
    assert sql.startswith("UPDATE CREDORA.CONFIG SET CONFIG_VALUE = CASE CONFIG_KEY WHEN {k0} THEN {v0!d} END")
    assert "WHERE CONFIG_KEY IN ({k0})" in sql and params == {"k0": "HURDLE_PCT", "v0": "16"}
    with pytest.raises(ValueError):
        policy.config_update_sql([])


def test_check_decision_blocks_self_and_decided():
    with pytest.raises(HTTPException) as e:
        policy.check_decision(proposal(created_by="admin"), "admin")
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        policy.check_decision(proposal(status="REJECTED"), "admin")
    assert e.value.status_code == 409 and "read-only" in e.value.detail
    policy.check_decision(proposal(), "admin")  # no error


# ---------------------------------------------------------------- roles

@pytest.mark.parametrize("method,path,body,allowed", [
    ("post", "/api/whatif/runs", {}, {"datasci"}),
    ("get", "/api/whatif/runs", None, {"datasci"}),
    ("get", "/api/policy/proposals", None, {"admin", "datasci"}),
    ("post", "/api/policy/proposals", {"run_id": "W0007", "note": "x"}, {"datasci"}),
    ("post", "/api/policy/proposals/3/approve", {"note": "x"}, {"admin"}),
    ("post", "/api/policy/proposals/3/reject", {"note": "x"}, {"admin"}),
])
def test_roles(method, path, body, allowed):
    for role in ("admin", "datasci", "loanops", "rm"):
        if role in allowed:
            continue
        r = getattr(c, method)(path, headers=h(role), **({"json": body} if body is not None else {}))
        assert r.status_code == 403, (role, path)


# ---------------------------------------------------------------- propose

def test_propose_records_lever_diff_and_audits(fake):
    calls, _ = fake
    r = c.post("/api/policy/proposals", json={"run_id": "W0007", "note": "Tighter hurdle"}, headers=h("datasci"))
    assert r.status_code == 200, r.text
    user, run_id, changes, note = calls["create"][0]
    assert (user, run_id, note) == ("datasci", "W0007", "Tighter hurdle")
    assert [x["key"] for x in changes] == ["HURDLE_PCT", "MAX_GST_SHARE_PCT"]
    assert calls["audit"] == ["POLICY_PROPOSE"]


def test_propose_needs_a_note(fake):
    r = c.post("/api/policy/proposals", json={"run_id": "W0007", "note": "  "}, headers=h("datasci"))
    assert r.status_code == 422


def test_only_one_pending_proposal_per_run(fake):
    calls, state = fake
    state["pending"] = proposal()
    r = c.post("/api/policy/proposals", json={"run_id": "W0007", "note": "again"}, headers=h("datasci"))
    assert r.status_code == 409 and "pending" in r.json()["detail"]
    assert calls["create"] == []


def test_propose_blocked_when_policy_changed_since_the_run(fake):
    _, state = fake
    state["config"]["HURDLE_PCT"] = 17.0
    r = c.post("/api/policy/proposals", json={"run_id": "W0007", "note": "x"}, headers=h("datasci"))
    assert r.status_code == 409 and "Policy changed" in r.json()["detail"]


# ---------------------------------------------------------------- approve / reject

def test_approve_starts_the_policy_job(fake):
    calls, _ = fake
    r = c.post("/api/policy/proposals/3/approve", json={"note": "Board minute 14"}, headers=h("admin"))
    assert r.status_code == 200, r.text
    assert r.json()["job_id"] == "analysis-x" and r.json()["proposal"]["status"] == "APPROVED"
    assert calls["decide"] == [(3, "APPROVED", "admin")] and len(calls["apply"]) == 1
    assert calls["audit"] == ["POLICY_APPROVE"]


def test_nobody_approves_their_own_proposal(fake):
    calls, state = fake
    state["proposal"] = proposal(created_by="admin")
    for action in ("approve", "reject"):
        r = c.post(f"/api/policy/proposals/3/{action}", json={"note": "mine"}, headers=h("admin"))
        assert r.status_code == 403
    assert calls["decide"] == [] and calls["apply"] == []


def test_approval_blocked_when_config_changed(fake):
    calls, state = fake
    state["config"]["HURDLE_PCT"] = 14.0
    r = c.post("/api/policy/proposals/3/approve", json={"note": "ok"}, headers=h("admin"))
    assert r.status_code == 409
    assert r.json()["detail"] == "Policy changed since this proposal. Start a new what-if run."
    assert calls["decide"] == [] and calls["apply"] == []


def test_decided_proposals_are_read_only(fake):
    calls, state = fake
    state["proposal"] = proposal(status="APPROVED", decided_by="admin")
    for action in ("approve", "reject"):
        r = c.post(f"/api/policy/proposals/3/{action}", json={"note": "again"}, headers=h("admin"))
        assert r.status_code == 409
    assert calls["decide"] == []


def test_reject_needs_a_note_and_audits(fake):
    calls, _ = fake
    assert c.post("/api/policy/proposals/3/reject", json={"note": ""}, headers=h("admin")).status_code == 422
    r = c.post("/api/policy/proposals/3/reject", json={"note": "Too loose for Q4"}, headers=h("admin"))
    assert r.status_code == 200 and r.json()["status"] == "REJECTED"
    assert calls["decide"] == [(3, "REJECTED", "admin")] and calls["audit"] == ["POLICY_REJECT"]


def test_unknown_proposal_is_404(fake):
    assert c.post("/api/policy/proposals/99/approve", json={"note": "x"}, headers=h("admin")).status_code == 404


# ---------------------------------------------------------------- the approval job

def test_analysis_part_maps_progress_and_keeps_the_proposal_id():
    j = jobs.Job(job_id="analysis-y", kind="analysis", steps=[{"name": str(i), "status": "pending"} for i in range(5)],
                 started_by="admin")
    part = policy._AnalysisPart(j, 1, {"proposal_id": 3})
    assert len(part.steps) == 4 and part.steps[0] is j.steps[1]
    part.progress = max(part.progress, 50)
    assert part.progress == 50 and j.progress == 60  # 1 of 5 steps done plus half of the other 4
    part.result = {"run_id": "R1", "counts": {}}
    assert j.result == {"run_id": "R1", "counts": {}, "proposal_id": 3}
    assert part.job_id == "analysis-y"


def test_approval_job_writes_config_runs_and_auto_publishes(monkeypatch):
    """Admin approval: CONFIG write, the official run, then the run is published by the system."""
    from app import publish
    calls = []
    cfg = dict(CONFIG)
    monkeypatch.setattr(policy, "read_config", lambda db: dict(cfg))
    monkeypatch.setattr(policy, "write_config", lambda ch: calls.append("config") or cfg.update(HURDLE_PCT=16.0))
    monkeypatch.setattr(policy, "set_applied_run", lambda pid, rid: calls.append(("applied", rid)))
    monkeypatch.setattr(jobs, "_run_analysis", lambda part, rid: calls.append(("run", rid)))
    monkeypatch.setattr(publish, "publish", lambda rid, by, note: calls.append(("publish", rid, by)))
    audits = []
    monkeypatch.setattr(policy.crm, "audit", lambda u, a, t, d=None: audits.append((u.username, a)))
    j = jobs.Job(job_id="analysis-z", kind="analysis", steps=[{"name": str(i), "status": "pending"} for i in range(3)],
                 started_by="admin")
    policy._apply(j, make_user("admin"), proposal(), "R9", {"proposal_id": 3})
    assert calls == ["config", ("applied", "R9"), ("run", "R9"), ("publish", "R9", "system")]
    assert ("system", "RUN_PUBLISH") in audits and j.result["published"] is True
