"""Hand-offs between the roles: model activation (datasci requests, admin decides), publishing a run,
assigning companies to relationship managers, loan status, and the RM's Exasol row scope."""

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import activation, crm, exa, publish, rmbook, runs
from app.auth import issue_token, make_user
from app.main import app
from app.routes import analysis as analysis_routes
from app.routes import offers as offer_routes
from app.routes import workflow as routes

c = TestClient(app)
ROLES = ("admin", "datasci", "loanops", "rm")


def h(role):
    return {"Authorization": f"Bearer {issue_token(make_user(role))}"}


def request(**kw):
    return {"request_id": 4, "created_by": "datasci", "model_version": "v4", "current_version": "v3",
            "metrics": {}, "note": "better AUC", "status": "PENDING", "decided_by": None, "decided_at": None,
            "decision_note": None, **kw}


REGISTRY = [{"MODEL_VERSION": "v3", "ALGORITHM": "trees", "AUC": 0.81, "GINI": 0.62, "IS_ACTIVE": True},
            {"MODEL_VERSION": "v4", "ALGORITHM": "trees", "AUC": 0.83, "GINI": 0.66, "IS_ACTIVE": False}]


# ---------------------------------------------------------------- roles

@pytest.mark.parametrize("method,path,body,allowed", [
    ("post", "/api/analysis/run", None, {"datasci"}),
    ("post", "/api/runs/R1/publish", {"note": "x"}, {"datasci"}),
    ("get", "/api/runs", None, {"admin", "datasci", "loanops"}),
    ("get", "/api/top50", None, {"admin", "datasci", "loanops"}),
    ("get", "/api/ml/activation-requests", None, {"admin", "datasci"}),
    ("post", "/api/ml/activation-requests", {"version": "v4", "note": "x"}, {"datasci"}),
    ("post", "/api/ml/activation-requests/4/approve", {"note": "x"}, {"admin"}),
    ("post", "/api/ml/activation-requests/4/reject", {"note": "x"}, {"admin"}),
    ("get", "/api/approvals/pending", None, {"admin"}),
    ("get", "/api/rms", None, {"admin", "datasci", "loanops"}),
    ("post", "/api/assignments", {"cif_ids": ["C000001"], "rm_id": "RM002"}, {"loanops"}),
    ("post", "/api/loan-status/C000001", {"status": "CONTACTED", "note": "x"}, {"rm"}),
])
def test_roles(method, path, body, allowed):
    for role in ROLES:
        if role in allowed:
            continue
        r = getattr(c, method)(path, headers=h(role), **({"json": body} if body is not None else {}))
        assert r.status_code == 403, (role, path, r.status_code)


def test_nobody_activates_a_model_directly():
    for role in ROLES:
        assert c.post("/api/ml/activate", json={"version": "v4"}, headers=h(role)).status_code in (404, 405)


# ---------------------------------------------------------------- model activation

@pytest.fixture
def act(monkeypatch):
    calls = {"create": [], "decide": [], "activate": [], "audit": [], "reopen": []}
    state = {"request": request(), "pending": None, "registry": [dict(m) for m in REGISTRY]}
    monkeypatch.setattr(activation, "registry", lambda db: [dict(m) for m in state["registry"]])
    monkeypatch.setattr(activation, "pending_for", lambda v: state["pending"])
    monkeypatch.setattr(activation, "get", lambda rid: dict(state["request"]) if rid == 4 else None)
    monkeypatch.setattr(activation, "create", lambda u, v, cur, m, note: calls["create"].append((u, v, cur, note))
                        or request(model_version=v, current_version=cur))
    monkeypatch.setattr(activation, "decide", lambda rid, st, u, note: calls["decide"].append((rid, st, u))
                        or request(status=st, decided_by=u))
    monkeypatch.setattr(activation, "activate", lambda v: calls["activate"].append(v))
    monkeypatch.setattr(activation, "reopen", lambda rid: calls["reopen"].append(rid))
    monkeypatch.setattr(routes.crm, "audit", lambda u, a, t, d=None: calls["audit"].append(a))
    return calls, state


def test_request_activation_records_the_baseline(act):
    calls, _ = act
    r = c.post("/api/ml/activation-requests", json={"version": "v4", "note": "AUC +0.02"}, headers=h("datasci"))
    assert r.status_code == 200, r.text
    assert calls["create"] == [("datasci", "v4", "v3", "AUC +0.02")]
    assert calls["audit"] == ["MODEL_ACTIVATION_REQUEST"] and calls["activate"] == []


def test_request_needs_a_note_and_an_inactive_model(act):
    assert c.post("/api/ml/activation-requests", json={"version": "v4", "note": " "}, headers=h("datasci")).status_code == 422
    assert c.post("/api/ml/activation-requests", json={"version": "v3", "note": "x"}, headers=h("datasci")).status_code == 409
    assert c.post("/api/ml/activation-requests", json={"version": "v9", "note": "x"}, headers=h("datasci")).status_code == 404


def test_one_pending_request_per_model(act):
    calls, state = act
    state["pending"] = request()
    r = c.post("/api/ml/activation-requests", json={"version": "v4", "note": "again"}, headers=h("datasci"))
    assert r.status_code == 409 and "pending" in r.json()["detail"] and calls["create"] == []


def test_admin_approval_switches_is_active(act):
    calls, _ = act
    r = c.post("/api/ml/activation-requests/4/approve", json={"note": "Validated"}, headers=h("admin"))
    assert r.status_code == 200, r.text
    assert calls["decide"] == [(4, "APPROVED", "admin")] and calls["activate"] == ["v4"]
    assert calls["audit"] == ["MODEL_ACTIVATION_APPROVE"]


def test_nobody_decides_their_own_request(act):
    calls, state = act
    state["request"] = request(created_by="admin")
    for a in ("approve", "reject"):
        assert c.post(f"/api/ml/activation-requests/4/{a}", json={"note": "mine"}, headers=h("admin")).status_code == 403
    assert calls["decide"] == [] and calls["activate"] == []


def test_approval_blocked_when_the_active_model_changed(act):
    calls, state = act
    state["registry"] = [dict(REGISTRY[0], IS_ACTIVE=False), dict(REGISTRY[1]),
                         {"MODEL_VERSION": "v5", "ALGORITHM": "trees", "AUC": 0.8, "GINI": 0.6, "IS_ACTIVE": True}]
    r = c.post("/api/ml/activation-requests/4/approve", json={"note": "ok"}, headers=h("admin"))
    assert r.status_code == 409 and r.json()["detail"] == activation.CHANGED_MSG
    assert calls["decide"] == [] and calls["activate"] == []


def test_decided_requests_are_read_only(act):
    calls, state = act
    state["request"] = request(status="REJECTED", decided_by="admin")
    for a in ("approve", "reject"):
        r = c.post(f"/api/ml/activation-requests/4/{a}", json={"note": "again"}, headers=h("admin"))
        assert r.status_code == 409 and "read-only" in r.json()["detail"]
    assert calls["decide"] == []


def test_reject_needs_a_note_and_audits(act):
    calls, _ = act
    assert c.post("/api/ml/activation-requests/4/reject", json={"note": ""}, headers=h("admin")).status_code == 422
    r = c.post("/api/ml/activation-requests/4/reject", json={"note": "Not before the audit"}, headers=h("admin"))
    assert r.status_code == 200 and calls["audit"] == ["MODEL_ACTIVATION_REJECT"] and calls["activate"] == []


def test_failed_switch_reopens_the_request(act, monkeypatch):
    calls, _ = act
    monkeypatch.setattr(activation, "activate", lambda v: (_ for _ in ()).throw(RuntimeError("Exasol down")))
    with pytest.raises(RuntimeError):
        c.post("/api/ml/activation-requests/4/approve", json={"note": "ok"}, headers=h("admin"))
    assert calls["reopen"] == [4]


def test_baseline_changed_rule():
    assert not activation.baseline_changed(request(), "v3")
    assert activation.baseline_changed(request(), "v5")
    assert not activation.baseline_changed(request(current_version=None), None)


# ---------------------------------------------------------------- publish

def run(rid, status="done", fin="2026-10-31T10:00:00Z"):
    return {"run_id": rid, "status": status, "finished_at": fin}


def test_only_published_runs_are_current():
    rs = [run("R1", fin="2026-10-31T09:00:00Z"), run("R2", fin="2026-10-31T10:00:00Z")]
    assert runs.pick_current(publish.only_published(rs, {"R1": {}}), None)["run_id"] == "R1"
    assert runs.pick_current(publish.only_published(rs, {}), None) is None  # nothing published yet
    assert runs.pick_current(publish.only_published(rs, None), None)["run_id"] == "R2"  # no publish table


def test_with_publish_marks_drafts():
    out = runs.with_publish([run("R1"), run("R2"), run("R3", status="failed")],
                            {"R1": {"published_by": "datasci", "published_at": "t", "note": "n"}})
    assert [(r["run_id"], r["published"]) for r in out] == [("R1", True), ("R2", False), ("R3", False)]
    assert out[0]["published_by"] == "datasci" and out[1]["published_by"] is None


def test_check_publishable():
    publish.check_publishable(run("R2"), "R2", {"R1": {}})
    for r, pub, code in ((None, {}, 404), (run("R2", "running"), {}, 409), (run("R1"), {"R1": {}}, 409)):
        with pytest.raises(HTTPException) as e:
            publish.check_publishable(r, "R1" if r is None else r["run_id"], pub)
        assert e.value.status_code == code


def test_publish_route_writes_as_svc_and_exports_offers(monkeypatch):
    calls = []
    monkeypatch.setattr(publish, "published", lambda db: {})
    monkeypatch.setattr(runs, "list_runs", lambda db, running=None: [run("R2")])
    monkeypatch.setattr(publish, "publish", lambda rid, by, note: calls.append(("publish", rid, by, note)))
    monkeypatch.setattr(routes.jobs, "export_offers", lambda rid: calls.append(("export", rid)) or {"inserted": 1})
    monkeypatch.setattr(routes.crm, "audit", lambda u, a, t, d=None: calls.append(("audit", a)))
    r = c.post("/api/runs/R2/publish", json={"note": "Reviewed"}, headers=h("datasci"))
    assert r.status_code == 200, r.text
    assert calls == [("publish", "R2", "datasci", "Reviewed"), ("export", "R2"), ("audit", "RUN_PUBLISH")]


def test_loanops_sees_published_runs_only(monkeypatch):
    rs = runs.with_publish([run("R1"), run("R2")], {"R1": {"published_by": "d", "published_at": "t", "note": None}})
    monkeypatch.setattr(runs, "list_runs", lambda db, running=None: [dict(r) for r in rs])
    assert [r["run_id"] for r in c.get("/api/runs", headers=h("loanops")).json()] == ["R1"]
    assert [r["run_id"] for r in c.get("/api/runs", headers=h("datasci")).json()] == ["R1", "R2"]


# ---------------------------------------------------------------- assignments

def test_exasol_user_per_rm():
    assert rmbook.exa_user_for("RM001") == "CREDORA_RM"  # the demo login
    assert rmbook.exa_user_for("RM002") == "CREDORA_RM002"


def test_clean_cifs():
    assert rmbook.clean_cifs([" c000001", "C000001", "C000002"]) == ["C000001", "C000002"]
    for bad in ([], [""], ["C0001; DROP"], ["C%"]):
        with pytest.raises(HTTPException):
            rmbook.clean_cifs(bad)


def test_split_moves():
    out = rmbook.split_moves(["C1", "C2", "C3"], {"C2": "RM002", "C3": "RM005"}, "RM002")
    assert out == {"new": ["C1"], "moved": ["C3"], "unchanged": ["C2"]}


def test_assign_route_uses_the_published_run(monkeypatch):
    seen = {}
    monkeypatch.setattr(runs, "current_run", lambda db: {"run_id": "R7"})
    monkeypatch.setattr(rmbook, "assign", lambda cifs, rm, rid, by: seen.update(cifs=cifs, rm=rm, rid=rid, by=by)
                        or {"rm_id": rm, "assigned": 2, "moved": 0, "unchanged": 0})
    monkeypatch.setattr(routes.crm, "audit", lambda *a, **k: None)
    r = c.post("/api/assignments", json={"cif_ids": ["c000001", "C000002"], "rm_id": "rm002"}, headers=h("loanops"))
    assert r.status_code == 200, r.text
    assert seen == {"cifs": ["C000001", "C000002"], "rm": "RM002", "rid": "R7", "by": "loanops"}


def test_assign_needs_a_published_run(monkeypatch):
    monkeypatch.setattr(runs, "current_run", lambda db: None)
    r = c.post("/api/assignments", json={"cif_ids": ["C000001"], "rm_id": "RM002"}, headers=h("loanops"))
    assert r.status_code == 409


def test_assign_writes_as_svc_with_the_rm_exasol_user(monkeypatch):
    sqls = []

    def q(user, sql, params=None):
        sqls.append((user, sql, params))
        if "FROM CREDORA.DECISIONS WHERE RUN_ID" in sql and "SELECT CIF_ID" in sql and "MERGE" not in sql:
            return [{"CIF_ID": "C000001"}, {"CIF_ID": "C000002"}]
        if "FROM CREDORA.RM_ASSIGNMENT WHERE CIF_ID IN" in sql:
            return [{"CIF_ID": "C000002", "RM_ID": "RM005"}]
        return []
    monkeypatch.setattr(rmbook, "rm_directory", lambda: [{"rm_id": "RM001"}, {"rm_id": "RM005"}])
    monkeypatch.setattr(rmbook.exa, "query", q)
    out = rmbook.assign(["C000001", "C000002"], "RM001", "R7", "loanops")
    assert out == {"rm_id": "RM001", "assigned": 1, "moved": 1, "unchanged": 0}
    assert all(u == exa.SVC for u, _, _ in sqls)
    merge = next(p for _, s, p in sqls if "MERGE INTO CREDORA.RM_ASSIGNMENT" in s)
    assert merge["u"] == "CREDORA_RM" and merge["c"] == ["C000001", "C000002"]
    with pytest.raises(HTTPException):
        rmbook.assign(["C000001"], "RM099", "R7", "loanops")


# ---------------------------------------------------------------- loan status

def test_status_rules():
    rmbook.check_status_change(None, "CONTACTED", "Called the CFO")
    rmbook.check_status_change("ASSIGNED", "NOT_INTERESTED", "Has a line elsewhere")
    for cur, new, note, code in ((None, "ASSIGNED", "x", 422), (None, "WON", "x", 422), (None, "CONTACTED", " ", 422),
                                 ("DISBURSED", "IN_PROGRESS", "x", 409), ("CONTACTED", "CONTACTED", "x", 409)):
        with pytest.raises(HTTPException) as e:
            rmbook.check_status_change(cur, new, note)
        assert e.value.status_code == code


AGREED = {"offer_id": 7, "stage": "NEGOTIATING", "agreed_amount": 1e7}


def test_status_moves_one_step_at_a_time():
    path = [None, "CONTACTED", "NEGOTIATING", "LOAN_TAKEN", "IN_PROGRESS", "DISBURSED"]
    for cur, new in zip(path, path[1:]):
        rmbook.check_status_change(cur, new, "x")
    for cur in path[:-1]:
        rmbook.check_status_change(cur, "NOT_INTERESTED", "x")
    rmbook.check_status_change("NOT_INTERESTED", "CONTACTED", "Called back")
    for cur, new in ((None, "DISBURSED"), ("ASSIGNED", "LOAN_TAKEN"), ("CONTACTED", "LOAN_TAKEN"),
                     ("NEGOTIATING", "DISBURSED"), ("LOAN_TAKEN", "DISBURSED"), ("IN_PROGRESS", "NEGOTIATING"),
                     ("DISBURSED", "NOT_INTERESTED"), ("NOT_INTERESTED", "LOAN_TAKEN")):
        with pytest.raises(HTTPException) as e:
            rmbook.check_status_change(cur, new, "x")
        assert e.value.status_code == 409, (cur, new)
    assert rmbook.next_statuses("DISBURSED") == [] and rmbook.next_statuses(None) == ["CONTACTED", "NOT_INTERESTED"]


def test_loan_taken_needs_agreed_or_sanctioned_terms():
    assert rmbook.offer_block(AGREED, False) is None
    assert rmbook.offer_block({**AGREED, "stage": "SANCTIONED"}, True) is None
    assert rmbook.offer_block({**AGREED, "stage": "VERIFIED"}, False) is None
    for o, esc in ((None, False), ({**AGREED, "stage": "OFFERED", "agreed_amount": None}, False),
                   ({**AGREED, "stage": "ESCALATED"}, True), ({**AGREED, "stage": "VERIFIED"}, True),
                   ({**AGREED, "stage": "DECLINED"}, False)):
        block = rmbook.offer_block(o, esc)
        assert block, o
        with pytest.raises(HTTPException) as e:
            rmbook.check_status_change("NEGOTIATING", "LOAN_TAKEN", "x", block)
        assert e.value.status_code == 409 and "needs agreed terms" in e.value.detail
        assert rmbook.next_statuses("NEGOTIATING", block) == ["NOT_INTERESTED"]
    # Not interested never needs an offer.
    rmbook.check_status_change("NEGOTIATING", "NOT_INTERESTED", "x", "blocked")


def status_route(monkeypatch, cur, offer, escalated=()):
    logged = []
    monkeypatch.setattr(rmbook, "assigned_cifs", lambda db: {"C000001"})
    monkeypatch.setattr(rmbook, "status_history", lambda db, rm_scope, cif_ids=None:
                        {"C000001": [{"status": cur}]} if cur else {})
    monkeypatch.setattr(rmbook, "log_status", lambda cif, rm, st, note, actor: logged.append(st) or {})
    monkeypatch.setattr(routes.crm, "audit", lambda *a, **k: None)
    monkeypatch.setattr(routes.crm, "offers_by_cif", lambda cifs: {"C000001": offer} if offer else {})
    monkeypatch.setattr(routes.crm, "escalated_offers", lambda ids: set(escalated))
    return logged


def test_route_refuses_loan_taken_while_escalated(monkeypatch):
    logged = status_route(monkeypatch, "NEGOTIATING", {**AGREED, "stage": "ESCALATED"})
    r = c.post("/api/loan-status/C000001", json={"status": "LOAN_TAKEN", "note": "x"}, headers=h("rm"))
    assert r.status_code == 409 and "sanction" in r.json()["detail"] and logged == []
    logged = status_route(monkeypatch, "NEGOTIATING", {**AGREED, "stage": "SANCTIONED"})
    r = c.post("/api/loan-status/C000001", json={"status": "LOAN_TAKEN", "note": "x"}, headers=h("rm"))
    assert r.status_code == 200 and logged == ["LOAN_TAKEN"]


def test_route_refuses_skipping_to_disbursed(monkeypatch):
    logged = status_route(monkeypatch, "NEGOTIATING", AGREED)
    r = c.post("/api/loan-status/C000001", json={"status": "DISBURSED", "note": "x"}, headers=h("rm"))
    assert r.status_code == 409 and logged == []


def offer_route(monkeypatch, status, stage="NEGOTIATING"):
    logged = []
    monkeypatch.setattr(rmbook, "assigned_cifs", lambda db: {"C000001"})
    monkeypatch.setattr(rmbook, "status_history", lambda db, rm_scope, cif_ids=None:
                        {"C000001": [{"status": status}]} if status else {})
    monkeypatch.setattr(rmbook, "log_status", lambda cif, rm, st, note, actor: logged.append(st) or {})
    monkeypatch.setattr(offer_routes.crm, "get_offer", lambda oid: {**AGREED, "offer_id": oid, "cif_id": "C000001",
                                                                    "stage": stage})
    monkeypatch.setattr(offer_routes.crm, "audit", lambda *a, **k: None)
    monkeypatch.setattr(offer_routes.crm, "transition", lambda *a, **k: {"offer_id": 7})
    monkeypatch.setattr(offer_routes, "run_quote", lambda u, o, t: {"within_limit": False, "reasons": ["above"]})
    return logged


def test_terms_lock_once_the_loan_is_taken(monkeypatch):
    offer_route(monkeypatch, "LOAN_TAKEN")
    r = c.post("/api/offers/7/propose", json={"amount": 1e7, "roi": 10, "tenure": 12}, headers=h("rm"))
    assert r.status_code == 409
    r = c.post("/api/offers/7/reject", json={"note": "x"}, headers=h("loanops"))
    assert r.status_code == 409


def test_proposal_moves_the_status_to_negotiating(monkeypatch):
    logged = offer_route(monkeypatch, "CONTACTED", "OFFERED")
    r = c.post("/api/offers/7/propose", json={"amount": 1e7, "roi": 10, "tenure": 12}, headers=h("rm"))
    assert r.status_code == 200 and logged == ["NEGOTIATING"]
    logged = offer_route(monkeypatch, "NEGOTIATING", "NEGOTIATING")
    c.post("/api/offers/7/propose", json={"amount": 1e7, "roi": 10, "tenure": 12}, headers=h("rm"))
    assert logged == []


def test_rm_cannot_check_her_own_offer():
    for action in ("verify", "sanction", "reject"):
        assert c.post(f"/api/offers/7/{action}", json={"note": "x"}, headers=h("rm")).status_code == 403


def test_rm_logs_status_only_for_assigned_companies(monkeypatch):
    logged = []
    monkeypatch.setattr(rmbook, "assigned_cifs", lambda db: {"C000001"})
    monkeypatch.setattr(rmbook, "status_history", lambda db, rm_scope, cif_ids=None: {})
    monkeypatch.setattr(rmbook, "log_status", lambda cif, rm, st, note, actor: logged.append((cif, rm, st)) or {})
    monkeypatch.setattr(routes.crm, "audit", lambda *a, **k: None)
    assert c.post("/api/loan-status/C000009", json={"status": "CONTACTED", "note": "x"}, headers=h("rm")).status_code == 403
    r = c.post("/api/loan-status/c000001", json={"status": "contacted", "note": "Met the promoter"}, headers=h("rm"))
    assert r.status_code == 200, r.text
    assert logged == [("C000001", "RM001", "CONTACTED")]


def test_tracker_rows():
    assigned = [{"cif_id": "C1", "rm_id": "RM001", "assigned_by": "loanops", "assigned_at": "2026-10-31T09:00:00Z"},
                {"cif_id": "C2", "rm_id": "RM002", "assigned_by": "loanops", "assigned_at": "2026-10-31T08:00:00Z"}]
    hist = {"C2": [{"status": "NEGOTIATING", "note": "n", "at": "2026-10-31T11:00:00Z", "actor": "rm"}]}
    rows = rmbook.tracker_rows(assigned, {"C1": {"LEGAL_NAME": "A Ltd", "DECISION": "APPROVE"}}, {"RM001": "S M"}, hist)
    assert [(r["cif_id"], r["status"]) for r in rows] == [("C2", "NEGOTIATING"), ("C1", "ASSIGNED")]
    assert rows[1]["rm_name"] == "S M" and rows[1]["legal_name"] == "A Ltd" and rows[0]["history"] == hist["C2"]
    assert rows[1]["next_statuses"] == ["CONTACTED", "NOT_INTERESTED"] and rows[0]["offer_block"]
    rows = rmbook.tracker_rows(assigned, {}, {}, hist, {"C2": AGREED}, set())
    assert rows[0]["offer_stage"] == "NEGOTIATING" and rows[0]["next_statuses"] == ["LOAN_TAKEN", "NOT_INTERESTED"]


# ---------------------------------------------------------------- the RM reads through V_RM_* views

def capture(monkeypatch, rows_for):
    sqls = []

    def q(user, sql, params=None):
        sqls.append((user, sql))
        for key, rows in rows_for.items():
            if key in sql:
                return rows
        return []
    monkeypatch.setattr(exa, "query", q)
    monkeypatch.setattr(exa, "scalar", lambda user, sql, params=None: sqls.append((user, sql)) or 0)
    return sqls


def test_rm_report_reads_only_rm_views(monkeypatch):
    monkeypatch.setattr(runs, "current_run", lambda db: {"run_id": "R7", "finished_at": "t"})
    monkeypatch.setattr(crm, "offer_for_app", lambda a: None)
    d = {"APP_ID": "A1", "CIF_ID": "C000001", "LEGAL_NAME": "A Ltd", "DECISION": "APPROVE", "GRADE": "A1", "PD": 0.01,
         "RANK_NO": 3, "OFFER_AMOUNT": 1e7, "OFFER_ROI": 10, "OFFER_TENURE": 12, "RAROC_OFFER": 20, "RAROC_FLOOR": 16,
         "MAX_AMOUNT": 1.2e7, "FLOOR_ROI": 9.5, "MAX_TENURE": 24, "AMOUNT_REQUESTED": 1e7, "TENURE_REQUESTED": 12,
         "PRODUCT": "WC", "HARD_FAILS": None, "DECIDED_AT": "t"}
    sqls = capture(monkeypatch, {"V_RM_DECISIONS": [d], "V_RM_COMPANY": [{"PARTNERS": 2, "GST_STAGE": "Stable",
                                                                         "GST_YEARS": 6}]})
    out = analysis_routes.build_report("C000001", make_user("rm"))
    assert out["cif_id"] == "C000001" and out["sources_used"] == analysis_routes.ALL_SOURCES
    read = " ".join(s for _, s in sqls)
    assert all(u == "CREDORA_RM" for u, _ in sqls)
    for t in ("CREDORA.DECISIONS ", "CREDORA.SCORES ", "CREDORA.FEATURES ", "V_COMPANY_MASKED", "APPLICATIONS"):
        assert t not in read.replace("V_RM_", "X"), t
    assert "V_RM_FEATURES" in read and "V_RM_SCORES" in read


def test_rm_report_for_unassigned_company_is_forbidden(monkeypatch):
    monkeypatch.setattr(runs, "current_run", lambda db: {"run_id": "R7", "finished_at": "t"})
    capture(monkeypatch, {})  # Exasol returns no row: the company is not assigned to CREDORA_RM
    with pytest.raises(HTTPException) as e:
        analysis_routes.build_report("C000999", make_user("rm"))
    assert e.value.status_code == 403


def test_rm_offers_are_scoped_to_her_book(monkeypatch):
    monkeypatch.setattr(rmbook, "assigned_cifs", lambda db: {"C000001"})
    monkeypatch.setattr(offer_routes.crm, "get_offer", lambda oid: {"offer_id": oid, "cif_id": "C000002"})
    with pytest.raises(HTTPException) as e:
        offer_routes.offer_for(make_user("rm"), 5)
    assert e.value.status_code == 403
    monkeypatch.setattr(offer_routes.crm, "get_offer", lambda oid: {"offer_id": oid, "cif_id": "C000001"})
    assert offer_routes.offer_for(make_user("rm"), 5)["cif_id"] == "C000001"
