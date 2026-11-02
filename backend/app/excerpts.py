"""'How Exasol decided': one entry per RUN_ANALYSIS step, joined at request time with that run's
CREDORA.RUN_LOG row (duration, row count). The code shown is the real script text, copied into
excerpts_code.py by tools/sync_excerpts.py."""

from __future__ import annotations

from typing import Any

from .excerpts_code import CODE

BANK = ["bank.oracle", "bank.mysql", "bank.postgres"]

STEP_INFO: dict[int, dict[str, Any]] = {
    1: dict(name="Refresh the bank's virtual schemas",
            what="Exasol reads Sapphire Bank's Oracle, MySQL and PostgreSQL databases in place through virtual "
                 "schemas. A refresh picks up tables the generator has just recreated; no data is copied.",
            engine="Lua script", object="VS_CBS, VS_CIF, VS_LOS", sources=BANK),
    2: dict(name="Read credit needs on file and the customer master",
            what="Applications in PostgreSQL are joined with companies and partners in MySQL in one SQL "
                 "statement. Exasol pushes the reads down to each database. {rows} applications read.",
            engine="SQL · virtual schema", object="CREDORA.APPLICATIONS", sources=["bank.postgres", "bank.mysql"]),
    3: dict(name="Fetch partners' CIBIL consumer reports",
            what="A Python UDF calls the CIBIL API's bulk endpoint, in 16 batches that Exasol runs 4 at a time, each call tried up to 3 times. "
                 "{rows} consumer reports staged in CREDORA_STAGE with a 7-day purge time.",
            engine="Python UDF", object="CREDORA.CIBIL_CONSUMER_FETCH", sources=["api.cibil", "bank.mysql"]),
    4: dict(name="Fetch the company's CIBIL commercial report",
            what="The same pattern for the company PAN: CMR rank, exposure, overdue, suit-filed and wilful-default "
                 "flags. {rows} commercial reports staged.",
            engine="Python UDF", object="CREDORA.CIBIL_COMMERCIAL_FETCH", sources=["api.cibil"]),
    5: dict(name="Fetch GST registrations and returns",
            what="GST_FETCH reads each GSTIN's registration and monthly GSTR-1 / GSTR-3B returns from the GSTN API. "
                 "{rows} monthly returns staged.",
            engine="Python UDF", object="CREDORA.GST_FETCH", sources=["api.gstn"]),
    6: dict(name="Fetch partners' accounts at other banks",
            what="AA_FETCH takes a consent per partner from the Account Aggregator and sums 12 months of "
                 "transactions per account. {rows} accounts staged; they are purged when the consent expires.",
            engine="Python UDF", object="CREDORA.AA_FETCH", sources=["api.aa", "bank.mysql"]),
    7: dict(name="Compute features",
            what="Twelve calendar months of current-account behaviour are aggregated in Oracle (pushdown), then "
                 "joined with GST, CIBIL and AA data into the 13 model features. The DSCR cash is the industry's "
                 "margin on GST turnover (INDUSTRY_MARGIN), and the company's CIBIL exposure at all lenders is "
                 "kept for the exposure cap. {rows} feature rows.",
            engine="SQL · window functions", object="CREDORA.FEATURES",
            sources=["bank.oracle", "bank.mysql", "api.gstn", "api.cibil", "api.aa"]),
    8: dict(name="Pick the risk model",
            what="The active model version comes from CREDORA.MODEL_REGISTRY; if none exists, one is trained on "
                 "past loans first.",
            engine="Lua script", object="CREDORA.MODEL_REGISTRY", sources=["exasol"]),
    9: dict(name="Score probability of default and explain it",
            what="PD_SCORE loads the model from BucketFS and, in 4 parallel instances, returns each application's "
                 "probability of default and how much each feature moved it. PD maps to a grade. {rows} scored.",
            engine="Python UDF", object="CREDORA.PD_SCORE", sources=["exasol"]),
    10: dict(name="Flag unusual companies (anomaly model)",
             what="ANOMALY_FLAG, an Isolation Forest in one Python UDF instance, looks at every company of the run at "
                  "once: GST turnover against bank credits and balances kept, inflow volatility and partners' money at "
                  "other banks. The most unusual share (CONFIG ANOMALY_CONTAMINATION_PCT, 3%) is flagged as possible "
                  "circular trading or inflated turnover, with the figures that stand out. {rows} companies checked.",
             engine="Python UDF", object="CREDORA.ANOMALY_FLAG", sources=["exasol", "api.gstn", "bank.oracle", "api.aa"]),
    11: dict(name="Size the offer, set the negotiation limit and decide",
             what="One SQL statement applies hard filters, prices the loan (EBLR + risk spread + operating spread), "
                  "sizes it from the industry's cash margin on GST turnover, the GST share and the room under the "
                  "total exposure cap (existing CIBIL exposure plus the offer within MAX_EXPOSURE_PCT of turnover), "
                  "sets the floor ROI where RAROC meets the hurdle with the LGD of the collateral type, and "
                  "decides Approve, Refer or Decline. A company the anomaly model flagged is referred for a person to "
                  "look at, never declined on it. {rows} decisions.",
             engine="SQL", object="CREDORA.DECISIONS", sources=["exasol", "bank.postgres"]),
    12: dict(name="Rank with PREFERRING",
             what="Exasol's PREFERRING clause returns the skyline: approved companies no other beats on RAROC, PD "
                  "and amount at once. Peeling skyline after skyline gives layers; the best 50 go to RMs. "
                  "{rows} companies placed in skyline layers.",
             engine="SQL · PREFERRING", object="CREDORA.DECISIONS", sources=["exasol"]),
    13: dict(name="Shadow-score with the challenger model",
             what="Champion/challenger: the logistic regression scorecard (or whichever model is not active) scores "
                  "the same companies with PD_SCORE, and the decision SQL of step 11 runs again on its PD to show "
                  "which decisions would change. Shadow only: it decides nothing until a data scientist activates "
                  "it. {rows} companies scored.",
             engine="Lua script · Python UDF", object="CREDORA.SCORE_CHALLENGER", sources=["exasol"]),
}

ANALYSIS_STEP_NAMES = [
    "Refresh virtual schemas",
    "Read credit needs on file",
    "Fetch CIBIL consumer reports (API)",
    "Fetch CIBIL commercial reports (API)",
    "Fetch GST returns (API)",
    "Fetch partner accounts at other banks (Account Aggregator API)",
    "Compute features",
    "Risk model",
    "Score probability of default (ML UDF)",
    "Flag anomalies (Isolation Forest UDF)",
    "Decide offer and negotiation limit",
    "Rank with PREFERRING skyline",
    "Shadow-score with the challenger model",
]
# The step that ended a run before the anomaly and challenger steps existed (it was step 11 then).
LEGACY_LAST_STEP = (11, "Rank with PREFERRING skyline")
CRM_STEP_NAME = "Export offers to CRM (crm.offer)"


def report_steps(run_log: list[dict]) -> list[dict]:
    """RUN_LOG rows of one run -> report steps."""
    by_no = {int(r["STEP_NO"]): r for r in run_log}
    out = []
    for n, info in STEP_INFO.items():
        r = by_no.get(n)
        lang, code = CODE[n]
        rows = int(r["ROWS_OUT"]) if r and r.get("ROWS_OUT") is not None else None
        what = info["what"].replace("{rows}", f"{rows:,}" if rows is not None else "–")
        if r and r.get("STATUS") == "FAILED":
            what += f" This step failed: {r.get('DETAIL') or 'see RUN_LOG'}."
        out.append({
            "n": n,
            "name": info["name"],
            "what": what,
            "engine": info["engine"],
            "object": info["object"],
            "language": lang,
            "code": code,
            "sources": info["sources"],
            "ms": int(r["MS"]) if r and r.get("MS") is not None else None,
        })
    return out
