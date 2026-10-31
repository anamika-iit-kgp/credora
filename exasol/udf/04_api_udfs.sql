-- Python UDFs that fetch 3rd party data on demand via API from the (mock) CIBIL, GSTN and Account Aggregator APIs.
-- Each is a SET script: Exasol groups the input keys into batches (GROUP BY batch), runs one
-- UDF instance per batch in parallel across cores, and each instance calls the bulk endpoint.
-- The API address and token come from CONNECTION objects, never from the SQL text.

CREATE OR REPLACE PYTHON3 SET SCRIPT CREDORA.CIBIL_CONSUMER_FETCH(conn_name VARCHAR(100), pan VARCHAR(10))
EMITS (pan VARCHAR(10), name VARCHAR(80), score DOUBLE, enquiries_6m DOUBLE, enquiries_12m DOUBLE,
       accounts DOUBLE, active_accounts DOUBLE, total_sanctioned DOUBLE, total_balance DOUBLE,
       total_overdue DOUBLE, max_dpd_12m DOUBLE, max_dpd_36m DOUBLE, written_off DOUBLE,
       raw_json VARCHAR(200000)) AS
import json
import requests

def keys(ctx, col):
    out = []
    while True:
        out.append(getattr(ctx, col))
        if not ctx.next():
            return out

def run(ctx):
    conn = exa.get_connection(ctx.conn_name)
    pans = keys(ctx, "pan")
    for i in range(0, len(pans), 500):
        r = requests.post(f"{conn.address}/v1/consumer/bulk", json={"pans": pans[i:i + 500]},
                          headers={"X-API-Key": conn.password}, timeout=120)
        r.raise_for_status()
        for rep in r.json()["reports"]:
            accts = rep.get("accounts", [])
            dpd = [a.get("dpd_36m") or [0] for a in accts]
            ctx.emit(rep["pan"], rep.get("name"), rep.get("score"), rep.get("enquiries_6m"), rep.get("enquiries_12m"),
                     len(accts), sum(a.get("status") == "ACTIVE" for a in accts),
                     sum(a.get("sanctioned") or 0 for a in accts), sum(a.get("balance") or 0 for a in accts),
                     sum(a.get("overdue") or 0 for a in accts),
                     max((max(d[:12]) for d in dpd), default=0), max((max(d) for d in dpd), default=0),
                     sum(a.get("status") in ("WRITTEN_OFF", "SETTLED") for a in accts),
                     json.dumps(rep))
/

CREATE OR REPLACE PYTHON3 SET SCRIPT CREDORA.CIBIL_COMMERCIAL_FETCH(conn_name VARCHAR(100), pan VARCHAR(10))
EMITS (pan VARCHAR(10), name VARCHAR(120), cmr_rank DOUBLE, total_exposure DOUBLE, overdue DOUBLE,
       suit_filed BOOLEAN, wilful_default BOOLEAN, facilities DOUBLE, raw_json VARCHAR(20000)) AS
import json
import requests

def run(ctx):
    conn = exa.get_connection(ctx.conn_name)
    pans = []
    while True:
        pans.append(ctx.pan)
        if not ctx.next():
            break
    for i in range(0, len(pans), 500):
        r = requests.post(f"{conn.address}/v1/commercial/bulk", json={"pans": pans[i:i + 500]},
                          headers={"X-API-Key": conn.password}, timeout=120)
        r.raise_for_status()
        for rep in r.json()["reports"]:
            ctx.emit(rep["pan"], rep.get("name"), rep.get("cmr_rank"), rep.get("total_exposure"), rep.get("overdue"),
                     bool(rep.get("suit_filed")), bool(rep.get("wilful_default")), rep.get("facilities"),
                     json.dumps(rep))
/

CREATE OR REPLACE PYTHON3 SET SCRIPT CREDORA.GST_FETCH(conn_name VARCHAR(100), gstin VARCHAR(15))
EMITS (gstin VARCHAR(15), legal_name VARCHAR(120), pan VARCHAR(10), state_name VARCHAR(30), registered_on DATE,
       reg_status VARCHAR(10), stage VARCHAR(12), gst_period VARCHAR(7), gstr1_turnover DOUBLE,
       gstr3b_tax_paid DOUBLE, due_date DATE, filed_on DATE, delay_days DOUBLE) AS
import datetime as dt
import requests

def d(s):
    return dt.date.fromisoformat(s) if s else None

def run(ctx):
    conn = exa.get_connection(ctx.conn_name)
    gstins = []
    while True:
        gstins.append(ctx.gstin)
        if not ctx.next():
            break
    for i in range(0, len(gstins), 200):
        r = requests.post(f"{conn.address}/v1/returns/bulk", json={"gstins": gstins[i:i + 200]},
                          headers={"X-API-Key": conn.password}, timeout=180)
        r.raise_for_status()
        for item in r.json()["items"]:
            reg = item["registration"]
            for ret in item["returns"]:
                ctx.emit(item["gstin"], reg.get("legal_name"), reg.get("pan"), reg.get("state"),
                         d(reg.get("registered_on")), reg.get("status"), reg.get("stage"), ret["period"],
                         ret.get("gstr1_turnover"), ret.get("gstr3b_tax_paid"), d(ret.get("due_date")),
                         d(ret.get("filed_on")), ret.get("delay_days"))
/

CREATE OR REPLACE PYTHON3 SET SCRIPT CREDORA.AA_FETCH(conn_name VARCHAR(100), pan VARCHAR(10), as_of DATE)
EMITS (pan VARCHAR(10), consent_id VARCHAR(36), consent_expires TIMESTAMP, aa_account_id VARCHAR(16), fip VARCHAR(40),
       acct_type VARCHAR(10), masked_no VARCHAR(20), opened_on DATE, current_balance DOUBLE,
       txn_count DOUBLE, credits_12m DOUBLE, debits_12m DOUBLE) AS
import datetime as dt
import requests

def run(ctx):
    conn = exa.get_connection(ctx.conn_name)
    as_of = ctx.as_of
    pans = []
    while True:
        pans.append(ctx.pan)
        if not ctx.next():
            break
    since = (as_of - dt.timedelta(days=365)).isoformat()
    for i in range(0, len(pans), 200):
        r = requests.post(f"{conn.address}/v1/fi/bulk", json={"pans": pans[i:i + 200], "purpose": "Loan underwriting"},
                          headers={"X-API-Key": conn.password}, timeout=180)
        r.raise_for_status()
        for item in r.json()["items"]:
            expires = dt.datetime.fromisoformat(item["expires_at"].replace("Z", "")) if item.get("expires_at") else None
            for a in item["accounts"]:
                txns = [t for t in a.get("transactions", []) if t["txn_date"] >= since]
                ctx.emit(item["pan"], item.get("consent_id"), expires, a["aa_account_id"], a.get("fip"),
                         a.get("acct_type"), a.get("masked_no"),
                         dt.date.fromisoformat(a["opened_on"]) if a.get("opened_on") else None,
                         a.get("current_balance"), len(txns),
                         sum(t["amount"] for t in txns if t["dr_cr"] == "C"),
                         sum(t["amount"] for t in txns if t["dr_cr"] == "D"))
/
