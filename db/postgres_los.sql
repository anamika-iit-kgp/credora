-- Sapphire Bank loan origination: PostgreSQL database los, schema public.
-- Safe to run repeatedly; the generator truncates the tables before loading.

CREATE TABLE IF NOT EXISTS application (
  app_id              VARCHAR(8) PRIMARY KEY,
  cif_id              VARCHAR(8) NOT NULL,
  applied_on          DATE NOT NULL,
  product             VARCHAR(4) NOT NULL,
  amount_requested    NUMERIC(18,2) NOT NULL,
  tenure_requested    INTEGER NOT NULL,
  purpose             VARCHAR(80) NOT NULL,
  collateral_type     VARCHAR(30) NOT NULL,
  collateral_value    NUMERIC(18,2) NOT NULL,
  status              VARCHAR(12) NOT NULL
);

CREATE TABLE IF NOT EXISTS past_loan (
  loan_id             VARCHAR(10) PRIMARY KEY,
  sanctioned_on       DATE NOT NULL,
  product             VARCHAR(4) NOT NULL,
  amount              NUMERIC(18,2) NOT NULL,
  gst_years           NUMERIC(4,1) NOT NULL,
  gst_turnover_12m    NUMERIC(18,2) NOT NULL,
  gst_late_filings_12m INTEGER NOT NULL,
  gst_bank_gap_pct    NUMERIC(7,2) NOT NULL,
  avg_balance_12m     NUMERIC(18,2) NOT NULL,
  inflow_volatility   NUMERIC(7,4) NOT NULL,
  bounce_ratio        NUMERIC(7,4) NOT NULL,
  cmr_rank            INTEGER NOT NULL,
  partner_min_score   INTEGER NOT NULL,
  partner_avg_score   NUMERIC(6,1) NOT NULL,
  partner_overdue_amt NUMERIC(18,2) NOT NULL,
  partner_other_bank_bal NUMERIC(18,2) NOT NULL,
  dscr                NUMERIC(7,3) NOT NULL,
  defaulted           BOOLEAN NOT NULL
);

CREATE INDEX IF NOT EXISTS application_cif_ix ON application (cif_id);

-- Exasol's PostgreSQL virtual schema (adbc-vs-rs) leaves out boolean columns, so the training
-- view exposes the label as an integer 0/1 (adbc-vs-rs
-- maps INTEGER but not BOOLEAN or SMALLINT).
DROP VIEW IF EXISTS public.past_loan_training;
CREATE VIEW public.past_loan_training AS
SELECT loan_id, sanctioned_on, product, amount, gst_years, gst_turnover_12m, gst_late_filings_12m,
       gst_bank_gap_pct, avg_balance_12m, inflow_volatility, bounce_ratio, cmr_rank, partner_min_score,
       partner_avg_score, partner_overdue_amt, partner_other_bank_bal, dscr,
       CAST(CASE WHEN defaulted THEN 1 ELSE 0 END AS INTEGER) AS defaulted_flag
FROM public.past_loan;
