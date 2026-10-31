-- Sapphire Bank CRM (offers and negotiation trail): PostgreSQL database crm, schema public.
-- Written by the Credora backend. Safe to run repeatedly; the generator truncates the tables.

CREATE TABLE IF NOT EXISTS offer (
  offer_id            SERIAL PRIMARY KEY,
  run_id              VARCHAR(20) NOT NULL,
  app_id              VARCHAR(8) NOT NULL,
  cif_id              VARCHAR(8) NOT NULL,
  decision            VARCHAR(8) NOT NULL,
  grade               VARCHAR(3),
  pd                  NUMERIC(7,5),
  rank_no             INTEGER,
  offer_amount        NUMERIC(18,2),
  offer_roi           NUMERIC(6,3),
  offer_tenure        INTEGER,
  floor_roi           NUMERIC(6,3),
  max_amount          NUMERIC(18,2),
  max_tenure          INTEGER,
  stage               VARCHAR(12) NOT NULL,
  agreed_amount       NUMERIC(18,2),
  agreed_roi          NUMERIC(6,3),
  agreed_tenure       INTEGER,
  updated_at          TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS offer_event (
  event_id            SERIAL PRIMARY KEY,
  offer_id            INTEGER NOT NULL,
  actor               VARCHAR(20) NOT NULL,
  action              VARCHAR(20) NOT NULL,
  amount              NUMERIC(18,2),
  roi                 NUMERIC(6,3),
  tenure              INTEGER,
  note                VARCHAR(400),
  at                  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS offer_app_ix ON offer (app_id);

CREATE INDEX IF NOT EXISTS offer_event_offer_ix ON offer_event (offer_id);

-- Policy maker-checker. The data scientist saves what-if runs and proposes one as the new policy;
-- the admin approves or rejects it. The backend also creates these at startup (backend/app/crm.py).
-- The generator does not truncate them: proposals are a decision record, kept across data sets.
CREATE SEQUENCE IF NOT EXISTS whatif_run_seq;

CREATE TABLE IF NOT EXISTS whatif_run (
  run_id              VARCHAR(20) PRIMARY KEY,       -- W0001, W0002, ...
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          VARCHAR(20) NOT NULL,
  base_run_id         VARCHAR(20) NOT NULL,          -- the official analysis run it re-decided
  model_version       VARCHAR(40),
  levers              JSONB NOT NULL,                -- {hurdle_pct, eblr_pct, max_gst_share_pct} used
  baseline            JSONB NOT NULL,                -- the CREDORA.CONFIG values at the time
  before_mix          JSONB NOT NULL,                -- {APPROVE, REFER, DECLINE} of the official run
  after_mix           JSONB NOT NULL,                -- the same with these levers
  before_amount       NUMERIC(20,2),                 -- pre-approved offer amount, official run
  after_amount        NUMERIC(20,2),                 -- pre-approved offer amount, with these levers
  ms                  INTEGER                        -- time of the Exasol query
);

CREATE TABLE IF NOT EXISTS policy_proposal (
  proposal_id         SERIAL PRIMARY KEY,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          VARCHAR(20) NOT NULL,
  run_id              VARCHAR(20) NOT NULL REFERENCES whatif_run (run_id),
  levers              JSONB NOT NULL,                -- [{key, lever, label, old, new}]
  outcome             JSONB NOT NULL,                -- {base_run_id, current:{...}, proposed:{...}}
  note                VARCHAR(400) NOT NULL,
  status              VARCHAR(10) NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  decided_by          VARCHAR(20),
  decided_at          TIMESTAMPTZ,
  decision_note       VARCHAR(400),
  applied_run_id      VARCHAR(20)                    -- the official run started by the approval
);

CREATE UNIQUE INDEX IF NOT EXISTS policy_proposal_pending_ux ON policy_proposal (run_id) WHERE status = 'PENDING';

-- Risk-model activation maker-checker: the data scientist trains a model and requests activation;
-- the admin approves (then CREDORA.MODEL_REGISTRY.IS_ACTIVE switches, written as CREDORA_SVC) or
-- rejects. Same rules as policy proposals: one pending request per model version, nobody decides
-- their own request, decided requests are read-only. Kept across data sets.
CREATE TABLE IF NOT EXISTS model_activation_request (
  request_id          SERIAL PRIMARY KEY,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          VARCHAR(20) NOT NULL,
  model_version       VARCHAR(40) NOT NULL,          -- the model to activate
  current_version     VARCHAR(40),                   -- the active model when the request was made
  metrics             JSONB NOT NULL,                -- {candidate:{algorithm,auc,gini}, current:{...}}
  note                VARCHAR(400) NOT NULL,
  status              VARCHAR(10) NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  decided_by          VARCHAR(20),
  decided_at          TIMESTAMPTZ,
  decision_note       VARCHAR(400)
);

CREATE UNIQUE INDEX IF NOT EXISTS model_activation_pending_ux ON model_activation_request (model_version)
  WHERE status = 'PENDING';
