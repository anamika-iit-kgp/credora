-- Machine learning inside Exasol. All UDFs run in the PYTHON3 script language container.
--
-- TRAIN_PD         trains the champion: gradient-boosted trees on Sapphire Bank's past loans (read
--                  live from PostgreSQL through the VS_LOS virtual schema), measures it on a hold-out
--                  set, and saves it to BucketFS as models/pd_<version>.pkl.
-- TRAIN_SCORECARD  trains the challenger: a logistic regression scorecard on standardised features,
--                  on the same past loans and the same hold-out, saved as models/pd_<version>.pkl.
--                  Both trainers also emit the SHA-256 of the pickle bytes they uploaded, which
--                  TRAIN_MODEL stores in MODEL_REGISTRY.MODEL_SHA256.
-- PD_SCORE         loads either kind of saved model from BucketFS and returns, for each company, the
--                  probability of default and how much each feature moved it (feature attribution).
--                  Before it unpickles the file it hashes the bytes and refuses a file whose SHA-256
--                  differs from the registry row. A row without a hash loads unchecked.
-- MODEL_FILE_SHA256 hashes one model file in BucketFS. The UPDATE at the end of this file uses it
--                  to fill MODEL_SHA256 for models registered before the hash existed.
-- ANOMALY_FLAG     an Isolation Forest (unsupervised) over one run's features: flags companies whose
--                  GST, bank and partner figures look unlike everyone else's (possible circular
--                  trading or inflated turnover) and says which figures stand out.
--
-- Both trainers sort the past loans by loan_id before the stratified 75/25 split, so the champion
-- and the challenger are measured on exactly the same hold-out loans.

CREATE OR REPLACE PYTHON3 SET SCRIPT CREDORA.TRAIN_PD(
  model_version VARCHAR(20), loan_id VARCHAR(10),
  gst_years DOUBLE, gst_turnover_12m DOUBLE, gst_late_filings_12m DOUBLE, gst_bank_gap_pct DOUBLE,
  avg_balance_12m DOUBLE, inflow_volatility DOUBLE, bounce_ratio DOUBLE, cmr_rank DOUBLE,
  partner_min_score DOUBLE, partner_avg_score DOUBLE, partner_overdue_amt DOUBLE, partner_other_bank_bal DOUBLE,
  dscr DOUBLE, defaulted BOOLEAN)
EMITS (model_version VARCHAR(20), algorithm VARCHAR(80), auc DOUBLE, gini DOUBLE, n_train DOUBLE, default_rate DOUBLE,
       feature_importance VARCHAR(20000), model_path VARCHAR(200), model_sha256 VARCHAR(64)) AS
import os
os.environ["OMP_NUM_THREADS"] = "4"
import hashlib
import io
import json
import pickle

import numpy as np
import requests
import urllib3
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import train_test_split

urllib3.disable_warnings()

FEATURES = ["gst_years", "gst_turnover_12m", "gst_late_filings_12m", "gst_bank_gap_pct", "avg_balance_12m",
            "inflow_volatility", "bounce_ratio", "cmr_rank", "partner_min_score", "partner_avg_score",
            "partner_overdue_amt", "partner_other_bank_bal", "dscr"]
# Monotonic constraints encode credit sense: e.g. more late filings can only raise risk.
MONOTONIC = {"gst_years": -1, "gst_late_filings_12m": 1, "gst_bank_gap_pct": 1, "inflow_volatility": 1,
             "bounce_ratio": 1, "cmr_rank": 1, "partner_min_score": -1, "partner_avg_score": -1,
             "partner_overdue_amt": 1, "dscr": -1}

def run(ctx):
    df = ctx.get_dataframe(num_rows="all")
    df.columns = [c.lower() for c in df.columns]
    df = df.sort_values("loan_id", kind="mergesort").reset_index(drop=True)  # same split as TRAIN_SCORECARD
    version = df["model_version"].iloc[0]
    X = df[FEATURES].astype(float).to_numpy()
    y = df["defaulted"].astype(int).to_numpy()

    def model():
        return HistGradientBoostingClassifier(
            max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=40, l2_regularization=1.0,
            monotonic_cst=[MONOTONIC.get(f, 0) for f in FEATURES], random_state=7)

    X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.25, stratify=y, random_state=7)
    m = model().fit(X_tr, y_tr)
    auc = float(roc_auc_score(y_te, m.predict_proba(X_te)[:, 1]))
    imp = permutation_importance(m, X_te, y_te, scoring="roc_auc", n_repeats=5, random_state=7)
    importance = {f: round(float(v), 5) for f, v in zip(FEATURES, imp.importances_mean)}

    final = model().fit(X, y)  # refit on all past loans for production use
    bundle = {"version": version, "features": FEATURES, "model": final,
              "baseline": {f: float(np.median(X[:, i])) for i, f in enumerate(FEATURES)}}
    buf = io.BytesIO()
    pickle.dump(bundle, buf)
    data = buf.getvalue()
    sha256 = hashlib.sha256(data).hexdigest()  # PD_SCORE checks the file against it before unpickling

    conn = exa.get_connection("BUCKETFS_MODELS")
    path = f"pd_{version}.pkl"
    r = requests.put(f"{conn.address}/{path}", data=data, auth=(conn.user, conn.password),
                     verify=False, timeout=120)
    r.raise_for_status()
    ctx.emit(version, "Gradient-boosted trees (scikit-learn HistGradientBoosting, monotonic)", auc, 2 * auc - 1,
             len(y), float(y.mean()), json.dumps(importance), f"/buckets/bfsdefault/default/models/{path}", sha256)
/

CREATE OR REPLACE PYTHON3 SET SCRIPT CREDORA.PD_SCORE(
  model_path VARCHAR(200), model_sha256 VARCHAR(64), app_id VARCHAR(8),
  gst_years DOUBLE, gst_turnover_12m DOUBLE, gst_late_filings_12m DOUBLE, gst_bank_gap_pct DOUBLE,
  avg_balance_12m DOUBLE, inflow_volatility DOUBLE, bounce_ratio DOUBLE, cmr_rank DOUBLE,
  partner_min_score DOUBLE, partner_avg_score DOUBLE, partner_overdue_amt DOUBLE, partner_other_bank_bal DOUBLE,
  dscr DOUBLE)
EMITS (app_id VARCHAR(8), pd DOUBLE, contributions VARCHAR(20000)) AS
import os
os.environ["OMP_NUM_THREADS"] = "1"  # one UDF instance per core already; avoid thread oversubscription
import hashlib
import json
import pickle
import time

_cache = {}

def load(path, expected_sha256):
    if path not in _cache:
        for _ in range(60):  # a freshly trained model can take a few seconds to sync to every node
            if os.path.exists(path):
                break
            time.sleep(1)
        with open(path, "rb") as f:
            data = f.read()
        # The registry row carries the SHA-256 the trainer computed from the bytes it uploaded. A file
        # that hashes differently was replaced or damaged after training and is never unpickled. Rows
        # registered before the hash existed carry NULL and load unchecked.
        if expected_sha256 is not None:
            found = hashlib.sha256(data).hexdigest()
            if found != expected_sha256.lower():
                raise RuntimeError(f"Model file {path} does not match MODEL_REGISTRY.MODEL_SHA256 "
                                   f"(expected {expected_sha256}, found {found})")
        _cache[path] = pickle.loads(data)
    return _cache[path]

def run(ctx):
    while True:
        df = ctx.get_dataframe(num_rows=2000)
        if df is None:
            break
        df.columns = [c.lower() for c in df.columns]
        expected = df["model_sha256"].iloc[0]
        b = load(df["model_path"].iloc[0], expected if isinstance(expected, str) and expected else None)
        feats = b["features"]
        X = df[feats].astype(float).fillna(value=b["baseline"]).to_numpy()
        m = b["model"]
        pd_ = m.predict_proba(X)[:, 1]
        # Attribution: how much the PD changes when one feature is set to the portfolio median.
        contrib = {}
        for j, f in enumerate(feats):
            Xj = X.copy()
            Xj[:, j] = b["baseline"][f]
            contrib[f] = pd_ - m.predict_proba(Xj)[:, 1]
        for i, app in enumerate(df["app_id"]):
            c = {f: round(float(contrib[f][i]), 6) for f in feats}
            ctx.emit(app, float(pd_[i]), json.dumps(c))
/

CREATE OR REPLACE PYTHON3 SET SCRIPT CREDORA.TRAIN_SCORECARD(
  model_version VARCHAR(20), loan_id VARCHAR(10),
  gst_years DOUBLE, gst_turnover_12m DOUBLE, gst_late_filings_12m DOUBLE, gst_bank_gap_pct DOUBLE,
  avg_balance_12m DOUBLE, inflow_volatility DOUBLE, bounce_ratio DOUBLE, cmr_rank DOUBLE,
  partner_min_score DOUBLE, partner_avg_score DOUBLE, partner_overdue_amt DOUBLE, partner_other_bank_bal DOUBLE,
  dscr DOUBLE, defaulted BOOLEAN)
EMITS (model_version VARCHAR(20), algorithm VARCHAR(80), auc DOUBLE, gini DOUBLE, n_train DOUBLE, default_rate DOUBLE,
       feature_importance VARCHAR(20000), model_path VARCHAR(200), model_sha256 VARCHAR(64)) AS
import os
os.environ["OMP_NUM_THREADS"] = "4"
import hashlib
import io
import json
import pickle

import numpy as np
import requests
import urllib3
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

urllib3.disable_warnings()

FEATURES = ["gst_years", "gst_turnover_12m", "gst_late_filings_12m", "gst_bank_gap_pct", "avg_balance_12m",
            "inflow_volatility", "bounce_ratio", "cmr_rank", "partner_min_score", "partner_avg_score",
            "partner_overdue_amt", "partner_other_bank_bal", "dscr"]

def run(ctx):
    df = ctx.get_dataframe(num_rows="all")
    df.columns = [c.lower() for c in df.columns]
    df = df.sort_values("loan_id", kind="mergesort").reset_index(drop=True)  # same split as TRAIN_PD
    version = df["model_version"].iloc[0]
    X = df[FEATURES].astype(float).to_numpy()
    y = df["defaulted"].astype(int).to_numpy()

    def model():
        # Standardised features, so each coefficient is the change in log-odds per standard deviation.
        return Pipeline([("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler()),
                         ("logit", LogisticRegression(C=1.0, max_iter=2000))])

    X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.25, stratify=y, random_state=7)
    m = model().fit(X_tr, y_tr)
    auc = float(roc_auc_score(y_te, m.predict_proba(X_te)[:, 1]))

    final = model().fit(X, y)  # refit on all past loans for production use
    coef = {f: round(float(c), 5) for f, c in zip(FEATURES, final.named_steps["logit"].coef_[0])}
    # Same bundle shape as TRAIN_PD, so PD_SCORE scores it and the activate flow can switch to it.
    bundle = {"version": version, "features": FEATURES, "model": final,
              "intercept": float(final.named_steps["logit"].intercept_[0]),
              "baseline": {f: float(np.median(X[:, i])) for i, f in enumerate(FEATURES)}}
    buf = io.BytesIO()
    pickle.dump(bundle, buf)
    data = buf.getvalue()
    sha256 = hashlib.sha256(data).hexdigest()  # PD_SCORE checks the file against it before unpickling

    conn = exa.get_connection("BUCKETFS_MODELS")
    path = f"pd_{version}.pkl"
    r = requests.put(f"{conn.address}/{path}", data=data, auth=(conn.user, conn.password),
                     verify=False, timeout=120)
    r.raise_for_status()
    ctx.emit(version, "LogisticRegression scorecard", auc, 2 * auc - 1, len(y), float(y.mean()),
             json.dumps(coef), f"/buckets/bfsdefault/default/models/{path}", sha256)
/

CREATE OR REPLACE PYTHON3 SET SCRIPT CREDORA.ANOMALY_FLAG(
  app_id VARCHAR(8), contamination_pct DOUBLE,
  gst_turnover_12m DOUBLE, bank_credits_12m DOUBLE, avg_balance_12m DOUBLE, inflow_volatility DOUBLE,
  partner_other_bank_bal DOUBLE)
EMITS (app_id VARCHAR(8), score DOUBLE, is_anomaly BOOLEAN, top_reasons VARCHAR(500)) AS
import os
os.environ["OMP_NUM_THREADS"] = "4"  # one instance sees the whole run
import numpy as np
from sklearn.ensemble import IsolationForest

# Signals of round-tripped money and inflated turnover: how GST sales, bank credits, balances kept and
# partners' money elsewhere fit together. Bounces and overdue are left out on purpose: the hard filters
# and the PD model already judge them, and with them the forest mostly re-finds declined companies.
# What each signal says when it is unusually high (and, for the two-sided ratio, unusually low).
# Ratios are taken as logs, so "far above" and "far below" are symmetric.
SIGNALS = [
    ("GST turnover far above bank credits", "bank credits far above GST turnover"),
    ("turnover high for the balances kept", None),
    ("bank inflows unusually volatile", None),
    ("partner balances at other banks unusually high", None),
]

def num(df, c):
    return df[c].astype(float).to_numpy()

def run(ctx):
    df = ctx.get_dataframe(num_rows="all")
    df.columns = [c.lower() for c in df.columns]
    turnover, credits = num(df, "gst_turnover_12m"), num(df, "bank_credits_12m")
    balance = np.clip(num(df, "avg_balance_12m"), 0, None)
    X = np.column_stack([
        np.log((turnover + 1e5) / (credits + 1e5)),
        np.log((turnover + 1e5) / (balance + 1e5)),
        num(df, "inflow_volatility"),
        np.log1p(np.clip(num(df, "partner_other_bank_bal"), 0, None)),
    ])
    med = np.nanmedian(X, axis=0)
    X = np.where(np.isnan(X), np.where(np.isnan(med), 0, med), X)
    n = len(X)

    pct = float(np.nan_to_num(df["contamination_pct"].astype(float).iloc[0]))  # % of companies; 0 = none
    forest = IsolationForest(n_estimators=200, contamination=min(max(pct, 0.1), 50) / 100, random_state=7).fit(X)
    score = -forest.score_samples(X)  # higher = easier to isolate = more unusual
    flag = (forest.predict(X) == -1) & (pct > 0)

    # Why: each signal's percentile in this run; the reasons are the signals in the outer 5%.
    pctl = (np.argsort(np.argsort(X, axis=0, kind="mergesort"), axis=0) + 0.5) / n
    for i, app in enumerate(df["app_id"]):
        found = []
        for j, (high, low) in enumerate(SIGNALS):
            p = pctl[i, j]
            if p >= 0.95:
                found.append((p, high))
            elif low and p <= 0.05:
                found.append((1 - p, low))
        found.sort(reverse=True)
        if not found:  # unusual only in combination: name the most extreme signal
            j = int(np.argmax(np.abs(pctl[i] - 0.5)))
            high, low = SIGNALS[j]
            found = [(0, low if (low and pctl[i, j] < 0.5) else high)]
        text = ", ".join(r for _, r in found[:2])
        ctx.emit(app, float(score[i]), bool(flag[i]), text[:1].upper() + text[1:])
/

-- SHA-256 of one model file at its local BucketFS path. NULL when the file is not on this node, so
-- the backfill below leaves such a row unhashed instead of failing the deployment.
CREATE OR REPLACE PYTHON3 SCALAR SCRIPT CREDORA.MODEL_FILE_SHA256(model_path VARCHAR(200)) RETURNS VARCHAR(64) AS
import hashlib
import os

def run(ctx):
    if ctx.model_path is None or not os.path.isfile(ctx.model_path):
        return None
    with open(ctx.model_path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()
/

-- Models registered before MODEL_SHA256 existed get their hash from the file now in BucketFS. Only
-- rows without a hash are touched, so this runs on every deployment without changing anything else.
UPDATE CREDORA.MODEL_REGISTRY SET MODEL_SHA256 = CREDORA.MODEL_FILE_SHA256(MODEL_PATH) WHERE MODEL_SHA256 IS NULL;
